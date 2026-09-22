import type { Cart, CartLine, Money, Product, ProductVariant } from '@caddie/shared';
import { callShopifyTool } from './mcpClient.js';

/**
 * Normalisers between the MCP payloads and our own types.
 *
 * The MCP payload shape shifts a little between stores and versions, so we
 * read defensively and drop anything we cannot verify rather than invent it.
 */

const DEFAULT_CURRENCY = 'GBP';

function toMoney(raw: unknown, fallbackCurrency = DEFAULT_CURRENCY): Money {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const nested = obj.min_variant_price ?? obj.minVariantPrice ?? null;
    if (nested) return toMoney(nested, fallbackCurrency);
    const amount = Number(obj.amount ?? obj.price ?? 0);
    const currency = String(obj.currency_code ?? obj.currencyCode ?? obj.currency ?? fallbackCurrency);
    return { amount: Number.isFinite(amount) ? amount : 0, currency };
  }
  const amount = Number(raw ?? 0);
  return { amount: Number.isFinite(amount) ? amount : 0, currency: fallbackCurrency };
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function toVariant(raw: Record<string, unknown>): ProductVariant {
  const options: Record<string, string> = {};
  const rawOptions = raw.options ?? raw.selected_options ?? raw.selectedOptions;

  if (Array.isArray(rawOptions)) {
    for (const entry of rawOptions as Array<Record<string, unknown>>) {
      const key = firstString(entry.name, entry.key);
      const value = firstString(entry.value);
      if (key && value) options[key] = value;
    }
  } else if (rawOptions && typeof rawOptions === 'object') {
    for (const [key, value] of Object.entries(rawOptions as Record<string, unknown>)) {
      if (typeof value === 'string') options[key] = value;
    }
  }

  return {
    id: String(raw.variant_id ?? raw.id ?? ''),
    title: firstString(raw.title, raw.name) ?? '',
    available: Boolean(raw.available ?? raw.availableForSale ?? raw.available_for_sale ?? true),
    price: toMoney(raw.price ?? raw.priceV2),
    options,
  };
}

export function toProduct(raw: Record<string, unknown>): Product {
  const variants = Array.isArray(raw.variants)
    ? (raw.variants as Array<Record<string, unknown>>).map(toVariant)
    : [];
  const image = raw.image && typeof raw.image === 'object' ? (raw.image as Record<string, unknown>) : null;

  return {
    id: String(raw.product_id ?? raw.id ?? ''),
    title: firstString(raw.title, raw.name) ?? 'Untitled product',
    url: firstString(raw.url, raw.online_store_url, raw.onlineStoreUrl) ?? '',
    imageUrl: firstString(raw.image_url, raw.imageUrl, image?.url),
    vendor: firstString(raw.vendor),
    productType: firstString(raw.product_type, raw.productType),
    tags: Array.isArray(raw.tags) ? (raw.tags as unknown[]).map(String) : [],
    price: toMoney(raw.price ?? raw.price_range ?? raw.priceRange ?? variants[0]?.price),
    variants,
    description: firstString(raw.description, raw.body_html),
  };
}

/* ---------------- Catalog ---------------- */

export interface SearchOptions {
  query: string;
  /** Why we are searching. The MCP server uses it to bias results. */
  context?: string;
  limit?: number;
  minPrice?: number;
  maxPrice?: number;
}

export async function searchProducts(opts: SearchOptions): Promise<Product[]> {
  const payload = await callShopifyTool<Record<string, unknown>>('search_shop_catalog', {
    query: opts.query,
    context: opts.context ?? 'Druids Personal Caddie helping a customer choose kit',
    limit: opts.limit ?? 10,
    ...(opts.minPrice !== undefined ? { min_price: opts.minPrice } : {}),
    ...(opts.maxPrice !== undefined ? { max_price: opts.maxPrice } : {}),
  });

  const list = payload.products ?? payload.results ?? payload.items ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((p) => toProduct(p as Record<string, unknown>)).filter((p) => p.id);
}

export async function getProductDetails(
  productId: string,
  options?: Record<string, string>,
): Promise<Product | null> {
  const payload = await callShopifyTool<Record<string, unknown>>('get_product_details', {
    product_id: productId,
    ...(options && Object.keys(options).length ? { options } : {}),
  });

  const raw = (payload.product ?? payload) as Record<string, unknown>;
  if (!raw || (!raw.id && !raw.product_id)) return null;
  return toProduct(raw);
}

/* ---------------- Cart ---------------- */

function toCartLine(raw: Record<string, unknown>): CartLine {
  const unitPrice = toMoney(raw.price ?? raw.unit_price);
  const quantity = Number(raw.quantity ?? 1);
  return {
    lineId: String(raw.id ?? raw.line_id ?? ''),
    productId: String(raw.product_id ?? raw.productId ?? ''),
    variantId: String(raw.variant_id ?? raw.variantId ?? ''),
    title: firstString(raw.title, raw.name) ?? '',
    variantTitle: firstString(raw.variant_title, raw.variantTitle) ?? '',
    imageUrl: firstString(raw.image_url, raw.imageUrl),
    quantity,
    unitPrice,
    lineTotal: { amount: unitPrice.amount * quantity, currency: unitPrice.currency },
  };
}

function toCart(raw: Record<string, unknown>): Cart {
  const rawLines = raw.lines ?? raw.items ?? [];
  const lines = Array.isArray(rawLines)
    ? (rawLines as Array<Record<string, unknown>>).map(toCartLine)
    : [];
  const subtotal = raw.subtotal ?? raw.cost ?? raw.total ?? null;

  return {
    id: String(raw.cart_id ?? raw.id ?? ''),
    checkoutUrl: firstString(raw.checkout_url, raw.checkoutUrl),
    lines,
    subtotal: subtotal
      ? toMoney(subtotal)
      : {
          amount: lines.reduce((sum, line) => sum + line.lineTotal.amount, 0),
          currency: lines[0]?.unitPrice.currency ?? DEFAULT_CURRENCY,
        },
    totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}

export async function getCart(cartId: string): Promise<Cart> {
  const payload = await callShopifyTool<Record<string, unknown>>('get_cart', { cart_id: cartId });
  return toCart((payload.cart ?? payload) as Record<string, unknown>);
}

export interface CartUpdate {
  cartId?: string;
  addItems?: Array<{ variantId: string; quantity: number }>;
  updateItems?: Array<{ lineId: string; quantity: number }>;
  removeLineIds?: string[];
}

export async function updateCart(update: CartUpdate): Promise<Cart> {
  const payload = await callShopifyTool<Record<string, unknown>>('update_cart', {
    ...(update.cartId ? { cart_id: update.cartId } : {}),
    ...(update.addItems?.length
      ? {
          add_items: update.addItems.map((item) => ({
            product_variant_id: item.variantId,
            quantity: item.quantity,
          })),
        }
      : {}),
    ...(update.updateItems?.length
      ? { update_items: update.updateItems.map((item) => ({ id: item.lineId, quantity: item.quantity })) }
      : {}),
    ...(update.removeLineIds?.length ? { remove_line_ids: update.removeLineIds } : {}),
  });
  return toCart((payload.cart ?? payload) as Record<string, unknown>);
}
