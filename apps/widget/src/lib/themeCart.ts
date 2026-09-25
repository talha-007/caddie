import {
  buildBundleCartItems,
  formEncodeCartItems,
  newBundleId,
  type BasketSync,
  type BundleDeal,
  type Cart,
  type CartAction,
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
}

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
  }>;
}

async function ajax<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { description?: string; message?: string };
    throw new Error(body.description || body.message || `The basket could not be updated (${res.status}).`);
  }
  return res.json() as Promise<T>;
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
export function basketSync(): BasketSync {
  return {
    lines: (lastRaw?.items ?? []).map((item) => ({
      key: item.key,
      productId: gid('Product', item.product_id),
      variantId: gid('ProductVariant', item.variant_id),
      title: item.product_title,
      variantTitle: item.variant_title ?? '',
      quantity: item.quantity,
      ...(bundleOf(item) ? { bundle: bundleOf(item) } : {}),
      ...(typeof item.properties?.['__Bundle_Name'] === 'string' ? { bundleName: String(item.properties['__Bundle_Name']) } : {}),
    })),
  };
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

export { addLines as addToThemeCart, addBundle as addBundleToThemeCart, changeLine as changeThemeCartLine, setLines as setThemeCartLines };
