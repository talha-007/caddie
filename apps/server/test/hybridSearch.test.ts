import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { hasFeature } from '../src/catalog/attributes.js';
import { rangeOf } from '../src/catalog/audience.js';
import { setBestSellersForTests } from '../src/catalog/bestSellers.js';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { categoriesOf, sizeStatus } from '../src/catalog/constraints.js';
import { setEmbeddingProviderForTests, type EmbeddingProvider } from '../src/catalog/embeddings.js';
import { descriptiveSearchText, lastHybridDiagnostics, wantsSemantic } from '../src/catalog/hybrid.js';
import { resetSemanticIndexForTests, syncSemanticIndex } from '../src/catalog/semantic.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';
import { rankProducts } from '../src/recommend/rank.js';

/**
 * Word search and meaning search as one candidate pool. Meaning adds
 * candidates for descriptive requests; the rules and word search still
 * decide. The fixtures reproduce what the live catalogue did: one dress in
 * four colours, a kids polo, a cap and a baselayer that say "warm", gilets
 * in three ranges, and joggers beside trousers.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function garment(title: string, type: string, description: string, sizes = ['S', 'M', 'L', 'XL', '2XL']): Product {
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND],
    price: { amount: 30, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size) => ({ id: `${title}-${size}`, title: size, available: true, price: { amount: 30, currency: 'GBP' }, options: { Size: size } })),
    description,
  };
}

const HOT = 'A lightweight, breathable piece for hot summer days, with UV protection.';
const LUXE = ['BLACK', 'NAVY', 'WHITE', 'LIME'].map((colour) => garment(`LADIES LUXE DRESS - ${colour}`, 'LADIES DRESSES', HOT, ['8', '10', '12']));
const BREEZE_POLO = garment('BREEZE POLO - WHITE', 'POLOS', 'A lightweight, breathable polo for hot summer rounds.');
const KIDS_BREEZE = garment('KIDS BREEZE POLO - WHITE', 'KIDS POLOS', 'A lightweight, breathable polo for hot summer days.', ['7-8', '9-10']);
const CLIMA_SHORTS = garment('CLIMA GOLF SHORTS - NAVY', 'SHORTS', 'Lightweight, breathable shorts for hot days.', ['32', '34', '36']);
const AXIS_CAP = garment('AXIS CAP - SAGE', 'CAPS', 'A lightweight, breathable cap.', ['ONE SIZE']);
const ELITE_NAVY = garment('ELITE POLO - NAVY', 'POLOS', 'A classic polo.');
const ELITE_WHITE = garment('ELITE POLO - WHITE', 'POLOS', 'A classic polo.');
const AQUA_NAVY = garment('AQUA POLO - NAVY', 'POLOS', 'A classic polo.');
const GALACTIC_NAVY = garment('GALACTIC MIDLAYER - NAVY', 'MIDLAYERS', 'A smooth midlayer.');
const GALACTIC_WHITE = garment('GALACTIC MIDLAYER - WHITE', 'MIDLAYERS', 'A smooth midlayer.');
const GILET = 'A warm padded body with protection from the wind.';
const CLIMA_GILETS = ['BLACK', 'NAVY', 'SAGE'].map((colour) => garment(`CLIMA GILET 3.0 - ${colour}`, 'GILETS', GILET));
const LADIES_GILET = garment('LADIES MEMBERS GILET - PINK', 'LADIES GILETS', GILET, ['8', '10', '12']);
const KIDS_GILET = garment('KIDS KINGDOM GILET - BLACK', 'KIDS GILETS', GILET, ['7-8', '9-10']);
const THERMAL_MIDLAYER = garment('THERMAL MIDLAYER - GREY', 'MIDLAYERS', 'A warm layer for cold mornings.');
const BASELAYER = garment('CREW BASELAYER - WHITE', 'BASELAYER TOPS', 'A warm under layer worn next to the skin.');
const TEX_RAIN = garment('TEX RAIN JACKET - BLACK', 'RAIN JACKET', 'Fully waterproof with taped seams, built for rain.');
const ARCHER = garment('ARCHER JACKET - WHITE', 'JACKETS', 'A smart softshell. This is not waterproof.');
// A jacket with a generic word in its name: it once led "mens sleeveless warm outer layer" on "layer".
const LINKS_LAYER = garment('LINKS LAYER JACKET - BLACK', 'JACKETS', 'A warm layer for cold rounds.');
const PREMIUM_TROUSERS = garment('PREMIUM PLAY TROUSERS - NAVY', 'TROUSERS', 'Stretch fabric that moves with your swing.', ['32', '34', '36']);
const JOGGERS = garment("MEN'S GOLF JOGGERS - BLACK", 'JOGGERS', 'Stretchy joggers for the course.', ['32', '34', '36']);

const CATALOGUE = [
  ...LUXE, BREEZE_POLO, KIDS_BREEZE, CLIMA_SHORTS, AXIS_CAP, ELITE_NAVY, ELITE_WHITE, AQUA_NAVY, GALACTIC_NAVY, GALACTIC_WHITE,
  ...CLIMA_GILETS, LADIES_GILET, KIDS_GILET, THERMAL_MIDLAYER, BASELAYER, TEX_RAIN, ARCHER, PREMIUM_TROUSERS, JOGGERS, LINKS_LAYER,
];

/** Counts of concept words: crude, deterministic, enough to order by meaning. */
const CONCEPTS = ['lightweight', 'breathable', 'hot', 'summer', 'uv', 'warm', 'cold', 'wind', 'rain', 'waterproof', 'gilet', 'sleeveless', 'body warmer', 'outer layer', 'stretch', 'trouser', 'polo', 'dress', 'cap', 'baselayer', 'midlayer'];
class FakeEmbeddings implements EmbeddingProvider {
  readonly name = 'fake/22';
  calls: string[][] = [];
  fail = false;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    if (this.fail) throw new Error('embeddings down');
    return texts.map((text) => {
      const lower = text.toLowerCase();
      return [0.01, ...CONCEPTS.map((concept) => lower.split(concept).length - 1)];
    });
  }
}

let fake: FakeEmbeddings;
beforeEach(async () => {
  resetSemanticIndexForTests();
  setCatalogueForTests(CATALOGUE);
  setDealsForTests([]);
  setBestSellersForTests([]);
  fake = new FakeEmbeddings();
  setEmbeddingProviderForTests(fake);
  await syncSemanticIndex();
});
afterEach(() => setEmbeddingProviderForTests(null));

async function search(args: Record<string, unknown>, utterance: string) {
  const session = await sessions.getOrCreate(`hybrid-${Math.random()}`);
  const before = fake.calls.length;
  const result = await runTool('search_products', args, { session, utterance });
  const products = result.attachment?.kind === 'products' ? result.attachment.products : [];
  return { result, products, titles: products.map((p) => p.title), embeddingCalls: fake.calls.length - before, diagnostics: lastHybridDiagnostics()! };
}

const perDesign = (titles: string[], design: string) => titles.filter((t) => t.startsWith(design)).length;

describe('when meaning search runs', () => {
  it('for descriptions, never for names, colours, sizes, ranges or budgets', () => {
    for (const described of ['something lightweight for hot weather golf', 'something warm but not bulky', 'rain protection for golf', 'sleeveless outer layer', 'stretchy trousers for playing golf']) {
      expect(wantsSemantic(described).use, described).toBe(true);
    }
    for (const precise of ['Elite Polo Navy', 'Galactic Midlayer', 'black polo', 'navy polo in XL', 'kids hoodie', 'polo under £30']) {
      expect(wantsSemantic(precise).use, precise).toBe(false);
    }
    expect(wantsSemantic('a lightweight elite polo', { named: true }).use).toBe(false);
  });
});

describe('precise requests are exactly as before', () => {
  it('Elite Polo Navy: the product first, no embedding call', async () => {
    const { titles, embeddingCalls, diagnostics } = await search({ query: 'Elite Polo Navy', colour: 'navy' }, 'Elite Polo Navy');
    expect(titles[0]).toBe('ELITE POLO - NAVY');
    expect(embeddingCalls).toBe(0);
    expect(diagnostics.semanticUsed).toBe(false);
  });

  it('Elite Polo Navy in XL: no embedding call', async () => {
    const { titles, embeddingCalls } = await search({ query: 'Elite Polo Navy in XL', colour: 'navy' }, 'Elite Polo Navy in XL');
    expect(titles[0]).toBe('ELITE POLO - NAVY');
    expect(embeddingCalls).toBe(0);
  });

  it('a misspelt design still wins, meaning search not consulted', async () => {
    const { titles, diagnostics } = await search({ query: 'Galatic Midlayer', productName: 'Galatic Midlayer' }, 'the galatic midlayer');
    expect(titles[0]).toMatch(/^GALACTIC MIDLAYER/);
    expect(diagnostics.semanticUsed).toBe(false);
  });

  it('navy polo in XL: every rule holds, no embedding call', async () => {
    const { products, embeddingCalls } = await search({ query: 'navy polo in XL', colour: 'navy' }, 'navy polo in XL');
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => /NAVY/.test(p.title) && categoriesOf(p).has('polo') && sizeStatus(p, 'XL') === 'in-stock')).toBe(true);
    expect(embeddingCalls).toBe(0);
  });
});

describe('descriptive requests get meaning search', () => {
  it('hot weather: meaning search runs, one dress design cannot fill the screen, no kids polo, everything lightweight', async () => {
    const { titles, products, diagnostics } = await search({ query: 'something lightweight for hot weather golf' }, 'something lightweight for hot weather golf');
    expect(diagnostics.semanticUsed).toBe(true);
    expect(diagnostics.semanticDesigns).toBeLessThan(diagnostics.semanticScanned);
    expect(perDesign(titles, 'LADIES LUXE DRESS')).toBeLessThanOrEqual(2);
    expect(titles).not.toContain('KIDS BREEZE POLO - WHITE');
    expect(titles).toContain('BREEZE POLO - WHITE');
    expect(products.every((p) => hasFeature(p, 'lightweight'))).toBe(true);
  });

  it('a sleeveless warm outer layer: a gilet leads, colourways collapsed', async () => {
    const { titles, diagnostics } = await search({ query: 'a sleeveless warm outer layer' }, 'a sleeveless warm outer layer');
    expect(diagnostics.semanticUsed).toBe(true);
    expect(titles[0]).toMatch(/GILET/);
    expect(perDesign(titles, 'CLIMA GILET 3.0')).toBeLessThanOrEqual(2);
    expect(titles.indexOf('CREW BASELAYER - WHITE') === -1 || titles.indexOf('CREW BASELAYER - WHITE') > 0).toBe(true);
  });

  it('rain protection: the waterproof rain jacket leads; a softshell is at most below it, marked as differing', async () => {
    const { titles, result, diagnostics } = await search({ query: 'rain protection for golf' }, 'rain protection for golf');
    expect(diagnostics.semanticUsed).toBe(true);
    expect(titles[0]).toBe('TEX RAIN JACKET - BLACK');
    // Rain is weather, a preference: a jacket that is not waterproof can follow, never lead, and never unmarked.
    if (titles.includes('ARCHER JACKET - WHITE')) {
      expect(titles.indexOf('ARCHER JACKET - WHITE')).toBeGreaterThan(0);
      expect(result.facts).toMatch(/ARCHER JACKET - WHITE[^\n]*: meets every rule, differs on a preference/);
    }
  });

  it('stretchy trousers: trousers only - joggers count as trousers, as they always have', async () => {
    const { titles, products } = await search({ query: 'stretchy trousers for playing golf' }, 'stretchy trousers for playing golf');
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => categoriesOf(p).has('trousers'))).toBe(true);
    expect(titles).toContain('PREMIUM PLAY TROUSERS - NAVY');
  });

  it('mens sleeveless warm outer layer: mens only, whatever meaning search found', async () => {
    const { products, diagnostics } = await search({ query: 'mens sleeveless warm outer layer' }, 'mens sleeveless warm outer layer');
    expect(diagnostics.semanticUsed).toBe(true);
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => rangeOf(p) === 'men')).toBe(true);
  });
});

describe('ranking a descriptive search by the strength of its evidence', () => {
  it('a generic word in a title does not beat the garment the request describes', async () => {
    const { titles, diagnostics } = await search({ query: 'mens sleeveless warm outer layer' }, 'mens sleeveless warm outer layer');
    expect(diagnostics.semanticUsed).toBe(true);
    const firstGilet = titles.findIndex((t) => /GILET/.test(t));
    expect(firstGilet).toBe(0);
    if (titles.includes('LINKS LAYER JACKET - BLACK')) expect(titles.indexOf('LINKS LAYER JACKET - BLACK')).toBeGreaterThan(firstGilet);
    // Why: the gilet agrees with the request's concept; "layer" is only a generic word.
    const gilet = diagnostics.top!.find((row) => /GILET/.test(row.title))!;
    const links = diagnostics.top!.find((row) => row.title === 'LINKS LAYER JACKET - BLACK');
    if (links) expect(gilet.band).toBeGreaterThan(links.band);
  });

  it('trousers typed as trousers come before joggers, which still count', async () => {
    const { titles } = await search({ query: 'stretchy trousers for playing golf' }, 'stretchy trousers for playing golf');
    expect(titles).toContain("MEN'S GOLF JOGGERS - BLACK");
    expect(titles.indexOf('PREMIUM PLAY TROUSERS - NAVY')).toBeLessThan(titles.indexOf("MEN'S GOLF JOGGERS - BLACK"));
  });

  it('with no range asked, the main range leads a tie; ladies stay, kids do not lead', async () => {
    const { titles, products } = await search({ query: 'a sleeveless warm outer layer' }, 'a sleeveless warm outer layer');
    expect(rangeOf(products[0]!)).toBe('men');
    expect(titles).toContain('LADIES MEMBERS GILET - PINK');
    expect(titles).not.toContain('KIDS KINGDOM GILET - BLACK');
  });

  it('a range asked for still filters exactly', async () => {
    const { products } = await search({ query: 'ladies sleeveless warm outer layer' }, 'ladies sleeveless warm outer layer');
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => rangeOf(p) === 'women')).toBe(true);
  });

  it('a broad request takes turns between equally strong kinds of garment', async () => {
    const { products } = await search({ query: 'lightweight for hot weather golf' }, 'lightweight for hot weather golf');
    const kinds = products.slice(0, 3).map((p) => [...categoriesOf(p)][0]);
    expect(new Set(kinds).size).toBeGreaterThanOrEqual(2);
    // Nothing for the cold, and every piece lightweight.
    expect(products.every((p) => hasFeature(p, 'lightweight'))).toBe(true);
    expect(products.map((p) => p.title)).not.toContain('THERMAL MIDLAYER - GREY');
  });

  it('a request that names a kind gets no mixing', async () => {
    const { products } = await search({ query: 'lightweight polo for hot weather' }, 'lightweight polo for hot weather');
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => categoriesOf(p).has('polo'))).toBe(true);
  });
});

describe('the customer\'s words survive a shortened query', () => {
  const embedded = () => fake.calls.at(-1)?.[0] ?? '';

  it('hot weather the model left out still reaches meaning search', async () => {
    const { diagnostics, titles } = await search({ query: 'lightweight golf clothing' }, 'I need something lightweight for playing golf somewhere hot');
    expect(diagnostics.semanticUsed).toBe(true);
    expect(diagnostics.described).toMatch(/somewhere hot/);
    expect(embedded()).toMatch(/Suited features: lightweight, breathable, moisture-wicking, UV protection/);
    expect(titles).not.toContain('THERMAL MIDLAYER - GREY');
  });

  it('summer the model left out survives', async () => {
    const { diagnostics } = await search({ query: 'lightweight golf clothing' }, 'Show me something lightweight for summer golf');
    expect(diagnostics.described).toMatch(/summer/);
    expect(embedded()).toMatch(/summer/);
    expect(embedded()).toMatch(/Suited features: .*breathable/);
  });

  it('warm weather survives, and the ladies range still filters', async () => {
    const { diagnostics, products } = await search({ query: 'lightweight ladies top', range: 'ladies' }, 'I need a lightweight ladies top for warm weather');
    expect(diagnostics.semanticUsed).toBe(true);
    expect(embedded()).toMatch(/warm weather/);
    expect(embedded()).toMatch(/Suited features: .*breathable/);
    expect(products.every((p) => rangeOf(p) === 'women')).toBe(true);
  });

  // Task 21: a feature only the model supplied is a proposal, not a rule - it neither filters nor turns meaning search on.
  it('a feature the customer asked for turns meaning search on; one only the model added does not', async () => {
    const asked = await search({ query: 'golf trousers', features: ['stretch'] }, 'trousers with some stretch for golf please');
    expect(asked.diagnostics.semanticUsed).toBe(true);
    expect(asked.diagnostics.why).toMatch(/stretch/);
    expect(asked.diagnostics.described).toMatch(/stretch/);
    const invented = await search({ query: 'golf trousers', features: ['stretch'] }, 'trousers for golf please');
    expect(invented.diagnostics.why).not.toMatch(/stretch/);
  });

  it('stretchy trousers: meaning search runs when the model shortens it to "golf trousers"', async () => {
    const { diagnostics, products } = await search({ query: 'golf trousers', features: ['stretch'] }, 'I want stretchy trousers for golf');
    expect(diagnostics.semanticUsed).toBe(true);
    expect(products.every((p) => categoriesOf(p).has('trousers'))).toBe(true);
  });

  it('sleeveless and cold survive "warm outer layer"', async () => {
    const { diagnostics, titles } = await search({ query: 'warm outer layer' }, 'I want something warm but sleeveless for a cold morning');
    expect(diagnostics.semanticUsed).toBe(true);
    expect(embedded()).toMatch(/Catalogue concepts: gilet, body warmer/);
    expect(embedded()).toMatch(/Suited features: .*warm/);
    expect(titles[0]).toMatch(/GILET/);
  });

  it('when the query and the customer name different weather, the customer wins', () => {
    const text = descriptiveSearchText({ query: 'lightweight polo for cold', utterance: 'a polo for hot weather' });
    expect(text).not.toMatch(/\bcold\b/);
    expect(text).toMatch(/hot weather/);
  });

  it('the customer\'s words are not repeated when the query already says them', () => {
    expect(descriptiveSearchText({ query: 'rain protection for golf', utterance: 'rain protection for golf' })).toBe('rain protection for golf');
  });

  it('precise requests stay precise, whatever the sentence around them', async () => {
    for (const [args, said] of [
      [{ productName: 'Elite Polo', colour: 'navy' }, 'Do you have the Elite Polo in navy?'],
      [{ query: 'polo', colour: 'navy', size: 'XL' }, 'Show me a navy polo in XL please'],
      [{ query: 'kids hoodie' }, 'Have you got a hoodie for my son?'],
      [{ query: 'polo', maxPrice: 30 }, "I'd like a polo under £30"],
    ] as const) {
      const { diagnostics, embeddingCalls } = await search(args as Record<string, unknown>, said);
      expect(diagnostics.semanticUsed, said).toBe(false);
      expect(embeddingCalls, said).toBe(0);
    }
  });
});

describe('weather in the ranking', () => {
  it('weather named now marks a product that states nothing for it; remembered weather only ranks', () => {
    const [asked] = rankProducts([ARCHER], { weather: ['wet'], weatherAsked: true });
    expect(asked!.matchLevel).toBe('strong');
    expect(asked!.missedPreferences.join()).toMatch(/nothing for wet weather/);
    const [remembered] = rankProducts([ARCHER], { weather: ['wet'] });
    expect(remembered!.matchLevel).toBe('exact');
  });
});

describe('if meaning search cannot run, word search answers', () => {
  const describe_ = { query: 'something lightweight for hot weather golf' };
  const said = 'something lightweight for hot weather golf';

  it('no provider, or a failing one: the same results as word search alone, and nothing said about it', async () => {
    setEmbeddingProviderForTests(null);
    const none = await search(describe_, said);
    expect(none.diagnostics).toMatchObject({ semanticUsed: false, fallback: expect.any(String) });

    setEmbeddingProviderForTests(fake);
    fake.fail = true;
    const failing = await search(describe_, said);
    expect(failing.diagnostics).toMatchObject({ semanticUsed: false, fallback: expect.stringMatching(/query embedding failed/) });
    expect(failing.titles).toEqual(none.titles);
    expect(failing.result.speech).toEqual(none.result.speech);
    expect(failing.result.facts ?? '').not.toMatch(/semantic|embedding/i);
  });
});

describe('the query cache', () => {
  it('the same descriptive request twice embeds the query once', async () => {
    const first = await search({ query: 'rain protection for golf' }, 'rain protection for golf');
    const second = await search({ query: 'rain protection for golf' }, 'rain protection for golf');
    expect(first.embeddingCalls).toBe(1);
    expect(second.embeddingCalls).toBe(0);
    expect(second.diagnostics.cache).toBe('hit');
    expect(second.titles).toEqual(first.titles);
  });
});
