import type { Product, ProductOption, ProductVariant } from '@caddie/shared';
import { env } from '../env.js';
import { UpstreamError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

/**
 * A local mirror of the Druids catalogue.
 *
 * Shopify throttles the UCP catalogue endpoint hard - trip it and the reply is
 * "retry after 3253 seconds", the best part of an hour with no catalogue at
 * all. At a thousand active customers that is not a tuning problem: one outfit
 * alone fires up to eight searches, so a busy hour is thousands of calls.
 *
 * So the catalogue is pulled in full every few minutes and searched in memory.
 * Shopify sees a handful of calls an hour no matter how many customers there
 * are, searches cost nothing and return instantly, and the throttle stops
 * being something a customer can ever see.
 *
 * The trade is freshness: stock can be up to one refresh interval stale. That
 * is fine for browsing - the basket is always live, and adding to it checks
 * the variant against Shopify at the time.
 */

const PAGE_SIZE = 50;

const QUERY = `
query Catalogue($cursor: String, $query: String) {
  products(first: ${PAGE_SIZE}, after: $cursor, query: $query) {
    nodes {
      id
      title
      handle
      description
      productType
      vendor
      tags
      onlineStoreUrl
      featuredMedia { ... on MediaImage { image { url } } }
      options { name optionValues { name } }
      priceRangeV2 { minVariantPrice { amount currencyCode } }
      variants(first: 100) {
        nodes {
          id
          title
          price
          availableForSale
          selectedOptions { name value }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface AdminVariant {
  id: string;
  title: string;
  price: string;
  availableForSale: boolean;
  selectedOptions: Array<{ name: string; value: string }>;
}

interface AdminProduct {
  id: string;
  title: string;
  handle: string;
  description: string | null;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  onlineStoreUrl: string | null;
  featuredMedia?: { image?: { url?: string } } | null;
  options: Array<{ name: string; optionValues: Array<{ name: string }> }>;
  priceRangeV2?: { minVariantPrice?: { amount?: string; currencyCode?: string } };
  variants: { nodes: AdminVariant[] };
}

function toVariant(raw: AdminVariant, currency: string): ProductVariant {
  const options: Record<string, string> = {};
  for (const option of raw.selectedOptions) options[option.name] = option.value;

  return {
    id: raw.id,
    title: raw.title,
    available: raw.availableForSale,
    price: { amount: Number(raw.price), currency },
    options,
  };
}

function toProduct(raw: AdminProduct): Product {
  const currency = raw.priceRangeV2?.minVariantPrice?.currencyCode ?? 'GBP';
  const options: ProductOption[] = raw.options
    .map((option) => ({ name: option.name, values: option.optionValues.map((value) => value.name) }))
    .filter((option) => option.name && option.values.length);

  return {
    id: raw.id,
    title: raw.title,
    url: raw.onlineStoreUrl ?? '',
    imageUrl: raw.featuredMedia?.image?.url ?? null,
    vendor: raw.vendor,
    productType: raw.productType,
    tags: raw.tags,
    price: { amount: Number(raw.priceRangeV2?.minVariantPrice?.amount ?? 0), currency },
    options,
    variants: raw.variants.nodes.map((variant) => toVariant(variant, currency)),
    description: raw.description,
  };
}

async function admin<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://${env.shopify.storeDomain}/admin/api/2025-07/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': env.shopify.adminToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new UpstreamError(`Shopify Admin API responded ${res.status}`, await res.text().catch(() => ''));
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new UpstreamError('Shopify Admin API error', body.errors);
  if (!body.data) throw new UpstreamError('Shopify Admin API returned no data');
  return body.data;
}

interface CataloguePage {
  products: {
    nodes: AdminProduct[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/* ---------------- The mirror ---------------- */

let products: Product[] = [];
let byId = new Map<string, Product>();
let lastSyncedAt = 0;
let syncing: Promise<void> | null = null;

export interface CatalogueState {
  count: number;
  lastSyncedAt: number;
  ageSeconds: number;
}

export function catalogueState(): CatalogueState {
  return {
    count: products.length,
    lastSyncedAt,
    ageSeconds: lastSyncedAt ? Math.round((Date.now() - lastSyncedAt) / 1000) : -1,
  };
}

export function allProducts(): Product[] {
  return products;
}

export function productById(id: string): Product | null {
  return byId.get(id) ?? null;
}

export function catalogueReady(): boolean {
  return products.length > 0;
}

/** Pulls the whole catalogue. Paginated, so a large range is one call per 50. */
async function pull(): Promise<Product[]> {
  const startedAt = Date.now();
  // Only the brand's own kit, when the store holds anything else.
  const filter = env.shopify.brandTag ? `tag:${env.shopify.brandTag} AND status:active` : 'status:active';

  const collected: Product[] = [];
  let cursor: string | null = null;

  // Bounded so a pagination bug cannot loop forever against a live API.
  for (let page = 0; page < 50; page += 1) {
    const data: CataloguePage = await admin<CataloguePage>(QUERY, { cursor, query: filter });

    collected.push(...data.products.nodes.map(toProduct));
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }

  log.info('catalogue.pulled', { products: collected.length, ms: Date.now() - startedAt });
  return collected;
}

/** Refreshes the mirror. Concurrent callers share one in-flight pull. */
export async function syncCatalogue(): Promise<CatalogueState> {
  if (syncing) {
    await syncing;
    return catalogueState();
  }

  syncing = (async () => {
    try {
      const fresh = await pull();
      // Only swap on success: a stale catalogue beats an empty one.
      if (fresh.length > 0) {
        products = fresh;
        byId = new Map(fresh.map((product) => [product.id, product]));
        lastSyncedAt = Date.now();
      } else {
        log.warn('catalogue.empty', { kept: products.length });
      }
    } finally {
      syncing = null;
    }
  })();

  await syncing;
  return catalogueState();
}

let timer: NodeJS.Timeout | null = null;

/**
 * Keeps the mirror warm.
 *
 * A failed refresh is logged and the previous catalogue kept, because serving
 * slightly stale products beats serving none.
 */
export function startCatalogueSync(intervalMs = env.shopify.catalogueRefreshMs): void {
  const refresh = () => {
    syncCatalogue().catch((err) => log.error('catalogue.sync_failed', { err: String(err) }));
  };

  refresh();
  timer = setInterval(refresh, intervalMs);
  timer.unref?.();
}

export function stopCatalogueSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam. */
export function setCatalogueForTests(items: Product[]): void {
  products = items;
  byId = new Map(items.map((product) => [product.id, product]));
  lastSyncedAt = Date.now();
}
