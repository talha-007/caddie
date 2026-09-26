import type { Product } from '@caddie/shared';
import { env } from '../env.js';
import { Semaphore } from '../lib/http.js';
import { log } from '../lib/logger.js';
import { embeddingProvider } from './embeddings.js';
import { buildProductSemanticText, semanticFingerprint, semanticQueryKey, semanticQueryText } from './semanticText.js';
import { allProducts, onCatalogueChange, productById } from './sync.js';

/**
 * Products by meaning, beside products by word.
 *
 * One vector per product, in memory next to the word index, built from the
 * product's own verified text (semanticText.ts). Word search cannot find "a
 * sleeveless warm outer layer" - no product is called that - and a vector
 * can. Nothing customer-facing reads this yet: it is built and searched here
 * so its answers can be judged before they are merged with word search.
 *
 * It is never on the critical path. The server starts, searches and sells
 * without it; the index builds in the background, a product at a time is
 * re-embedded only when its text changes, and any failure leaves word search
 * exactly as it was.
 */

interface Entry {
  fingerprint: string;
  /** Unit length, so similarity is a dot product. */
  vector: Float32Array;
}

export interface SemanticSearchResult {
  product: Product;
  /** Cosine similarity. Internal: for ranking and debugging, never shown. */
  similarity: number;
}

export type SemanticSearchOutcome =
  | { available: true; results: SemanticSearchResult[]; indexed: number; partial: boolean; cached: boolean }
  | { available: false; reason: string };

export interface SemanticState {
  status: 'off' | 'building' | 'ready' | 'partial' | 'failed';
  model: string | null;
  indexed: number;
  catalogue: number;
  lastError?: string;
  lastBuiltAt?: number;
}

const index = new Map<string, Entry>();
let status: SemanticState['status'] = 'off';
let lastError: string | undefined;
let lastBuiltAt: number | undefined;
let building: Promise<SemanticState> | null = null;
let rebuildAgain = false;

/**
 * Query vectors already worked out, by their semantic text. An embedding
 * call is most of a semantic search's time (about 300ms); the same request
 * phrased the same way should not pay it twice. Least recently used goes
 * first; nothing is kept across a restart. Product vectors never go here.
 */
const QUERY_CACHE_SIZE = 500;
const queryCache = new Map<string, Float32Array>();

/** Texts per embeddings request, and requests at once: a few dozen calls for the catalogue, never thousands. */
const BATCH = 100;
const requests = new Semaphore(2);

function normalise(values: number[]): Float32Array {
  const vector = Float32Array.from(values);
  let length = 0;
  for (const value of vector) length += value * value;
  length = Math.sqrt(length) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i]! /= length;
  return vector;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

export function semanticState(): SemanticState {
  const provider = embeddingProvider();
  return {
    status,
    model: provider?.name ?? null,
    indexed: index.size,
    catalogue: allProducts().length,
    ...(lastError ? { lastError } : {}),
    ...(lastBuiltAt ? { lastBuiltAt } : {}),
  };
}

/**
 * Brings the index in line with the catalogue: new or changed products are
 * embedded, removed ones dropped, unchanged ones kept. One run at a time; a
 * change during a run schedules one more.
 */
export async function syncSemanticIndex(): Promise<SemanticState> {
  if (building) {
    rebuildAgain = true;
    return building;
  }
  building = (async () => {
    try {
      do {
        rebuildAgain = false;
        await runSync();
      } while (rebuildAgain);
    } finally {
      building = null;
    }
    return semanticState();
  })();
  return building;
}

async function runSync(): Promise<void> {
  const provider = embeddingProvider();
  if (!provider) {
    status = 'off';
    return;
  }
  const products = allProducts();
  const live = new Set(products.map((product) => product.id));
  // Gone from the catalogue, gone from the index.
  for (const id of index.keys()) if (!live.has(id)) index.delete(id);

  const stale = products
    .map((product) => ({ product, fingerprint: semanticFingerprint(product) }))
    .filter(({ product, fingerprint }) => index.get(product.id)?.fingerprint !== fingerprint);
  // Nothing stale: every product has its current vector.
  if (stale.length === 0) {
    if (index.size) status = 'ready';
    return;
  }

  status = 'building';
  const startedAt = Date.now();
  const batches: Array<typeof stale> = [];
  for (let i = 0; i < stale.length; i += BATCH) batches.push(stale.slice(i, i + BATCH));

  let failures = 0;
  await Promise.all(
    batches.map((batch) =>
      requests.run(async () => {
        try {
          const vectors = await provider.embed(batch.map(({ product }) => buildProductSemanticText(product)));
          batch.forEach(({ product, fingerprint }, i) => {
            const vector = vectors[i];
            if (vector?.length) index.set(product.id, { fingerprint, vector: normalise(vector) });
          });
        } catch (err) {
          // A batch that fails keeps whatever vectors those products had; word search is unaffected.
          failures += 1;
          lastError = err instanceof Error ? err.message : String(err);
          log.warn('semantic.batch_failed', { products: batch.length, err: lastError });
        }
      }),
    ),
  );

  status = failures === 0 ? 'ready' : index.size ? 'partial' : 'failed';
  if (failures === 0) lastError = undefined;
  lastBuiltAt = Date.now();
  log.info('semantic.indexed', { embedded: stale.length, indexed: index.size, failedBatches: failures, ms: Date.now() - startedAt });
}

/**
 * The products whose meaning is closest to the text, over every product that
 * has a vector - a partly built index searches what it has. No rules are
 * applied here (range, size, colour): that is the search tool's job, and
 * will be when the two are merged.
 */
export async function semanticSearch(query: string, limit = 10): Promise<SemanticSearchOutcome> {
  const provider = embeddingProvider();
  if (!provider) return { available: false, reason: 'no embedding provider configured' };
  if (index.size === 0) return { available: false, reason: status === 'failed' ? `index failed: ${lastError ?? 'unknown'}` : 'index not built' };
  let queryVector: Float32Array;
  const key = semanticQueryKey(query);
  const cached = queryCache.get(key);
  if (cached) {
    // Most recently used goes to the back: the oldest is what gets dropped.
    queryCache.delete(key);
    queryCache.set(key, cached);
    queryVector = cached;
  } else {
    try {
      const [values] = await provider.embed([semanticQueryText(query)]);
      if (!values?.length) return { available: false, reason: 'empty query embedding' };
      queryVector = normalise(values);
    } catch (err) {
      return { available: false, reason: `query embedding failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    queryCache.set(key, queryVector);
    if (queryCache.size > QUERY_CACHE_SIZE) queryCache.delete(queryCache.keys().next().value!);
  }
  const results = scan(queryVector, limit);
  return { available: true, results, indexed: index.size, partial: index.size < allProducts().length, cached: !!cached };
}

/** The in-memory scan on its own, for measuring and tests. */
export function scan(queryVector: Float32Array, limit: number): SemanticSearchResult[] {
  const scored: SemanticSearchResult[] = [];
  for (const [id, entry] of index) {
    const product = productById(id);
    if (!product) continue;
    scored.push({ product, similarity: dot(queryVector, entry.vector) });
  }
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

export { normalise as normaliseVector };

/** A product's current vector, if it has one - for tests and the evaluation script. */
export function semanticEntry(productId: string): { fingerprint: string; vector: Float32Array } | undefined {
  return index.get(productId);
}

let unsubscribe: (() => void) | null = null;
let timer: NodeJS.Timeout | null = null;

/**
 * Builds the index in the background and keeps it following the catalogue.
 * Changes are gathered for a couple of seconds - a bulk edit is one run, not
 * one per product. Does nothing unless SEMANTIC_INDEX is on and a key is set.
 */
export function startSemanticIndex(opts: { force?: boolean } = {}): void {
  if (!(opts.force || env.openai.semanticIndex) || !embeddingProvider()) return;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      syncSemanticIndex().catch((err) => log.warn('semantic.sync_failed', { err: String(err) }));
    }, 2000);
    timer.unref?.();
  };
  unsubscribe?.();
  unsubscribe = onCatalogueChange(schedule);
  void syncSemanticIndex().catch((err) => log.warn('semantic.sync_failed', { err: String(err) }));
}

export function resetSemanticIndexForTests(): void {
  index.clear();
  queryCache.clear();
  status = 'off';
  lastError = undefined;
  lastBuiltAt = undefined;
  unsubscribe?.();
  unsubscribe = null;
  if (timer) clearTimeout(timer);
  timer = null;
}
