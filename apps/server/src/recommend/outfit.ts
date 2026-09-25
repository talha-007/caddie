import type { Money, OutfitInput, OutfitPiece, OutfitRecommendation, Product } from '@caddie/shared';
import { parseRange, rangeOf, type Range } from '../catalog/audience.js';
import { matchesColourText } from '../catalog/colour.js';
import { searchProducts } from '../shopify/catalog.js';
import { storeCurrency } from '../shopify/money.js';
import { isPack } from './packs.js';
import { priceFor } from './pricing.js';
import { stockedInSize } from './sizeWords.js';

/**
 * Day 6 - Outfit builder.
 *
 * An outfit is one product per slot. We search each slot separately so the
 * customer never ends up with three tops, and so "change the colour" only has
 * to re-run one slot.
 */

export interface OutfitSlot {
  slot: string;
  /** Search terms that tend to surface this slot in the Druids catalogue. */
  terms: string;
  /**
   * Words that prove a product really belongs in this slot.
   *
   * The catalogue search is semantic, so a search for "shorts trousers navy"
   * happily returns a navy polo as its top hit. Without this check the outfit
   * ends up wearing the same polo as both its top and its bottom.
   */
  keywords: string[];
  required: boolean;
}

/**
 * Terms are matched against the Druids range as it is actually stocked:
 * POLOS, MIDLAYERS, GOLF HOODIES, GILETS, JACKETS, SHORTS, TROUSERS,
 * HEADWEAR, SOCKS. Re-check these when the real store replaces the test one.
 */
export const DEFAULT_SLOTS: OutfitSlot[] = [
  { slot: 'top', terms: 'polo shirt tee', keywords: ['polo', 'shirt', 'tee', 't-shirt'], required: true },
  {
    slot: 'bottom',
    terms: 'shorts trousers',
    keywords: ['short', 'trouser', 'pant', 'jogger', 'chino'],
    required: true,
  },
  {
    slot: 'layer',
    terms: 'midlayer hoodie gilet jacket',
    keywords: ['midlayer', 'mid layer', 'hoodie', 'gilet', 'jacket', 'vest', 'sweat'],
    required: false,
  },
  {
    slot: 'accessory',
    terms: 'socks beanie cap',
    keywords: ['sock', 'beanie', 'cap', 'hat', 'glove', 'bag', 'belt'],
    required: false,
  },
];

/** True when the product's name or tags say it belongs in this slot. */
export function fitsSlot(product: Product, slot: OutfitSlot): boolean {
  const haystack = [product.title, ...product.tags].join(' ').toLowerCase();
  return slot.keywords.some((keyword) => haystack.includes(keyword));
}

/** What goes with anything, for a slot that has nothing in the colour asked for. */
const NEUTRALS = 'black white grey stone';

/** A whole word, singular or plural: "polos" names a polo, "shortly" does not name shorts. */
function names(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}e?s?\\b`, 'i').test(text);
}

/**
 * The slots this outfit should fill, and what may fill each one.
 *
 * Asked for "polos and trousers for a club match", the builder used to fill
 * all four slots anyway and hand back a hoodie and socks nobody asked for. So
 * a customer who names garments gets those garments: only the slots they
 * named, and within a slot only the kind they named - "trousers" is not an
 * invitation to shorts. Name nothing ("something for a wedding") and they get
 * the full look.
 *
 * `pieces` is the model's reading of the same request, when it passes one;
 * the words themselves narrow what goes in each slot either way.
 */
export function slotsFor(rawSeed: string, pieces?: string[], utterance?: string): OutfitSlot[] {
  // Golf's own phrase, not a garment: "for my tee time" must not mean tees only.
  const clean = (text: string) => text.replace(/\btee[- ]?times?\b/gi, ' ');
  const seed = clean(rawSeed);
  const wanted = pieces?.length
    ? DEFAULT_SLOTS.filter((slot) => pieces.includes(slot.slot))
    : DEFAULT_SLOTS.filter((slot) => slot.keywords.some((keyword) => names(seed, keyword)));
  if (wanted.length === 0) return DEFAULT_SLOTS;

  /*
   * Which kind goes in each slot reads the customer's own words as well as the
   * model's seed. The model passed pieces ["top", "bottom"] with the seed "navy
   * outfit", and "trousers" never reached us - so the bottom was a pair of
   * shorts. Their words only narrow a slot already chosen, never add one.
   */
  const said = `${seed} ${utterance ? clean(utterance) : ''}`;
  return wanted.map((slot) => {
    const named = slot.keywords.filter((keyword) => names(said, keyword));
    return named.length ? { ...slot, keywords: named, terms: named.join(' ') } : slot;
  });
}

/** The outfit slots a piece of text names: "swap the orange polo" names the top. */
export function namedSlots(text: string): string[] {
  const clean = text.replace(/\btee[- ]?times?\b/gi, ' ');
  return DEFAULT_SLOTS.filter((slot) => slot.keywords.some((keyword) => names(clean, keyword))).map((slot) => slot.slot);
}

/** Everything a rebuild carries over from the outfit on screen. */
export interface OutfitOptions {
  /** Pieces staying as they are - a swap rebuilds one slot around these. */
  keep?: OutfitPiece[];
  /** Products that must not come back: the one being swapped out, and earlier ones. */
  exclude?: Iterable<string>;
  /** The range they are known to shop. Named in the seed wins; see catalog/audience.ts. */
  known?: 'men' | 'women';
}

/**
 * What is still affordable, at the size the customer is buying.
 *
 * `product.price` is Shopify's cheapest variant. Filtering on it let a
 * garment into the outfit that the customer could not afford once their
 * actual size was priced, and the total under-read to match.
 */
function withinBudget(products: Product[], remaining: number | null, size?: string): Product[] {
  if (remaining === null) return products;
  return products.filter((p) => priceFor(p, size).amount <= remaining);
}

function hasSize(product: Product, size?: string): boolean {
  return stockedInSize(product.variants, size);
}

/**
 * 2 for the exact colour, 1 for its family, so a navy piece beats a teal one
 * when they asked for navy-and-blue. Title and Colour option only - the tags
 * carry a "blue" campaign label on orange polos.
 */
function scoreForColour(product: Product, colour?: string): number {
  return colour ? matchesColourText(product, colour) : 0;
}

export async function recommendOutfit(
  input: OutfitInput,
  slots: OutfitSlot[] = DEFAULT_SLOTS,
  options: OutfitOptions = {},
): Promise<OutfitRecommendation> {
  const kept = options.keep ?? [];
  const pieces: OutfitPiece[] = [];
  /** Slots filled with a neutral because nothing came in their colour. */
  const stoodIn: Array<{ slot: string; title: string }> = [];
  const used = new Set<string>([...(options.exclude ?? []), ...kept.map((piece) => piece.product.id)]);
  let remaining = input.budget ? input.budget.amount : null;
  // What stays is already spent.
  for (const piece of kept) {
    if (remaining !== null) remaining -= priceFor(piece.product, input.size).amount;
  }

  /*
   * One range for the whole outfit. The live store has mens, ladies and kids
   * ranges, and an outfit built slot by slot from open searches came back a
   * kids polo with mens trousers. Named in their words wins, then what we know
   * of them, then what is already in the outfit. Knowing none of it, the main
   * mens range - said out loud in the reason, so it is never a silent guess.
   */
  const keptRange = kept.map((piece) => rangeOf(piece.product))[0];
  const range: Range = parseRange(input.seed).range ?? options.known ?? keptRange ?? 'men';
  const defaulted = !parseRange(input.seed).range && !options.known && !keptRange;
  const rangeWord = range === 'women' ? 'ladies' : range === 'kids' ? 'kids' : 'mens';

  for (const slot of slots) {
    const staying = kept.find((piece) => piece.slot === slot.slot);
    if (staying) {
      pieces.push(staying);
      continue;
    }

    /*
     * Garment first, occasion second.
     *
     * Searching "match day navy shorts trousers" returns a polo, a gilet and a
     * jacket - the occasion words swamp the garment. "navy shorts" returns the
     * shorts. So we lead with colour and garment, and only fall back to the
     * customer's own phrasing if that finds nothing.
     */
    const queries = [
      [rangeWord, input.colour, slot.terms].filter(Boolean).join(' '),
      [rangeWord, input.seed, input.colour, slot.terms].filter(Boolean).join(' '),
    ];

    let pick: Product | undefined;

    for (const query of queries) {
      const results = await searchProducts({
        query,
        limit: 8,
        ...(remaining !== null
          ? { maxPrice: remaining, currency: input.budget?.currency ?? storeCurrency() }
          : {}),
      });

      const usable = withinBudget(
        results.filter(
          (p) =>
            p.price.amount > 0 &&
            // Nobody wears the Ambassador Pack as a top.
            !isPack(p) &&
            hasSize(p, input.size) &&
            // A polo is not a pair of shorts, whatever the search thinks.
            fitsSlot(p, slot) &&
            // And nothing gets worn twice.
            !used.has(p.id),
        ),
        remaining,
        input.size,
      ).sort((a, b) => scoreForColour(b, input.colour) - scoreForColour(a, input.colour));

      pick = usable[0];
      if (pick) break;
    }

    /*
     * Nothing in their colour for this slot. A stylist would not drop the
     * trousers from a navy outfit, and would not quietly add purple ones
     * either: they would reach for a neutral and say so. Only neutrals, only
     * when a colour was asked for, and always named in the reason.
     */
    if (!pick && input.colour) {
      const results = await searchProducts({
        query: `${rangeWord} ${NEUTRALS} ${slot.terms}`,
        limit: 8,
        ...(remaining !== null
          ? { maxPrice: remaining, currency: input.budget?.currency ?? storeCurrency() }
          : {}),
      });
      pick = withinBudget(
        results.filter(
          (p) => p.price.amount > 0 && !isPack(p) && hasSize(p, input.size) && fitsSlot(p, slot) && !used.has(p.id),
        ),
        remaining,
        input.size,
      )[0];
      if (pick) stoodIn.push({ slot: slot.slot, title: pick.title });
    }

    // Nothing genuinely belongs in this slot - leave it empty and say so
    // rather than padding the outfit with something that does not fit.
    if (!pick) continue;

    pieces.push({ slot: slot.slot, product: pick });
    used.add(pick.id);
    if (remaining !== null) remaining -= priceFor(pick, input.size).amount;
  }

  const priced = pieces.map((piece) => priceFor(piece.product, input.size));
  const total: Money = {
    amount: Number(priced.reduce((sum, price) => sum + price.amount, 0).toFixed(2)),
    currency: priced[0]?.currency ?? input.budget?.currency ?? storeCurrency(),
  };
  const exact = priced.every((price) => price.exact);

  let reason = buildReason(pieces, input, slots);
  if (defaulted && pieces.length) reason += ' This is from the mens range - say if you would like ladies instead.';
  for (const { slot, title } of stoodIn) {
    reason += ` There is no ${slot} in ${input.colour}, so I have gone with the ${title} to go with it.`;
  }
  return {
    pieces,
    total,
    // A total added up from "from" prices is not a total, and saying so costs
    // less than a customer discovering it at checkout.
    reason: exact ? reason : `${reason} That is a starting price - the final one depends on the sizes chosen.`,
  };
}

function buildReason(pieces: OutfitPiece[], input: OutfitInput, slots: OutfitSlot[]): string {
  if (pieces.length === 0) {
    return `I could not put an outfit together for "${input.seed}" with what is in stock right now.`;
  }
  const bits = [`Built around ${input.seed}`];
  if (input.colour) bits.push(`leaning ${input.colour}`);
  if (input.budget) bits.push(`kept under ${input.budget.amount} ${input.budget.currency}`);
  const missingRequired = slots.filter(
    (slot) => slot.required && !pieces.some((piece) => piece.slot === slot.slot),
  );
  let reason = `${bits.join(', ')}.`;
  if (missingRequired.length) {
    // Colour is a hard rule now, so it is usually the reason: say so.
    const brief = input.colour ? `in ${input.colour}` : 'that fits the brief';
    reason += ` I could not find a ${missingRequired.map((s) => s.slot).join(' or ')} ${brief}.`;
  }
  return reason;
}
