import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { readIntent, standingPart } from '../src/shopper/profile.js';
import { rememberShopper } from '../src/shopper/remember.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';
import { resolveSearchIntent, type SearchArgs } from '../src/tools/searchIntent.js';

/**
 * Every argument the model has invented, each once a real customer's search:
 * a midlayer for "warm but sleeveless", size M nobody gave, £100 nobody
 * named, lightweight for a relaxed polo, navy alone from "navy or black",
 * ladies for a customer who never said. The model proposes; the customer's
 * words, what they told us, and the search they are following decide.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function garment(title: string, type: string, description: string, price = 30, sizes = ['S', 'M', 'L', 'XL']): Product {
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

const CATALOGUE = [
  garment('ARVID GILET - NAVY', 'GILETS', 'Lightweight warmth, windproof and sleeveless.', 36),
  garment('CLIMA GILET 3.0 - BLACK', 'GILETS', 'Warmth without sleeves, stretchy.', 30),
  garment('PURE MIDLAYER - BLACK', 'MIDLAYERS', 'Lightweight, with warmth for cooler days.', 28),
  garment('STEALTH MIDLAYER - NAVY', 'MIDLAYERS', 'Breathable with brushed warmth.', 30),
  garment('ELITE POLO - NAVY', 'POLOS', 'Breathable and lightweight, slim cut.', 20),
  garment('ELITE POLO - BLACK', 'POLOS', 'Breathable and lightweight, slim cut.', 20),
  garment('BLOCK PIQUE POLO - RED', 'POLOS', 'Breathable with a regular fit.', 14),
  garment('GOLF TEE POLO - NAVY', 'POLOS', 'Breathable with a relaxed fit.', 24),
  garment('PREMIUM POLO - WHITE', 'POLOS', 'Soft cotton with a relaxed fit.', 90),
  garment('LADIES ELITE POLO - NAVY', 'LADIES POLOS', 'Breathable and lightweight.', 12, ['8', '10', '12']),
  garment('TEX RAIN JACKET - BLACK', 'RAIN JACKET', 'Fully waterproof, taped seams.', 68),
  garment('CLIMA JACKET - NAVY', 'JACKETS', 'Warm and stretchy.', 34),
];

beforeEach(() => {
  setCatalogueForTests(CATALOGUE);
  setDealsForTests([]);
});

async function customer(...said: string[]) {
  const id = `intent-${Math.random()}`;
  await sessions.getOrCreate(id);
  for (const text of said) await rememberShopper(id, standingPart(readIntent(text)));
  return id;
}

async function resolve(args: SearchArgs, utterance: string, id?: string) {
  const session = await sessions.getOrCreate(id ?? (await customer()));
  return resolveSearchIntent(args, { session, utterance }, readIntent(utterance));
}

async function search(args: object, utterance: string, id?: string) {
  const session = await sessions.getOrCreate(id ?? (await customer()));
  const result = await runTool('search_products', args, { session, utterance });
  const titles = result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : [];
  return { result, titles };
}

const rejectedFields = (intent: Awaited<ReturnType<typeof resolve>>) => intent.rejected.map((entry) => entry.field);

describe('category', () => {
  it('invented: "warm but sleeveless" with category midlayer - not a rule, gilets stay in', async () => {
    const said = 'I want something warm but sleeveless for a cold morning';
    const intent = await resolve({ query: 'warm sleeveless', category: 'midlayer' }, said);
    expect(intent.categories).toBeUndefined();
    expect(rejectedFields(intent)).toContain('category');
    expect(intent.weather).toContain('cold');
    expect(intent.concepts).toContain('gilet');
    const { titles } = await search({ query: 'warm sleeveless', category: 'midlayer' }, said);
    expect(titles.some((t) => /GILET/.test(t))).toBe(true);
  });

  it('invented in the query words too - "midlayer sleeveless warm" is searched without the midlayer', async () => {
    const intent = await resolve({ query: 'midlayer sleeveless warm' }, 'I want something warm but sleeveless for a cold morning');
    expect(intent.categories).toBeUndefined();
    expect(intent.query).toBe('sleeveless warm');
  });

  it('explicit: "Show me a warm midlayer" - midlayer is the rule', async () => {
    const intent = await resolve({ query: 'warm midlayer', category: 'midlayer' }, 'Show me a warm midlayer');
    expect(intent.categories).toEqual({ value: ['midlayer'], source: 'utterance', strength: 'hard' });
    const { titles } = await search({ query: 'warm midlayer', category: 'midlayer' }, 'Show me a warm midlayer');
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => /MIDLAYER/.test(t))).toBe(true);
  });

  it('carried by a follow-up to the search on screen, never into a new request', async () => {
    const id = await customer();
    await search({ query: 'jacket', category: 'jacket' }, 'Show me a jacket', id);
    const another = await resolve({ query: 'jacket', category: 'jacket' }, 'Show me another one', id);
    expect(another.categories).toMatchObject({ value: ['jacket'], source: 'conversation' });
    const fresh = await resolve({ query: 'warm sleeveless', category: 'jacket' }, 'I want something warm but sleeveless for a cold morning', id);
    expect(fresh.categories).toBeUndefined();
  });
});

describe('size', () => {
  it('invented: size M with no size given - ignored', async () => {
    const intent = await resolve({ query: 'polo', size: 'M' }, 'Show me a polo');
    expect(intent.size).toBeUndefined();
    expect(rejectedFields(intent)).toContain('size');
  });

  it('explicit: "a navy polo in XL" - XL is the rule', async () => {
    const intent = await resolve({ query: 'navy polo', size: 'XL' }, 'Show me a navy polo in XL');
    expect(intent.size).toMatchObject({ value: 'XL', source: 'utterance' });
  });
});

describe('budget', () => {
  it('invented: maxPrice 100 with no budget named - ignored, the £90 polo stays', async () => {
    const intent = await resolve({ query: 'relaxed polo', maxPrice: 100 }, 'I want a relaxed-fit polo');
    expect(intent.maxPrice).toBeUndefined();
    expect(rejectedFields(intent)).toContain('maxPrice');
  });

  it('explicit: "a polo under £50" - £50 is the rule', async () => {
    const intent = await resolve({ query: 'polo', maxPrice: 50 }, 'Show me a polo under £50');
    expect(intent.maxPrice).toMatchObject({ value: 50, source: 'utterance' });
    const { titles } = await search({ query: 'polo', maxPrice: 50 }, 'Show me a polo under £50');
    expect(titles).not.toContain('PREMIUM POLO - WHITE');
  });

  it('remembered: a budget they gave earlier still counts', async () => {
    const id = await customer('keep polos under £50');
    const intent = await resolve({ query: 'polo', maxPrice: 50 }, 'Show me a polo', id);
    expect(intent.maxPrice).toMatchObject({ value: 50, source: 'profile' });
  });
});

describe('features', () => {
  it('invented: lightweight for "a relaxed-fit polo" - not required', async () => {
    const intent = await resolve({ query: 'polo', features: ['lightweight'] }, 'I want a relaxed-fit polo');
    expect(intent.features.value).toEqual([]);
    expect(rejectedFields(intent)).toContain('features');
    const { titles } = await search({ query: 'polo', features: ['lightweight'] }, 'I want a relaxed-fit polo');
    // The Golf Tee Polo is relaxed but its description never says lightweight: it is not filtered out.
    expect(titles).toContain('GOLF TEE POLO - NAVY');
  });

  it('explicit: "a lightweight polo" - lightweight required', async () => {
    const intent = await resolve({ query: 'polo', features: ['lightweight'] }, 'Show me a lightweight polo');
    expect(intent.features.value).toEqual(['lightweight']);
  });

  it('derived: "something lighter" is lightweight; "rain protection" needs waterproof', async () => {
    expect((await resolve({ query: 'polo', features: ['lightweight'] }, 'Something lighter.')).features.value).toEqual(['lightweight']);
    expect((await resolve({ query: 'rain jacket', features: ['waterproof'] }, 'I need rain protection for golf')).features.value).toContain('waterproof');
  });
});

describe('colour', () => {
  it('"navy or black" remembered, the model sends navy: still navy or black, as a preference', async () => {
    const id = await customer('I mostly wear navy or black');
    const intent = await resolve({ query: 'polo', colour: 'navy' }, 'Show me a polo', id);
    expect(intent.colour).toMatchObject({ value: 'navy or black', source: 'profile' });
    const { result } = await search({ query: 'polo', colour: 'navy' }, 'Show me a polo', id);
    expect(result.facts).toMatch(/navy or black is a preference/);
  });

  it('explicit: "show me a red polo" - red is the rule', async () => {
    const intent = await resolve({ query: 'red polo', colour: 'red' }, 'show me a red polo');
    expect(intent.colour).toMatchObject({ value: 'red', source: 'utterance' });
    const { titles } = await search({ query: 'red polo', colour: 'red' }, 'show me a red polo');
    expect(titles).toEqual(['BLOCK PIQUE POLO - RED']);
  });

  it('invented: white "for summer" when no colour was named - not a filter', async () => {
    const intent = await resolve({ query: 'polo', colour: 'white' }, 'I need a polo for summer');
    expect(intent.colour).toBeUndefined();
    expect(rejectedFields(intent)).toContain('colour');
  });

  it('carried by a follow-up: "another one" after a navy search stays navy', async () => {
    const id = await customer();
    await search({ query: 'navy polo', colour: 'navy' }, 'Show me a navy polo', id);
    const intent = await resolve({ query: 'polo', colour: 'navy' }, 'Another one', id);
    expect(intent.colour).toMatchObject({ value: 'navy', source: 'conversation' });
  });
});

describe('range', () => {
  it('invented: ladies when no range was said - ignored', async () => {
    const intent = await resolve({ query: 'polo', range: 'ladies' }, 'Show me a polo');
    expect(intent.range).toBeUndefined();
    expect(rejectedFields(intent)).toContain('range');
  });

  it('explicit: "a ladies polo" - ladies is the rule', async () => {
    const intent = await resolve({ query: 'polo', range: 'ladies' }, 'Show me a ladies polo');
    expect(intent.range).toMatchObject({ value: 'women', source: 'utterance' });
  });

  it('an invented range is never remembered as theirs', async () => {
    const id = await customer();
    await search({ query: 'polo', range: 'mens' }, 'Show me a polo', id);
    const session = await sessions.getOrCreate(id);
    expect(session.preferences.audience).toBeUndefined();
  });
});

describe('product name', () => {
  it('invented: a name for a description is not checked as a name - no "we do not stock"', async () => {
    const intent = await resolve({ query: 'rain jacket', productName: 'Rain Pro Jacket' }, 'I need something for the rain');
    expect(intent.productName).toBeUndefined();
    const { result } = await search({ query: 'rain jacket', productName: 'Rain Pro Jacket' }, 'I need something for the rain');
    expect(result.speech).not.toMatch(/We do not stock/);
  });

  it('named, misspelt or not, is checked', async () => {
    expect((await resolve({ query: 'Galatic midlayer', productName: 'Galatic midlayer' }, 'Do you have the Galatic midlayer?')).productName).toMatchObject({ source: 'utterance' });
    expect((await resolve({ query: 'elite polo', productName: 'Elite Polo' }, 'show me the elite pollo')).productName).toMatchObject({ source: 'utterance' });
  });

  it('named earlier in the conversation: "do you have it in black?"', async () => {
    const id = await customer();
    const session = await sessions.getOrCreate(id);
    await sessions.patch(id, { messages: [...session.messages, { id: 'm1', role: 'user', text: 'Show me the Elite Polo', createdAt: new Date().toISOString() }] });
    const intent = await resolve({ query: 'Elite Polo', productName: 'Elite Polo', colour: 'black' }, 'Do you have it in black?', id);
    expect(intent.productName).toMatchObject({ source: 'conversation' });
  });
});

describe('what the readers cannot read is never a rule', () => {
  const said = 'Quiero una chaqueta azul impermeable, menos de cien';
  const proposal: SearchArgs = { query: 'jacket', category: 'jacket', colour: 'blue', maxPrice: 100, features: ['waterproof'], range: 'mens', size: 'M' };

  it('category, range, colour and features are hints; budget and size are ignored', async () => {
    const intent = await resolve(proposal, said);
    expect(intent.verifiable).toBe(false);
    expect(intent.categories).toBeUndefined();
    expect(intent.range).toBeUndefined();
    expect(intent.maxPrice).toBeUndefined();
    expect(intent.size).toBeUndefined();
    expect(intent.features.value).toEqual([]);
    expect(intent.hints.features).toEqual(['waterproof']);
    expect(intent.colour).toMatchObject({ value: 'blue', strength: 'preference' });
    const by = Object.fromEntries(intent.rejected.map((entry) => [entry.field, entry.disposition]));
    expect(by).toMatchObject({ category: 'soft', colour: 'soft', features: 'soft', maxPrice: 'ignored', size: 'rejected' });
    expect(intent.rejected.find((entry) => entry.field === 'category')?.reason).toBe('tool-only; customer language not verified');
  });

  it('on the catalogue: nothing is filtered out, the proposed colour and kind just come first', async () => {
    const { titles, result } = await search(proposal, said);
    expect(titles.length).toBeGreaterThan(0);
    // No £100 ceiling, no jacket rule, no waterproof rule, no blue filter: browsing, not a narrowed search.
    expect(result.facts ?? '').not.toMatch(/Every result is in blue/);
    expect(result.facts ?? '').not.toMatch(/Nothing matched under/);
    // The Clima Jacket is navy and says nothing of waterproofing: neither a blue nor a waterproof rule holds it back.
    expect(titles).toContain('CLIMA JACKET - NAVY');
  });

  it('"quiero un polo azul": the model\'s colour ranks first, other colours are not excluded', async () => {
    const intent = await resolve({ query: 'polo', colour: 'navy', category: 'polo' }, 'Quiero un polo azul');
    expect(intent.colour).toMatchObject({ strength: 'preference', source: 'tool' });
    const { result } = await search({ query: 'polo', colour: 'navy', category: 'polo' }, 'Quiero un polo azul');
    expect(result.facts).toMatch(/navy is a preference, not a rule/);
  });

  it('remembered evidence still counts in any language: their own budget and colours', async () => {
    const id = await customer('keep polos under £50', 'I mostly wear navy or black');
    const intent = await resolve({ query: 'polo', maxPrice: 50, colour: 'navy' }, 'Quiero un polo', id);
    expect(intent.maxPrice).toMatchObject({ value: 50, source: 'profile' });
    expect(intent.colour).toMatchObject({ value: 'navy or black', source: 'profile', strength: 'hard' });
  });

  it('a size the model proposed is still ignored', async () => {
    const intent = await resolve({ query: 'polo', size: 'M' }, 'Quiero un polo azul');
    expect(intent.size).toBeUndefined();
  });
});

describe('normalised customer words are evidence', () => {
  it('English typed in Urdu letters is read as the English it is', async () => {
    const intent = await resolve({ query: 'navy polo', colour: 'navy', category: 'polo' }, 'شو می اے نیوی پولو');
    expect(intent.evidence).toBe('Show me a navy polo');
    expect(intent.verifiable).toBe(true);
    expect(intent.categories).toMatchObject({ value: ['polo'], source: 'utterance' });
    expect(intent.colour).toMatchObject({ value: 'navy', source: 'utterance', strength: 'hard' });
  });

  it('genuine Urdu has no English normalisation: it stays unread, and proposals stay hints', async () => {
    const intent = await resolve({ query: 'navy polo', colour: 'navy', category: 'polo' }, 'مجھے نیوی پولو دکھاؤ');
    expect(intent.verifiable).toBe(false);
    expect(intent.categories).toBeUndefined();
    expect(intent.colour).toMatchObject({ strength: 'preference' });
  });

  it('the voice path hands over its normalised text as the utterance: "Show me a navy polo in XL"', async () => {
    const intent = await resolve({ query: 'navy polo', colour: 'navy', size: 'XL' }, 'Show me a navy polo in XL');
    expect(intent).toMatchObject({ categories: { value: ['polo'] }, colour: { value: 'navy', strength: 'hard' }, size: { value: 'XL' } });
  });
});

describe('product names nobody gave', () => {
  it('never become "we do not stock", in English or not', async () => {
    for (const said of ['I need something for the rain', 'Necesito algo para la lluvia']) {
      const { result } = await search({ query: 'Rain Pro Jacket', productName: 'Rain Pro Jacket' }, said);
      expect(result.speech, said).not.toMatch(/We do not stock/);
      expect(result.facts ?? '', said).not.toMatch(/nothing in the Druids catalogue is called/);
    }
  });

  it('a name the customer said is checked, in any language', async () => {
    const intent = await resolve({ query: 'Elite Polo', productName: 'Elite Polo' }, '¿Tienen el Elite Polo?');
    expect(intent.productName).toMatchObject({ value: 'Elite Polo', source: 'utterance' });
    const { result } = await search({ productName: 'Elite Polo' }, 'Do you have the Elite Polo?');
    expect(result.facts).toMatch(/Druids stocks the Elite Polo design/);
  });
});

describe('arguments chosen directly, with no model in between', () => {
  it('are trusted, as a UI action is', async () => {
    const session = await sessions.getOrCreate(await customer());
    const intent = resolveSearchIntent({ query: 'polo', category: 'polo', range: 'ladies', maxPrice: 30 }, { session, direct: true }, readIntent(''));
    expect(intent).toMatchObject({ categories: { source: 'ui' }, range: { value: 'women', source: 'ui' }, maxPrice: { value: 30, source: 'ui' } });
  });
});

describe('"relaxed-fit" is "relaxed fit"', () => {
  it.each([
    ['I want a relaxed-fit polo', 'relaxed'],
    ['something slim-fit please', 'tight'],
    ['a regular-fit polo', 'regular'],
    ['tailored-fit trousers', 'tight'],
    ['I want a relaxed fit polo', 'relaxed'],
  ])('%s', (said, fit) => {
    expect(readIntent(said).fit).toBe(fit);
  });

  it('a hyphen elsewhere changes nothing', () => {
    expect(readIntent('a quarter-zip midlayer').fit).toBeUndefined();
  });
});

describe('a proposal that is not a feature at all', () => {
  it('"relaxed" is dropped, the search still runs, and "relaxed-fit" leads with a relaxed cut', async () => {
    const intent = await resolve({ query: 'polo', features: ['relaxed'] }, 'I want a relaxed-fit polo');
    expect(intent.rejected).toContainEqual(expect.objectContaining({ field: 'features', value: ['relaxed'], disposition: 'ignored' }));
    // As the chat loop does before any tool runs: what they said is remembered first.
    const id = await customer('I want a relaxed-fit polo');
    const { titles, result } = await search({ query: 'polo', features: ['relaxed'] }, 'I want a relaxed-fit polo', id);
    expect(result.speech).not.toMatch(/could not use/);
    expect(['GOLF TEE POLO - NAVY', 'PREMIUM POLO - WHITE']).toContain(titles[0]);
  });
});
