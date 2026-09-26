import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { priceComparisons } from '../src/ai/verify.js';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * "Show me the cheapest rainy jacket you have": £35 one time, £80 the next,
 * with a £16 waterproof jacket in the catalogue. And "something cheaper"
 * after a £36 gilet answered with another £36 gilet, "more affordable".
 * Cheapest and cheaper are computed from real prices now.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function item(title: string, type: string, description: string, price: number, opts: { sizes?: Record<string, number>; tags?: string[] } = {}): Product {
  const sizes = opts.sizes ?? { S: price, M: price, L: price, XL: price };
  const lowest = Math.min(...Object.values(sizes));
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND, ...(opts.tags ?? [])],
    price: { amount: lowest, currency: 'GBP' },
    options: [{ name: 'Size', values: Object.keys(sizes) }],
    variants: Object.entries(sizes).map(([size, amount]) => ({ id: `${title}-${size}`, title: size, available: true, price: { amount, currency: 'GBP' }, options: { Size: size } })),
    description,
  };
}

const WATERPROOF = 'Fully waterproof with taped seams, breathable.';
const THUNDER = item('THUNDER RAIN JACKET - NAVY', 'RAIN JACKET', WATERPROOF, 80, { tags: ['best-seller'] });
const NADIR = item('NADIR RAIN JACKET - SAGE', 'RAIN JACKET', WATERPROOF, 70);
const GLEN = item('GLEN RAIN JACKET - BLUE', 'RAIN JACKET', WATERPROOF, 35);
const WARRIOR = item('WARRIOR JACKET - BLACK', 'JACKETS', `Windproof and ${WATERPROOF.toLowerCase()}`, 16);
const WALTER = item('WALTER JACKET - BLACK', 'JACKETS', 'A light shell for dry days.', 12);
const LADIES_RAIN = item('LADIES STORME RAIN JACKET - NAVY', 'LADIES RAIN JACKET', WATERPROOF, 64);
const CHEAP_POLO = item('GARDEN POLO - NAVY', 'POLOS', 'Breathable.', 5);
// Starting price and XL price differ: A is cheaper from, B is cheaper in XL.
const A = item('ALPHA JACKET - GREY', 'JACKETS', 'Brushed warmth, stretchy.', 15, { sizes: { S: 15, M: 15, L: 15, XL: 30 } });
const B = item('BETA JACKET - GREY', 'JACKETS', 'Brushed warmth, stretchy.', 20, { sizes: { S: 20, M: 20, L: 20, XL: 22 } });

const ARVID = item('ARVID GILET - NAVY', 'GILETS', 'Warm and windproof.', 36);
const BLAKE = item('BLAKE GILET - GREY', 'GILETS', 'Warm and breathable.', 36);
const DECK = item('DECK GILET - BLACK', 'GILETS', 'Warm and stretchy.', 30);
const STEALTH = item('STEALTH GILET - BLACK', 'GILETS', 'Warm and water-resistant.', 10);

beforeEach(() => {
  setCatalogueForTests([THUNDER, NADIR, GLEN, WARRIOR, WALTER, LADIES_RAIN, CHEAP_POLO, A, B, ARVID, BLAKE, DECK, STEALTH]);
  setDealsForTests([]);
});

async function ask(args: Record<string, unknown>, utterance: string, sessionId?: string) {
  const session = await sessions.getOrCreate(sessionId ?? `price-${Math.random()}`);
  const result = await runTool('search_products', args, { session, utterance });
  const cards = result.attachment?.kind === 'products' ? result.attachment.products : [];
  return { result, titles: cards.map((p) => p.title) };
}

/** A customer looking at this product - as the last search's lead. */
async function lookingAt(product: Product): Promise<string> {
  const id = `price-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { lastLead: { id: product.id, colour: 'navy' } });
  return id;
}

describe('cheapest', () => {
  it('the live failure: the £16 waterproof jacket leads, with the proof in the facts', async () => {
    const { result, titles } = await ask({ query: 'rainy jacket', category: 'jacket' }, 'Show me the cheapest rainy jacket you have.');
    expect(titles[0]).toBe('WARRIOR JACKET - BLACK');
    // Cheapest first all the way down.
    expect(titles.slice(0, 4)).toEqual(['WARRIOR JACKET - BLACK', 'GLEN RAIN JACKET - BLUE', 'LADIES STORME RAIN JACKET - NAVY', 'NADIR RAIN JACKET - SAGE']);
    // The £12 jacket is not for rain, and the £5 polo is not a jacket.
    expect(titles).not.toContain('WALTER JACKET - BLACK');
    expect(titles).not.toContain('GARDEN POLO - NAVY');
    expect(result.facts).toMatch(/Price ordering: sorted by price, lowest first/);
    expect(result.facts).toMatch(/The lowest-priced is WARRIOR JACKET - BLACK \[[^\]]+\] at £16\.00 - you may call it the cheapest/);
    expect(result.speech).toMatch(/The cheapest that fits is the Warrior Jacket - Black at £16\.00/i);
  });

  it('the best-selling, best-matching £80 jacket does not outrank price', async () => {
    const { titles } = await ask({ query: 'rain jacket', category: 'jacket' }, 'cheapest rain jacket please');
    expect(titles[0]).toBe('WARRIOR JACKET - BLACK');
    expect(titles.indexOf('THUNDER RAIN JACKET - NAVY')).toBeGreaterThan(titles.indexOf('GLEN RAIN JACKET - BLUE'));
  });

  it('the same request gives the same answer every time', async () => {
    const leads = new Set<string>();
    for (let i = 0; i < 3; i += 1) leads.add((await ask({ query: 'rainy jacket' }, 'Show me the cheapest rainy jacket you have.')).titles[0]!);
    expect([...leads]).toEqual(['WARRIOR JACKET - BLACK']);
  });

  it('in XL, the XL price decides: B at £22 beats A, which is £15 from but £30 in XL', async () => {
    const { result, titles } = await ask({ query: 'jacket', size: 'XL' }, 'cheapest warm jacket in XL');
    expect(titles.indexOf('BETA JACKET - GREY')).toBeLessThan(titles.indexOf('ALPHA JACKET - GREY'));
    expect(result.facts).toMatch(/priced in XL/);
  });

  it('a budget first, then the minimum: under £40 is the £16 and the £35', async () => {
    const { titles } = await ask({ query: 'waterproof jacket', maxPrice: 40 }, 'the cheapest waterproof jacket under £40');
    expect(titles).toEqual(['WARRIOR JACKET - BLACK', 'GLEN RAIN JACKET - BLUE']);
  });

  it('price never bypasses a rule: colour, range', async () => {
    // Navy only - the ladies one is navy too, and no range was asked for - cheapest first.
    expect((await ask({ query: 'navy rain jacket', colour: 'navy' }, 'the cheapest navy rain jacket')).titles).toEqual(['LADIES STORME RAIN JACKET - NAVY', 'THUNDER RAIN JACKET - NAVY']);
    expect((await ask({ query: 'ladies rain jacket' }, 'cheapest ladies rain jacket')).titles).toEqual(['LADIES STORME RAIN JACKET - NAVY']);
  });

  it('an ordinary search is ordered as it always was - no price ordering, no cheapest', async () => {
    const { result } = await ask({ query: 'rainy jacket' }, 'show me a rainy jacket');
    expect(result.facts ?? '').not.toMatch(/Price ordering/);
    expect(result.speech).not.toMatch(/cheapest/i);
  });
});

describe('cheaper', () => {
  it('after the £36 Arvid Gilet: only below £36, with the saving worked out', async () => {
    const id = await lookingAt(ARVID);
    const { result, titles } = await ask({ query: 'gilet' }, 'Something cheaper.', id);
    expect(titles.sort()).toEqual(['DECK GILET - BLACK', 'STEALTH GILET - BLACK']);
    expect(titles).not.toContain('BLAKE GILET - GREY');
    expect(result.facts).toMatch(/Price comparison: compared with ARVID GILET - NAVY \[[^\]]+\] at £36\.00/);
    expect(result.facts).toMatch(/STEALTH GILET - BLACK \[[^\]]+\]: £10\.00, £26\.00 cheaper/);
    expect(result.facts).toMatch(/Never call anything at £36\.00 or more cheaper/);
  });

  it('the kind comes from what is being compared, even when the model searches for anything', async () => {
    const id = await lookingAt(ARVID);
    const { titles } = await ask({ query: 'something cheaper' }, 'Something cheaper.', id);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((title) => /GILET/.test(title))).toBe(true);
  });

  it('nothing cheaper than the cheapest: said plainly, nothing offered as cheaper', async () => {
    const id = await lookingAt(STEALTH);
    const { result } = await ask({ query: 'gilet' }, 'Something cheaper.', id);
    expect(result.speech).toMatch(/couldn't find anything cheaper than the Stealth Gilet - Black at £10\.00/);
    expect(result.attachment).toBeUndefined();
  });

  it('with nothing in focus, no comparison is made', async () => {
    // Following up a gilet search, but no product was ever led with or looked at.
    const id = `price-${Math.random()}`;
    await sessions.getOrCreate(id);
    await sessions.patch(id, { lastSearch: { categories: ['gilet'] } });
    const { result } = await ask({ query: 'gilet' }, 'Something cheaper.', id);
    expect(result.facts).toMatch(/no product is in focus to compare with/);
    expect(result.facts).not.toMatch(/Price comparison/);
  });

  it('"cheaper than £30" is a budget, not a comparison', async () => {
    const id = await lookingAt(ARVID);
    const { result } = await ask({ query: 'gilet', maxPrice: 30 }, 'a gilet cheaper than £30', id);
    expect(result.facts ?? '').not.toMatch(/Price comparison/);
  });
});

describe('the reply may only compare prices the search compared', () => {
  const nothing = 'Results: BLAKE GILET - GREY - £36.00';
  it('"cheaper" or "cheapest" with no price evidence is caught', () => {
    expect(priceComparisons('The Blake Gilet at £36 is a more affordable option.', nothing)).toEqual([{ kind: 'comparison', claim: 'more affordable' }]);
    expect(priceComparisons('This is our cheapest jacket.', nothing)).toEqual([{ kind: 'comparison', claim: 'cheapest' }]);
  });

  it('allowed when the facts carry the proof', () => {
    expect(priceComparisons('The Warrior Jacket is the cheapest at £16.', 'Price ordering: sorted by price...')).toEqual([]);
    expect(priceComparisons('The Deck Gilet is £6 cheaper.', 'Price comparison: compared with ARVID GILET...')).toEqual([]);
  });

  it('a comparison ordering is not a proof of cheapest', () => {
    expect(priceComparisons('The Stealth Gilet is the cheapest gilet.', 'Price comparison: compared with ARVID GILET...')).toEqual([{ kind: 'comparison', claim: 'cheapest' }]);
  });

  it('what they asked for, and "nothing cheaper", are not claims', () => {
    expect(priceComparisons('You wanted something cheaper, so here are a few.', nothing)).toEqual([]);
    expect(priceComparisons("I couldn't find anything cheaper that fits.", nothing)).toEqual([]);
  });
});
