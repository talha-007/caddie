import { beforeEach, describe, expect, it } from 'vitest';
import type { CartAction, Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { describeIdentity, resolveCustomerProductIdentity } from '../src/catalog/productIdentity.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { focusFromCard, noteShoppingFocus } from '../src/session/focus.js';
import { rememberShopper } from '../src/shopper/remember.js';
import { sessions } from '../src/session/store.js';
import { quantityAsked } from '../src/tools/cartAuthorization.js';
import { runTool } from '../src/tools/index.js';

/**
 * "Add the One Pair Tour Ankle Socks to my basket" put LADIES TOUR ANKLE
 * SOCKS in the basket. The model searched "tour ankle socks", the name
 * lookup dropped "one" and picked the design with two words left, and
 * add_to_cart added whatever id it was given. One reader now decides which
 * product the customer named, from their words; a basket add must be of it.
 *
 * Every tool call here passes what a model got wrong - a sibling, another
 * range, a product looked up in passing - and checks what reaches the basket.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
let next = 1000;

function product(title: string, sizes: string[] | null, price = 20): Product {
  const id = next;
  next += 10;
  const values = sizes ?? ['Default Title'];
  const name = sizes ? 'Size' : 'Title';
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [...BRAND],
    price: { amount: price, currency: 'GBP' },
    options: [{ name, values }],
    variants: values.map((value, i) => ({ id: `gid://shopify/ProductVariant/${id + i + 1}`, title: value, available: true, price: { amount: price, currency: 'GBP' }, options: { [name]: value } })),
    description: null,
  };
}

const TOPS = ['S', 'M', 'L', 'XL'];
const ONE_PAIR = product('ONE PAIR TOUR ANKLE SOCKS - WHITE', null, 6);
const LADIES_SOCKS = product('LADIES TOUR ANKLE SOCKS - WHITE/PURPLE', null, 4);
const KIDS_SOCKS = product('KIDS TOUR ANKLE SOCKS - WHITE', null, 4);
const ELITE_NAVY = product('ELITE POLO - NAVY', TOPS);
const ELITE_WHITE = product('ELITE POLO - WHITE', TOPS);
const LADIES_ELITE = product('LADIES ELITE POLO - PINK', TOPS);
const CLIMA_NAVY = product('CLIMA JACKET 3.0 - NAVY', TOPS, 58);
const CLIMA_BLACK = product('CLIMA JACKET 3.0 - BLACK', TOPS, 58);
// Real name words that filler lists used to drop.
const PLAIN_TOUR = product('PLAIN TOUR POLO - WHITE', TOPS);
const TOUR_POLO = product('TOUR POLO - WHITE', TOPS);
const GOLF_TEE = product('GOLF TEE POLO - WHITE', TOPS);
const TEE_POLO = product('TEE POLO - BLACK', TOPS);
const NEW_TOUR_CAP = product('NEW TOUR CAP - BLACK', null, 15);
const TOUR_CAP = product('TOUR CAP - NAVY', null, 15);

const CATALOGUE = [ONE_PAIR, LADIES_SOCKS, KIDS_SOCKS, ELITE_NAVY, ELITE_WHITE, LADIES_ELITE, CLIMA_NAVY, CLIMA_BLACK, PLAIN_TOUR, TOUR_POLO, GOLF_TEE, TEE_POLO, NEW_TOUR_CAP, TOUR_CAP];

let id = '';
beforeEach(async () => {
  setCatalogueForTests(CATALOGUE);
  setDealsForTests([]);
  id = `identity-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme' });
});

/** A customer message, read as converse() reads it, and recorded. */
async function said(text: string) {
  await noteShoppingFocus(id, text);
  await sessions.append(id, [{ id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() }]);
}
async function caddie(text: string) {
  await sessions.append(id, [{ id: `a-${Math.random()}`, role: 'assistant', text, createdAt: new Date().toISOString() }]);
}
async function onScreen(products: Product[]) {
  await sessions.patch(id, { lastShown: { kind: 'products', items: products.map((p) => ({ id: p.id, title: p.title })) } });
}
/** A tap on a card, exactly as POST /choice records it. */
async function tap(p: Product, options: Record<string, string>) {
  const session = await sessions.getOrCreate(id);
  await sessions.patch(id, {
    cardChoices: { ...(session.cardChoices ?? {}), [p.id]: { options, at: Date.now() + 5000 } },
    activeShoppingContext: focusFromCard(p, session.activeShoppingContext, 1),
  });
}
/** The model's add_to_cart call, this turn, and what reached the basket. */
async function add(args: Record<string, unknown>, utterance: string) {
  const result = await runTool('add_to_cart', args, { session: await sessions.getOrCreate(id), utterance });
  const lines = (result.actions ?? []).flatMap((action: CartAction) => (action.type === 'add' ? action.lines : []));
  const added = lines.map((line) => {
    const owner = CATALOGUE.find((p) => p.variants.some((v) => v.id.endsWith(`/${line.variantId}`)))!;
    return `${owner.title} / ${owner.variants.find((v) => v.id.endsWith(`/${line.variantId}`))!.title} x${line.quantity}`;
  });
  return { result, added };
}

describe('the one reader of product names', () => {
  it('the full name is that product - never a sibling with fewer words', () => {
    expect(describeIdentity(resolveCustomerProductIdentity('Add the One Pair Tour Ankle Socks to my basket.'))).toBe(`exact ${ONE_PAIR.title}`);
    expect(describeIdentity(resolveCustomerProductIdentity('Add the Ladies Tour Ankle Socks'))).toBe(`exact ${LADIES_SOCKS.title}`);
  });

  it('fewer words that fit several products are ambiguous - no product is chosen', () => {
    const identity = resolveCustomerProductIdentity('tour ankle socks');
    expect(identity.status).toBe('ambiguous');
    expect(describeIdentity(identity)).toMatch(/ONE PAIR TOUR ANKLE SOCKS.*KIDS TOUR ANKLE SOCKS.*LADIES TOUR ANKLE SOCKS|ONE PAIR/);
  });

  it('"one", "plain", "golf" and "new" are name words, not filler', () => {
    expect(describeIdentity(resolveCustomerProductIdentity('the plain tour polo'))).toBe(`exact ${PLAIN_TOUR.title}`);
    expect(describeIdentity(resolveCustomerProductIdentity('the tour polo'))).toBe(`exact ${TOUR_POLO.title}`);
    expect(describeIdentity(resolveCustomerProductIdentity('the golf tee polo'))).toBe(`exact ${GOLF_TEE.title}`);
    // Two ordinary words are a description, not a name.
    expect(resolveCustomerProductIdentity('the tee polo').status).toBe('none');
    expect(describeIdentity(resolveCustomerProductIdentity('the new tour cap'))).toBe(`exact ${NEW_TOUR_CAP.title}`);
    expect(describeIdentity(resolveCustomerProductIdentity('the tour cap'))).toBe(`exact ${TOUR_CAP.title}`);
  });

  it('a design and a colour: that colourway; a design alone: the family', () => {
    expect(describeIdentity(resolveCustomerProductIdentity('Add the Elite Polo in navy'))).toBe(`exact ${ELITE_NAVY.title}`);
    expect(describeIdentity(resolveCustomerProductIdentity('What other colours does the Elite Polo come in?'))).toBe('family ELITE POLO');
    expect(describeIdentity(resolveCustomerProductIdentity('the ladies elite polo'))).toBe(`exact ${LADIES_ELITE.title}`);
  });

  it('descriptions are not names', () => {
    for (const text of ['Add a pair of socks', 'show me a golf polo', 'show me polos and jackets', 'add it', 'the navy one']) {
      expect(resolveCustomerProductIdentity(text).status, text).toBe('none');
    }
  });
});

describe('the basket gets the product the customer named', () => {
  it('the socks: the model passes the Ladies pair, the One Pair goes in', async () => {
    const { added, result } = await add({ productId: LADIES_SOCKS.id }, 'Add the One Pair Tour Ankle Socks to my basket.');
    expect(added).toEqual([`${ONE_PAIR.title} / Default Title x1`]);
    expect(JSON.stringify(result)).not.toContain(LADIES_SOCKS.variants[0]!.id.split('/').pop()!);
  });

  it('the socks with the right id: added as asked', async () => {
    expect((await add({ productId: ONE_PAIR.id }, 'Add the One Pair Tour Ankle Socks to my basket.')).added).toEqual([`${ONE_PAIR.title} / Default Title x1`]);
  });

  it('the Ladies pair, asked for by name, is not forced to the One Pair', async () => {
    expect((await add({ productId: LADIES_SOCKS.id }, 'Add the Ladies Tour Ankle Socks to my basket.')).added).toEqual([`${LADIES_SOCKS.title} / Default Title x1`]);
  });

  it('the Elite Polo in navy: the model passes the white one, navy goes in', async () => {
    expect((await add({ productId: ELITE_WHITE.id, options: { Size: 'M' } }, 'Add the Elite Polo in navy in M')).added).toEqual([`${ELITE_NAVY.title} / M x1`]);
  });

  it('a name that fits several products: nothing added until they say which', async () => {
    const { added, result } = await add({ productId: LADIES_SOCKS.id }, 'Add the tour ankle socks');
    expect(added).toEqual([]);
    expect(result.speech).toMatch(/Which do you mean/);
    expect(result.facts).toMatch(/Nothing was added/);
  });

  it('...unless only one of them is what they are looking at', async () => {
    await onScreen([ONE_PAIR, ELITE_NAVY]);
    expect((await add({ productId: LADIES_SOCKS.id }, 'Add the tour ankle socks')).added).toEqual([`${ONE_PAIR.title} / Default Title x1`]);
  });
});

describe('"add it": the product they tapped, were offered, or were waiting on', () => {
  it('a card tapped in M, then "add it": that card, in M', async () => {
    await onScreen([ELITE_NAVY, CLIMA_NAVY]);
    await tap(CLIMA_NAVY, { Size: 'M' });
    expect((await add({ productId: ELITE_NAVY.id }, 'Add it.')).added).toEqual([`${CLIMA_NAVY.title} / M x1`]);
  });

  it('a product named after a tap beats the tap', async () => {
    await onScreen([ELITE_NAVY, CLIMA_NAVY]);
    await tap(CLIMA_NAVY, { Size: 'M' });
    expect((await add({ productId: CLIMA_NAVY.id, options: { Size: 'M' } }, 'Add the Elite Polo navy in M')).added).toEqual([`${ELITE_NAVY.title} / M x1`]);
  });

  it('"yes" to "shall I add the Elite Polo in navy?": the Elite navy, never what the model swaps in', async () => {
    await rememberShopper(id, { usualSize: 'L' }, 'customer-words');
    await onScreen([ELITE_NAVY, CLIMA_NAVY]);
    await said('Show me polos');
    await caddie('The Elite Polo in navy is a great pick. Shall I add the Elite Polo in navy in L?');
    const { added } = await add({ productId: CLIMA_NAVY.id, options: { Size: 'L' } }, 'Yes.');
    expect(added).toEqual([`${ELITE_NAVY.title} / L x1`]);
  });

  it('"M" to "what size?": the product that asked - not another the model reaches for', async () => {
    await said('Add the Clima Jacket 3.0 in navy');
    const asked = await add({ productId: CLIMA_NAVY.id }, 'Add the Clima Jacket 3.0 in navy');
    expect(asked.added).toEqual([]);
    expect((await sessions.getOrCreate(id)).pendingAction?.productIds).toEqual([CLIMA_NAVY.id]);
    await caddie('What size would you like?');
    await said('M');
    expect((await add({ productId: ELITE_NAVY.id, options: { Size: 'M' } }, 'M')).added).toEqual([`${CLIMA_NAVY.title} / M x1`]);
  });

  it('another product named before the size: the waiting add does not finish', async () => {
    await said('Add the Clima Jacket 3.0 in navy');
    await add({ productId: CLIMA_NAVY.id }, 'Add the Clima Jacket 3.0 in navy');
    await caddie('What size would you like?');
    await said('Actually the Elite Polo in M');
    const { added, result } = await add({ productId: CLIMA_NAVY.id, options: { Size: 'M' } }, 'Actually the Elite Polo in M');
    expect(added).toEqual([]);
    expect(result.facts).toMatch(/Basket unchanged|not ask/i);
  });

  it('a product the model only looked up does not become "it"', async () => {
    await said('Show me the Elite Polo');
    await onScreen([ELITE_NAVY]);
    // The model looks the Clima Jacket up in passing - that moves nothing (Phase 3B).
    await runTool('get_product_details', { productId: CLIMA_NAVY.id }, { session: await sessions.getOrCreate(id), utterance: 'Show me the Elite Polo' });
    expect((await sessions.getOrCreate(id)).activeShoppingContext?.productId).not.toBe(CLIMA_NAVY.id);
    await said('Add it in M');
    expect((await add({ productId: CLIMA_NAVY.id, options: { Size: 'M' } }, 'Add it in M')).added).toEqual([`${ELITE_NAVY.title} / M x1`]);
  });
});

describe('a quantity is read from how they buy, not from the product name', () => {
  const asked = async (utterance: string, proposed: number) => quantityAsked({ session: await sessions.getOrCreate(id), utterance }, proposed);

  it('"One Pair" is one item; "two pairs of" is two; "3.0" is not three', async () => {
    expect(await asked('Add One Pair Tour Ankle Socks', 2)).toBe(1);
    expect(await asked('Add two pairs of One Pair Tour Ankle Socks', 2)).toBe(2);
    expect(await asked('Add Clima Jacket 3.0', 3)).toBe(1);
    expect(await asked('Add a pair of socks', 2)).toBe(1);
  });

  it('end to end: "Add One Pair Tour Ankle Socks" goes in once', async () => {
    expect((await add({ productId: ONE_PAIR.id, quantity: 2 }, 'Add One Pair Tour Ankle Socks')).added).toEqual([`${ONE_PAIR.title} / Default Title x1`]);
  });
});

describe('search, product_info and other_colours read the same name', () => {
  it('search: the model shortens the name, the One Pair still leads', async () => {
    const result = await runTool('search_products', { query: 'tour ankle socks' }, { session: await sessions.getOrCreate(id), utterance: 'Show me One Pair Tour Ankle Socks' });
    const shown = result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : [];
    expect(shown[0]).toBe(ONE_PAIR.title);
    expect(result.facts).toMatch(/ONE PAIR TOUR ANKLE SOCKS/);
    expect(result.facts).not.toMatch(/exact product found: LADIES/);
  });

  it('product_info: asked about the One Pair, the model looks up the Ladies pair - the answer is about the One Pair', async () => {
    const result = await runTool('product_info', { which: 'ladies tour ankle socks', question: 'is it one size?' }, { session: await sessions.getOrCreate(id), utterance: 'Is the One Pair Tour Ankle Socks one size?' });
    expect(result.facts).toMatch(/About: ONE PAIR TOUR ANKLE SOCKS/);
  });

  it('other_colours: asked about the Elite Polo, the model passes the jacket - the Elite Polo\'s colours', async () => {
    const result = await runTool('other_colours', { productId: CLIMA_NAVY.id }, { session: await sessions.getOrCreate(id), utterance: 'What other colours does the Elite Polo come in?' });
    const shown = result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : [];
    expect(shown.sort()).toEqual([ELITE_NAVY.title, ELITE_WHITE.title].sort());
  });
});

describe('"add them" is as bare as "add it"', () => {
  it('the design they are looking at, not what the model reaches for', async () => {
    await said('Show me One Pair Tour Ankle Socks');
    await onScreen([ONE_PAIR, LADIES_SOCKS]);
    expect((await add({ productId: LADIES_SOCKS.id }, 'Add them')).added).toEqual([`${ONE_PAIR.title} / Default Title x1`]);
  });
});
