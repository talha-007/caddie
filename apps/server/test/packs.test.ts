import { describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { findNamedPack, findUnstockedBundle, isPack, NAMED_PACKS, UNSTOCKED_BUNDLES } from '../src/recommend/packs.js';

function product(title: string, productType: string | null, tags: string[] = []): Product {
  return {
    id: `gid://shopify/Product/${title}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType,
    tags,
    price: { amount: 99, currency: 'GBP' },
    options: [],
    variants: [],
    description: null,
  };
}

/**
 * A pack is a product in the catalogue, so it comes back from ordinary
 * searches. Left unchecked it could be picked as a garment to go inside
 * another pack, or worn as the top half of an outfit.
 */
describe('telling a pack from a garment', () => {
  it('recognises one by product type', () => {
    expect(isPack(product('GOLF AMBASSADOR PACK', 'PACKS'))).toBe(true);
  });

  it('recognises one by tag, in case the type is ever set differently', () => {
    expect(isPack(product('RAINSUIT SPECIAL', null, ['druids-pack']))).toBe(true);
  });

  it('does not mistake a garment for one', () => {
    expect(isPack(product('VENTO POLO - NAVY/ WHITE', 'POLOS', ['mens']))).toBe(false);
    expect(isPack(product('TECH TROUSER - BLACK', 'TROUSERS'))).toBe(false);
  });

  /* "3 PACK SOCKS" is socks, not a pack. */
  it('does not go by the word in the title', () => {
    expect(isPack(product('PERFORMANCE SOCKS 3 PACK', 'SOCKS', ['mens']))).toBe(false);
  });
});

describe('recognising a pack the customer names', () => {
  it('finds the Ambassador Pack however it is referred to', () => {
    for (const phrase of [
      'the ambassador pack',
      'what is in the Ambassador Pack?',
      'tell me about the 6 for 99 deal',
      'GOLF AMBASSADOR PACK',
    ]) {
      expect(findNamedPack(phrase)?.product).toBe('GOLF AMBASSADOR PACK');
    }
  });

  it('finds the Rainsuit Special', () => {
    expect(findNamedPack('do you do a rainsuit?')?.product).toBe('RAINSUIT SPECIAL');
    expect(findNamedPack('rainsuit special')?.product).toBe('RAINSUIT SPECIAL');
  });

  /*
   * A budget request is not a named pack. Answering it with the Ambassador
   * Pack would quote £99 to someone who asked for something under £50.
   */
  it('does not match a plain budget request', () => {
    expect(findNamedPack('build me a pack under 100')).toBeNull();
    expect(findNamedPack('some kit for under fifty')).toBeNull();
    expect(findNamedPack(undefined)).toBeNull();
    expect(findNamedPack('')).toBeNull();
  });
});

describe('the packs we claim to sell', () => {
  /*
   * Druids sells twelve bundles. Only these two had a price published on a
   * page we could read, and a pack the Caddie cannot price is a pack it must
   * not offer.
   */
  it('is only the ones whose price came from Druids', () => {
    expect(NAMED_PACKS.map((pack) => pack.product)).toEqual(['GOLF AMBASSADOR PACK', 'RAINSUIT SPECIAL']);
  });

  it('gives the Ambassador Pack the six slots Druids advertises', () => {
    const ambassador = NAMED_PACKS[0]!;
    expect(ambassador.slots).toHaveLength(6);
    expect(ambassador.slots.map((slot) => slot.slot)).toEqual([
      'jacket',
      'midlayer',
      'polo',
      'trouser',
      'belt or cap',
      'socks',
    ]);
  });

  it('gives every slot something to search for and something to check against', () => {
    for (const pack of NAMED_PACKS) {
      for (const slot of pack.slots) {
        expect(slot.terms.trim()).not.toBe('');
        expect(slot.keywords.length).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * Druids sells twelve bundles and this store carries two. The other ten still
 * get asked about, and the budget assembler used to answer: "the Prestige Pack
 * includes three items and costs £92" - a pack that is not in the store, at a
 * price that is not its own. Knowing the names is what lets us decline.
 */
describe('bundles Druids sells that we cannot price', () => {
  it('recognises the mens ones', () => {
    expect(findUnstockedBundle('what is in the prestige pack?')?.name).toBe('Prestige Pack');
    expect(findUnstockedBundle('tell me about the players bundle')?.name).toBe('Players Bundle');
    expect(findUnstockedBundle('do you do any 3 polos?')?.name).toBe('Any 3 Polos');
  });

  /*
   * "ladies ambassador pack" contains "ambassador", which is an alias of the
   * mens pack. Matched the wrong way round, a woman asking about her pack is
   * quoted the mens one at £99 - the wrong range and a price that is not hers.
   */
  it('does not let a ladies or kids pack be answered with the mens one', () => {
    expect(findUnstockedBundle('how much is the ladies ambassador pack?')?.name).toBe(
      'Ladies Ambassador Pack',
    );
    expect(findUnstockedBundle('the kids ambassador pack')?.name).toBe('Kids Ambassador Pack');
    expect(findUnstockedBundle('ladies rainsuit')?.name).toBe('Ladies Rainsuit Special');
  });

  it('leaves the two we do stock alone', () => {
    expect(findUnstockedBundle('the ambassador pack')).toBeNull();
    expect(findUnstockedBundle('rainsuit special')).toBeNull();
  });

  it('does not fire on an ordinary budget request', () => {
    expect(findUnstockedBundle('build me a pack under 100')).toBeNull();
    expect(findUnstockedBundle(undefined)).toBeNull();
  });

  /* Every name we decline must be one we could later build. */
  it('never overlaps with the packs we do build', () => {
    for (const bundle of UNSTOCKED_BUNDLES) {
      expect(findNamedPack(bundle.name.toLowerCase())).toBeNull();
    }
  });
});
