import { describe, expect, it, vi } from 'vitest';
import type { Cart, Product } from '@caddie/shared';

/**
 * Basket actions for one session run one at a time. Four adds in one reply
 * once all read an empty basket and opened four baskets; the Vapi webhook
 * ran its tool calls in parallel, cart writes included. The gateway queues
 * them, and each reads the session the one before it left.
 */

const calls: string[] = [];
const cartIdsSeen: Array<string | undefined> = [];
vi.mock('../src/shopify/catalog.js', async (original) => ({
  ...(await original<typeof import('../src/shopify/catalog.js')>()),
  addToCart: vi.fn(async (cartId: string | undefined, variantId: string): Promise<Cart> => {
    cartIdsSeen.push(cartId);
    calls.push(`start ${variantId}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    calls.push(`end ${variantId}`);
    return { id: 'cart-1', lines: [], totalQuantity: 1, subtotal: { amount: 20, currency: 'GBP' }, checkoutUrl: '' } as unknown as Cart;
  }),
}));

const { setCatalogueForTests } = await import('../src/catalog/sync.js');
const { sessions } = await import('../src/session/store.js');
const { executeCommerceAction } = await import('../src/tools/actionGateway.js');
await import('../src/tools/index.js');
const { env } = await import('../src/env.js');

const product = (id: string): Product => ({
  id: `gid://shopify/Product/${id}`,
  title: `SOCKS ${id}`,
  url: '',
  imageUrl: null,
  vendor: 'Druids',
  productType: null,
  tags: [env.shopify.brandTag].filter(Boolean) as string[],
  price: { amount: 6, currency: 'GBP' },
  options: [{ name: 'Title', values: ['Default Title'] }],
  variants: [{ id: `gid://shopify/ProductVariant/${id}0`, title: 'Default Title', available: true, price: { amount: 6, currency: 'GBP' }, options: { Title: 'Default Title' } }],
  description: null,
});

describe('one session, one basket action at a time', () => {
  it('two adds at once: the second starts after the first ends, and uses the basket it opened', async () => {
    setCatalogueForTests([product('91'), product('92')]);
    const id = `serial-${Math.random()}`;
    await sessions.getOrCreate(id);
    await sessions.patch(id, { cartMode: 'storefront' });
    const session = await sessions.getOrCreate(id);
    const [a, b] = await Promise.all([
      executeCommerceAction({ session, direct: true }, { type: 'add-product', productId: 'gid://shopify/Product/91' }),
      executeCommerceAction({ session, direct: true }, { type: 'add-product', productId: 'gid://shopify/Product/92' }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(calls).toEqual(['start gid://shopify/ProductVariant/910', 'end gid://shopify/ProductVariant/910', 'start gid://shopify/ProductVariant/920', 'end gid://shopify/ProductVariant/920']);
    // One basket: the second add found the first one's cart.
    expect(cartIdsSeen).toEqual([undefined, 'cart-1']);
  });
});
