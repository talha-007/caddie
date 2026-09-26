import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { attributesOf, featuresAsked } from '../src/catalog/attributes.js';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { lookupProductName, unknownNameIn } from '../src/catalog/lookup.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { normaliseQuery } from '../src/catalog/taxonomy.js';
import { env } from '../src/env.js';
import { nextStep } from '../src/recommend/nextStep.js';
import { slotWeight } from '../src/recommend/outfit.js';
import { rankProducts } from '../src/recommend/rank.js';
import { categoryForProduct, recommendSize } from '../src/recommend/size.js';
import { sessions } from '../src/session/store.js';
import { describeProfile, mergeProfile, readIntent, standingPart } from '../src/shopper/profile.js';
import { runTool } from '../src/tools/index.js';

/**
 * The sales brain: what the customer wants, held as requirements and
 * preferences; products ranked on verified facts; sizes that know the
 * garment. Each case is a behaviour the Caddie got wrong, or could not do,
 * before - see the brief in the commit that added this file.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
const SIZES = ['S', 'M', 'L', 'XL', '2XL'];

function garment(title: string, over: Partial<Product> & { sizes?: string[]; out?: string[] } = {}): Product {
  const { sizes = SIZES, out = [], ...rest } = over;
  const price = rest.price ?? { amount: 30, currency: 'GBP' };
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [...BRAND],
    price,
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size) => ({
      id: `${title}-${size}`,
      title: size,
      available: !out.includes(size),
      price,
      options: { Size: size },
    })),
    description: null,
    ...rest,
  };
}

const NAVY_POLO = garment('VENTO POLO - NAVY', {
  productType: 'POLOS',
  description: 'A lightweight, breathable polo with moisture-wicking fabric. Athletic cut. 90% polyester 10% spandex.',
});
const BLACK_POLO = garment('SLATE POLO - BLACK', { productType: 'POLOS', price: { amount: 45, currency: 'GBP' }, description: 'Breathable and stretchy.' });
const ORANGE_POLO = garment('PEAK POLO - ORANGE', { productType: 'POLOS', price: { amount: 25, currency: 'GBP' }, description: 'Lightweight and breathable, keeps you cool.' });
const DEAR_POLO = garment('TOUR POLO - NAVY', { productType: 'POLOS', price: { amount: 65, currency: 'GBP' }, description: 'Premium polo.' });
const RAIN_JACKET = garment('STORM JACKET - BLACK', {
  productType: 'JACKETS',
  price: { amount: 70, currency: 'GBP' },
  description: 'Fully waterproof with taped seams and a detachable hood. Windproof and breathable.',
});
const SOFTSHELL = garment('ARCHER JACKET - NAVY', { productType: 'JACKETS', price: { amount: 55, currency: 'GBP' }, description: 'A smart softshell for cool mornings. This is not waterproof.' });
const RAINSUIT_NAMED = garment('RAINSUIT JACKET - GREY', { productType: 'JACKETS', description: 'Our classic suit top.' });
const RAIN_TROUSERS = garment('STORM TROUSERS - BLACK', {
  productType: 'TROUSERS',
  sizes: ['30', '32', '34', '36'],
  description: 'Waterproof over trousers.',
});
const TROUSERS = garment('TECH TROUSER - NAVY', { productType: 'TROUSERS', sizes: ['30', '32', '34', '36'], description: 'Stretch trousers.' });
const MIDLAYER = garment('CORE MIDLAYER - GREY', { productType: 'MIDLAYERS', description: 'A warm quarter zip with a brushed back.' });

const CATALOGUE = [NAVY_POLO, BLACK_POLO, ORANGE_POLO, DEAR_POLO, RAIN_JACKET, SOFTSHELL, RAINSUIT_NAMED, RAIN_TROUSERS, TROUSERS, MIDLAYER];
const titles = (products: Product[]) => products.map((p) => p.title);

beforeEach(() => {
  setCatalogueForTests(CATALOGUE);
  setDealsForTests([]);
});

/* ---------------- Verified attributes ---------------- */

describe('verified product attributes', () => {
  it('reads features, cut and fabric from the description', () => {
    const a = attributesOf(NAVY_POLO);
    expect(a.features).toEqual(expect.arrayContaining(['lightweight', 'breathable', 'moisture-wicking', 'stretch']));
    expect(a.fit).toBe('athletic');
    expect(a.materials).toEqual(['90% polyester', '10% spandex']);
  });

  it('never calls something waterproof its description does not', () => {
    expect(attributesOf(SOFTSHELL).features).not.toContain('waterproof');
    // "Rainsuit" in the name is not a statement that it is waterproof.
    expect(attributesOf(RAINSUIT_NAMED).features).not.toContain('waterproof');
    expect(attributesOf(RAIN_JACKET).features).toEqual(expect.arrayContaining(['waterproof', 'windproof', 'hooded']));
  });

  it('does not read "keeps you cool on warm days" as a warm garment', () => {
    expect(attributesOf(garment('X POLO', { description: 'Keeps you cool on warm days.' })).features).not.toContain('warm');
  });
});

/* ---------------- Search semantics ---------------- */

describe('customer words into catalogue words', () => {
  it('a rain top is a jacket that has to be waterproof', () => {
    const q = normaliseQuery('rain top');
    expect(q.query).toBe('rain jacket');
    expect(q.features).toEqual(['waterproof']);
  });

  it('a jumper is a midlayer, golf bottoms are trousers', () => {
    expect(normaliseQuery('navy jumper').query).toBe('navy jumper midlayer hoodie');
    expect(normaliseQuery('golf bottoms').query).toBe('trousers');
  });

  it('keeps the word the product is named by - INFINITE RAIN TROUSERS was lost as plain "trousers"', () => {
    expect(normaliseQuery('rain trousers').query).toBe('rain trousers');
    expect(normaliseQuery('rain trousers').features).toEqual(['waterproof']);
  });

  it('keeps every describing word', () => {
    expect(normaliseQuery('plain white polo').query).toBe('plain white polo');
    expect(normaliseQuery('plain white rain top').query).toBe('plain white rain jacket');
  });

  it('hears the features a customer asks for', () => {
    expect(featuresAsked('something to keep me dry')).toContain('waterproof');
    expect(featuresAsked('a lightweight polo')).toContain('lightweight');
    expect(featuresAsked('something for warm weather')).not.toContain('warm');
  });
});

/* ---------------- Reading what they want ---------------- */

describe('budget semantics', () => {
  it('"under" is a hard ceiling, "around" is near it, "ideally" is a wish', () => {
    expect(readIntent('polos under £100').budget).toMatchObject({ amount: 100, kind: 'max' });
    expect(readIntent('something around £100').budget).toMatchObject({ amount: 100, kind: 'around' });
    expect(readIntent('ideally under £60').budget).toMatchObject({ amount: 60, kind: 'ideal' });
    expect(readIntent('nothing over 60 quid').budget).toMatchObject({ amount: 60, kind: 'max' });
  });

  it('knows each from total', () => {
    expect(readIntent('£50 each').budget?.per).toBe('item');
    expect(readIntent("don't want to spend more than £50 on a polo").budget).toMatchObject({ amount: 50, kind: 'max', per: 'item' });
    expect(readIntent('an outfit, £150 in total').budget).toMatchObject({ amount: 150, per: 'total' });
    expect(readIntent('a pack under £100').budget?.per).toBe('total');
  });

  it('is not fooled by a measurement', () => {
    expect(readIntent('I need trousers, under 34 waist').budget).toBeUndefined();
    expect(readIntent('my chest is 42 inches').budget).toBeUndefined();
  });
});

describe('colour: requirement, preference or just this request', () => {
  it('"only navy" is a standing requirement', () => {
    const intent = readIntent('I only want navy');
    expect(intent.colours).toEqual({ words: ['navy'], strength: 'required' });
    expect(standingPart(intent).colours).toBeDefined();
  });

  it('"I\'d prefer navy" and "maybe navy or black" are preferences', () => {
    expect(readIntent("I'd prefer navy").colours?.strength).toBe('preferred');
    expect(readIntent('maybe navy or black').colours).toEqual({ words: ['navy', 'black'], strength: 'preferred' });
  });

  it('"show me blue polos" binds this search only, and is not remembered', () => {
    const intent = readIntent('show me blue polos');
    expect(intent.colours?.strength).toBe('required');
    expect(standingPart(intent).colours).toBeUndefined();
  });

  it('"anything but black" is a colour to avoid, not black', () => {
    const intent = readIntent('any polo, anything but black');
    expect(intent.avoidColours).toEqual(['black']);
    expect(intent.colours).toBeUndefined();
  });
});

describe('the rest of the profile', () => {
  it('reads usual size, fit, layering, weather and a purchase boundary', () => {
    const intent = readIntent("I'm usually XL, prefer a relaxed fit, and want room to layer underneath for cold mornings");
    expect(intent.usualSize).toBe('XL');
    expect(intent.fit).toBe('relaxed');
    expect(intent.layering).toBe(true);
    expect(intent.weather).toContain('cold');
    expect(readIntent('just the jacket please').justThis).toBe('jacket');
  });

  it('a later statement overrides, turned-down products accumulate, and asking for more lifts "just this"', () => {
    let profile = mergeProfile(undefined, { budget: { amount: 50, kind: 'max', per: 'item' }, rejected: ['a'], justThis: 'jacket' });
    profile = mergeProfile(profile, { budget: { amount: 80, kind: 'around', per: 'item' }, rejected: ['b'] });
    expect(profile.budget).toEqual({ amount: 80, kind: 'around', per: 'item' });
    expect(profile.rejected).toEqual(['a', 'b']);
    profile = mergeProfile(profile, readIntent('what else goes with it?'));
    expect(profile.justThis).toBeUndefined();
  });

  it('is described to the model without a raw score or anything to read aloud', () => {
    const text = describeProfile({ usualSize: 'XL', fit: 'relaxed', colours: { words: ['navy', 'black'], strength: 'preferred' }, budget: { amount: 50, kind: 'max', per: 'item' } });
    expect(text).toContain('usually wears XL');
    expect(text).toContain('navy or black (preferred)');
    expect(text).toContain('no more than £50 per item (a hard limit)');
  });
});

/* ---------------- Ranking ---------------- */

describe('ranking verified candidates', () => {
  const polos = [ORANGE_POLO, BLACK_POLO, NAVY_POLO, DEAR_POLO];

  it('a preferred colour ranks first without removing the rest', () => {
    const ranked = rankProducts(polos, { colours: { words: ['navy'], strength: 'preferred' } });
    expect(ranked[0]!.product.title).toMatch(/NAVY/);
    expect(ranked).toHaveLength(4);
    expect(ranked.find((r) => r.product === ORANGE_POLO)!.matchLevel).toBe('strong');
  });

  it('a required colour marks everything else partial', () => {
    const ranked = rankProducts(polos, { colours: { words: ['navy'], strength: 'required' } });
    expect(ranked.find((r) => r.product === ORANGE_POLO)!.matchLevel).toBe('partial');
  });

  it('a hard budget is never beaten, a stated reason is given from facts', () => {
    const ranked = rankProducts(polos, { budget: { amount: 50, kind: 'max', per: 'item' }, size: 'XL', colours: { words: ['navy'], strength: 'preferred' } });
    const top = ranked[0]!;
    expect(top.product).toBe(NAVY_POLO);
    expect(top.matchLevel).toBe('exact');
    expect(top.reason).toContain('within your £50 budget');
    expect(top.reason).toContain('XL is in stock');
    expect(top.reason).not.toMatch(/score|\d+\.\d/);
    expect(ranked.find((r) => r.product === DEAR_POLO)!.matchLevel).toBe('partial');
  });

  it('"around £40" favours the nearest price rather than the cheapest', () => {
    const ranked = rankProducts([ORANGE_POLO, BLACK_POLO, DEAR_POLO], { budget: { amount: 45, kind: 'around', per: 'item' } });
    expect(ranked[0]!.product).toBe(BLACK_POLO);
  });

  it('a required feature is checked against the description, not the name', () => {
    const ranked = rankProducts([SOFTSHELL, RAINSUIT_NAMED, RAIN_JACKET], { features: { required: ['waterproof'], preferred: [] } });
    expect(ranked[0]!.product).toBe(RAIN_JACKET);
    expect(ranked[0]!.matchLevel).toBe('exact');
    expect(ranked.find((r) => r.product === RAINSUIT_NAMED)!.matchLevel).toBe('partial');
  });

  it('a size that is sold out, or a product turned down, drops to partial', () => {
    const soldOut = garment('GRID POLO - NAVY', { out: ['XL'] });
    const ranked = rankProducts([soldOut, NAVY_POLO], { size: 'XL', rejected: [NAVY_POLO.id] });
    expect(ranked.every((r) => r.matchLevel === 'partial')).toBe(true);
  });
});

/* ---------------- Named products ---------------- */

describe('whether we stock a named product', () => {
  it('finds a real name, whatever the colour or garment word', () => {
    const result = lookupProductName('the Vento polo in navy');
    expect(result?.status).toBe('exact');
  });

  it('proves absence from the whole catalogue, and offers the nearest names', () => {
    const result = lookupProductName('Druids Tour Championship Jacket');
    expect(result?.status).toBe('not-stocked');
    if (result?.status === 'not-stocked') expect(titles(result.closest)).toContain('TOUR POLO - NAVY');
  });

  it('spots a name in plain search words when a word appears nowhere in the catalogue', () => {
    expect(unknownNameIn('Tour Championship Jacket')?.status).toBe('not-stocked');
    // Ordinary describing words are in descriptions, so they are never taken for a name.
    expect(unknownNameIn('breathable polo')).toBeNull();
    // Nor a place, an occasion or a size - each was once called a product we do not stock.
    expect(unknownNameIn('lightweight polo for spain')).toBeNull();
    expect(unknownNameIn('something for a wedding')).toBeNull();
    expect(unknownNameIn('vento polo xl')).toBeNull();
  });

  it('claims nothing about a kind of thing', () => {
    expect(lookupProductName('a navy polo')).toBeNull();
  });

  it('claims nothing when the catalogue is not loaded', () => {
    setCatalogueForTests([]);
    expect(lookupProductName('Tour Championship Jacket')?.status).toBe('unknown');
  });
});

/* ---------------- Sizing ---------------- */

describe('size as a fit recommendation', () => {
  it('a 42 inch chest reads straight off the chart, with high confidence', () => {
    const result = recommendSize({ audience: 'men', chestCm: 42 * 2.54 });
    expect(result.size).toBe('L');
    expect(result.confidenceLevel).toBe('high');
  });

  it('liking it loose low in the band keeps the size and offers the next one up, with why', () => {
    const result = recommendSize({ audience: 'men', chestCm: 42 * 2.54, fitPreference: 'relaxed' });
    expect(result.size).toBe('L');
    expect(result.alternativeSize).toBe('XL');
    expect(result.alternativeReason).toMatch(/loose|layer/);
  });

  it('liking it loose high in the band sizes up', () => {
    expect(recommendSize({ audience: 'men', chestCm: 110, fitPreference: 'relaxed' }).size).toBe('XL');
  });

  it('between two sizes is medium confidence, with the other as a real option', () => {
    const result = recommendSize({ audience: 'men', chestCm: 103.8 });
    expect(result.confidenceLevel).toBe('medium');
    expect(result.alternativeSize).toBe('L');
  });

  it('height and weight alone is an estimate, said as one', () => {
    const result = recommendSize({ audience: 'men', heightValue: 180, heightUnit: 'cm', weightValue: 80, weightUnit: 'kg' });
    expect(result.confidenceLevel).toBe('estimate');
    expect(result.reason).toMatch(/estimate/);
  });

  it('the same customer can need a different size in a close-cut garment', () => {
    const relaxedCut = recommendSize({ audience: 'men', chestCm: 110, fitPreference: 'relaxed' }, { productFit: 'relaxed', productTitle: 'EASY POLO' });
    const athletic = recommendSize({ audience: 'men', chestCm: 110, fitPreference: 'relaxed' }, { productFit: 'athletic', productTitle: 'VENTO POLO - NAVY' });
    expect(relaxedCut.size).toBe('L');
    expect(athletic.size).toBe('XL');
  });

  it('room to layer sizes up a jacket at the top of its band', () => {
    expect(recommendSize({ audience: 'men', chestCm: 110, category: 'jacket' }, { layering: true }).size).toBe('XL');
  });

  it('picks the chart from the product itself', () => {
    expect(categoryForProduct('men', 'TROUSERS TECH TROUSER - NAVY')).toBe('trousers');
    expect(categoryForProduct('men', 'POLOS VENTO POLO - NAVY')).toBe('polo');
    expect(categoryForProduct('men', 'GILETS CORE GILET')).toBe('jacket');
    expect(categoryForProduct('women', 'LADIES SKORT - WHITE')).toBe('skort');
  });
});

/* ---------------- Budgets across an outfit ---------------- */

describe('where a total outfit budget goes', () => {
  it('puts the money into the outer layer in the wet, and the top in the heat', () => {
    expect(slotWeight('layer', ['wet'])).toBeGreaterThan(slotWeight('top', ['wet']));
    expect(slotWeight('top', ['hot'])).toBeGreaterThan(slotWeight('layer', ['hot']));
    expect(slotWeight('accessory')).toBeLessThan(slotWeight('bottom'));
  });
});

/* ---------------- Cross-selling ---------------- */

describe('the next step', () => {
  it('a waterproof jacket suggests waterproof trousers', async () => {
    const step = await nextStep([RAIN_JACKET], {});
    expect(step?.productId).toBe(RAIN_TROUSERS.id);
  });

  it('"just the jacket" suggests nothing', async () => {
    expect(await nextStep([RAIN_JACKET], { profile: { justThis: 'jacket' } })).toBeNull();
  });

  it('a deal saving is only offered when both prices are real and it saves money', async () => {
    const steps = [NAVY_POLO, RAIN_JACKET, TROUSERS].map((p, i) => ({ title: `Step ${i}`, collection: `c${i}`, productIds: new Set([p.id]) }));
    setDealsForTests([{ handle: 'test-pack', title: 'TEST PACK', range: 'men', prices: { GBP: 99 }, dynamicPrices: false, steps, url: '' }]);
    const step = await nextStep([NAVY_POLO], { basketProductIds: [RAIN_JACKET.id, TROUSERS.id] });
    expect(step?.line).toContain('Verified saving');
    expect(step?.line).toContain('£130.00');
  });
});

/* ---------------- Through the search tool ---------------- */

describe('search_products with a shopper profile', () => {
  let id = '';
  beforeEach(async () => {
    id = `brain-${Math.random()}`;
    await sessions.getOrCreate(id);
  });
  afterEach(() => setDealsForTests([]));

  async function search(args: Record<string, unknown>, utterance: string) {
    const session = await sessions.getOrCreate(id);
    const result = await runTool('search_products', args, { session, utterance });
    return { result, shown: result.attachment?.kind === 'products' ? titles(result.attachment.products) : [] };
  }

  it('"I\'d prefer navy" leads with navy but still shows other colours', async () => {
    const { shown, result } = await search({ query: 'polo', colour: 'navy' }, "I'd prefer navy - show me polos");
    expect(shown[0]).toMatch(/NAVY/);
    expect(shown.some((t) => !/NAVY/.test(t))).toBe(true);
    expect(result.facts).toContain('preference');
  });

  it('"I only want navy" shows navy only', async () => {
    const { shown } = await search({ query: 'polo', colour: 'navy' }, 'I only want navy polos');
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((t) => /NAVY/.test(t))).toBe(true);
  });

  it('a rain top puts the verified waterproof jacket forward and never the one named "rainsuit"', async () => {
    const { shown, result } = await search({ query: 'rain top' }, 'I need a rain top');
    expect(shown[0]).toBe('STORM JACKET - BLACK');
    expect(shown).not.toContain('RAINSUIT JACKET - GREY');
    expect(result.facts).toContain('rain top -> rain jacket');
  });

  it('finds a garment with a needed feature even when it is not on the first page of results', async () => {
    // Thirty ordinary trousers ahead of the one that says waterproof - the live store's joggers and INFINITE RAIN TROUSERS.
    const plain = Array.from({ length: 30 }, (_, i) => garment(`TECH TROUSER ${i} - NAVY`, { productType: 'TROUSERS', sizes: ['32', '34'], description: 'Stretch trousers.' }));
    const rain = garment('INFINITE RAIN TROUSERS - BLACK', { productType: 'TROUSERS', sizes: ['32', '34'], description: 'Fully waterproof over trousers.' });
    setCatalogueForTests([...plain, rain]);
    const { shown, result } = await search({ query: 'trousers', features: ['waterproof'] }, 'I need waterproof trousers');
    expect(shown[0]).toBe('INFINITE RAIN TROUSERS - BLACK');
    expect(result.speech).not.toMatch(/could not find anything that meets/);
  });

  it('a hard per-item budget from earlier is kept on the next search', async () => {
    const session = await sessions.patch(id, { shopper: { budget: { amount: 50, kind: 'max', per: 'item' }, usualSize: 'XL' } });
    const result = await runTool('search_products', { query: 'polo' }, { session, utterance: 'show me another polo' });
    const shown = result.attachment?.kind === 'products' ? result.attachment.products : [];
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((p) => p.price.amount <= 50)).toBe(true);
    expect(result.facts).toMatch(/Lead with: .*within your £50 budget/);
  });

  it('a named product that does not exist is proven absent from the whole catalogue', async () => {
    const { result } = await search({ query: 'jacket', productName: 'Tour Championship Jacket' }, 'how much is the Tour Championship Jacket?');
    expect(result.facts).toContain('nothing in the Druids catalogue is called "Tour Championship Jacket"');
  });

  it('a search between building an outfit and swapping in it does not lose the outfit', async () => {
    let session = await sessions.getOrCreate(id);
    const built = await runTool('recommend_outfit', { seed: 'polo and trousers', pieces: ['top', 'bottom'] }, { session, utterance: 'a polo and trousers outfit' });
    const pieces = built.attachment?.kind === 'outfit' ? built.attachment.recommendation.pieces : [];
    const trousers = pieces.find((piece) => piece.slot === 'bottom')!.product.id;
    session = await sessions.getOrCreate(id);
    // The model looks the replacement up first - this used to replace the outfit on screen.
    await runTool('search_products', { query: 'navy polo' }, { session, utterance: 'swap the polo for a navy one' });
    session = await sessions.getOrCreate(id);
    const swapped = await runTool('recommend_outfit', { seed: 'navy polo', swapWith: NAVY_POLO.id }, { session, utterance: 'swap the polo for a navy one' });
    const after = swapped.attachment?.kind === 'outfit' ? swapped.attachment.recommendation.pieces : [];
    expect(after.find((piece) => piece.slot === 'top')?.product.id).toBe(NAVY_POLO.id);
    expect(after.find((piece) => piece.slot === 'bottom')?.product.id).toBe(trousers);
  });

  it('never states a feature the description does not', async () => {
    const { result } = await search({ query: 'jacket' }, 'show me jackets');
    const softshellLine = result.facts?.split('\n').find((line) => line.startsWith('- ARCHER JACKET'));
    expect(softshellLine).toBeDefined();
    expect(softshellLine).not.toMatch(/waterproof/);
  });
});
