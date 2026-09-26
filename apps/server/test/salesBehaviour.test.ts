import { beforeEach, describe, expect, it } from 'vitest';
import type { CaddieAttachment, Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { attributesOf } from '../src/catalog/attributes.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { verifyReply, withoutClaims } from '../src/ai/verify.js';
import { readIntent, standingPart } from '../src/shopper/profile.js';
import { rememberShopper } from '../src/shopper/remember.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * How the Caddie sells once search is right. Each case is one the replay
 * caught: "an exact match for your request", "do you have another one?"
 * answered with the polo just recommended, a regular-cut polo led for "I
 * prefer a relaxed fit", and "would you like to see this HEXIE POLO?" with its
 * card on screen.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function polo(title: string, description: string): Product {
  const sizes = ['S', 'M', 'L', 'XL'];
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: 'POLOS',
    tags: [...BRAND],
    price: { amount: 20, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size) => ({ id: `${title}-${size}`, title: size, available: true, price: { amount: 20, currency: 'GBP' }, options: { Size: size } })),
    description,
  };
}

const REGULAR = 'Breathable, with a regular fit.';
const RELAXED = 'Lightweight and breathable, with a relaxed fit.';

// Regular cuts first, as the store's search order had Block Pique first.
const CATALOGUE = [
  polo('BLOCK PIQUE POLO - NAVY', REGULAR),
  polo('BLOCK PIQUE POLO - BLACK', REGULAR),
  polo('GARDEN POLO - NAVY', REGULAR),
  polo('GOLF TEE POLO - NAVY', RELAXED),
  polo('BACKNINE POLO - BLACK', RELAXED),
  polo('FIESTA POLO - NAVY', RELAXED),
  polo('WAVEFORM POLO - BLACK', RELAXED),
  polo('OPLO POLO - BLACK', REGULAR),
  polo('ELITE POLO - NAVY', REGULAR),
  polo('HEXIE POLO - BLACK', REGULAR),
  polo('HEXA PERFORMANCE POLO - SAGE', REGULAR),
];

beforeEach(() => {
  setCatalogueForTests(CATALOGUE);
  setDealsForTests([]);
});

async function customer(...said: string[]) {
  const id = `sales-${Math.random()}`;
  await sessions.getOrCreate(id);
  for (const text of said) await rememberShopper(id, standingPart(readIntent(text)));
  return id;
}

async function turn(id: string, args: Record<string, unknown>, utterance: string) {
  const session = await sessions.getOrCreate(id);
  const result = await runTool('search_products', args, { session, utterance });
  const cards = result.attachment?.kind === 'products' ? result.attachment.products : [];
  const lead = /Lead with: ([^[]+) \[/.exec(result.facts ?? '')?.[1];
  return { result, cards, titles: cards.map((p) => p.title), lead };
}

const colourOf = (title: string) => title.split(' - ')[1]!;
const card = (...titles: string[]): CaddieAttachment => ({ kind: 'products', products: CATALOGUE.filter((p) => titles.includes(p.title)) });

describe('internal wording never reaches the customer', () => {
  const facts = 'Results: GARDEN POLO - NAVY - £20.00';
  const wording = (reply: string) => verifyReply(reply, facts, card('GARDEN POLO - NAVY')).filter((v) => v.kind === 'wording');

  it('ranking labels are caught', () => {
    for (const reply of [
      'The Garden Polo is an exact match for your request.',
      'The Garden Polo is a strong match.',
      'It came up as a semantic match.',
      'Its match level is high.',
      'The Garden Polo is a perfect match.',
    ]) expect(wording(reply).length, reply).toBeGreaterThan(0);
  });

  it('suitability no fact states is caught', () => {
    expect(wording('The Garden Polo is perfect for warm weather.').length).toBeGreaterThan(0);
  });

  it('a weather verdict no description gives is caught; the features it rests on are not', () => {
    expect(wording('The Garden Polo is lightweight and breathable, making it suitable for warm weather.').length).toBeGreaterThan(0);
    expect(wording("It's great for summer rounds.").length).toBeGreaterThan(0);
    expect(wording("It's lightweight and breathable, which lines up well with what you asked for.")).toEqual([]);
    expect(withoutClaims('The Garden Polo is lightweight and breathable, making it suitable for warm weather. What size do you need?', [{ kind: 'wording', claim: 'suitable for warm weather' }])).toBe(
      'The Garden Polo is lightweight and breathable. What size do you need?',
    );
  });

  it('ordinary sales language passes', () => {
    for (const reply of [
      "I'd start with the Garden Polo - it's breathable and in navy.",
      'A good option is the Garden Polo.',
      'These are the closest matches in navy.',
    ]) expect(wording(reply), reply).toEqual([]);
  });

  it('the last resort rewords rather than dropping the recommendation', () => {
    const fixed = withoutClaims('The Garden Polo is an exact match for your request. It is £20.00.', [{ kind: 'wording', claim: 'exact match' }]);
    expect(fixed).toBe('The Garden Polo is a good fit for your request. It is £20.00.');
    const heat = withoutClaims('The Garden Polo is breathable, perfect for warm weather.', [{ kind: 'wording', claim: 'perfect for' }]);
    expect(heat).toBe('The Garden Polo is breathable.');
  });
});

describe('never offering to show what is on screen', () => {
  const offers = (reply: string, ...titles: string[]) => verifyReply(reply, titles.join('\n'), card(...titles)).filter((v) => v.kind === 'offer');

  it('"would you like to see this HEXIE POLO?" with its card up', () => {
    expect(offers('Would you like to see this HEXIE POLO?', 'HEXIE POLO - BLACK', 'HEXA PERFORMANCE POLO - SAGE')).toHaveLength(1);
    expect(offers('Want me to show you it?', 'HEXIE POLO - BLACK')).toHaveLength(1);
    expect(offers('Would you like to see the black version too?', 'GARDEN POLO - NAVY', 'OPLO POLO - BLACK')).toHaveLength(1);
  });

  it('offers of more, other or something not on screen are real offers', () => {
    expect(offers('Would you like to see other colours?', 'HEXIE POLO - BLACK')).toEqual([]);
    expect(offers('Want me to show you more polos?', 'HEXIE POLO - BLACK')).toEqual([]);
    expect(offers('Would you like to see it in red?', 'HEXIE POLO - BLACK')).toEqual([]);
    expect(offers('Is that the one you meant?', 'HEXIE POLO - BLACK')).toEqual([]);
  });

  it('the last resort drops only the offer', () => {
    expect(withoutClaims('I found the Hexie Polo. Would you like to see this HEXIE POLO?', [{ kind: 'offer', claim: 'Would you like to see this HEXIE POLO' }])).toBe(
      'I found the Hexie Polo.',
    );
  });
});

describe('"another one"', () => {
  it('leads with something not yet shown, twice running', async () => {
    const id = await customer();
    const first = await turn(id, { query: 'polo', limit: 3 }, 'Show me a polo.');
    const second = await turn(id, { query: 'polo', limit: 3 }, 'Do you have another one?');
    expect(second.titles[0]).not.toBe(first.titles[0]);
    expect(first.titles).not.toContain(second.titles[0]);
    const third = await turn(id, { query: 'polo', limit: 3 }, 'Another.');
    expect([...first.titles, ...second.titles]).not.toContain(third.titles[0]);
  });

  it('navy or black: what is new still takes turns by colour', async () => {
    const id = await customer('I mostly wear navy or black');
    await turn(id, { query: 'polo', limit: 2 }, 'Show me a polo.');
    const next = await turn(id, { query: 'polo', limit: 2 }, 'Another one');
    expect(next.titles.map(colourOf).sort()).toEqual(['BLACK', 'NAVY']);
  });

  it('when everything has been seen, it still answers', async () => {
    const id = await customer();
    await turn(id, { query: 'polo', limit: 12 }, 'Show me a polo.');
    const again = await turn(id, { query: 'polo', limit: 12 }, 'Another one');
    expect(again.titles.length).toBeGreaterThan(0);
  });

  it('a new search starts the run again', async () => {
    const id = await customer();
    const first = await turn(id, { query: 'polo', limit: 3 }, 'Show me a polo.');
    await turn(id, { query: 'polo', limit: 3 }, 'Another one');
    // Not asking for another: the same cards as the first time, nothing pushed back for having been seen.
    const fresh = await turn(id, { query: 'polo', limit: 3 }, 'Show me a polo.');
    expect(new Set(fresh.titles)).toEqual(new Set(first.titles));
  });
});

describe('the lead suits what they told us', () => {
  it('a relaxed fit leads for "I prefer a relaxed fit", when one fits equally well', async () => {
    const id = await customer('I prefer a relaxed fit');
    const { cards, lead } = await turn(id, { query: 'polo' }, 'Show me a polo.');
    expect(attributesOf(cards[0]!).fit).toBe('relaxed');
    expect(lead).toBe(cards[0]!.title);
  });

  it('a relaxed fit further down, beyond the cards, still leads', async () => {
    const id = await customer('I prefer a relaxed fit');
    const { cards } = await turn(id, { query: 'polo', limit: 2 }, 'Show me a polo.');
    expect(attributesOf(cards[0]!).fit).toBe('relaxed');
    expect(cards).toHaveLength(2);
  });

  it('navy or black: after a navy lead, a black one can lead', async () => {
    const id = await customer('I mostly wear navy or black');
    const first = await turn(id, { query: 'polo' }, 'Show me a polo.');
    const next = await turn(id, { query: 'polo' }, 'Show me a polo.');
    expect(colourOf(next.titles[0]!)).not.toBe(colourOf(first.titles[0]!));
    expect(['NAVY', 'BLACK']).toContain(colourOf(next.titles[0]!));
  });
});

describe('the next step', () => {
  it('a named product in a size they gave, in stock: offer the basket', async () => {
    const id = await customer();
    const { result } = await turn(id, { productName: 'Elite Polo', colour: 'navy', size: 'XL' }, 'Do you have the Elite Polo in navy in XL?');
    expect(result.facts).toMatch(/Next step: the ELITE POLO - NAVY is in stock in XL at £20.00 - offer to add it to their basket in XL/);
  });

  it('their usual size, remembered, counts', async () => {
    const id = await customer("I'm usually XL");
    const { result } = await turn(id, { productName: 'Elite Polo', colour: 'navy' }, 'Do you have the Elite Polo in navy?');
    expect(result.facts).toMatch(/offer to add it to their basket in XL/);
  });

  it('no size yet: ask for it, not the basket', async () => {
    const id = await customer();
    const { result } = await turn(id, { productName: 'Elite Polo', colour: 'navy' }, 'Do you have the Elite Polo in navy?');
    expect(result.facts).toMatch(/Next step: their size is not known - ask for it/);
    expect(result.facts).not.toMatch(/basket in/);
  });

  it('a name that could be two products: no lead and no basket, just which one', async () => {
    const id = await customer("I'm usually XL");
    const { result } = await turn(id, { productName: 'Hexi polo' }, 'Show me the Hexi polo');
    expect(result.facts).toMatch(/no single product could be confirmed/);
    expect(result.facts).not.toMatch(/Lead with|Next step/);
  });
});
