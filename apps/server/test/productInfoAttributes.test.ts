import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * "Is it waterproof?" about the Tex Rain Jacket - waterproof in search,
 * waterproof in its own description - was answered "its description does not
 * state that it is waterproof": product_info's facts held sizes and stock and
 * nothing about the product. Direct questions are answered from the same
 * verified data search and the reply checks use.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function item(title: string, type: string, description: string): Product {
  const sizes = ['S', 'M', 'L', 'XL'];
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND],
    price: { amount: 40, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size) => ({ id: `${title}-${size}`, title: size, available: true, price: { amount: 40, currency: 'GBP' }, options: { Size: size } })),
    description,
  };
}

const TEX = item('TEX RAIN JACKET - BLACK', 'RAIN JACKET', 'Fully waterproof with taped seams, windproof and breathable, with an athletic cut.');
const THUNDER = item('THUNDER RAIN JACKET - NAVY', 'RAIN JACKET', 'Waterproof, breathable, stretchy and lightweight.');
const ARVID_BLACK = item('ARVID GILET - BLACK', 'GILETS', 'Lightweight warmth, water-resistant and windproof, with an athletic cut.');
const ARVID_NAVY = item('ARVID GILET - NAVY', 'GILETS', 'Lightweight warmth, water-resistant and windproof, with an athletic cut.');
const STEALTH = item('STEALTH MIDLAYER - NAVY', 'MIDLAYERS', 'Breathable, with brushed warmth.');
const GOLF_TEE = item('GOLF TEE POLO - NAVY', 'POLOS', 'Breathable with a relaxed fit.');
const PURE = item('PURE MIDLAYER - BLACK', 'MIDLAYERS', 'Lightweight, with warmth for cooler days.');

beforeEach(() => {
  setCatalogueForTests([TEX, THUNDER, ARVID_BLACK, ARVID_NAVY, STEALTH, GOLF_TEE, PURE]);
  setDealsForTests([]);
});

/** A customer with these cards on screen, talking about `focus`. */
async function looking(on: Product[], focus?: Product) {
  const id = `info-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, {
    lastShown: { kind: 'products', items: on.map((p) => ({ id: p.id, title: p.title })) },
    ...(focus ? { focusProductId: focus.id } : {}),
  });
  return id;
}

async function ask(id: string, utterance: string, which?: string) {
  const session = await sessions.getOrCreate(id);
  return runTool('product_info', { question: utterance, ...(which ? { which } : {}) }, { session, utterance });
}

describe('stated: yes, straight away', () => {
  it('Tex Rain Jacket: waterproof', async () => {
    const id = await looking([TEX], TEX);
    const result = await ask(id, 'Is it waterproof?');
    expect(result.speech).toMatch(/^Yes - the Tex Rain Jacket - Black is described as waterproof\./);
    expect(result.speech).not.toMatch(/which|colour/i);
    expect(result.facts).toMatch(/Verified from its own description: [^\n]*waterproof/);
    expect(result.facts).toMatch(/waterproof - yes, its description states it/);
  });

  it('Thunder Rain Jacket: waterproof, by name', async () => {
    const id = await looking([TEX, THUNDER]);
    const result = await ask(id, 'Is the Thunder Rain Jacket waterproof?', 'Thunder Rain Jacket');
    expect(result.speech).toMatch(/^Yes - the Thunder Rain Jacket - Navy is described as waterproof/);
  });

  it('several at once: waterproof and breathable', async () => {
    const id = await looking([TEX], TEX);
    const result = await ask(id, 'Is it waterproof and breathable?');
    expect(result.speech).toMatch(/waterproof/);
    expect(result.speech).toMatch(/breathable/);
    expect(result.speech).not.toMatch(/doesn't state/);
  });
});

describe('something else stated in its place', () => {
  it('Arvid Gilet: water-resistant, not waterproof - and no colour question with both colours on screen', async () => {
    const id = await looking([ARVID_BLACK, ARVID_NAVY]);
    const result = await ask(id, 'Is the Arvid Gilet waterproof?', 'Arvid Gilet');
    expect(result.speech).toBe("The Arvid Gilet's description says water-resistant, not waterproof.");
    expect(result.facts).toMatch(/every colourway shares this description/);
  });

  it('insulated: warm is stated, insulated is not - never a flat no', async () => {
    const id = await looking([ARVID_BLACK], ARVID_BLACK);
    const result = await ask(id, 'Is it insulated?');
    expect(result.speech).toMatch(/says warm, but doesn't state that it's insulated/);
    expect(result.speech).not.toMatch(/^No\b|is not insulated/);
  });
});

describe('not stated: said as not stated, never as no', () => {
  it('insulated, of something that does not even say warm', async () => {
    const id = await looking([THUNDER], THUNDER);
    const result = await ask(id, 'Is it insulated?');
    expect(result.speech).toMatch(/product data doesn't state that it's insulated/);
  });

  it('"is this relaxed fit?" with no cut stated - an answer about fit, not stock', async () => {
    const id = await looking([STEALTH], STEALTH);
    const result = await ask(id, 'Is this relaxed fit?');
    expect(result.speech).toMatch(/doesn't state that it's relaxed fit/);
    expect(result.speech).not.toMatch(/in stock/);
  });

  it('a cut stated, and not the one asked about', async () => {
    const id = await looking([TEX], TEX);
    const result = await ask(id, 'Is this relaxed fit?');
    expect(result.speech).toMatch(/says an athletic cut, not relaxed fit/);
  });
});

describe('fit and shape', () => {
  it('relaxed cut stated: yes', async () => {
    const id = await looking([GOLF_TEE], GOLF_TEE);
    expect((await ask(id, 'Is this relaxed fit?')).speech).toMatch(/^Yes - .* relaxed fit/);
  });

  it('sleeveless: a gilet yes, a midlayer not stated', async () => {
    expect((await ask(await looking([ARVID_BLACK], ARVID_BLACK), 'Is it sleeveless?')).speech).toMatch(/^Yes - .*sleeveless/);
    expect((await ask(await looking([PURE], PURE), 'Is it sleeveless?')).speech).toMatch(/doesn't state that it's sleeveless/);
  });

  it('a hood: not stated for a rain jacket whose data never mentions one', async () => {
    expect((await ask(await looking([TEX], TEX), 'Does it have a hood?')).speech).toMatch(/doesn't state that it's hooded/);
  });
});

describe('the product in focus', () => {
  it('two jackets shown, talking about the Tex: the Tex is answered', async () => {
    const id = await looking([THUNDER, TEX], TEX);
    const result = await ask(id, 'Is it waterproof?');
    expect(result.facts).toMatch(/^About: TEX RAIN JACKET - BLACK/);
  });

  it('ordinary questions are answered as before', async () => {
    const id = await looking([TEX], TEX);
    expect((await ask(id, 'Is XL in stock?')).speech).toMatch(/XL is in stock/);
    expect((await ask(id, 'How much is it?')).speech).toMatch(/£40\.00/);
  });
});

describe('stated in other words', () => {
  // The live Arvid Gilet: "Padded front", "Thermal properties" - and never the word insulated.
  const PADDED = item('ARVID GILET - STONE', 'GILETS', 'Lightweight warmth. Padded front. Thermal properties. Water-resistant.');
  it('insulated? of a thermal, padded gilet: its own words, and insulated not stated - not yes, not no', async () => {
    setCatalogueForTests([PADDED]);
    const id = await looking([PADDED], PADDED);
    const result = await ask(id, 'Is it insulated?');
    expect(result.speech).toMatch(/says thermal and padded, but doesn't state that it's insulated/);
    expect(result.facts).toMatch(/Also stated, in these words: thermal, padded/);
  });
});

describe('"this", with one design on screen in several colours', () => {
  const TEE_WHITE = item('GOLF TEE POLO - WHITE', 'POLOS', 'Breathable with a relaxed fit.');
  it('answers for the design - no colour question', async () => {
    setCatalogueForTests([GOLF_TEE, TEE_WHITE]);
    const id = await looking([TEE_WHITE, GOLF_TEE]);
    const result = await ask(id, 'Is this relaxed fit?', 'this');
    expect(result.speech).toMatch(/^Yes - the Golf Tee Polo is described as relaxed fit/);
    expect(result.speech).not.toMatch(/which/i);
  });

  it('two different designs on screen and nothing named: still asks which', async () => {
    const id = await looking([TEX, THUNDER]);
    const result = await ask(id, 'Is this waterproof?', 'this');
    expect(result.speech).toBe('Which one do you mean?');
  });
});
