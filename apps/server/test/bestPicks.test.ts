import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@caddie/shared';
import { setBestSellersForTests } from '../src/catalog/bestSellers.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { bestPicks, kindOf, kindsNamed } from '../src/recommend/bestPicks.js';
import { rankProducts } from '../src/recommend/rank.js';
import { sessions } from '../src/session/store.js';
import { readIntent } from '../src/shopper/profile.js';
import { rememberShopper, shopperSizes } from '../src/shopper/remember.js';
import { runTool } from '../src/tools/index.js';

/**
 * Who and what size first, then the shop's best sellers in that size - and
 * every card opening on it. Best picks are Shopify's own sales rank, never
 * something we make up.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];

function item(title: string, type: string, sizes: string[], out: string[] = []): Product {
  return {
    id: `gid://shopify/Product/${title.replace(/\W+/g, '-')}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: type,
    tags: [...BRAND],
    price: { amount: 30, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size) => ({
      id: `${title}-${size}`,
      title: size,
      available: !out.includes(size),
      price: { amount: 30, currency: 'GBP' },
      options: { Size: size },
    })),
    description: null,
  };
}

const TOPS = ['S', 'M', 'L', 'XL'];
const WAIST = ['32', '34', '36'];
const VENTO_NAVY = item('VENTO POLO - NAVY', 'POLOS', TOPS);
const VENTO_WHITE = item('VENTO POLO - WHITE', 'POLOS', TOPS);
const ORIENT = item('ORIENT POLO - BLACK', 'POLOS', TOPS, ['L']);
const TECH = item('TECH TROUSER - NAVY', 'TROUSERS', WAIST);
const TOUR_SHORT = item('TOUR SHORT - STONE', 'SHORTS', WAIST, ['34']);
const HECTAR = item('HECTAR MIDLAYER - GREY', 'MIDLAYERS', TOPS);
const DAPPER = item('DAPPER JACKET - BLACK', 'JACKETS', TOPS);
const LADIES = item('LADIES HEART POLO - NAVY', 'LADIES POLOS', ['8', '10', '12']);
const CAP = item('PLAYERS CAP - RED', 'HEADWEAR', ['ONE SIZE']);

const CATALOGUE = [VENTO_NAVY, VENTO_WHITE, ORIENT, TECH, TOUR_SHORT, HECTAR, DAPPER, LADIES, CAP];

beforeEach(() => {
  setCatalogueForTests(CATALOGUE);
  // Shopify's sales order: Orient sells best, then the white Vento, then the navy.
  setBestSellersForTests([ORIENT, VENTO_WHITE, TOUR_SHORT, VENTO_NAVY, TECH, DAPPER, HECTAR].map((p) => p.id));
});

describe('best picks', () => {
  it('are best sellers in stock in their size, one colour per garment, across kinds', () => {
    const picks = bestPicks(CATALOGUE, { range: 'men', size: 'L', waist: '34', limit: 6 }).map((p) => p.title);
    // Orient has no L and the Tour Short no 34: never offered in a size they cannot buy.
    expect(picks).not.toContain('ORIENT POLO - BLACK');
    expect(picks).not.toContain('TOUR SHORT - STONE');
    // One Vento - the colour that sells best.
    expect(picks.filter((t) => t.startsWith('VENTO'))).toEqual(['VENTO POLO - WHITE']);
    // Taking turns: a polo, then bottoms, midlayer, jacket - not a screen of polos.
    expect(picks.slice(0, 4)).toEqual(['VENTO POLO - WHITE', 'TECH TROUSER - NAVY', 'HECTAR MIDLAYER - GREY', 'DAPPER JACKET - BLACK']);
    expect(picks).not.toContain('LADIES HEART POLO - NAVY');
  });

  it('stay in the range asked for, and only the kinds named', () => {
    expect(bestPicks(CATALOGUE, { range: 'women', size: '12' }).map((p) => p.title)).toEqual(['LADIES HEART POLO - NAVY']);
    expect(bestPicks(CATALOGUE, { range: 'men', kinds: kindsNamed('just trousers') }).map((p) => kindOf(p))).toEqual(['bottoms', 'bottoms']);
  });
});

describe('sizes on two scales', () => {
  it('reads a waist size from what they say', () => {
    expect(readIntent('I have a 34 waist').waist).toBe('34');
    expect(readIntent('waist size 36').waist).toBe('36');
    expect(readIntent('my waist is 86cm').waist).toBeUndefined();
  });

  it('ranks trousers on the waist and tops on the top size', () => {
    const ranked = rankProducts([TECH, TOUR_SHORT], { size: 'L', waist: '34' });
    expect(ranked.find((r) => r.product === TOUR_SHORT)!.matchLevel).toBe('partial');
    expect(ranked.find((r) => r.product === TECH)!.reason).toContain('34 is in stock');
  });
});

describe('the quick start', () => {
  it('is remembered, sent back to the widget, and best picks use it', async () => {
    const id = `quick-${Math.random()}`;
    await sessions.getOrCreate(id);
    await rememberShopper(id, { range: 'men', usualSize: 'L', waist: '34' });
    const session = await sessions.getOrCreate(id);
    expect(shopperSizes(session)).toEqual({ range: 'men', size: 'L', waist: '34' });

    const result = await runTool('best_picks', {}, { session, utterance: 'Show me your best picks' });
    const titles = result.attachment?.kind === 'products' ? result.attachment.products.map((p) => p.title) : [];
    expect(titles[0]).toBe('VENTO POLO - WHITE');
    expect(result.speech).toContain('L and 34 waist');
  });
});
