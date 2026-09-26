import type { Cart, CartLine, Product, ProductOption, ProductVariant } from '@caddie/shared';
import { env } from '../env.js';
import { inRange, parseRange, type Range } from '../catalog/audience.js';
import { isCategory, sizeStatus, type Category } from '../catalog/constraints.js';
import { colourMatch, parseColours } from '../catalog/colour.js';
import { searchLocal } from '../catalog/search.js';
import { catalogueReady, productById, productByTitle } from '../catalog/sync.js';
import { cached, CATALOG_TTL_MS, clearCatalogCache } from './cache.js';
import * as storefrontCart from './storefrontCart.js';
import { addMoney, readMoney, storeCurrency, toMinorUnits } from './money.js';
import { log } from '../lib/logger.js';
import { buyerContext, callUcpTool } from './ucpClient.js';
import { optionValueMatches } from '../recommend/sizeWords.js';

/**
 * Normalisers between the UCP payloads and our own types.
 *
 * Shapes are read defensively: anything we cannot verify is dropped rather
 * than guessed at.
 */

const DEFAULT_CURRENCY = storeCurrency();

interface UcpText {
  html?: string;
}

interface UcpMedia {
  type?: string;
  url?: string;
}

function stripHtml(value: unknown): string | null {
  const html = (value as UcpText | undefined)?.html ?? (typeof value === 'string' ? value : null);
  if (!html) return null;
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

function firstImage(media: unknown): string | null {
  if (!Array.isArray(media)) return null;
  const image = (media as UcpMedia[]).find((item) => item.type === 'image' && item.url);
  return image?.url ?? null;
}

function toVariant(raw: Record<string, unknown>, fallbackCurrency: string): ProductVariant {
  const options: Record<string, string> = {};
  if (Array.isArray(raw.options)) {
    for (const option of raw.options as Array<Record<string, unknown>>) {
      const name = typeof option.name === 'string' ? option.name : null;
      const label = typeof option.label === 'string' ? option.label : null;
      if (name && label) options[name] = label;
    }
  }

  const availability = raw.availability as { available?: boolean } | undefined;

  return {
    id: String(raw.id ?? ''),
    title: typeof raw.title === 'string' ? raw.title : '',
    available: availability?.available ?? false,
    price: readMoney(raw.price, fallbackCurrency),
    options,
  };
}

export function toProduct(raw: Record<string, unknown>): Product {
  const priceRange = raw.price_range as { min?: { amount?: number; currency?: string } } | undefined;
  const currency = priceRange?.min?.currency ?? DEFAULT_CURRENCY;

  const rawVariants = Array.isArray(raw.variants) ? (raw.variants as Array<Record<string, unknown>>) : [];
  const variants = rawVariants.map((variant) => toVariant(variant, currency));

  // Products carry their own media; variants carry theirs. Fall back to the
  // first variant so a card is never imageless when an image does exist.
  const image = firstImage(raw.media) ?? firstImage(rawVariants[0]?.media);

  // UCP has no product_type; the first collection is the closest thing.
  const collections = Array.isArray(raw.collections) ? (raw.collections as Array<Record<string, unknown>>) : [];
  const collectionTitle = typeof collections[0]?.title === 'string' ? (collections[0].title as string) : null;

  const options: ProductOption[] = Array.isArray(raw.options)
    ? (raw.options as Array<Record<string, unknown>>)
        .map((option) => ({
          name: typeof option.name === 'string' ? option.name : '',
          values: Array.isArray(option.values)
            ? (option.values as Array<Record<string, unknown>>)
                .map((value) => (typeof value.label === 'string' ? value.label : ''))
                .filter(Boolean)
            : [],
        }))
        .filter((option) => option.name && option.values.length)
    : [];

  return {
    id: String(raw.id ?? ''),
    title: typeof raw.title === 'string' ? raw.title : 'Untitled product',
    url: typeof raw.url === 'string' ? raw.url : '',
    imageUrl: image,
    vendor: typeof raw.vendor === 'string' ? raw.vendor : null,
    productType: collectionTitle,
    tags: Array.isArray(raw.tags) ? (raw.tags as unknown[]).map(String) : [],
    price: readMoney(priceRange?.min, currency),
    options,
    variants,
    description: stripHtml(raw.description),
  };
}

/* ---------------- Catalog ---------------- */

export interface SearchOptions {
  query: string;
  limit?: number;
  /** Major units, as a customer would say it. Converted here. */
  maxPrice?: number;
  minPrice?: number;
  currency?: string;
  /** Default true - only things that can actually be bought. */
  available?: boolean;
  /** The range they are known to be shopping. See catalog/audience.ts. */
  known?: 'men' | 'women';
  /** Hard rules: see catalog/constraints.ts. Applied by the local mirror. */
  range?: Range;
  categories?: Category[];
  size?: string;
}

interface SearchPayload {
  products?: Array<Record<string, unknown>>;
  pagination?: { has_next_page?: boolean; cursor?: string };
}

/**
 * Keeps the Caddie to the brand's own kit.
 *
 * UCP search has no vendor filter and its payload carries no vendor field, so
 * we filter on the tag afterwards and over-fetch to compensate.
 */
export function isBrandProduct(product: Product): boolean {
  const tag = env.shopify.brandTag;
  if (!tag) return true;
  const needle = tag.toLowerCase();
  return product.tags.some((value) => value.toLowerCase() === needle);
}

export async function searchProducts(opts: SearchOptions): Promise<Product[]> {
  const wanted = opts.limit ?? 10;

  /*
   * Served from the local mirror. Shopify's catalogue endpoint is throttled
   * far too hard to call per customer - see catalog/sync.ts - and searching in
   * memory is both unlimited and instant.
   */
  if (catalogueReady()) {
    return searchLocal({
      query: opts.query,
      limit: wanted,
      ...(opts.maxPrice !== undefined ? { maxPrice: opts.maxPrice } : {}),
      ...(opts.minPrice !== undefined ? { minPrice: opts.minPrice } : {}),
      ...(opts.available !== undefined ? { available: opts.available } : {}),
      ...(opts.known ? { known: opts.known } : {}),
      ...(opts.range ? { range: opts.range } : {}),
      ...(opts.categories?.length ? { categories: opts.categories } : {}),
      ...(opts.size ? { size: opts.size } : {}),
    }).filter(isBrandProduct);
  }

  // Only before the first sync has landed, or if it is failing.
  log.warn('catalogue.not_ready', { query: opts.query });
  const currency = opts.currency ?? DEFAULT_CURRENCY;
  const price: Record<string, number> = {};
  if (opts.minPrice !== undefined) price.min = toMinorUnits({ amount: opts.minPrice, currency });
  if (opts.maxPrice !== undefined) price.max = toMinorUnits({ amount: opts.maxPrice, currency });

  const request = {
    catalog: {
      query: opts.query,
      context: buyerContext(),
      filters: { available: opts.available ?? true, ...(Object.keys(price).length ? { price } : {}) },
      pagination: { limit: env.shopify.brandTag ? Math.min(wanted * 3, 50) : wanted },
    },
  };

  const payload = await cached(`search:${JSON.stringify(request)}`, CATALOG_TTL_MS, () =>
    callUcpTool<SearchPayload>('search_catalog', request),
  );

  const products = (payload.products ?? []).map(toProduct).filter((product) => product.id);
  // The same colour rule as the mirror: semantic search returns neighbours,
  // and an orange polo is a neighbour of "blue polo".
  const { colours, plain } = parseColours(opts.query);
  const { range: asked } = parseRange(opts.query);
  return products
    .filter(isBrandProduct)
    .filter((product) => colourMatch(product, colours, opts.available !== false, plain) > 0)
    .filter((product) => inRange(product, opts.range ?? asked, opts.known))
    .filter((product) => !opts.categories?.length || isCategory(product, opts.categories))
    // A result without variants cannot be ruled out on size here; the basket checks it.
    .filter((product) => !opts.size || product.variants.length === 0 || sizeStatus(product, opts.size) === 'in-stock')
    .slice(0, wanted);
}

/** A Shopify GID or a bare numeric id - anything else is a name. */
function looksLikeId(ref: string): boolean {
  return /^gid:\/\/shopify\//.test(ref) || /^\d+$/.test(ref);
}

export async function getProductDetails(
  productId: string,
  selected?: Record<string, string>,
): Promise<Product | null> {
  const mirrored = productById(productId);
  if (mirrored) {
    if (!selected || Object.keys(selected).length === 0) return mirrored;

    /*
     * Narrow to the chosen combination, the way Shopify does. add_to_cart
     * reads variants[0], so this has to leave exactly the variant the
     * customer picked - or none, when that combination does not exist.
     */
    const variants = mirrored.variants.filter((variant) => {
      /*
       * The option name comes from the model, so its capitalisation is not
       * ours to rely on: { size: "L" } never matched { Size: "L" }, narrowed
       * to nothing, and the customer was told we could not find the
       * combination for a garment sitting in stock.
       */
      const byName = new Map(
        Object.entries(variant.options).map(([name, value]) => [name.toLowerCase(), value]),
      );
      return Object.entries(selected).every(
        ([name, value]) => {
          const held = byName.get(name.toLowerCase());
          // "medium" is M, and half of "M/L" - see optionValueMatches.
          return held !== undefined && optionValueMatches(held, value);
        },
      );
    });
    return { ...mirrored, variants };
  }

  /*
   * A name where an id belongs. The model only has ids for what it has been
   * shown this conversation; asked to "put the VENTO POLO - NAVY/ WHITE in
   * instead" before it had seen one, it passed the title. That went to UCP as
   * an id, failed, and the customer heard "I hit a problem". An exact title
   * from the mirror is as good as an id, and anything else is a miss - never a
   * throttled network call.
   */
  if (!looksLikeId(productId)) {
    const byTitle = productByTitle(productId);
    if (!byTitle) {
      log.warn('catalogue.miss', { productId, reason: 'not an id, and no product has that title' });
      return null;
    }
    return getProductDetails(byTitle.id, selected);
  }

  /*
   * An id the loaded mirror does not have is not a product. The mirror is the
   * whole catalogue, kept current by webhooks; the ids that miss it are ones
   * the model made up - it passed 9742692698425 for a polo whose id is
   * 9713581621473, UCP threw, and the customer heard "I hit a problem" instead
   * of the model being told to look the product up. So: a miss, answered
   * locally, and the throttled endpoint is left for before the mirror lands.
   */
  if (catalogueReady()) {
    log.warn('catalogue.miss', { productId, reason: 'not in the catalogue - likely an invented id' });
    return null;
  }

  log.warn('catalogue.miss', { productId, reason: 'catalogue not loaded yet' });
  const request = {
    catalog: {
      id: productId,
      context: buyerContext(),
      ...(selected && Object.keys(selected).length
        ? { selected: Object.entries(selected).map(([name, label]) => ({ name, label })) }
        : {}),
    },
  };

  let payload: Record<string, unknown>;
  try {
    payload = await cached(`product:${JSON.stringify(request)}`, CATALOG_TTL_MS, () =>
      callUcpTool<Record<string, unknown>>('get_product', request),
    );
  } catch (err) {
    // Unknown or throttled, the honest answer is the same: we could not find it.
    log.warn('catalogue.lookup_failed', { productId, err: String(err) });
    return null;
  }

  const raw = (payload.product ?? payload) as Record<string, unknown>;
  if (!raw?.id) return null;
  return toProduct(raw);
}

/** Resolves several product or variant ids in one call. */
export async function lookupProducts(ids: string[]): Promise<Product[]> {
  if (ids.length === 0) return [];
  const request = { catalog: { ids: ids.slice(0, 10), context: buyerContext() } };
  const payload = await cached(`lookup:${JSON.stringify(request)}`, CATALOG_TTL_MS, () =>
    callUcpTool<SearchPayload>('lookup_catalog', request),
  );
  return (payload.products ?? []).map(toProduct).filter((product) => product.id);
}

/* ---------------- Cart ---------------- */

interface UcpTotal {
  type?: string;
  amount?: number;
}

interface UcpCart {
  id?: string;
  currency?: string;
  line_items?: Array<Record<string, unknown>>;
  totals?: UcpTotal[];
  continue_url?: string;
}

function toCartLine(raw: Record<string, unknown>, currency: string): CartLine {
  const item = (raw.item ?? {}) as Record<string, unknown>;
  const quantity = Number(raw.quantity ?? 1);
  const unitPrice = readMoney(item.price, currency);
  const lineTotal = (raw.totals as UcpTotal[] | undefined)?.find((total) => total.type === 'total');

  return {
    lineId: String(raw.id ?? ''),
    // UCP identifies a line by its variant; the product id is not carried here.
    productId: '',
    variantId: String(item.id ?? ''),
    title: typeof item.title === 'string' ? item.title : '',
    variantTitle: '',
    imageUrl: typeof item.image_url === 'string' ? item.image_url : null,
    quantity,
    unitPrice,
    lineTotal:
      lineTotal?.amount !== undefined
        ? readMoney(lineTotal.amount, currency)
        : addMoney(Array.from({ length: quantity }, () => unitPrice), currency),
  };
}

function toCart(raw: UcpCart): Cart {
  const currency = raw.currency ?? DEFAULT_CURRENCY;
  const lines = (raw.line_items ?? []).map((line) => toCartLine(line, currency));
  const subtotal =
    raw.totals?.find((total) => total.type === 'subtotal') ?? raw.totals?.find((total) => total.type === 'total');

  return {
    id: String(raw.id ?? ''),
    // UCP calls it continue_url: where the buyer picks the cart up in Shopify.
    checkoutUrl: raw.continue_url ?? null,
    lines,
    subtotal:
      subtotal?.amount !== undefined
        ? readMoney(subtotal.amount, currency)
        : addMoney(
            lines.map((line) => line.lineTotal),
            currency,
          ),
    totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}

export interface CartLineInput {
  variantId: string;
  quantity: number;
}

/*
 * The basket is the one thing that cannot be mirrored or cached - it has to be
 * live and it is per customer. So it goes over the Storefront API, which
 * Shopify does not rate-limit for buyer traffic, whenever a token is set.
 * The UCP path stays as a fallback, but it will not survive real traffic.
 */
export async function getCart(cartId: string): Promise<Cart> {
  if (storefrontCart.storefrontCartEnabled()) return storefrontCart.getCart(cartId);
  const payload = await callUcpTool<UcpCart>('get_cart', { id: cartId });
  return toCart(payload);
}

export async function createCart(lines: CartLineInput[]): Promise<Cart> {
  const payload = await callUcpTool<UcpCart>('create_cart', {
    cart: {
      line_items: lines.map((line) => ({ item: { id: line.variantId }, quantity: line.quantity })),
      context: buyerContext(),
    },
  });
  return toCart(payload);
}

/**
 * Replaces the cart's lines with exactly what is passed.
 *
 * This is how UCP behaves - sending one line drops the rest - which is why
 * every caller here goes through addToCart / setLineQuantity rather than
 * calling this directly. Quantity 0 removes a line.
 */
async function replaceCartLines(cartId: string, lines: CartLineInput[]): Promise<Cart> {
  // Buying something can take the last one, so cached availability is stale.
  clearCatalogCache();
  const payload = await callUcpTool<UcpCart>('update_cart', {
    id: cartId,
    cart: {
      line_items: lines.map((line) => ({ item: { id: line.variantId }, quantity: line.quantity })),
      context: buyerContext(),
    },
  });
  return toCart(payload);
}

function linesOf(cart: Cart): CartLineInput[] {
  return cart.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity }));
}

/** Adds to an existing cart, or starts one. Read, merge, write. */
export async function addToCart(
  cartId: string | undefined,
  variantId: string,
  quantity = 1,
): Promise<Cart> {
  if (storefrontCart.storefrontCartEnabled()) {
    clearCatalogCache();
    return storefrontCart.addToCart(cartId, variantId, quantity);
  }

  if (!cartId) return createCart([{ variantId, quantity }]);

  const current = await getCart(cartId);
  const lines = linesOf(current);
  const existing = lines.find((line) => line.variantId === variantId);

  if (existing) existing.quantity += quantity;
  else lines.push({ variantId, quantity });

  return replaceCartLines(cartId, lines);
}

/** Sets a line to an exact quantity. 0 removes it. */
export async function setLineQuantity(cartId: string, lineId: string, quantity: number): Promise<Cart> {
  if (storefrontCart.storefrontCartEnabled()) {
    return storefrontCart.setLineQuantity(cartId, lineId, quantity);
  }

  const current = await getCart(cartId);
  const lines = current.lines.map((line) => ({
    variantId: line.variantId,
    quantity: line.lineId === lineId ? quantity : line.quantity,
  }));
  return replaceCartLines(cartId, lines);
}
