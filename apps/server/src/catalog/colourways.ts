import type { Product } from '@caddie/shared';
import { rangeOf } from './audience.js';
import { allProducts, catalogueVersion } from './sync.js';

/**
 * The other colours of a garment.
 *
 * Druids lists every colourway as its own product - "ARCHER JACKET - WHITE",
 * "ARCHER JACKET - BLUE" - so nothing in Shopify says they are the same
 * jacket. A customer asking "does this come in other colours?" was told no,
 * or asked which product they meant, about the one on their screen. The
 * garment is the name before the colour, and that is how a salesperson on
 * the shop floor would group them.
 */

/** "ARCHER JACKET - WHITE / GREY" -> "archer jacket". The garment, without its colour. */
export function garmentName(title: string): string {
  const dash = title.lastIndexOf(' - ');
  return (dash >= 0 ? title.slice(0, dash) : title).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The colour part of a title: "ARCHER JACKET - WHITE / GREY" -> "WHITE / GREY". */
export function colourwayName(title: string): string {
  const dash = title.lastIndexOf(' - ');
  return dash >= 0 ? title.slice(dash + 3).trim() : '';
}

let index = new Map<string, Product[]>();
let indexedVersion = -1;

function ensureIndex(): void {
  const version = catalogueVersion();
  if (version === indexedVersion) return;
  index = new Map();
  for (const product of allProducts()) {
    // A title without a colourway is a garment of its own - nothing to group it with.
    if (!colourwayName(product.title)) continue;
    const key = `${rangeOf(product)}|${garmentName(product.title)}`;
    const group = index.get(key) ?? [];
    group.push(product);
    index.set(key, group);
  }
  indexedVersion = version;
}

/** The same garment in its other colours, in stock, in the same range. */
export function otherColourways(product: Product): Product[] {
  ensureIndex();
  const group = index.get(`${rangeOf(product)}|${garmentName(product.title)}`) ?? [];
  return group.filter((other) => other.id !== product.id && other.variants.some((variant) => variant.available));
}
