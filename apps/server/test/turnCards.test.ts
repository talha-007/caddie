import { describe, expect, it } from 'vitest';
import type { CaddieAttachment, Product } from '@caddie/shared';
import { cardWeight } from '../src/ai/openai.js';
import { productByTitle, setCatalogueForTests } from '../src/catalog/sync.js';

/**
 * A turn shows one card. The model built an outfit and then asked the size
 * tool "mens or womens?" in the same turn, and the size tool's empty card
 * replaced the outfit - the customer never saw what they asked for.
 */

const outfit = { kind: 'outfit', recommendation: { pieces: [], total: { amount: 0, currency: 'GBP' }, reason: '' } } as CaddieAttachment;
const asking = { kind: 'size', recommendation: { size: null } } as unknown as CaddieAttachment;
const sized = { kind: 'size', recommendation: { size: 'M' } } as unknown as CaddieAttachment;
const products = { kind: 'products', products: [] } as CaddieAttachment;
const cart = { kind: 'cart', cart: {} } as unknown as CaddieAttachment;

describe('cardWeight', () => {
  it('never lets a size question hide the outfit', () => {
    expect(cardWeight(asking, false)).toBeLessThan(cardWeight(outfit, false));
    expect(cardWeight(sized, false)).toBeLessThan(cardWeight(outfit, false));
  });

  it('puts a basket that just changed above everything', () => {
    expect(cardWeight(cart, true)).toBeGreaterThan(cardWeight(outfit, false));
    expect(cardWeight(cart, true)).toBeGreaterThan(cardWeight(products, false));
  });

  it('treats reading the basket like any other answer', () => {
    expect(cardWeight(cart, false)).toBe(cardWeight(products, false));
  });
});

describe('productByTitle', () => {
  const product = (id: string, title: string): Product => ({
    id,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [],
    price: { amount: 22, currency: 'GBP' },
    options: [],
    variants: [],
    description: null,
  });
  const vento = product('gid://shopify/Product/1', 'VENTO POLO - NAVY/ WHITE');
  const orient = product('gid://shopify/Product/2', 'ORIENT POLO - WHITE');

  it('finds a product the model named instead of giving its id', () => {
    setCatalogueForTests([vento, orient]);
    expect(productByTitle('Vento Polo - Navy/White')?.id).toBe('gid://shopify/Product/1');
  });

  it('never settles for a near miss', () => {
    setCatalogueForTests([vento, orient]);
    expect(productByTitle('VENTO POLO - NAVY')).toBeNull();
    expect(productByTitle('')).toBeNull();
  });
});
