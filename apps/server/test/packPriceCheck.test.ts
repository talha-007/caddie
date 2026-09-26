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
    // The price they pay, once - not the listed one it is less than.
    expect(result.speech).toBe('Adding the AMBASSADOR PACK - mixed-cheap to your basket for £120.');
    expect(result.speech).not.toContain('£129.99');
  });
});

/*
 * "Cool & Wet is £159.99", then a card at £156: these pieces cost less on
 * their own, and checkout charges that. What is said is what they will pay.
 */
describe('what is said about the price', () => {
  beforeEach(() => setCatalogueForTests([polo('1'), polo('2')]));

  async function show(handle: string) {
    const id = `said-${Math.random()}`;
    await sessions.patch(id, { cartMode: 'theme' });
    const shown = await runTool('recommend_pack', { query: 'ambassador pack mixed conditions' }, { session: await sessions.getOrCreate(id), utterance: 'the mixed conditions one' });
    const added = await runTool('add_pack_to_cart', { size: 'M', pack: `ambassador pack ${handle}` }, { session: await sessions.getOrCreate(id), utterance: 'add it in medium' });
    const card = shown.attachment?.kind === 'pack' ? shown.attachment.recommendation.total.amount : NaN;
    return { shown, added, card };
  }

  it('listed above what the pieces cost: the setup price is said, never the listed one, and no saving', async () => {
    setDealsForTests([pack('mixed-cheap', 129.99)]);
    checkoutPrice = 999;
    const { shown, added, card } = await show('mixed-cheap');
    expect(shown.speech).toMatch(/^This Mixed Conditions setup comes to £120\./);
    expect(shown.speech).not.toContain('129.99');
    expect(shown.facts).toContain('Pack price: pays £120; listed £129.99; saving none.');
    expect(shown.facts).toContain('The pack is listed at £129.99, but these selected pieces total £120, so £120 is what you would pay.');
    // Spoken, on the card and in the basket: one figure.
    expect(card).toBe(120);
    expect(added.speech).toBe('Adding the AMBASSADOR PACK - mixed-cheap to your basket for £120.');
  });

  it('listed at exactly what the pieces cost: that price, and no saving', async () => {
    setDealsForTests([pack('mixed-even', 120)]);
    checkoutPrice = 120;
    const { shown, added, card } = await show('mixed-even');
    expect(shown.speech).toMatch(/is 2 pieces for £120\./);
    expect(shown.facts).toContain('Pack price: pays £120; listed £120; saving none.');
    expect(card).toBe(120);
    expect(added.speech).toContain('for £120.');
  });

  it('listed below what the pieces cost: the pack price is what they pay, and the saving is real', async () => {
    setDealsForTests([pack('mixed-save', 99.99)]);
    checkoutPrice = 99.99;
    const { shown, added, card } = await show('mixed-save');
    expect(shown.speech).toMatch(/is 2 pieces for £99\.99\./);
    expect(shown.facts).toContain('Pack price: pays £99.99; listed £99.99; saving £20.01.');
    expect(card).toBe(99.99);
    expect(added.speech).toContain('for £99.99.');
  });

  it('the versions, before one is built: named without a price', async () => {
    setDealsForTests([
      { ...pack('warm', 99.99), condition: 'warm' as const, conditionTitle: 'WARM ROUNDS' },
      { ...pack('coolwet', 159.99), condition: 'coolwet' as const, conditionTitle: 'COOL & WET' },
    ]);
    const result = await runTool('recommend_pack', { query: 'ambassador pack' }, { session: await sessions.getOrCreate(`v-${Math.random()}`), utterance: 'show me your Ambassador Packs' });
    expect(result.speech).toMatch(/Warm Rounds/);
    expect(result.speech).not.toMatch(/£/);
    expect(result.facts ?? '').not.toMatch(/£/);
  });
});

describe('the reply check on a pack price', async () => {
  const { packPricing } = await import('../src/ai/verify.js');
  const cheaper = 'Pack price: pays £156; listed £159.99; saving none.';

  it('the listed price said as the price is caught', () => {
    expect(packPricing('The Cool & Wet pack is £159.99. What top size do you wear?', cheaper).map((v) => v.claim)).toEqual(['£159.99']);
  });

  it('the listed price explained once, beside what they pay, passes', () => {
    expect(packPricing('The pack is listed at £159.99, but these selected pieces total £156, so £156 is what you would pay.', cheaper)).toEqual([]);
  });

  it('a saving that is not there is caught', () => {
    expect(packPricing('This setup comes to £156, so you save £3.99.', cheaper).map((v) => v.claim)).toEqual(['you save']);
    expect(packPricing("It's a great deal at £156.", cheaper).map((v) => v.claim)).toEqual(['great deal']);
  });

  it('a saving that is there may be said', () => {
    expect(packPricing('The pack is £99.99, which saves you £20.01.', 'Pack price: pays £99.99; listed £99.99; saving £20.01.')).toEqual([]);
  });

  it('only the latest pack price counts', () => {
    expect(packPricing('It comes to £159.99.', `${cheaper}\nPack price: pays £159.99; listed £159.99; saving none.`)).toEqual([]);
  });
});

describe('a count that is a size', async () => {
  const { verifyReply } = await import('../src/ai/verify.js');
  it('"leg 34 for the trousers" is not thirty-four pairs', () => {
    const card = { kind: 'products' as const, products: [{ ...polo('9'), title: "MEN'S CLIMA GOLF TROUSERS - NAVY" }] };
    expect(verifyReply('Would you like 34 for the trousers?', '', card).filter((v) => v.kind === 'count')).toEqual([]);
    expect(verifyReply('I can do waist 34 trousers.', '', card).filter((v) => v.kind === 'count')).toEqual([]);
    expect(verifyReply('Here are six trousers.', '', card).filter((v) => v.kind === 'count').length).toBe(1);
  });
});

describe('a swap that changes the price', () => {
  it('says the new total when a swap moves it (£120 and £129.99, either way round)', async () => {
    const dearer = { ...polo('3'), price: { amount: 80, currency: 'GBP' }, variants: [{ ...polo('3').variants[0]!, price: { amount: 80, currency: 'GBP' } }] };
    setCatalogueForTests([polo('1'), polo('2'), dearer]);
    checkoutPrice = 129.99;
    const base = pack('mixed-swap', 129.99);
    setDealsForTests([{ ...base, steps: [{ ...base.steps[0]!, productIds: new Set(['gid://shopify/Product/1', 'gid://shopify/Product/3']) }, base.steps[1]!] }]);
    const id = `swap-${Math.random()}`;
    await sessions.patch(id, { cartMode: 'theme' });
    const first = await runTool('recommend_pack', { query: 'ambassador pack mixed conditions' }, { session: await sessions.getOrCreate(id), utterance: 'the mixed one' });
    expect(first.facts).not.toContain('This change takes it');
    const lead = first.attachment?.kind === 'pack' ? first.attachment.recommendation.items[0]!.id : '';
    const before = lead.endsWith('/3') ? '£129.99' : '£120';
    const after = lead.endsWith('/3') ? '£120' : '£129.99';
    const swapped = await runTool('recommend_pack', { query: 'ambassador pack mixed conditions', swap: lead }, { session: await sessions.getOrCreate(id), utterance: 'change the first polo' });
    expect(swapped.facts).toContain(`This change takes it from ${before} to ${after} - say the new total, ${after}, in the reply.`);
  });
});
