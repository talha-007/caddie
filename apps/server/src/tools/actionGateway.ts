import type { Cart, CartAction } from '@caddie/shared';
import { log } from '../lib/logger.js';
import { sessions, type PendingAction } from '../session/store.js';
import { cartAuthorization, lineChangeAuthorization, offeredAction, turnNow } from './cartAuthorization.js';
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
    };

export interface ActionOutcome {
  ok: boolean;
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
    const here: ToolContext = { ...ctx, session: await sessions.getOrCreate(ctx.session.id) };
    const said = (ctx.utterance ?? '').slice(0, 160);

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

    if (!plan.ok) {
      log.info('gateway.refused', { sessionId: ctx.session.id, action: action.type, source, reason: plan.reason });
      // What it waits for next turn - or nothing: a refused action never leaves an old one waiting.
      await sessions.patch(ctx.session.id, { pendingAction: plan.pending ? { ...plan.pending, turn: turnNow(here) } : undefined });
      return {
        ok: false,
        action: action.type,
        source,
        reason: plan.reason,
        speech: plan.speech,
        facts: `Nothing was ${action.type === 'update-line' ? 'changed' : 'added'} (${plan.reason}) - the basket is unchanged. ${plan.facts} Never say it was ${action.type === 'update-line' ? 'changed' : 'added'}.`,
      };
    }

    // 3. applied
    const cart = plan.storefront ? await plan.storefront() : undefined;
    // 4. recorded - only now that it is made.
    await plan.afterSuccess?.();
    await sessions.patch(ctx.session.id, {
      pendingAction: undefined,
      ...(plan.productId && action.type !== 'update-line' ? { lastAdded: { productId: plan.productId, turn: turnNow(here) } } : {}),
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
