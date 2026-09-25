import { describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { DEFAULT_SLOTS, fitsSlot, recommendOutfit, slotsFor } from '../src/recommend/outfit.js';

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

describe('slotsFor', () => {
  const names = (seed: string, pieces?: string[]) => slotsFor(seed, pieces).map((s) => s.slot);

  it('builds only the garments the customer named', () => {
    // "polos and trousers" came back with a hoodie and socks as well.
    expect(names('golf club match, polos and trousers')).toEqual(['top', 'bottom']);
  });

  it('keeps a named kind within its slot - trousers are not shorts', () => {
    const bottom = slotsFor('polos and trousers').find((s) => s.slot === 'bottom')!;
    expect(fitsSlot(product('TECH TROUSER - BLACK'), bottom)).toBe(true);
    expect(fitsSlot(product('TOUR SHORT - NAVY'), bottom)).toBe(false);
  });

  it('gives the full look when nothing is named', () => {
    expect(names('a club match next week')).toEqual(['top', 'bottom', 'layer', 'accessory']);
  });

  it('follows the pieces the model passes', () => {
    expect(names('club match', ['top', 'bottom'])).toEqual(['top', 'bottom']);
  });

  it('does not read "tee time" as a request for tees', () => {
    expect(names('outfit for my tee time')).toEqual(['top', 'bottom', 'layer', 'accessory']);
    const top = slotsFor('polo for my tee time', ['top']).find((s) => s.slot === 'top')!;
    expect(top.keywords).toEqual(['polo']);
  });

  it('does not see shorts in "shortly"', () => {
    expect(names('I am playing shortly')).toEqual(['top', 'bottom', 'layer', 'accessory']);
  });
});

describe('recommendOutfit swapping one piece', () => {
  // Stocked and tagged like the real catalogue, or search leaves them out.
  const stocked = (title: string): Product => ({
    ...product(title, [env.shopify.brandTag].filter(Boolean)),
    variants: [{ id: `gid://shopify/ProductVariant/${title}`, title: 'S', available: true, price: { amount: 42, currency: 'GBP' }, options: { Size: 'S' } }],
  });
  const polo = stocked('GOLF TEE POLO - PURPLE');
  const otherPolo = stocked('ORIENT POLO - WHITE');
  const trousers = stocked('TECH TROUSER - BLACK');

  it('replaces only the swapped piece and never offers it again', async () => {
    setCatalogueForTests([polo, otherPolo, trousers]);
    const result = await recommendOutfit({ seed: 'polos and trousers' }, slotsFor('polos and trousers'), {
      keep: [{ slot: 'bottom', product: trousers }],
      exclude: [polo.id],
    });
    expect(result.pieces.map((p) => p.product.title)).toEqual(['ORIENT POLO - WHITE', 'TECH TROUSER - BLACK']);
  });

  it('leaves the slot empty rather than bring the same piece back', async () => {
    setCatalogueForTests([polo, trousers]);
    const result = await recommendOutfit({ seed: 'polos and trousers' }, slotsFor('polos and trousers'), {
      keep: [{ slot: 'bottom', product: trousers }],
      exclude: [polo.id],
    });
    expect(result.pieces.map((p) => p.product.title)).toEqual(['TECH TROUSER - BLACK']);
  });
});

describe('slotsFor with the customer\'s own words', () => {
  it('narrows to trousers when only the customer said so', () => {
    // The model passed pieces and the seed "navy outfit"; the customer said trousers.
    const bottom = slotsFor('navy outfit', ['top', 'bottom'], 'Build me a navy outfit, polos and trousers').find(
      (s) => s.slot === 'bottom',
    )!;
    expect(fitsSlot(product('TOUR SHORT - NAVY'), bottom)).toBe(false);
    expect(fitsSlot(product('TECH TROUSER - BLACK'), bottom)).toBe(true);
  });

  it('never adds a slot the model did not choose', () => {
    const chosen = slotsFor('navy outfit', ['top'], 'polos, I already have trousers').map((s) => s.slot);
    expect(chosen).toEqual(['top']);
  });
});
