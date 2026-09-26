import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { answerAbout, sizesAsked, stockPicture } from '../src/recommend/productFacts.js';
import { resolveProduct } from '../src/session/screen.js';
import type { CaddieSession } from '../src/session/store.js';

/**
 * Colours, sizes, stock and price in a size - the questions a shop assistant
 * gets all day - answered from the variants, and "the second one" resolved
 * from what is on screen.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function garment(title: string, sizes: Array<[string, boolean, number?]>, extra: Partial<Product> = {}): Product {
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: 'POLOS',
    tags: [...BRAND],
    price: { amount: Math.min(...sizes.map(([, , p]) => p ?? 24)), currency: 'GBP' },
    options: [{ name: 'Size', values: sizes.map(([size]) => size) }],
    variants: sizes.map(([size, available, price]) => ({
      id: `${title}-${size}`,
      title: size,
      available,
      price: { amount: price ?? 24, currency: 'GBP' },
      options: { Size: size },
    })),
    description: null,
    ...extra,
  };
}

const VENTO_NAVY = garment('VENTO POLO - NAVY', [['S', true], ['M', true], ['L', true], ['XL', false], ['2XL', true, 28]]);
const VENTO_WHITE = garment('VENTO POLO - WHITE', [['M', true], ['L', true]]);
const ELITE_BLACK = garment('ELITE POLO - BLACK', [['S', true], ['M', false]]);
const TROUSERS = garment('TECH TROUSER - NAVY', [['32', true, 30], ['34', false, 30]], {
  productType: 'TROUSERS',
  options: [
    { name: 'WAIST SIZE', values: ['32', '34'] },
    { name: 'LEG LENGTH', values: ['30', '32'] },
  ],
  variants: [
    { id: 't-32-30', title: '32 / 30', available: true, price: { amount: 30, currency: 'GBP' }, options: { 'WAIST SIZE': '32', 'LEG LENGTH': '30' } },
    { id: 't-34-30', title: '34 / 30', available: false, price: { amount: 30, currency: 'GBP' }, options: { 'WAIST SIZE': '34', 'LEG LENGTH': '30' } },
  ],
});

beforeEach(() => setCatalogueForTests([VENTO_NAVY, VENTO_WHITE, ELITE_BLACK, TROUSERS]));

function session(items: Product[], pageProduct?: Product): CaddieSession {
  return {
    id: 's',
    createdAt: 0,
    updatedAt: 0,
    sizeProfile: {},
    preferences: {},
    messages: [],
    lastShown: { kind: 'products', items: items.map((p) => ({ id: p.id, title: p.title })) },
    ...(pageProduct ? { page: { pageType: 'product' as const, productId: pageProduct.id } } : {}),
  };
}

describe('the stock picture', () => {
  it('knows every size, what is sold out, and prices that differ by size', () => {
    const picture = stockPicture(VENTO_NAVY);
    const sizes = picture.groups[0]!.sizes;
    expect(sizes.find((s) => s.size === 'XL')!.inStock).toBe(false);
    expect(sizes.find((s) => s.size === '2XL')!.price).toBe(28);
    expect(picture.otherColourways.map((p) => p.title)).toEqual(['VENTO POLO - WHITE']);
  });

  it('reads waist sizes, and leg length as another choice', () => {
    const picture = stockPicture(TROUSERS);
    expect(picture.sizeOption).toBe('WAIST SIZE');
    expect(picture.otherOptions.map((o) => o.name)).toEqual(['LEG LENGTH']);
  });
});

describe('answering the question', () => {
  it('is XL in stock - no, with what is', () => {
    const answer = answerAbout(VENTO_NAVY, 'is XL in stock?');
    expect(answer.speech).toMatch(/XL is sold out/);
    expect(answer.speech).toMatch(/S, M, L, 2XL/);
  });

  it('how much in 2XL - the price of that size, not the starting price', () => {
    expect(answerAbout(VENTO_NAVY, 'how much is it in 2XL?').speech).toBe('2XL is in stock at £28.00.');
  });

  it('what colours - its own and the other colourways', () => {
    expect(answerAbout(VENTO_NAVY, 'what colours does it come in?').speech).toBe('It comes in navy, white.');
  });

  it('does it come in white - yes, as the other colourway', () => {
    expect(answerAbout(VENTO_NAVY, 'does it come in white?').speech).toMatch(/^Yes - it also comes in white/);
  });

  it('does it come in green - no, and what it does come in', () => {
    expect(answerAbout(VENTO_NAVY, 'do you have it in green?').speech).toMatch(/^Not in green.*navy, white/);
  });

  it('a waist size on trousers', () => {
    expect(answerAbout(TROUSERS, 'is the 34 waist available?').speech).toMatch(/34 is sold out/);
  });

  it('never reads "it\'s in stock" as size S', () => {
    expect(sizesAsked("is it's in stock", VENTO_NAVY)).toEqual([]);
    expect(sizesAsked('do you have it in L', VENTO_NAVY)).toEqual(['L']);
    expect(sizesAsked('a medium please', VENTO_NAVY)).toEqual(['M']);
  });

  it('the price range when it depends on the size', () => {
    expect(answerAbout(VENTO_NAVY, 'how much is it?').speech).toBe("It's £24.00 to £28.00, depending on the size.");
  });
});

describe('which product they mean', () => {
  const screen = session([VENTO_NAVY, ELITE_BLACK, TROUSERS]);

  it('by position', () => {
    expect(resolveProduct(screen, 'is the second one in stock')?.product).toBe(ELITE_BLACK);
    expect(resolveProduct(screen, 'the last one')?.product).toBe(TROUSERS);
  });

  it('by colour, kind or name', () => {
    expect(resolveProduct(screen, 'does the black one come in XL')?.product).toBe(ELITE_BLACK);
    expect(resolveProduct(screen, 'what sizes do the trousers come in')?.product).toBe(TROUSERS);
    expect(resolveProduct(screen, 'is the vento in stock')?.product).toBe(VENTO_NAVY);
  });

  it('"this" is the page they are on', () => {
    expect(resolveProduct(session([ELITE_BLACK, TROUSERS], VENTO_WHITE), 'does this come in XL')?.product).toBe(VENTO_WHITE);
  });

  it('asks rather than guesses when it could be several', () => {
    expect(resolveProduct(session([VENTO_NAVY, ELITE_BLACK]), 'does the polo come in XL')).toBeNull();
  });
});
