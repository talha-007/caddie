import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BasketSync, CartAction, Product, SmartCartSuggestResponse } from '@caddie/shared';

/**
 * Smart Cart, acting: where the copied theme turned the preview on, a Caddie
 * add of a qualifying product carries the offer's trigger - by the theme's own
 * rule, never the product's name - and the cart's read-back is judged against
 * that stamped line. And a nudge is shown only when the offer would lower the
 * price at all: most Druids stock is already reduced below the deal.
 */

const { ownerHeaders } = await import('./support/ownership.js');
const { env } = await import('../src/env.js');
const { resetLimits } = await import('../src/lib/rateLimit.js');
const { sessionRouter } = await import('../src/routes/session.js');
const { sessions } = await import('../src/session/store.js');
const { setCatalogueForTests } = await import('../src/catalog/sync.js');
const { setDealsForTests } = await import('../src/catalog/bundles.js');
const { SMART_CART_OFFERS, evaluateSmartCart, offerForProduct, offerValue, setSmartCartCollectionsForTests, triggerPropertiesFor } = await import('../src/smartCart/index.js');
const { judge } = await import('../src/tools/cartOperations.js');
const { CART_OPS_CONTRACT, SMART_CART_HEADER, SMART_CART_PREVIEW } = await import('@caddie/shared');

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
function product(id: string, title: string, type: string, sizes: string[], price: number, tags: string[] = [], soldOut: string[] = []): Product {
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND, ...tags],
    price: { amount: price, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size, i) => ({ id: `gid://shopify/ProductVariant/${id}${i}`, title: size, available: !soldOut.includes(size), price: { amount: price, currency: 'GBP' }, options: { Size: size } })),
    description: null,
  };
}
// Real Druids sale prices (Phase 4): most stock is already below the deal.
const FLORAL = product('71', 'FLORAL PANEL POLO - NAVY', 'POLOS', ['M', 'L'], 24, ['bundle_threepolo']); // 710 M, 711 L
const FLORAL_SAGE = product('72', 'FLORAL PANEL POLO - SAGE', 'POLOS', ['M', 'L'], 10, ['bundle_threepolo']); // 720, 721
const EMOTIVE = product('73', 'ABSTRACT EMOTIVE POLO - BLACK', 'POLOS', ['M', 'L'], 24, ['Bundle_ThreePolo']); // 730, 731 - tag case differs
const LADIES = product('74', 'LADIES POLO - PINK', 'POLOS', ['M'], 24, ['bundle_threepolo_ladies']); // 740
const CLIMA = product('75', "MEN'S CLIMA GOLF TROUSERS - BLACK", 'TROUSERS', ['32', '34'], 30); // 750, 751
const JOGGER = product('76', 'LUXE GOLF JOGGERS - BLACK', 'JOGGERS', ['32', '34'], 20); // 760, 761
const COMFORT = product('77', 'COMFORT SHORTS - BLACK', 'SHORTS', ['32'], 26); // 770
const JACKET = product('78', 'STORM JACKET - BLACK', 'JACKETS', ['M'], 60); // 780
const TRIGGER_POLO_NAMED = product('79', 'THREE POLO BUNDLE STYLE POLO', 'POLOS', ['M'], 30); // untagged, "bundle" in its name
const ALL = [FLORAL, FLORAL_SAGE, EMOTIVE, LADIES, CLIMA, JOGGER, COMFORT, JACKET, TRIGGER_POLO_NAMED];
const POLO_OFFER = SMART_CART_OFFERS.find((offer) => offer.id === 'any-3-polos')!;
const TROUSER_OFFER = SMART_CART_OFFERS.find((offer) => offer.id === 'any-2-mens-trousers')!;

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/session', sessionRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

let id = '';
beforeEach(async () => {
  setCatalogueForTests(ALL);
  setDealsForTests([]);
  setSmartCartCollectionsForTests({ 'men-golf-trousers': [CLIMA.id, JOGGER.id], 'men-golf-shorts': [COMFORT.id] });
  resetLimits();
  id = `stamp-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: CART_OPS_CONTRACT });
});

const headers = async (preview: boolean) => ({
  'Content-Type': 'application/json',
  'x-caddie-cart': 'theme',
  'x-caddie-widget': CART_OPS_CONTRACT,
  ...(preview ? { [SMART_CART_HEADER]: SMART_CART_PREVIEW } : {}),
  ...(await ownerHeaders(id)),
});
async function add(p: Product, size: string, preview: boolean) {
  const res = await fetch(`${base}/api/session/${id}/add`, { method: 'POST', headers: await headers(preview), body: JSON.stringify({ items: [{ productId: p.id, options: { Size: size } }] }) });
  const body = (await res.json()) as { ok: boolean; actions?: CartAction[] };
  return body.actions?.find((action): action is Extract<CartAction, { type: 'add' }> => action.type === 'add');
}
type Line = BasketSync['lines'][number];
const line = (key: string, p: Product, variant: string, quantity: number, properties?: Record<string, string>): Line => ({
  key, productId: p.id, variantId: `gid://shopify/ProductVariant/${variant}`, title: '', variantTitle: '', quantity, ...(properties ? { properties } : {}),
});
const POLO_TRIGGER = { __3_Polo_Bundle: '3_Polo_Bundle' };
const TROUSER_TRIGGER = { '__any-2-trousers': 'any-2-trousers' };

describe('which products qualify - the theme\'s rule, never the name', () => {
  it('polos by the bundle_threepolo tag, matched without regard to case', () => {
    expect(offerForProduct(FLORAL)?.id).toBe('any-3-polos');
    expect(offerForProduct(EMOTIVE)?.id).toBe('any-3-polos');
  });
  it('a ladies-tagged polo is not the men\'s offer; ladies stay out of V1', () => {
    expect(offerForProduct(LADIES)).toBeNull();
  });
  it('a product whose name says "bundle" or "polo" but carries no tag does not qualify', () => {
    expect(offerForProduct(TRIGGER_POLO_NAMED)).toBeNull();
  });
  it('trousers and shorts by collection membership', () => {
    expect(offerForProduct(CLIMA)?.id).toBe('any-2-mens-trousers');
    expect(offerForProduct(COMFORT)?.id).toBe('any-2-shorts');
    expect(offerForProduct(JACKET)).toBeNull();
  });
  it('before the collections have loaded, trousers match nothing - an unstamped add, never a wrong one', () => {
    setSmartCartCollectionsForTests({});
    expect(offerForProduct(CLIMA)).toBeNull();
  });
  it('a product that would match two offers is stamped for neither', () => {
    setSmartCartCollectionsForTests({ 'men-golf-trousers': [FLORAL.id] });
    expect(offerForProduct(FLORAL)).toBeNull();
  });
  it('the properties a stamped add carries are exactly the trigger the theme writes', () => {
    expect(triggerPropertiesFor(FLORAL.id)).toEqual(POLO_TRIGGER);
    expect(triggerPropertiesFor(CLIMA.id)).toEqual(TROUSER_TRIGGER);
    expect(triggerPropertiesFor(COMFORT.id)).toEqual({ '__any-2-trouser-shorts': 'any-2-trouser-shorts' });
    expect(triggerPropertiesFor(JACKET.id)).toBeUndefined();
  });
});

describe('stamping on the Caddie\'s own adds', () => {
  it('with the preview on, a qualifying polo goes in carrying __3_Polo_Bundle, and the read-back is expected on that line', async () => {
    const action = await add(FLORAL, 'M', true);
    expect(action?.lines).toEqual([{ variantId: '710', quantity: 1, properties: POLO_TRIGGER }]);
    const record = Object.values((await sessions.getOrCreate(id)).cartOperations ?? {})[0]!;
    expect(record.expect.add).toEqual([{ variantId: '710', quantity: 1, properties: POLO_TRIGGER }]);
  });
  it('a qualifying pair of trousers carries __any-2-trousers', async () => {
    const action = await add(CLIMA, '32', true);
    expect(action?.lines[0]?.properties).toEqual(TROUSER_TRIGGER);
  });
  it('a product in no offer goes in plain, preview or not', async () => {
    const action = await add(JACKET, 'M', true);
    expect(action?.lines).toEqual([{ variantId: '780', quantity: 1 }]);
  });
  it('without the preview header - the live theme - nothing is stamped, exactly as today', async () => {
    const action = await add(FLORAL, 'M', false);
    expect(action?.lines).toEqual([{ variantId: '710', quantity: 1 }]);
  });
  it('the header is read on every request: the same session moving to the live theme stops stamping at once', async () => {
    await add(FLORAL, 'M', true);
    expect((await sessions.getOrCreate(id)).smartCartPreview).toBe(true);
    const later = await add(FLORAL, 'L', false);
    expect((await sessions.getOrCreate(id)).smartCartPreview).toBe(false);
    expect(later?.lines[0]?.properties).toBeUndefined();
  });
});

describe('the read-back of a stamped add', () => {
  const record = (properties?: Record<string, string>) => ({ expect: { add: [{ variantId: '710', quantity: 1, ...(properties ? { properties } : {}) }] } }) as never;
  const sync = (lines: Line[]): BasketSync => ({ lines });
  it('the stamped line rising is applied', () => {
    expect(judge(record(POLO_TRIGGER), { status: 'applied', before: sync([]), after: sync([line('k1', FLORAL, '710', 1, POLO_TRIGGER)]) })).toBe('applied');
  });
  it('merging into an existing stamped line of the same variant is applied', () => {
    expect(judge(record(POLO_TRIGGER), { status: 'applied', before: sync([line('k1', FLORAL, '710', 1, POLO_TRIGGER)]), after: sync([line('k1', FLORAL, '710', 2, POLO_TRIGGER)]) })).toBe('applied');
  });
  it('the variant landing without its trigger (a plain line) is not taken as the stamped add', () => {
    expect(judge(record(POLO_TRIGGER), { status: 'applied', before: sync([]), after: sync([line('k1', FLORAL, '710', 1)]) })).not.toBe('applied');
  });
  it('an unstamped add is judged exactly as before: on the plain line', () => {
    expect(judge(record(), { status: 'applied', before: sync([]), after: sync([line('k1', FLORAL, '710', 1)]) })).toBe('applied');
    expect(judge(record(), { status: 'applied', before: sync([]), after: sync([line('k1', FLORAL, '710', 1, POLO_TRIGGER)]) })).not.toBe('applied');
  });
});

describe('whether the offer would lower the price - sale prices, SupaEasy\'s sets', () => {
  const value = (lines: Line[], candidates: Product[] = [], currency?: string, offer = POLO_OFFER) => {
    const state = evaluateSmartCart(lines.map((entry) => ({ key: entry.key, quantity: entry.quantity, properties: entry.properties ?? null }))).offers.find((o) => o.offerId === offer.id)!;
    const basket = lines.map((entry) => ({ lineId: entry.key, productId: entry.productId, variantId: String(entry.variantId).split('/').pop()!, quantity: entry.quantity }));
    return offerValue(state, offer, basket, currency, candidates);
  };
  it('three £24 polos (£72) against £59.99: yes', () => {
    expect(value([line('a', FLORAL, '710', 3, POLO_TRIGGER)]).worthwhile).toBe(true);
  });
  it('two £24 and one £10 polo (£58): no - already under the deal, SupaEasy discounts nothing', () => {
    expect(value([line('a', FLORAL, '710', 2, POLO_TRIGGER), line('b', FLORAL_SAGE, '720', 1, POLO_TRIGGER)]).worthwhile).toBe(false);
  });
  it('two £20 joggers against 2 for £49: no', () => {
    expect(value([line('a', JOGGER, '760', 2, TROUSER_TRIGGER)], [], undefined, TROUSER_OFFER).worthwhile).toBe(false);
  });
  it('two £30 Clima trousers: yes', () => {
    expect(value([line('a', CLIMA, '750', 2, TROUSER_TRIGGER)], [], undefined, TROUSER_OFFER).worthwhile).toBe(true);
  });
  it('one away with £48 held: a £24 polo would take the set over £59.99 - worth nudging, and suggestible', () => {
    const v = value([line('a', FLORAL, '710', 2, POLO_TRIGGER)], [EMOTIVE]);
    expect(v).toMatchObject({ worthwhile: true, canSuggest: true, floorPence: 1199 });
  });
  it('one away with £20 held (two £10 polos): the third would have to cost over £39.99 - with nothing that dear, no nudge', () => {
    const v = value([line('a', FLORAL_SAGE, '720', 2, POLO_TRIGGER)], [FLORAL, EMOTIVE]);
    expect(v).toMatchObject({ worthwhile: false, canSuggest: false, floorPence: 3999 });
  });
  it('two missing: each must beat half of what is left', () => {
    const v = value([line('a', FLORAL, '710', 1, POLO_TRIGGER)], [EMOTIVE]);
    // £59.99 - £24 = £35.99 over two: each above £17.99.
    expect(v).toMatchObject({ worthwhile: true, canSuggest: true, floorPence: 1799 });
  });
  it('another currency: cannot tell, so no gate and no suggestion', () => {
    expect(value([line('a', FLORAL, '710', 2, POLO_TRIGGER)], [EMOTIVE], 'EUR')).toMatchObject({ worthwhile: null, canSuggest: false });
  });
  it('a price the catalogue does not know: cannot tell', () => {
    const unknown = { ...line('a', FLORAL, '999', 2, POLO_TRIGGER) };
    expect(value([unknown], [EMOTIVE]).worthwhile).toBeNull();
  });
});

describe('the basket route carries the gate', () => {
  const sync = async (lines: Line[], currency = 'GBP') =>
    (await (await fetch(`${base}/api/session/${id}/basket`, { method: 'POST', headers: await headers(true), body: JSON.stringify({ cartToken: 'c', currency, lines }) })).json()) as { smartCart: { offers: Array<{ offerId: string; worthwhile: boolean | null; canSuggest: boolean }> } };
  it('two £24 polos, a £24 polo to be had: worthwhile and suggestible', async () => {
    const body = await sync([line('a', FLORAL, '710', 2, POLO_TRIGGER)]);
    expect(body.smartCart.offers[0]).toMatchObject({ offerId: 'any-3-polos', worthwhile: true, canSuggest: true });
  });
  it('two £20 joggers: not worthwhile, not suggestible', async () => {
    // Only joggers in the collection, so nothing dearer would finish the pair above £49 either.
    setSmartCartCollectionsForTests({ 'men-golf-trousers': [JOGGER.id] });
    const body = await sync([line('a', JOGGER, '760', 1, TROUSER_TRIGGER)]);
    expect(body.smartCart.offers[1]).toMatchObject({ offerId: 'any-2-mens-trousers', worthwhile: false, canSuggest: false });
  });
  it('a euro cart: not judged', async () => {
    const body = await sync([line('a', FLORAL, '710', 2, POLO_TRIGGER)], 'EUR');
    expect(body.smartCart.offers[0]).toMatchObject({ worthwhile: null, canSuggest: false });
    expect((await sessions.getOrCreate(id)).cartCurrency).toBe('EUR');
  });
});

describe('suggestions that complete an offer', () => {
  const suggest = async (offerId: string) => {
    const res = await fetch(`${base}/api/session/${id}/smart-cart/suggest`, { method: 'POST', headers: await headers(true), body: JSON.stringify({ offerId }) });
    return { status: res.status, body: (await res.json()) as SmartCartSuggestResponse };
  };
  const syncBasket = async (lines: Line[]) => fetch(`${base}/api/session/${id}/basket`, { method: 'POST', headers: await headers(true), body: JSON.stringify({ currency: 'GBP', lines }) });

  it('qualifying, in stock, not already in the basket, and dear enough to make the set save something - cheapest first', async () => {
    await syncBasket([line('a', FLORAL, '710', 2, POLO_TRIGGER)]);
    const { status, body } = await suggest('any-3-polos');
    expect(status).toBe(200);
    // Floral navy is in the basket; the £10 sage would leave the set at £58; the ladies polo and the untagged one never qualify.
    expect(body.products.map((p) => p.title)).toEqual(['ABSTRACT EMOTIVE POLO - BLACK']);
    expect(body.message).toBe('Polos that complete the 3 for £59.99 offer');
    expect(body.message).not.toMatch(/sav|£\d+(\.\d+)? off\b|unlock/i);
  });
  it('nothing that would help: an empty list and a plain message', async () => {
    await syncBasket([line('a', FLORAL_SAGE, '720', 2, POLO_TRIGGER)]);
    const { body } = await suggest('any-3-polos');
    expect(body.products).toEqual([]);
    expect(body.message).toMatch(/couldn't find more polos/);
  });
  it('an offer that does not exist is refused', async () => {
    expect((await suggest('any-3-ladies-polos')).status).toBe(400);
  });
});
