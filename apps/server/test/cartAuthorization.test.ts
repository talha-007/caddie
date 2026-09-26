import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { readIntent } from '../src/shopper/profile.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';

/**
 * "I'm usually M now" - a size update - and the model called add_to_cart for
 * the jacket on screen in M. Nothing went in only because M was sold out. An
 * add needs the customer to have asked for one.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
const sizes = ['S', 'M', 'L', 'XL', '2XL'];
const JACKET: Product = {
  id: 'gid://shopify/Product/700',
  title: 'WARRIOR JACKET - BLACK',
  url: '',
  imageUrl: null,
  vendor: 'Druids',
  productType: 'JACKETS',
  tags: [...BRAND],
  price: { amount: 16, currency: 'GBP' },
  options: [{ name: 'Size', values: sizes }],
  variants: sizes.map((size, i) => ({ id: `gid://shopify/ProductVariant/${701 + i}`, title: size, available: true, price: { amount: 16, currency: 'GBP' }, options: { Size: size } })),
  description: 'Waterproof and windproof.',
};

beforeEach(() => {
  setCatalogueForTests([JACKET]);
  setDealsForTests([]);
});

/** A storefront shopper who has already said these things, and been answered like this. */
async function conversation(...turns: Array<[string, string]>) {
  const id = `auth-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme' });
  const at = Date.now() - 60_000;
  const messages = turns.flatMap(([said, replied], i) => [
    { id: `u${i}`, role: 'user' as const, text: said, createdAt: new Date(at + i * 2000).toISOString() },
    { id: `a${i}`, role: 'assistant' as const, text: replied, createdAt: new Date(at + i * 2000 + 1000).toISOString() },
  ]);
  if (messages.length) await sessions.append(id, messages);
  return id;
}

/** The model calls add_to_cart while the customer says `utterance`. */
async function modelAdds(id: string, utterance: string, args: Record<string, unknown> = { productId: JACKET.id, options: { Size: 'M' } }) {
  const session = await sessions.getOrCreate(id);
  const result = await runTool('add_to_cart', args, { session, utterance });
  const lines = (result.actions ?? []).flatMap((action) => ('lines' in action ? action.lines : []));
  return { result, lines };
}

/** What the chat route does after a turn: keep both sides. */
async function recordTurn(id: string, said: string, replied: string) {
  const now = Date.now();
  await sessions.append(id, [
    { id: `u-${now}`, role: 'user', text: said, createdAt: new Date(now).toISOString() },
    { id: `a-${now}`, role: 'assistant', text: replied, createdAt: new Date(now + 1).toISOString() },
  ]);
}

describe('the live failure', () => {
  it('"I\'m usually M now" is a size update, not an add', async () => {
    const id = await conversation(["I'm usually XL.", 'Thanks - XL noted.'], ['Show me the Warrior Jacket in black.', 'The Warrior Jacket in black is £16.']);
    const { result, lines } = await modelAdds(id, "I'm usually M now.");
    expect(lines).toEqual([]);
    expect(result.facts).toMatch(/Basket unchanged\. The customer did not ask to add anything/);
    expect(result.facts).toMatch(/Do not say anything was added/);
    // Their size update itself is read as normal.
    expect(readIntent("I'm usually M now.").usualSize).toBe('M');
  });
});

describe('asked in their own words: added', () => {
  it.each(['Add it', 'Add this one please', 'Put the black jacket in my basket', "I'll take it", "I'll take the M", 'Can you add it to my basket?'])('%s', async (said) => {
    // They gave their size earlier: the add is theirs to ask for, the size already theirs (Task 12 still applies).
    const id = await conversation(["I'm usually M", 'Noted - M.']);
    expect((await modelAdds(id, said)).lines).toEqual([{ variantId: '702', quantity: 1 }]);
  });
});

describe('not asking: nothing added, whatever the model calls', () => {
  it.each(['My size is XL', 'Show me another one', 'Is it waterproof?', 'How much is it?', 'Do you have it in black?', "Don't add it yet", 'What would you add to this?'])('%s', async (said) => {
    // M is their size, so only the missing ask stops the add.
    const id = await conversation(["I'm usually M", 'Noted - M.']);
    expect((await modelAdds(id, said)).lines).toEqual([]);
  });

  it('"XL" answering a size question, when no add was offered or asked for', async () => {
    const id = await conversation(['Do you have the Warrior Jacket in black?', 'We do - what size do you wear?']);
    expect((await modelAdds(id, 'XL', { productId: JACKET.id, options: { Size: 'XL' } })).lines).toEqual([]);
  });
});

describe('a yes counts only as a yes to an add', () => {
  it('after "want me to add it?": added', async () => {
    const id = await conversation(['XL', 'The Warrior Jacket is in stock in XL at £16. Want me to add it to your basket in XL?']);
    expect((await modelAdds(id, 'Yes please', { productId: JACKET.id, options: { Size: 'XL' } })).lines).toEqual([{ variantId: '704', quantity: 1 }]);
  });

  it('a size, in answer to "which size shall I add?": added', async () => {
    const id = await conversation(['Show me the Warrior Jacket', 'It is £16. Shall I add it to your basket? Which size?']);
    expect((await modelAdds(id, 'L', { productId: JACKET.id, options: { Size: 'L' } })).lines).toEqual([{ variantId: '703', quantity: 1 }]);
  });

  it('after "would you like another colour?": nothing added', async () => {
    const id = await conversation(["I'm usually M", 'Noted - M.'], ['Show me the Warrior Jacket', 'Here it is in black. Would you like another colour?']);
    expect((await modelAdds(id, 'Yes')).lines).toEqual([]);
  });
});

describe('"add it", then the size it was waiting for', () => {
  it('the size finishes the add, without another "add it"', async () => {
    const id = await conversation(['Show me the Warrior Jacket in black.', 'It is £16.']);
    const asked = await modelAdds(id, 'Add it', { productId: JACKET.id });
    expect(asked.lines).toEqual([]);
    expect(asked.result.speech).toMatch(/which size/i);
    await recordTurn(id, 'Add it', 'Which size would you like for the Warrior Jacket?');
    expect((await modelAdds(id, 'M')).lines).toEqual([{ variantId: '702', quantity: 1 }]);
  });

  it('but only as the very next thing they say', async () => {
    const id = await conversation(['Show me the Warrior Jacket in black.', 'It is £16.']);
    await modelAdds(id, 'Add it', { productId: JACKET.id });
    await recordTurn(id, 'Add it', 'Which size would you like for the Warrior Jacket?');
    await recordTurn(id, 'Is it waterproof?', 'Yes, it is described as waterproof.');
    // M is now a size they said, so only the lapsed ask stops it.
    expect((await modelAdds(id, 'M')).lines).toEqual([]);
  });
});

describe('a size tapped on a card is not an add', () => {
  async function tapped() {
    const id = await conversation(['Show me rain jackets', 'Here are the rain jackets.']);
    await sessions.patch(id, { cardChoices: { [JACKET.id]: { options: { Size: 'M' }, at: Date.now() } }, cardFocus: JACKET.id, focusProductId: JACKET.id });
    return id;
  }

  it('tap, then "is it waterproof?": nothing added', async () => {
    expect((await modelAdds(await tapped(), 'Is it waterproof?', { productId: JACKET.id })).lines).toEqual([]);
  });

  it('tap, then "add it": the tapped M goes in', async () => {
    expect((await modelAdds(await tapped(), 'Add it.', { productId: JACKET.id })).lines).toEqual([{ variantId: '702', quantity: 1 }]);
  });
});

describe('the Add button', () => {
  it('pressed in the widget - no chat message needed', async () => {
    // The size on the card came from them (their profile, or a tap); pressing Add is the ask.
    const id = await conversation(["I'm usually L", 'Noted - L.']);
    const session = await sessions.getOrCreate(id);
    const result = await runTool('add_to_cart', { productId: JACKET.id, options: { Size: 'L' }, quantity: 1 }, { session, direct: true });
    expect(result.actions?.[0]).toMatchObject({ lines: [{ variantId: '703', quantity: 1 }] });
  });
});

describe('how many', () => {
  it('more than one only when they say so', async () => {
    const said = (): Promise<string> => conversation(["I'm usually M", 'Noted - M.']);
    expect((await modelAdds(await said(), 'Add it', { productId: JACKET.id, options: { Size: 'M' }, quantity: 3 })).lines).toEqual([{ variantId: '702', quantity: 1 }]);
    expect((await modelAdds(await said(), 'Add two in M', { productId: JACKET.id, options: { Size: 'M' }, quantity: 2 })).lines).toEqual([{ variantId: '702', quantity: 2 }]);
  });
});

describe('tap, a question about it, then "add it"', () => {
  it('the tapped size still stands - the question was about the same product', async () => {
    const id = await conversation(['Show me rain jackets', 'Here are the rain jackets.']);
    await sessions.patch(id, { cardChoices: { [JACKET.id]: { options: { Size: 'M' }, at: Date.now() - 5000 } }, cardFocus: JACKET.id, focusProductId: JACKET.id });
    await recordTurn(id, 'Is it waterproof?', 'Yes - the Warrior Jacket is described as waterproof.');
    expect((await modelAdds(id, 'Add it.', { productId: JACKET.id })).lines).toEqual([{ variantId: '702', quantity: 1 }]);
  });
});
