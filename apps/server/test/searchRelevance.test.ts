import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setBestSellersForTests } from '../src/catalog/bestSellers.js';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { lookupProductName } from '../src/catalog/lookup.js';
import { searchLocal, searchLocalScored } from '../src/catalog/search.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * Which of the products that meet every rule come first. Word overlap and
 * then the cheapest price used to decide: "polo" opened on a £5 clearance
 * polo, and "Elite Polo Navy" was followed by any navy polo at all.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
const TOPS = ['S', 'M', 'L', 'XL', '2XL'];

function garment(title: string, type: string, opts: { price?: number; out?: string[]; sizes?: string[]; tags?: string[]; description?: string } = {}): Product {
  const sizes = opts.sizes ?? TOPS;
  const price = opts.price ?? 20;
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND, ...(opts.tags ?? [])],
    price: { amount: price, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size) => ({ id: `${title}-${size}`, title: size, available: !(opts.out ?? []).includes(size), price: { amount: price, currency: 'GBP' }, options: { Size: size } })),
    description: opts.description ?? null,
  };
}

const ELITE_NAVY = garment('ELITE POLO - NAVY', 'POLOS');
const ELITE_WHITE = garment('ELITE POLO - WHITE', 'POLOS');
const ELITE_BLACK = garment('ELITE POLO - BLACK', 'POLOS');
const LADIES_ELITE_NAVY = garment('LADIES ELITE POLO - NAVY', 'LADIES POLOS', { sizes: ['8', '10', '12'], price: 12 });
const AQUA_NAVY = garment('AQUA POLO - NAVY', 'POLOS', { price: 12 });
const SPEED_NAVY = garment('SPEED POLO - NAVY', 'POLOS', { price: 12 });
// A clearance polo: cheapest, one size left, campaign tagged "20 off".
const CLEARANCE = garment('PINEAPPLE SKULLZ POLO - BLUE / ORANGE', 'POLOS', { price: 5, out: ['S', 'M', 'L', '2XL'], tags: ['20 off'] });
const HONEYCOMB = garment('HONEYCOMB POLO - WHITE', 'POLOS', { price: 20 });
const GALACTIC_NAVY = garment('GALACTIC MIDLAYER - NAVY', 'MIDLAYERS', { price: 32 });
const GALACTIC_WHITE = garment('GALACTIC MIDLAYER - WHITE', 'MIDLAYERS', { price: 32 });
const GALACTIC_BLACK = garment('GALACTIC MIDLAYER - BLACK', 'MIDLAYERS', { price: 32 });
const PIQUE_MIDLAYER = garment('PIQUE MIDLAYER - GREY', 'MIDLAYERS', { price: 14 });
const ULTRA_MIDLAYER = garment('ULTRA BLEND MIDLAYER - GREY', 'MIDLAYERS', { price: 14 });
const VAPOR_NAVY = garment('VAPOR JACKET 2.0 - NAVY', 'JACKETS', { price: 34 });
const VAPOR_SAGE = garment('VAPOR JACKET 2.0 - SAGE', 'JACKETS', { price: 34 });
const ARCHER = garment('ARCHER JACKET - WHITE', 'JACKETS', { price: 20 });
const MEMBERS = garment('MEMBERS JACKET - BLUE', 'JACKETS', { price: 20 });
const CLIMA_TROUSERS = garment("MEN'S CLIMA GOLF TROUSERS - NAVY", 'TROUSERS', { sizes: ['32', '34', '36'], price: 30 });
const JOGGERS = garment("MEN'S GOLF JOGGERS - BLACK", 'JOGGERS', { sizes: ['32', '34', '36'], price: 20 });
const HEXA = garment('HEXA PERFORMANCE POLO - SAGE', 'POLOS', { price: 14 });
const HEXIE = garment('HEXIE POLO - BLACK', 'POLOS', { price: 12 });

const CATALOGUE = [
  ELITE_NAVY, ELITE_WHITE, ELITE_BLACK, LADIES_ELITE_NAVY, AQUA_NAVY, SPEED_NAVY, CLEARANCE, HONEYCOMB,
  GALACTIC_NAVY, GALACTIC_WHITE, GALACTIC_BLACK, PIQUE_MIDLAYER, ULTRA_MIDLAYER,
  VAPOR_NAVY, VAPOR_SAGE, ARCHER, MEMBERS, CLIMA_TROUSERS, JOGGERS, HEXA, HEXIE,
];

let id = '';
beforeEach(async () => {
  setCatalogueForTests(CATALOGUE);
  setDealsForTests([]);
  setBestSellersForTests([]);
  id = `relevance-${Math.random()}`;
  await sessions.getOrCreate(id);
});

const titles = (products: Product[]) => products.map((p) => p.title);

async function search(args: Record<string, unknown>, utterance: string) {
  const session = await sessions.getOrCreate(id);
  const result = await runTool('search_products', args, { session, utterance });
  return { result, titles: result.attachment?.kind === 'products' ? titles(result.attachment.products) : [] };
}

describe('name words outrank garment words', () => {
  it('"Elite Polo Navy": the Elite Polo first, and no other navy polo after it', async () => {
    const { titles: shown, result } = await search({ query: 'Elite Polo Navy', colour: 'navy' }, 'Elite Polo Navy');
    expect(shown[0]).toBe('ELITE POLO - NAVY');
    expect(result.facts).toMatch(/ELITE POLO - NAVY .*the design they named: Elite Polo/);
    expect(shown).not.toContain('AQUA POLO - NAVY');
    expect(shown).not.toContain('SPEED POLO - NAVY');
  });

  it('"Galactic Midlayer": the Galactic colourways, not every midlayer', () => {
    const shown = titles(searchLocal({ query: 'Galactic Midlayer', limit: 6 }));
    expect(shown.sort()).toEqual(['GALACTIC MIDLAYER - BLACK', 'GALACTIC MIDLAYER - NAVY', 'GALACTIC MIDLAYER - WHITE']);
  });

  it('"Elite Polo": the Elite family before, and instead of, other polos', () => {
    const shown = titles(searchLocal({ query: 'Elite Polo', limit: 6 }));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((t) => t.includes('ELITE POLO'))).toBe(true);
    // The mens design is exactly what was named; the ladies one has the name inside a longer one.
    expect(shown.indexOf('LADIES ELITE POLO - NAVY')).toBeGreaterThan(shown.indexOf('ELITE POLO - WHITE'));
  });

  it('says why: the words matched, together, as the exact design', () => {
    const [top] = searchLocalScored({ query: 'galactic midlayer', limit: 3 });
    expect(top).toMatchObject({ matchedWords: ['galactic', 'midlayer'], identifyingMatched: 1, identifyingAsked: 1, coverage: 1, phrase: true, exactDesign: true });
  });
});

describe('a threshold, not a quota', () => {
  it('only the two Vapor jackets for "vapor jacket" - no other jackets to fill the screen', () => {
    expect(titles(searchLocal({ query: 'vapor jacket', limit: 6 })).sort()).toEqual(['VAPOR JACKET 2.0 - NAVY', 'VAPOR JACKET 2.0 - SAGE']);
  });

  it('a garment on its own is still a browse of every one', () => {
    const shown = titles(searchLocal({ query: 'polo', limit: 20 }));
    expect(shown.length).toBeGreaterThanOrEqual(8);
    expect(shown.every((t) => t.includes('POLO'))).toBe(true);
  });
});

describe('ties go to what sells and what can be bought, not the cheapest', () => {
  it('a clearance polo with one size left does not open "polo"', () => {
    const shown = titles(searchLocal({ query: 'polo', limit: 20 }));
    expect(shown[0]).not.toBe(CLEARANCE.title);
    expect(shown.indexOf(CLEARANCE.title)).toBeGreaterThan(shown.indexOf(HONEYCOMB.title));
  });

  it('among equally relevant polos, the best seller leads - even when it costs more', () => {
    setBestSellersForTests([HONEYCOMB.id, AQUA_NAVY.id]);
    const shown = titles(searchLocal({ query: 'polo', limit: 20 }));
    expect(shown[0]).toBe('HONEYCOMB POLO - WHITE');
  });

  it('a best seller never outranks the product that was named', () => {
    setBestSellersForTests([AQUA_NAVY.id, SPEED_NAVY.id]);
    expect(titles(searchLocal({ query: 'elite polo navy', limit: 6 }))[0]).toBe('ELITE POLO - NAVY');
  });

  it('a budget is a rule, and its words are not searched for', async () => {
    setBestSellersForTests([HONEYCOMB.id]);
    const { titles: shown } = await search({ query: 'polo under £20', maxPrice: 20 }, 'polo under £20');
    expect(shown.length).toBeGreaterThan(0);
    // "20" once matched the clearance polo's "20 off" campaign tag.
    expect(shown[0]).toBe('HONEYCOMB POLO - WHITE');
    expect(shown.every((t) => CATALOGUE.find((p) => p.title === t)!.price.amount <= 20)).toBe(true);
  });
});

describe('what the earlier layers decide still stands', () => {
  it('a misspelt name still leads with its design', async () => {
    const { titles: shown, result } = await search({ query: 'Galatic midlayer', productName: 'Galatic midlayer' }, 'the galatic midlayer');
    expect(shown.slice(0, 3).every((t) => t.startsWith('GALACTIC MIDLAYER'))).toBe(true);
    expect(result.facts).toMatch(/appears to refer to the Galactic Midlayer design/);
  });

  it('a name close to two designs still picks neither', () => {
    expect(lookupProductName('hexi polo')?.kind).toBe('possible-match');
  });

  it('"polos and trousers" still brings both', () => {
    const shown = titles(searchLocal({ query: 'polos and trousers', limit: 6 }));
    expect(shown.slice(0, 4).some((t) => t.includes('POLO'))).toBe(true);
    expect(shown.slice(0, 4).some((t) => /TROUSERS|JOGGERS/.test(t))).toBe(true);
  });
});
