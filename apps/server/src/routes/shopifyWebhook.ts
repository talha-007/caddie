import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { productForInventoryItem, refreshProduct, removeProduct, syncDelta } from '../catalog/sync.js';
import { env } from '../env.js';
import { log } from '../lib/logger.js';

/**
 * Shopify webhooks, which are what actually keep the catalogue mirror current.
 *
 * A busy store changes stock constantly, and no polling interval is right for
 * that - short enough to be fresh is wasteful, cheap enough to be sensible is
 * stale. Webhooks invert it: Shopify tells us the moment something moves, we
 * re-read that one product, and the mirror is current within seconds for
 * nothing.
 *
 * The body must stay raw here. The HMAC is over the exact bytes Shopify sent,
 * and JSON.parse then re-stringify does not reproduce them.
 */

export const shopifyWebhookRouter: Router = Router();

/** Shopify signs every webhook with the app's secret. */
function verify(raw: unknown, signature: string | undefined): boolean {
  if (!signature || !env.shopify.webhookSecret) return false;

  /*
   * Must be the raw bytes. If a JSON parser ran first this is an object, the
   * signature can no longer be checked, and hashing it throws - which, in an
   * async handler, takes the process down. Refuse instead.
   */
  if (!Buffer.isBuffer(raw)) {
    log.error('shopify.webhook.body_not_raw');
    return false;
  }

  const expected = createHmac('sha256', env.shopify.webhookSecret).update(raw).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }

  // Lengths must match before timingSafeEqual, and it must be constant time.
  return expected.length === given.length && timingSafeEqual(expected, given);
}

shopifyWebhookRouter.post(
  '/',
  express.raw({ type: '*/*', limit: '2mb' }),
  async (req, res) => {
    const raw = req.body as Buffer;
    const topic = req.get('x-shopify-topic') ?? '';

    if (!verify(raw, req.get('x-shopify-hmac-sha256'))) {
      log.warn('shopify.webhook.bad_signature', { topic });
      return res.status(401).send('bad signature');
    }

    /*
     * Answer immediately and do the work after. Shopify retries anything that
     * takes more than five seconds or fails, and a retry storm on a busy store
     * is worse than a slightly late mirror.
     */
    res.status(200).send('ok');

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      log.warn('shopify.webhook.unreadable', { topic });
      return;
    }

    try {
      await handle(topic, payload);
    } catch (err) {
      // The delta pull will catch whatever this missed, so nothing is lost.
      log.error('shopify.webhook.failed', { topic, err: String(err) });
    }
  },
);

/**
 * Products waiting to be re-read, and the timer that will do it.
 *
 * A bulk edit in the Shopify admin - a sale going on, a price list imported -
 * fires a webhook per product. Two and a half thousand of those, each firing
 * its own Admin API read, would throttle us out of the API we depend on. So
 * they are collected for a moment and fetched as one delta instead.
 */
const pending = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;

const BURST_WINDOW_MS = 1500;
/** Past this many at once it is a bulk edit, and a delta pull is cheaper. */
const BURST_IS_BULK = 15;

function schedule(productId: string): void {
  pending.add(productId);
  if (flushTimer) return;

  flushTimer = setTimeout(() => {
    const ids = [...pending];
    pending.clear();
    flushTimer = null;

    const work =
      ids.length >= BURST_IS_BULK
        ? // One query for everything that changed beats one per product.
          syncDelta().then((count) => log.info('shopify.webhook.bulk', { products: ids.length, refreshed: count }))
        : Promise.all(ids.map((id) => refreshProduct(id))).then(() => undefined);

    work.catch((err) => log.error('shopify.webhook.flush_failed', { err: String(err) }));
  }, BURST_WINDOW_MS);

  flushTimer.unref?.();
}

async function handle(topic: string, payload: Record<string, unknown>): Promise<void> {
  const gid = (id: unknown, kind: string) =>
    typeof id === 'number' || typeof id === 'string' ? `gid://shopify/${kind}/${id}` : null;

  switch (topic) {
    case 'products/create':
    case 'products/update': {
      const productId = gid(payload.id, 'Product');
      if (!productId) return;
      schedule(productId);
      log.debug('shopify.webhook.product', { topic, productId });
      return;
    }

    case 'products/delete': {
      const productId = gid(payload.id, 'Product');
      if (productId) removeProduct(productId);
      return;
    }

    case 'inventory_levels/update': {
      /*
       * This one names an inventory item, not a product, which is why the
       * mirror keeps an index from one to the other. An unknown item means a
       * product we do not carry - or one added since the last pull, which the
       * delta will bring in.
       */
      const inventoryItemId = gid(payload.inventory_item_id, 'InventoryItem');
      if (!inventoryItemId) return;

      const productId = productForInventoryItem(inventoryItemId);
      if (!productId) return;

      schedule(productId);
      log.debug('shopify.webhook.stock', { productId });
      return;
    }

    default:
      // Anything else we are subscribed to: let the delta pull sort it out.
      log.debug('shopify.webhook.ignored', { topic });
      await syncDelta().catch(() => undefined);
  }
}
