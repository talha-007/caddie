import { describe, expect, it, beforeEach } from 'vitest';
import type { Product } from '@caddie/shared';
import { applyChanges, productById, productForInventoryItem, removeProduct, setCatalogueForTests } from '../src/catalog/sync.js';
import { searchLocal } from '../src/catalog/search.js';

/**
 * The mirror is what every customer-facing search reads, so these cover the
 * two things that would be invisible until a customer saw them: a change not
 * landing, and search returning something nobody asked for.
 */

function product(id: string, title: string, over: Partial<Product> = {}): Product {
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [],
    price: { amount: 42, currency: 'GBP' },
    options: [{ name: 'Size', values: ['S', 'M'] }],
    variants: [
      { id: `gid://shopify/ProductVariant/${id}-1`, title: 'S', available: true, price: { amount: 42, currency: 'GBP' }, options: { Size: 'S' }, inventoryItemId: `gid://shopify/InventoryItem/${id}` },
    ],
    description: null,
    ...over,
  };
}

describe('the catalogue mirror', () => {
  beforeEach(() => {
    setCatalogueForTests([
      product('1', 'VENTO POLO - NAVY/ WHITE', { productType: 'POLOS', tags: ['navy', 'mens'] }),
      product('2', 'TOUR SHORT - NAVY', { productType: 'SHORTS', tags: ['navy', 'mens'], price: { amount: 42, currency: 'GBP' } }),
      product('3', 'PERFORMANCE SOCKS - WHITE', { productType: 'SOCKS', tags: ['white'], price: { amount: 16, currency: 'GBP' } }),
    ]);
  });

  it('patches a changed product without disturbing the rest', () => {
    const updated = product('2', 'TOUR SHORT - NAVY', { price: { amount: 19, currency: 'GBP' } });
    expect(applyChanges([updated])).toBe(1);

    expect(productById('gid://shopify/Product/2')?.price.amount).toBe(19);
    expect(productById('gid://shopify/Product/1')?.title).toBe('VENTO POLO - NAVY/ WHITE');
  });

  it('adds a product it has not seen before', () => {
    applyChanges([product('9', 'TOUR CAP - WHITE')]);
    expect(productById('gid://shopify/Product/9')?.title).toBe('TOUR CAP - WHITE');
  });

  it('drops a deleted product so it stops being recommended', () => {
    expect(removeProduct('gid://shopify/Product/3')).toBe(true);
    expect(productById('gid://shopify/Product/3')).toBeNull();
    expect(searchLocal({ query: 'socks' })).toHaveLength(0);
  });

  it('finds the product behind an inventory item, for stock webhooks', () => {
    expect(productForInventoryItem('gid://shopify/InventoryItem/2')).toBe('gid://shopify/Product/2');
    expect(productForInventoryItem('gid://shopify/InventoryItem/nope')).toBeNull();
  });

  it('keeps the inventory index in step after a patch', () => {
    applyChanges([
      product('2', 'TOUR SHORT - NAVY', {
        variants: [
          { id: 'v-new', title: 'M', available: true, price: { amount: 42, currency: 'GBP' }, options: { Size: 'M' }, inventoryItemId: 'gid://shopify/InventoryItem/moved' },
        ],
      }),
    ]);
    expect(productForInventoryItem('gid://shopify/InventoryItem/moved')).toBe('gid://shopify/Product/2');
    expect(productForInventoryItem('gid://shopify/InventoryItem/2')).toBeNull();
  });
});

describe('local search', () => {
  beforeEach(() => {
    setCatalogueForTests([
      product('1', 'VENTO POLO - NAVY/ WHITE', { productType: 'POLOS', tags: ['navy', 'mens'] }),
      product('2', 'TOUR SHORT - NAVY', { productType: 'SHORTS', tags: ['navy', 'mens'] }),
      product('3', 'PERFORMANCE SOCKS - WHITE', { productType: 'SOCKS', tags: ['white'], price: { amount: 16, currency: 'GBP' } }),
    ]);
  });

  it('puts the best match first', () => {
    const hits = searchLocal({ query: 'navy polo' });
    expect(hits[0]?.title).toBe('VENTO POLO - NAVY/ WHITE');
  });

  it('matches the product type, not just the name', () => {
    expect(searchLocal({ query: 'shorts' })[0]?.title).toBe('TOUR SHORT - NAVY');
  });

  it('returns nothing when we do not stock it, rather than the nearest thing', () => {
    // This is the whole point of replacing semantic search: it always returned
    // something, which is how the Caddie ended up offering jackets for a
    // product we do not sell.
    expect(searchLocal({ query: 'umbrella' })).toHaveLength(0);
  });

  it('respects a budget', () => {
    const hits = searchLocal({ query: 'navy', maxPrice: 20 });
    expect(hits).toHaveLength(0);
    expect(searchLocal({ query: 'socks', maxPrice: 20 })).toHaveLength(1);
  });

  it('hides anything with nothing in stock', () => {
    applyChanges([
      product('2', 'TOUR SHORT - NAVY', {
        variants: [{ id: 'v', title: 'S', available: false, price: { amount: 42, currency: 'GBP' }, options: { Size: 'S' } }],
      }),
    ]);
    expect(searchLocal({ query: 'tour short' })).toHaveLength(0);
  });
});
