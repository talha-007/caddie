import { beforeEach, describe, expect, it } from 'vitest';
import type { CaddieAttachment, Product } from '@caddie/shared';
import { setDealsForTests } from '../../src/catalog/bundles.js';
import { offerability, supportsSize } from '../../src/catalog/commerce.js';
import { setCatalogueForTests } from '../../src/catalog/sync.js';
import { env } from '../../src/env.js';
import { sessions } from '../../src/session/store.js';
import { rememberShopper } from '../../src/shopper/remember.js';
import { eligibilityFor, guardCards } from '../../src/tools/eligibility.js';
import { runTool } from '../../src/tools/index.js';

/**
 * V1 hardening task 1: one card eligibility rule for every card, and a
 * customer's sizes applied only where they mean something. A one-size cap
 * was hidden from a customer whose usual size is M ("not in stock in M /
 * 32"), and a pack was shown holding a jacket sold out in their S.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
let nextId = 9100;

function product(title: string, type: string, options: Array<{ name: string; values: string[] }>, soldOut: (combo: Record<string, string>) => boolean = () => false, price = 30): Product {
  const id = nextId;
  nextId += 50;
  const combos = options.reduce<Array<Record<string, string>>>((all, option) => all.flatMap((combo) => option.values.map((value) => ({ ...combo, [option.name]: value }))), [{}]);
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND],
    price: { amount: price, currency: 'GBP' },
    options,
    variants: combos.map((combo, i) => ({ id: `gid://shopify/ProductVariant/${id + i + 1}`, title: Object.values(combo).join(' / ') || 'Default Title', available: !soldOut(combo), price: { amount: price, currency: 'GBP' }, options: combo })),
    description: null,
  };
}

const TOPS = [{ name: 'Size', values: ['S', 'M', 'L', 'XL'] }];
const CAP = product('KOMO CAP - NAVY', 'HEADWEAR', [{ name: 'Size', values: ['ONE SIZE'] }], () => false, 15);
const CAP_COLOURS = product('PLAYERS CAP - RED', 'HEADWEAR', [{ name: 'Colour', values: ['RED', 'NAVY'] }], () => false, 15);
const SOCKS = product('ONE PAIR TOUR ANKLE SOCKS - WHITE', 'SOCKS', [], () => false, 8);
const POLO = product('ELITE POLO - NAVY', 'POLOS', TOPS, () => false, 20);
const POLO_NO_M = product('ELITE POLO - WHITE', 'POLOS', TOPS, (c) => c.Size === 'M', 20);
const POLO_SAGE = product('ELITE POLO - SAGE', 'POLOS', TOPS, () => false, 20);
const CHEAP_POLO_NO_M = product('BUDGET POLO - GREY', 'POLOS', TOPS, (c) => c.Size === 'M', 9);
const JACKET = product('CLIMA JACKET - NAVY', 'JACKETS', TOPS, () => false, 58);
const WARRIOR = product('WARRIOR JACKET - RED', 'JACKETS', TOPS, (c) => c.Size === 'S', 60);
const HEXA = product('HEXA PERFORMANCE JACKET - BLACK', 'JACKETS', TOPS, () => false, 40);
const TROUSERS = product("MEN'S CLIMA GOLF TROUSERS - NAVY", 'TROUSERS', [{ name: 'WAIST SIZE', values: ['30', '32', '34'] }, { name: 'LEG LENGTH', values: ['30', '32', '34'] }], () => false, 30);
const TROUSERS_32_GONE = product("MEN'S TOUR TROUSERS - BLACK", 'TROUSERS', [{ name: 'WAIST SIZE', values: ['30', '32', '34'] }, { name: 'LEG LENGTH', values: ['30', '32'] }], (c) => c['WAIST SIZE'] === '32', 30);
const BELT = product('TOUR PRO BELT - BLACK', 'BELTS', [{ name: 'Size', values: ['M/L', 'L/XL'] }], () => false, 20);
const GONE = product('ARCHER JACKET - BLACK', 'JACKETS', TOPS, () => true, 32);
const EVERYTHING = [CAP, CAP_COLOURS, SOCKS, POLO, POLO_NO_M, POLO_SAGE, CHEAP_POLO_NO_M, JACKET, WARRIOR, HEXA, TROUSERS, TROUSERS_32_GONE, BELT, GONE];

const step = (title: string, products: Product[]) => ({ title, collection: title, productIds: new Set(products.map((p) => p.id)) });
const MIXED = {
  handle: 'ambassador-pack-mixed-conditions',
  title: 'AMBASSADOR PACK - MIXED CONDITIONS',
  range: 'men' as const,
  prices: { GBP: 99 },
  dynamicPrices: false,
  url: '',
  steps: [step('JACKET', [WARRIOR, HEXA]), step('POLO', [POLO])],
};

let id = '';
beforeEach(async () => {
  setCatalogueForTests(EVERYTHING);
  setDealsForTests([MIXED]);
  id = `eligibility-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme' });
});

async function profile(update: { usualSize?: string; waist?: string }) {
  await rememberShopper(id, { range: 'men', ...update }, 'customer-words');
  return sessions.getOrCreate(id);
}

const cards = (result: { attachment?: CaddieAttachment }) => (result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : []);

describe('which of their sizes applies', () => {
  it('1-3. usual M and waist 32: a one-size cap, a colours-only cap and one-size socks all stay eligible', async () => {
    const session = await profile({ usualSize: 'M', waist: '32' });
    const rule = eligibilityFor(session);
    for (const item of [CAP, CAP_COLOURS, SOCKS]) {
      expect(rule.decide(item)).toMatchObject({ offer: 'eligible', sizes: {} });
      expect(['in-stock', 'sold-out', 'not-made']).not.toContain(supportsSize(item, 'M'));
      expect(['in-stock', 'sold-out', 'not-made']).not.toContain(supportsSize(item, '32'));
    }
    // A colour is never read as a size.
    expect(supportsSize(CAP_COLOURS, 'RED')).toBe('not-applicable');
  });

  it('4-5. M applies to a polo and a jacket', async () => {
    const rule = eligibilityFor(await profile({ usualSize: 'M' }));
    expect(rule.decide(POLO).sizes).toEqual({ Size: 'M' });
    expect(rule.decide(JACKET).sizes).toEqual({ Size: 'M' });
  });

  it('6-8. waist 32 applies to trousers, never to a polo or a jacket', async () => {
    const rule = eligibilityFor(await profile({ waist: '32' }));
    expect(rule.decide(TROUSERS).sizes).toEqual({ 'WAIST SIZE': '32' });
    expect(rule.decide(POLO)).toMatchObject({ offer: 'eligible', sizes: {} });
    expect(rule.decide(JACKET)).toMatchObject({ offer: 'eligible', sizes: {} });
    expect(supportsSize(POLO, '32')).toBe('not-applicable');
  });

  it('9. M does not silently become M/L on a belt', async () => {
    const rule = eligibilityFor(await profile({ usualSize: 'M' }));
    expect(rule.decide(BELT)).toMatchObject({ offer: 'eligible', sizes: {} });
    expect(supportsSize(BELT, 'M')).toBe('not-applicable');
  });

  it('a 34 given as a leg is judged on the leg, never as a waist', () => {
    expect(offerability(TROUSERS_32_GONE, [{ size: '34', as: 'leg' }]).offer).toBe('not-eligible');
    expect(offerability(TROUSERS_32_GONE, [{ size: '34', as: 'waist' }]).offer).toBe('eligible');
  });
});

describe('what may be offered', () => {
  it('10-11. S known: a jacket sold out in S is not eligible, though it has other sizes', () => {
    expect(offerability(WARRIOR, [{ size: 'S', as: 'top' }])).toMatchObject({ offer: 'not-eligible', reason: 'sold out in S', why: 'sold-out' });
    expect(WARRIOR.variants.some((variant) => variant.available)).toBe(true);
  });

  it('12. no size known: some sizes sold out is still eligible', () => {
    expect(offerability(WARRIOR, []).offer).toBe('eligible');
  });

  it('13. nothing buyable at all: not eligible', () => {
    expect(offerability(GONE, [])).toMatchObject({ offer: 'not-eligible', why: 'unavailable' });
  });

  it('the exact variant: waist 32 sold out in every leg is not eligible', () => {
    expect(offerability(TROUSERS_32_GONE, [{ size: '32', as: 'waist' }]).offer).toBe('not-eligible');
    expect(offerability(TROUSERS, [{ size: '32', as: 'waist' }, { size: '34', as: 'leg' }]).offer).toBe('eligible');
  });

  it('a product they named, not to be had in their size, is informational only', () => {
    expect(offerability(WARRIOR, [{ size: 'S' }], { named: true }).offer).toBe('informational-only');
  });
});

describe('every path that shows cards', () => {
  it('caps with usual M and waist 32: shown, and never "not in M" or "32"', async () => {
    await profile({ usualSize: 'M', waist: '32' });
    const session = await sessions.getOrCreate(id);
    const result = await runTool('search_products', { query: 'caps' }, { session, utterance: 'Show me all caps in stock.' });
    expect(cards(result).sort()).toEqual([CAP.title, CAP_COLOURS.title].sort());
    expect(`${result.speech} ${result.facts}`).not.toMatch(/not (in stock |made |available )?in (M|32)\b|in M \/ 32/);
  });

  it('polos with usual M: only polos to be had in M', async () => {
    await profile({ usualSize: 'M' });
    const result = await runTool('search_products', { query: 'polos' }, { session: await sessions.getOrCreate(id), utterance: 'Show me polos.' });
    expect(cards(result)).toContain(POLO.title);
    expect(cards(result)).not.toContain(POLO_NO_M.title);
    expect(cards(result)).not.toContain(CHEAP_POLO_NO_M.title);
  });

  it('trousers with waist 32: only trousers to be had in 32', async () => {
    await profile({ waist: '32' });
    const result = await runTool('search_products', { query: 'trousers' }, { session: await sessions.getOrCreate(id), utterance: 'Show me trousers.' });
    expect(cards(result)).toContain(TROUSERS.title);
    expect(cards(result)).not.toContain(TROUSERS_32_GONE.title);
  });

  it('14. a named product sold out in their size: said, no card', async () => {
    await profile({ usualSize: 'S' });
    const result = await runTool('get_product_details', { productId: WARRIOR.id }, { session: await sessions.getOrCreate(id), utterance: 'Do you have the Warrior Jacket red in S?' });
    expect(result.attachment).toBeUndefined();
    expect(result.speech).toMatch(/sold out in S/);
    expect(result.facts).toMatch(/informational only/);
  });

  it('14b. named in a search: said in the facts, never a card', async () => {
    await profile({ usualSize: 'S' });
    const result = await runTool('search_products', { productName: 'Warrior Jacket', colour: 'red' }, { session: await sessions.getOrCreate(id), utterance: 'Show me the Warrior Jacket in red' });
    expect(cards(result)).not.toContain(WARRIOR.title);
    expect(result.facts).toMatch(/WARRIOR JACKET - RED is the product they named, but it is sold out in S/);
    expect(result.speech).toMatch(/sold out in S/);
    expect(result.speech).not.toMatch(/do not have/);
  });

  it('15. other colours: a colourway sold out in their M is taken off', async () => {
    await profile({ usualSize: 'M' });
    // other_colours works from the product the customer names or holds, not the model's id alone.
    const result = await runTool('other_colours', { productId: POLO.id }, { session: await sessions.getOrCreate(id), utterance: 'what other colours does the Elite Polo navy come in?' });
    expect(cards(result).sort()).toEqual([POLO.title, POLO_SAGE.title].sort());
    expect(cards(result)).not.toContain(POLO_NO_M.title);
  });

  it('16. cheaper: only what can be had in their size, though the cheapest is sold out in M', async () => {
    await profile({ usualSize: 'M' });
    const result = await runTool('search_products', { query: 'polo' }, { session: await sessions.getOrCreate(id), utterance: "What's the cheapest polo?" });
    expect(cards(result)).not.toContain(CHEAP_POLO_NO_M.title);
    expect(cards(result).length).toBeGreaterThan(0);
    const rule = eligibilityFor(await sessions.getOrCreate(id));
    for (const title of cards(result)) expect(rule.eligible(EVERYTHING.find((p) => p.title === title)!)).toBe(true);
  });

  it('17. "another one": only eligible products', async () => {
    await profile({ usualSize: 'M' });
    await runTool('search_products', { query: 'polos' }, { session: await sessions.getOrCreate(id), utterance: 'Show me polos.' });
    const result = await runTool('search_products', { query: 'polos' }, { session: await sessions.getOrCreate(id), utterance: 'Show me another one' });
    const rule = eligibilityFor(await sessions.getOrCreate(id));
    for (const title of cards(result)) expect(rule.eligible(EVERYTHING.find((p) => p.title === title)!)).toBe(true);
  });

  it('18. best picks: only eligible products, one-size included', async () => {
    await profile({ usualSize: 'M', waist: '32' });
    const result = await runTool('best_picks', { garments: 'polos, trousers, caps' }, { session: await sessions.getOrCreate(id), utterance: 'what are your best polos, trousers and caps?' });
    const shown = cards(result);
    expect(shown).not.toContain(POLO_NO_M.title);
    expect(shown).not.toContain(TROUSERS_32_GONE.title);
    const rule = eligibilityFor(await sessions.getOrCreate(id));
    for (const title of shown) expect(rule.eligible(EVERYTHING.find((p) => p.title === title)!)).toBe(true);
  });

  it('19. a pack for a known S never holds a piece sold out in S', async () => {
    await profile({ usualSize: 'S' });
    const result = await runTool('recommend_pack', { query: 'Ambassador Pack Mixed Conditions', colour: 'red' }, { session: await sessions.getOrCreate(id), utterance: 'show me the ambassador pack mixed conditions in red' });
    const pieces = result.attachment?.kind === 'pack' ? result.attachment.recommendation.items.map((p) => p.title) : [];
    expect(pieces).not.toContain(WARRIOR.title);
    expect(pieces).toContain(HEXA.title);
  });

  it('19b. a pack whose only jacket is sold out in S: no sold-out piece chosen in its place', async () => {
    setDealsForTests([{ ...MIXED, steps: [step('JACKET', [WARRIOR]), step('POLO', [POLO])] }]);
    await profile({ usualSize: 'S' });
    const result = await runTool('recommend_pack', { query: 'Ambassador Pack Mixed Conditions' }, { session: await sessions.getOrCreate(id), utterance: 'show me the ambassador pack mixed conditions' });
    const pieces = result.attachment?.kind === 'pack' ? result.attachment.recommendation.items.map((p) => p.title) : [];
    expect(pieces).not.toContain(WARRIOR.title);
  });

  it('20. replacement candidates in S never include a jacket sold out in S', async () => {
    const session = await sessions.getOrCreate(id);
    await runTool('recommend_pack', { query: 'Ambassador Pack Mixed Conditions', colour: 'red' }, { session, utterance: 'show me the ambassador pack mixed conditions in red' });
    const result = await runTool('search_products', { query: 'jacket', size: 'S' }, { session: await sessions.getOrCreate(id), utterance: 'show me another jacket for the pack available in S' });
    expect(cards(result)).not.toContain(WARRIOR.title);
    expect(cards(result)).toContain(HEXA.title);
  });

  it('21. the last check takes an ineligible card off, and off the screen, however it got there', async () => {
    await profile({ usualSize: 'M' });
    const session = await sessions.getOrCreate(id);
    await sessions.patch(id, { lastShown: { kind: 'products', items: [POLO, POLO_NO_M].map((p) => ({ id: p.id, title: p.title })), query: 'polos' } });
    const injected = { speech: 'Here you go.', attachment: { kind: 'products' as const, products: [POLO, POLO_NO_M] } };
    const guarded = await guardCards(injected, { session, utterance: 'show me polos' }, 'test-injection');
    expect(cards(guarded)).toEqual([POLO.title]);
    expect((await sessions.getOrCreate(id)).lastShown?.items.map((item) => item.title)).toEqual([POLO.title]);
    // A pack holding a sold-out piece is not shown at all.
    const pack = { speech: 'The pack.', attachment: { kind: 'pack' as const, recommendation: { items: [WARRIOR, POLO], total: { amount: 99, currency: 'GBP' }, overBudget: false, reason: '' } } };
    await profile({ usualSize: 'S' });
    const blocked = await guardCards(pack as never, { session: await sessions.getOrCreate(id), utterance: '' }, 'test-injection');
    expect(blocked.attachment).toBeUndefined();
  });
});

describe('the reply check', () => {
  it('"not available in M" of a cap in one size is caught; of a polo sold out in M it is right', async () => {
    const { stockClaims } = await import('../../src/ai/verify.js');
    expect(stockClaims('The Komo Cap is not available in M.', [CAP], [CAP]).length).toBeGreaterThan(0);
    expect(stockClaims('The Komo Cap is sold out in 32.', [CAP], [CAP]).length).toBeGreaterThan(0);
    expect(stockClaims('The Elite Polo is sold out in M.', [POLO_NO_M], [POLO_NO_M]).length).toBe(0);
    // "isn't available in size S" says it is not - never read as "available in S".
    expect(stockClaims("The Warrior Jacket in red isn't available in size S.", [WARRIOR], [WARRIOR])).toEqual([]);
    expect(stockClaims('The Warrior Jacket in red isn’t available in size S.', [WARRIOR], [WARRIOR])).toEqual([]);
    expect(stockClaims('The Warrior Jacket in red is available in size S.', [WARRIOR], [WARRIOR]).length).toBeGreaterThan(0);
  });
});

describe('their size put on something in one size', () => {
  it('"in your size M" of a cap or socks is caught; of a polo it is not', async () => {
    const { sizeClaims } = await import('../../src/ai/verify.js');
    expect(sizeClaims('The Komo Cap is just £15 in your size M.', [CAP, POLO])).toHaveLength(1);
    expect(sizeClaims('We have one size socks in your size M.', [SOCKS])).toHaveLength(1);
    expect(sizeClaims('These are lightweight, fitting your medium size.', [SOCKS])).toHaveLength(1);
    expect(sizeClaims('The Elite Polo is £20 in your size M.', [CAP, POLO])).toEqual([]);
    expect(sizeClaims('The Komo Cap comes in one size.', [CAP])).toEqual([]);
    expect(sizeClaims('I found six caps in your size, all one size fits most.', [CAP, CAP_COLOURS])).toHaveLength(1);
    expect(sizeClaims('The Elite Polo is a breathable choice in your size.', [POLO])).toEqual([]);
  });
});
