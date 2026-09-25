import { describe, expect, it } from 'vitest';
import { normaliseSize, sameSize, stockedInSize, optionValueMatches } from '../src/recommend/sizeWords.js';

function variant(size: string, available = true) {
  return { available, options: { Size: size } };
}

describe('reading a size the way a person says it', () => {
  it('maps the words customers and the model actually use', () => {
    expect(normaliseSize('Medium')).toBe('M');
    expect(normaliseSize('medium')).toBe('M');
    expect(normaliseSize('M')).toBe('M');
    expect(normaliseSize('Large')).toBe('L');
    expect(normaliseSize('extra large')).toBe('XL');
    expect(normaliseSize('x-large')).toBe('XL');
    expect(normaliseSize('XXL')).toBe('2XL');
    expect(normaliseSize('2xl')).toBe('2XL');
  });

  it('leaves a waist size alone, because that is already the catalogue code', () => {
    expect(normaliseSize('32')).toBe('32');
    expect(normaliseSize('34')).toBe('34');
  });

  /* Null means "could not tell", not "no match" - callers must not filter on it. */
  it('returns null rather than guessing at something it does not know', () => {
    expect(normaliseSize('whatever fits')).toBeNull();
    expect(normaliseSize('')).toBeNull();
    expect(normaliseSize(undefined)).toBeNull();
  });

  it('treats the word and the code as the same size', () => {
    expect(sameSize('M', 'Medium')).toBe(true);
    expect(sameSize('Medium', 'M')).toBe(true);
    expect(sameSize('L', 'M')).toBe(false);
  });
});

describe('whether a product is stocked in a size', () => {
  it('does not filter when no size was asked for', () => {
    expect(stockedInSize([variant('S'), variant('M')])).toBe(true);
  });

  it('does not filter a search result that carries no variants yet', () => {
    expect(stockedInSize([], 'M')).toBe(true);
  });

  /*
   * "Medium" never equalled "M", so every product was dropped, every outfit
   * slot came back empty, and the customer was told nothing was in stock
   * while the whole range was available.
   */
  it('matches a word size against the catalogue code', () => {
    expect(stockedInSize([variant('M')], 'Medium')).toBe(true);
    expect(stockedInSize([variant('M')], 'medium')).toBe(true);
  });

  it('still excludes a size the product genuinely does not stock', () => {
    expect(stockedInSize([variant('S'), variant('M')], 'XL')).toBe(false);
  });

  it('excludes a size that is listed but sold out', () => {
    expect(stockedInSize([variant('M', false)], 'M')).toBe(false);
  });

  /*
   * Tops are sized by letter and trousers by waist. Asking for a medium used
   * to drop every pair of trousers, so an outfit came back with nothing to
   * wear below the waist.
   */
  it('does not exclude a product sized on a different scale', () => {
    const trousers = [variant('32'), variant('34')];
    expect(stockedInSize(trousers, 'M')).toBe(true);
    expect(stockedInSize(trousers, 'Medium')).toBe(true);
  });

  it('still applies a waist size to waist-sized products', () => {
    const trousers = [variant('32'), variant('34')];
    expect(stockedInSize(trousers, '32')).toBe(true);
    expect(stockedInSize(trousers, '40')).toBe(false);
  });

  it('ignores a size it cannot read rather than emptying the result', () => {
    expect(stockedInSize([variant('S'), variant('M')], 'whatever fits')).toBe(true);
  });
});

describe('optionValueMatches', () => {
  // On the live store "medium" was read as no size at all, and the belt's
  // combined sizes as neither - sizes on the shelf reported out of stock.
  it('reads size words as the store writes them', () => {
    expect(optionValueMatches('M', 'medium')).toBe(true);
    expect(optionValueMatches('L', 'Large')).toBe(true);
    expect(optionValueMatches('XL', 'extra large')).toBe(true);
    expect(optionValueMatches('32', '32')).toBe(true);
  });

  it('matches half of a combined size', () => {
    expect(optionValueMatches('M/L', 'medium')).toBe(true);
    expect(optionValueMatches('L/XL', 'large')).toBe(true);
    expect(optionValueMatches('M/L', 'large')).toBe(true);
    expect(optionValueMatches('L/XL', 'medium')).toBe(false);
  });

  it('does not match a different size', () => {
    expect(optionValueMatches('M', 'large')).toBe(false);
    expect(optionValueMatches('30', '32')).toBe(false);
  });
});
