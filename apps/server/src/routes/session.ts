import { Router, type RequestHandler } from 'express';
import { CART_OPS_CONTRACT, type BasketSync, type BasketSyncResponse, type SmartCartSuggestRequest, type SmartCartSuggestResponse, type CardChoice, type CartAction, type CartOutcomeReport, type ProfileRequest, type SessionClaimResponse, type SessionRestartResponse, type UiActionResponse, type UiAddRequest, type UiCartLineRequest, type UiPackAddRequest } from '@caddie/shared';
import { z } from 'zod';
import { clientKey, noteCartMode } from '../lib/request.js';
import { speak, speechEnabled } from '../ai/speak.js';
import { clientHash } from '../usage/identity.js';
import { executeCommerceAction } from '../tools/actionGateway.js';
import { basketPatch, settleOutcome } from '../tools/cartOperations.js';
import { trustedShopperFacts } from '../shopper/facts.js';
import type { ShopperProfile } from '../shopper/profile.js';
import { rememberShopper } from '../shopper/remember.js';
import { log } from '../lib/logger.js';
import { LIMITS } from '../lib/rateLimit.js';
import { limitRoute } from '../lib/routeLimit.js';
import { productById } from '../catalog/sync.js';
import { sessions, type CaddieSession } from '../session/store.js';
import { SMART_CART_OFFERS, cheapestAvailablePence, offerValue, qualifyingProducts, smartCartView } from '../smartCart/index.js';
import { customerTurn, describeFocus, focusFromCard } from '../session/focus.js';
import { claimSession, requireSessionOwner } from '../session/ownership.js';
import { runTool } from '../tools/index.js';

/**
 * POST /api/session/:id/restart
 *
 * A new conversation that keeps the basket - the widget's "New chat". The
 * conversation otherwise carries across page loads. Starting again used to
 * mean a brand new session id, and the basket lives on the session, so a
 * customer who wanted a fresh chat lost what they had added.
 *
 * What carries over is what the customer has *committed* to: the basket, and
 * what we know about their fit. What goes is what belonged to the old chat -
 * the words, what was on screen, the budget and colour of that search - since
 * the model would otherwise resolve "that one" against a thread the customer
 * can no longer see.
 */

export const sessionRouter: Router = Router();

/*
 * Every route here changes a shopper's session, and none needs a login - the
 * session id is all a caller has to know. Limited per session and per
 * address, generously: a shopper tapping sizes and opening the basket never
 * gets near it; a script hammering one session, or many, does.
 */
const writeLimit = limitRoute('session', (req) => req.params.id, LIMITS.sessionWritesPerSession, LIMITS.sessionWritesPerAddress) as RequestHandler<{ id: string }>;
/*
 * And only the browser that owns the session (session/ownership.ts) - checked
 * first, so a caller with someone else's id is turned away before it can
 * spend that session's allowance.
 */
const owner = requireSessionOwner((req) => req.params.id) as RequestHandler<{ id: string }>;
const claimLimit = limitRoute('claim', (req) => req.params.id, LIMITS.sessionClaimsPerSession, LIMITS.sessionClaimsPerAddress) as RequestHandler<{ id: string }>;

/**
 * POST /api/session/:id/claim - make this session id the caller's. Once, per
 * session: a session already claimed says so (409) and gives nothing away.
 */
sessionRouter.post('/:id/claim', claimLimit, async (req, res, next) => {
  try {
    const claimed = await claimSession(req.params.id);
    if (!claimed.ok) return res.status(claimed.reason === 'taken' ? 409 : 400).json({ error: claimed.reason === 'taken' ? 'session_taken' : 'invalid_session' });
    const body: SessionClaimResponse = { sessionId: req.params.id, sessionToken: claimed.sessionToken, contract: CART_OPS_CONTRACT };
    return res.json(body);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/session/:id/choice
 *
 * A size tapped on a product card lived only in the card. The customer picked
 * M on a rain jacket, said "add it", and the Caddie - which had never heard of
 * the M - asked for their size and reached for a different jacket. The card
 * now says what they picked; it is kept for that product, and that product
 * becomes the one "it" means. Only options the product really has are kept.
 */
sessionRouter.post('/:id/choice', owner, writeLimit, async (req, res, next) => {
  const sessionId = req.params.id;
  try {
    const body = (req.body ?? {}) as Partial<CardChoice>;
    const product = productById(String(body.productId ?? ''));
    if (!product) return res.status(400).json({ error: 'unknown_product' });
    // Under the product's own option names ("SIZE", "JACKET SIZE"), and only values it really has.
    const options: Record<string, string> = {};
    for (const [name, value] of Object.entries(body.options ?? {})) {
      const option = product.options.find((own) => own.name.toLowerCase() === name.toLowerCase());
      const real = option?.values.find((own) => own.toLowerCase() === String(value).toLowerCase());
      if (option && real) options[option.name] = real;
    }
    if (Object.keys(options).length === 0) return res.status(400).json({ error: 'no_valid_options' });
    const variantId = typeof body.variantId === 'string' && body.variantId ? body.variantId : undefined;

    const session = await sessions.getOrCreate(sessionId);
    // A tap is the customer's own choice of product: it moves what they are shopping for (session/focus.ts).
    const activeShoppingContext = focusFromCard(product, session.activeShoppingContext, customerTurn(session, false));
    await sessions.patch(sessionId, {
      cardChoices: { ...(session.cardChoices ?? {}), [product.id]: { options, ...(variantId ? { variantId } : {}), at: Date.now() } },
      activeShoppingContext,
    });
    log.info('session.card_choice', { sessionId, productId: product.id, options });
    log.info('focus.updated', { sessionId, utterance: null, prior: describeFocus(session.activeShoppingContext), resolved: describeFocus(activeShoppingContext), source: 'card-action' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

sessionRouter.post('/:id/restart', owner, writeLimit, async (req, res, next) => {
  const sessionId = req.params.id;
  try {
    const existing = await sessions.get(sessionId);
    if (!existing) {
      const empty: SessionRestartResponse = { sessionId, cart: null };
      return res.json(empty);
    }

    /*
     * A whole new record written with save, not patch: patch deliberately
     * never unsets a field, and forgetting `lastShown` is the point.
     */
    const now = Date.now();
    const fresh = {
      id: sessionId,
      createdAt: existing.createdAt,
      updatedAt: now,
      /*
       * What they told us about themselves is about them, not the old chat,
       * and stays: their usual size, range, waist, standing preferences and
       * measurements - each with where it came from. What this shopping
       * session asked for goes with it (the focus is not carried), and so
       * does any size we recommended: after New chat it would read as theirs.
       */
      ...carriedAcrossNewChat(existing),
      messages: [],
      ...(existing.cartId ? { cartId: existing.cartId } : {}),
      // A new conversation on the same shopping session: the same owner, the same capability.
      ...(existing.ownerHash ? { ownerHash: existing.ownerHash } : {}),
    };
    await sessions.save(fresh);

    let cart: SessionRestartResponse['cart'] = null;
    if (fresh.cartId) {
      try {
        const result = await runTool('view_cart', {}, { session: fresh });
        cart = result.attachment?.kind === 'cart' ? result.attachment.cart : null;
      } catch (err) {
        // A basket Shopify no longer knows (checked out, or expired) is not a
        // reason to fail the page: the chat still starts, just without it.
        log.warn('session.restart.cart_unavailable', { sessionId, err: String(err) });
      }
    }

    const body: SessionRestartResponse = { sessionId, cart };
    return res.json(body);
  } catch (err) {
    return next(err);
  }
});

/**
 * What a New chat keeps: the durable facts and measurements they gave, and
 * the currency. Everything else about the shopping - the focus and its
 * mission, the pack in hand, a waiting basket add, what is on screen, the
 * search history, card taps, our size advice - starts again (Phase 3B).
 */
function carriedAcrossNewChat(existing: CaddieSession): Pick<CaddieSession, 'sizeProfile' | 'preferences' | 'shopper'> {
  const { measurements, sources, ...facts } = trustedShopperFacts(existing);
  const provenance = Object.fromEntries(Object.keys(sources).map((field) => [field, existing.shopper?.provenance?.[field]]).filter(([, record]) => !!record));
  const shopper: ShopperProfile | undefined = Object.keys(provenance).length ? { ...facts, provenance } : undefined;
  return {
    sizeProfile: { ...measurements },
    preferences: existing.preferences.currency ? { currency: existing.preferences.currency } : {},
    ...(shopper ? { shopper } : {}),
  };
}

/**
 * POST /api/session/:id/profile - who they are shopping for, and their sizes.
 *
 * The widget's quick start asks these first, so the first thing shown is
 * already their range in their size, and every size picker opens on it. Held
 * like anything they say in chat: a later "actually I'm an XL" replaces it.
 * Checked against what the store sells rather than taken as given - the body
 * comes from a browser.
 */
sessionRouter.post('/:id/profile', owner, writeLimit, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Partial<ProfileRequest>;
    const range = body.range === 'men' || body.range === 'women' || body.range === 'kids' ? body.range : undefined;
    // Letter sizes, ladies' 6-22, kids' age bands ("8/10", "9-10") - nothing longer, nothing stranger.
    const clean = (value: unknown) =>
      typeof value === 'string' && /^[A-Za-z0-9/ -]{1,12}$/.test(value.trim()) ? value.trim().toUpperCase() : undefined;
    const size = clean(body.size);
    const waist = typeof body.waist === 'string' && /^\d{2}$/.test(body.waist.trim()) ? body.waist.trim() : undefined;
    await sessions.getOrCreate(req.params.id);
    // Typed into the quick start by the customer: theirs, as firmly as if they had said it.
    const shopper = await rememberShopper(
      req.params.id,
      {
        ...(range ? { range } : {}),
        ...(size ? { usualSize: size } : {}),
        ...(waist ? { waist } : {}),
      },
      'ui-form',
    );
    res.json({ ok: true, shopper: { range: shopper.range, size: shopper.usualSize, waist: shopper.waist } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/session/:id/basket - the store cart, as the widget last read it.
 *
 * On the storefront the basket is the theme's cart in the shopper's browser,
 * which the server cannot read. The widget sends it after every change and on
 * every page load, so "swap the orange polo" and "what is in my basket" are
 * answered from what is really there.
 */
sessionRouter.post('/:id/basket', owner, writeLimit, async (req, res, next) => {
  try {
    const body = req.body as Partial<BasketSync> | undefined;
    const lines = Array.isArray(body?.lines) ? body.lines.slice(0, 100) : [];
    await sessions.getOrCreate(req.params.id);
    // Names from our own catalogue, never from the request (tools/cartOperations.ts basketFromSync): these lines go into the model's instructions.
    const token = typeof body?.cartToken === 'string' ? body.cartToken.slice(0, 120) : undefined;
    const fresh = basketPatch(lines, typeof body?.currency === 'string' ? body.currency : undefined);
    await sessions.patch(req.params.id, { cartMode: 'theme', ...fresh, ...(token ? { cartToken: token } : {}) });
    // Smart Cart progress from this very read, for the widget's preview: the server stays its only author.
    const reply: BasketSyncResponse = { ok: true, lines: lines.length, smartCart: smartCartView(fresh.smartCart, { lines: fresh.basket ?? [], ...(fresh.cartCurrency ? { currency: fresh.cartCurrency } : {}) }) };
    res.json(reply);
  } catch (err) {
    next(err);
  }
});


/**
 * POST /api/session/:id/smart-cart/suggest - products that would complete an
 * offer the basket is part-way to, for the Smart Cart preview's "find me"
 * button. Deterministic, no model: qualifying by the theme's own rule, in
 * stock, not already in the basket, and priced above what the finished set
 * needs for SupaEasy to discount anything (smartCart/value.ts) - cheapest of
 * those first. Adding one goes through the gateway like any card, and is
 * stamped there.
 */
sessionRouter.post('/:id/smart-cart/suggest', owner, writeLimit, async (req, res, next) => {
  try {
    const offer = SMART_CART_OFFERS.find((entry) => entry.id === (req.body as Partial<SmartCartSuggestRequest> | undefined)?.offerId);
    if (!offer) return res.status(400).json({ error: 'unknown_offer' });
    const session = await sessions.getOrCreate(req.params.id);
    const inBasket = new Set((session.basket ?? []).map((line) => line.productId));
    const candidates = qualifyingProducts(offer).filter((product) => !inBasket.has(product.id));
    const state = session.smartCart?.offers.find((entry) => entry.offerId === offer.id);
    const value = state ? offerValue(state, offer, session.basket ?? [], session.cartCurrency, candidates) : null;
    const floor = value?.floorPence ?? 0;
    const products = candidates
      .map((product) => ({ product, price: cheapestAvailablePence(product) }))
      .filter((entry): entry is { product: typeof entry.product; price: number } => entry.price !== null && entry.price > floor)
      .sort((a, b) => a.price - b.price)
      .slice(0, 6)
      .map((entry) => entry.product);
    const units = offer.display?.units ?? 'items';
    const message = products.length
      ? `${units.charAt(0).toUpperCase()}${units.slice(1)} that complete the ${offer.display?.deal ?? offer.name} offer`
      : `I couldn't find more ${units} for the ${offer.display?.deal ?? offer.name} offer just now.`;
    log.info('smart_cart.suggested', { sessionId: req.params.id, offerId: offer.id, floorPence: floor, candidates: candidates.length, shown: products.length });
    const reply: SmartCartSuggestResponse = { offerId: offer.id, products, message };
    return res.json(reply);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/session/:id/speak - the Caddie's reply, spoken (ai/speak.ts).
 *
 * Only a reply the Caddie gave in this session, named by its message id: the
 * words come from the session, never from the request, so this can never be
 * used to have arbitrary text spoken on our account. Owner only, with its own
 * budget - speech costs more than a tap. 404 when spoken replies are off.
 */
const speakLimit = limitRoute('speak', (req) => req.params.id, LIMITS.speakPerSession, LIMITS.speakPerAddress) as RequestHandler<{ id: string }>;

sessionRouter.post('/:id/speak', owner, speakLimit, async (req, res, next) => {
  try {
    if (!speechEnabled()) return res.status(404).json({ error: 'speech_off' });
    const messageId = typeof (req.body as { messageId?: unknown } | undefined)?.messageId === 'string' ? String((req.body as { messageId: string }).messageId).slice(0, 100) : '';
    const session = await sessions.getOrCreate(req.params.id);
    const said = session.messages.find((entry) => entry.id === messageId && entry.role === 'assistant');
    if (!said || !said.text.trim()) return res.status(404).json({ error: 'unknown_message' });
    const audio = await speak(said.text, { sessionId: req.params.id, client: clientHash(clientKey(req)) });
    res.setHeader('Cache-Control', 'no-store');
    return res.type('audio/mpeg').send(audio);
  } catch (err) {
    return next(err);
  }
});

/*
 * The widget's own basket changes - a card's Add button, a pack's Add button,
 * the basket's quantity and remove buttons - through the Action Gateway, as
 * every change the Caddie makes is. They used to write straight to the
 * theme's cart: no server check that the variant was real or in stock, no
 * pack price check, no pack replacement. The click is the customer's
 * authority; the gateway checks everything else and hands back the changes
 * for the widget to make in the store's cart.
 */

const optionsSchema = z.record(z.string().max(60)).refine((options) => Object.keys(options).length <= 6);

const addSchema = z.object({
  items: z.array(z.object({ productId: z.string().min(1).max(100), options: optionsSchema, quantity: z.number().int().min(1).max(10).optional() })).min(1).max(10),
});

sessionRouter.post('/:id/add', owner, writeLimit, async (req, res, next) => {
  const sessionId = req.params.id;
  try {
    const parsed = addSchema.safeParse((req.body ?? {}) as UiAddRequest);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
    await noteCartMode(req, await sessions.getOrCreate(sessionId), (id, change) => sessions.patch(id, change));
    const actions: CartAction[] = [];
    let reply: UiActionResponse = { ok: true };
    for (const item of parsed.data.items) {
      const outcome = await executeCommerceAction(
        { session: await sessions.getOrCreate(sessionId), direct: true },
        { type: 'add-product', productId: item.productId, options: item.options, ...(item.quantity ? { quantity: item.quantity } : {}) },
      );
      if (outcome.actions) actions.push(...outcome.actions);
      if (outcome.cart) reply = { ...reply, cart: outcome.cart };
      // The first that cannot go in stops the rest - and says why. What went in before it still goes in.
      if (!outcome.ok) {
        reply = { ...reply, ok: false, message: outcome.speech };
        break;
      }
    }
    return res.json({ ...reply, ...(actions.length ? { actions } : {}) });
  } catch (err) {
    return next(err);
  }
});

/*
 * POST /api/session/:id/cart-outcome - what the store cart showed after the
 * widget carried out an operation the gateway handed it. Only this completes
 * the change (tools/cartOperations.ts): the report is judged against the
 * change asked for, a repeat is answered the same way and changes nothing,
 * and an operation this session never made is refused. Owner-only, like
 * every route about a session.
 */
const syncLineSchema = z.object({
  key: z.string().min(1).max(200),
  productId: z.string().min(1).max(100),
  variantId: z.string().min(1).max(100),
  title: z.string().max(200).optional(),
  variantTitle: z.string().max(200).optional(),
  quantity: z.number().int().min(0).max(999),
  bundle: z.string().max(100).optional(),
  bundleName: z.string().max(100).optional(),
  properties: z.record(z.string().max(200)).optional(),
  sellingPlanId: z.string().max(100).optional(),
});
const syncSchema = z.object({ cartToken: z.string().max(120).optional(), currency: z.string().max(8).optional(), lines: z.array(syncLineSchema).max(100) });
const outcomeSchema = z.object({
  operationId: z.string().min(1).max(80),
  status: z.enum(['applied', 'failed', 'partial', 'uncertain']),
  before: syncSchema.nullable(),
  after: syncSchema.nullable(),
  error: z.string().max(300).optional(),
  failure: z.enum(['rejected', 'network', 'timeout']).optional(),
  evidence: z.literal('ajax-cart-read'),
});

sessionRouter.post('/:id/cart-outcome', owner, writeLimit, async (req, res, next) => {
  try {
    const parsed = outcomeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
    const sync = (value: z.infer<typeof syncSchema> | null): BasketSync | null =>
      value ? { ...(value.cartToken ? { cartToken: value.cartToken } : {}), ...(value.currency ? { currency: value.currency } : {}), lines: value.lines.map((line) => ({ ...line, title: line.title ?? '', variantTitle: line.variantTitle ?? '' })) } : null;
    const report: CartOutcomeReport = { ...parsed.data, before: sync(parsed.data.before), after: sync(parsed.data.after) };
    const result = await settleOutcome(req.params.id, report);
    return res.status(result.status === 'unknown' ? 404 : 200).json(result);
  } catch (err) {
    return next(err);
  }
});

const packSchema = z.object({
  handle: z.string().min(1).max(120),
  pieces: z.array(z.object({ productId: z.string().min(1).max(100), options: optionsSchema })).min(1).max(12),
});

sessionRouter.post('/:id/add-pack', owner, writeLimit, async (req, res, next) => {
  const sessionId = req.params.id;
  try {
    const parsed = packSchema.safeParse((req.body ?? {}) as UiPackAddRequest);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
    await noteCartMode(req, await sessions.getOrCreate(sessionId), (id, change) => sessions.patch(id, change));
    const outcome = await executeCommerceAction({ session: await sessions.getOrCreate(sessionId), direct: true }, { type: 'add-pack', handle: parsed.data.handle, pieces: parsed.data.pieces });
    const reply: UiActionResponse = { ok: outcome.ok, ...(outcome.actions ? { actions: outcome.actions } : {}), ...(outcome.ok ? {} : { message: outcome.speech }) };
    return res.json(reply);
  } catch (err) {
    return next(err);
  }
});

const lineSchema = z.object({ lineId: z.string().min(1).max(200), quantity: z.number().int().min(0).max(10) });

sessionRouter.post('/:id/cart-line', owner, writeLimit, async (req, res, next) => {
  const sessionId = req.params.id;
  try {
    const parsed = lineSchema.safeParse((req.body ?? {}) as UiCartLineRequest);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
    await noteCartMode(req, await sessions.getOrCreate(sessionId), (id, change) => sessions.patch(id, change));
    const outcome = await executeCommerceAction({ session: await sessions.getOrCreate(sessionId), direct: true }, { type: 'update-line', lineId: parsed.data.lineId, quantity: parsed.data.quantity });
    const reply: UiActionResponse = {
      ok: outcome.ok,
      ...(outcome.actions ? { actions: outcome.actions } : {}),
      ...(outcome.cart ? { cart: outcome.cart } : {}),
      ...(outcome.ok ? {} : { message: outcome.speech }),
    };
    return res.json(reply);
  } catch (err) {
    return next(err);
  }
});
