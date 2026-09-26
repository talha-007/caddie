import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { topKindsFor } from '../src/catalog/concepts.js';
import { categoriesOf } from '../src/catalog/constraints.js';
import { rangeOf } from '../src/catalog/audience.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { rankProducts } from '../src/recommend/rank.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * "A lightweight ladies top for warm weather" was answered with a visor, a
 * cap and four midlayers: "top" named no kind, so it matched "layering top",
 * and a midlayer whose description says both warm and breathable counted as
 * right for the heat on breathable alone. Descriptions below are written the
 * way the live store's are.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function garment(title: string, type: string, description: string, sizes = ['S', 'M', 'L', 'XL']): Product {
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

const HEAT = 'Lightweight, breathable and moisture-wicking, with UPF 50 sun protection.';
const WARM_LAYER = 'A lightweight, breathable layering top with brushed warmth for cooler rounds.';
const LADIES = ['8', '10', '12', '14'];

const LADIES_MIDLAYER = garment('LADIES BREEZY MIDLAYER - NAVY', 'LADIES MIDLAYERS', WARM_LAYER, LADIES);
const LADIES_MIDLAYER_2 = garment('LADIES ULTRA BLEND MIDLAYER - BLACK', 'LADIES MIDLAYERS', WARM_LAYER, LADIES);
const LADIES_POLO = garment('LADIES FLORAL POLO - BLUE', 'LADIES POLOS', HEAT, LADIES);
const LADIES_SLEEVELESS = garment('LADIES FLORAL SLEEVELESS POLO - TEAL', 'LADIES POLOS', HEAT, LADIES);
const LADIES_DRESS = garment('LADIES BELLA DRESS - NAVY', 'LADIES DRESSES', HEAT, LADIES);
const LADIES_CAP = garment('LADIES MESH CAP - PINK', 'LADIES CAPS', 'Lightweight and breathable mesh top panel.', ['ONE SIZE']);
const MENS_POLO = garment('SOLITAIRE POLO - NAVY', 'POLOS', HEAT);
const MENS_MIDLAYER = garment('GLOBAL MIDLAYER - SAGE', 'MIDLAYERS', WARM_LAYER);
const MENS_JACKET = garment('WARRIOR JACKET - SAGE', 'JACKETS', 'Windproof, with warmth where you need it.');
const MENS_HOODIE = garment('CLUB HOODIE - BLACK', 'HOODIES', 'Fleece lined to keep you warm on early starts.');
const MENS_BASELAYER = garment('CREW BASELAYER - BLACK', 'BASELAYER TOPS', 'Breathable and moisture-wicking under any top.');

const CATALOGUE = [
  LADIES_MIDLAYER, LADIES_MIDLAYER_2, LADIES_CAP, LADIES_POLO, LADIES_SLEEVELESS, LADIES_DRESS,
  MENS_MIDLAYER, MENS_JACKET, MENS_HOODIE, MENS_BASELAYER, MENS_POLO,
];

beforeEach(() => {
  setCatalogueForTests(CATALOGUE);
  setDealsForTests([]);
});

async function search(query: string, utterance: string) {
  const session = await sessions.getOrCreate(`top-${Math.random()}`);
  const result = await runTool('search_products', { query }, { session, utterance });
  const shown = result.attachment?.kind === 'products' ? result.attachment.products : [];
  return { result, shown, titles: shown.map((p) => p.title) };
}

const kindOf = (product: Product) => [...categoriesOf(product)];
const isHotTop = (product: Product) => kindOf(product).some((kind) => kind === 'polo' || kind === 'dress');
const isLayer = (product: Product) => kindOf(product).some((kind) => kind === 'midlayer' || kind === 'hoodie' || kind === 'jacket');

describe('what "top" means', () => {
  it('depends on the weather, and on nothing having been named', () => {
    expect(topKindsFor('a ladies top for warm weather', 'hot', [])).toEqual(['polo', 'dress']);
    expect(topKindsFor('a top for a cold morning', 'cold', [])).toEqual(['midlayer', 'hoodie', 'jacket']);
    expect(topKindsFor('show me a top', undefined, [])).toEqual([]);
    expect(topKindsFor('a midlayer for summer', 'hot', ['midlayer'])).toEqual([]);
    expect(topKindsFor('something for summer', 'hot', [])).toEqual([]);
  });
});

describe('a top for the weather', () => {
  it('lightweight ladies top for warm weather: ladies only, polos and dresses ahead of warm midlayers', async () => {
    const { result, shown } = await search('lightweight ladies top for warm weather', 'I need a lightweight ladies top for warm weather');
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((p) => rangeOf(p) === 'women')).toBe(true);
    expect(isHotTop(shown[0]!)).toBe(true);
    const lastHotTop = Math.max(...shown.map((p, i) => (isHotTop(p) ? i : -1)));
    const firstOther = shown.findIndex((p) => !isHotTop(p));
    if (firstOther >= 0) expect(firstOther).toBeGreaterThan(lastHotTop);
    expect(result.facts).toMatch(/"Top" read as polo or dress for hot weather - a preference/);
    expect(result.facts).not.toMatch(/Lead with: LADIES BREEZY MIDLAYER/);
  });

  it('ladies top for summer: the summer kinds first', async () => {
    const { shown } = await search('ladies top for summer', 'Show me a ladies top for summer golf');
    expect(shown.slice(0, 3).every(isHotTop)).toBe(true);
    expect(shown.every((p) => rangeOf(p) === 'women')).toBe(true);
  });

  it('mens lightweight top for warm weather: mens only, a polo first', async () => {
    const { shown } = await search('mens lightweight top for warm weather', 'mens lightweight top for warm weather');
    expect(shown.every((p) => rangeOf(p) === 'men')).toBe(true);
    expect(shown[0]!.title).toBe('SOLITAIRE POLO - NAVY');
  });

  it('a top with no weather stays broad', async () => {
    const { result, shown } = await search('top', 'Show me a top');
    expect(shown.length).toBeGreaterThan(0);
    expect(result.facts ?? '').not.toMatch(/"Top" read as/);
    // Not forced into polos: the layers and baselayers that say "top" are still there.
    expect(shown.some((p) => !isHotTop(p))).toBe(true);
  });

  it('a warm top for a cold morning: layers, never a polo', async () => {
    const { shown } = await search('warm top for a cold morning', 'I need a warm top for a cold morning');
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every(isLayer)).toBe(true);
  });

  it('a top for a cold morning, without "warm": the layers lead', async () => {
    const { result, shown } = await search('top for a cold morning', 'a top for a cold morning');
    expect(isLayer(shown[0]!)).toBe(true);
    expect(result.facts).toMatch(/"Top" read as midlayer or hoodie or jacket for cold weather/);
  });

  it('a midlayer named for summer stays a midlayer', async () => {
    const { result, shown } = await search('lightweight midlayer for summer evenings', 'I want a lightweight midlayer for summer evenings');
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((p) => kindOf(p).includes('midlayer'))).toBe(true);
    expect(result.facts ?? '').not.toMatch(/"Top" read as/);
  });
});

describe('warm and breathable, in the heat and in the cold', () => {
  const WARM_BREATHABLE = garment('HECTAR MIDLAYER - GREY', 'MIDLAYERS', 'Breathable, with brushed warmth.');
  const LIGHT_BREATHABLE = garment('BREEZE POLO - WHITE', 'POLOS', 'Lightweight and breathable.');

  it('for hot weather, below a product with heat signals and no warmth', () => {
    const ranked = rankProducts([WARM_BREATHABLE, LIGHT_BREATHABLE], { weather: ['hot'], weatherAsked: true });
    expect(ranked.map((r) => r.product.title)).toEqual(['BREEZE POLO - WHITE', 'HECTAR MIDLAYER - GREY']);
    const warm = ranked.find((r) => r.product === WARM_BREATHABLE)!;
    expect(warm.matchLevel).toBe('strong');
    expect(warm.missedPreferences.join(' ')).toMatch(/warm/);
    expect(warm.reason).not.toMatch(/breathable/);
  });

  it('for cold weather, still the strong pick', () => {
    const ranked = rankProducts([LIGHT_BREATHABLE, WARM_BREATHABLE], { weather: ['cold'], weatherAsked: true });
    expect(ranked[0]!.product).toBe(WARM_BREATHABLE);
    expect(ranked[0]!.matchLevel).toBe('exact');
  });

  it('a day that is both hot and cold leaves warm alone', () => {
    const ranked = rankProducts([WARM_BREATHABLE], { weather: ['hot', 'cold'], weatherAsked: true });
    expect(ranked[0]!.matchLevel).toBe('exact');
  });

  it('remembered heat ranks it down but never calls it a miss', () => {
    const ranked = rankProducts([WARM_BREATHABLE, LIGHT_BREATHABLE], { weather: ['hot'] });
    expect(ranked[0]!.product).toBe(LIGHT_BREATHABLE);
    expect(ranked.find((r) => r.product === WARM_BREATHABLE)!.missedPreferences).toEqual([]);
  });
});
