import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@caddie/shared';

vi.mock('../src/shopify/catalog.js', () => ({ searchProducts: vi.fn() }));

const { searchProducts } = await import('../src/shopify/catalog.js');
const { recommendPack } = await import('../src/recommend/pack.js');

const search = vi.mocked(searchProducts);

function product(title: string, amount: number): Product {
  return {
    id: `gid://shopify/Product/${title}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [],
    price: { amount, currency: 'GBP' },
    options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
    variants: [],
    description: null,
  };
}

const RANGE = [product('GOLF TEE POLO', 24), product('TECH TROUSER', 58), product('CAPTAINS MIDLAYER', 10)];

/**
 * A pack used to depend on the customer's own phrasing matching the
 * catalogue. The index matches literal words, so "a pack of basic clothing"
 * found nothing and the customer was told we had nothing under their budget
 * while we had plenty. It was intermittent, because it turned on which words
 * the model happened to lift out of the conversation.
 */
describe('building a pack when the wording finds nothing', () => {
  beforeEach(() => {
    search.mockReset();
  });

  it('falls back to the range when the customer words match nothing', async () => {
    search.mockResolvedValueOnce([]).mockResolvedValueOnce(RANGE);

    const pack = await recommendPack({
      query: 'basic clothing',
      budget: { amount: 100, currency: 'GBP' },
    });

    expect(pack.items).toHaveLength(3);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('searches the customer words first, and the range only after', async () => {
    search.mockResolvedValueOnce([]).mockResolvedValueOnce(RANGE);

    await recommendPack({ query: 'basic clothing', budget: { amount: 100, currency: 'GBP' } });

    // Led by the range, so a pack is never kids unless asked (see catalog/audience.ts).
    expect(search.mock.calls[0]?.[0]?.query).toBe('mens basic clothing');
    expect(search.mock.calls[1]?.[0]?.query).toContain('polo');
  });

  /* The fallback is a rescue, not a widener: a pack of hoodies stays hoodies. */
  it('does not run the fallback when their own words filled the pack', async () => {
    search.mockResolvedValueOnce(RANGE);

    const pack = await recommendPack({ query: 'hoodie', budget: { amount: 100, currency: 'GBP' } });

    expect(pack.items).toHaveLength(3);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('keeps the better attempt when the fallback finds less', async () => {
    search.mockResolvedValueOnce(RANGE.slice(0, 2)).mockResolvedValueOnce([product('SOCKS', 9)]);

    const pack = await recommendPack({ query: 'shorts', budget: { amount: 100, currency: 'GBP' } });

    expect(pack.items).toHaveLength(2);
    expect(pack.items.map((item) => item.title)).not.toContain('SOCKS');
  });

  it('still says so honestly when the store really has nothing', async () => {
    search.mockResolvedValue([]);

    const pack = await recommendPack({ query: 'anything', budget: { amount: 100, currency: 'GBP' } });

    expect(pack.items).toEqual([]);
    expect(pack.reason).toContain('could not find');
  });
});
