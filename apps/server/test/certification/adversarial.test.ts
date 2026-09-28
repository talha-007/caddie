import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { readCustomerTurn } from '../../src/ai/turn.js';
import { verifyReply } from '../../src/ai/verify.js';
import { setDealsForTests, type DealRecipe } from '../../src/catalog/bundles.js';
import { setCatalogueForTests } from '../../src/catalog/sync.js';
import { env } from '../../src/env.js';
import { sessions } from '../../src/session/store.js';
import { trustedShopperFacts, currentShoppingIntent } from '../../src/shopper/facts.js';
import { runTool } from '../../src/tools/index.js';
import { resolveSearchIntent } from '../../src/tools/searchIntent.js';
import { readIntent } from '../../src/shopper/profile.js';
import type { ToolContext } from '../../src/tools/types.js';

/**
 * Certification §5: the model proposes something wrong; deterministic code
 * must correct or block it. Each case names the layer that catches it.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
let next = 95000;
function product(title: string, type: string, sizes: string[], opts: { soldOut?: string[]; description?: string; price?: number } = {}): Product {
  const id = next;
  next += 20;
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND],
    price: { amount: opts.price ?? 30, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size, i) => ({ id: `gid://shopify/ProductVariant/${id + i + 1}`, title: size, available: !(opts.soldOut ?? []).includes(size), price: { amount: opts.price ?? 30, currency: 'GBP' }, options: { Size: size } })),
    description: opts.description ?? 'Breathable.',
  };
}
const ELITE_NAVY = product('ELITE POLO - NAVY', 'POLOS', ['S', 'M', 'L'], { soldOut: ['L'], price: 20 });
const ELITE_WHITE = product('ELITE POLO - WHITE', 'POLOS', ['S', 'M', 'L'], { price: 20 });
const LADIES = product('LADIES ELITE POLO - NAVY', 'LADIES POLOS', ['8', '10', '12']);
const JACKET = product('CLIMA JACKET 3.0 - NAVY', 'JACKETS', ['S', 'M', 'L'], { description: 'Water-resistant and breathable.' });
const SOCKS = product('ONE PAIR TOUR ANKLE SOCKS - WHITE', 'SOCKS', ['Default Title']);
const TROUSERS = product('TOUR TROUSERS - NAVY', 'TROUSERS', ['32', '34']);
const step = (title: string, products: Product[]) => ({ title, collection: title, productIds: new Set(products.map((p) => p.id)) });
const PACK: DealRecipe = { handle: 'cert-pack', title: 'AMBASSADOR PACK - COOL & WET', range: 'men', prices: { GBP: 99 }, dynamicPrices: false, url: '', condition: 'coolwet', conditionTitle: 'COOL & WET', steps: [step('POLO', [ELITE_WHITE]), step('TROUSERS', [TROUSERS])] };

let id = '';
beforeEach(async () => {
  setCatalogueForTests([ELITE_NAVY, ELITE_WHITE, LADIES, JACKET, SOCKS, TROUSERS]);
  setDealsForTests([PACK]);
  id = `cert-adv-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: 'cart-ops/1' });
});

async function turn(said: string, run?: (ctx: ToolContext) => Promise<Awaited<ReturnType<typeof runTool>>>, reply = 'OK.') {
  await readCustomerTurn(id, said);
  const result = run ? await run({ session: await sessions.getOrCreate(id), utterance: said }) : undefined;
  await sessions.append(id, [
    { id: `u-${Math.random()}`, role: 'user', text: said, createdAt: new Date().toISOString() },
    { id: `a-${Math.random()}`, role: 'assistant', text: reply, createdAt: new Date().toISOString() },
  ]);
  return result;
}
const tool = (name: string, args: Record<string, unknown>) => (ctx: ToolContext) => runTool(name, args, ctx);
const added = (result: Awaited<ReturnType<typeof runTool>> | undefined) => (result?.actions ?? []).flatMap((a) => ('lines' in a ? a.lines : []));
const variant = (p: Product, size: string) => p.variants.find((v) => v.options.Size === size)!.id.split('/').pop();

describe('certification: bad model proposals are corrected or blocked', () => {
  it('wrong product id - customer named the Elite Polo navy, model adds the jacket [gateway target binding]', async () => {
    const result = await turn('Add the Elite Polo in navy in M', tool('add_to_cart', { productId: JACKET.id, options: { Size: 'M' } }));
    expect(added(result)).toEqual([{ variantId: variant(ELITE_NAVY, 'M'), quantity: 1 }]);
  });

  it('wrong colourway - customer said navy, model passes white [gateway identity]', async () => {
    const result = await turn('Add the navy Elite Polo in M', tool('add_to_cart', { productId: ELITE_WHITE.id, options: { Size: 'M' } }));
    expect(added(result)).toEqual([{ variantId: variant(ELITE_NAVY, 'M'), quantity: 1 }]);
  });

  it('wrong range - model searches ladies when nobody said so [search intent]', async () => {
    await readCustomerTurn(id, 'show me polos');
    const intent = resolveSearchIntent({ query: 'polo', range: 'ladies' }, { session: await sessions.getOrCreate(id), utterance: 'show me polos' }, readIntent('show me polos'));
    expect(intent.range).toBeUndefined();
  });

  it('wrong size - model adds in L, customer never gave a size [size evidence]', async () => {
    const result = await turn('Add the Elite Polo in navy', tool('add_to_cart', { productId: ELITE_NAVY.id, options: { Size: 'M' } }));
    expect(added(result)).toEqual([]);
    expect(result?.speech).toMatch(/size/i);
  });

  it('invented quantity - model adds 3, customer asked for one [quantityAsked]', async () => {
    const result = await turn('Add the white Elite Polo in M', tool('add_to_cart', { productId: ELITE_WHITE.id, options: { Size: 'M' }, quantity: 3 }));
    expect(added(result)).toEqual([{ variantId: variant(ELITE_WHITE, 'M'), quantity: 1 }]);
  });

  it('invented preference - note_shopper black, £20 [shopper facts provenance]', async () => {
    await turn('show me polos', tool('note_shopper', { colours: { words: ['black'], strength: 'required' }, budget: { amount: 20, kind: 'max', per: 'item' } }));
    const session = await sessions.getOrCreate(id);
    expect(trustedShopperFacts(session).colours).toBeUndefined();
    expect(currentShoppingIntent(session).budget).toBeUndefined();
  });

  it('invented measurement - model passes chest 120cm nobody said [find_my_size evidence]', async () => {
    await turn('what size am I?', tool('find_my_size', { chestCm: 120, audience: 'men' }));
    expect(trustedShopperFacts(await sessions.getOrCreate(id)).measurements.chestCm).toBeUndefined();
  });

  it('wrong basket line - customer removes the polo, model passes the jacket line [line change planner]', async () => {
    await sessions.patch(id, {
      basket: [
        { lineId: 'p', productId: ELITE_NAVY.id, title: ELITE_NAVY.title, variantTitle: 'M', quantity: 1 },
        { lineId: 'j', productId: JACKET.id, title: JACKET.title, variantTitle: 'M', quantity: 1 },
      ],
    });
    const result = await turn('remove the Elite Polo', tool('update_cart_item', { lineId: 'j', quantity: 0 }));
    expect(result?.actions).toMatchObject([{ type: 'change', lineKey: 'p', quantity: 0 }]);
  });

  it('pack not in hand - model adds the pack after the customer left it [pack binding]', async () => {
    await turn('show me the cool and wet pack', tool('recommend_pack', { query: PACK.title }));
    await sessions.patch(id, { packChoices: { [PACK.handle]: { top: 'M', waist: '34' } } });
    await turn('actually show me jackets', undefined, 'Shall I add the pack to your basket?');
    const result = await turn('yes', tool('add_pack_to_cart', { pack: PACK.title }));
    expect((result?.actions ?? []).filter((a) => a.type === 'add-bundle')).toEqual([]);
  });

  it('old pending action - "M" two missions later does not finish the polo add [livePending]', async () => {
    await turn('Add the Elite Polo in navy', tool('add_to_cart', { productId: ELITE_NAVY.id }), 'What size?');
    await turn('show me jackets');
    const result = await turn('M', tool('add_to_cart', { productId: ELITE_NAVY.id, options: { Size: 'M' } }));
    expect(added(result)).toEqual([]);
  });

  it('sold-out variant - model adds L, which is sold out [gateway stock]', async () => {
    const result = await turn('Add the Elite Polo in navy in L', tool('add_to_cart', { productId: ELITE_NAVY.id, options: { Size: 'L' } }));
    expect(added(result)).toEqual([]);
    expect(result?.speech).toMatch(/out of stock/i);
  });

  it('fake price, fake stock, unsupported waterproof, unsupported size requirement [reply verifier]', () => {
    const card = (p: Product) => ({ kind: 'products' as const, products: [p] });
    const kinds = (reply: string, p: Product) => verifyReply(reply, `${p.title} - £${p.price.amount}`, card(p)).map((v) => v.kind);
    expect(kinds('The Elite Polo is £15.', ELITE_NAVY)).toContain('price');
    expect(kinds('L is in stock in the Elite Polo.', ELITE_NAVY)).toContain('stock');
    expect(kinds('The Clima Jacket is waterproof.', JACKET)).toContain('attribute');
    expect(kinds('What size would you like?', SOCKS)).toContain('size');
  });
});

describe('certification: a pack only when asked for', () => {
  it('"Is it waterproof?" about a polo does not build a pack', async () => {
    await turn('show me red polos');
    const result = await turn('Is it waterproof?', tool('recommend_pack', { query: 'Ambassador Pack', weather: ['wet'] }));
    expect(result?.attachment).toBeUndefined();
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.pack).toBeUndefined();
  });
  it('"show me the cool and wet pack" still does', async () => {
    const result = await turn('show me the cool and wet pack', tool('recommend_pack', { query: PACK.title }));
    expect(result?.attachment?.kind).toBe('pack');
  });
});

describe('certification: "we don\'t have ..." is checked against the catalogue', () => {
  it('"We don\'t have red jackets" when a red jacket is in stock: rejected; "no red belts" when there are none: allowed', () => {
    const red = product('WARRIOR JACKET - RED', 'JACKETS', ['S', 'M']);
    setCatalogueForTests([ELITE_NAVY, JACKET, red]);
    const kinds = (reply: string) => verifyReply(reply, '', { kind: 'products', products: [JACKET] }).filter((v) => v.kind === 'stock').map((v) => v.claim);
    expect(kinds("We don't have red jackets, but here are other colours.")).toHaveLength(1);
    expect(kinds('There are no red jackets in stock.')).toHaveLength(1);
    expect(kinds("We don't have red belts.")).toEqual([]);
  });
});

describe('certification: a colour the customer never chose', () => {
  it('"white or black" said, "Add it in M", the model picks white: the colour is asked; "white" then adds white M', async () => {
    await sessions.patch(id, { lastShown: { kind: 'products', items: [ELITE_WHITE, ELITE_NAVY].map((p) => ({ id: p.id, title: p.title })) } });
    await turn("Show me men's polos", undefined, 'I recommend the Elite Polo in white or navy - breathable, at £20. What size do you need?');
    const first = await turn('Add it in M.', tool('add_to_cart', { productId: ELITE_WHITE.id, options: { Size: 'M' } }), 'Which colour of the Elite Polo would you like?');
    expect(added(first)).toEqual([]);
    expect(first?.speech).toMatch(/colour/i);
    const second = await turn('White.', tool('add_to_cart', { productId: ELITE_WHITE.id, options: { Size: 'M' } }));
    expect(added(second)).toEqual([{ variantId: variant(ELITE_WHITE, 'M'), quantity: 1 }]);
  });
});
