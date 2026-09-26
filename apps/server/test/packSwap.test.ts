import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaddieAttachment, Product } from '@caddie/shared';
import { setDealsForTests, type DealRecipe } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { verifyReply } from '../src/ai/verify.js';
import { sessions } from '../src/session/store.js';
import { kindWanted, runTool } from '../src/tools/index.js';

/**
 * One piece of a pack changed to a colour. Asked to "change the colour of
 * trouser to white", the Caddie put black joggers on the card, told the
 * customer they were white, then said the white ones could not be had -
 * while the pack's own trousers came in white. And asked "do you have only
 * one Ambassador Pack?" it said yes, with a Ladies and a Kids one on sale.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function garment(title: string, sizes: string[], price = 30): Product {
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [...BRAND],
    price: { amount: price, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size) => ({ id: `${title}-${size}`, title: size, available: true, price: { amount: price, currency: 'GBP' }, options: { Size: size } })),
    description: null,
  };
}

const TOPS = ['S', 'M', 'L', 'XL'];
const WAIST = ['32', '34', '36'];
const POLO_NAVY = garment('ELITE POLO - NAVY', TOPS, 20);
const CLIMA_NAVY = garment("MEN'S CLIMA GOLF TROUSERS - NAVY", WAIST, 30);
const CLIMA_WHITE = garment("MEN'S CLIMA GOLF TROUSERS - WHITE", WAIST, 30);
const SHORTS_WHITE = garment('CLIMA GOLF SHORTS - WHITE', WAIST, 22);
const JOGGERS_BLACK = garment("MEN'S GOLF JOGGERS - BLACK", WAIST, 45);
const LADIES_POLO = garment('LADIES ELITE POLO - PINK', ['8', '10', '12'], 20);
const CAP = garment('KOMO CAP - NAVY', ['ONE SIZE'], 15);
const BEANIE = garment('TRIGON GOLF BEANIE - NAVY', ['ONE SIZE'], 14);
const BELT = garment('TOUR PRO BELT - BLACK', ['S/M', 'M/L'], 20);
// White trousers the store sells that the pack does not take.
const PREMIUM_WHITE = { ...garment('PREMIUM PLAY TROUSERS - WHITE', WAIST, 30), productType: 'TROUSERS' };

const step = (title: string, products: Product[]) => ({ title, collection: title, productIds: new Set(products.map((p) => p.id)) });
const MENS: DealRecipe = {
  handle: 'golf-ambassador-pack',
  title: 'AMBASSADOR PACK',
  range: 'men',
  prices: { GBP: 99.99 },
  dynamicPrices: false,
  url: '',
  steps: [
    step('POLO', [POLO_NAVY]),
    step('TROUSER / SHORTS', [CLIMA_NAVY, CLIMA_WHITE, SHORTS_WHITE, JOGGERS_BLACK]),
    step('BELT / CAP', [CAP, BEANIE, BELT]),
  ],
};
const LADIES: DealRecipe = { ...MENS, handle: 'ladies-ambassador-pack', title: 'LADIES AMBASSADOR PACK', range: 'women', steps: [step('POLO', [LADIES_POLO])] };
const KIDS: DealRecipe = { ...MENS, handle: 'kids-ambassador', title: 'KIDS AMBASSADOR', range: 'kids', prices: { GBP: 85 }, steps: [step('POLO', [LADIES_POLO])] };

let id = '';
beforeEach(async () => {
  setCatalogueForTests([POLO_NAVY, CLIMA_NAVY, CLIMA_WHITE, SHORTS_WHITE, JOGGERS_BLACK, LADIES_POLO, CAP, BEANIE, BELT, PREMIUM_WHITE]);
  setDealsForTests([MENS, LADIES, KIDS]);
  id = `swap-${Math.random()}`;
  await sessions.getOrCreate(id);
});
afterEach(() => setDealsForTests([]));

async function pack(args: Record<string, unknown>, utterance: string) {
  const session = await sessions.getOrCreate(id);
  const result = await runTool('recommend_pack', { query: 'Ambassador Pack', ...args }, { session, utterance });
  const items = result.attachment?.kind === 'pack' ? result.attachment.recommendation.items : [];
  return { result, titles: items.map((p) => p.title) };
}

describe('changing one piece to a colour', () => {
  it('uses the same trousers in white when the pack has them, even with no colour passed', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    // The model left the colour out - it is in the customer's words.
    const { result, titles } = await pack({ swap: CLIMA_NAVY.id }, 'I want to change the color of trouser to white.');
    expect(titles).toContain("MEN'S CLIMA GOLF TROUSERS - WHITE");
    expect(titles).toContain('ELITE POLO - NAVY');
    expect(result.speech).toMatch(/Clima Golf Trousers - White/);
  });

  it('says what colours it comes in, and changes nothing, when the step has none in that colour', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const { result } = await pack({ swap: CLIMA_NAVY.id }, 'change the trousers to pink');
    expect(result.attachment).toBeUndefined();
    expect(result.speech).toMatch(/doesn't come in pink/);
    expect(result.speech).toMatch(/white/);
    expect(result.facts).toMatch(/Never say it has been changed/);
  });

  it('still moves to a different design when they ask for a new design', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const { titles } = await pack({ swap: CLIMA_NAVY.id }, 'change the design of the trousers');
    expect(titles.some((t) => /CLIMA GOLF TROUSERS/.test(t))).toBe(false);
  });
});

describe('changing one piece to another kind', () => {
  it('"a belt instead of a cap" puts a belt in, not a beanie', async () => {
    const first = await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const hat = first.titles.find((t) => /CAP|BEANIE/.test(t))!;
    const hatId = [CAP, BEANIE].find((p) => p.title === hat)!.id;
    const { titles, result } = await pack({ swap: hatId }, 'I need a belt instead of a cap');
    expect(titles).toContain('TOUR PRO BELT - BLACK');
    expect(result.facts).toMatch(/-> TOUR PRO BELT - BLACK/);
  });

  it('"instead of" is a swap even when the model passes no piece to swap', async () => {
    const first = await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const { titles } = await pack({}, 'I need a belt instead of a cap');
    expect(titles).toContain('TOUR PRO BELT - BLACK');
    // Everything else stays as it was.
    expect(titles.filter((t) => !/BELT|CAP|BEANIE/.test(t))).toEqual(first.titles.filter((t) => !/BELT|CAP|BEANIE/.test(t)));
  });

  it('a kind passed as the replacement is a kind, not a product to look up', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const { titles } = await pack({ swap: CAP.id, swapWith: 'belt' }, 'swap it');
    expect(titles).toContain('TOUR PRO BELT - BLACK');
  });

  it('reads which kind they want', () => {
    const step = [CAP, BEANIE, BELT, CLIMA_NAVY, SHORTS_WHITE, JOGGERS_BLACK];
    expect(kindWanted('I need a belt instead of a cap', BEANIE, step)?.name).toBe('belt');
    expect(kindWanted('change the hat to a belt', CAP, step)?.name).toBe('belt');
    expect(kindWanted('a cap rather than the belt', BELT, step)?.name).toBe('cap');
    expect(kindWanted('swap the trousers for shorts', CLIMA_NAVY, step)?.name).toBe('shorts');
    // Only the kind going out: a different one of the same kind, no restriction.
    expect(kindWanted('change the colour of the trousers to white', CLIMA_NAVY, step)).toBeUndefined();
    // A kind the step does not hold is no help.
    expect(kindWanted('a visor instead', CAP, step)).toBeUndefined();
  });
});

describe('what the customer says about one piece', () => {
  const notTrousers = (titles: string[]) => titles.filter((t) => !/TROUSERS|SHORTS|JOGGERS/.test(t));

  it('"select the clima trousers in white" changes the trousers only, not the whole pack', async () => {
    const first = await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    // The model passed the colour and no piece: every piece used to be rebuilt in white.
    const { titles } = await pack({ colour: 'white', size: 'M' }, "Okay, you can select men's clima golf trousers which is white color.");
    expect(titles).toContain("MEN'S CLIMA GOLF TROUSERS - WHITE");
    expect(notTrousers(titles)).toEqual(notTrousers(first.titles));
  });

  it('a search to change a piece of the pack on screen is a swap in the pack', async () => {
    const first = await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const session = await sessions.getOrCreate(id);
    const result = await runTool('search_products', { query: 'white trousers', colour: 'white' }, { session, utterance: 'Also change this trouser with a white trouser.' });
    expect(result.attachment?.kind).toBe('pack');
    const titles = result.attachment?.kind === 'pack' ? result.attachment.recommendation.items.map((p) => p.title) : [];
    expect(titles).toContain("MEN'S CLIMA GOLF TROUSERS - WHITE");
    expect(notTrousers(titles)).toEqual(notTrousers(first.titles));
  });

  it('a search for a piece while the pack is on screen shows only what the pack takes', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const session = await sessions.getOrCreate(id);
    const result = await runTool('search_products', { query: 'white trousers', colour: 'white' }, { session, utterance: 'show me white trousers' });
    const titles = result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : [];
    expect(titles).toContain("MEN'S CLIMA GOLF TROUSERS - WHITE");
    expect(titles).not.toContain('PREMIUM PLAY TROUSERS - WHITE');
    expect(result.speech).toMatch(/any of these can go in the pack/);
  });

  it('picking one of those choices swaps it into the same pack', async () => {
    const first = await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    let session = await sessions.getOrCreate(id);
    await runTool('search_products', { query: 'white trousers', colour: 'white' }, { session, utterance: 'show me white trousers' });
    session = await sessions.getOrCreate(id);
    // No pack named, and the pack itself is no longer on screen.
    const result = await runTool('recommend_pack', { query: 'put it in', swapWith: CLIMA_WHITE.id }, { session, utterance: 'put the first one in' });
    const titles = result.attachment?.kind === 'pack' ? result.attachment.recommendation.items.map((p) => p.title) : [];
    expect(titles).toContain("MEN'S CLIMA GOLF TROUSERS - WHITE");
    expect(titles.filter((t) => !/TROUSERS/.test(t))).toEqual(first.titles.filter((t) => !/TROUSERS/.test(t)));
  });

  it('"put the first one in" goes into the pack even when the model reaches for add_to_cart', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    let session = await sessions.getOrCreate(id);
    await runTool('search_products', { query: 'white trousers', colour: 'white' }, { session, utterance: 'show me white trousers' });
    session = await sessions.getOrCreate(id);
    const result = await runTool('add_to_cart', { productId: CLIMA_WHITE.id }, { session, utterance: 'put the first one in' });
    const titles = result.attachment?.kind === 'pack' ? result.attachment.recommendation.items.map((p) => p.title) : [];
    expect(titles).toContain("MEN'S CLIMA GOLF TROUSERS - WHITE");
    expect(result.actions ?? []).toEqual([]);
  });

  it('asked for separately, the whole store is searched', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const session = await sessions.getOrCreate(id);
    const result = await runTool('search_products', { query: 'white trousers', colour: 'white' }, { session, utterance: 'show me white trousers to buy separately' });
    const titles = result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : [];
    expect(titles).toContain('PREMIUM PLAY TROUSERS - WHITE');
    expect(result.facts).toMatch(/never offer to put them in the pack/);
  });

  it('a design they name but the pack does not take is refused, even with no product passed', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    await pack({ swap: CLIMA_NAVY.id }, 'change the trousers to white');
    // The model passed only the piece going out; white shorts used to go in.
    const { result } = await pack({ swap: CLIMA_WHITE.id }, 'Swap this premium play trouser which is white.');
    expect(result.attachment).toBeUndefined();
    expect(result.speech).toMatch(/Premium Play Trousers - White aren't one of the pack's choices/);
  });

  it('naming the piece going out, with no colour, is not picking it again', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const { titles } = await pack({}, 'change the clima trousers');
    expect(titles).not.toContain("MEN'S CLIMA GOLF TROUSERS - NAVY");
    expect(titles.length).toBeGreaterThan(0);
  });

  it('a product the pack does not take: says so, offers the one the pack takes in that colour, changes nothing', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const { result } = await pack({ swap: CLIMA_NAVY.id, swapWith: PREMIUM_WHITE.id }, 'swap in the premium play trousers in white');
    expect(result.attachment).toBeUndefined();
    expect(result.speech).toMatch(/Premium Play Trousers - White aren't one of the pack's choices - the Men's Clima Golf Trousers - White is/);
  });
});

describe('other versions of the pack', () => {
  it('names the Ladies and Kids packs when asked about more than one', async () => {
    const { result } = await pack({}, 'Do you have only one ambassador pack?');
    expect(result.speech).toMatch(/Ladies and a Kids Ambassador Pack/);
    expect(result.facts).toMatch(/never say there is only one/);
  });

  it('keeps them in the facts, but out of the words, for a plain request', async () => {
    const { result } = await pack({}, 'show me the ambassador pack');
    expect(result.speech).not.toMatch(/Ladies/);
    expect(result.facts).toMatch(/LADIES|Ladies/);
  });
});

describe('the reply checker and colours', () => {
  const card: CaddieAttachment = {
    kind: 'pack',
    recommendation: { items: [POLO_NAVY, JOGGERS_BLACK], total: { amount: 99.99, currency: 'GBP' }, reason: '', overBudget: false },
  };
  const evidence = "ELITE POLO - NAVY, MEN'S GOLF JOGGERS - BLACK. Pack price £99.99.";

  it('catches a piece called a colour its card does not show', () => {
    const v = verifyReply('We can change the trouser to white golf joggers instead.', evidence, card);
    expect(v).toEqual([{ kind: 'colour', claim: 'white golf joggers' }]);
  });

  it('passes the colours the card does show', () => {
    expect(verifyReply('It has the navy Elite Polo and black golf joggers.', evidence, card)).toEqual([]);
  });

  it('does not read a colour across a comma', () => {
    expect(verifyReply('It has the Men\'s Golf Joggers in black, Elite Polo in navy.', evidence, card)).toEqual([]);
  });

  it('allows the colour of the piece just swapped out', () => {
    const swapped = `${evidence}\nChanged: MEN'S CLIMA GOLF TROUSERS - NAVY -> MEN'S GOLF JOGGERS - BLACK.`;
    const withTrousers: CaddieAttachment = {
      kind: 'pack',
      recommendation: { items: [POLO_NAVY, JOGGERS_BLACK, CLIMA_WHITE], total: { amount: 99.99, currency: 'GBP' }, reason: '', overBudget: false },
    };
    expect(verifyReply("I've replaced the navy Men's Clima Golf Trousers.", swapped, withTrousers)).toEqual([]);
  });

  it('leaves an offer alone', () => {
    expect(verifyReply('Would white golf joggers suit you better?', evidence, card)).toEqual([]);
  });
});

describe('sizes in the basket', () => {
  it('refuses a pack in sizes the customer never gave', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const session = await sessions.getOrCreate(id);
    const result = await runTool('add_pack_to_cart', { size: 'L', options: { waist: '34', leg: '32' } }, { session, utterance: 'okay, select the white trousers' });
    expect(result.facts).toMatch(/Nothing was added/);
    expect(result.actions ?? []).toEqual([]);
  });

  it('takes sizes they said, in words', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const session = await sessions.getOrCreate(id);
    const result = await runTool('add_pack_to_cart', { size: 'L', options: { waist: '34', leg: '32' } }, { session, utterance: "I'm a large, 34 waist, 32 leg" });
    expect(result.facts ?? '').not.toMatch(/Nothing was added/);
  });

  it('"I\'m" is not a size M', async () => {
    const session = await sessions.getOrCreate(id);
    const result = await runTool('add_to_cart', { productId: POLO_NAVY.id, options: { Size: 'M' } }, { session, utterance: "I'm happy with that one" });
    expect(result.facts).toMatch(/Nothing was added/);
  });
});

describe('only what the customer said', () => {
  it('a product the pack does not take, asked about, gets a no first', async () => {
    await pack({ colour: 'navy' }, 'show me the ambassador pack in navy');
    const session = await sessions.getOrCreate(id);
    const result = await runTool(
      'search_products',
      { query: 'premium play trousers white', colour: 'white' },
      { session, utterance: 'do you have premium play trousers in white for the pack?' },
    );
    expect(result.speech).toMatch(/^No - the Premium Play Trousers aren't part of the Ambassador Pack/);
    const titles = result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : [];
    expect(titles).not.toContain('PREMIUM PLAY TROUSERS - WHITE');
  });

  it('ignores a colour the model passes that the customer never said', async () => {
    const { titles } = await pack({ colour: 'white' }, 'show me the ambassador pack');
    // Built as if no colour were asked: the navy polo is the only polo, and nothing forces white trousers first.
    const plain = await (async () => {
      id = `swap-${Math.random()}`;
      await sessions.getOrCreate(id);
      return pack({}, 'show me the ambassador pack');
    })();
    expect(titles).toEqual(plain.titles);
  });
});
