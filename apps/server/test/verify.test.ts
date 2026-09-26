import { beforeEach, describe, expect, it } from 'vitest';
import type { CaddieAttachment, Product } from '@caddie/shared';
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

/* ---------------- Features and fit ---------------- */

function described(title: string, description: string): Product {
  return { ...product(title), description };
}

// Each says exactly what its own description says - nothing more.
const WARM_GILET = described('ARVID GILET - NAVY', 'A windproof shell with warmth where you need it.');
const REGULAR_POLO = described('BLOCK PIQUE POLO - NAVY', 'Breathable and stretchy, with a regular fit.');
const NO_FIT_POLO = described('GARDEN POLO - NAVY', 'Breathable, moisture-wicking and lightweight.');
const SHOWER_JACKET = described('SHOWER JACKET - BLACK', 'A water-resistant shell for passing showers.');
const RAIN_JACKET = described('TEX RAIN JACKET - BLACK', 'Fully waterproof with taped seams.');
const LIGHT_POLO = described('FEATHER POLO - WHITE', 'A lightweight fabric for the course.');

describe('features and fit, held to each product\'s own data', () => {
  const all = [WARM_GILET, REGULAR_POLO, NO_FIT_POLO, SHOWER_JACKET, RAIN_JACKET, LIGHT_POLO];
  beforeEach(() => setCatalogueForTests(all));
  const card = (...items: Product[]): CaddieAttachment => ({ kind: 'products', products: items });
  const facts = all.map((p) => p.title).join('\n');
  const check = (reply: string, ...items: Product[]) => verifyReply(reply, facts, card(...items)).filter((v) => v.kind === 'attribute');

  it('warm is not insulated', () => {
    expect(check('The Arvid Gilet is warmly insulated.', WARM_GILET)).toEqual([{ kind: 'attribute', claim: 'insulated' }]);
    expect(check('The Arvid Gilet is warm and windproof.', WARM_GILET)).toEqual([]);
  });

  it('a regular fit is not a relaxed fit', () => {
    expect(check('The Block Pique Polo is a relaxed-fit polo.', REGULAR_POLO)).toEqual([{ kind: 'attribute', claim: 'relaxed fit' }]);
    expect(check('The Block Pique Polo has a regular fit.', REGULAR_POLO)).toEqual([]);
  });

  it('a fit the data does not state cannot be claimed', () => {
    expect(check('The Garden Polo has a relaxed cut.', NO_FIT_POLO)).toEqual([{ kind: 'attribute', claim: 'relaxed fit' }]);
  });

  it('water-resistant is not waterproof; waterproof is', () => {
    expect(check('The Shower Jacket is waterproof.', SHOWER_JACKET)).toEqual([{ kind: 'attribute', claim: 'waterproof' }]);
    expect(check('The Shower Jacket is water-resistant.', SHOWER_JACKET)).toEqual([]);
    expect(check('The Tex Rain Jacket is fully waterproof.', RAIN_JACKET)).toEqual([]);
    // A waterproof jacket is also water-resistant: the weaker claim is true.
    expect(check('The Tex Rain Jacket is water resistant.', RAIN_JACKET)).toEqual([]);
  });

  it('lightweight is not breathable', () => {
    expect(check('The Feather Polo is lightweight.', LIGHT_POLO)).toEqual([]);
    expect(check('The Feather Polo is breathable.', LIGHT_POLO)).toEqual([{ kind: 'attribute', claim: 'breathable' }]);
  });

  it('ordinary wording differences are fine', () => {
    expect(check('The Garden Polo is moisture wicking, breathable and light weight.', NO_FIT_POLO)).toEqual([]);
    expect(check('The Block Pique Polo is stretch and breathable.', REGULAR_POLO)).toEqual([]);
  });

  it('each product is held to its own features', () => {
    expect(check('The Tex Rain Jacket is waterproof and the Feather Polo is lightweight.', RAIN_JACKET, LIGHT_POLO)).toEqual([]);
    const swapped = check('The Feather Polo is waterproof and the Tex Rain Jacket is lightweight.', RAIN_JACKET, LIGHT_POLO);
    expect(swapped.map((v) => v.claim).sort()).toEqual(['lightweight', 'waterproof']);
  });

  it('"it" is the product just named', () => {
    expect(check("I'd start with the Garden Polo. It has a relaxed cut.", REGULAR_POLO, NO_FIT_POLO)).toEqual([{ kind: 'attribute', claim: 'relaxed fit' }]);
  });

  it('what the customer wants is not a product fact - but saying they want it is fine', () => {
    const evidence = `${facts}\nI'm XL and prefer a relaxed fit.`;
    const claimed = verifyReply('The Garden Polo is a relaxed-fit polo in navy.', evidence, card(NO_FIT_POLO)).filter((v) => v.kind === 'attribute');
    expect(claimed).toEqual([{ kind: 'attribute', claim: 'relaxed fit' }]);
    expect(check("You prefer a relaxed fit; the Garden Polo's description doesn't state its cut.", NO_FIT_POLO)).toEqual([]);
  });

  it('an offer of other products says nothing about this one; naming one still does', () => {
    expect(check('The Arvid Gilet is not stated as waterproof. Would you like to see waterproof gilets instead?', WARM_GILET)).toEqual([]);
    expect(check('The Arvid Gilet is warm. Here are some waterproof alternatives.', WARM_GILET)).toEqual([]);
    expect(check('Would you like the insulated Arvid Gilet?', WARM_GILET)).toEqual([{ kind: 'attribute', claim: 'insulated' }]);
  });

  it('saying what it is not is not a claim', () => {
    expect(check("The Arvid Gilet is warm and windproof; its description doesn't say it's insulated.", WARM_GILET)).toEqual([]);
  });

  it('the last resort drops the sentence however the claim was worded', () => {
    const reply = 'The Block Pique Polo is a relaxed-fit polo. It is £24.00.';
    expect(withoutClaims(reply, [{ kind: 'attribute', claim: 'relaxed fit' }])).toBe('It is £24.00.');
  });
});

/* ---------------- Garment shape ---------------- */

/*
 * "The Pure Midlayer in black is warm and sleeveless": asked for something
 * sleeveless, the model was handed midlayers and gave one the shape the
 * customer wanted. A shape is the product's only when its own title, type or
 * description says so.
 */
describe("garment shape, held to each product's own data", () => {
  const typed = (title: string, type: string, description: string): Product => ({ ...product(title), productType: type, description });
  const PURE = typed('PURE MIDLAYER - BLACK', 'MIDLAYERS', 'Lightweight, with warmth for cooler days, to layer over your shirt. Moisture-wicking stretch fabric.');
  const ARVID = typed('ARVID GILET - BLACK', 'GILETS', 'Lightweight warmth, water-resistant and windproof, with a full-length zipper.');
  const HOODIE = typed('TEE-TIME HOODIE - BLACK', 'MIDLAYERS', 'Soft brushed fabric for cooler rounds.');
  const ZIP_TOP = typed('ULTRA BLEND 3.0 1/4 ZIP - WHITE', 'MIDLAYERS', 'Breathable, warm and stretchy.');
  const LONG_BASE = typed('CREW BASELAYER - BLACK', 'BASELAYER TOPS', 'A long sleeve base layer, breathable and moisture-wicking.');
  const POLO = typed('ELITE POLO - NAVY', 'POLOS', 'Breathable and lightweight with a slim cut.');
  const all = [PURE, ARVID, HOODIE, ZIP_TOP, LONG_BASE, POLO];
  beforeEach(() => setCatalogueForTests(all));
  const facts = all.map((p) => p.title).join('\n');
  const shape = (reply: string, ...items: Product[]) =>
    verifyReply(reply, facts, { kind: 'products', products: items })
      .filter((v) => v.kind === 'attribute')
      .map((v) => v.claim);

  it('the blocker: a midlayer is not sleeveless because the customer wanted sleeveless', () => {
    expect(shape('The Pure Midlayer in black is warm and sleeveless.', PURE)).toEqual(['sleeveless']);
    expect(shape('The Pure Midlayer has no sleeves.', PURE)).toEqual(['sleeveless']);
    // The customer's words are not the product's.
    const evidence = `${facts}\nI want something warm but sleeveless for a cold morning`;
    expect(verifyReply('The Pure Midlayer is warm and sleeveless.', evidence, { kind: 'products', products: [PURE] }).map((v) => v.claim)).toContain('sleeveless');
  });

  it('a gilet is sleeveless by its own name', () => {
    expect(shape('The Arvid Gilet is sleeveless.', ARVID)).toEqual([]);
    expect(shape('The Arvid Gilet is a warm, sleeveless layer.', ARVID)).toEqual([]);
  });

  it('never leaks from one product to another', () => {
    expect(shape('The Arvid Gilet and the Pure Midlayer are both sleeveless.', ARVID, PURE)).toEqual(['sleeveless']);
    expect(shape('The Arvid Gilet is sleeveless. The Pure Midlayer is warm.', ARVID, PURE)).toEqual([]);
    expect(shape("I'd start with the Arvid Gilet. The Pure Midlayer is sleeveless too.", ARVID, PURE)).toEqual(['sleeveless']);
  });

  it('hooded: a hoodie has a hood; a midlayer that says nothing of one does not', () => {
    expect(shape('The Tee-Time Hoodie has a hood.', HOODIE)).toEqual([]);
    expect(shape('The Tee-Time Hoodie is hooded.', HOODIE)).toEqual([]);
    expect(shape("The Pure Midlayer is hooded.", PURE)).toEqual(['hooded']);
    expect(shape('The Pure Midlayer comes with a hood.', PURE)).toEqual(['hooded']);
  });

  it('sleeve length needs saying: long sleeve where stated, never assumed for a polo', () => {
    expect(shape('The Crew Baselayer is long-sleeved.', LONG_BASE)).toEqual([]);
    expect(shape('The Elite Polo is short-sleeved.', POLO)).toEqual(['short sleeve']);
    expect(shape('The Pure Midlayer has long sleeves.', PURE)).toEqual(['long sleeve']);
  });

  it('zips: a quarter zip is a quarter zip, not a full zip, and a zip is neither', () => {
    expect(shape('The Ultra Blend 3.0 1/4 Zip is a quarter-zip.', ZIP_TOP)).toEqual([]);
    expect(shape('The Ultra Blend 3.0 1/4 Zip is a full zip.', ZIP_TOP)).toEqual(['full zip']);
    expect(shape('The Arvid Gilet has a full zip.', ARVID)).toEqual([]);
    expect(shape('The Pure Midlayer is a half-zip.', PURE)).toEqual(['half zip']);
  });

  it('necks: crew where the name says crew; a v-neck needs saying', () => {
    expect(shape('The Crew Baselayer has a crew neck.', LONG_BASE)).toEqual([]);
    expect(shape('The Elite Polo has a v-neck.', POLO)).toEqual(['v-neck']);
    expect(shape('The Pure Midlayer has a zip neck.', PURE)).toEqual(['zip neck']);
  });

  it('saying what it is not, or cannot be confirmed, is not a claim', () => {
    expect(shape("The Pure Midlayer's description doesn't say it's sleeveless.", PURE)).toEqual([]);
    expect(shape("The Pure Midlayer isn't hooded.", PURE)).toEqual([]);
    expect(shape("I can't confirm whether the Elite Polo is short sleeved.", POLO)).toEqual([]);
  });

  it('the last resort drops the sentence that makes the claim', () => {
    const reply = 'The Pure Midlayer in black is warm and sleeveless. What size do you need?';
    expect(withoutClaims(reply, [{ kind: 'attribute', claim: 'sleeveless' }])).toBe('What size do you need?');
  });
});
