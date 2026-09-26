import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { verifyReply, withoutClaims } from '../src/ai/verify.js';

/**
 * Every reply checked against what the tools said this turn. Each case is a
 * reply the Caddie actually gave.
 */

function product(title: string, price = 24): Product {
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [],
    price: { amount: price, currency: 'GBP' },
    options: [],
    variants: [],
    description: null,
  };
}

const VENTO = product('VENTO POLO - NAVY', 22);
const HECTAR = product('HECTAR MIDLAYER - GREY', 34);
const TOUR = product('TOUR CHAMPIONSHIP JACKET - BLACK', 90);

beforeEach(() => setCatalogueForTests([VENTO, HECTAR, TOUR]));

const packCard = {
  kind: 'pack' as const,
  recommendation: { items: [HECTAR, VENTO], total: { amount: 129.99, currency: 'GBP' }, reason: '', overBudget: false },
};

describe('prices', () => {
  const evidence = 'Results: VENTO POLO - NAVY - £22.00. Pack price £129.99. Bought separately these come to £150.00.';

  it('passes a price the tools gave, and a saving worked out from two of them', () => {
    expect(verifyReply('The Vento Polo is £22.00.', evidence)).toEqual([]);
    expect(verifyReply('That saves you £20.01 on buying them separately.', evidence)).toEqual([]);
  });

  it('catches a price no tool gave', () => {
    // A pack whose pieces came to £130, quoted at its £159.99 list price.
    expect(verifyReply('All for £159.99 as a fixed pack price.', evidence)).toEqual([{ kind: 'price', claim: '£159.99' }]);
  });

  it('allows the customer\'s own budget, which is in their words', () => {
    expect(verifyReply('Within your £50 budget.', `${evidence}\nI want a polo under £50`)).toEqual([]);
  });
});

describe('products', () => {
  it('catches a product the tools never mentioned', () => {
    const v = verifyReply('I would go for the Tour Championship Jacket.', 'Results: VENTO POLO - NAVY - £22.00');
    expect(v).toEqual([{ kind: 'product', claim: 'tour championship jacket' }]);
  });

  it('passes one that is in the results', () => {
    expect(verifyReply('The Vento Polo in navy is a good start.', 'Results: VENTO POLO - NAVY - £22.00')).toEqual([]);
  });
});

describe('counts', () => {
  it('catches "6 polos" for a pack with one polo', () => {
    const v = verifyReply('The pack for mixed conditions with 6 polos is £129.99.', 'Pack price £129.99', packCard);
    expect(v).toEqual([{ kind: 'count', claim: '6 polos' }]);
  });

  it('passes a count the card holds', () => {
    expect(verifyReply('It has one polo and a midlayer.', 'Pack price £129.99', packCard)).toEqual([]);
  });
});

describe('the last resort', () => {
  it('drops only the sentences that make the claim', () => {
    const reply = 'The Vento Polo is £22.00. The pack is £159.99 fixed. What size are you?';
    expect(withoutClaims(reply, [{ kind: 'price', claim: '£159.99' }])).toBe('The Vento Polo is £22.00. What size are you?');
  });
});
