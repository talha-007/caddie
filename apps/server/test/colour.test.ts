import { describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { colourMatch, coloursOffered, parseColours } from '../src/catalog/colour.js';
import { searchLocal } from '../src/catalog/search.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';

/**
 * "A blue polo" in Spanish came back with orange and black polos first. Two
 * causes: "blue" knew nothing about navy or teal, and the store tags orange
 * polos "blue" as a campaign label. These are built from the real products'
 * shapes, tags included.
 */

function polo(title: string, extra: Partial<Product> = {}): Product {
  return {
    id: `gid://shopify/Product/${title}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    // The real store's tags, "blue" campaign label and all.
    tags: ['blue', 'POLO', 'polos', 'mens'],
    price: { amount: 24, currency: 'GBP' },
    options: [{ name: 'Size', values: ['S', 'M'] }],
    variants: [
      { id: `${title}-S`, title: 'S', available: true, price: { amount: 24, currency: 'GBP' }, options: { Size: 'S' } },
    ],
    description: 'Pairs well with navy trousers.',
    ...extra,
  };
}

const ORANGE = polo('PRIME PIQUE POLO - ORANGE', { price: { amount: 8, currency: 'GBP' } });
const BLACK = polo('HOPS N BARLEY POLO - BLACK');
const NAVY_WHITE = polo('VENTO POLO - NAVY/ WHITE');
const TEAL = polo('TECH DROP POLO - TEAL');
const WHITE = polo('ORIENT POLO - WHITE');
const TOUR = polo('TOUR POLO', {
  options: [
    { name: 'Size', values: ['S'] },
    { name: 'Colour', values: ['NAVY', 'SAGE'] },
  ],
  variants: [
    { id: 'tour-navy', title: 'S / NAVY', available: false, price: { amount: 30, currency: 'GBP' }, options: { Size: 'S', Colour: 'NAVY' } },
    { id: 'tour-sage', title: 'S / SAGE', available: true, price: { amount: 30, currency: 'GBP' }, options: { Size: 'S', Colour: 'SAGE' } },
  ],
});
const TROUSERS = polo('TECH TROUSER - BLACK', { tags: ['trousers', 'mens'] });

const titles = (products: Product[]) => products.map((p) => p.title);

describe('parseColours', () => {
  it('takes the colour out of the words', () => {
    const { colours, rest } = parseColours('blue polo');
    expect(colours.map((c) => c.word)).toEqual(['blue']);
    expect(rest).toBe('polo');
  });

  it('reads "navy blue" as navy, not as anything blue', () => {
    const { colours } = parseColours('navy blue polo');
    expect(colours.map((c) => c.word)).toEqual(['navy']);
  });

  it('drops "light" and "dark" along with the colour', () => {
    expect(parseColours('light blue polo').rest).toBe('polo');
  });

  it('leaves a query with no colour alone', () => {
    expect(parseColours('golf polo').colours).toEqual([]);
  });
});

describe('colourMatch', () => {
  const blue = parseColours('blue').colours;

  it('ignores the "blue" campaign tag on an orange polo', () => {
    expect(colourMatch(ORANGE, blue)).toBe(0);
  });

  it('ignores colours mentioned in the description', () => {
    expect(colourMatch(WHITE, parseColours('navy').colours)).toBe(0);
  });

  it('counts navy and teal as blue, the exact word above the family', () => {
    expect(colourMatch(NAVY_WHITE, blue)).toBe(1);
    expect(colourMatch(TEAL, blue)).toBe(1);
    expect(colourMatch(NAVY_WHITE, parseColours('navy').colours)).toBe(2);
  });

  it('does not count teal as navy', () => {
    expect(colourMatch(TEAL, parseColours('navy').colours)).toBe(0);
  });

  it('reads a Colour option, but only while that colour is in stock', () => {
    expect(colourMatch(TOUR, parseColours('sage').colours)).toBe(3);
    // The navy variant is sold out: offering it is the same mistake as offering orange.
    expect(colourMatch(TOUR, parseColours('navy').colours)).toBe(0);
  });
});

describe('searchLocal with a colour', () => {
  setCatalogueForTests([ORANGE, BLACK, NAVY_WHITE, TEAL, WHITE, TOUR, TROUSERS]);

  it('never returns a polo in another colour for "blue polo"', () => {
    const found = titles(searchLocal({ query: 'blue polo' }));
    expect(found).not.toContain('PRIME PIQUE POLO - ORANGE');
    expect(found).not.toContain('HOPS N BARLEY POLO - BLACK');
    expect(found.sort()).toEqual(['TECH DROP POLO - TEAL', 'VENTO POLO - NAVY/ WHITE']);
  });

  it('puts the exact shade first', () => {
    setCatalogueForTests([TEAL, NAVY_WHITE, ORANGE]);
    expect(titles(searchLocal({ query: 'navy polo' }))).toEqual(['VENTO POLO - NAVY/ WHITE']);
    setCatalogueForTests([ORANGE, BLACK, NAVY_WHITE, TEAL, WHITE, TOUR, TROUSERS]);
  });

  it('returns nothing rather than the wrong colour', () => {
    expect(searchLocal({ query: 'pink polo' })).toEqual([]);
  });

  it('finds by colour alone', () => {
    expect(titles(searchLocal({ query: 'something black' })).sort()).toEqual([
      'HOPS N BARLEY POLO - BLACK',
      'TECH TROUSER - BLACK',
    ]);
  });

  it('still searches normally with no colour named', () => {
    expect(searchLocal({ query: 'polo' }).length).toBe(6);
  });
});

describe('coloursOffered', () => {
  it('names the colourways actually in stock', () => {
    expect(coloursOffered([ORANGE, NAVY_WHITE, TOUR])).toEqual(['ORANGE', 'NAVY/ WHITE', 'SAGE']);
  });
});

describe('plain', () => {
  // Asked to swap for "a plain white polo", the customer was moved into WHITE/ ORANGE.
  const WHITE_ORANGE = polo('VENTO POLO - WHITE/ ORANGE');

  it('scores only-that-colour above that colour in a mix', () => {
    const white = parseColours('white').colours;
    expect(colourMatch(WHITE, white)).toBe(3);
    expect(colourMatch(WHITE_ORANGE, white)).toBe(2);
  });

  it('reads "plain" and "solid" and keeps them out of the words', () => {
    expect(parseColours('plain white polo')).toMatchObject({ plain: true, rest: 'polo' });
    expect(parseColours('solid navy polo').plain).toBe(true);
    expect(parseColours('white polo').plain).toBe(false);
  });

  it('never returns a two-colour polo for "plain white"', () => {
    setCatalogueForTests([WHITE_ORANGE, WHITE, NAVY_WHITE, ORANGE]);
    expect(titles(searchLocal({ query: 'plain white polo' }))).toEqual(['ORIENT POLO - WHITE']);
  });

  it('ranks the plain one first even when "plain" was not said', () => {
    setCatalogueForTests([WHITE_ORANGE, NAVY_WHITE, WHITE]);
    expect(titles(searchLocal({ query: 'white polo' }))[0]).toBe('ORIENT POLO - WHITE');
  });

  it('with no colour, "plain" means one colour', () => {
    setCatalogueForTests([WHITE_ORANGE, NAVY_WHITE, WHITE, ORANGE]);
    expect(titles(searchLocal({ query: 'plain polo' })).sort()).toEqual(['ORIENT POLO - WHITE', 'PRIME PIQUE POLO - ORANGE']);
  });
});

describe('ranges on the live store', () => {
  // "navy polo" on the live Druids store came back four kids polos out of six.
  const KIDS = polo('KIDS BAND POLO - NAVY', { productType: 'KIDS POLOS' });
  const LADIES = polo('LADIES ELITE POLO - NAVY', { productType: 'POLOS' });
  const MENS = polo('HORIZON POLO - NAVY', { productType: 'POLOS' });
  const STRIPE = polo('STRIPE PERFORMANCE POLO - WHITE');

  it('never shows kids unless asked', () => {
    setCatalogueForTests([KIDS, LADIES, MENS]);
    expect(titles(searchLocal({ query: 'navy polo' })).sort()).toEqual(['HORIZON POLO - NAVY', 'LADIES ELITE POLO - NAVY']);
    expect(titles(searchLocal({ query: 'kids navy polo' }))).toEqual(['KIDS BAND POLO - NAVY']);
  });

  it('keeps to the range asked for, or already known', () => {
    setCatalogueForTests([KIDS, LADIES, MENS]);
    expect(titles(searchLocal({ query: 'womens navy polo' }))).toEqual(['LADIES ELITE POLO - NAVY']);
    expect(titles(searchLocal({ query: 'navy polo', known: 'men' }))).toEqual(['HORIZON POLO - NAVY']);
  });

  it('does not call a striped polo plain', () => {
    setCatalogueForTests([STRIPE, WHITE]);
    expect(titles(searchLocal({ query: 'plain white polo' }))).toEqual(['ORIENT POLO - WHITE']);
  });
});

describe('the live catalogue vocabulary', () => {
  // Checked against every colourway word on the live store: these were the colours it did not know.
  it('knows mulberry, petal, tiffany and the store shorthand blk', () => {
    expect(colourMatch(polo('VENTO POLO - MULBERRY/WHITE'), parseColours('pink').colours)).toBeGreaterThan(0);
    expect(colourMatch(polo('VENTO POLO - MULBERRY/WHITE'), parseColours('purple').colours)).toBeGreaterThan(0);
    expect(colourMatch(polo('LADIES POLO - PETAL'), parseColours('pink').colours)).toBeGreaterThan(0);
    expect(colourMatch(polo('CAP - TIFFANY'), parseColours('blue').colours)).toBeGreaterThan(0);
    expect(colourMatch(polo('BELT - BLK'), parseColours('black').colours)).toBe(3);
  });
});
