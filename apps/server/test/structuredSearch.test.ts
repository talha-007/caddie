import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { categoriesAsked, categoriesOf, sizeInRequest, sizeStatus } from '../src/catalog/constraints.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';
import { lastHybridDiagnostics } from '../src/catalog/hybrid.js';

/**
 * The rules in a request - kind of garment, range, size, colour, budget,
 * what it must do - enforced, not scored. Product types, size scales and
 * titles are the live Druids store's.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
const TOPS = ['S', 'M', 'L', 'XL', '2XL'];

function garment(
  title: string,
  type: string,
  opts: { sizes?: string[]; out?: string[]; price?: number; priceBySize?: Record<string, number>; description?: string; tags?: string[] } = {},
): Product {
  const sizes = opts.sizes ?? TOPS;
  const price = (size: string) => opts.priceBySize?.[size] ?? opts.price ?? 30;
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND, ...(opts.tags ?? [])],
    price: { amount: Math.min(...sizes.map(price)), currency: 'GBP' },
    options: [{ name: type.includes('JACKET') ? 'JACKET SIZE' : 'SIZE', values: sizes }],
    variants: sizes.map((size) => ({
      id: `${title}-${size}`,
      title: size,
      available: !(opts.out ?? []).includes(size),
      price: { amount: price(size), currency: 'GBP' },
      options: { [type.includes('JACKET') ? 'JACKET SIZE' : 'SIZE']: size },
    })),
    description: opts.description ?? null,
  };
}

const AQUA_NAVY = garment('AQUA POLO - NAVY', 'POLOS', { price: 12 });
const SPEED_NAVY_NO_XL = garment('SPEED POLO - NAVY', 'POLOS', { price: 12, out: ['XL'] });
const ELITE_NAVY = garment('ELITE POLO - NAVY', 'POLOS', { price: 20 });
const ELITE_WHITE_NO_XL = garment('ELITE POLO - WHITE', 'POLOS', { price: 20, out: ['XL'] });
const TOUR_BLACK = garment('TOUR POLO - BLACK', 'POLOS', { priceBySize: { S: 38, M: 38, L: 38, XL: 38, '2XL': 44 } });
const LADIES_NAVY = garment('LADIES ELITE POLO - NAVY', 'LADIES POLOS', { sizes: ['8', '10', '12', '14'], price: 12 });
const KIDS_NAVY = garment('KIDS ELITE POLO - NAVY', 'KIDS POLOS', { sizes: ['7-8', '9-10'], price: 10 });
// A polo that mentions "body" and "warmer" - it once came back for "body warmer".
const NAPA_NAVY = garment('NAPA POLO - NAVY', 'POLOS', { price: 22, description: 'Soft on the body, a warmer weight for spring.', tags: ['warmer'] });
const CLIMA_GILET = garment('CLIMA GILET 3.0 - BLACK', 'GILETS', { price: 16 });
const TECH_GILET = garment('TECH GILET - SAGE', 'GILETS', { price: 20 });
const TEE_TIME_HOODIE = garment('TEE-TIME HOODIE - BLACK', 'GOLF HOODIES', { price: 28 });
const KIDS_HOODIE = garment('KIDS HESSIE HOODIE - NAVY', 'KIDS MIDLAYERS', { sizes: ['7-8', '9-10'], price: 18 });
const GALACTIC_NAVY = garment('GALACTIC MIDLAYER - NAVY', 'MIDLAYERS', { price: 32 });
const ULTRA_GREY_NO_2XL = garment('ULTRA BLEND MIDLAYER - GREY', 'MIDLAYERS', { price: 14, out: ['2XL'] });
const TEX_BLACK = garment('TEX RAIN JACKET - BLACK', 'RAIN JACKET', { price: 68, description: 'Fully waterproof with taped seams.' });
const STORM_BLACK_NO_XL = garment('STORM JACKET - BLACK', 'RAIN JACKET', { price: 70, out: ['XL'], description: 'Fully waterproof, windproof and breathable.' });
const ESCAPADE_BLACK = garment('ESCAPADE JACKET - BLACK', 'RAIN JACKET', { price: 95, description: 'Fully waterproof.' });
const ARCHER_BLACK = garment('ARCHER JACKET - BLACK', 'JACKETS', { price: 55, description: 'A smart softshell. This is not waterproof.' });
const TEX_NAVY = garment('TEX RAIN JACKET - NAVY', 'RAIN JACKET', { price: 68, description: 'Fully waterproof with taped seams.' });

const CATALOGUE = [
  AQUA_NAVY, SPEED_NAVY_NO_XL, ELITE_NAVY, ELITE_WHITE_NO_XL, TOUR_BLACK, LADIES_NAVY, KIDS_NAVY, NAPA_NAVY,
  CLIMA_GILET, TECH_GILET, TEE_TIME_HOODIE, KIDS_HOODIE, GALACTIC_NAVY, ULTRA_GREY_NO_2XL,
  TEX_BLACK, STORM_BLACK_NO_XL, ESCAPADE_BLACK, ARCHER_BLACK, TEX_NAVY,
];

let id = '';
beforeEach(async () => {
  setCatalogueForTests(CATALOGUE);
  setDealsForTests([]);
  id = `structured-${Math.random()}`;
  await sessions.getOrCreate(id);
});

async function search(args: Record<string, unknown>, utterance: string) {
  const session = await sessions.getOrCreate(id);
  const result = await runTool('search_products', args, { session, utterance });
  const products = result.attachment?.kind === 'products' ? result.attachment.products : [];
  return { result, products, titles: products.map((p) => p.title) };
}

const inStockIn = (product: Product, size: string) => sizeStatus(product, size) === 'in-stock';

describe('reading the rules from a request', () => {
  it('reads a size however it is put', () => {
    expect(sizeInRequest('navy polo in XL')).toBe('XL');
    expect(sizeInRequest('a polo, size XL please')).toBe('XL');
    expect(sizeInRequest('XL polo')).toBe('XL');
    expect(sizeInRequest('midlayer in 2XL')).toBe('2XL');
    expect(sizeInRequest('a large polo')).toBe('L');
    expect(sizeInRequest('trousers with a 34 waist')).toBe('34');
    expect(sizeInRequest('ladies polo size 12')).toBe('12');
    // Everyday words are not sizes.
    expect(sizeInRequest('a large range of polos')).toBeUndefined();
    expect(sizeInRequest('something small for my bag')).toBeUndefined();
  });

  it('reads the kind of garment through the shop-floor words', () => {
    expect(categoriesAsked('body warmer')).toEqual(['gilet']);
    expect(categoriesAsked('waterproof jacket')).toEqual(['jacket']);
    expect(categoriesAsked('rain top')).toEqual(['jacket']);
    expect(categoriesAsked('jumper').sort()).toEqual(['hoodie', 'midlayer']);
    expect(categoriesAsked('something for the rain')).toEqual([]);
  });

  it('takes the kind of garment from the product type, and a narrower kind from the title', () => {
    expect([...categoriesOf(TEX_BLACK)]).toEqual(['jacket']);
    expect([...categoriesOf(KIDS_HOODIE)].sort()).toEqual(['hoodie', 'midlayer']);
    expect([...categoriesOf(NAPA_NAVY)]).toEqual(['polo']);
  });

  it('is strict about size: another scale is not that size', () => {
    expect(sizeStatus(SPEED_NAVY_NO_XL, 'XL')).toBe('sold-out');
    expect(sizeStatus(AQUA_NAVY, 'XL')).toBe('in-stock');
    expect(sizeStatus(LADIES_NAVY, 'XL')).toBe('other-scale');
  });
});

describe('search_products enforces them', () => {
  it('navy polo in XL: every result can be bought in XL', async () => {
    const { titles, products, result } = await search({ query: 'navy polo in XL', colour: 'navy' }, 'navy polo available in XL');
    expect(titles.length).toBeGreaterThan(0);
    expect(products.every((p) => inStockIn(p, 'XL'))).toBe(true);
    expect(titles).not.toContain('SPEED POLO - NAVY');
    expect(titles.every((t) => /NAVY/.test(t))).toBe(true);
    expect(result.facts).toMatch(/XL in stock at £/);
  });

  it('"size XL" and "XL polo" work the same', async () => {
    for (const [query, said] of [['polo size XL', 'polo size XL'], ['XL polo', 'an XL polo']] as const) {
      const { products } = await search({ query }, said);
      expect(products.length).toBeGreaterThan(0);
      expect(products.every((p) => inStockIn(p, 'XL'))).toBe(true);
    }
  });

  it('a size passed by the model is enforced when the customer said it', async () => {
    const { products } = await search({ query: 'navy polo', colour: 'navy', size: 'XL' }, "navy polo please, I'm an XL");
    expect(products.every((p) => inStockIn(p, 'XL'))).toBe(true);
  });

  it('body warmer: gilets, never a polo that mentions the words', async () => {
    const { titles } = await search({ query: 'body warmer' }, 'have you got a body warmer?');
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => /GILET/.test(t))).toBe(true);
    expect(titles).not.toContain('NAPA POLO - NAVY');
  });

  it('ladies polo: ladies only', async () => {
    const { titles } = await search({ query: 'ladies polo' }, 'show me ladies polos');
    expect(titles).toEqual(['LADIES ELITE POLO - NAVY']);
  });

  it('kids hoodie: kids hoodies only', async () => {
    const { titles } = await search({ query: 'kids hoodie' }, 'a hoodie for my son');
    expect(titles).toEqual(['KIDS HESSIE HOODIE - NAVY']);
  });

  it('a range passed by the model decides', async () => {
    const { titles } = await search({ query: 'polo', range: 'ladies' }, 'polo');
    expect(titles).toEqual(['LADIES ELITE POLO - NAVY']);
  });

  it('midlayer in 2XL: midlayers, in stock in 2XL', async () => {
    const { titles, products } = await search({ query: 'midlayer in 2XL' }, 'midlayer in 2XL');
    expect(titles).toContain('GALACTIC MIDLAYER - NAVY');
    expect(titles).not.toContain('ULTRA BLEND MIDLAYER - GREY');
    expect(products.every((p) => inStockIn(p, '2XL') && categoriesOf(p).has('midlayer'))).toBe(true);
  });

  it('a budget is checked at the price of their size', async () => {
    // The Tour Polo is £38 up to XL and £44 in 2XL.
    const inXL = await search({ query: 'black polo', colour: 'black', maxPrice: 40 }, 'black polo in XL under £40');
    expect(inXL.titles).toContain('TOUR POLO - BLACK');
    const in2XL = await search({ query: 'black polo', colour: 'black', maxPrice: 40 }, 'black polo in 2XL under £40');
    expect(in2XL.titles).not.toContain('TOUR POLO - BLACK');
  });

  it('waterproof jacket in XL: jackets, waterproof by their description, in XL', async () => {
    const { titles } = await search({ query: 'waterproof jacket', features: ['waterproof'] }, 'waterproof jacket in XL');
    expect(titles.sort()).toEqual(['ESCAPADE JACKET - BLACK', 'TEX RAIN JACKET - BLACK', 'TEX RAIN JACKET - NAVY']);
  });

  it('black waterproof jacket under £80 in XL: every rule at once, and no padding', async () => {
    const { titles, result } = await search(
      { query: 'black waterproof jacket', colour: 'black', features: ['waterproof'], maxPrice: 80 },
      'black waterproof jacket under £80 in XL',
    );
    // Storm is sold out in XL, Escapade is £95, Archer is not waterproof, Tex navy is navy.
    expect(titles).toEqual(['TEX RAIN JACKET - BLACK']);
    expect(result.facts).toMatch(/TEX RAIN JACKET - BLACK.*checked: jacket, black, XL in stock at £68.00, within £80.00, waterproof/);
    expect(result.facts).not.toMatch(/partial/);
  });

  it('nothing in their size is said as that, with what exists in other sizes', async () => {
    const { result, titles } = await search({ query: 'white elite polo', colour: 'white' }, 'white elite polo in XL');
    expect(titles).toEqual([]);
    expect(result.speech).toMatch(/None of those are in stock in XL/);
    expect(result.facts).toMatch(/ELITE POLO - WHITE .*in stock in S, M, L, 2XL/);
  });
});

describe('a size is a rule only when the customer gave it', () => {
  const provenance = () => lastHybridDiagnostics()!.size!;

  it('a size the model invented is set aside: no size rule, no size facts', async () => {
    // The model added M to a request that named no size; the search still runs, across every size.
    const { result, products } = await search({ query: 'gilet', size: 'M' }, 'I want a gilet for a cold morning');
    expect(provenance()).toEqual({ requestedSize: 'M', trustedSize: null, sizeSource: 'none', ignoredModelSize: true });
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => categoriesOf(p).has('gilet'))).toBe(true);
    expect(result.facts ?? '').not.toMatch(/\bM in stock|in M\b|your size M/);
  });

  it('a size in the customer\'s words is the rule', async () => {
    const { titles, products } = await search({ query: 'navy polo', colour: 'navy', size: 'XL' }, 'Show me a navy polo in XL');
    expect(provenance()).toMatchObject({ trustedSize: 'XL', sizeSource: 'utterance', ignoredModelSize: false });
    expect(products.every((p) => inStockIn(p, 'XL'))).toBe(true);
    expect(titles).not.toContain('SPEED POLO - NAVY');
  });

  it('read from their words when the model leaves the size out', async () => {
    const { products } = await search({ query: 'navy polo', colour: 'navy' }, 'Show me a navy polo in XL');
    expect(provenance()).toMatchObject({ trustedSize: 'XL', sizeSource: 'utterance' });
    expect(products.every((p) => inStockIn(p, 'XL'))).toBe(true);
  });

  it('their words win over a different size the model passed', async () => {
    await search({ query: 'navy polo', colour: 'navy', size: 'M' }, 'Show me a navy polo in XL');
    expect(provenance()).toMatchObject({ requestedSize: 'M', trustedSize: 'XL', sizeSource: 'utterance', ignoredModelSize: true });
  });

  it('a usual size they told us is still trusted later', async () => {
    await sessions.patch(id, { shopper: { usualSize: 'XL' } });
    const { products } = await search({ query: 'polo', size: 'XL' }, 'Show me another polo');
    expect(provenance()).toMatchObject({ trustedSize: 'XL', sizeSource: 'conversation or profile' });
    expect(products.every((p) => inStockIn(p, 'XL'))).toBe(true);
  });

  it('the model cannot swap their usual size for another, nor rewrite it', async () => {
    await sessions.patch(id, { shopper: { usualSize: 'XL' } });
    const { result } = await search({ query: 'polo', size: 'M' }, 'Show me another polo');
    expect(provenance()).toMatchObject({ requestedSize: 'M', trustedSize: null, ignoredModelSize: true });
    expect(result.facts ?? '').not.toMatch(/\bM in stock|in M\b/);
    // Their usual size still ranks, as it always has, and is not replaced.
    expect(result.facts).toMatch(/XL is in stock/);
    expect((await sessions.getOrCreate(id)).shopper?.usualSize).toBe('XL');
  });

  it('no size known: the model\'s L is set aside', async () => {
    const { result } = await search({ query: 'polo', size: 'L' }, 'show me a polo');
    expect(provenance()).toMatchObject({ trustedSize: null, ignoredModelSize: true });
    expect(result.facts ?? '').not.toMatch(/\bL in stock/);
  });

  it('a size they said, with a budget, still prices at that size', async () => {
    // The Tour Polo is £38 up to XL and £44 in 2XL.
    const { titles } = await search({ query: 'black polo', colour: 'black', maxPrice: 40, size: '2XL' }, 'a black polo in 2XL under £40');
    expect(provenance()).toMatchObject({ trustedSize: '2XL', sizeSource: 'utterance' });
    expect(titles).not.toContain('TOUR POLO - BLACK');
  });
});

describe('named products keep their identity, and meet the rules', () => {
  it('Elite Polo Navy in XL: the product, checked in XL', async () => {
    const { titles, result } = await search({ query: 'Elite Polo Navy', productName: 'Elite Polo Navy' }, 'Elite Polo Navy in XL');
    expect(titles[0]).toBe('ELITE POLO - NAVY');
    expect(result.facts).toMatch(/exact product found: ELITE POLO - NAVY/);
    expect(result.facts).toMatch(/ELITE POLO - NAVY .*XL in stock/);
  });

  it('a misspelt name still resolves, and a sold-out size is never shown as it', async () => {
    const { titles, result } = await search({ query: 'Elite Pollo White', productName: 'Elite Pollo White' }, 'Elite Pollo White in XL');
    expect(titles).not.toContain('ELITE POLO - WHITE');
    expect(result.facts).toMatch(/ELITE POLO - WHITE/);
    expect(result.facts).toMatch(/sold out in XL/);
  });
});
