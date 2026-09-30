import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest } from '@caddie/shared';
import { sendMessage } from '../src/lib/api.js';
import { OWN_DRAWER_QUIET_MS, THEME_CART_DEBOUNCE_MS, TURN_BASKET_MS, announceToTheme, basketForTurn, runOperation, watchThemeCart } from '../src/lib/themeCart.js';
import { FakeShopifyCart, installStorefront } from './support/fakeShopifyCart.js';

/**
 * Smart Cart phase 1 - basket freshness. Every chat turn carries the cart as
 * it really is, read from /cart.js just before sending; a read that fails
 * never stops the message and never stands in an empty basket; and cart
 * changes the rest of the theme makes (its RE_RENDER_DRAWER calls) are read
 * back once, while Caddie's own re-render is not.
 */

const POLO = { variantId: 611, productId: 61, title: 'ELITE POLO - NAVY', variantTitle: 'M', price: 2000 };
const JACKET = { variantId: 701, productId: 70, title: 'CLIMA JACKET 3.0 - NAVY', variantTitle: 'L', price: 3400 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let cart: FakeShopifyCart;
/** The Caddie server's side of the wire: the claim, and every chat body it receives. */
let chats: ChatRequest[];

beforeEach(() => {
  sessionStorage.clear();
  cart = new FakeShopifyCart([POLO, JACKET]);
  installStorefront(cart);
  chats = [];
  const shopify = cart.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/claim')) return json(200, { sessionId: 's1', sessionToken: 'tok', contract: 'cart-ops/1' });
    if (url.endsWith('/api/chat')) {
      chats.push(JSON.parse(String(init?.body)) as ChatRequest);
      return json(200, { sessionId: 's1', message: { id: 'm', role: 'assistant', text: 'ok', createdAt: '' } });
    }
    return shopify(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { RE_RENDER_DRAWER?: unknown }).RE_RENDER_DRAWER;
  document.getElementById('cart-drawer')?.remove();
});

describe('a chat turn carries the cart as it is now', () => {
  it('1. the message includes the latest /cart.js snapshot, in the basket route\'s own shape', async () => {
    cart.seed([{ variantId: 611, quantity: 1 }]);
    // The theme changed the cart after the widget last looked: the turn must see it.
    cart.seed([{ variantId: 701, quantity: 2 }]);
    const basket = await basketForTurn();
    await sendMessage('s1', 'what is in my basket?', undefined, undefined, basket);
    expect(chats).toHaveLength(1);
    const sent = chats[0]!.basket!;
    expect(sent.lines.map((line) => [line.variantId, line.quantity])).toEqual([
      ['gid://shopify/ProductVariant/611', 1],
      ['gid://shopify/ProductVariant/701', 2],
    ]);
    expect(sent.lines.every((line) => typeof line.key === 'string' && line.key.length > 0)).toBe(true);
  });

  it('3. a /cart.js read that fails: the message is still sent, with no basket rather than an empty one', async () => {
    cart.failNext('read', 500, 'Internal error');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const basket = await basketForTurn();
    expect(basket).toBeNull();
    await sendMessage('s1', 'hello', undefined, undefined, basket);
    expect(chats).toHaveLength(1);
    expect(chats[0]).not.toHaveProperty('basket');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not read the cart/));
    warn.mockRestore();
  });

  it('3b. a /cart.js read that hangs: the turn waits no longer than its deadline, then goes without a basket', async () => {
    vi.useFakeTimers();
    cart.hang('read');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = basketForTurn();
    await vi.advanceTimersByTimeAsync(TURN_BASKET_MS + 10);
    expect(await pending).toBeNull();
    cart.unhang('read');
    warn.mockRestore();
  });
});

describe('cart changes made by the rest of the theme', () => {
  it('4. the theme\'s RE_RENDER_DRAWER after its own cart change triggers one resync, and the theme still re-renders', async () => {
    vi.useFakeTimers();
    const themeRender = vi.fn();
    (window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER = themeRender;
    const resync = vi.fn();
    const stop = watchThemeCart(resync);
    // What QUICK_CART / UPDATE_QTY do on success: call the global by name.
    (window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER();
    expect(themeRender).toHaveBeenCalledTimes(1);
    expect(resync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(THEME_CART_DEBOUNCE_MS + 10);
    expect(resync).toHaveBeenCalledTimes(1);
    stop();
    expect((window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER).toBe(themeRender);
  });

  it('rapid theme re-renders (drawer +, +, +) are coalesced into one resync', async () => {
    vi.useFakeTimers();
    (window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER = vi.fn();
    const resync = vi.fn();
    const stop = watchThemeCart(resync);
    for (let i = 0; i < 5; i += 1) {
      (window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER();
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(THEME_CART_DEBOUNCE_MS + 10);
    expect(resync).toHaveBeenCalledTimes(1);
    stop();
  });

  it('5. Caddie\'s own announcement (RE_RENDER_DRAWER, cart:update, cart:refresh) causes no resync at all', async () => {
    vi.useFakeTimers();
    const themeRender = vi.fn();
    (window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER = themeRender;
    const resync = vi.fn();
    const stop = watchThemeCart(resync);
    for (let i = 0; i < 3; i += 1) announceToTheme(null);
    await vi.advanceTimersByTimeAsync(THEME_CART_DEBOUNCE_MS * 5);
    // The theme was still told three times; nothing was read back.
    expect(themeRender).toHaveBeenCalledTimes(3);
    expect(resync).not.toHaveBeenCalled();
    stop();
  });

  it('a theme with no RE_RENDER_DRAWER: nothing is wrapped, nothing polls', async () => {
    vi.useFakeTimers();
    const resync = vi.fn();
    const stop = watchThemeCart(resync);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resync).not.toHaveBeenCalled();
    expect((window as unknown as { RE_RENDER_DRAWER?: unknown }).RE_RENDER_DRAWER).toBeUndefined();
    stop();
  });

  it('a theme that defines RE_RENDER_DRAWER after the widget mounts is wrapped on window load', async () => {
    vi.useFakeTimers();
    const resync = vi.fn();
    const stop = watchThemeCart(resync);
    (window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER = vi.fn();
    window.dispatchEvent(new Event('load'));
    (window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER();
    await vi.advanceTimersByTimeAsync(THEME_CART_DEBOUNCE_MS + 10);
    expect(resync).toHaveBeenCalledTimes(1);
    stop();
  });

  it('wrapping twice (a remount) never double-wraps', () => {
    const themeRender = vi.fn();
    (window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER = themeRender;
    const first = watchThemeCart(vi.fn());
    const wrapped = (window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER;
    const second = watchThemeCart(vi.fn());
    expect((window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER).toBe(wrapped);
    second();
    first();
    expect((window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER).toBe(themeRender);
  });
});

describe('6. Caddie\'s own cart operations are unchanged', () => {
  it('a stamped add through runOperation still lands, reports applied, and triggers no theme-change resync', async () => {
    vi.useFakeTimers();
    const themeRender = vi.fn();
    (window as unknown as { RE_RENDER_DRAWER: () => void }).RE_RENDER_DRAWER = themeRender;
    const resync = vi.fn();
    const stop = watchThemeCart(resync);
    const report = await runOperation({ type: 'add', operationId: 'op-1', lines: [{ variantId: '611', quantity: 1 }], expect: { add: [{ variantId: '611', quantity: 1 }] } });
    expect(report).toMatchObject({ status: 'applied' });
    expect(cart.quantities()).toEqual({ 611: 1 });
    expect(themeRender).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(THEME_CART_DEBOUNCE_MS * 5);
    expect(resync).not.toHaveBeenCalled();
    stop();
  });
});

describe('the sport theme: no RE_RENDER_DRAWER, no cart events - its drawer is redrawn', () => {
  /** What sport-quick-cart.js does after an add or a drawer change: swap the drawer's inner HTML. */
  function drawer(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'cart-drawer';
    el.innerHTML = '<div data-hydration-key="cart-drawer-inner"><p>empty</p></div>';
    document.body.appendChild(el);
    return el;
  }
  /** Past any quiet window an earlier test's own change left open (module state; the fake clock restarts at real time). */
  let hours = 0;
  const clear = () => {
    vi.useFakeTimers();
    hours += 1;
    vi.setSystemTime(Date.now() + hours * 3_600_000);
  };
  const redraw = (el: HTMLElement) => {
    el.querySelector('[data-hydration-key="cart-drawer-inner"]')!.innerHTML = '<ul><li>line</li></ul>';
  };

  it('a redraw of #cart-drawer by the theme triggers one resync', async () => {
    clear();
    const el = drawer();
    const resync = vi.fn();
    const stop = watchThemeCart(resync);
    redraw(el);
    redraw(el);
    await vi.advanceTimersByTimeAsync(THEME_CART_DEBOUNCE_MS + 10);
    expect(resync).toHaveBeenCalledTimes(1);
    stop();
  });

  it("the redraw that follows Caddie's own change is not read back; a later one by the theme is", async () => {
    clear();
    const el = drawer();
    const resync = vi.fn();
    const stop = watchThemeCart(resync);
    announceToTheme(null);
    redraw(el);
    await vi.advanceTimersByTimeAsync(THEME_CART_DEBOUNCE_MS + 10);
    expect(resync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(OWN_DRAWER_QUIET_MS);
    redraw(el);
    await vi.advanceTimersByTimeAsync(THEME_CART_DEBOUNCE_MS + 10);
    expect(resync).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stopping disconnects: no resync after unmount', async () => {
    clear();
    const el = drawer();
    const resync = vi.fn();
    watchThemeCart(resync)();
    redraw(el);
    await vi.advanceTimersByTimeAsync(THEME_CART_DEBOUNCE_MS * 3);
    expect(resync).not.toHaveBeenCalled();
  });

  it('a drawer rendered after mount is observed from window load', async () => {
    clear();
    const resync = vi.fn();
    const stop = watchThemeCart(resync);
    const el = drawer();
    window.dispatchEvent(new Event('load'));
    redraw(el);
    await vi.advanceTimersByTimeAsync(THEME_CART_DEBOUNCE_MS + 10);
    expect(resync).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('a theme that announces its cart changes', () => {
  it("cart:refresh or cart:update from the theme triggers one resync; Caddie's own do not", async () => {
    vi.useFakeTimers();
    const resync = vi.fn();
    const stop = watchThemeCart(resync);
    document.dispatchEvent(new CustomEvent('cart:refresh', { detail: { sourceId: 'druids-caddie' } }));
    document.dispatchEvent(new CustomEvent('cart:update', { detail: { sourceId: 'druids-caddie' } }));
    await vi.advanceTimersByTimeAsync(THEME_CART_DEBOUNCE_MS + 10);
    expect(resync).not.toHaveBeenCalled();
    document.dispatchEvent(new CustomEvent('cart:refresh'));
    document.dispatchEvent(new CustomEvent('cart:update', { detail: { sourceId: 'product-form' } }));
    await vi.advanceTimersByTimeAsync(THEME_CART_DEBOUNCE_MS + 10);
    expect(resync).toHaveBeenCalledTimes(1);
    stop();
  });
});
