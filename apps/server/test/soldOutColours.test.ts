import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { rememberShopper } from '../src/shopper/remember.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * With S as their size, "different colours" of the Elite Polo showed grey,
 * sage, lavender and jade - sold out in S - and each card opened on a Sold out
 * button. Only colours the customer can buy, in their size, are shown.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
let next = 7000;

function polo(colour: string, soldOut: string[] = []): Product {
  const sizes = ['S', 'M', 'L', 'XL'];
  const id = next;
  next += 10;
  return {
    id: `gid://shopify/Product/${id}`,
    title: `ELITE POLO - ${colour}`,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [...BRAND],
    price: { amount: 20, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size, i) => ({
      id: `gid://shopify/ProductVariant/${id + i + 1}`,
      title: size,
      available: !soldOut.includes(size),
      price: { amount: 20, currency: 'GBP' },
      options: { Size: size },
    })),
    description: null,
  };
}

const WHITE = polo('WHITE');
const NAVY = polo('NAVY');
const GREY = polo('GREY', ['S']); // sold out in S only
const JADE = polo('JADE', ['S', 'M', 'L', 'XL']); // sold out everywhere

let id = '';
beforeEach(async () => {
  setCatalogueForTests([WHITE, NAVY, GREY, JADE]);
  setDealsForTests([]);
  id = `sold-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { lastShown: { kind: 'products', items: [{ id: WHITE.id, title: WHITE.title }] } });
});

const colours = async (utterance = 'Show me different colours', args: Record<string, unknown> = { productId: WHITE.id }) => {
  const result = await runTool('other_colours', args, { session: await sessions.getOrCreate(id), utterance });
  return { result, titles: result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : [] };
};

describe('other colours: only what they can buy', () => {
  it('in their size S: grey (sold out in S) and jade (sold out) are not shown, and not counted', async () => {
    await rememberShopper(id, { usualSize: 'S' });
    const { result, titles } = await colours();
    expect(titles.sort()).toEqual(['ELITE POLO - NAVY', 'ELITE POLO - WHITE']);
    expect(result.speech).not.toMatch(/4 colourways|grey|jade/i);
    expect(result.facts).not.toMatch(/GREY|JADE/);
  });

  it('with no size given, only the colour sold out in every size goes', async () => {
    const { titles } = await colours();
    expect(titles.sort()).toEqual(['ELITE POLO - GREY', 'ELITE POLO - NAVY', 'ELITE POLO - WHITE']);
  });

  it('"does it come in grey?" in S: no - the grey cannot be bought in S', async () => {
    await rememberShopper(id, { usualSize: 'S' });
    const { result, titles } = await colours('Does it come in grey?', { productId: WHITE.id, colour: 'grey' });
    expect(titles).toEqual([]);
    expect(result.speech).toMatch(/do not have the ELITE POLO in grey/);
  });

  it('nothing buyable in their size: says so, and shows nothing', async () => {
    setCatalogueForTests([polo('RED', ['M']), polo('BLUE', ['M'])]);
    const red = (await import('../src/catalog/sync.js')).allProducts()[0]!;
    await sessions.patch(id, { lastShown: { kind: 'products', items: [{ id: red.id, title: red.title }] } });
    await rememberShopper(id, { usualSize: 'M' });
    const { result, titles } = await colours('Show me different colours', { productId: red.id });
    expect(titles).toEqual([]);
    expect(result.speech).toMatch(/isn't in stock in M in any colour/);
  });
});
