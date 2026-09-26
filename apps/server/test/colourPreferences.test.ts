import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { parseColours } from '../src/catalog/colour.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { readIntent, standingPart } from '../src/shopper/profile.js';
import { rememberShopper } from '../src/shopper/remember.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * "I'm usually XL, prefer a relaxed fit, mostly navy or black, and keep polos
 * under £50", then "show me a polo": the profile held navy and black, the
 * model searched with colour navy, and black was never seen again.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function polo(title: string): Product {
  const sizes = ['S', 'M', 'L', 'XL'];
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: 'POLOS',
    tags: [...BRAND],
    price: { amount: 24, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size) => ({ id: `${title}-${size}`, title: size, available: true, price: { amount: 24, currency: 'GBP' }, options: { Size: size } })),
    description: 'Breathable and lightweight.',
  };
}

// Navy first in every list, as the live store's search order had it.
const CATALOGUE = [
  'GARDEN POLO - NAVY', 'BLOCK PIQUE POLO - NAVY', 'HONEYCOMB POLO - NAVY', 'PRIME POLO - NAVY',
  'GARDEN POLO - BLACK', 'BLOCK PIQUE POLO - BLACK', 'HONEYCOMB POLO - BLACK',
  'GARDEN POLO - WHITE', 'CLUB POLO - RED', 'CLUB POLO - GREY', 'CLUB POLO - LIGHT BLUE',
].map(polo);

beforeEach(() => {
  setCatalogueForTests(CATALOGUE);
  setDealsForTests([]);
});

const remembered = (text: string) => standingPart(readIntent(text)).colours;

async function customer(...said: string[]) {
  const id = `colours-${Math.random()}`;
  await sessions.getOrCreate(id);
  for (const text of said) await rememberShopper(id, standingPart(readIntent(text)));
  return id;
}

async function search(id: string, args: Record<string, unknown>, utterance: string) {
  const session = await sessions.getOrCreate(id);
  const result = await runTool('search_products', args, { session, utterance });
  const titles = result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : [];
  return { result, titles };
}

const colourOf = (title: string) => title.split(' - ')[1]!;

describe('several colours, remembered as several', () => {
  it('navy or black', () => {
    expect(remembered('I mostly wear navy or black')).toEqual({ words: ['navy', 'black'], strength: 'preferred' });
  });

  it('three of them', () => {
    expect(remembered('I usually wear navy, black or white')?.words).toEqual(['navy', 'black', 'white']);
    expect(parseColours('navy, black or white').colours.map((c) => c.word)).toEqual(['navy', 'black', 'white']);
  });

  it('"mostly navy and sometimes black"', () => {
    expect(remembered('mostly navy and sometimes black')?.words).toEqual(['navy', 'black']);
  });

  it('the whole opening message of the conversation that lost black', () => {
    expect(remembered("I'm usually XL, prefer a relaxed fit, mostly navy or black, and keep polos under £50.")).toEqual({
      words: ['navy', 'black'],
      strength: 'preferred',
    });
  });

  it('a colour with its own shade word is one colour, and not folded into another', () => {
    expect(parseColours('light blue and navy').colours.map((c) => c.word).sort()).toEqual(['blue', 'navy']);
    expect(parseColours('navy blue').colours.map((c) => c.word)).toEqual(['navy']);
    expect(parseColours('royal blue').colours.map((c) => c.word)).toEqual(['royal']);
  });
});

describe('a later search', () => {
  it('"show me a polo", with the model repeating navy: navy and black both preferred', async () => {
    const id = await customer('I mostly wear navy or black');
    const { result, titles } = await search(id, { query: 'polo', colour: 'navy' }, 'Show me a polo.');
    expect(titles.slice(0, 2).map(colourOf).sort()).toEqual(['BLACK', 'NAVY']);
    expect(titles.filter((t) => colourOf(t) === 'BLACK').length).toBeGreaterThan(0);
    expect(result.facts).toMatch(/navy or black is a preference, not a rule/);
    expect(result.facts).not.toMatch(/not navy \(it is black\)/);
    // A preference ranks; it never filters.
    expect(result.facts).not.toMatch(/Every result is in/);
  });

  it('with no colour passed at all, the same', async () => {
    const id = await customer('I mostly wear navy or black');
    const { titles } = await search(id, { query: 'polo' }, 'Show me a polo.');
    expect(new Set(titles.slice(0, 4).map(colourOf))).toEqual(new Set(['NAVY', 'BLACK']));
  });

  it('"another one" and "something lighter": black is still as good as navy', async () => {
    const id = await customer('I mostly wear navy or black');
    for (const utterance of ['Do you have another one?', 'Something lighter.']) {
      const { result } = await search(id, { query: 'polo', colour: 'navy' }, utterance);
      expect(result.facts, utterance).toMatch(/GARDEN POLO - BLACK \[[^\]]+\]: meets everything asked/);
    }
  });

  it('"only navy or black": both are the rule, not navy alone', async () => {
    const id = await customer('Only navy or black for me');
    const { titles } = await search(id, { query: 'polo', colour: 'navy' }, 'Show me a polo.');
    expect(titles.every((t) => ['NAVY', 'BLACK'].includes(colourOf(t)))).toBe(true);
    expect(titles.some((t) => colourOf(t) === 'BLACK')).toBe(true);
  });
});

describe('the list said in this message', () => {
  it('the opening message itself, with the model passing navy alone: black too', async () => {
    const said = "I'm usually XL, prefer a relaxed fit, mostly navy or black, and keep polos under £50.";
    const id = await customer(said);
    const { result, titles } = await search(id, { query: 'polo', colour: 'navy', size: 'XL', maxPrice: 50 }, said);
    expect(titles.slice(0, 2).map(colourOf).sort()).toEqual(['BLACK', 'NAVY']);
    expect(result.facts).toMatch(/navy or black is a preference/);
  });

  it('"a polo in navy or black", with the model passing navy: both, and only those', async () => {
    const id = await customer();
    const { titles } = await search(id, { query: 'polo', colour: 'navy' }, 'Show me a polo in navy or black');
    expect(titles.every((t) => ['NAVY', 'BLACK'].includes(colourOf(t)))).toBe(true);
    expect(titles.some((t) => colourOf(t) === 'BLACK')).toBe(true);
  });
});

describe('what they say now wins', () => {
  it('a red polo, over a navy-or-black preference', async () => {
    const id = await customer('I mostly wear navy or black');
    const { titles } = await search(id, { query: 'red polo', colour: 'red' }, 'Actually show me a red polo.');
    expect(titles).toEqual(['CLUB POLO - RED']);
  });

  it('a navy polo in XL is navy only, as before', async () => {
    const id = await customer('I mostly wear navy or black');
    const { titles } = await search(id, { query: 'navy polo', colour: 'navy', size: 'XL' }, 'Show me a navy polo in XL');
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => colourOf(t) === 'NAVY')).toBe(true);
  });

  it('anything except navy: navy stays out, black stays in', async () => {
    const id = await customer('I mostly wear navy or black');
    const { titles } = await search(id, { query: 'polo', colour: 'black' }, 'Anything except navy.');
    expect(titles.some((t) => colourOf(t) === 'NAVY')).toBe(false);
    expect(titles.some((t) => colourOf(t) === 'BLACK')).toBe(true);
  });
});

describe('one colour, as before', () => {
  it('"I prefer navy": navy first, other colours still shown', async () => {
    const id = await customer('I prefer navy');
    const { titles } = await search(id, { query: 'polo', colour: 'navy' }, 'Show me a polo.');
    expect(colourOf(titles[0]!)).toBe('NAVY');
    expect(titles.some((t) => colourOf(t) !== 'NAVY')).toBe(true);
  });
});
