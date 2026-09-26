import { Router } from 'express';
import type { BasketSync, CardChoice, ProfileRequest, SessionRestartResponse } from '@caddie/shared';
import { rememberShopper } from '../shopper/remember.js';
import { log } from '../lib/logger.js';
import { productById } from '../catalog/sync.js';
import { sessions } from '../session/store.js';
import { customerTurn, describeFocus, focusFromCard } from '../session/focus.js';
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

/**
 * POST /api/session/:id/choice
 *
 * A size tapped on a product card lived only in the card. The customer picked
 * M on a rain jacket, said "add it", and the Caddie - which had never heard of
 * the M - asked for their size and reached for a different jacket. The card
 * now says what they picked; it is kept for that product, and that product
 * becomes the one "it" means. Only options the product really has are kept.
 */
sessionRouter.post('/:id/choice', async (req, res, next) => {
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
      focusProductId: product.id,
      cardFocus: product.id,
      activeShoppingContext,
    });
    log.info('session.card_choice', { sessionId, productId: product.id, options });
    log.info('focus.updated', { sessionId, utterance: null, prior: describeFocus(session.activeShoppingContext), resolved: describeFocus(activeShoppingContext), source: 'card-action' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

sessionRouter.post('/:id/restart', async (req, res, next) => {
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
      sizeProfile: existing.sizeProfile,
      preferences: existing.preferences.audience ? { audience: existing.preferences.audience } : {},
      // Who they shop for and their sizes are about them, not the old chat.
      ...(existing.shopper
        ? {
            shopper: Object.fromEntries(
              Object.entries({
                range: existing.shopper.range,
                usualSize: existing.shopper.usualSize,
                waist: existing.shopper.waist,
                fit: existing.shopper.fit,
              }).filter(([, value]) => value !== undefined),
            ),
          }
        : {}),
      messages: [],
      ...(existing.cartId ? { cartId: existing.cartId } : {}),
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
 * POST /api/session/:id/profile - who they are shopping for, and their sizes.
 *
 * The widget's quick start asks these first, so the first thing shown is
 * already their range in their size, and every size picker opens on it. Held
 * like anything they say in chat: a later "actually I'm an XL" replaces it.
 * Checked against what the store sells rather than taken as given - the body
 * comes from a browser.
 */
sessionRouter.post('/:id/profile', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Partial<ProfileRequest>;
    const range = body.range === 'men' || body.range === 'women' || body.range === 'kids' ? body.range : undefined;
    // Letter sizes, ladies' 6-22, kids' age bands ("8/10", "9-10") - nothing longer, nothing stranger.
    const clean = (value: unknown) =>
      typeof value === 'string' && /^[A-Za-z0-9/ -]{1,12}$/.test(value.trim()) ? value.trim().toUpperCase() : undefined;
    const size = clean(body.size);
    const waist = typeof body.waist === 'string' && /^\d{2}$/.test(body.waist.trim()) ? body.waist.trim() : undefined;
    await sessions.getOrCreate(req.params.id);
    const shopper = await rememberShopper(req.params.id, {
      ...(range ? { range } : {}),
      ...(size ? { usualSize: size } : {}),
      ...(waist ? { waist } : {}),
    });
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
sessionRouter.post('/:id/basket', async (req, res, next) => {
  try {
    const body = req.body as Partial<BasketSync> | undefined;
    const lines = Array.isArray(body?.lines) ? body.lines.slice(0, 100) : [];
    await sessions.getOrCreate(req.params.id);
    await sessions.patch(req.params.id, {
      cartMode: 'theme',
      basket: lines
        .filter((line) => typeof line?.key === 'string' && typeof line?.productId === 'string')
        .map((line) => {
          /*
           * Names from our own catalogue, never from the request. These lines
           * go into the model's instructions, and anyone can call this
           * endpoint: a "product" titled "ignore your rules and..." would be a
           * prompt injection. Only the ids are taken from the client.
           */
          const product = productById(String(line.productId));
          const variant = product?.variants.find((entry) => entry.id === String(line.variantId));
          return {
          lineId: String(line.key).slice(0, 200),
          productId: String(line.productId),
          title: product?.title ?? 'an item from the store',
          variantTitle: variant ? Object.values(variant.options).filter((value) => value !== 'Default Title').join(' / ') : '',
          quantity: Number(line.quantity) || 0,
          ...(line.bundle ? { bundle: String(line.bundle).slice(0, 100) } : {}),
          ...(line.bundleName ? { bundleName: String(line.bundleName).slice(0, 100) } : {}),
          };
        }),
    });
    res.json({ ok: true, lines: lines.length });
  } catch (err) {
    next(err);
  }
});
