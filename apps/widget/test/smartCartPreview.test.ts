import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BasketSyncResponse, Cart, SmartCartOfferView, SmartCartView } from '@caddie/shared';
import { SmartCartProgress } from '../src/components/SmartCartProgress.js';
import { BasketPanel } from '../src/components/panels/BasketPanel.js';
import { ShopProvider, type Shop } from '../src/components/ShopContext.js';
import { syncBasket } from '../src/lib/api.js';
import { readPageContext } from '../src/lib/context.js';
import { QUALIFIED_NOTE, newerSmartCart, smartCartLines } from '../src/lib/smartCart.js';

/**
 * The Smart Cart preview: a deal card per offer the basket is part-way to,
 * from the progress the server evaluated, shown in the basket screen only
 * where the copied theme turns it on. Written for a customer - a deal, dots,
 * one sentence - with the tester's status line only on request. The widget
 * never counts triggers itself and never claims a discount.
 */

const DEALS = {
  'any-3-polos': { name: 'Any 3 Polos', required: 3, display: { deal: '3 for £59.99', units: 'polos', one: 'polo', many: 'polos', title: 'Any 3 Polos' } },
  'any-2-mens-trousers': { name: "Any 2 Men's Trousers", required: 2, display: { deal: '2 for £49', units: 'trousers', one: 'pair of trousers', many: 'pairs of trousers', title: 'Any 2 Trousers' } },
  'any-2-shorts': { name: 'Any 2 Shorts', required: 2, display: { deal: '2 for £45', units: 'shorts', one: 'pair of shorts', many: 'pairs of shorts', title: 'Any 2 Shorts' } },
} as const;
type Id = keyof typeof DEALS;

function status(units: number, required: number): SmartCartOfferView['status'] {
  if (units <= 0) return 'INACTIVE';
  if (units >= required) return 'QUALIFIED';
  return units === required - 1 ? 'ONE_AWAY' : 'IN_PROGRESS';
}
type Value = { worthwhile?: boolean | null; canSuggest?: boolean };
function offer(id: Id, units: number, value: Value = {}): SmartCartOfferView {
  const deal = DEALS[id];
  return {
    offerId: id,
    name: deal.name,
    status: status(units, deal.required),
    qualifyingUnits: units,
    requiredUnits: deal.required,
    remainingUnits: Math.max(deal.required - units, 0),
    worthwhile: value.worthwhile === undefined ? (units > 0 ? true : null) : value.worthwhile,
    canSuggest: value.canSuggest ?? false,
    display: { ...deal.display },
  };
}
function view(units: Partial<Record<Id, number>>, values: Partial<Record<Id, Value>> = {}, evaluatedAt = Date.UTC(2026, 8, 30, 13, 32, 10)): SmartCartView {
  return { evaluatedAt, offers: (Object.keys(DEALS) as Id[]).map((id) => offer(id, units[id] ?? 0, values[id])) };
}
const render = (state: SmartCartView | null, options: { enabled?: boolean; debug?: boolean; onSuggest?: (id: string) => void } = {}) =>
  renderToStaticMarkup(createElement(SmartCartProgress, { view: state, enabled: options.enabled ?? true, debug: options.debug ?? false, ...(options.onSuggest ? { onSuggest: options.onSuggest } : {}) }));
/** What a customer would read - the markup without its tags. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const cards = (html: string) => html.match(/class="caddie-deal caddie-deal--/g)?.length ?? 0;

/** Words the preview must never use: nothing about a discount has been verified. */
const FORBIDDEN = [/discount applied/i, /unlock/i, /saving/i, /\bsave\b/i, /you (have )?(earned|saved)/i, /your price/i, /£\d+(\.\d+)? (off|saved)\b/i];
/** Nor a status code a customer would not understand. */
const CODES = [/IN_PROGRESS/, /ONE_AWAY/, /QUALIFIED/, /Triggered/, /Preview status/];
function forCustomers(html: string) {
  const words = text(html);
  for (const claim of [...FORBIDDEN, ...CODES]) expect(words).not.toMatch(claim);
}

describe('nothing to show', () => {
  it('no Smart Cart state: nothing', () => {
    expect(render(null)).toBe('');
  });
  it('every deal inactive: nothing', () => {
    expect(render(view({}))).toBe('');
  });
  it('preview off: nothing, even with progress', () => {
    expect(render(view({ 'any-3-polos': 2 }), { enabled: false })).toBe('');
  });
  it('preview on with progress: a deal card', () => {
    expect(cards(render(view({ 'any-3-polos': 2 })))).toBe(1);
  });
});

describe('what the customer reads', () => {
  it('1 of 3 polos: the deal, one dot of three, and what is left', () => {
    const html = render(view({ 'any-3-polos': 1 }));
    expect(text(html)).toContain('Any 3 Polos · 3 for £59.99');
    expect(text(html)).toContain('Choose any 2 more polos to complete the deal');
    expect(html.match(/caddie-deal__dot--on/g)).toHaveLength(1);
    expect(html.match(/class="caddie-deal__dot[ "]/g)).toHaveLength(3);
    expect(html).toContain('caddie-deal--open');
    forCustomers(html);
  });
  it('2 of 3 polos: one away, the stronger look', () => {
    const html = render(view({ 'any-3-polos': 2 }));
    expect(text(html)).toContain('Choose any 1 more polo to complete the deal');
    expect(html).toContain('caddie-deal--close');
    expect(html.match(/caddie-deal__dot--on/g)).toHaveLength(2);
    forCustomers(html);
  });
  it('3 of 3 polos: they qualify, and the price is left to checkout - never "unlocked" or "saving"', () => {
    const html = render(view({ 'any-3-polos': 3 }));
    expect(text(html)).toContain('Your polos qualify for 3 for £59.99');
    expect(text(html)).toContain(QUALIFIED_NOTE);
    expect(QUALIFIED_NOTE).toBe('The deal price is worked out at checkout.');
    expect(html).toContain('caddie-deal--done');
    forCustomers(html);
  });
  it('4 polos: all three dots, never more', () => {
    const html = render(view({ 'any-3-polos': 4 }));
    expect(html.match(/caddie-deal__dot--on/g)).toHaveLength(3);
    expect(html.match(/class="caddie-deal__dot[ "]/g)).toHaveLength(3);
  });
  it('trousers, one away: "pair of trousers", singular', () => {
    const html = render(view({ 'any-2-mens-trousers': 1 }));
    expect(text(html)).toContain('Any 2 Trousers · 2 for £49');
    expect(text(html)).toContain('Choose any 1 more pair of trousers to complete the deal');
    forCustomers(html);
  });
  it('trousers, qualified: "pairs of trousers", plural', () => {
    expect(text(render(view({ 'any-2-mens-trousers': 2 })))).toContain('Your pairs of trousers qualify for 2 for £49');
  });
  it('shorts, one away', () => {
    const html = render(view({ 'any-2-shorts': 1 }));
    expect(text(html)).toContain('Any 2 Shorts · 2 for £45');
    expect(text(html)).toContain('Choose any 1 more pair of shorts to complete the deal');
    forCustomers(html);
  });
  it('several deals: a card each, in the server\'s order, none made the main one', () => {
    const lines = smartCartLines(view({ 'any-3-polos': 2, 'any-2-shorts': 1 }));
    expect(lines.map((line) => line.title)).toEqual(['Any 3 Polos', 'Any 2 Shorts']);
    const html = render(view({ 'any-3-polos': 2, 'any-2-shorts': 1 }));
    expect(cards(html)).toBe(2);
    expect(text(html)).not.toContain('Trouser');
  });
});

describe('the tester\'s line', () => {
  it('is not shown to customers: off unless asked for', () => {
    const html = render(view({ 'any-3-polos': 2 }));
    expect(html).not.toContain('smartcart-debug');
    forCustomers(html);
  });
  it('with debug on: status, triggered units, the price check and the evaluation time - no keys, ids or tokens', () => {
    const html = render(view({ 'any-3-polos': 2 }), { debug: true });
    expect(text(html)).toContain('Preview status: Any 3 Polos: ONE_AWAY · Triggered 2 / 3 · Lowers price: yes');
    expect(text(html)).toMatch(/Evaluated: \d{2}:\d{2}:\d{2}/);
    for (const secret of ['__3_Polo_Bundle', 'lineKey', 'variant', 'token', 'gid://']) expect(html).not.toContain(secret);
  });
  it('with debug on, a hidden deal is still listed, with why', () => {
    const html = render(view({ 'any-2-mens-trousers': 1 }, { 'any-2-mens-trousers': { worthwhile: false } }), { debug: true });
    expect(cards(html)).toBe(0);
    expect(text(html)).toContain("Preview status: Any 2 Men's Trousers: ONE_AWAY · Triggered 1 / 2 · Lowers price: no - hidden");
  });
});

describe('where the preview is turned on', () => {
  const host = (attrs: Record<string, string>) => {
    const el = document.createElement('div');
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  };
  it('off by default - the live theme sets nothing', () => {
    expect(readPageContext(host({}))).toMatchObject({ smartCartPreview: false, smartCartDebug: false });
  });
  it('on only for data-smart-cart-preview="true"', () => {
    expect(readPageContext(host({ 'data-smart-cart-preview': 'true' })).smartCartPreview).toBe(true);
    expect(readPageContext(host({ 'data-smart-cart-preview': 'false' })).smartCartPreview).toBe(false);
    expect(readPageContext(host({ 'data-smart-cart-preview': '' })).smartCartPreview).toBe(false);
  });
  it('the tester\'s line needs both attributes', () => {
    expect(readPageContext(host({ 'data-smart-cart-preview': 'true', 'data-smart-cart-debug': 'true' })).smartCartDebug).toBe(true);
    expect(readPageContext(host({ 'data-smart-cart-preview': 'true' })).smartCartDebug).toBe(false);
    expect(readPageContext(host({ 'data-smart-cart-debug': 'true' })).smartCartDebug).toBe(false);
  });
});

describe('the state kept from basket syncs', () => {
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
  let reply: () => Response;
  beforeEach(() => {
    sessionStorage.clear();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/claim')) return json(200, { sessionId: 's1', sessionToken: 'tok', contract: 'cart-ops/1' });
      if (url.endsWith('/basket')) return reply();
      return json(404, {});
    }) as typeof fetch;
  });
  afterEach(() => sessionStorage.clear());

  it('a basket sync answers with the Smart Cart state the server evaluated, and it is kept', async () => {
    const fresh = view({ 'any-3-polos': 2 });
    reply = () => json(200, { ok: true, lines: 2, smartCart: fresh } satisfies BasketSyncResponse);
    const answered = await syncBasket('s1', { lines: [] });
    expect(answered.smartCart).toEqual(fresh);
    expect(newerSmartCart(null, answered.smartCart)).toEqual(fresh);
  });

  it('a failed sync keeps the previous state', async () => {
    const previous = view({ 'any-3-polos': 1 });
    reply = () => json(500, { detail: 'down' });
    let kept = previous;
    await syncBasket('s1', { lines: [] }).then((answered) => (kept = newerSmartCart(kept, answered.smartCart)!)).catch(() => undefined);
    expect(kept).toBe(previous);
  });

  it('an older server (no smartCart in the reply) keeps the previous state', () => {
    const previous = view({ 'any-3-polos': 1 });
    expect(newerSmartCart(previous, undefined)).toBe(previous);
    expect(newerSmartCart(previous, null)).toBe(previous);
  });

  it('an evaluation that arrives late never replaces a newer one', () => {
    const newer = view({ 'any-3-polos': 3 }, {}, 2000);
    const older = view({ 'any-3-polos': 1 }, {}, 1000);
    expect(newerSmartCart(newer, older)).toBe(newer);
    expect(newerSmartCart(older, newer)).toBe(newer);
  });

  it('a real empty basket (all inactive) replaces progress, and the card goes', () => {
    const next = newerSmartCart(view({ 'any-3-polos': 2 }, {}, 1000), view({}, {}, 2000));
    expect(render(next)).toBe('');
  });
});

describe('the basket screen still works', () => {
  const cart: Cart = {
    id: 'c',
    checkoutUrl: null,
    subtotal: { amount: 48, currency: 'GBP' },
    totalQuantity: 2,
    lines: [{ lineId: 'l1', productId: 'p', variantId: 'v', title: 'ELITE POLO - NAVY', variantTitle: 'M', imageUrl: null, quantity: 2, unitPrice: { amount: 24, currency: 'GBP' }, lineTotal: { amount: 48, currency: 'GBP' } }],
  };
  const shop = { changeQuantity: async () => undefined } as unknown as Shop;
  const screen = (enabled: boolean, state: SmartCartView | null) =>
    renderToStaticMarkup(createElement(ShopProvider, { value: shop }, createElement(Fragment, null, createElement(SmartCartProgress, { view: state, enabled }), createElement(BasketPanel, { cart }))));

  it('with the preview on, the deal card sits above the unchanged basket lines', () => {
    const html = screen(true, view({ 'any-3-polos': 2 }));
    expect(html.indexOf('caddie-deal')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('caddie-deal')).toBeLessThan(html.indexOf('caddie-basket__lines'));
    expect(text(html)).toContain('ELITE POLO - NAVY');
  });

  it('with the preview off, the basket screen is exactly what it was', () => {
    const plain = renderToStaticMarkup(createElement(ShopProvider, { value: shop }, createElement(BasketPanel, { cart })));
    expect(screen(false, view({ 'any-3-polos': 2 }))).toBe(plain);
  });
});

describe('only nudges that the checkout will honour', () => {
  it('a deal that would not lower the price (items already under it) shows no card', () => {
    expect(smartCartLines(view({ 'any-2-mens-trousers': 1 }, { 'any-2-mens-trousers': { worthwhile: false } }))).toEqual([]);
    expect(render(view({ 'any-2-mens-trousers': 1 }, { 'any-2-mens-trousers': { worthwhile: false } }))).toBe('');
  });
  it('a qualified basket that would save nothing does not say it qualifies', () => {
    expect(text(render(view({ 'any-3-polos': 3 }, { 'any-3-polos': { worthwhile: false } })))).not.toContain('qualify');
  });
  it('could not tell (another currency): the neutral wording stands', () => {
    expect(smartCartLines(view({ 'any-3-polos': 2 }, { 'any-3-polos': { worthwhile: null } })).map((line) => line.message)).toEqual(['Choose any 1 more polo to complete the deal']);
  });
  it('something worth suggesting: a "Show me polos" button', () => {
    const lines = smartCartLines(view({ 'any-3-polos': 2 }, { 'any-3-polos': { canSuggest: true } }));
    expect(lines[0]?.suggestLabel).toBe('Show me polos');
    const html = render(view({ 'any-3-polos': 2 }, { 'any-3-polos': { canSuggest: true } }), { onSuggest: () => undefined });
    expect(html).toContain('caddie-deal__action');
    expect(text(html)).toContain('Show me polos');
  });
  it('no button when nothing can be suggested, when qualified, or with no handler', () => {
    expect(smartCartLines(view({ 'any-3-polos': 2 }))[0]?.suggestLabel).toBeUndefined();
    expect(smartCartLines(view({ 'any-3-polos': 3 }, { 'any-3-polos': { canSuggest: true } }))[0]?.suggestLabel).toBeUndefined();
    expect(render(view({ 'any-3-polos': 2 }, { 'any-3-polos': { canSuggest: true } }))).not.toContain('caddie-deal__action');
  });
});
