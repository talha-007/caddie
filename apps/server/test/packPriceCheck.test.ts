import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@caddie/shared';

/**
 * A condition pack is added only when checkout has been seen to charge its
 * pack price. The Mixed Conditions and Cool & Wet packs went into a test cart
 * at the sum of their pieces: the discount had not been told their triggers.
 */

let checkoutPrice = 0;
vi.mock('../src/shopify/storefrontCart.js', async (original) => ({
  ...(await original<typeof import('../src/shopify/storefrontCart.js')>()),
  storefrontCartEnabled: () => true,
  checkoutTotal: vi.fn(async () => checkoutPrice),
}));

const { setCatalogueForTests } = await import('../src/catalog/sync.js');
const { setDealsForTests } = await import('../src/catalog/bundles.js');
const { sessions } = await import('../src/session/store.js');
const { runTool } = await import('../src/tools/index.js');
const { env } = await import('../src/env.js');

const polo = (id: string): Product => ({
  id: `gid://shopify/Product/${id}`,
  title: `POLO ${id}`,
  url: `https://x/products/polo-${id}`,
  imageUrl: null,
  vendor: 'Druids',
  productType: 'POLOS',
  tags: [env.shopify.brandTag].filter(Boolean) as string[],
  price: { amount: 60, currency: 'GBP' },
  options: [{ name: 'Size', values: ['M'] }],
  variants: [{ id: `gid://shopify/ProductVariant/${id}1`, title: 'M', available: true, price: { amount: 60, currency: 'GBP' }, options: { Size: 'M' } }],
  description: null,
});

const pack = (handle: string, price: number) => ({
  handle,
  title: `AMBASSADOR PACK - ${handle}`,
  range: 'men' as const,
  prices: { GBP: price },
  dynamicPrices: false,
  steps: [
    { title: 'Polo 1', collection: 'p', productIds: new Set(['gid://shopify/Product/1']) },
    { title: 'Polo 2', collection: 'p', productIds: new Set(['gid://shopify/Product/2']) },
  ],
  url: 'https://x/pages/pack',
  format: 'plus' as const,
  trigger: { '__amb-mens-condition': handle },
  condition: 'mixed' as const,
  conditionTitle: 'MIXED CONDITIONS',
});

async function addPack(handle: string) {
  const id = `price-${Math.random()}`;
  await sessions.patch(id, { cartMode: 'theme' });
  let session = await sessions.getOrCreate(id);
  await runTool('recommend_pack', { query: 'ambassador pack mixed conditions' }, { session });
  session = await sessions.getOrCreate(id);
  return runTool('add_pack_to_cart', { size: 'M', pack: `ambassador pack ${handle}` }, { session, utterance: 'add it in medium' });
}

describe('a condition pack only goes in at its pack price', () => {
  beforeEach(() => setCatalogueForTests([polo('1'), polo('2')]));

  it('is added when checkout charges the pack price', async () => {
    setDealsForTests([pack('mixed-ok', 99.99)]);
    checkoutPrice = 99.99;
    const result = await addPack('mixed-ok');
    expect(result.actions?.[0]?.type).toBe('add-bundle');
  });

  it('is refused, and says so, when checkout charges something else', async () => {
    // Two £60 pieces for a £110 pack: checkout should say £110, and says £120.
    setDealsForTests([pack('mixed-wrong', 110)]);
    checkoutPrice = 120;
    const result = await addPack('mixed-wrong');
    expect(result.actions).toBeUndefined();
    expect(result.speech).toMatch(/can't add/);
    expect(result.facts).toContain('Nothing was added');
  });

  it('goes in at the pieces\' own total when that is under the pack price - and says so', async () => {
    // Two £60 pieces for a £129.99 pack: a discount never raises a price, so they pay £120.
    setDealsForTests([pack('mixed-cheap', 129.99)]);
    checkoutPrice = 999; // never asked: nothing can charge more than the pieces cost
    const result = await addPack('mixed-cheap');
    expect(result.actions?.[0]?.type).toBe('add-bundle');
    expect(result.speech).toContain('£120.00');
    expect(result.speech).toContain('less than the £129.99 pack price');
  });
});
