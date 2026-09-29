import type { Cart, CartAction, Product } from '@caddie/shared';
import { log } from '../lib/logger.js';
import { sessions, type PendingAction } from '../session/store.js';
import { currentMission } from '../session/shoppingSession.js';
import { cartAuthorization, lineChangeAuthorization, offeredAction, turnNow } from './cartAuthorization.js';
import { STILL_UPDATING, UNCERTAIN_HELD, UPDATING, dispatch, dispatchBatch, expireDispatched, keepOperations, unsettledOperation, type PlannedOperation } from './cartOperations.js';
import { CART_OPS_CONTRACT } from '@caddie/shared';
import type { ToolContext } from './types.js';

/**
 * The Action Gateway: every change to a customer's basket passes through
 * here, and only here.
 *
 * Adds, pack adds, quantity changes and removals used to be decided in five
 * places: two tools checked the customer had asked, update_cart_item did not
 * check at all, and the widget's Add buttons wrote straight to the store's
 * cart with no server check of the variant, its stock or a pack's price. The
 * outfit tool's basket swap said "swapping it in your basket too" and handed
 * the widget nothing to do.
 *
 * Now a model, a button or a route only *requests* an action. The gateway
 * decides - in this order, and before anything changes:
 *
 *   1. authorised    the customer's words, a yes to what was offered, the
 *                    answer a waiting action needed, or their own click
 *   2. validated     the product they meant, the variant their choices make,
 *                    in stock, the quantity they said, the price it will
 *                    charge (the planner for that kind of action)
 *   3. applied       the CartActions the widget makes on the storefront, or
 *                    the Storefront API cart in the dev harness
 *   4. recorded      only after it is applied: the waiting action cleared,
 *                    what they liked, the pack bookkeeping
 *
 * The result says plainly whether anything changed. A refused action comes
 * back as "nothing changed", why, and the one thing needed - never something
 * the model could read as done.
 *
 * Actions for one session run one at a time. Four adds in one reply once all
 * read an empty basket and opened four baskets; the Vapi webhook ran its tool
 * calls in parallel, cart writes included.
 */

/** Who asked - the only things that authorise a change. A model's call alone never does. */
export type ActionSource = 'customer-utterance' | 'customer-confirmation' | 'pending-action-continuation' | 'ui-add' | 'ui-cart-change';

export type CommerceAction =
  | { type: 'add-product'; productId: string; options?: Record<string, string>; quantity?: number; replaces?: string }
  | { type: 'add-pack'; pack?: string; handle?: string; pieces?: Array<{ productId: string; options: Record<string, string> }> }
  | { type: 'update-line'; lineId: string; quantity: number };

export type RejectReason =
  | 'not-authorized'
  | 'no-target'
  | 'ambiguous-target'
  | 'missing-option'
  | 'sold-out'
  | 'not-found'
  | 'not-ready'
  | 'price-check'
  | 'unavailable'
  | 'wrong-action';

/** What validation decided: a change, ready to apply, or why there is none. */
export type ActionPlan =
  | {
      ok: true;
      /** Said to the customer: what is happening. */
      speech: string;
      facts?: string;
      /** On the storefront: the changes the widget makes in the store's cart. */
      actions?: CartAction[];
      /** In the dev harness: the Storefront API change, run by the gateway. */
      storefront?: () => Promise<Cart>;
      /** Side effects that must wait until the change is made (likes, bookkeeping). */
      afterSuccess?: () => Promise<void>;
      /**
       * On the storefront: the change is only made once the widget's report on
       * the cart bears it out (tools/cartOperations.ts). Set by planners whose
       * change the cart can confirm; the gateway then defers everything in
       * step 4 to that report.
       */
      operation?: PlannedOperation;
      /** Several lines changed together: one operation per action, in the same order, confirmed once as a batch. */
      operations?: { items: PlannedOperation[]; title: string };
      productId?: string;
      variantId?: string;
      quantity?: number;
      /** What it will charge, in the store's currency. */
      charge?: number;
    }
  | {
      ok: false;
      reason: RejectReason;
      /** The one short question or statement for the customer. */
      speech: string;
      facts: string;
      /** When the answer to `speech` should finish this action next turn. */
      pending?: Omit<PendingAction, 'turn'>;
      /** The choice the question is about, shown - "which do you mean?" with the candidates on screen, so the answer can be a tap. */
      cards?: Product[];
    };

export interface ActionOutcome {
  ok: boolean;
  /** ok, but handed to the widget and not yet borne out by the cart: nothing is added until its report says so. */
  dispatched?: boolean;
  operationId?: string;
  action: CommerceAction['type'];
  source?: ActionSource;
  reason?: RejectReason;
  speech: string;
  facts: string;
  actions?: CartAction[];
  cart?: Cart;
  productId?: string;
  variantId?: string;
  quantity?: number;
  charge?: number;
  /** A refusal's choice, to be shown. */
  cards?: Product[];
}

type Planner = (ctx: ToolContext, action: CommerceAction, source: ActionSource) => Promise<ActionPlan>;
const planners = new Map<CommerceAction['type'], Planner>();

/** The validation for one kind of action - registered by tools/index.ts, which holds the catalogue and pack logic it needs. */
export function registerPlanner(type: CommerceAction['type'], planner: Planner): void {
  planners.set(type, planner);
}

/* ---------------- one at a time, per session ---------------- */

const queues = new Map<string, Promise<unknown>>();

async function serialised<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const before = queues.get(sessionId) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(run);
  const tail = mine.catch(() => undefined);
  queues.set(sessionId, tail);
  try {
    return await mine;
  } finally {
    if (queues.get(sessionId) === tail) queues.delete(sessionId);
  }
}

/* ---------------- 1. authorised ---------------- */

function authorise(ctx: ToolContext, action: CommerceAction): ActionSource | null {
  if (action.type === 'update-line') return lineChangeAuthorization(ctx);
  if (ctx.direct) return 'ui-add';
  const auth = cartAuthorization(ctx, action.type === 'add-product' && action.replaces ? { replaces: action.replaces } : {});
  if (!auth.authorized) return null;
  if (auth.source === 'confirmation') {
    // A yes answers what was offered: an add of a product is not a pack, and a pack is not a product.
    const offered = offeredAction(ctx);
    if (offered && offered.type !== action.type) return null;
    return 'customer-confirmation';
  }
  return auth.source === 'continuation' ? 'pending-action-continuation' : 'customer-utterance';
}

const NOT_AUTHORISED: Record<CommerceAction['type'], { speech: string; facts: (said: string) => string }> = {
  'add-product': {
    speech: "I haven't added anything to your basket.",
    facts: (said) => `Basket unchanged. The customer did not ask to add anything - their words were "${said}". Do not say anything was added, and add nothing until they ask.`,
  },
  'add-pack': {
    speech: "I haven't added the pack to your basket.",
    facts: (said) => `Basket unchanged. The customer did not ask to add the pack - their words were "${said}". Do not say it was added.`,
  },
  'update-line': {
    speech: "I haven't changed your basket.",
    facts: (said) => `Basket unchanged. The customer did not ask to change or remove anything - their words were "${said}". Do not say anything was changed or removed.`,
  },
};

/* ---------------- the gateway ---------------- */

export async function executeCommerceAction(ctx: ToolContext, action: CommerceAction): Promise<ActionOutcome> {
  return serialised(ctx.session.id, async () => {
    // Read fresh: an earlier action in this same reply may have changed the session.
    const here: ToolContext = { ...ctx, session: await expireDispatched(ctx.session.id, await sessions.getOrCreate(ctx.session.id)) };
    const said = (ctx.utterance ?? '').slice(0, 160);
    /*
     * A change already handed to the widget and not yet borne out by the cart
     * holds every other change to this basket: a second "yes" must not send
     * the same add again, and two Caddie writes must not race in one cart.
     * Held for OUTCOME_TIMEOUT_MS at most (expireDispatched).
     */
    const unsettled = unsettledOperation(here.session);
    // A change still unconfirmed from an earlier turn holds new ones; the adds of this same turn ("add everything") go out together, each its own operation.
    if (unsettled && unsettled.turn !== turnNow(here)) {
      log.info('gateway.held_for_outcome', { sessionId: ctx.session.id, action: action.type, operationId: unsettled.id, status: unsettled.status });
      return {
        ok: false,
        action: action.type,
        reason: 'not-ready',
        speech: unsettled.status === 'uncertain' ? UNCERTAIN_HELD : STILL_UPDATING,
        facts: `A basket change (${unsettled.wording.title}${unsettled.wording.choice ? ` in ${unsettled.wording.choice}` : ''}) is ${unsettled.status === 'uncertain' ? 'unconfirmed' : 'still being confirmed by the store cart'}. Nothing else was changed and nothing is sent again; do not add, change or offer anything for the basket until it is settled. Say only what the tool said.`,
      };
    }

    const source = authorise(here, action);
    if (!source) {
      log.warn('gateway.not_authorized', { sessionId: ctx.session.id, action: action.type, said });
      return {
        ok: false,
        action: action.type,
        reason: 'not-authorized',
        speech: NOT_AUTHORISED[action.type].speech,
        facts: NOT_AUTHORISED[action.type].facts(said),
      };
    }

    const planner = planners.get(action.type);
    if (!planner) throw new Error(`No planner registered for ${action.type}`);
    const plan = await planner(here, action, source);

    /*
     * The same variant dispatched twice in one turn: the waiting record's add
     * and the model's own add_to_cart for the same card both went out, and a
     * customer who said "the second one in XL" got two (journey test, 29
     * Sep). The second is not sent - it is already going in.
     */
    if (plan.ok && plan.variantId && Object.values(here.session.cartOperations ?? {}).some((record) => record.status === 'dispatched' && record.turn === turnNow(here) && record.variantId === String(plan.variantId).split('/').pop())) {
      log.info('gateway.duplicate_in_turn', { sessionId: ctx.session.id, variantId: plan.variantId });
      return { ok: false, action: action.type, source, reason: 'wrong-action', speech: "It's already going into your basket.", facts: 'That exact item was sent to the basket a moment ago this turn; nothing is sent twice. Say it is going in.' };
    }

    if (!plan.ok) {
      log.info('gateway.refused', { sessionId: ctx.session.id, action: action.type, source, reason: plan.reason });
      /*
       * What it waits for - or nothing: a refused action never leaves an old
       * one waiting. The record carries whether they asked for it (their
       * words, a yes, or an answer to a question of its own), so a field
       * given later needs no second yes, and the question asked in the code's
       * own words (tools/pending.ts). Stamped with its mission: an unrelated
       * new mission ends it (session/shoppingSession.ts livePending).
       */
      const authorized = source === 'customer-utterance' || source === 'customer-confirmation' || source === 'pending-action-continuation' || !!here.session.pendingAction?.authorized;
      await sessions.patch(ctx.session.id, {
        pendingAction: plan.pending
          ? { ...plan.pending, authorized, question: plan.speech, missing: plan.pending.missing ?? [plan.pending.awaiting], turn: turnNow(here), mission: currentMission(here.session) }
          : undefined,
      });
      return {
        ok: false,
        action: action.type,
        source,
        reason: plan.reason,
        speech: plan.speech,
        facts: `Nothing was ${action.type === 'update-line' ? 'changed' : 'added'} (${plan.reason}) - the basket is unchanged. ${plan.facts} Never say it was ${action.type === 'update-line' ? 'changed' : 'added'}.`,
        ...(plan.cards?.length ? { cards: plan.cards } : {}),
      };
    }

    /*
     * 3. On the storefront, handed over - not made. The widget carries the
     * change out in the theme's cart and reports what the cart then showed;
     * only that report completes the action (tools/cartOperations.ts). The
     * customer's authorisation is held on the record until then, and
     * nothing is said to be added.
     */
    if ((plan.operation || plan.operations) && here.session.cartMode === 'theme' && plan.actions?.length) {
      /*
       * A widget that cannot report on the change (no x-caddie-widget, or an
       * older contract) is not handed one: it would carry it out and never
       * tell us, and the change would sit unconfirmed for good. Said plainly;
       * the theme's own Add button still works.
       */
      if (here.session.widgetContract !== CART_OPS_CONTRACT) {
        log.warn('gateway.widget_unsupported', { sessionId: ctx.session.id, action: action.type, widget: here.session.widgetContract ?? null });
        return {
          ok: false,
          action: action.type,
          reason: 'unavailable',
          speech: "I can't change your basket from this version of the page - please refresh the page, or use the Add button on the product.",
          facts: 'The page is running an older widget that cannot confirm basket changes; nothing was changed. Tell them to refresh, or to use the product page. Never say it was added.',
        };
      }
      const meta = {
        source,
        turn: turnNow(here),
        mission: currentMission(here.session),
        ...(plan.productId ? { productId: plan.productId } : {}),
        ...(plan.variantId ? { variantId: plan.variantId } : {}),
      };
      const sent = plan.operations
        ? dispatchBatch(here.session, plan.operations.items, plan.operations.title, plan.actions, meta)
        : (() => { const one = dispatch(here.session, plan.operation!, plan.actions, meta); return { actions: one.actions, records: [one.record] }; })();
      const { actions } = sent;
      const record = sent.records[0]!;
      await sessions.patch(ctx.session.id, {
        cartOperations: keepOperations(here.session.cartOperations, ...sent.records),
        pendingAction: {
          type: record.kind,
          productIds: plan.productId ? [plan.productId] : [],
          ...(plan.quantity !== undefined ? { quantity: plan.quantity } : {}),
          awaiting: 'outcome',
          missing: ['outcome'],
          authorized: true,
          dispatched: record.id,
          turn: turnNow(here),
          mission: currentMission(here.session),
        },
      });
      log.info('gateway.dispatched', { sessionId: ctx.session.id, action: action.type, source, operationId: record.id, operations: sent.records.length, productId: plan.productId ?? null, variantId: plan.variantId ?? null, quantity: plan.quantity ?? null });
      return {
        ok: true,
        dispatched: true,
        operationId: record.id,
        action: action.type,
        source,
        speech: UPDATING,
        facts: `${plan.facts ?? ''}\nThe store cart is being updated and the result is confirmed separately - the customer will see the confirmation. Say only that the basket is being updated: never that it is added, in the basket or done, and do not ask about a size or colour for it.`.trim(),
        actions,
        ...(plan.productId ? { productId: plan.productId } : {}),
        ...(plan.variantId ? { variantId: plan.variantId } : {}),
        ...(plan.quantity !== undefined ? { quantity: plan.quantity } : {}),
        ...(plan.charge !== undefined ? { charge: plan.charge } : {}),
      };
    }

    // 3. applied
    const cart = plan.storefront ? await plan.storefront() : undefined;
    // 4. recorded - only now that it is made.
    await plan.afterSuccess?.();
    await sessions.patch(ctx.session.id, {
      pendingAction: undefined,
      ...(plan.productId && action.type !== 'update-line' ? { lastAdded: { productId: plan.productId, turn: turnNow(here), ...(here.pendingResolved ? { byPending: true } : {}) } } : {}),
      // The dev harness's cart, as the basket the next action reads - on the storefront the widget reports it.
      ...(cart
        ? { cartId: cart.id, basket: cart.lines.map((line) => ({ lineId: line.lineId, productId: line.productId, title: line.title, variantTitle: line.variantTitle, quantity: line.quantity })) }
        : {}),
    });
    log.info('gateway.applied', {
      sessionId: ctx.session.id,
      action: action.type,
      source,
      productId: plan.productId ?? null,
      variantId: plan.variantId ?? null,
      quantity: plan.quantity ?? null,
      charge: plan.charge ?? null,
    });
    return {
      ok: true,
      action: action.type,
      source,
      speech: plan.speech,
      facts: plan.facts ?? '',
      ...(plan.actions ? { actions: plan.actions } : {}),
      ...(cart ? { cart } : {}),
      ...(plan.productId ? { productId: plan.productId } : {}),
      ...(plan.variantId ? { variantId: plan.variantId } : {}),
      ...(plan.quantity !== undefined ? { quantity: plan.quantity } : {}),
      ...(plan.charge !== undefined ? { charge: plan.charge } : {}),
    };
  });
}
