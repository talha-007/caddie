import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { verifyReply } from '../src/ai/verify.js';
import { setDealsForTests } from '../src/catalog/bundles.js';
import {
  availableSizes,
  chartCategoryOf,
  colourwaysOf,
  featureState,
  formatMoney,
  primaryKind,
  productColourWords,
  productRange,
  resolveVariant,
  sizeOptionName,
  sizeScale,
  supportsSize,
} from '../src/catalog/commerce.js';
import { searchLocal } from '../src/catalog/search.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { kindOf } from '../src/recommend/bestPicks.js';
import { DEFAULT_SLOTS, fitsSlot } from '../src/recommend/outfit.js';
import { priceFor } from '../src/recommend/pricing.js';
import { answerAbout, attributesAsked, describeStock, stockPicture } from '../src/recommend/productFacts.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * Phase 4: one answer to each factual question about a catalogue product,
 * and every consumer - search, best picks, outfits, sizing, product
 * answers, the basket and the reply checker - reading that answer.
 * Fixtures are shaped on real Druids products: their titles, product types,
 * descriptions and option shapes.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
let next = 70000;
type Opt = { name: string; values: string[] };
function item(
  title: string,
  productType: string,
  description: string,
  options: Opt[] = [{ name: 'Size', values: ['S', 'M', 'L', 'XL'] }],
  opts: { price?: (combo: Record<string, string>) => number; soldOut?: (combo: Record<string, string>) => boolean } = {},
): Product {
  const combos = options.reduce<Array<Record<string, string>>>((acc, option) => acc.flatMap((combo) => option.values.map((value) => ({ ...combo, [option.name]: value }))), [{}]);
  const id = next;
  next += 50;
  const price = opts.price ?? (() => 30);
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType,
    tags: [...BRAND],
    price: { amount: Math.min(...combos.map(price)), currency: 'GBP' },
    options,
    variants: combos.map((combo, i) => ({
      id: `gid://shopify/ProductVariant/${id + i + 1}`,
      title: Object.values(combo).join(' / '),
      available: !(opts.soldOut?.(combo) ?? false),
      price: { amount: price(combo), currency: 'GBP' },
      options: combo,
    })),
    description,
  };
}

const ELITE_NAVY = item('ELITE POLO - NAVY', 'POLOS', 'Breathable, moisture-wicking piqué polo with a slim fit.', [{ name: 'Size', values: ['S', 'M', 'L', 'XL', '2XL'] }], {
  price: (combo) => (combo.Size === '2XL' ? 24 : 20),
  soldOut: (combo) => combo.Size === 'XL',
});
const ELITE_WHITE = item('ELITE POLO - WHITE', 'POLOS', 'Breathable, moisture-wicking piqué polo with a slim fit.');
const VENTO = item('VENTO POLO - NAVY/ WHITE', 'POLOS', 'Lightweight polo in a relaxed fit.');
const HOODIE = item('CLUB HOODIE - GREY', 'MIDLAYERS', 'Soft brushed-back hoodie with a hood.');
const GILET = item('ARVID GILET - BLACK', 'GILETS', 'Sleeveless and windproof, with a thermal lining.');
const TEX = item('TEX RAIN JACKET - BLACK', 'JACKETS', 'Fully waterproof and breathable.');
const SHOWER = item('SHOWER TOP - NAVY', 'JACKETS', 'Water-resistant shell for light showers. Not waterproof.');
const TROUSERS = item('CLIMA GOLF TROUSERS - NAVY', 'TROUSERS', 'Stretch trousers.', [
  { name: 'WAIST SIZE', values: ['32', '34', '36'] },
  { name: 'LEG LENGTH', values: ['30', '32'] },
], { soldOut: (combo) => combo['WAIST SIZE'] === '36' });
const JOGGERS = item('TOUR JOGGERS - BLACK', 'JOGGERS', 'Tapered joggers.');
const SKORT = item('LADIES PLAY SKORT - WHITE', 'LADIES SKORTS', 'Stretch skort.', [{ name: 'Size', values: ['8', '10', '12', '14'] }]);
const CAP = item('EVERYDAY D CAP - WHITE', 'CAPS', 'Cotton cap.', [{ name: 'Size', values: ['ONE SIZE'] }]);
const BELT = item('CROC LEATHER BELT - BROWN', 'BELTS', 'Leather belt.', [{ name: 'Size', values: ['S/M', 'L/XL'] }]);
const SOCKS = item('ONE PAIR TOUR ANKLE SOCKS - WHITE', 'SOCKS', 'Cushioned ankle socks.', []);
const KIDS = item('KIDS BAND POLO - NAVY', 'KIDS POLOS', 'Breathable polo.', [{ name: 'Size', values: ['7/8', '9/10', '11/12'] }]);
const GONE = item('ELITE POLO - SAGE', 'POLOS', 'Breathable, moisture-wicking piqué polo with a slim fit.', undefined, { soldOut: () => true });
const ALL = [ELITE_NAVY, ELITE_WHITE, VENTO, HOODIE, GILET, TEX, SHOWER, TROUSERS, JOGGERS, SKORT, CAP, BELT, SOCKS, KIDS, GONE];

beforeEach(() => {
  setCatalogueForTests(ALL);
  setDealsForTests([]);
});

/* ---------------- kind and range ---------------- */

describe('one kind and one range, read the same by every consumer', () => {
  const cases: Array<[Product, string, 'men' | 'women' | 'kids', string | undefined, string | undefined, string | undefined]> = [
    // product, kind, range, best-pick kind, outfit slot, chart
    [ELITE_NAVY, 'polo', 'men', 'polo', 'top', 'polo'],
    [HOODIE, 'hoodie', 'men', 'midlayer', 'layer', 'midlayer'],
    [GILET, 'gilet', 'men', 'jacket', 'layer', undefined],
    [TEX, 'jacket', 'men', 'jacket', 'layer', 'jacket'],
    [TROUSERS, 'trousers', 'men', 'bottoms', 'bottom', 'trousers'],
    [JOGGERS, 'trousers', 'men', 'bottoms', 'bottom', 'trousers'],
    [SKORT, 'skort', 'women', 'bottoms', 'bottom', undefined],
    [CAP, 'cap', 'men', 'headwear', 'accessory', undefined],
    [BELT, 'belt', 'men', 'belt', 'accessory', undefined],
    [SOCKS, 'socks', 'men', 'socks', 'accessory', undefined],
    [KIDS, 'polo', 'kids', 'polo', 'top', undefined],
  ];
  for (const [product, kind, range, pick, slot, chart] of cases) {
    it(`${product.title}: ${kind}, ${range}`, () => {
      expect(primaryKind(product)).toBe(kind);
      expect(productRange(product)).toBe(range);
      expect(kindOf(product)).toBe(pick);
      if (slot) {
        expect(fitsSlot(product, DEFAULT_SLOTS.find((own) => own.slot === slot)!)).toBe(true);
        for (const other of DEFAULT_SLOTS.filter((own) => own.slot !== slot)) expect(fitsSlot(product, other), `${product.title} in ${other.slot}`).toBe(false);
      }
      if (chart && range !== 'kids') expect(chartCategoryOf(product, range === 'women' ? 'women' : 'men')).toBe(chart);
    });
  }

  it('search filters by the same kind and range', () => {
    const polos = searchLocal({ query: 'polo', categories: ['polo'], available: false });
    expect(polos.every((product) => primaryKind(product) === 'polo')).toBe(true);
    const ladies = searchLocal({ query: 'skort', range: 'women' });
    expect(ladies.map((product) => product.title)).toEqual([SKORT.title]);
    // Never a child's polo for an adult who named no range.
    expect(searchLocal({ query: 'polo' }).some((product) => productRange(product) === 'kids')).toBe(false);
  });

  it('a tag never decides a kind: a campaign label is not a garment', () => {
    const tagged = { ...ELITE_WHITE, id: 'gid://shopify/Product/79999', tags: [...ELITE_WHITE.tags, 'jacket', 'trousers'] };
    expect(fitsSlot(tagged, DEFAULT_SLOTS.find((own) => own.slot === 'bottom')!)).toBe(false);
    expect(primaryKind(tagged)).toBe('polo');
  });
});

/* ---------------- colour ---------------- */

describe('colour: one reading for search, colourways, other colours and the checker', () => {
  it('a compound colourway is both its colours', () => {
    expect(productColourWords(VENTO)).toEqual(expect.arrayContaining(['navy', 'white']));
    expect(searchLocal({ query: 'white polo' }).map((product) => product.title)).toContain(VENTO.title);
  });

  it('colourways of a design: the same design, same range, only those that can be bought', () => {
    const family = colourwaysOf(ELITE_NAVY).map((product) => product.title);
    expect(family).toEqual(expect.arrayContaining([ELITE_NAVY.title, ELITE_WHITE.title]));
    expect(family).not.toContain(GONE.title);
    expect(family).not.toContain(VENTO.title);
  });

  it('a colourway that is sold out is still its colour - but nothing offers it', () => {
    expect(productColourWords(GONE, false)).toContain('sage');
    expect(searchLocal({ query: 'sage polo' })).toEqual([]);
    expect(colourwaysOf(ELITE_WHITE).map((product) => product.title)).not.toContain(GONE.title);
  });

  it('other_colours, and the checker, agree', async () => {
    const id = `ct-${Math.random()}`;
    await sessions.getOrCreate(id);
    const result = await runTool('other_colours', { productId: ELITE_NAVY.id }, { session: await sessions.getOrCreate(id), direct: true });
    const shown = result.attachment?.kind === 'products' ? result.attachment.products.map((product) => product.title) : [];
    expect(shown).toEqual(expect.arrayContaining([ELITE_NAVY.title, ELITE_WHITE.title]));
    expect(shown).not.toContain(GONE.title);
    const card = { kind: 'products' as const, products: [VENTO] };
    expect(verifyReply('The white Vento polo is lightweight.', VENTO.title, card).filter((v) => v.kind === 'colour')).toEqual([]);
    expect(verifyReply('The red Vento polo is lightweight.', VENTO.title, card).filter((v) => v.kind === 'colour')).toHaveLength(1);
  });
});

/* ---------------- sizes ---------------- */

describe('size scales: what size choices a product really has', () => {
  it('letters, combined letters, waist and leg, UK numbers, ages, one size', () => {
    expect(sizeScale(ELITE_NAVY).dimensions.map((d) => d.scale)).toEqual(['letter']);
    expect(sizeScale(BELT).dimensions.map((d) => d.scale)).toEqual(['combined']);
    expect(sizeScale(TROUSERS).dimensions.map((d) => d.scale)).toEqual(['waist', 'leg']);
    expect(sizeScale(SKORT).dimensions.map((d) => d.scale)).toEqual(['number']);
    expect(sizeScale(KIDS).dimensions.map((d) => d.scale)).toEqual(['age']);
    expect(sizeScale(CAP).oneSize).toBe(true);
    expect(sizeScale(SOCKS).oneSize).toBe(true);
    expect(sizeOptionName(CAP)).toBeNull();
    expect(sizeOptionName(TROUSERS)).toBe('WAIST SIZE');
  });

  it('in stock, sold out, not made, another scale - one answer', () => {
    expect(supportsSize(ELITE_NAVY, 'M')).toBe('in-stock');
    expect(supportsSize(ELITE_NAVY, 'medium')).toBe('in-stock');
    expect(supportsSize(ELITE_NAVY, 'XL')).toBe('sold-out');
    expect(supportsSize(ELITE_NAVY, '3XL')).toBe('not-made');
    // V1 task 1: a waist says nothing about a polo, and a top size nothing about a belt in M/L - they are not applicable.
    expect(supportsSize(ELITE_NAVY, '34')).toBe('not-applicable');
    expect(supportsSize(BELT, 'L')).toBe('not-applicable');
    // A combined size said as itself is the belt's own.
    expect(supportsSize(BELT, 'L/XL')).not.toBe('not-applicable');
    expect(supportsSize(TROUSERS, '36')).toBe('sold-out');
    expect(availableSizes(ELITE_NAVY)).toEqual(['S', 'M', 'L', '2XL']);
  });

  it('search, product info and the checker agree on XL being sold out', () => {
    expect(searchLocal({ query: 'elite polo', size: 'XL' }).map((p) => p.title)).not.toContain(ELITE_NAVY.title);
    expect(describeStock(ELITE_NAVY)).toMatch(/sold out XL/);
    expect(answerAbout(ELITE_NAVY, 'is XL in stock?').speech).toMatch(/XL.*sold out|sold out.*XL/i);
    const card = { kind: 'products' as const, products: [ELITE_NAVY] };
    expect(verifyReply('XL is in stock in the Elite Polo.', ELITE_NAVY.title, card).filter((v) => v.kind === 'stock')).toHaveLength(1);
    expect(verifyReply('M is in stock.', ELITE_NAVY.title, card).filter((v) => v.kind === 'stock')).toEqual([]);
    expect(verifyReply('It is sold out in XL.', ELITE_NAVY.title, card).filter((v) => v.kind === 'stock')).toEqual([]);
    expect(verifyReply('It is sold out in M.', ELITE_NAVY.title, card).filter((v) => v.kind === 'stock')).toHaveLength(1);
  });

  it('one size, everywhere: the card, product info and the basket never ask a size', async () => {
    expect(stockPicture(CAP).sizeOption).toBeUndefined();
    expect(describeStock(CAP)).toMatch(/one size/);
    expect(answerAbout(SOCKS, 'what sizes does it come in?').speech).toMatch(/one size/i);
    const id = `ct-${Math.random()}`;
    await sessions.getOrCreate(id);
    await sessions.patch(id, { cartMode: 'theme' });
    const added = await runTool('add_to_cart', { productId: CAP.id }, { session: await sessions.getOrCreate(id), direct: true });
    expect(added.actions?.length).toBe(1);
    expect(added.speech ?? '').not.toMatch(/which size|what size/i);
  });
});

/* ---------------- attributes ---------------- */

describe('attributes: stated, explicitly not, or not stated', () => {
  it('waterproof, water-resistant but not waterproof, not stated', () => {
    expect(featureState(TEX, 'waterproof')).toBe('yes');
    expect(featureState(TEX, 'water-resistant')).toBe('yes');
    expect(featureState(SHOWER, 'water-resistant')).toBe('yes');
    expect(featureState(SHOWER, 'waterproof')).toBe('no');
    expect(featureState(ELITE_NAVY, 'waterproof')).toBe('unknown');
  });

  it('product info says each of those as its data does', () => {
    expect(attributesAsked(TEX, 'is it waterproof?')[0]?.state).toBe('yes');
    expect(attributesAsked(SHOWER, 'is it waterproof?')[0]).toMatchObject({ state: 'other', instead: 'water-resistant' });
    expect(attributesAsked(ELITE_NAVY, 'is it waterproof?')[0]?.state).toBe('unstated');
  });

  it('the checker holds a reply to the same data', () => {
    const on = (product: Product) => ({ kind: 'products' as const, products: [product] });
    const attrs = (reply: string, product: Product) => verifyReply(reply, product.title, on(product)).filter((v) => v.kind === 'attribute').map((v) => v.claim);
    expect(attrs('The Tex Rain Jacket is waterproof.', TEX)).toEqual([]);
    expect(attrs('The Shower Top is waterproof.', SHOWER)).toContain('waterproof');
    expect(attrs('The Elite Polo is breathable.', ELITE_NAVY)).toEqual([]);
    expect(attrs('The Vento Polo has a relaxed fit.', VENTO)).toEqual([]);
    expect(attrs('The Elite Polo has a relaxed fit.', ELITE_NAVY)).toContain('relaxed fit');
    expect(attrs('The Arvid Gilet is sleeveless.', GILET)).toEqual([]);
    expect(attrs('The Club Hoodie is sleeveless.', HOODIE)).toContain('sleeveless');
    expect(attrs('The Arvid Gilet is insulated.', GILET)).toContain('insulated');
  });

  it('fit only where stated', () => {
    expect(attributesAsked(ELITE_NAVY, 'is it a relaxed fit?')[0]).toMatchObject({ state: 'other' });
    expect(attributesAsked(TEX, 'is it a relaxed fit?')[0]?.state).toBe('unstated');
  });
});

/* ---------------- variant and price ---------------- */

describe('one variant, one price - on the card, in the reply and in the basket', () => {
  it('exact, incomplete, invalid, ambiguous', () => {
    expect(resolveVariant(ELITE_NAVY, { Size: 'M' }).status).toBe('exact');
    expect(resolveVariant(ELITE_NAVY, { size: 'medium' }).status).toBe('exact');
    expect(resolveVariant(TROUSERS, { 'WAIST SIZE': '34' })).toMatchObject({ status: 'incomplete' });
    expect(resolveVariant(ELITE_NAVY, { Size: '3XL' }).status).toBe('invalid');
    expect(resolveVariant(ELITE_NAVY, {}).status).toBe('incomplete');
    const beltish = item('TOUR BELT - BLACK', 'BELTS', 'Belt.', [{ name: 'Size', values: ['M/L', 'L/XL'] }]);
    expect(resolveVariant(beltish, { Size: 'L' }).status).toBe('ambiguous');
    expect(resolveVariant(BELT, { Size: 'L' }).status).toBe('exact');
    expect(resolveVariant(CAP).status).toBe('exact');
  });

  it('the price in a size: product details, the stock line and the basket say the same', async () => {
    const id = `ct-${Math.random()}`;
    await sessions.getOrCreate(id);
    await sessions.patch(id, { cartMode: 'theme' });
    const details = await runTool('get_product_details', { productId: ELITE_NAVY.id, options: { Size: '2XL' } }, { session: await sessions.getOrCreate(id), direct: true });
    expect(details.speech).toContain(formatMoney(24, 'GBP'));
    expect(priceFor(ELITE_NAVY, '2XL')).toMatchObject({ amount: 24, exact: true });
    expect(describeStock(ELITE_NAVY)).toContain('2XL (£24.00)');
    const added = await runTool('add_to_cart', { productId: ELITE_NAVY.id, options: { Size: '2XL' } }, { session: await sessions.getOrCreate(id), direct: true });
    expect(added.actions?.[0]).toMatchObject({ type: 'add', lines: [{ variantId: ELITE_NAVY.variants.find((v) => v.options.Size === '2XL')!.id.split('/').pop() }] });
    expect(added.facts ?? '').toContain('Charged: £24.00');
  });

  it('a size chosen with nothing else open, but the colour of a two-option product not chosen, is not a variant', async () => {
    const twoOption = item('PRIME POLO', 'POLOS', 'Polo.', [
      { name: 'Colour', values: ['Navy', 'White'] },
      { name: 'Size', values: ['S', 'M'] },
    ]);
    setCatalogueForTests([...ALL, twoOption]);
    const id = `ct-${Math.random()}`;
    await sessions.getOrCreate(id);
    const details = await runTool('get_product_details', { productId: twoOption.id, options: { Size: 'M' } }, { session: await sessions.getOrCreate(id), direct: true });
    expect(details.speech).not.toMatch(/is £30\.00 and in stock/);
  });

  it('sold out in the exact size: not added, and said so', async () => {
    const id = `ct-${Math.random()}`;
    await sessions.getOrCreate(id);
    await sessions.patch(id, { cartMode: 'theme' });
    const added = await runTool('add_to_cart', { productId: ELITE_NAVY.id, options: { Size: 'XL' } }, { session: await sessions.getOrCreate(id), direct: true });
    expect(added.actions ?? []).toEqual([]);
    expect(added.speech).toMatch(/out of stock/i);
  });

  it('a price with no size is the lowest they could pay - never a sold-out variant\'s', () => {
    const odd = item('ODD POLO - NAVY', 'POLOS', 'Polo.', [{ name: 'Size', values: ['S', 'M'] }], { price: (combo) => (combo.Size === 'S' ? 10 : 30), soldOut: (combo) => combo.Size === 'S' });
    setCatalogueForTests([...ALL, odd]);
    expect(priceFor(odd)).toMatchObject({ amount: 30 });
    expect(searchLocal({ query: 'odd polo', maxPrice: 20 }).map((product) => product.title)).not.toContain(odd.title);
    expect(stockPicture(odd)).toMatchObject({ priceMin: 30, priceMax: 30 });
  });
});

/* ---------------- search hard constraints ---------------- */

describe('search: a product passes a hard constraint here exactly when commerce truth says so', () => {
  it('kind, range, colour, size, budget', () => {
    const hits = searchLocal({ query: 'navy polo', categories: ['polo'], size: 'M', maxPrice: 25 });
    for (const product of ALL) {
      const passes =
        primaryKind(product) === 'polo' &&
        productRange(product) !== 'kids' &&
        productColourWords(product).includes('navy') &&
        supportsSize(product, 'M') === 'in-stock' &&
        priceFor(product, 'M').amount <= 25;
      expect(hits.some((hit) => hit.id === product.id), product.title).toBe(passes);
    }
  });
});

/* ---------------- found in the live replay ---------------- */

describe('found in the live replay', () => {
  it('"Top size M, waist 34, leg 32" confirms all three - the waist no longer hides the top size', async () => {
    const { readPackChoices } = await import('../src/tools/packState.js');
    const polo = ELITE_WHITE;
    expect(readPackChoices('Top size M, waist 34, leg 32.', 'What top size do you wear?', [polo, TROUSERS])).toMatchObject({ top: 'M', waist: '34', leg: '32' });
  });

  it('search tells the model a one-size card has no size to ask for', async () => {
    const id = `ct-${Math.random()}`;
    await sessions.getOrCreate(id);
    const result = await runTool('search_products', { query: 'socks' }, { session: await sessions.getOrCreate(id), utterance: 'show me some socks' });
    expect(result.facts).toMatch(/ONE PAIR TOUR ANKLE SOCKS - WHITE.*one size - never ask a size/);
    expect(result.facts ?? '').not.toMatch(/their size is not known - ask for it/);
  });
});

/* ---------------- amendment: size questions, and one variant matcher ---------------- */

describe('the checker rejects a size asked of what has no size to choose', () => {
  const sizes = (reply: string, products: Product[], settled: string[] = [], screen: Product[] = []) =>
    verifyReply(reply, products.map((p) => p.title).join('\n'), { kind: 'products', products }, undefined, { screen, sizeSettled: new Set(settled) }).filter((v) => v.kind === 'size');

  it('one-size socks + "what size?": rejected', () => {
    expect(sizes('What size would you like?', [SOCKS])).toHaveLength(1);
  });

  it('one-size belt or cap + "choose a size": rejected', () => {
    const oneSizeBelt = item('CROC GOLF LEATHER BELT - GREY', 'BELTS', 'Leather belt.', [{ name: 'Size', values: ['ONE SIZE FITS ALL'] }]);
    expect(sizes('Please choose a size for the belt.', [oneSizeBelt])).toHaveLength(1);
    expect(sizes('Choose a size and I will add the cap.', [CAP])).toHaveLength(1);
  });

  it('a polo with no size chosen: the question stands', () => {
    expect(sizes('What size would you like in the Elite Polo?', [ELITE_NAVY])).toEqual([]);
  });

  it('the Elite Polo already chosen in M: not asked again', () => {
    expect(sizes('What size would you like for the Elite Polo?', [ELITE_NAVY], [ELITE_NAVY.id])).toHaveLength(1);
  });

  it('a pack where only the one-size pieces are "open": no claim they need sizes - a real open size still asked', () => {
    const pack = { kind: 'pack' as const, recommendation: { items: [ELITE_NAVY, TROUSERS, SOCKS, CAP], total: { amount: 99, currency: 'GBP' }, reason: '' } } as never;
    const check = (reply: string, settled: string[]) =>
      verifyReply(reply, '', pack, undefined, { sizeSettled: new Set(settled) }).filter((v) => v.kind === 'size');
    expect(check('I still need the sizes for the socks and the cap.', [ELITE_NAVY.id, TROUSERS.id])).toHaveLength(1);
    expect(check('The pack needs size options for the belt and socks too.', [ELITE_NAVY.id, TROUSERS.id])).toHaveLength(1);
    expect(check('What top size do you wear?', [TROUSERS.id])).toEqual([]);
    expect(check('What waist size do you need for the trousers?', [ELITE_NAVY.id])).toEqual([]);
  });

  it('"it comes in one size" is not a question', () => {
    expect(sizes('It comes in one size, so no size to choose.', [SOCKS])).toEqual([]);
  });
});

describe('getProductDetails narrows by the one matching rule', () => {
  const PRIME = item('PRIME POLO', 'POLOS', 'Polo.', [
    { name: 'Colour', values: ['Navy', 'White'] },
    { name: 'Size', values: ['S', 'M'] },
  ]);
  const TOUR_BELT = item('TOUR BELT - BLACK', 'BELTS', 'Belt.', [{ name: 'Size', values: ['M/L', 'L/XL'] }]);
  beforeEach(() => setCatalogueForTests([...ALL, PRIME, TOUR_BELT]));
  const details = async (product: Product, selected: Record<string, string>) => {
    const { getProductDetails } = await import('../src/shopify/catalog.js');
    return (await getProductDetails(product.id, selected))!;
  };

  it('exact options: the one variant', async () => {
    expect((await details(PRIME, { Colour: 'Navy', Size: 'M' })).variants).toHaveLength(1);
    expect(resolveVariant(PRIME, { colour: 'navy', size: 'medium' }).status).toBe('exact');
  });

  it('partial options: every variant they allow, and incomplete - never the first', async () => {
    expect((await details(PRIME, { Size: 'M' })).variants.map((v) => v.options.Colour)).toEqual(['Navy', 'White']);
    expect(resolveVariant(PRIME, { Size: 'M' }).status).toBe('incomplete');
  });

  it('ambiguous: L on a belt made in M/L and L/XL', async () => {
    expect((await details(TOUR_BELT, { Size: 'L' })).variants).toHaveLength(2);
    expect(resolveVariant(TOUR_BELT, { Size: 'L' }).status).toBe('ambiguous');
  });

  it('combined: L/XL named exactly, or L on a belt made in S/M and L/XL', async () => {
    expect((await details(TOUR_BELT, { Size: 'L/XL' })).variants.map((v) => v.options.Size)).toEqual(['L/XL']);
    expect((await details(BELT, { Size: 'L' })).variants.map((v) => v.options.Size)).toEqual(['L/XL']);
    expect(resolveVariant(BELT, { Size: 'large' }).status).toBe('exact');
  });

  it('invalid: none', async () => {
    expect((await details(PRIME, { Colour: 'Red', Size: 'M' })).variants).toEqual([]);
    expect(resolveVariant(PRIME, { Colour: 'Red', Size: 'M' }).status).toBe('invalid');
  });

  it('sold-out exact: that variant, marked sold out', async () => {
    const variants = (await details(ELITE_NAVY, { Size: 'XL' })).variants;
    expect(variants).toHaveLength(1);
    expect(variants[0]!.available).toBe(false);
    const resolved = resolveVariant(ELITE_NAVY, { Size: 'XL' });
    expect(resolved.status === 'exact' && resolved.variant.available).toBe(false);
  });
});
