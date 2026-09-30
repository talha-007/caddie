import { describe, expect, it } from 'vitest';
import { SMART_CART_OFFERS, evaluateSmartCart, hasTrigger, progressStatus, type SmartCartLine, type SmartCartOfferId, type SmartCartOfferState } from '../src/smartCart/index.js';

/**
 * Smart Cart phase 3 - the read-only evaluator. It mirrors the live SupaEasy
 * rule and nothing more: a line counts when it carries the offer's trigger
 * property with a value that is not empty; its quantity counts as units; the
 * product itself - name, type, tag, collection, pack - is never looked at.
 */

const POLO = '__3_Polo_Bundle';
const TROUSERS = '__any-2-trousers';
const SHORTS = '__any-2-trouser-shorts';

/** What QUICK_CART writes on a polo from a product tagged bundle_threepolo. */
const poloProps = { __Localization: 'GB', __Product_Url: '/products/elite-polo', __data_three_polo: '3_Polo_Bundle', [POLO]: '3_Polo_Bundle' };
/** What bundle builder v4 writes on each line of the live any-2 page (a subset): pack metadata and the trigger. */
const v4Props = (handle: string, bundleId = 'b-1') => ({ __bundle_id: bundleId, __Bundle_Name: handle, __bundle_version_2: handle, __b_version: '4', __fixed_price: '49.00', __price_validated: 'true', [`__${handle}`]: handle });
/** The same pack line with no trigger: an Ambassador Pack's trousers. */
const packOnly = (bundleId = 'amb-1') => ({ __bundle_id: bundleId, __Bundle_Name: 'golf-ambassador-pack', __bundle_version_2: 'golf-ambassador-pack', __b_version: '4', '__golf-ambassador-pack': 'golf-ambassador-pack' });

let n = 0;
const line = (quantity: number, properties?: SmartCartLine['properties'], variantId = String(900 + n)): SmartCartLine => ({ key: `k${++n}`, variantId, quantity, ...(properties !== undefined ? { properties } : {}) });
const offer = (lines: SmartCartLine[], id: SmartCartOfferId): SmartCartOfferState => evaluateSmartCart(lines).offers.find((o) => o.offerId === id)!;
/** The men's three, the deals the older multi-offer checks were written for. */
const MEN = new Set<string>(['any-3-polos', 'any-2-mens-trousers', 'any-2-shorts']);
const men = (offers: readonly SmartCartOfferState[]) => offers.filter((o) => MEN.has(o.offerId));
const summary = (state: SmartCartOfferState) => [state.status, state.qualifyingUnits, state.remainingUnits];

describe('the offers', () => {
  it('are every live "any N" deal - men, ladies and kids - with its key, value and threshold', () => {
    expect(SMART_CART_OFFERS.map((o) => [o.id, o.triggerKey, o.matchValue ?? null, o.threshold])).toEqual([
      ['any-3-polos', POLO, null, 3],
      ['any-2-mens-trousers', TROUSERS, null, 2],
      ['any-2-shorts', SHORTS, null, 2],
      ['any-3-polos-kids', '__bundle_threepolo_kids', null, 3],
      ['any-3-polos-ladies', '__bundle_threepolo_ladies', null, 3],
      ['any-2-trousers-ladies', '__ladies-any-2-trousers', null, 2],
      ['any-2-trousers-kids', '__kids-any-2-trousers', null, 2],
      ['any-2-shorts-ladies', '__any-2-shorts', 'ladies', 2],
      ['any-2-shorts-kids', '__any-2-shorts', 'kids', 2],
    ]);
  });

  it('never include __three-polo-deal, the £55 ladies polo key or any fixed pack', () => {
    const keys = SMART_CART_OFFERS.map((o) => o.triggerKey);
    for (const excluded of ['__three-polo-deal', '__any-three-ladies-polos', '__golf-ambassador-pack', '__ladies-ambassador-pack', '__kids-ambassador', '__prestige-pack', '__players-bundle', '__any-rainsuit', '__layering-duo', '__amb-mens-condition']) {
      expect(keys).not.toContain(excluded);
    }
    const lines = [line(3, { '__three-polo-deal': 'three-polo-deal' }), line(3, { '__any-three-ladies-polos': 'any-three-ladies-polos' }), line(6, { '__golf-ambassador-pack': 'golf-ambassador-pack' })];
    expect(evaluateSmartCart(lines).offers.every((o) => o.status === 'INACTIVE')).toBe(true);
  });

  it('every offer is reported, in config order, for any basket - including an empty one', () => {
    const state = evaluateSmartCart([], SMART_CART_OFFERS, 1234);
    expect(state.evaluatedAt).toBe(1234);
    expect(state.offers).toHaveLength(SMART_CART_OFFERS.length);
    expect(men(state.offers).map((o) => [o.offerId, o.status, o.qualifyingUnits, o.requiredUnits, o.remainingUnits, o.matchedLineKeys, o.matchedVariantIds])).toEqual([
      ['any-3-polos', 'INACTIVE', 0, 3, 3, [], []],
      ['any-2-mens-trousers', 'INACTIVE', 0, 2, 2, [], []],
      ['any-2-shorts', 'INACTIVE', 0, 2, 2, [], []],
    ]);
    expect(state.offers.every((o) => o.status === 'INACTIVE' && o.qualifyingUnits === 0)).toBe(true);
  });
});

describe('status from units', () => {
  it('threshold 3: 0 inactive, 1 in progress, 2 one away, 3 and 4 qualified', () => {
    expect([0, 1, 2, 3, 4].map((units) => progressStatus(units, 3))).toEqual(['INACTIVE', 'IN_PROGRESS', 'ONE_AWAY', 'QUALIFIED', 'QUALIFIED']);
  });
  it('threshold 2: 0 inactive, 1 one away, 2 and more qualified - never "in progress"', () => {
    expect([0, 1, 2, 5].map((units) => progressStatus(units, 2))).toEqual(['INACTIVE', 'ONE_AWAY', 'QUALIFIED', 'QUALIFIED']);
  });
});

describe('Any 3 Polos', () => {
  it('an empty basket: inactive, three to go', () => {
    expect(summary(offer([], 'any-3-polos'))).toEqual(['INACTIVE', 0, 3]);
  });
  it('one triggered polo: in progress', () => {
    expect(summary(offer([line(1, poloProps)], 'any-3-polos'))).toEqual(['IN_PROGRESS', 1, 2]);
  });
  it('two triggered units on two lines: one away', () => {
    const lines = [line(1, poloProps), line(1, poloProps)];
    const state = offer(lines, 'any-3-polos');
    expect(summary(state)).toEqual(['ONE_AWAY', 2, 1]);
    expect(state.matchedLineKeys).toEqual(lines.map((l) => l.key));
  });
  it('quantity 3 on one triggered line: qualified - quantity is units', () => {
    const lines = [line(3, poloProps, '611')];
    const state = offer(lines, 'any-3-polos');
    expect(summary(state)).toEqual(['QUALIFIED', 3, 0]);
    expect(state.matchedLineKeys).toEqual([lines[0]!.key]);
    expect(state.matchedVariantIds).toEqual(['611']);
  });
  it('four triggered units: qualified, and the count is not capped at the threshold', () => {
    expect(summary(offer([line(2, poloProps), line(2, poloProps)], 'any-3-polos'))).toEqual(['QUALIFIED', 4, 0]);
  });
  it('polos without the trigger do not count, however many - a Caddie add today, or an Ambassador Pack polo', () => {
    const lines = [line(3, undefined), line(2, {}), line(1, { __Localization: 'GB', __Product_Url: '/products/elite-polo' }), line(1, packOnly())];
    expect(summary(offer(lines, 'any-3-polos'))).toEqual(['INACTIVE', 0, 3]);
  });
  it('an empty trigger does not count', () => {
    expect(summary(offer([line(3, { ...poloProps, [POLO]: '' })], 'any-3-polos'))).toEqual(['INACTIVE', 0, 3]);
  });
  it('only this offer\'s key: __data_three_polo alone is not the trigger', () => {
    expect(summary(offer([line(3, { __data_three_polo: '3_Polo_Bundle' })], 'any-3-polos'))).toEqual(['INACTIVE', 0, 3]);
  });
});

describe('Any 2 Men\'s Trousers', () => {
  it('one triggered unit: one away', () => {
    expect(summary(offer([line(1, v4Props('any-2-trousers'))], 'any-2-mens-trousers'))).toEqual(['ONE_AWAY', 1, 1]);
  });
  it('two triggered lines: qualified', () => {
    expect(summary(offer([line(1, v4Props('any-2-trousers')), line(1, v4Props('any-2-trousers'))], 'any-2-mens-trousers'))).toEqual(['QUALIFIED', 2, 0]);
  });
  it('quantity 2 on one triggered line: qualified', () => {
    expect(summary(offer([line(2, { [TROUSERS]: 'any-2-trousers' })], 'any-2-mens-trousers'))).toEqual(['QUALIFIED', 2, 0]);
  });
  it('v4 pack metadata and the trigger (the live any-2 page): counts - pack lines are not excluded', () => {
    const lines = [line(1, v4Props('any-2-trousers', 'p1')), line(1, v4Props('any-2-trousers', 'p1'))];
    const state = offer(lines, 'any-2-mens-trousers');
    expect(summary(state)).toEqual(['QUALIFIED', 2, 0]);
    expect(state.matchedLineKeys).toEqual(lines.map((l) => l.key));
  });
  it('v4 pack metadata without the trigger (trousers in another pack): does not count', () => {
    expect(summary(offer([line(1, packOnly()), line(1, packOnly())], 'any-2-mens-trousers'))).toEqual(['INACTIVE', 0, 2]);
  });
  it('an empty trigger does not count', () => {
    expect(summary(offer([line(2, { [TROUSERS]: '' })], 'any-2-mens-trousers'))).toEqual(['INACTIVE', 0, 2]);
  });
});

describe('Any 2 Shorts', () => {
  it('one triggered unit: one away', () => {
    expect(summary(offer([line(1, v4Props('any-2-trouser-shorts'))], 'any-2-shorts'))).toEqual(['ONE_AWAY', 1, 1]);
  });
  it('two triggered lines: qualified', () => {
    expect(summary(offer([line(1, v4Props('any-2-trouser-shorts')), line(1, v4Props('any-2-trouser-shorts'))], 'any-2-shorts'))).toEqual(['QUALIFIED', 2, 0]);
  });
  it('quantity 2 on one triggered line: qualified', () => {
    expect(summary(offer([line(2, { [SHORTS]: 'any-2-trouser-shorts' })], 'any-2-shorts'))).toEqual(['QUALIFIED', 2, 0]);
  });
  it('v4 pack metadata and the trigger: counts', () => {
    expect(summary(offer([line(1, v4Props('any-2-trouser-shorts', 's1')), line(1, v4Props('any-2-trouser-shorts', 's1'))], 'any-2-shorts'))).toEqual(['QUALIFIED', 2, 0]);
  });
  it('v4 pack metadata without the trigger: does not count', () => {
    expect(summary(offer([line(2, packOnly())], 'any-2-shorts'))).toEqual(['INACTIVE', 0, 2]);
  });
  it('the ladies and kids shorts trigger is a different offer and does not count here', () => {
    expect(summary(offer([line(2, { '__any-2-shorts': 'kids' })], 'any-2-shorts'))).toEqual(['INACTIVE', 0, 2]);
  });
  it('an empty trigger does not count', () => {
    expect(summary(offer([line(2, { [SHORTS]: '' })], 'any-2-shorts'))).toEqual(['INACTIVE', 0, 2]);
  });
});

describe('property edge cases', () => {
  it('trigger missing: no', () => {
    expect(hasTrigger(line(1, { __Localization: 'GB' }), POLO)).toBe(false);
    expect(hasTrigger(line(1, undefined), POLO)).toBe(false);
    expect(hasTrigger(line(1, null), POLO)).toBe(false);
  });
  it('trigger value empty string: no', () => {
    expect(hasTrigger(line(1, { [POLO]: '' }), POLO)).toBe(false);
  });
  it('trigger value whitespace only: YES - SupaEasy tests `value !== ""` without trimming, so checkout would count it', () => {
    expect(hasTrigger(line(1, { [POLO]: '   ' }), POLO)).toBe(true);
    expect(summary(offer([line(3, { [POLO]: ' ' })], 'any-3-polos'))).toEqual(['QUALIFIED', 3, 0]);
  });
  it('trigger value null or undefined (the unvalidated basket route could carry either): no', () => {
    expect(hasTrigger(line(1, { [POLO]: null }), POLO)).toBe(false);
    expect(hasTrigger(line(1, { [POLO]: undefined }), POLO)).toBe(false);
  });
  it('a value that is not a string did not come from a cart read: no', () => {
    expect(hasTrigger(line(1, { [POLO]: 1 }), POLO)).toBe(false);
    expect(hasTrigger(line(1, { [POLO]: { v: 'x' } }), POLO)).toBe(false);
  });
  it('the expected value: yes - and so is any other value, since SupaEasy does not compare it', () => {
    expect(hasTrigger(line(1, { [POLO]: '3_Polo_Bundle' }), POLO)).toBe(true);
    expect(hasTrigger(line(1, { [POLO]: 'something else' }), POLO)).toBe(true);
  });
  it('the key is matched exactly: case and a missing prefix matter', () => {
    expect(hasTrigger(line(1, { __3_polo_bundle: '3_Polo_Bundle' }), POLO)).toBe(false);
    expect(hasTrigger(line(1, { '3_Polo_Bundle': '3_Polo_Bundle' }), POLO)).toBe(false);
  });
  it('unrelated properties change nothing', () => {
    const plain = offer([line(3, { [POLO]: '3_Polo_Bundle' })], 'any-3-polos');
    const busy = offer([line(3, { ...poloProps, _gift: 'yes', __bundle_id: 'x', note: 'hi' })], 'any-3-polos');
    expect(summary(busy)).toEqual(summary(plain));
  });
  it('the same variant on several lines: every triggered line counts, the variant is listed once', () => {
    const lines = [line(1, poloProps, '611'), line(1, { ...poloProps, _gift: 'yes' }, '611'), line(1, undefined, '611')];
    const state = offer(lines, 'any-3-polos');
    expect(summary(state)).toEqual(['ONE_AWAY', 2, 1]);
    expect(state.matchedLineKeys).toEqual([lines[0]!.key, lines[1]!.key]);
    expect(state.matchedVariantIds).toEqual(['611']);
  });
  it('a line of quantity 0 (just removed, still reported) matches nothing', () => {
    const state = offer([line(0, poloProps)], 'any-3-polos');
    expect(summary(state)).toEqual(['INACTIVE', 0, 3]);
    expect(state.matchedLineKeys).toEqual([]);
  });
  it('a line with no variant id still counts; it just adds no variant', () => {
    const state = offer([{ key: 'nv', quantity: 1, properties: poloProps }], 'any-3-polos');
    expect(state.qualifyingUnits).toBe(1);
    expect(state.matchedVariantIds).toEqual([]);
  });
});

describe('several offers in one basket', () => {
  it('polos and trousers: each counts its own lines only', () => {
    const lines = [line(2, poloProps), line(1, v4Props('any-2-trousers'))];
    const state = evaluateSmartCart(lines);
    expect(men(state.offers).map((o) => [o.offerId, o.status, o.qualifyingUnits])).toEqual([
      ['any-3-polos', 'ONE_AWAY', 2],
      ['any-2-mens-trousers', 'ONE_AWAY', 1],
      ['any-2-shorts', 'INACTIVE', 0],
    ]);
  });
  it('all three offers active at once, independently', () => {
    const lines = [line(3, poloProps), line(1, v4Props('any-2-trousers')), line(1, v4Props('any-2-trousers')), line(1, v4Props('any-2-trouser-shorts')), line(1, undefined)];
    expect(men(evaluateSmartCart(lines).offers).map((o) => [o.offerId, o.status, o.qualifyingUnits, o.remainingUnits])).toEqual([
      ['any-3-polos', 'QUALIFIED', 3, 0],
      ['any-2-mens-trousers', 'QUALIFIED', 2, 0],
      ['any-2-shorts', 'ONE_AWAY', 1, 1],
    ]);
  });
  it('one line carrying two triggers counts for both - no exclusion is invented (no known live path writes this)', () => {
    const both = line(2, { [POLO]: '3_Polo_Bundle', [TROUSERS]: 'any-2-trousers' });
    const state = evaluateSmartCart([both]);
    expect(men(state.offers).map((o) => [o.offerId, o.qualifyingUnits, o.matchedLineKeys])).toEqual([
      ['any-3-polos', 2, [both.key]],
      ['any-2-mens-trousers', 2, [both.key]],
      ['any-2-shorts', 0, []],
    ]);
  });
});

describe('replaceable config', () => {
  it('takes any offer list - a live SupaEasy reader can stand in for the static one', () => {
    const state = evaluateSmartCart([line(4, { __x: 'y' })], [{ id: 'any-3-polos', name: 'Test', triggerKey: '__x', triggerValue: 'x', threshold: 5, qualifies: { tag: 'x' }, gatePrice: { amount: 1, currency: 'GBP' } }]);
    expect(state.offers).toEqual([expect.objectContaining({ triggerKey: '__x', status: 'ONE_AWAY', qualifyingUnits: 4, requiredUnits: 5, remainingUnits: 1 })]);
  });
  it('display wording is metadata only: changing it changes no number', () => {
    const lines = [line(2, poloProps)];
    const altered = SMART_CART_OFFERS.map((o) => ({ ...o, display: { deal: '3 for £1', units: 'things', one: 'thing', many: 'things', title: 'Thing deal' } }));
    expect(evaluateSmartCart(lines, altered, 1)).toEqual(evaluateSmartCart(lines, SMART_CART_OFFERS, 1));
  });
});

describe('the view sent to the widget', () => {
  it('is null when there is no state, never an empty one', async () => {
    const { smartCartView } = await import('../src/smartCart/index.js');
    expect(smartCartView(undefined)).toBeNull();
  });
  it('carries progress and display wording only', async () => {
    const { smartCartView } = await import('../src/smartCart/index.js');
    const view = smartCartView(evaluateSmartCart([line(2, poloProps, '611')], SMART_CART_OFFERS, 5))!;
    expect(view.evaluatedAt).toBe(5);
    // No basket prices given: whether the offer lowers the price cannot be told.
    expect(view.offers[0]).toEqual({ offerId: 'any-3-polos', name: 'Any 3 Polos', status: 'ONE_AWAY', qualifyingUnits: 2, requiredUnits: 3, remainingUnits: 1, worthwhile: null, canSuggest: false, display: { deal: '3 for £59.99', units: 'polos', one: 'polo', many: 'polos', title: 'Any 3 Polos' } });
    expect(JSON.stringify(view)).not.toMatch(/matchedLineKeys|matchedVariantIds|triggerKey|611|__3_Polo_Bundle/);
  });
});

describe('ladies and kids "any N" deals', () => {
  it('ladies polos: __bundle_threepolo_ladies, 3 units, at £59.99 - the £55 key counts for nothing', () => {
    expect(summary(offer([line(3, { __bundle_threepolo_ladies: 'bundle_threepolo_ladies' })], 'any-3-polos-ladies'))).toEqual(['QUALIFIED', 3, 0]);
    expect(summary(offer([line(3, { '__any-three-ladies-polos': 'any-three-ladies-polos' })], 'any-3-polos-ladies'))).toEqual(['INACTIVE', 0, 3]);
  });
  it('kids polos: __bundle_threepolo_kids, 3 units', () => {
    expect(summary(offer([line(2, { __bundle_threepolo_kids: 'bundle_threepolo_kids' })], 'any-3-polos-kids'))).toEqual(['ONE_AWAY', 2, 1]);
  });
  it("ladies and kids trousers each read their own key, never the men's", () => {
    const lines = [line(1, { '__ladies-any-2-trousers': 'ladies-any-2-trousers' }), line(2, { '__kids-any-2-trousers': 'kids-any-2-trousers' })];
    expect(summary(offer(lines, 'any-2-trousers-ladies'))).toEqual(['ONE_AWAY', 1, 1]);
    expect(summary(offer(lines, 'any-2-trousers-kids'))).toEqual(['QUALIFIED', 2, 0]);
    expect(summary(offer(lines, 'any-2-mens-trousers'))).toEqual(['INACTIVE', 0, 2]);
  });
  it('ladies and kids shorts share one key, __any-2-shorts, and are told apart by its trimmed value - as SupaEasy does', () => {
    const lines = [line(1, { '__any-2-shorts': 'ladies' }), line(1, { '__any-2-shorts': 'kids' }), line(1, { '__any-2-shorts': ' ladies ' })];
    expect(summary(offer(lines, 'any-2-shorts-ladies'))).toEqual(['QUALIFIED', 2, 0]);
    expect(summary(offer(lines, 'any-2-shorts-kids'))).toEqual(['ONE_AWAY', 1, 1]);
  });
  it('a value that is neither "ladies" nor "kids" (or differs in case) counts for neither shorts deal', () => {
    const lines = [line(2, { '__any-2-shorts': 'any-2-shorts' }), line(2, { '__any-2-shorts': 'Ladies' })];
    expect(summary(offer(lines, 'any-2-shorts-ladies'))).toEqual(['INACTIVE', 0, 2]);
    expect(summary(offer(lines, 'any-2-shorts-kids'))).toEqual(['INACTIVE', 0, 2]);
  });
  it("the men's shorts key is a different deal from the ladies & kids one", () => {
    const lines = [line(2, { '__any-2-trouser-shorts': 'any-2-trouser-shorts' })];
    expect(summary(offer(lines, 'any-2-shorts'))).toEqual(['QUALIFIED', 2, 0]);
    expect(summary(offer(lines, 'any-2-shorts-ladies'))).toEqual(['INACTIVE', 0, 2]);
  });
  it('exact value matching still refuses an empty value', () => {
    expect(hasTrigger(line(1, { '__any-2-shorts': '' }), '__any-2-shorts', 'ladies')).toBe(false);
    expect(hasTrigger(line(1, { '__any-2-shorts': 'ladies' }), '__any-2-shorts', 'ladies')).toBe(true);
    expect(hasTrigger(line(1, { '__any-2-shorts': 'ladies' }), '__any-2-shorts', 'kids')).toBe(false);
  });
});
