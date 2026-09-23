import { describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { DEFAULT_SLOTS, fitsSlot } from '../src/recommend/outfit.js';

/**
 * The catalogue search is semantic, so a search for "shorts trousers navy"
 * will happily return a navy polo first. These lock in the check that stopped
 * an outfit wearing the same polo as both its top and its bottom.
 */

function product(title: string, tags: string[] = []): Product {
  return {
    id: `gid://shopify/Product/${title}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags,
    price: { amount: 42, currency: 'GBP' },
    options: [],
    variants: [],
    description: null,
  };
}

const slot = (name: string) => DEFAULT_SLOTS.find((s) => s.slot === name)!;

describe('fitsSlot', () => {
  it('keeps a polo out of the bottom slot', () => {
    expect(fitsSlot(product('VENTO POLO - NAVY/ WHITE'), slot('bottom'))).toBe(false);
  });

  it('accepts real bottoms', () => {
    expect(fitsSlot(product('TOUR SHORT - NAVY'), slot('bottom'))).toBe(true);
    expect(fitsSlot(product('TECH TROUSER - BLACK'), slot('bottom'))).toBe(true);
  });

  it('accepts a polo as a top', () => {
    expect(fitsSlot(product('VENTO POLO - NAVY/ WHITE'), slot('top'))).toBe(true);
  });

  it('does not treat a gilet as a top', () => {
    expect(fitsSlot(product('APOLLO GILET - NAVY'), slot('top'))).toBe(false);
    expect(fitsSlot(product('APOLLO GILET - NAVY'), slot('layer'))).toBe(true);
  });

  it('matches on tags when the title does not say it', () => {
    expect(fitsSlot(product('DRUIDS ESSENTIALS 2.0', ['shorts', 'mens']), slot('bottom'))).toBe(true);
  });

  it('places accessories', () => {
    expect(fitsSlot(product('PERFORMANCE SOCKS - WHITE'), slot('accessory'))).toBe(true);
    expect(fitsSlot(product('TOUR BEANIE - BLACK'), slot('accessory'))).toBe(true);
  });

  it('every default slot has keywords, or it would accept anything', () => {
    for (const entry of DEFAULT_SLOTS) {
      expect(entry.keywords.length).toBeGreaterThan(0);
    }
  });
});
