import { beforeEach, describe, expect, it } from 'vitest';
import type { CaddieAttachment, Product } from '@caddie/shared';
import { verifyReply, withoutClaims } from '../../src/ai/verify.js';
import { setDealsForTests } from '../../src/catalog/bundles.js';
import { needsSaid, suitsNeed } from '../../src/catalog/suitability.js';
import { setCatalogueForTests } from '../../src/catalog/sync.js';
import { env } from '../../src/env.js';
import { sessions } from '../../src/session/store.js';
import { readIntent } from '../../src/shopper/profile.js';
import { runTool } from '../../src/tools/index.js';
import { readCustomerTurn } from '../../src/ai/turn.js';
import { currentShoppingIntent } from '../../src/shopper/facts.js';

/**
 * V1 hardening task 4: a catalogue fact never becomes a suitability claim
 * the catalogue does not make. A cap described as lightweight and
 * breathable was called "good for cooler weather"; water-resistant was
 * upgraded to waterproof; "not stated" was said as "no". One decision
 * (catalog/suitability.ts suitsNeed) now gates search, answers product
 * questions and holds the reply to the same truth.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function item(title: string, type: string, description: string | null, sizes = ['S', 'M', 'L', 'XL'], price = 30): Product {
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND],
    price: { amount: price, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size) => ({ id: `${title}-${size}`, title: size, available: true, price: { amount: price, currency: 'GBP' }, options: { Size: size } })),
    description,
  };
}

const ONE = ['One Size'];
const LIGHT_CAP = item('BREEZE CAP - NAVY', 'CAPS', 'A lightweight and breathable golf cap.', ONE);
const COSY_CAP = item('COMFORT CAP - GREY', 'CAPS', 'Comfortable on chilly early starts, with a classic look.', ONE);
const WINTER_CAP = item('ARCTIC CAP - BLACK', 'CAPS', 'A thermal cap with a fleece lining.', ONE);
const STORM = item('STORM JACKET - BLACK', 'JACKETS', 'Fully waterproof with taped seams. Breathable.', undefined, 60);
const TEMPEST = item('TEMPEST JACKET - RED', 'JACKETS', 'Waterproof and windproof.', undefined, 80);
const DRIZZLE = item('DRIZZLE JACKET - NAVY', 'JACKETS', 'A water-resistant shell for changeable days.', undefined, 20);
const SOFTSHELL = item('ARCHER JACKET - GREY', 'JACKETS', 'A smart softshell. This is not waterproof.');
const AIR_POLO = item('AIR POLO - WHITE', 'POLOS', 'Lightweight and breathable.');
const AIR_POLO_NAVY = item('AIR POLO - NAVY', 'POLOS', 'Lightweight and breathable.');
const CLUB_POLO = item('CLUB POLO - NAVY', 'POLOS', 'A classic club polo.');
const EVERYTHING = [LIGHT_CAP, COSY_CAP, WINTER_CAP, STORM, TEMPEST, DRIZZLE, SOFTSHELL, AIR_POLO, AIR_POLO_NAVY, CLUB_POLO];

beforeEach(() => {
  setCatalogueForTests(EVERYTHING);
  setDealsForTests([]);
});

let id = '';
beforeEach(async () => {
  id = `suit-${Math.random()}`;
  await sessions.getOrCreate(id);
});

async function search(args: Record<string, unknown>, utterance: string) {
  const session = await sessions.getOrCreate(id);
  const result = await runTool('search_products', args, { session, utterance });
  const products = result.attachment?.kind === 'products' ? result.attachment.products : [];
  return { result, titles: products.map((product) => product.title) };
}

async function askAbout(product: Product, utterance: string) {
  await sessions.patch(id, {
    lastShown: { kind: 'products', items: [{ id: product.id, title: product.title }] },
    activeShoppingContext: { kinds: [], productId: product.id, request: '', turn: 1, source: 'explicit' as const },
  });
  const session = await sessions.getOrCreate(id);
  return runTool('product_info', { question: utterance }, { session, utterance });
}

const cards = (products: Product[]): CaddieAttachment => ({ kind: 'products', products });
const evidenceOf = (products: Product[]) => products.map((product) => `${product.title} - £30.00`).join('\n');
const check = (reply: string, products: Product[]) => verifyReply(reply, evidenceOf(products), cards(products));
const claims = (reply: string, products: Product[]) => check(reply, products).map((violation) => `${violation.kind}:${violation.claim}`);

describe('the suitability decision', () => {
  it('1. lightweight and breathable is not cold-weather suitability', () => {
    expect(suitsNeed(LIGHT_CAP, 'cold')).toMatchObject({ verdict: 'unknown', evidence: [] });
    expect(suitsNeed(LIGHT_CAP, 'hot')).toMatchObject({ verdict: 'yes', evidence: ['lightweight', 'breathable'] });
  });

  it('3. thermal or fleece is', () => {
    expect(suitsNeed(WINTER_CAP, 'cold')).toMatchObject({ verdict: 'yes', evidence: ['warm'] });
  });

  it('4-5. waterproof suits rain as waterproof; water-resistant suits rain as water-resistant, never as waterproof', () => {
    expect(suitsNeed(STORM, 'wet')).toMatchObject({ verdict: 'yes', evidence: ['waterproof'] });
    expect(suitsNeed(DRIZZLE, 'wet')).toMatchObject({ verdict: 'yes', evidence: ['water-resistant'] });
    expect(suitsNeed(SOFTSHELL, 'wet')).toMatchObject({ verdict: 'unknown' });
  });

  it('7. not stated is not a no', () => {
    expect(suitsNeed(CLUB_POLO, 'hot').verdict).toBe('unknown');
    expect(suitsNeed(CLUB_POLO, 'cold').verdict).toBe('unknown');
  });

  it('11. "that looks cool" is not weather; "cooler weather" and "warmer" are', () => {
    expect(needsSaid('that looks cool, show me polos').needs).toEqual([]);
    expect(readIntent('that looks cool').weather).toBeUndefined();
    expect(needsSaid('something for cooler weather').needs).toEqual(['cold']);
    expect(needsSaid('do you have a warmer cap?').needs).toEqual(['cold']);
    expect(needsSaid('have you got a body warmer?').needs).toEqual([]);
    expect(needsSaid('something breathable for summer').needs).toEqual(['hot']);
    expect(needsSaid('ideally something for the rain').hard).toBe(false);
  });
});

describe('search: a need asked for is a rule', () => {
  it('1, 3, 8. caps for cold weather: the thermal cap, never the lightweight one nor the one whose blurb mentions chilly starts', async () => {
    const { result, titles } = await search({ query: 'cap cold weather' }, 'Show me caps for cold weather.');
    expect(titles).toEqual([WINTER_CAP.title]);
    expect(result.facts).toMatch(/for cold weather its description states warm/);
  });

  it('9. no cap states warmth: said truthfully, nothing shown as if it did', async () => {
    setCatalogueForTests([LIGHT_CAP, COSY_CAP, AIR_POLO]);
    const { result, titles } = await search({ query: 'cap cold weather' }, 'Do you have a warmer cap for cold weather?');
    expect(titles).toEqual([]);
    expect(result.attachment).toBeUndefined();
    expect(result.speech).toMatch(/I can't confirm any caps are designed for cold weather from the product information I have/);
    expect(result.speech).toMatch(/anyway\?/);
    expect(result.facts).toMatch(/informational only/);
    expect(result.facts).toContain(LIGHT_CAP.title);
    expect(result.facts).toMatch(/BREEZE CAP - NAVY \[[^\]]+\] \| description states: breathable, lightweight/);
    expect(result.facts).toMatch(/COMFORT CAP - GREY \[[^\]]+\] \| description states no technical features/);
  });

  it('9b. "show them anyway" lifts the rule', async () => {
    setCatalogueForTests([LIGHT_CAP, COSY_CAP, AIR_POLO]);
    const { titles } = await search({ query: 'cap' }, 'Yes, show me the caps anyway.');
    expect(titles.sort()).toEqual([COSY_CAP.title, LIGHT_CAP.title].sort());
  });

  it('4-5. waterproof jackets: the waterproof one only - water-resistant is not waterproof', async () => {
    const { titles } = await search({ query: 'waterproof jacket' }, 'Show me waterproof jackets.');
    expect(titles.sort()).toEqual([STORM.title, TEMPEST.title].sort());
  });

  it('6. water-resistant jackets: the water-resistant one and the waterproof one, each by its own word', async () => {
    const { result, titles } = await search({ query: 'water-resistant jacket' }, 'Show me water-resistant jackets.');
    expect(titles.sort()).toEqual([DRIZZLE.title, STORM.title, TEMPEST.title].sort());
    expect(result.facts).toMatch(/DRIZZLE JACKET[^\n]*for wet weather its description states water-resistant/);
    expect(result.facts).toMatch(/STORM JACKET[^\n]*for wet weather its description states waterproof/);
  });

  it('6b. "for the rain" asks for waterproof (the customer reader): the water-resistant jacket is not shown as meeting it', async () => {
    const { titles } = await search({ query: 'jacket rain' }, 'Show me jackets for the rain.');
    expect(titles.sort()).toEqual([STORM.title, TEMPEST.title].sort());
  });

  it('10. something breathable for summer: verified breathable, lightweight evidence - never the plain polo', async () => {
    const { result, titles } = await search({ query: 'breathable polo' }, 'Show me something breathable for summer.');
    // "Something": no kind, so every breathable garment qualifies - and only those.
    expect(titles).toContain(AIR_POLO.title);
    expect(titles).not.toContain(CLUB_POLO.title);
    expect(titles.every((title) => suitsNeed(EVERYTHING.find((product) => product.title === title)!, 'hot').evidence.includes('breathable'))).toBe(true);
    expect(result.facts).toMatch(/AIR POLO[^\n]*for hot weather its description states lightweight and breathable/);
  });

  it('11. "that looks cool" filters nothing', async () => {
    const { titles } = await search({ query: 'polo' }, 'That looks cool. Show me polos.');
    expect(titles.sort()).toEqual([AIR_POLO.title, AIR_POLO_NAVY.title, CLUB_POLO.title].sort());
  });
});

describe('product questions: answered from the description, not stated is not a no', () => {
  it('5. "Is this waterproof?" of a water-resistant jacket: no upgrade', async () => {
    const result = await askAbout(DRIZZLE, 'Is this waterproof?');
    expect(result.speech).toMatch(/description says water-resistant, not waterproof/);
    expect(result.speech).not.toMatch(/^Yes/);
  });

  it('6. "Is this water-resistant?": yes, in its own word', async () => {
    const result = await askAbout(DRIZZLE, 'Is this water-resistant?');
    expect(result.speech).toMatch(/^Yes - the Drizzle Jacket - Navy is described as water-resistant\./);
  });

  it('7. "Is it insulated?" with nothing stated: not stated, never no', async () => {
    const result = await askAbout(LIGHT_CAP, 'Is it insulated?');
    expect(result.speech).toMatch(/doesn't state that it's insulated/);
    expect(result.speech).not.toMatch(/^No\b/);
    expect(result.facts).toMatch(/insulated - not stated \(never say no\)/);
  });

  it('7b. "Will this keep me warm?" of the lightweight cap: not stated', async () => {
    const result = await askAbout(LIGHT_CAP, 'Will this keep me warm?');
    expect(result.speech).toMatch(/doesn't state that it's warm/);
    expect(result.speech).not.toMatch(/cooler|good for/i);
  });

  it('"Is this good for winter?": from what it states for cold weather, or that it states nothing', async () => {
    const cold = await askAbout(WINTER_CAP, 'Is this good for winter?');
    expect(cold.speech).toMatch(/is described as warm, which is what cold weather calls for/);
    const light = await askAbout(LIGHT_CAP, 'Is this good for winter?');
    expect(light.speech).toMatch(/doesn't state anything for cold weather - nothing about warmth, insulation or windproofing/);
    expect(light.facts).toMatch(/cold weather - not supported/);
  });

  it('an explicit "not waterproof" is a no, and the facts say so the same way', async () => {
    const result = await askAbout(SOFTSHELL, 'Is this waterproof?');
    expect(result.speech).toMatch(/^No - the Archer Jacket - Grey's description says it isn't waterproof/);
    expect(result.facts).toMatch(/waterproof - no, its description says it is not/);
  });

  it('15. "Is this breathable?" of the Air Polo: yes', async () => {
    const result = await askAbout(AIR_POLO, 'Is this breathable?');
    expect(result.speech).toMatch(/^Yes - the Air Polo - White is described as breathable\./);
  });
});

describe('the reply checker: a weather verdict is a claim', () => {
  it('2. "good for cooler weather" of the lightweight cap is caught', () => {
    expect(claims('The Breeze Cap is lightweight and breathable, so good for cooler weather.', [LIGHT_CAP])).toContain('attribute:suited to cold weather');
  });

  it('12. "will keep you warm" is caught', () => {
    const found = claims('The Breeze Cap will keep you warm on the course.', [LIGHT_CAP]);
    expect(found).toContain('attribute:suited to cold weather');
    expect(found).toContain('attribute:warm');
  });

  it('13. "good for winter" is caught; of the thermal cap it stands', () => {
    expect(claims('The Breeze Cap is good for winter.', [LIGHT_CAP])).toContain('attribute:suited to cold weather');
    expect(claims('The Arctic Cap is good for winter.', [WINTER_CAP])).toEqual([]);
    expect(claims('The Arctic Cap will keep you warm.', [WINTER_CAP])).toEqual([]);
  });

  it('14. "fully waterproof" of the water-resistant jacket is caught; "water-resistant" stands', () => {
    expect(claims('The Drizzle Jacket is fully waterproof.', [DRIZZLE])).toContain('attribute:waterproof');
    expect(claims('The Drizzle Jacket is water-resistant.', [DRIZZLE])).toEqual([]);
    expect(claims('The Storm Jacket is waterproof, good for rain.', [STORM])).toEqual([]);
  });

  it('14b. of the water-resistant jacket: "for light showers" stands, "for the rain" and "keeps you dry" are waterproof claims', () => {
    // Its description states water-resistant, which is what wet weather calls for; "for the rain" and "keeps you dry" are read as waterproof, which it does not state.
    expect(claims('The Drizzle Jacket is water-resistant, for showers.', [DRIZZLE])).toEqual([]);
    expect(claims('The Drizzle Jacket is for the rain.', [DRIZZLE])).toContain('attribute:waterproof');
    expect(claims('The Drizzle Jacket keeps you dry.', [DRIZZLE])).toContain('attribute:waterproof');
  });

  it('15. a factual "breathable" of the Air Polo stands; "great for hot weather" of the plain polo does not', () => {
    expect(claims('The Air Polo is breathable.', [AIR_POLO])).toEqual([]);
    expect(claims('The Club Polo is great for hot weather.', [CLUB_POLO])).toContain('attribute:suited to hot weather');
  });

  it('a truthful "I can\'t confirm" and a question claim nothing', () => {
    expect(claims("I can't confirm any of these caps are designed for cold weather from the product information I have. Would you like to see them anyway?", [LIGHT_CAP, COSY_CAP])).toEqual([]);
  });

  it('the last resort drops the sentence with the verdict and keeps the facts', () => {
    const reply = 'The Breeze Cap is lightweight and breathable. It is good for cooler weather. Would you like it?';
    const violations = check(reply, [LIGHT_CAP]);
    expect(withoutClaims(reply, violations)).toBe('The Breeze Cap is lightweight and breathable. Would you like it?');
  });

  it('16. a pack: the condition name is not a claim, and a feature invented for a piece is caught', () => {
    const pack: CaddieAttachment = { kind: 'pack', recommendation: { items: [LIGHT_CAP, AIR_POLO, DRIZZLE], total: { amount: 99, currency: 'GBP' }, reason: '', overBudget: false } };
    const evidence = `AMBASSADOR PACK - COOL & WET - £99.00\n- CAP: ${LIGHT_CAP.title}\n- POLO: ${AIR_POLO.title}\n- JACKET: ${DRIZZLE.title}`;
    expect(verifyReply('The Cool & Wet Ambassador Pack is 3 pieces for £99.00. What top size do you wear?', evidence, pack)).toEqual([]);
    expect(verifyReply('The Warm Rounds Ambassador Pack is 3 pieces for £99.00.', evidence, pack)).toEqual([]);
    expect(verifyReply('The Cool & Wet pack has a waterproof Drizzle Jacket.', evidence, pack).map((v) => `${v.kind}:${v.claim}`)).toContain('attribute:waterproof');
    expect(verifyReply('The Breeze Cap in the pack will keep you warm.', evidence, pack).map((v) => `${v.kind}:${v.claim}`)).toContain('attribute:suited to cold weather');
    // The Drizzle Jacket's own word stands.
    expect(verifyReply('The Drizzle Jacket in it is water-resistant.', evidence, pack)).toEqual([]);
  });
});

/* ---------------- closure: paraphrased conclusions, and a need that lasts the mission ---------------- */

describe('the reply checker: however the conclusion is put', () => {
  const attributes = (reply: string, products: Product[]) => check(reply, products).filter((v) => v.kind === 'attribute').map((v) => v.claim);

  it.each([
    'a solid choice when the temperature drops',
    'a sensible winter option',
    'should work well on colder days',
    'stays warm on frosty mornings',
    'a nice option for the chilly early starts',
    'performs well in cold conditions',
    'useful in winter',
  ])('1. cold, unsupported: "%s" of the lightweight cap is caught', (phrase) => {
    expect(attributes(`The Breeze Cap is ${phrase}.`, [LIGHT_CAP])).toContain('suited to cold weather');
    // Carried subject: the cap is what the second sentence is about.
    expect(attributes(`The Breeze Cap is £30. It is ${phrase}.`, [LIGHT_CAP])).toContain('suited to cold weather');
  });

  it.each(['a good bet for wet rounds', 'built for rainy days', 'handles a downpour', 'works well in the rain', 'appropriate for showery days'])(
    '2. rain, unsupported: "%s" of the softshell is caught',
    (phrase) => {
      expect(attributes(`The Archer Jacket is ${phrase}.`, [SOFTSHELL])).toContain('suited to wet weather');
    },
  );

  it('2b. "should keep you dry" of the water-resistant jacket is a waterproof claim', () => {
    expect(attributes('The Drizzle Jacket should keep you dry.', [DRIZZLE])).toContain('waterproof');
  });

  it.each(["ideal when it's hot", 'a good choice for summer rounds', 'keeps you cool in the heat', 'suited to sunny days', 'works for warm weather'])(
    '3. heat, unsupported: "%s" of the plain polo is caught',
    (phrase) => {
      expect(attributes(`The Club Polo is ${phrase}.`, [CLUB_POLO])).toContain('suited to hot weather');
    },
  );

  it('4. the same phrases of a product whose description backs them stand', () => {
    for (const phrase of ['a solid choice when the temperature drops', 'a sensible winter option', 'should work well on colder days', 'will keep you warm']) {
      expect(attributes(`The Arctic Cap is ${phrase}.`, [WINTER_CAP]), phrase).toEqual([]);
    }
    for (const phrase of ['a good bet for wet rounds', 'built for rainy days', 'should keep you dry', 'handles a downpour']) {
      expect(attributes(`The Storm Jacket is ${phrase}.`, [STORM]), phrase).toEqual([]);
    }
    for (const phrase of ["a good choice when it's hot", 'keeps you cool in the heat', 'suited to sunny days']) {
      expect(attributes(`The Air Polo is ${phrase}.`, [AIR_POLO]), phrase).toEqual([]);
    }
    // Water-resistant is what showers call for, by its own word; "wet rounds" and "the rain" read as waterproof, which it is not.
    expect(attributes('The Drizzle Jacket is fine in a passing shower.', [DRIZZLE])).toEqual([]);
    expect(attributes('The Drizzle Jacket is a good bet for wet rounds.', [DRIZZLE])).toContain('waterproof');
  });

  it('5. negated, not-confirmed and questioning wording stands', () => {
    for (const reply of [
      "I can't confirm the Breeze Cap is suitable for winter.",
      "The Breeze Cap's description doesn't say anything about cold weather.",
      'The Breeze Cap is not described as a cold-weather piece.',
      'Do you play much in the winter?',
      "You mentioned cold weather - the Breeze Cap's description states lightweight and breathable, nothing about warmth.",
      'None of our caps have features for warmth or insulation. Would you like to see the caps we have anyway?',
      'Neither the Breeze Cap nor the Comfort Cap is described for winter.',
    ]) expect(attributes(reply, [LIGHT_CAP]), reply).toEqual([]);
  });

  it('a conclusion hidden behind a negation is still a conclusion', () => {
    // "Without warmth features, suitable for sun on a summer day": the second part concludes for heat of a cap that states nothing (live replay).
    expect(attributes('The Comfort Cap is a simple cap without waterproof or warmth features, suitable for sun protection on a summer day.', [COSY_CAP])).toContain('suited to hot weather');
    expect(attributes('The Comfort Cap is not insulated, but it is a solid choice when the temperature drops.', [COSY_CAP])).toContain('suited to cold weather');
    // While a negation that covers the weather claims nothing.
    expect(attributes("The Comfort Cap isn't waterproof, so not one for the rain.", [COSY_CAP])).toEqual([]);
    expect(attributes("The Comfort Cap won't keep you dry or warm.", [COSY_CAP])).toEqual([]);
  });

  it('ordinary sales language is not a weather claim', () => {
    for (const reply of ['The Breeze Cap looks great in navy.', 'The Breeze Cap is a nice option.', 'The Breeze Cap is a popular choice. Shall I add it?']) {
      expect(check(reply, [LIGHT_CAP]), reply).toEqual([]);
    }
  });

  it("a product's own name is not weather", () => {
    const RAIN_NAMED = item('MONSOON RAIN JACKET - BLUE', 'JACKETS', 'A smart shell.');
    setCatalogueForTests([...EVERYTHING, RAIN_NAMED]);
    expect(attributes('The Monsoon Rain Jacket is £30.', [RAIN_NAMED])).toEqual([]);
    expect(attributes('The Monsoon Rain Jacket is built for rainy days.', [RAIN_NAMED])).toContain('suited to wet weather');
  });
});

describe('a need asked for outright lasts the mission', () => {
  async function turn(text: string, args: Record<string, unknown>) {
    await readCustomerTurn(id, text);
    const out = await search(args, text);
    await sessions.append(id, [
      { id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() },
      { id: `a-${Math.random()}`, role: 'assistant', text: out.result.speech, createdAt: new Date().toISOString() },
    ]);
    return out;
  }
  const WATERPROOF = [STORM.title, TEMPEST.title];
  const onlyWaterproof = (titles: string[]) => {
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((title) => WATERPROOF.includes(title))).toBe(true);
  };

  it('6. waterproof jackets -> show me more: still waterproof', async () => {
    onlyWaterproof((await turn('Show me waterproof jackets.', { query: 'waterproof jackets' })).titles);
    onlyWaterproof((await turn('Show me more.', { query: 'jackets' })).titles);
  });

  it('7. waterproof jackets -> cheaper: waterproof and cheaper, never the cheaper water-resistant one', async () => {
    onlyWaterproof((await turn('Show me waterproof jackets.', { query: 'waterproof jackets' })).titles);
    // Cheaper than the one recommended: the other waterproof jacket when it is cheaper, else a truthful nothing - never the cheap water-resistant one.
    const { titles, result } = await turn('Cheaper?', { query: 'jackets' });
    expect(result.facts).toMatch(/Price comparison/);
    expect(titles).not.toContain(DRIZZLE.title);
    expect(titles.every((title) => WATERPROOF.includes(title))).toBe(true);
    if (!titles.length) expect(result.speech).toMatch(/couldn't find anything cheaper/);
  });

  it('8. waterproof jackets -> another one: waterproof', async () => {
    onlyWaterproof((await turn('Show me waterproof jackets.', { query: 'waterproof jackets' })).titles);
    onlyWaterproof((await turn('Another one?', { query: 'jackets' })).titles);
  });

  it('9. warm caps -> show me more: only the thermal cap, or a truthful no-match', async () => {
    expect((await turn('Show me warm caps.', { query: 'warm caps' })).titles).toEqual([WINTER_CAP.title]);
    const more = await turn('Show me more.', { query: 'caps' });
    expect(more.titles.every((title) => title === WINTER_CAP.title)).toBe(true);
    if (!more.titles.length) expect(more.result.speech).toMatch(/can't confirm/);
    expect(more.titles).not.toContain(LIGHT_CAP.title);
    expect(more.titles).not.toContain(COSY_CAP.title);
  });

  it('10. a polo for hot weather -> different colours: still only polos its description backs', async () => {
    expect((await turn('Show me a polo for hot weather.', { query: 'polo hot weather' })).titles.sort()).toEqual([AIR_POLO.title, AIR_POLO_NAVY.title].sort());
    const { titles } = await turn('Different colours?', { query: 'polo' });
    expect(titles.length).toBeGreaterThan(0);
    expect(titles).not.toContain(CLUB_POLO.title);
  });

  it('11. warm caps -> "show them anyway": the requirement goes, for this turn and the next', async () => {
    expect((await turn('Show me warm caps.', { query: 'warm caps' })).titles).toEqual([WINTER_CAP.title]);
    const anyway = await turn('Show them anyway.', { query: 'caps' });
    expect(anyway.titles.sort()).toEqual([COSY_CAP.title, LIGHT_CAP.title, WINTER_CAP.title].sort());
    expect(currentShoppingIntent(await sessions.getOrCreate(id)).weather).toBeUndefined();
    const more = await turn('Show me more.', { query: 'caps' });
    expect(more.titles.length).toBe(3);
  });

  it('11b. "it doesn\'t have to be waterproof" lets the requirement go', async () => {
    onlyWaterproof((await turn('Show me waterproof jackets.', { query: 'waterproof jackets' })).titles);
    const { titles } = await turn("It doesn't have to be waterproof.", { query: 'jackets' });
    expect(titles).toContain(DRIZZLE.title);
    expect(currentShoppingIntent(await sessions.getOrCreate(id)).features?.required ?? []).toEqual([]);
  });

  it('12. waterproof jackets -> show me polos: a new mission, and the jacket requirement does not follow', async () => {
    onlyWaterproof((await turn('Show me waterproof jackets.', { query: 'waterproof jackets' })).titles);
    const { titles } = await turn('Show me polos.', { query: 'polos' });
    expect(titles.sort()).toEqual([AIR_POLO.title, AIR_POLO_NAVY.title, CLUB_POLO.title].sort());
    const now = currentShoppingIntent(await sessions.getOrCreate(id));
    expect(now.weather).toBeUndefined();
    expect(now.features).toBeUndefined();
  });

  it('a softened need only ranks: "ideally something for the rain" holds nothing', async () => {
    const { titles } = await turn('Show me jackets, ideally something for the rain.', { query: 'jackets' });
    expect(titles).toContain(SOFTSHELL.title);
    expect(currentShoppingIntent(await sessions.getOrCreate(id)).weather).toBeUndefined();
  });
});
