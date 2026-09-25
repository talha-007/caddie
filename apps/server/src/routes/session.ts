import { Router } from 'express';
import type { BasketSync, SessionRestartResponse } from '@caddie/shared';
import { log } from '../lib/logger.js';
import { productById } from '../catalog/sync.js';
import { sessions } from '../session/store.js';
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
