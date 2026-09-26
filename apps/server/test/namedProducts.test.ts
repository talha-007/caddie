import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { identityOf } from '../src/catalog/identity.js';
import { lookupProductName, namingWords, unknownNameIn } from '../src/catalog/lookup.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { sessions } from '../src/session/store.js';
import { runTool } from '../src/tools/index.js';
import { lastHybridDiagnostics } from '../src/catalog/hybrid.js';

/**
 * Which product a customer named. Titles are the live Druids store's: every
 * colourway its own product, "DESIGN - COLOUR", ladies and kids versions
 * named as such. Each case is one the audit caught going wrong.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function garment(title: string, type: string, sizes = ['S', 'M', 'L', 'XL', '2XL'], extra: Partial<Product> = {}): Product {
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND],
    price: { amount: 20, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size) => ({ id: `${title}-${size}`, title: size, available: true, price: { amount: 20, currency: 'GBP' }, options: { Size: size } })),
    description: null,
    ...extra,
  };
}

const ELITE_NAVY = garment('ELITE POLO - NAVY', 'POLOS', undefined, { handle: 'elite-polo-navy' });
const ELITE_BLACK = garment('ELITE POLO - BLACK', 'POLOS');
const ELITE_WHITE = garment('ELITE POLO - WHITE', 'POLOS');
const LADIES_ELITE_NAVY = garment('LADIES ELITE POLO - NAVY', 'LADIES POLOS', ['8', '10', '12']);
const LADIES_ELITE_SLEEVELESS = garment('LADIES ELITE SLEEVELESS POLO - NAVY', 'LADIES POLOS', ['8', '10', '12']);
const KIDS_ELITE_NAVY = garment('KIDS ELITE POLO - NAVY', 'KIDS POLOS', ['7-8', '9-10']);
const GALACTIC_WHITE = garment('GALACTIC MIDLAYER - WHITE', 'MIDLAYERS');
const GALACTIC_NAVY = garment('GALACTIC MIDLAYER - NAVY', 'MIDLAYERS');
const GALACTIC_BLACK = garment('GALACTIC MIDLAYER - BLACK', 'MIDLAYERS');
const LADIES_GALACTIC_PINK = garment('LADIES GALACTIC MIDLAYER - PINK', 'LADIES MIDLAYERS', ['8', '10', '12']);
const APEX_BLUSH = garment('LADIES APEX POLO - BLUSH', 'LADIES POLOS', ['8', '10', '12']);
const VAPOR_NAVY = garment('VAPOR JACKET 2.0 - NAVY', 'JACKETS');
const AQUA_BLACK = garment('AQUA POLO - BLACK', 'POLOS');
const TOUR_NAVY = garment('TOUR POLO - NAVY', 'POLOS');
const STRIPE_PERFORMANCE = garment('STRIPE PERFORMANCE POLO - SAGE', 'POLOS');
const HEXA_SAGE = garment('HEXA PERFORMANCE POLO - SAGE', 'POLOS');
const HEXIE_BLACK = garment('HEXIE POLO - BLACK', 'POLOS');
const TEE_TIME_BLACK = garment('TEE-TIME HOODIE - BLACK', 'MIDLAYERS');
// A title with a fit word in it, as the live store has: "fit" is a title word, so "relaxed fit" once looked like a name.
const CLASSIC_FIT = garment('LADIES CLASSIC FIT POLO - PINK', 'LADIES POLOS', ['8', '10', '12']);
const CLIMA_GILET = garment('CLIMA GILET 3.0 - BLACK', 'GILETS');

const CATALOGUE = [
  ELITE_NAVY, ELITE_BLACK, ELITE_WHITE, LADIES_ELITE_NAVY, LADIES_ELITE_SLEEVELESS, KIDS_ELITE_NAVY,
  GALACTIC_WHITE, GALACTIC_NAVY, GALACTIC_BLACK, LADIES_GALACTIC_PINK, APEX_BLUSH, VAPOR_NAVY, AQUA_BLACK, TOUR_NAVY, STRIPE_PERFORMANCE, HEXA_SAGE, HEXIE_BLACK, TEE_TIME_BLACK, CLASSIC_FIT, CLIMA_GILET,
];

beforeEach(() => {
  setCatalogueForTests(CATALOGUE);
  setDealsForTests([]);
});

describe('a product identity, read from its title', () => {
  it('knows the design, colour, garment and range', () => {
    expect(identityOf(ELITE_NAVY)).toMatchObject({
      title: 'elite polo navy',
      design: 'elite polo',
      designWords: ['elite'],
      garments: ['polo'],
      colourway: 'navy',
      range: 'men',
      handle: 'elite-polo-navy',
    });
    expect(identityOf(LADIES_ELITE_NAVY)).toMatchObject({ design: 'ladies elite polo', designWords: ['elite'], range: 'women' });
    expect(identityOf(VAPOR_NAVY).designWords).toEqual(['vapor']);
  });
});

describe('what a name check can claim', () => {
  it('"Elite Polo - Navy" is that one product, not every Elite Polo', () => {
    const result = lookupProductName('Elite Polo - Navy');
    expect(result?.kind).toBe('exact-product');
    if (result?.kind === 'exact-product') expect(result.product.title).toBe('ELITE POLO - NAVY');
  });

  it('the handle is an exact identity too', () => {
    const result = lookupProductName('elite-polo-navy');
    expect(result?.kind === 'exact-product' && result.product.id).toBe(ELITE_NAVY.id);
  });

  it('"Galactic Midlayer" is the design in several colours - not one of them picked at random', () => {
    const result = lookupProductName('Galactic Midlayer');
    expect(result?.kind).toBe('exact-family');
    if (result?.kind === 'exact-family') {
      expect(result.products.map((p) => p.title).sort()).toEqual(['GALACTIC MIDLAYER - BLACK', 'GALACTIC MIDLAYER - NAVY', 'GALACTIC MIDLAYER - WHITE']);
      expect(result.familyName).toBe('GALACTIC MIDLAYER');
    }
  });

  it('"black Apex polo" is never the blush one', () => {
    const result = lookupProductName('black Apex polo');
    expect(result?.kind).toBe('possible-match');
    expect(result?.kind === 'exact-product' || result?.kind === 'exact-family').toBe(false);
  });

  it('a range they name decides which product it is', () => {
    const ladies = lookupProductName('ladies Elite Polo navy');
    expect(ladies?.kind === 'exact-product' && ladies.product.title).toBe('LADIES ELITE POLO - NAVY');
    const kids = lookupProductName('kids elite polo in navy');
    expect(kids?.kind === 'exact-product' && kids.product.title).toBe('KIDS ELITE POLO - NAVY');
    // Pink is only in the ladies range: a mens request for it is not that product.
    const mensPink = lookupProductName("men's Galactic Midlayer pink");
    expect(mensPink?.kind).toBe('possible-match');
  });

  it('a size does not change which product it is', () => {
    const result = lookupProductName('Elite Polo Navy in XL');
    expect(result?.kind === 'exact-product' && result.product.title).toBe('ELITE POLO - NAVY');
  });

  it('part of a longer name is a possible match, not the product', () => {
    expect(lookupProductName('the sleeveless polo in navy')?.kind).toBe('possible-match');
    // The whole name is the product, even though it is ladies only.
    const whole = lookupProductName('Elite Sleeveless Polo navy');
    expect(whole?.kind === 'exact-product' && whole.product.title).toBe('LADIES ELITE SLEEVELESS POLO - NAVY');
  });

  it('a name that is nowhere in the catalogue is not stocked', () => {
    expect(lookupProductName('Tour Championship Jacket')?.kind).toBe('not-found');
  });

  it('never proves absence when every word is stocked, just not together', () => {
    const result = lookupProductName('Apex Performance Polo');
    expect(result?.kind).not.toBe('not-found');
  });

  it('never proves absence over a word one letter from a real name', () => {
    // Misspelt names now resolve (see "misspelt names" below); an unknown word is never "not stocked".
    expect(lookupProductName('Vapour jacket')?.kind).not.toBe('not-found');
    expect(lookupProductName('Galatic midlayer')?.kind).not.toBe('not-found');
    expect(unknownNameIn('elite pollo')?.kind).not.toBe('not-found');
  });
});

describe('misspelt and differently spelt names', () => {
  const corrected = (result: ReturnType<typeof lookupProductName>) =>
    result && 'resolution' in result && result.resolution ? result.resolution : undefined;

  it('"Galatic Midlayer" is the Galactic Midlayer design, read as corrected', () => {
    const result = lookupProductName('Galatic Midlayer');
    expect(result?.kind).toBe('exact-family');
    if (result?.kind === 'exact-family') expect(result.familyName).toBe('GALACTIC MIDLAYER');
    expect(corrected(result)).toMatchObject({ type: 'corrected', corrections: [{ from: 'galatic', to: 'galactic' }] });
  });

  it('"Vapour jacket" is the VAPOR JACKET 2.0', () => {
    const result = lookupProductName('Vapour jacket');
    expect(result?.kind === 'exact-product' && result.product.title).toBe('VAPOR JACKET 2.0 - NAVY');
    expect(corrected(result)?.type).toBe('corrected');
  });

  it('"elite pollo" is the Elite Polo design - the typo is in the garment word', () => {
    const result = lookupProductName('elite pollo');
    expect(result?.kind).toBe('exact-family');
    if (result?.kind === 'exact-family') expect(result.products.every((p) => p.title.startsWith('ELITE POLO'))).toBe(true);
    expect(unknownNameIn('elite pollo')?.kind).toBe('exact-family');
  });

  it('"hoody" is read as hoodie', () => {
    const result = lookupProductName('Tee Time hoody in black');
    expect(result?.kind === 'exact-product' && result.product.title).toBe('TEE-TIME HOODIE - BLACK');
  });

  it('a typo and a colour: the right colourway, and a wrong colour is never exact', () => {
    const navy = lookupProductName('Galatic midlayer in navy');
    expect(navy?.kind === 'exact-product' && navy.product.title).toBe('GALACTIC MIDLAYER - NAVY');
    expect(lookupProductName('Galatic midlayer in lime')?.kind).toBe('possible-match');
    // "Apax" is Apex - and the only Apex polo is blush, so a black one is not it.
    const apax = lookupProductName('black Apax polo');
    expect(apax?.kind).toBe('possible-match');
  });

  it('a typo and a range: the range still decides', () => {
    const ladies = lookupProductName('ladies galatic midlayer');
    expect(ladies?.kind === 'exact-product' && ladies.product.title).toBe('LADIES GALACTIC MIDLAYER - PINK');
    expect(lookupProductName('kids galatic midlayer')?.kind).toBe('possible-match');
  });

  it('a size does not take part in matching a misspelt name', () => {
    const result = lookupProductName('Elite Pollo Navy in XL');
    expect(result?.kind === 'exact-product' && result.product.title).toBe('ELITE POLO - NAVY');
  });

  it('close to two names is a possible match, never a guess', () => {
    // "hexi" is one letter from HEXA and from HEXIE.
    const result = lookupProductName('hexi polo');
    expect(result?.kind).toBe('possible-match');
    if (result?.kind === 'possible-match') {
      const titles = result.products.map((p) => p.title);
      expect(titles.some((t) => t.startsWith('HEXA'))).toBe(true);
      expect(titles.some((t) => t.startsWith('HEXIE'))).toBe(true);
    }
  });

  it('an invented name stays not stocked - no product is picked for it', () => {
    expect(lookupProductName('Zorblax polo')?.kind).toBe('not-found');
    expect(lookupProductName('Tour Championship Jacket')?.kind).toBe('not-found');
  });

  it('what already worked still does', () => {
    const elite = lookupProductName('Elite Polo - Navy');
    expect(elite?.kind === 'exact-product' && elite.product.title).toBe('ELITE POLO - NAVY');
    expect(corrected(elite)?.type).toBe('exact');
    expect(lookupProductName('Galactic Midlayer')?.kind).toBe('exact-family');
    expect(lookupProductName('black Apex polo')?.kind).toBe('possible-match');
  });
});

describe('a description is never taken for a product name', () => {
  it('"sleeveless outer layer" is not a product Druids do not stock', () => {
    expect(namingWords('sleeveless outer layer')).toEqual([]);
    expect(unknownNameIn('sleeveless outer layer')?.kind).not.toBe('not-found');
  });

  it('weather and a description together are still a description', () => {
    expect(unknownNameIn('warm sleeveless outer layer for a cold morning')?.kind).not.toBe('not-found');
    expect(unknownNameIn('warm sleeveless')?.kind).not.toBe('not-found');
  });

  it('fit is a preference, not a name - even where "fit" is in a title', () => {
    expect(namingWords('relaxed fit')).toEqual([]);
    expect(unknownNameIn('relaxed fit')?.kind).not.toBe('not-found');
    expect(unknownNameIn('relaxed fit polo')?.kind).not.toBe('not-found');
    expect(unknownNameIn('polo relaxed fit')?.kind).not.toBe('not-found');
    expect(unknownNameIn('slim fit polo')?.kind).not.toBe('not-found');
  });

  it('features and a garment are a description', () => {
    expect(unknownNameIn('lightweight waterproof jacket')?.kind).not.toBe('not-found');
    expect(unknownNameIn('breathable moisture wicking polo')?.kind).not.toBe('not-found');
  });

  it('a real name is still checked: Tour Championship Jacket is not stocked', () => {
    expect(namingWords('Do you have the Tour Championship Jacket?')).toEqual(['tour', 'championship']);
    expect(unknownNameIn('Tour Championship Jacket')?.kind).toBe('not-found');
  });

  it('what named products did before still holds', () => {
    expect(unknownNameIn('Galatic Midlayer')?.kind).toBe('exact-family');
    expect(unknownNameIn('elite pollo')?.kind).toBe('exact-family');
    expect(unknownNameIn('Hexi polo')).toBeNull();
    expect(lookupProductName('Hexi polo')?.kind).toBe('possible-match');
    const elite = lookupProductName('Elite Polo Navy');
    expect(elite?.kind === 'exact-product' && elite.product.title).toBe('ELITE POLO - NAVY');
  });

  it('a name passed as productName is checked whatever words it uses', () => {
    // The model names it; the check runs, and a real product is still found.
    expect(lookupProductName('Tour Championship Jacket')?.kind).toBe('not-found');
    expect(lookupProductName('Galatic Midlayer')?.kind).toBe('exact-family');
  });
});

describe('search_products with a product name and no query', () => {
  // What the customer said: the name, and any colour or size, unless the test says otherwise (Task 22: a model's arguments alone are not rules).
  async function byName(args: Record<string, unknown>, utterance = '') {
    const session = await sessions.getOrCreate(`name-only-${Math.random()}`);
    const asked = [args.productName ?? args.query, args.colour ? `in ${args.colour}` : '', args.size ? `in ${args.size}` : ''].filter(Boolean).join(' ');
    const said = utterance || (asked ? `Do you have the ${asked}?` : '');
    const result = await runTool('search_products', args, { session, utterance: said });
    const shown = result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : [];
    return { result, shown, diagnostics: lastHybridDiagnostics() };
  }

  it('an exact product: accepted, checked, shown', async () => {
    const { result, shown } = await byName({ productName: 'Elite Polo Navy' });
    expect(result.speech).not.toMatch(/could not use/);
    expect(result.facts).toMatch(/exact product found: ELITE POLO - NAVY/);
    expect(shown[0]).toBe('ELITE POLO - NAVY');
  });

  it('a design: accepted, its colourways', async () => {
    const { result, shown } = await byName({ productName: 'Galactic Midlayer' });
    expect(result.facts).toMatch(/stocks the Galactic Midlayer design in 3 colourways/);
    expect(shown.filter((t) => t.startsWith('GALACTIC MIDLAYER')).length).toBe(3);
  });

  it('a misspelt design: accepted, corrected, and meaning search not consulted', async () => {
    const { result, diagnostics } = await byName({ productName: 'Galatic Midlayer' });
    expect(result.facts).toMatch(/"Galatic Midlayer" appears to refer to the Galactic Midlayer design/);
    expect(diagnostics?.semanticUsed).toBe(false);
  });

  it('an unknown product: accepted, and the catalogue check says it is not stocked', async () => {
    const { result } = await byName({ productName: 'Tour Championship Jacket' });
    expect(result.speech).toMatch(/We do not stock the Tour Championship Jacket/);
    expect(result.facts).toMatch(/nothing in the Druids catalogue is called "Tour Championship Jacket"/);
  });

  it('a name close to two designs: accepted, and neither is claimed', async () => {
    const { result } = await byName({ productName: 'Hexi polo' });
    expect(result.speech).not.toMatch(/could not use/);
    expect(result.facts).toMatch(/no single product could be confirmed for "Hexi polo"/);
    expect(result.facts).not.toMatch(/exact product found/);
  });

  it('a name and a colour: the navy one', async () => {
    const { result, shown } = await byName({ productName: 'Elite Polo', colour: 'navy' });
    expect(result.facts).toMatch(/exact product found: ELITE POLO - NAVY/);
    expect(shown.every((t) => /NAVY/.test(t))).toBe(true);
  });

  it('a name and a size: the size is still a rule', async () => {
    const inXL = await byName({ productName: 'Elite Polo Navy', size: 'XL' }, 'the Elite Polo in navy, in XL');
    expect(inXL.result.facts).toMatch(/ELITE POLO - NAVY .*XL in stock/);
    const notMade = await byName({ productName: 'Elite Polo Navy', size: '5XL' }, 'the Elite Polo in navy in 5XL');
    expect(notMade.shown).not.toContain('ELITE POLO - NAVY');
    expect(notMade.result.facts).toMatch(/ELITE POLO - NAVY is the product they named, but it is not made in 5XL/);
  });

  it('query and productName together work as before', async () => {
    const { result, shown } = await byName({ query: 'Elite Polo Navy', productName: 'Elite Polo - Navy' });
    expect(shown[0]).toBe('ELITE POLO - NAVY');
    expect(result.facts).toMatch(/exact product found: ELITE POLO - NAVY/);
  });

  it('neither is refused, and so are empty strings', async () => {
    for (const args of [{}, { query: '', productName: '' }, { query: '   ', productName: ' ' }]) {
      const { result } = await byName(args);
      expect(result.speech, JSON.stringify(args)).toMatch(/could not use search_products.*give query, productName, or both/);
      expect(result.attachment).toBeUndefined();
    }
  });
});

describe('search_products with a description', () => {
  it('"warm sleeveless for a cold morning" searches, with no word about not stocking it', async () => {
    const session = await sessions.getOrCreate(`describe-${Math.random()}`);
    const result = await runTool('search_products', { query: 'warm sleeveless', features: ['warm'] }, { session, utterance: 'I want something warm but sleeveless for a cold morning' });
    expect(result.facts ?? '').not.toMatch(/You may say we do not stock it/);
    expect(result.speech).not.toMatch(/do not stock/);
  });

  it('"polo relaxed fit" searches polos, with no word about not stocking a "relaxed fit"', async () => {
    const session = await sessions.getOrCreate(`describe-${Math.random()}`);
    const result = await runTool('search_products', { query: 'polo relaxed fit' }, { session, utterance: "I'm XL and prefer a relaxed fit. Show me a polo." });
    expect(result.facts ?? '').not.toMatch(/Catalogue check/);
    expect(result.speech).not.toMatch(/do not stock/);
  });
});

describe('search_products with a named product', () => {
  let id = '';
  beforeEach(async () => {
    id = `named-${Math.random()}`;
    await sessions.getOrCreate(id);
  });
  afterEach(() => setDealsForTests([]));

  async function search(args: Record<string, unknown>, utterance: string) {
    const session = await sessions.getOrCreate(id);
    const result = await runTool('search_products', args, { session, utterance });
    const shown = result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : [];
    return { result, shown };
  }

  it('the named colourway leads, and the facts say it is exact', async () => {
    const { result, shown } = await search({ query: 'Elite Polo Navy', productName: 'Elite Polo - Navy' }, 'show me the Elite Polo in navy');
    expect(shown[0]).toBe('ELITE POLO - NAVY');
    expect(result.facts).toMatch(/exact product found: ELITE POLO - NAVY/);
  });

  it('a black Apex polo search never shows the blush one first, or says we sell it', async () => {
    const { result, shown } = await search({ query: 'black Apex polo', productName: 'Apex polo', colour: 'black' }, 'Show me the black Apex polo in XL.');
    expect(shown).not.toContain('LADIES APEX POLO - BLUSH');
    expect(result.facts).not.toMatch(/exact product found/);
    expect(result.facts).toMatch(/no single product could be confirmed/);
    expect(result.speech).not.toMatch(/do not stock/);
  });

  it('a family names the design and asks nothing false', async () => {
    const { result, shown } = await search({ query: 'Galactic Midlayer', productName: 'Galactic Midlayer' }, 'do you have the galactic midlayer?');
    expect(shown.filter((t) => t.startsWith('GALACTIC MIDLAYER')).length).toBe(3);
    expect(result.facts).toMatch(/stocks the Galactic Midlayer design in 3 colourways/);
  });

  it('a misspelt name is never "we do not stock"', async () => {
    const { result } = await search({ query: 'Vapour jacket', productName: 'Vapour jacket' }, 'show me the vapour jacket');
    expect(result.speech).not.toMatch(/do not stock/);
    expect(result.facts).not.toMatch(/You may say we do not stock it/);
  });

  it('a product we really do not sell is still said plainly', async () => {
    const { result } = await search({ query: 'Tour Championship Jacket', productName: 'Tour Championship Jacket' }, 'how much is the Tour Championship Jacket?');
    expect(result.speech).toMatch(/We do not stock the Tour Championship Jacket/);
  });
});

describe('get_product_details by name', () => {
  it('opens the one product a name and colour pin down', async () => {
    const session = await sessions.getOrCreate(`details-${Math.random()}`);
    const result = await runTool('get_product_details', { productId: 'Elite Polo - Navy' }, { session, utterance: 'tell me about the navy elite polo' });
    expect(`${result.speech} ${result.facts ?? ''} ${JSON.stringify(result.attachment ?? {})}`).toMatch(/ELITE POLO - NAVY/);
    expect(result.speech).not.toMatch(/which one/);
  });

  it('asks which colour for a design, and never says it is not stocked', async () => {
    const session = await sessions.getOrCreate(`details-${Math.random()}`);
    const result = await runTool('get_product_details', { productId: 'Galactic Midlayer' }, { session, utterance: 'tell me about the galactic midlayer' });
    expect(result.speech).toMatch(/which one/);
    expect(result.speech).not.toMatch(/do not stock/);
  });
});

/*
 * "Show me the Hexi polo": the check said Hexie or Hexa, and the cards were
 * the best-selling Elite, Honeycomb and Prime polos, because the candidates
 * lived only in the facts. The cards are the candidates now, under every rule.
 */
describe('a name that could be several products: the candidates are the cards', () => {
  const soldOutIn = (product: Product, size: string): Product => ({
    ...product,
    variants: product.variants.map((variant) => (variant.options.Size === size ? { ...variant, available: false } : variant)),
  });
  const HEXIE = ['BLACK', 'NAVY'].map((colour) => garment(`HEXIE POLO - ${colour}`, 'POLOS'));
  const HEXIE_WHITE_NO_XL = soldOutIn(garment('HEXIE POLO - WHITE', 'POLOS'), 'XL');
  const HEXA = ['SAGE', 'BLACK'].map((colour) => garment(`HEXA PERFORMANCE POLO - ${colour}`, 'POLOS'));
  const HEXA_GILET = garment('HEXA GILET - BLACK', 'GILETS');
  const LADIES_HEXIE = garment('LADIES HEXIE POLO - PINK', 'LADIES POLOS', ['8', '10', '12']);
  // The best sellers that used to fill the screen.
  const BEST_SELLERS = ['ELITE POLO - NAVY', 'HONEYCOMB POLO - NAVY', 'PRIME POLO - BLACK', 'BLOCK PIQUE POLO - WHITE'].map((title) =>
    garment(title, 'POLOS', undefined, { tags: [...BRAND, 'best-seller'] }),
  );

  beforeEach(() => setCatalogueForTests([...HEXIE, HEXIE_WHITE_NO_XL, ...HEXA, HEXA_GILET, LADIES_HEXIE, ...BEST_SELLERS]));

  async function search(args: Record<string, unknown>, utterance = '') {
    const session = await sessions.getOrCreate(`possible-${Math.random()}`);
    const result = await runTool('search_products', args, { session, utterance });
    const shown = result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : [];
    return { result, shown };
  }
  const unrelated = /ELITE|HONEYCOMB|PRIME|BLOCK PIQUE/;

  it('Hexi polo: Hexie and Hexa polos, nothing unrelated, no gilet, neither claimed', async () => {
    const { result, shown } = await search({ query: 'Hexi polo', productName: 'Hexi polo' }, 'Show me the Hexi polo');
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.some((t) => t.startsWith('HEXIE POLO'))).toBe(true);
    expect(shown.some((t) => t.startsWith('HEXA PERFORMANCE POLO'))).toBe(true);
    // Both names within the first two cards, rather than one name six times.
    expect(shown.slice(0, 2).map((t) => t.split(' ')[0]).sort()).toEqual(['HEXA', 'HEXIE']);
    expect(shown.filter((t) => unrelated.test(t))).toEqual([]);
    expect(shown).not.toContain('HEXA GILET - BLACK');
    expect(result.facts).toMatch(/no single product could be confirmed/);
    expect(result.facts).not.toMatch(/exact product found|Lead with/);
    expect(result.speech).toMatch(/couldn't confirm a single product/);
  });

  it('the facts name exactly the cards on screen', async () => {
    const { result, shown } = await search({ productName: 'Hexi polo' }, 'Show me the Hexi polo');
    const check = result.facts!.split('\n').find((line) => line.startsWith('Catalogue check'))!;
    for (const title of shown) expect(check).toContain(title);
    expect(check).not.toMatch(unrelated);
  });

  it('black Hexi polo: only the black candidates', async () => {
    const { shown } = await search({ query: 'black Hexi polo', productName: 'Hexi polo', colour: 'black' }, 'Show me the black Hexi polo');
    expect(shown.sort()).toEqual(['HEXA PERFORMANCE POLO - BLACK', 'HEXIE POLO - BLACK']);
  });

  it('ladies Hexi polo: only the ladies candidate', async () => {
    const { shown } = await search({ query: 'ladies Hexi polo', productName: 'Hexi polo' }, 'Show me the ladies Hexi polo');
    expect(shown).toEqual(['LADIES HEXIE POLO - PINK']);
  });

  it('Hexi polo in XL: a candidate sold out in XL is left off', async () => {
    const { result, shown } = await search({ productName: 'Hexi polo', size: 'XL' }, 'Show me the Hexi polo in XL');
    expect(shown).not.toContain('HEXIE POLO - WHITE');
    expect(shown).toContain('HEXIE POLO - BLACK');
    expect(shown.filter((t) => unrelated.test(t))).toEqual([]);
    expect(result.facts).toMatch(/XL in stock/);
  });

  it('when no candidate meets the rules, the search answers as before', async () => {
    const { result, shown } = await search({ query: 'Hexi polo in orange', productName: 'Hexi polo', colour: 'orange' }, 'the Hexi polo in orange');
    expect(shown.filter((t) => /HEX/.test(t))).toEqual([]);
    expect(result.facts ?? '').toMatch(/no single product could be confirmed|orange/i);
  });
});
