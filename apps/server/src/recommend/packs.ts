import type { Money, PackRecommendation, Product } from '@caddie/shared';
import { searchProducts } from '../shopify/catalog.js';
import { stockedInSize } from './sizeWords.js';

/**
 * The packs Druids actually sells.
 *
 * Before this, "show me your packs" put together three products under a
 * budget and called it a pack. That is a useful answer to "what can I get for
 * £100" and the wrong answer to "what is the Ambassador Pack" - the customer
 * is asking about a real thing on the real website, with a real price.
 *
 * The split follows the project rule. The name, the price and the description
 * are a Shopify product, fetched like any other. Which garments fill it is
 * ours, and is here. Neither is the model's.
 *
 * Contents are from druids.com. Only the two whose prices are published on a
 * page we could read are here: Druids sells ten more bundles (Prestige Pack,
 * Players Bundle, Any 3 Polos, and the ladies and kids ranges) and inventing
 * a price for any of them is precisely what the Caddie must never do.
 */

export interface PackSlot {
  /** What the customer is told this piece is. */
  slot: string;
  /** Search terms that surface this slot in the Druids range. */
  terms: string;
  /** Words that prove a product really belongs in the slot. */
  keywords: string[];
}

export interface NamedPack {
  /** The Shopify product title. The price and the name come from there. */
  product: string;
  /** What customers call it. Matched against the whole message. */
  aliases: string[];
  slots: PackSlot[];
}

export const NAMED_PACKS: NamedPack[] = [
  {
    product: 'GOLF AMBASSADOR PACK',
    aliases: ['ambassador pack', 'ambassador', '6 for 99', 'six for 99', '6 for £99'],
    slots: [
      { slot: 'jacket', terms: 'jacket gilet', keywords: ['jacket', 'gilet'] },
      { slot: 'midlayer', terms: 'midlayer hoodie', keywords: ['midlayer', 'mid layer', 'hoodie', 'sweat'] },
      { slot: 'polo', terms: 'polo shirt tee', keywords: ['polo', 'shirt', 'tee'] },
      { slot: 'trouser', terms: 'trousers shorts', keywords: ['trouser', 'short', 'jogger', 'chino', 'pant'] },
      { slot: 'belt or cap', terms: 'belt cap beanie', keywords: ['belt', 'cap', 'beanie', 'hat'] },
      { slot: 'socks', terms: 'socks', keywords: ['sock'] },
    ],
  },
  {
    product: 'RAINSUIT SPECIAL',
    aliases: ['rainsuit', 'rain suit', 'rainsuit special', 'waterproofs', 'waterproof suit'],
    slots: [
      { slot: 'jacket', terms: 'jacket waterproof rain', keywords: ['jacket'] },
      { slot: 'trousers', terms: 'trousers waterproof rain', keywords: ['trouser', 'pant'] },
      { slot: 'beanie', terms: 'beanie hat cap', keywords: ['beanie', 'hat', 'cap'] },
    ],
  },
];

/**
 * The bundles Druids sells that we cannot build.
 *
 * Their prices are set by a bundle app and rendered in the browser, so they
 * appear in no product feed, no collection JSON and no page we can read. That
 * makes them unbuildable - but not unaskable.
 *
 * Knowing the names is the entire point. Asked "what is in the Prestige Pack",
 * the Caddie used to fall through to the budget assembler, put three garments
 * together, and answer "the Prestige Pack includes three items and costs £92".
 * There is no Prestige Pack in the store and £92 is not its price. Naming them
 * here lets us say we cannot check that one, which is true, instead of
 * inventing a pack and a price for it.
 *
 * Slot structures are known - each is a set of collections on druids.com, e.g.
 * the Prestige Pack is a polo, a hoodie or sweater, and golf joggers. Add one
 * to NAMED_PACKS and seedPacks.mjs together the moment its price is confirmed.
 */
export interface UnstockedBundle {
  name: string;
  aliases: string[];
}

export const UNSTOCKED_BUNDLES: UnstockedBundle[] = [
  { name: 'Prestige Pack', aliases: ['prestige pack', 'prestige'] },
  { name: 'Players Bundle', aliases: ['players bundle', 'players pack'] },
  { name: 'Any 3 Polos', aliases: ['any 3 polos', 'any three polos', '3 polo deal', 'three polo deal'] },
  { name: 'Any 2 Shorts', aliases: ['any 2 shorts', 'any two shorts'] },
  { name: 'Any 2 Trousers', aliases: ['any 2 trousers', 'any two trousers'] },
  { name: 'Any 2 Joggers', aliases: ['any 2 joggers', 'any two joggers'] },
  { name: 'Ladies Ambassador Pack', aliases: ['ladies ambassador', 'womens ambassador'] },
  { name: 'Ladies Rainsuit Special', aliases: ['ladies rainsuit', 'womens rainsuit'] },
  { name: 'Ladies Players Bundle', aliases: ['ladies players', 'womens players'] },
  { name: 'Kids Ambassador Pack', aliases: ['kids ambassador', 'junior ambassador'] },
  { name: 'Kids Rainsuit Special', aliases: ['kids rainsuit', 'junior rainsuit'] },
];

/**
 * A bundle we know the name of but cannot price or fill.
 *
 * Checked before findNamedPack, because "ladies ambassador pack" contains
 * "ambassador" and would otherwise be answered with the mens pack - the wrong
 * range at a price that is not theirs.
 */
export function findUnstockedBundle(text: string | undefined): UnstockedBundle | null {
  if (!text) return null;
  const haystack = text.toLowerCase();
  return (
    UNSTOCKED_BUNDLES.find(
      (bundle) =>
        haystack.includes(bundle.name.toLowerCase()) ||
        bundle.aliases.some((alias) => haystack.includes(alias)),
    ) ?? null
  );
}

/**
 * A pack is a product in the catalogue, so it turns up in ordinary searches.
 * Without this the Ambassador Pack could be chosen as a garment to go inside
 * a pack, or worn as the top half of an outfit.
 */
export function isPack(product: Product): boolean {
  return (
    product.productType?.toUpperCase() === 'PACKS' ||
    product.tags.some((tag) => tag.toLowerCase() === 'druids-pack')
  );
}

/**
 * Another range entirely. Both packs we stock are mens.
 *
 * "ladies ambassador pack" contains "ambassador", so without this it matches
 * the mens pack - a woman asking about hers is answered with the wrong range
 * at a price that is not hers. The tool checks the unstocked bundles first,
 * which also catches it, but that leaves the ordering of two calls as the only
 * thing standing between a customer and a wrong price. Better that neither
 * call can get it wrong on its own.
 */
const OTHER_RANGE = /\b(ladies|lady|womens?|women|kids?|junior|juniors|girls?|boys?)\b/i;

/** The pack the customer is naming, if they are naming one. */
export function findNamedPack(text: string | undefined): NamedPack | null {
  if (!text) return null;
  if (OTHER_RANGE.test(text)) return null;
  const haystack = text.toLowerCase();

  return (
    NAMED_PACKS.find(
      (pack) =>
        haystack.includes(pack.product.toLowerCase()) ||
        pack.aliases.some((alias) => haystack.includes(alias)),
    ) ?? null
  );
}

function fitsSlot(product: Product, slot: PackSlot): boolean {
  const haystack = [product.title, ...product.tags].join(' ').toLowerCase();
  return slot.keywords.some((keyword) => haystack.includes(keyword));
}

/** Finds the pack's own Shopify product, which is where the price lives. */
async function packProduct(pack: NamedPack): Promise<Product | null> {
  const results = await searchProducts({ query: pack.product, limit: 10 });
  return results.find((product) => product.title.toUpperCase() === pack.product.toUpperCase()) ?? null;
}

export interface NamedPackInput {
  colour?: string;
  size?: string;
}

/**
 * Builds one of the real packs: its price from Shopify, its contents from
 * whatever is genuinely in stock.
 *
 * A slot that cannot be filled is left out rather than padded, the same way an
 * outfit slot is. The pack still costs what Shopify says it costs - a pack we
 * could only half fill is a stock problem to be honest about, not a discount
 * we are entitled to invent.
 */
export async function recommendNamedPack(
  pack: NamedPack,
  input: NamedPackInput = {},
): Promise<PackRecommendation | null> {
  const product = await packProduct(pack);
  if (!product) return null;

  const items: Product[] = [];
  const slots: Array<{ slot: string; productId: string | null }> = [];
  const used = new Set<string>();

  for (const slot of pack.slots) {
    const queries = [[input.colour, slot.terms].filter(Boolean).join(' '), slot.terms];
    let pick: Product | undefined;

    for (const query of queries) {
      const results = await searchProducts({ query, limit: 8 });
      pick = results.find(
        (candidate) =>
          !isPack(candidate) &&
          candidate.price.amount > 0 &&
          fitsSlot(candidate, slot) &&
          stockedInSize(candidate.variants, input.size) &&
          !used.has(candidate.id),
      );
      if (pick) break;
    }

    slots.push({ slot: slot.slot, productId: pick?.id ?? null });
    if (!pick) continue;
    items.push(pick);
    used.add(pick.id);
  }

  const price: Money = product.price;

  return {
    items,
    // The pack's price, not the sum of its contents.
    total: price,
    overBudget: false,
    reason: buildReason(product.title, items.length, pack.slots.length, price),
    pack: { productId: product.id, title: product.title, price, slots },
  };
}

function buildReason(title: string, filled: number, wanted: number, price: Money): string {
  const headline = `The ${title.toLowerCase()} is ${price.amount} ${price.currency} for ${wanted} pieces.`;
  if (filled === wanted) return `${headline} Here is how it looks in what we have in stock.`;
  if (filled === 0) {
    return `${headline} I cannot fill any of it from what is in stock at the moment, though.`;
  }
  return `${headline} I could fill ${filled} of the ${wanted} from stock right now.`;
}
