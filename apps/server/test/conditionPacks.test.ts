import { beforeEach, describe, expect, it } from 'vitest';
import { buildBundleCartItems, BundleCartError } from '@caddie/shared';
import {
  borrowEmptySteps,
  conditionPackRecipes,
  parseCountryPrices,
  parseScriptProperties,
  setDealsForTests,
  type DealRecipe,
} from '../src/catalog/bundles.js';
import { chooseDeal, conditionFrom, toBundleDeal } from '../src/recommend/deals.js';

/**
 * The Ambassador Pack by conditions: Warm Rounds £99.99, Mixed Conditions
 * £129.99, Cool & Wet £159.99. The Caddie only knew the £99.99 pack and
 * offered it to everyone. The template below has the shape of the preview
 * theme's page.choose-ambassador-pack-temp.json, cut down to what is read.
 */

const card = (gender: string, condition: string, title: string, gb: number, trigger: string) => ({
  type: 'condition_card',
  settings: {
    belongs_to_gender: gender,
    condition_key: condition,
    title,
    script_properties: trigger,
    bundle_prices_json: `{\n  "GB": ${gb},   // United Kingdom (also fallback)\n  "US": 250,  // USA\n}`,
  },
});

const stepSection = (gender: string, condition: string) => ({
  type: 'sport-bundle-step',
  settings: { belongs_to_gender: gender, belongs_to_condition: condition },
  blocks: {
    b: { type: 'step', settings: { step_order: 2, step_key: `${gender}-polo`, step_label: 'Polo', pick_count: 2, tab_1_collection: 'polo-3' } },
    a: { type: 'step', settings: { step_order: 1, step_key: `${gender}-jacket`, step_label: 'Jacket / Gilet', pick_count: 1, tab_1_collection: 'jackets', tab_2_collection: 'gilets' } },
  },
  block_order: ['a', 'b'],
});

const TEMPLATE = `/* Shopify comment */ ${JSON.stringify({
  sections: {
    gender: {
      type: 'sport-bundle-gender-select',
      blocks: {
        w: card('men', 'warm', 'WARM ROUNDS', 99.99, '__golf-ambassador-pack=golf-ambassador-pack'),
        m: card('men', 'mixed', 'MIXED CONDITIONS', 129.99, '__amb-mens-condition=mixed'),
        c: card('men', 'coolwet', 'COOL & WET', 159.99, '__amb-mens-condition=coolwet'),
        x: card('men', 'warm', 'NO TRIGGER', 99.99, ''),
      },
      block_order: ['w', 'm', 'c', 'x'],
    },
    s1: stepSection('men', 'warm'),
    s2: stepSection('men', 'mixed'),
    s3: stepSection('men', 'coolwet'),
  },
  order: ['gender', 's1', 's2', 's3'],
})}`;

describe('reading the condition packs from the theme', () => {
  it('reads prices with comments in them, and the checkout trigger', () => {
    expect(parseCountryPrices('{\n "GB": 129.99, // UK\n "US": 250, // USA\n}')).toEqual({ GB: 129.99, US: 250 });
    expect(parseScriptProperties('__amb-mens-condition=mixed\n\n')).toEqual({ '__amb-mens-condition': 'mixed' });
  });

  it('builds one pack per condition, with its own price, steps in order and two polo picks', () => {
    const recipes = conditionPackRecipes(TEMPLATE, 'choose-ambassador-pack-temp', 'https://www.druids.com');
    expect(recipes.map((r) => `${r.title} £${r.prices.GBP}`)).toEqual([
      'AMBASSADOR PACK - WARM ROUNDS £99.99',
      'AMBASSADOR PACK - MIXED CONDITIONS £129.99',
      'AMBASSADOR PACK - COOL & WET £159.99',
    ]);
    const mixed = recipes[1]!;
    expect(mixed.format).toBe('plus');
    expect(mixed.trigger).toEqual({ '__amb-mens-condition': 'mixed' });
    expect(mixed.steps.map((s) => s.title)).toEqual(['Jacket / Gilet', 'Polo 1', 'Polo 2']);
    expect(mixed.steps[0]!.collections).toEqual(['jackets', 'gilets']);
    expect(mixed.url).toBe('https://www.druids.com/pages/choose-ambassador-pack-temp?gender=men&condition=mixed');
  });

  it('never sells a pack with no checkout trigger - it would be charged at full price', () => {
    const recipes = conditionPackRecipes(TEMPLATE, 'p', 'https://x');
    expect(recipes.some((r) => r.conditionTitle === 'NO TRIGGER')).toBe(false);
  });
});

describe('an empty step on a condition pack', () => {
  const step = (title: string, ids: string[]) => ({ title, collection: title.toLowerCase(), productIds: new Set(ids) });
  const old: DealRecipe = {
    handle: 'golf-ambassador-pack', title: 'AMBASSADOR PACK', range: 'men', prices: { GBP: 99.99 }, dynamicPrices: false, url: '',
    steps: [step('JACKET / GILET', ['jacket-1']), step('POLO', ['polo-1'])],
  };
  const condition = (trigger: Record<string, string>): DealRecipe => ({
    handle: 'ambassador-men-x', title: 'AMBASSADOR PACK - X', range: 'men', prices: { GBP: 99.99 }, dynamicPrices: false, url: '',
    format: 'plus', trigger, steps: [step('Jacket / Gilet', []), step('Polo', ['polo-2'])],
  });

  it('is filled from the older pack it shares a checkout trigger with', () => {
    const warm = condition({ '__golf-ambassador-pack': 'golf-ambassador-pack' });
    borrowEmptySteps([warm], [old]);
    expect([...warm.steps[0]!.productIds]).toEqual(['jacket-1']);
    expect([...warm.steps[1]!.productIds]).toEqual(['polo-2']);
  });

  it('is filled from the Ambassador Pack of its range when the trigger is its own - checkout priced that at £129.99', () => {
    const mixed = condition({ '__amb-mens-condition': 'mixed' });
    borrowEmptySteps([mixed], [old]);
    expect([...mixed.steps[0]!.productIds]).toEqual(['jacket-1']);
  });

  it('is left empty when the older step is a different kind of garment', () => {
    const mixed = condition({ '__amb-mens-condition': 'mixed' });
    const unlike: DealRecipe = { ...old, steps: [step('SOCKS', ['sock-1']), step('POLO', ['polo-1'])] };
    borrowEmptySteps([mixed], [unlike]);
    expect(mixed.steps[0]!.productIds.size).toBe(0);
  });

  it('never borrows across ranges', () => {
    const mixed = { ...condition({ '__amb-mens-condition': 'mixed' }), range: 'women' as const };
    borrowEmptySteps([mixed], [old]);
    expect(mixed.steps[0]!.productIds.size).toBe(0);
  });
});

/* ---------------- Choosing which ---------------- */

const pack = (condition: 'warm' | 'mixed' | 'coolwet', price: number, range: DealRecipe['range'] = 'men'): DealRecipe => ({
  handle: `ambassador-${range}-${condition}`,
  title: `AMBASSADOR PACK - ${condition}`,
  range,
  prices: { GBP: price },
  dynamicPrices: false,
  steps: [{ title: 'Polo', collection: 'polo', productIds: new Set() }],
  url: '',
  format: 'plus',
  trigger: { '__amb-mens-condition': condition },
  condition,
  conditionTitle: condition.toUpperCase(),
});

describe('which Ambassador Pack', () => {
  beforeEach(() => setDealsForTests([pack('warm', 99.99), pack('mixed', 129.99), pack('coolwet', 159.99), pack('warm', 99.99, 'women')]));

  it('asks when nothing says which conditions, cheapest first', () => {
    const choice = chooseDeal('ambassador pack');
    expect(choice && 'ask' in choice && choice.ask.map((d) => d.condition)).toEqual(['warm', 'mixed', 'coolwet']);
  });

  it('picks from the pack name or the weather described', () => {
    const pick = (text: string, weather?: Parameters<typeof conditionFrom>[1]) => {
      const choice = chooseDeal(text, undefined, weather);
      return choice && 'deal' in choice ? choice.deal.condition : 'ask';
    };
    expect(pick('the mixed conditions pack')).toBe('mixed');
    expect(pick('cool & wet pack')).toBe('coolwet');
    expect(pick('ambassador pack for playing in the rain')).toBe('coolwet');
    expect(pick('ambassador pack for summer in Spain')).toBe('warm');
    expect(pick('ambassador pack, UK weather, bit of everything')).toBe('mixed');
    expect(pick('ambassador pack', ['wet'])).toBe('coolwet');
  });

  it('a range with only one version needs no question', () => {
    const choice = chooseDeal('ladies ambassador pack');
    expect(choice && 'deal' in choice && choice.deal.handle).toBe('ambassador-women-warm');
  });
});

/* ---------------- Into the cart ---------------- */

describe('the condition packs go into the cart the new theme way', () => {
  const pieces = [
    { variantId: '111', productId: '11', price: 60, compareAtPrice: null, handle: 'storm-jacket-black' },
    { variantId: '222', productId: '22', price: 30, compareAtPrice: null, handle: 'vento-polo-navy' },
  ];

  it('writes only the trigger, the group id, the country and the handle - no price properties', () => {
    const items = buildBundleCartItems(toBundleDeal(pack('mixed', 129.99), [null]), pieces, {
      currency: 'GBP',
      country: 'GB',
      now: 1,
      bundleId: 'abc',
    });
    expect(items).toEqual([
      {
        id: '111',
        quantity: 1,
        properties: [
          ['__Localization', 'GB'],
          ['__Product_Url', 'storm-jacket-black'],
          ['_data_bundle_id', 'abc'],
          ['__amb-mens-condition', 'mixed'],
        ],
      },
      {
        id: '222',
        quantity: 1,
        properties: [
          ['__Localization', 'GB'],
          ['__Product_Url', 'vento-polo-navy'],
          ['_data_bundle_id', 'abc'],
          ['__amb-mens-condition', 'mixed'],
        ],
      },
    ]);
    const keys = items.flatMap((item) => item.properties.map(([key]) => key));
    expect(keys.some((key) => /price|fixed|discount/i.test(key))).toBe(false);
  });

  it('refuses a pack with no trigger rather than charge full price', () => {
    const noTrigger = { ...toBundleDeal(pack('mixed', 129.99), [null]), trigger: {} };
    expect(() => buildBundleCartItems(noTrigger, pieces, { currency: 'GBP', country: 'GB', now: 1, bundleId: 'x' })).toThrow(BundleCartError);
  });
});
