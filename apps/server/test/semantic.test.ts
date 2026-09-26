import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setEmbeddingProviderForTests, type EmbeddingProvider } from '../src/catalog/embeddings.js';
import { searchLocal } from '../src/catalog/search.js';
import {
  resetSemanticIndexForTests,
  semanticEntry,
  semanticSearch,
  semanticState,
  syncSemanticIndex,
} from '../src/catalog/semantic.js';
import { buildProductSemanticText, semanticFingerprint, semanticQueryText, usefulDescription } from '../src/catalog/semanticText.js';
import { applyChanges, removeProduct, setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * Semantic search, on its own: the text each product is embedded from, the
 * index that follows the catalogue, and search by meaning - with a fake,
 * deterministic embedding provider, so no test ever calls the paid API.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function garment(title: string, type: string, description: string, extra: Partial<Product> = {}): Product {
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND, '40 off', 'sendlane-all', 'size-xl', 'blue'],
    price: { amount: 20, currency: 'GBP' },
    options: [{ name: 'Size', values: ['M', 'L'] }],
    variants: ['M', 'L'].map((size) => ({ id: `${title}-${size}`, title: size, available: true, price: { amount: 20, currency: 'GBP' }, options: { Size: size } })),
    description,
    ...extra,
  };
}

const SUMMER_POLO = garment(
  'BREEZE POLO - WHITE',
  'POLOS',
  'A lightweight, breathable polo for hot summer rounds. Moisture-wicking fabric keeps you cool. Machine wash at 30 degrees.',
);
const RAIN_JACKET = garment('STORM JACKET - BLACK', 'RAIN JACKET', 'Fully waterproof with taped seams, built for rain and cold wind.');
const WARM_GILET = garment('TECH GILET - NAVY', 'GILETS', 'A warm sleeveless layer for cold mornings, with a padded body.');
const TROUSERS = garment("MEN'S CLIMA GOLF TROUSERS - GREY", 'TROUSERS', 'Stretchy trousers that move with your swing.', {
  options: [{ name: 'WAIST SIZE', values: ['32', '34'] }],
});

/**
 * A vector per concept word: how often each appears. Crude, deterministic,
 * and enough to say which product is closer to a query.
 */
const CONCEPTS = ['lightweight', 'hot', 'summer', 'cool', 'warm', 'cold', 'rain', 'waterproof', 'polo', 'jacket', 'gilet', 'sleeveless', 'stretch', 'trouser', 'weather'];
class FakeEmbeddings implements EmbeddingProvider {
  readonly name = 'fake/15';
  calls: string[][] = [];
  failWhen: ((text: string) => boolean) | null = null;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    if (this.failWhen && texts.some(this.failWhen)) throw new Error('rate limited');
    return texts.map((text) => {
      const lower = text.toLowerCase();
      return [0.01, ...CONCEPTS.map((concept) => lower.split(concept).length - 1)];
    });
  }
  get textsEmbedded(): number {
    return this.calls.reduce((sum, call) => sum + call.length, 0);
  }
}

let fake: FakeEmbeddings;
beforeEach(() => {
  resetSemanticIndexForTests();
  fake = new FakeEmbeddings();
  setEmbeddingProviderForTests(fake);
  setCatalogueForTests([SUMMER_POLO, RAIN_JACKET, WARM_GILET, TROUSERS]);
});
afterEach(() => setEmbeddingProviderForTests(null));

describe('the text a product is embedded from', () => {
  it('says what the product is: design, category and what it is called, range, features, description', () => {
    const text = buildProductSemanticText(SUMMER_POLO);
    expect(text.split('\n').slice(0, 5)).toEqual([
      'Product: Breeze Polo',
      'Category: polo',
      'Also called: polo shirt, golf shirt, short-sleeved golf top',
      'Range: mens',
      'Features: breathable, moisture-wicking, lightweight',
    ]);
    expect(text).toContain('A lightweight, breathable polo for hot summer rounds.');
  });

  it('carries no colour line, and names the product by its design, not its colourway', () => {
    const text = buildProductSemanticText(SUMMER_POLO);
    expect(text).not.toMatch(/^Colour:/m);
    expect(text).not.toContain('BREEZE POLO - WHITE');
    // Two colourways of one design embed the same text: colour is a rule, applied elsewhere.
    expect(semanticFingerprint({ ...SUMMER_POLO, id: 'other', title: 'BREEZE POLO - NAVY' })).toBe(semanticFingerprint(SUMMER_POLO));
  });

  it('a gilet is called a body warmer and a sleeveless jacket - without being called warm', () => {
    const text = buildProductSemanticText(garment('CLIMA GILET 3.0 - BLACK', 'GILETS', 'A smart layer for the course.'));
    expect(text).toMatch(/Also called: .*body warmer.*sleeveless jacket/);
    expect(text).not.toMatch(/Features:/);
  });

  it('a rain jacket is called what it is for', () => {
    expect(buildProductSemanticText(RAIN_JACKET)).toMatch(/Also called: .*rain jacket, wet-weather jacket, rain protection/);
  });

  it('keeps the opening of a long description, cut at a sentence', () => {
    const long = `${'A sentence about the polo. '.repeat(40)}`;
    const kept = usefulDescription(long);
    expect(kept.length).toBeLessThanOrEqual(400);
    expect(kept.endsWith('.')).toBe(true);
  });

  it('leaves out campaign tags and care instructions', () => {
    const text = buildProductSemanticText(SUMMER_POLO);
    for (const noise of ['40 off', 'sendlane', 'size-xl']) expect(text).not.toContain(noise);
    expect(text).not.toMatch(/machine wash/i);
    expect(usefulDescription('Warm and soft. Tumble dry low. Free delivery over £50.')).toBe('Warm and soft.');
  });

  it('a price, a stock level or a tag does not change the fingerprint; the description does', () => {
    const cheaper = { ...SUMMER_POLO, price: { amount: 10, currency: 'GBP' }, tags: ['sale'] };
    expect(semanticFingerprint(cheaper)).toBe(semanticFingerprint(SUMMER_POLO));
    const rewritten = { ...SUMMER_POLO, description: 'A heavy winter polo.' };
    expect(semanticFingerprint(rewritten)).not.toBe(semanticFingerprint(SUMMER_POLO));
  });
});

describe('the index', () => {
  it('gives every product a vector, in batches rather than one call each', async () => {
    const state = await syncSemanticIndex();
    expect(state).toMatchObject({ status: 'ready', indexed: 4, catalogue: 4, model: 'fake/15' });
    for (const product of [SUMMER_POLO, RAIN_JACKET, WARM_GILET, TROUSERS]) expect(semanticEntry(product.id)?.vector.length).toBe(16);
    expect(fake.calls.length).toBe(1);
  });

  it('re-embeds only a product whose text changed', async () => {
    await syncSemanticIndex();
    const before = fake.textsEmbedded;
    // A price and tag change: same text, no new vector.
    applyChanges([{ ...RAIN_JACKET, price: { amount: 99, currency: 'GBP' }, tags: ['clearance'] }]);
    await syncSemanticIndex();
    expect(fake.textsEmbedded).toBe(before);
    // A new description: that product, and only it.
    const oldVector = semanticEntry(RAIN_JACKET.id)!.vector;
    applyChanges([{ ...RAIN_JACKET, description: 'A lightweight summer shell.' }]);
    await syncSemanticIndex();
    expect(fake.textsEmbedded).toBe(before + 1);
    expect(semanticEntry(RAIN_JACKET.id)!.vector).not.toEqual(oldVector);
  });

  it('drops a deleted product', async () => {
    await syncSemanticIndex();
    removeProduct(WARM_GILET.id);
    await syncSemanticIndex();
    expect(semanticEntry(WARM_GILET.id)).toBeUndefined();
    expect(semanticState().indexed).toBe(3);
  });
});

describe('searching by meaning', () => {
  it('ranks the product closest in meaning first', async () => {
    await syncSemanticIndex();
    const outcome = await semanticSearch('lightweight warm-weather polo for hot summer golf', 4);
    expect(outcome.available).toBe(true);
    if (outcome.available) {
      expect(outcome.results[0]!.product.title).toBe('BREEZE POLO - WHITE');
      const titles = outcome.results.map((r) => r.product.title);
      expect(titles.indexOf('BREEZE POLO - WHITE')).toBeLessThan(titles.indexOf('STORM JACKET - BLACK'));
      expect(outcome.results[0]!.similarity).toBeGreaterThan(outcome.results[1]!.similarity);
    }
  });

  it('finds what no product is called: a sleeveless warm layer is the gilet', async () => {
    await syncSemanticIndex();
    const outcome = await semanticSearch('a sleeveless warm layer for a cold morning', 2);
    expect(outcome.available && outcome.results[0]!.product.title).toBe('TECH GILET - NAVY');
  });
});

describe('the query, in the catalogue\'s words', () => {
  it('"sleeveless outer layer" brings in the gilet', () => {
    expect(semanticQueryText('a sleeveless warm outer layer')).toMatch(/Catalogue concepts: gilet, body warmer, sleeveless jacket/);
  });

  it('"body warmer" is a gilet, through the shop-floor taxonomy', () => {
    expect(semanticQueryText('body warmer')).toMatch(/Catalogue concepts: gilet, body warmer/);
  });

  it('rain brings in rain jackets, and the features that keep it out', () => {
    const text = semanticQueryText('rain protection for golf');
    expect(text).toMatch(/rain jacket, wet-weather jacket, rain protection/);
    expect(text).toMatch(/Suited features: waterproof, water-resistant/);
  });

  it('hot weather asks for the features that suit heat - the ones product texts state', () => {
    const query = semanticQueryText('something lightweight for hot weather golf');
    expect(query).toMatch(/Suited features: lightweight, breathable, moisture-wicking, UV protection/);
    // And the product side keeps those verified features.
    expect(buildProductSemanticText(SUMMER_POLO)).toMatch(/Features: breathable, moisture-wicking, lightweight/);
  });

  it('keeps the customer\'s own words first', () => {
    expect(semanticQueryText('a jumper for a cold morning')).toMatch(/^a jumper for a cold morning\. /);
  });
});

describe('customer search', () => {
  it('a precise request answers the same with the semantic index built as without it', async () => {
    // Descriptive requests use the index since the hybrid search (see hybridSearch.test.ts); a named kind of garment does not.
    const ask = async () => {
      const session = await sessions.getOrCreate(`semantic-${Math.random()}`);
      const result = await runTool('search_products', { query: 'jacket' }, { session, utterance: 'show me jackets' });
      return { speech: result.speech, facts: result.facts, shown: result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.id) : [] };
    };
    const without = await ask();
    await syncSemanticIndex();
    const before = fake.calls.length;
    expect(await ask()).toEqual(without);
    // And it never asked for an embedding.
    expect(fake.calls.length).toBe(before);
  });
});

describe('the query cache', () => {
  it('embeds the same request once, however it is spaced or capitalised', async () => {
    await syncSemanticIndex();
    const before = fake.calls.length;
    await semanticSearch('Rain protection for golf');
    await semanticSearch('rain   protection for GOLF ');
    expect(fake.calls.length).toBe(before + 1);
  });

  it('embeds a different request again', async () => {
    await syncSemanticIndex();
    const before = fake.calls.length;
    await semanticSearch('rain protection for golf');
    await semanticSearch('a sleeveless warm outer layer');
    expect(fake.calls.length).toBe(before + 2);
  });
});

describe('when it cannot work', () => {
  it('without a provider it says so, and word search is untouched', async () => {
    setEmbeddingProviderForTests(null);
    const outcome = await semanticSearch('rain jacket');
    expect(outcome).toMatchObject({ available: false });
    expect(searchLocal({ query: 'jacket', limit: 5 }).map((p) => p.title)).toEqual(['STORM JACKET - BLACK']);
  });

  it('a failing provider leaves the index failed, search unavailable, and word search working', async () => {
    fake.failWhen = () => true;
    const state = await syncSemanticIndex();
    expect(state.status).toBe('failed');
    expect(state.lastError).toMatch(/rate limited/);
    expect((await semanticSearch('polo')).available).toBe(false);
    expect(searchLocal({ query: 'polo', limit: 5 }).length).toBe(1);
  });

  it('a query that cannot be embedded is reported, not thrown', async () => {
    await syncSemanticIndex();
    fake.failWhen = (text) => text.startsWith('polo please');
    const outcome = await semanticSearch('polo please');
    expect(outcome).toMatchObject({ available: false });
    if (!outcome.available) expect(outcome.reason).toMatch(/query embedding failed/);
  });

  it('a partly built index searches what it has', async () => {
    await syncSemanticIndex();
    const NEW = garment('ARCHER JACKET - WHITE', 'JACKETS', 'A smart softshell.');
    fake.failWhen = (text) => /archer/i.test(text);
    applyChanges([NEW]);
    const state = await syncSemanticIndex();
    expect(state).toMatchObject({ status: 'partial', indexed: 4, catalogue: 5 });
    fake.failWhen = null;
    const outcome = await semanticSearch('waterproof rain jacket', 2);
    expect(outcome.available && outcome.partial).toBe(true);
    expect(outcome.available && outcome.results[0]!.product.title).toBe('STORM JACKET - BLACK');
  });
});
