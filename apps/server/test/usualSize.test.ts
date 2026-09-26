import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { readIntent, standingPart } from '../src/shopper/profile.js';
import { rememberShopper } from '../src/shopper/remember.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * "Add it in L", and the model called find_my_size with usualSize L - which
 * would make L, the size of one jacket, the size every picker and search used
 * from then on. A usual size is one the customer says they usually wear, or
 * one worked out from their measurements; never a size for one purchase.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
const sizes = ['S', 'M', 'L', 'XL', '2XL'];
const JACKET: Product = {
  id: 'gid://shopify/Product/500',
  title: 'WARRIOR JACKET - BLACK',
  url: '',
  imageUrl: null,
  vendor: 'Druids',
  productType: 'JACKETS',
  tags: [...BRAND],
  price: { amount: 16, currency: 'GBP' },
  options: [{ name: 'Size', values: sizes }],
  variants: sizes.map((size, i) => ({ id: `gid://shopify/ProductVariant/${501 + i}`, title: size, available: true, price: { amount: 16, currency: 'GBP' }, options: { Size: size } })),
  description: 'Waterproof and windproof.',
};

beforeEach(() => {
  setCatalogueForTests([JACKET]);
  setDealsForTests([]);
});

async function customer(...said: string[]) {
  const id = `usual-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme' });
  for (const text of said) await rememberShopper(id, standingPart(readIntent(text)));
  return id;
}

async function sizeTool(id: string, args: Record<string, unknown>, utterance: string) {
  const session = await sessions.getOrCreate(id);
  return runTool('find_my_size', args, { session, utterance });
}

const usual = async (id: string) => (await sessions.getOrCreate(id)).shopper?.usualSize;

describe('a size for this purchase never becomes their usual size', () => {
  it('usual XL, "add it in L", the model passes usualSize L: still XL', async () => {
    const id = await customer("I'm usually XL");
    const result = await sizeTool(id, { usualSize: 'L' }, 'Add it in L.');
    expect(await usual(id)).toBe('XL');
    expect((await sessions.getOrCreate(id)).sizeProfile.usualSize).toBe('XL');
    expect(result.facts).toMatch(/L is the size they want for this purchase, not their usual size - nothing about their size was stored/);
    expect(result.facts).toMatch(/call add_to_cart with L/);
  });

  it('no usual size yet, "add it in M": M is not stored', async () => {
    const id = await customer();
    await sizeTool(id, { usualSize: 'M' }, 'Add it in M.');
    expect(await usual(id)).toBeUndefined();
    expect((await sessions.getOrCreate(id)).sizeProfile.usualSize).toBeUndefined();
  });

  it('a size tapped on a card is not their usual size either', async () => {
    const id = await customer("I'm usually XL");
    await sessions.patch(id, { cardChoices: { [JACKET.id]: { options: { Size: 'M' }, at: Date.now() } }, cardFocus: JACKET.id });
    const session = await sessions.getOrCreate(id);
    const result = await runTool('add_to_cart', { productId: JACKET.id }, { session, utterance: 'Add it.' });
    expect(result.actions?.[0]).toMatchObject({ lines: [{ variantId: '502' }] });
    expect(await usual(id)).toBe('XL');
  });
});

describe('a usual size they said is stored', () => {
  it.each([
    ["I'm usually XL", 'XL'],
    ['My normal polo size is L', 'L'],
    ['my usual size is medium', 'M'],
    ['I generally wear a medium', 'M'],
    ["I'm usually M now.", 'M'],
  ])('%s -> %s', (said, size) => {
    expect(readIntent(said).usualSize).toBe(size);
  });

  it('purchase wording is not a usual size', () => {
    for (const said of ['Add it in L.', 'For this one, make it 2XL', 'Add this jacket in L']) expect(readIntent(said).usualSize, said).toBeUndefined();
  });

  it('"I\'m usually M now" changes it, through the tool as well', async () => {
    const id = await customer("I'm usually XL");
    await rememberShopper(id, standingPart(readIntent("I'm usually M now.")));
    await sizeTool(id, { usualSize: 'M' }, "I'm usually M now.");
    expect(await usual(id)).toBe('M');
  });

  it('a usual size said earlier in the conversation still counts', async () => {
    const id = await customer();
    const session = await sessions.getOrCreate(id);
    await sessions.patch(id, { messages: [...session.messages, { id: 'm1', role: 'user', text: 'I normally wear a large', createdAt: new Date().toISOString() }] });
    await sizeTool(id, { usualSize: 'L' }, 'what size should I get in this jacket?');
    expect(await usual(id)).toBe('L');
  });
});

describe('a size worked out from their measurements is stored, as before', () => {
  it('height and weight: the recommended size becomes theirs', async () => {
    const id = await customer();
    const result = await sizeTool(id, { heightValue: 180, heightUnit: 'cm', weightValue: 80, weightUnit: 'kg', audience: 'men' }, "I'm 180cm and 80kg, what size am I?");
    expect(result.attachment?.kind).toBe('size');
    expect(await usual(id)).toMatch(/^(S|M|L|XL|2XL)$/);
  });

  it('with measurements, an unsupported usual size is set aside but the sizing still runs', async () => {
    const id = await customer();
    const result = await sizeTool(id, { usualSize: 'S', chestCm: 107, audience: 'men' }, 'my chest is 107cm, add it in S');
    expect(result.attachment?.kind).toBe('size');
    expect(await usual(id)).not.toBe('S');
  });
});

describe('waist', () => {
  it('a waist being bought is not their waist; a waist that is theirs is', () => {
    expect(readIntent('Add the 34 waist').waist).toBeUndefined();
    expect(readIntent('put the 32 waist in my basket').waist).toBeUndefined();
    expect(readIntent('I have a 34 waist').waist).toBe('34');
    expect(readIntent("I'm a 36 waist").waist).toBe('36');
    expect(readIntent('waist size 36').waist).toBe('36');
  });

  it('so "add the 34 waist" leaves a remembered 36 alone', async () => {
    const id = await customer('I have a 36 waist');
    await rememberShopper(id, standingPart(readIntent('Add the 34 waist')));
    expect((await sessions.getOrCreate(id)).shopper?.waist).toBe('36');
  });
});

/*
 * "My chest is 36 inches" reached find_my_size with a height of 36 inches as
 * well. The chart refused the height, and the customer was asked how tall
 * they were instead of being given a size.
 */
describe('a height they never said', () => {
  it('is dropped, and the chest gives the size', async () => {
    const id = `height-${Math.random()}`;
    const session = await sessions.getOrCreate(id);
    const result = await runTool(
      'find_my_size',
      { chestCm: 91.44, waistCm: 86.36, heightValue: 36, heightUnit: 'in', audience: 'men' },
      { session, utterance: 'My chest is 36 inches.' },
    );
    expect(result.attachment?.kind === 'size' ? result.attachment.recommendation.size : null).toBe('S');
    expect((await sessions.getOrCreate(id)).sizeProfile.heightValue).toBeUndefined();
  });

  it('is kept when they said it', async () => {
    const id = `height-${Math.random()}`;
    const result = await runTool(
      'find_my_size',
      { heightValue: 178, heightUnit: 'cm', weightValue: 80, weightUnit: 'kg', audience: 'men' },
      { session: await sessions.getOrCreate(id), utterance: "I'm 178cm and 80kg" },
    );
    expect((await sessions.getOrCreate(id)).sizeProfile.heightValue).toBe(178);
    expect(result.attachment?.kind).toBe('size');
  });
});
