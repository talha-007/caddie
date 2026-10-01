import {
  buildBundleCartItems,
  formEncodeCartItems,
  newBundleId,
  type BasketSync,
  type BundleDeal,
  type Cart,
  type CartAction,
  type CartOutcomeReport,
  type SmartCartRepair,
} from '@caddie/shared';

/**
 * The store's own cart, used when the Caddie runs on the Druids storefront.
 *
 * Until now the Caddie kept a basket of its own through the Storefront API.
 * On the live store that was two baskets: what the Caddie added never showed
 * in the theme's cart icon, and the bundle deals - whose price is applied by
 * a discount matching lines in the theme's cart - could not be bought at their
 * price at all. So on the storefront the Caddie uses the cart the theme uses,
 * through the same endpoints the theme's own buttons call.
 */

interface ShopifyGlobal {
  shop?: string;
  country?: string;
  currency?: { active?: string };
  /** The store's locale-aware root ("/", "/en-gb/"), as the theme's own cart calls use it. */
  routes?: { root?: string };
}

/** Cart endpoints under the store's root, so a localised storefront ("/fr/") is not sent to the wrong cart. */
export function cartPath(path: string): string {
  const root = shopify()?.routes?.root ?? '/';
  return `${root.endsWith('/') ? root.slice(0, -1) : root}${path}`;
}

/** How long one cart request may take before the widget stops waiting for it (a timeout is not a cancellation). */
export const CART_REQUEST_MS = 15_000;

function shopify(): ShopifyGlobal | undefined {
  return (window as unknown as { Shopify?: ShopifyGlobal }).Shopify;
}

/** On a Shopify storefront, with its cart endpoints on this origin. Not the dev harness. */
export function onStorefront(): boolean {
  if (typeof window === 'undefined') return false;
  if (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) return false;
  return Boolean(shopify()?.shop);
}

interface AjaxCart {
  token: string;
  item_count: number;
  total_price: number;
  currency: string;
  items: Array<{
    key: string;
    product_id: number;
    variant_id: number;
    product_title: string;
    variant_title: string | null;
    image: string | null;
    quantity: number;
    final_price: number;
    final_line_price: number;
    /** Before any discount - what a deal's saving is a percentage of. */
    original_line_price?: number;
    properties: Record<string, unknown> | null;
    /** The discounts applied to the line - SupaEasy's deals among them - in minor units. */
    line_level_discount_allocations?: Array<{ amount?: number; discount_application?: { title?: string } }>;
    selling_plan_allocation?: { selling_plan?: { id?: number | string } } | null;
  }>;
}

/** A cart request that ran past its deadline: the store may still have done the work. */
export class CartTimeout extends Error {
  constructor(readonly path: string) {
    super('The basket took too long to respond.');
  }
}

async function ajax<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CART_REQUEST_MS);
  let res: Response;
  try {
    res = await fetch(cartPath(path), {
      credentials: 'same-origin',
      ...init,
      // After the spread: an init with its own headers once replaced these, and every POST went out without Accept.
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new CartTimeout(path);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { description?: string; message?: string };
    throw new CartRejected(res.status, body.description || body.message || `The basket could not be updated (${res.status}).`);
  }
  return res.json() as Promise<T>;
}

/** The store answered and refused: the one failure whose outcome is known - nothing was changed by this request. */
export class CartRejected extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** How a failed request is classed for the report: only a refusal the store sent is a known outcome. */
export function failureKind(err: unknown): 'rejected' | 'network' | 'timeout' {
  if (err instanceof CartTimeout) return 'timeout';
  if (err instanceof CartRejected) return 'rejected';
  return 'network';
}

const gid = (kind: 'Product' | 'ProductVariant', id: number) => `gid://shopify/${kind}/${id}`;

function toCart(raw: AjaxCart): Cart {
  const currency = raw.currency || shopify()?.currency?.active || 'GBP';
  return {
    id: raw.token,
    checkoutUrl: '/checkout',
    totalQuantity: raw.item_count,
    // The cart's own total, after any bundle discount the store applies.
    subtotal: { amount: raw.total_price / 100, currency },
    lines: raw.items.map((item) => ({
      lineId: item.key,
      productId: gid('Product', item.product_id),
      variantId: gid('ProductVariant', item.variant_id),
      title: item.product_title,
      variantTitle: item.variant_title ?? '',
      imageUrl: item.image,
      quantity: item.quantity,
      unitPrice: { amount: item.final_price / 100, currency },
      lineTotal: { amount: item.final_line_price / 100, currency },
      ...(typeof item.properties?.['__Bundle_Name'] === 'string' ? { bundle: String(item.properties['__Bundle_Name']) } : {}),
    })),
  };
}

/** Which bundle a line belongs to, from the properties the theme's builder writes. */
function bundleOf(item: AjaxCart['items'][number]): string | undefined {
  // __bundle_id from the old bundle builder, _data_bundle_id from the sport-bundle (condition) packs.
  const id = item.properties?.['__bundle_id'] ?? item.properties?.['_data_bundle_id'];
  return typeof id === 'string' && id ? id : undefined;
}

let lastRaw: AjaxCart | null = null;

export async function readCart(): Promise<Cart> {
  lastRaw = await ajax<AjaxCart>('/cart.js');
  return toCart(lastRaw);
}

/** The cart as the server needs it, so the model can see what is really in it. */
export function basketSync(raw: AjaxCart | null = lastRaw): BasketSync {
  return {
    ...(raw?.token ? { cartToken: raw.token } : {}),
    ...(raw?.currency ? { currency: raw.currency } : {}),
    lines: (raw?.items ?? []).map((item) => ({
      key: item.key,
      productId: gid('Product', item.product_id),
      variantId: gid('ProductVariant', item.variant_id),
      title: item.product_title,
      variantTitle: item.variant_title ?? '',
      quantity: item.quantity,
      ...(item.properties && Object.keys(item.properties).length ? { properties: Object.fromEntries(Object.entries(item.properties).map(([key, value]) => [key, String(value ?? '')])) } : {}),
      ...(item.selling_plan_allocation?.selling_plan?.id !== undefined ? { sellingPlanId: String(item.selling_plan_allocation.selling_plan.id) } : {}),
      ...(bundleOf(item) ? { bundle: bundleOf(item) } : {}),
      ...(typeof item.properties?.['__Bundle_Name'] === 'string' ? { bundleName: String(item.properties['__Bundle_Name']) } : {}),
      // What Shopify took off this line, by discount title - always sent, [] when nothing, so "no discount" is told apart from "not reported".
      ...(Number.isFinite(item.original_line_price) ? { originalLinePrice: Math.max(0, Math.round(Number(item.original_line_price))) } : {}),
      discounts: (item.line_level_discount_allocations ?? []).map((allocation) => ({ title: String(allocation.discount_application?.title ?? ''), amount: Math.max(0, Math.round(Number(allocation.amount) || 0)) })),
    })),
  };
}

/** A fresh read of the cart, or null when the store did not answer - never a stale copy passed off as fresh. */
async function readRaw(): Promise<AjaxCart | null> {
  try {
    lastRaw = await ajax<AjaxCart>('/cart.js');
    return lastRaw;
  } catch {
    return null;
  }
}

const sameProperties = (a: Record<string, unknown> | null, b: Record<string, unknown> | null) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
const samePlan = (a: AjaxCart['items'][number], b: AjaxCart['items'][number]) => String(a.selling_plan_allocation?.selling_plan?.id ?? '') === String(b.selling_plan_allocation?.selling_plan?.id ?? '');

/**
 * One operation the server handed over, carried out in the store's cart and
 * reported as the cart then showed it (server: tools/cartOperations.ts).
 *
 * The cart is read before, so the report can show the change and not just
 * the state, and after every step. A replacement adds the new size first
 * and only then takes the old line out - re-found in the fresh read, by key
 * or, when the add re-keyed the cart, by variant and properties - so a
 * refused add leaves the old line untouched, and an add that went in but a
 * removal that did not is reported as exactly that, never as done. A
 * request that times out is reported uncertain: the store may have done
 * the work, and only a read can say.
 */
export async function runOperation(action: Extract<CartAction, { type: 'add' | 'change' }>): Promise<CartOutcomeReport> {
  const operationId = action.operationId ?? '';
  const beforeRaw = await readRaw();
  const before = beforeRaw ? basketSync(beforeRaw) : null;
  const report = (status: CartOutcomeReport['status'], after: AjaxCart | null, error?: string, failure?: CartOutcomeReport['failure']): CartOutcomeReport => ({
    operationId,
    status,
    before,
    after: after ? basketSync(after) : null,
    ...(error ? { error } : {}),
    ...(failure ? { failure } : {}),
    evidence: 'ajax-cart-read',
  });
  // A refusal the store sent is a failure with a known outcome; a request that got no answer, or that the widget stopped waiting for, is uncertain.
  const failed = (err: unknown) => (failureKind(err) === 'rejected' ? 'failed' : 'uncertain') as 'uncertain' | 'failed';
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  if (action.type === 'change') {
    try {
      await changeLine(action.lineKey, action.quantity);
    } catch (err) {
      return report(failed(err), await readRaw(), message(err), failureKind(err));
    }
    const after = await readRaw();
    announceToTheme(after);
    return report(after ? 'applied' : 'uncertain', after);
  }

  // add, and for a replacement the old line out once the new one is in
  try {
    await addLines(action.lines);
  } catch (err) {
    return report(failed(err), await readRaw(), message(err), failureKind(err));
  }
  const afterAdd = await readRaw();
  const outgoing = action.removeKeys ?? [];
  if (!outgoing.length) {
    announceToTheme(afterAdd);
    return report(afterAdd ? 'applied' : 'uncertain', afterAdd);
  }
  if (!afterAdd) return report('uncertain', null, 'The basket could not be read after the add.');
  // The lines going out, as the cart holds them now: by key, or - the add re-keyed the cart - by the variant and properties the key had before.
  const keys: string[] = [];
  for (const key of outgoing) {
    const held = afterAdd.items.find((item) => item.key === key);
    if (held) {
      keys.push(held.key);
      continue;
    }
    const was = beforeRaw?.items.find((item) => item.key === key);
    const expected = action.expect?.remove?.find((line) => line.key === key);
    const variant = was?.variant_id ?? (expected ? Number(expected.variantId) : undefined);
    const again = afterAdd.items.find((item) => item.variant_id === variant && (!was || (sameProperties(item.properties, was.properties) && samePlan(item, was))) && !action.lines.some((line) => Number(line.variantId) === item.variant_id && item.quantity === line.quantity && !was));
    if (again) keys.push(again.key);
  }
  if (keys.length !== outgoing.length) return report('partial', afterAdd, 'The line to take out could not be found in the basket.');
  try {
    if (keys.length === 1) await changeLine(keys[0]!, 0);
    else await setLines(Object.fromEntries(keys.map((key) => [key, 0])));
  } catch (err) {
    const after = await readRaw();
    return report(err instanceof CartTimeout && !after ? 'uncertain' : 'partial', after, message(err), failureKind(err));
  }
  const after = await readRaw();
  announceToTheme(after);
  return report(after ? 'applied' : 'uncertain', after);
}

/** A read of the cart for an operation whose outcome was never reported (a refresh, a lost answer): what the cart shows now. */
/** How long a chat turn waits for its basket read before it is sent without one. */
export const TURN_BASKET_MS = 2500;

/**
 * The cart as it is now, for the chat turn about to be sent: read fresh from
 * /cart.js and converted exactly as the basket route takes it (basketSync).
 * Only on the storefront (the caller checks onStorefront). Null when the read fails or takes longer than `ms` - never an empty basket
 * standing in for one we could not read: the server then keeps the copy it
 * had, and the message still goes (Smart Cart phase 1).
 */
export async function basketForTurn(ms = TURN_BASKET_MS): Promise<BasketSync | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  const raw = await Promise.race([readRaw(), late]);
  clearTimeout(timer);
  if (!raw) {
    console.warn('[caddie] could not read the cart before sending; sending without it');
    return null;
  }
  return basketSync(raw);
}

/**
 * Set while Caddie itself asks the theme to re-render its drawer
 * (announceToTheme), so its own change is not taken for the theme's.
 */
let ownRender = false;

/** How long rapid theme re-renders are gathered into one basket read. */
export const THEME_CART_DEBOUNCE_MS = 400;

const WATCHED = '__caddieWatched';
type RenderFn = ((...args: unknown[]) => unknown) & { [WATCHED]?: true; __caddieOriginal?: (...args: unknown[]) => unknown };

/**
 * How long after Caddie's own change a redraw of the theme's drawer is taken
 * for that change (the theme fetching its drawer section in answer to our
 * cart:refresh), not for one of the theme's own.
 */
export const OWN_DRAWER_QUIET_MS = 2500;
let ownUntil = 0;

/** The id Caddie's own cart events carry, so they are never read back as the theme's. */
const OWN_SOURCE = 'druids-caddie';

/**
 * Changes to the cart made by the rest of the theme. Themes say so in
 * different ways, and each is watched; the theme's own behaviour is
 * unchanged, and every signal not caused by Caddie schedules one debounced
 * change. No polling.
 *
 * - The live Druids theme ("Autumn 2026", snippets/application_script.liquid)
 *   dispatches no cart events; every one of its cart paths calls the global
 *   RE_RENDER_DRAWER() on success - QUICK_CART, the drawer's UPDATE_QTY /
 *   UPDATE_LINE_ITEM / REMOVE_BUNDLES, the cart page, bundle builder v4. So
 *   that function is wrapped (again on window load, if defined later).
 * - The sport theme (the copy Smart Cart is previewed on) has no
 *   RE_RENDER_DRAWER and dispatches no cart events either: its adds and its
 *   drawer controls end by redrawing #cart-drawer from the Section Rendering
 *   API (assets/sport-quick-cart.js). A redraw there is its cart changing -
 *   the theme's own header count watches the same element the same way. So
 *   #cart-drawer's children are observed, and nothing else.
 * - A theme that does announce (cart:refresh, cart:update) is heard, unless
 *   the announcement is Caddie's own.
 */
export function watchThemeCart(onChange: () => void, debounceMs = THEME_CART_DEBOUNCE_MS): () => void {
  const w = window as unknown as { RE_RENDER_DRAWER?: RenderFn };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let installed: RenderFn | undefined;
  let observer: MutationObserver | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  const onEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ sourceId?: string } | undefined>).detail;
    if (detail?.sourceId !== OWN_SOURCE) schedule();
  };
  const observeDrawer = () => {
    const drawer = document.getElementById('cart-drawer');
    if (observer || !drawer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(() => {
      // The redraw our own cart:refresh asked for is not the theme's change.
      if (Date.now() >= ownUntil) schedule();
    });
    observer.observe(drawer, { childList: true, subtree: true });
  };
  const install = () => {
    const current = w.RE_RENDER_DRAWER;
    if (typeof current !== 'function' || current[WATCHED]) return;
    const wrapped: RenderFn = function (this: unknown, ...args: unknown[]) {
      // The cart has already changed when the theme calls this (its success callbacks).
      if (!ownRender) schedule();
      return current.apply(this, args);
    };
    wrapped[WATCHED] = true;
    wrapped.__caddieOriginal = current;
    w.RE_RENDER_DRAWER = wrapped;
    installed = wrapped;
  };
  const onLoad = () => {
    install();
    observeDrawer();
  };
  onLoad();
  window.addEventListener('load', onLoad);
  document.addEventListener('cart:refresh', onEvent);
  document.addEventListener('cart:update', onEvent);
  return () => {
    clearTimeout(timer);
    window.removeEventListener('load', onLoad);
    document.removeEventListener('cart:refresh', onEvent);
    document.removeEventListener('cart:update', onEvent);
    observer?.disconnect();
    if (installed && w.RE_RENDER_DRAWER === installed && installed.__caddieOriginal) w.RE_RENDER_DRAWER = installed.__caddieOriginal as RenderFn;
  };
}

export async function observe(operationId: string): Promise<CartOutcomeReport> {
  const after = await readRaw();
  return { operationId, status: 'uncertain', before: null, after: after ? basketSync(after) : null, evidence: 'ajax-cart-read' };
}

/**
 * Tell the theme its cart changed, so its cart icon and drawer catch up.
 * Themes listen for different things: the Druids theme re-renders its drawer
 * with RE_RENDER_DRAWER, Horizon-based themes listen for cart:update, and
 * older ones for cart:refresh. Each is harmless where it is not heard.
 */
export function announceToTheme(cart: AjaxCart | null = lastRaw): void {
  // Caddie's own re-render: not a theme change to read back (watchThemeCart) - nor the drawer redraw it sets off.
  ownRender = true;
  ownUntil = Date.now() + OWN_DRAWER_QUIET_MS;
  try {
    (window as unknown as { RE_RENDER_DRAWER?: () => void }).RE_RENDER_DRAWER?.();
  } catch {
    // The theme's own function failing is not ours to surface.
  } finally {
    ownRender = false;
  }
  const detail = { resource: cart, sourceId: OWN_SOURCE, data: { itemCount: cart?.item_count ?? 0, source: OWN_SOURCE } };
  document.dispatchEvent(new CustomEvent('cart:update', { bubbles: true, detail }));
  document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true, detail }));
}

async function addLines(lines: Array<{ variantId: string; quantity: number; properties?: Record<string, string> }>): Promise<void> {
  await ajax('/cart/add.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Properties only when the server sent them: a Smart Cart offer trigger, written as the theme's own Add button writes it.
    body: JSON.stringify({ items: lines.map((line) => ({ id: Number(line.variantId), quantity: line.quantity, ...(line.properties && Object.keys(line.properties).length ? { properties: line.properties } : {}) })) }),
  });
}

/**
 * Several lines at once, in one request. Removing lines one by one failed on
 * the live store: taking out the first piece of a pack changes the cart and
 * Shopify re-keys the lines left, so the second removal named a key that no
 * longer existed (400) and half a pack was left behind. /cart/update.js takes
 * them all together.
 */
async function setLines(quantities: Record<string, number>): Promise<void> {
  await ajax('/cart/update.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: quantities }),
  });
}

async function changeLine(key: string, quantity: number): Promise<void> {
  await ajax('/cart/change.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: key, quantity }),
  });
}

/** Lines already tried this page, so a refusal is not sent again on every basket read. */
const triedRepairs = new Set<string>();

/**
 * Gives basket lines their Smart Cart deal key, as the server listed them
 * (server: smartCart/repair.ts): a qualifying line added without one - by
 * a path the copied theme does not stamp yet, or before it stamped any -
 * is not counted by SupaEasy. Each is checked against a fresh read first
 * and changed only if it is still there, plain, at the same quantity: the
 * customer may have changed it since. cart/change.js replaces the line's
 * properties, and a plain line has none to lose. Returns whether the cart
 * changed.
 */
export async function repairLines(repairs: readonly SmartCartRepair[]): Promise<boolean> {
  const pending = repairs.filter((repair) => !triedRepairs.has(repair.lineKey));
  if (!pending.length) return false;
  const now = await readRaw();
  if (!now) return false;
  let changed = false;
  for (const repair of pending) {
    triedRepairs.add(repair.lineKey);
    const line = now.items.find((item) => item.key === repair.lineKey);
    const plain = line && !(line.properties && Object.keys(line.properties).length) && !line.selling_plan_allocation;
    if (!line || !plain || gid('ProductVariant', line.variant_id) !== repair.variantId || line.quantity !== repair.quantity) continue;
    try {
      await ajax('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: repair.lineKey, quantity: repair.quantity, properties: repair.properties }),
      });
      changed = true;
    } catch (err) {
      // Left as it was - full price, as before - and not tried again this page.
      console.warn('[caddie] could not add the deal key to a basket line', err);
    }
  }
  if (changed) announceToTheme(await readRaw());
  return changed;
}

/** A bundle deal, added exactly as the theme's bundle builder adds it. */
async function addBundle(
  bundle: BundleDeal,
  pieces: Array<{ variantId: string; productId: string; price: number; compareAtPrice: number | null }>,
  bundleId?: string,
): Promise<void> {
  const now = Date.now();
  const items = buildBundleCartItems(bundle, pieces, {
    currency: shopify()?.currency?.active ?? 'GBP',
    country: shopify()?.country ?? 'GB',
    now,
    bundleId: bundleId ?? newBundleId(now),
  });
  await ajax('/cart/add.js', {
    method: 'POST',
    // Form-encoded, as jQuery sends it from the theme, so every value arrives as the same text.
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: formEncodeCartItems(items),
  });
}

/**
 * Carries out the server's cart actions in order and returns the cart after.
 * A swap removes its old lines only once the new one is in: a failed add must
 * never leave the customer with neither.
 */
export async function runActions(actions: CartAction[]): Promise<Cart> {
  // An operation the server will only count as made on its report is never run here: see runOperation.
  actions = actions.filter((action) => !((action.type === 'add' || action.type === 'change') && action.operationId));
  // Removals together first, in one request - see setLines.
  const removals = actions.filter((action): action is Extract<CartAction, { type: 'change' }> => action.type === 'change' && action.quantity === 0);
  if (removals.length > 1) {
    await setLines(Object.fromEntries(removals.map((action) => [action.lineKey, 0])));
    actions = actions.filter((action) => !removals.includes(action as never));
  }
  for (const action of actions) {
    if (action.type === 'add') {
      await addLines(action.lines);
      if (action.removeKeys?.length) await setLines(Object.fromEntries(action.removeKeys.map((key) => [key, 0])));
    } else if (action.type === 'change') {
      await changeLine(action.lineKey, action.quantity);
    } else if (action.type === 'add-bundle') {
      await addBundle(action.bundle, action.pieces, action.bundleId);
      if (action.replaceBundles?.length) {
        // Read fresh: the add has re-keyed the lines of the old pack.
        const now = await ajax<AjaxCart>('/cart.js');
        const old = now.items.filter((item) => action.replaceBundles!.includes(bundleOf(item) ?? ''));
        if (old.length) await setLines(Object.fromEntries(old.map((item) => [item.key, 0])));
      }
    }
  }
  const cart = await readCart();
  announceToTheme();
  return cart;
}

// Nothing else is exported that changes the cart: every change is one the server handed back (runActions, runOperation, repairLines).
