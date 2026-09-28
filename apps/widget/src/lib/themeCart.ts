import {
  buildBundleCartItems,
  formEncodeCartItems,
  newBundleId,
  type BasketSync,
  type BundleDeal,
  type Cart,
  type CartAction,
  type CartOutcomeReport,
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
    properties: Record<string, unknown> | null;
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
  try {
    (window as unknown as { RE_RENDER_DRAWER?: () => void }).RE_RENDER_DRAWER?.();
  } catch {
    // The theme's own function failing is not ours to surface.
  }
  const detail = { resource: cart, sourceId: 'druids-caddie', data: { itemCount: cart?.item_count ?? 0, source: 'druids-caddie' } };
  document.dispatchEvent(new CustomEvent('cart:update', { bubbles: true, detail }));
  document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true, detail }));
}

async function addLines(lines: Array<{ variantId: string; quantity: number }>): Promise<void> {
  await ajax('/cart/add.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: lines.map((line) => ({ id: Number(line.variantId), quantity: line.quantity })) }),
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

// Nothing else is exported that changes the cart: every change is one the server's Action Gateway handed back (runActions).
