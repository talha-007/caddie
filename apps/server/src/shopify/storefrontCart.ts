import type { Cart, CartLine, Money } from '@caddie/shared';
import { env } from '../env.js';
import { UpstreamError } from '../lib/errors.js';
import { fetchWithTimeout } from '../lib/http.js';
import { log } from '../lib/logger.js';

/**
 * The basket, over the Storefront API.
 *
 * Shopify does not rate-limit buyer traffic on the Storefront API, which is
 * the whole reason for this file: the UCP endpoint is throttled hard enough
 * that a busy hour takes the basket down for the best part of an hour, and a
 * basket is the one thing that cannot be cached or mirrored.
 *
 * Two differences from the UCP cart worth knowing:
 *  - cartLinesAdd merges rather than replacing, so no read-modify-write.
 *  - Money comes back as decimal strings already in major units ("42.00"),
 *    not minor units.
 *
 * Needs SHOPIFY_STOREFRONT_TOKEN. Without it the UCP cart is used instead.
 */

const API_VERSION = '2025-07';

/**
 * Shopify has two kinds of Storefront token and they take different headers.
 *
 *  - A **public** token is 32 hex characters with no prefix, is safe in a
 *    browser, and goes in `X-Shopify-Storefront-Access-Token`.
 *  - A **private** (delegate) token is prefixed `shpat_`, is server-only, and
 *    goes in `Shopify-Storefront-Private-Token`.
 *
 * Sending a private token in the public header returns a 401 with an empty
 * message - no hint that the token is fine and the header is wrong. That cost
 * an afternoon: the token had just been created, so the obvious reading was
 * that it was the wrong token, not that we were asking the wrong way.
 */
export function authHeader(token: string): Record<string, string> {
  return token.startsWith('shpat_')
    ? { 'Shopify-Storefront-Private-Token': token }
    : { 'X-Shopify-Storefront-Access-Token': token };
}

export function storefrontCartEnabled(): boolean {
  return Boolean(env.shopify.storefrontToken);
}

interface GqlCartLine {
  id: string;
  quantity: number;
  cost?: { totalAmount?: { amount?: string; currencyCode?: string } };
  merchandise?: {
    id?: string;
    title?: string;
    price?: { amount?: string; currencyCode?: string };
    image?: { url?: string } | null;
    product?: { id?: string; title?: string };
  };
}

interface GqlCart {
  id: string;
  checkoutUrl?: string;
  totalQuantity?: number;
  cost?: { subtotalAmount?: { amount?: string; currencyCode?: string } };
  lines?: { nodes?: GqlCartLine[] };
}

const CART_FIELDS = `
  id
  checkoutUrl
  totalQuantity
  cost { subtotalAmount { amount currencyCode } }
  lines(first: 100) {
    nodes {
      id
      quantity
      cost { totalAmount { amount currencyCode } }
      merchandise {
        ... on ProductVariant {
          id
          title
          price { amount currencyCode }
          image { url }
          product { id title }
        }
      }
    }
  }`;

async function storefront<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetchWithTimeout(`https://${env.shopify.storeDomain}/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    timeoutMs: 15_000,
    label: 'Shopify Storefront API',
    headers: {
      ...authHeader(env.shopify.storefrontToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new UpstreamError(`Shopify Storefront API responded ${res.status}`, await res.text().catch(() => ''));
  }

  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new UpstreamError('Shopify Storefront API error', body.errors);
  if (!body.data) throw new UpstreamError('Shopify Storefront API returned no data');
  return body.data;
}

function money(raw: { amount?: string; currencyCode?: string } | undefined, fallback = 'GBP'): Money {
  return {
    // Already major units here, unlike UCP.
    amount: Number(raw?.amount ?? 0),
    currency: raw?.currencyCode ?? fallback,
  };
}

function toLine(raw: GqlCartLine, currency: string): CartLine {
  const variant = raw.merchandise ?? {};
  const unitPrice = money(variant.price, currency);
  const name = variant.product?.title ?? '';
  const option = variant.title && variant.title !== 'Default Title' ? ` - ${variant.title}` : '';

  return {
    lineId: raw.id,
    productId: variant.product?.id ?? '',
    variantId: variant.id ?? '',
    title: `${name}${option}`.trim(),
    variantTitle: variant.title ?? '',
    imageUrl: variant.image?.url ?? null,
    quantity: raw.quantity,
    unitPrice,
    lineTotal: money(raw.cost?.totalAmount, currency),
  };
}

function toCart(raw: GqlCart): Cart {
  const subtotal = money(raw.cost?.subtotalAmount);
  const lines = (raw.lines?.nodes ?? []).map((line) => toLine(line, subtotal.currency));

  return {
    id: raw.id,
    checkoutUrl: raw.checkoutUrl ?? null,
    lines,
    subtotal,
    totalQuantity: raw.totalQuantity ?? lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}

/** Surfaces the userErrors Shopify returns instead of failing the request. */
function unwrap(result: { cart?: GqlCart; userErrors?: Array<{ message?: string }> } | undefined, what: string): Cart {
  const errors = result?.userErrors ?? [];
  if (errors.length > 0) {
    throw new UpstreamError(`${what}: ${errors.map((error) => error.message).join('; ')}`, errors);
  }
  if (!result?.cart) throw new UpstreamError(`${what} returned no cart`);
  return toCart(result.cart);
}

export async function getCart(cartId: string): Promise<Cart> {
  const data = await storefront<{ cart: GqlCart | null }>(
    `query($id: ID!) { cart(id: $id) { ${CART_FIELDS} } }`,
    { id: cartId },
  );
  if (!data.cart) throw new UpstreamError('That basket has expired.');
  return toCart(data.cart);
}

export async function createCart(variantId: string, quantity: number): Promise<Cart> {
  const data = await storefront<{ cartCreate?: { cart?: GqlCart; userErrors?: Array<{ message?: string }> } }>(
    `mutation($lines: [CartLineInput!]!) {
       cartCreate(input: { lines: $lines }) { cart { ${CART_FIELDS} } userErrors { field message } }
     }`,
    { lines: [{ merchandiseId: variantId, quantity }] },
  );
  return unwrap(data.cartCreate, 'Could not start a basket');
}

/** Adds to an existing basket. Merges, so no read-modify-write. */
export async function addToCart(cartId: string | undefined, variantId: string, quantity = 1): Promise<Cart> {
  if (!cartId) return createCart(variantId, quantity);

  const data = await storefront<{ cartLinesAdd?: { cart?: GqlCart; userErrors?: Array<{ message?: string }> } }>(
    `mutation($cartId: ID!, $lines: [CartLineInput!]!) {
       cartLinesAdd(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { field message } }
     }`,
    { cartId, lines: [{ merchandiseId: variantId, quantity }] },
  );
  return unwrap(data.cartLinesAdd, 'Could not add that');
}

/** Sets a line to an exact quantity. 0 removes it. */
export async function setLineQuantity(cartId: string, lineId: string, quantity: number): Promise<Cart> {
  if (quantity <= 0) {
    const data = await storefront<{ cartLinesRemove?: { cart?: GqlCart; userErrors?: Array<{ message?: string }> } }>(
      `mutation($cartId: ID!, $lineIds: [ID!]!) {
         cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { field message } }
       }`,
      { cartId, lineIds: [lineId] },
    );
    return unwrap(data.cartLinesRemove, 'Could not remove that');
  }

  const data = await storefront<{ cartLinesUpdate?: { cart?: GqlCart; userErrors?: Array<{ message?: string }> } }>(
    `mutation($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
       cartLinesUpdate(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { field message } }
     }`,
    { cartId, lines: [{ id: lineId, quantity }] },
  );
  return unwrap(data.cartLinesUpdate, 'Could not change that');
}

export function logMode(): void {
  log.info('cart.mode', { via: storefrontCartEnabled() ? 'storefront-api' : 'ucp' });
}

/**
 * What checkout would charge for these lines, from a throwaway cart.
 *
 * A pack's price is applied at checkout by a discount Function that looks
 * for the pack's trigger property. A trigger the Function has not been set up
 * for is silently ignored: the Mixed Conditions and Cool & Wet packs went into
 * a test cart at £117 and £114 - the sum of their pieces - against quoted
 * pack prices of £99.99 and £159.99. This asks Shopify rather than trusting
 * the theme's word. The cart is never checked out; Shopify expires it.
 */
export async function checkoutTotal(
  lines: Array<{ variantId: string; properties: Array<[string, string]> }>,
  countryCode = 'GB',
): Promise<number> {
  const data = await storefront<{
    cartCreate?: { cart?: { cost: { totalAmount: { amount: string } } }; userErrors?: Array<{ message?: string }> };
  }>(
    `mutation($lines: [CartLineInput!]!, $country: CountryCode!) {
       cartCreate(input: { lines: $lines, buyerIdentity: { countryCode: $country } }) {
         cart { cost { totalAmount { amount } } }
         userErrors { message }
       }
     }`,
    {
      country: countryCode,
      lines: lines.map((line) => ({
        merchandiseId: line.variantId.startsWith('gid://') ? line.variantId : `gid://shopify/ProductVariant/${line.variantId}`,
        quantity: 1,
        attributes: line.properties.map(([key, value]) => ({ key, value })),
      })),
    },
  );
  const cart = data.cartCreate?.cart;
  if (!cart) throw new UpstreamError(data.cartCreate?.userErrors?.[0]?.message ?? 'Could not price the pack');
  return Number(cart.cost.totalAmount.amount);
}
