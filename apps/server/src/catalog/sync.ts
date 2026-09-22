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
 * So the catalogue is held in memory and searched locally. Keeping it current
 * is three things, cheapest first:
 *
 *  1. **Webhooks** do the real work. Shopify tells us the moment a product or
 *     a stock level changes, so the mirror is current within seconds and costs
 *     nothing to keep that way. On a busy store that matters: stock moves
 *     constantly, and any fixed interval is either stale or wasteful.
 *  2. **A delta pull** every minute asks only for what changed since the last
 *     one - nine cost points against seventy-two for a full page. It covers
 *     webhooks missed while we were restarting.
 *  3. **A full reconcile** every half hour, to catch anything the other two
 *     dropped and to notice deletions.
 *
 * Storefront traffic does not touch any of this. Shoppers browsing the store
 * consume the Storefront API's quota, not the Admin API's, so how busy the
 * shop is has no bearing on the sync.
 *
 * The trade is freshness: between a change and the webhook landing, the mirror
 * is briefly behind. The basket is always live, and adding to it checks the
 * variant against Shopify at the time, so the worst case is offering something
 * that sold out moments ago.
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
          inventoryItem { id }
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
  inventoryItem?: { id?: string } | null;
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
    ...(raw.inventoryItem?.id ? { inventoryItemId: raw.inventoryItem.id } : {}),
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
/** inventoryItemId -> productId, so an inventory webhook can find its product. */
let byInventoryItem = new Map<string, string>();
let lastSyncedAt = 0;
let lastDeltaAt = 0;
let syncing: Promise<void> | null = null;

/**
 * Bumped on every change. The search index watches this so it rebuilds when
 * the catalogue moves and not on every query.
 */
let version = 0;

export function catalogueVersion(): number {
  return version;
}

/** Rebuilt whenever the mirror changes; a few hundred products makes it cheap. */
function rebuildInventoryIndex(): void {
  byInventoryItem = new Map();
  for (const product of products) {
    for (const variant of product.variants) {
      if (variant.inventoryItemId) byInventoryItem.set(variant.inventoryItemId, product.id);
    }
  }
}

export function productForInventoryItem(inventoryItemId: string): string | null {
  return byInventoryItem.get(inventoryItemId) ?? null;
}

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

/**
 * Asks only for products touched since a given moment.
 *
 * Nine cost points against seventy-two for a full page, so it can run often.
 */
async function pullChangedSince(since: Date): Promise<Product[]> {
  const brand = env.shopify.brandTag ? `tag:${env.shopify.brandTag} AND ` : '';
  const filter = `${brand}status:active AND updated_at:>'${since.toISOString()}'`;

  const collected: Product[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const data: CataloguePage = await admin<CataloguePage>(QUERY, { cursor, query: filter });
    collected.push(...data.products.nodes.map(toProduct));
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return collected;
}

/** Folds changed products into the mirror without disturbing the rest. */
export function applyChanges(changed: Product[]): number {
  if (changed.length === 0) return 0;

  for (const product of changed) {
    const index = products.findIndex((existing) => existing.id === product.id);
    if (index === -1) products.push(product);
    else products[index] = product;
    byId.set(product.id, product);
  }

  rebuildInventoryIndex();
  lastSyncedAt = Date.now();
  version += 1;
  log.info('catalogue.patched', { products: changed.length });
  return changed.length;
}

/** Drops a product that has been deleted or unpublished. */
export function removeProduct(productId: string): boolean {
  const index = products.findIndex((product) => product.id === productId);
  if (index === -1) return false;
  products.splice(index, 1);
  byId.delete(productId);
  rebuildInventoryIndex();
  version += 1;
  log.info('catalogue.removed', { productId });
  return true;
}

/** Re-reads one product, after a webhook says it changed. */
export async function refreshProduct(productId: string): Promise<boolean> {
  const data = await admin<CataloguePage>(QUERY, { cursor: null, query: `id:${productId.split('/').pop()}` });
  const fresh = data.products.nodes.map(toProduct);
  if (fresh.length === 0) return removeProduct(productId);
  applyChanges(fresh);
  return true;
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
        rebuildInventoryIndex();
        lastSyncedAt = Date.now();
        lastDeltaAt = Date.now();
        version += 1;
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

let deltaTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;

/** Catches up on anything missed since the last delta, or while we were down. */
export async function syncDelta(): Promise<number> {
  if (!lastDeltaAt) {
    await syncCatalogue();
    return products.length;
  }

  // A minute of overlap: a product saved during the last pull can carry a
  // timestamp from just before it.
  const changed = await pullChangedSince(new Date(lastDeltaAt - 60_000));
  lastDeltaAt = Date.now();
  return applyChanges(changed);
}

/**
 * Keeps the mirror current.
 *
 * Webhooks do the real work; these two are the safety nets. A failed refresh
 * is logged and the previous catalogue kept, because serving slightly stale
 * products beats serving none.
 */
export function startCatalogueSync(
  deltaMs = env.shopify.catalogueDeltaMs,
  reconcileMs = env.shopify.catalogueReconcileMs,
): void {
  // The first pull is done by the caller before taking traffic; these are the
  // safety nets behind the webhooks.
  deltaTimer = setInterval(() => {
    syncDelta().catch((err) => log.warn('catalogue.delta_failed', { err: String(err) }));
  }, deltaMs);
  deltaTimer.unref?.();

  reconcileTimer = setInterval(() => {
    syncCatalogue().catch((err) => log.error('catalogue.sync_failed', { err: String(err) }));
  }, reconcileMs);
  reconcileTimer.unref?.();
}

export function stopCatalogueSync(): void {
  if (deltaTimer) clearInterval(deltaTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  deltaTimer = null;
  reconcileTimer = null;
}

/** Test seam. */
export function setCatalogueForTests(items: Product[]): void {
  products = items;
  byId = new Map(items.map((product) => [product.id, product]));
  rebuildInventoryIndex();
  lastSyncedAt = Date.now();
  version += 1;
}
