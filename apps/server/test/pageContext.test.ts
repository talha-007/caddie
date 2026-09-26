import { describe, expect, it } from 'vitest';
import { pageContext } from '../src/ai/openai.js';
import { MemorySessionStore } from '../src/session/store.js';
import type { CaddieSession } from '../src/session/store.js';

function session(page?: CaddieSession['page']): CaddieSession {
  return {
    id: 's',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sizeProfile: {},
    preferences: {},
    messages: [],
    ...(page ? { page } : {}),
  };
}

describe('what the customer is looking at', () => {
  it('says nothing when the widget told us nothing', () => {
    expect(pageContext(session())).toBeNull();
  });

  /*
   * Every one of these is tokens on a call that does not cache, so a page
   * with nothing useful on it must cost nothing at all.
   */
  it('says nothing on a page that is not a product, collection or cart', () => {
    expect(pageContext(session({ pageType: 'other', productId: 'gid://shopify/Product/1' }))).toBeNull();
  });

  it('says nothing on a product page that did not give us the id', () => {
    expect(pageContext(session({ pageType: 'product', productTitle: 'Tour Polo' }))).toBeNull();
  });

  it('names the product so "this one" resolves', () => {
    const message = pageContext(session({ pageType: 'product', productId: 'gid://shopify/Product/42' }));
    expect(message?.content).toContain('gid://shopify/Product/42');
    expect(message?.content).toContain('"This"');
  });

  it('includes the title when the theme gave us one', () => {
    const message = pageContext(
      session({ pageType: 'product', productId: 'gid://shopify/Product/42', productTitle: 'Tour Polo' }),
    );
    expect(message?.content).toContain('Tour Polo');
  });

  it('mentions a cart page without inventing a product', () => {
    const message = pageContext(session({ pageType: 'cart' }));
    expect(message?.content).toContain('cart');
    expect(message?.content).not.toContain('gid://');
  });

  /*
   * Voice posts audio and no context, so the page has to survive on the
   * session or "what size am I in this" arrives attached to nothing.
   */
  it('is remembered across turns for the voice path', async () => {
    const store = new MemorySessionStore();
    await store.patch('v1', { page: { pageType: 'product', productId: 'gid://shopify/Product/7' } });
    await store.patch('v1', { sizeProfile: { heightValue: 180, heightUnit: 'cm' } });

    const saved = await store.get('v1');
    expect(saved?.page?.productId).toBe('gid://shopify/Product/7');
  });
});

/*
 * "Add this one pair tour ankle socks to my basket", on the socks' own page,
 * got "What size would you like?" - they come in one size. The model is told.
 */
describe('a product that comes in one size', async () => {
  const { setCatalogueForTests } = await import('../src/catalog/sync.js');
  const product = (id: string, options: Array<{ name: string; values: string[] }>) => ({
    id: `gid://shopify/Product/${id}`,
    title: `THING ${id}`,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [],
    price: { amount: 6, currency: 'GBP' },
    options,
    variants: [],
    description: null,
  });

  it('is said to come in one size, so no size is asked', () => {
    setCatalogueForTests([product('7', [{ name: 'Title', values: ['Default Title'] }])]);
    expect(pageContext(session({ pageType: 'product', productId: 'gid://shopify/Product/7' }))?.content).toContain('one size only - never ask which size');
  });

  it('a product with sizes says nothing of the kind', () => {
    setCatalogueForTests([product('8', [{ name: 'Size', values: ['S', 'M', 'L'] }])]);
    expect(pageContext(session({ pageType: 'product', productId: 'gid://shopify/Product/8' }))?.content).not.toContain('one size');
  });
});

describe('asked to add', async () => {
  const { asksToAdd } = await import('../src/tools/cartAuthorization.js');
  it('reads an add request, and not a refusal or a question', () => {
    expect(asksToAdd('Add this one pair tour ankle socks to my basket')).toBe(true);
    expect(asksToAdd("I'll take them")).toBe(true);
    expect(asksToAdd("Don't add it yet")).toBe(false);
    expect(asksToAdd('What are the available sizes?')).toBe(false);
  });
});
