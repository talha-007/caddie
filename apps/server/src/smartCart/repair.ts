import type { BasketSync, SmartCartRepair } from '@caddie/shared';
import { productById } from '../catalog/sync.js';
import { SMART_CART_OFFERS } from './config.js';
import { offerForProduct } from './eligibility.js';
import type { SmartCartOfferConfig } from './types.js';

/** At most this many lines are re-keyed from one basket read: a cart is small, and a runaway is not. */
const MAX_REPAIRS = 10;

/**
 * Lines already in the basket that qualify for an "any N" deal but carry no
 * key, so SupaEasy would not count them: added before the theme stamped
 * keys, or by a path that still does not (an add-on app, a drawer button, a
 * section the copied theme has not had updated). The widget re-writes each
 * with its key, the same key every other add path writes.
 *
 * Only plain lines - no properties, no selling plan, not part of a pack.
 * A line with properties came from a builder or an app and is left exactly
 * as it is: a pack piece given an "any N" key as well could be discounted
 * twice, and replacing an app's properties would break whatever it priced.
 */
export function missingDealKeys(lines: BasketSync['lines'], offers: readonly SmartCartOfferConfig[] = SMART_CART_OFFERS): SmartCartRepair[] {
  const repairs: SmartCartRepair[] = [];
  for (const line of lines) {
    if (repairs.length >= MAX_REPAIRS) break;
    // The basket route takes the widget's read as sent: anything malformed is passed over, not repaired.
    if (typeof line?.key !== 'string' || typeof line.productId !== 'string' || typeof line.variantId !== 'string' || !(line.quantity > 0)) continue;
    if ((line.properties && Object.keys(line.properties).length) || line.sellingPlanId || line.bundle) continue;
    const product = productById(line.productId);
    const offer = product ? offerForProduct(product, offers) : null;
    if (!offer) continue;
    repairs.push({ lineKey: line.key, variantId: line.variantId, quantity: line.quantity, properties: { [offer.triggerKey]: offer.triggerValue } });
  }
  return repairs;
}
