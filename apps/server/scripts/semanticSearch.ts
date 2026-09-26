/**
 * Semantic search, tried by hand against the live catalogue. Developer only:
 * nothing customer-facing reads the semantic index yet.
 *
 *   npm run semantic-search --workspace=@caddie/server -- "something lightweight for hot weather golf"
 *
 * With no query it runs a standing set. Read-only against Shopify; it does
 * call the embeddings API - about a million tokens for the catalogue at
 * text-embedding-3-small, a few pence - and prints the top ten per query with
 * their similarity, so the results can be judged by eye, not by the number.
 */
import { syncCatalogue } from '../src/catalog/sync.js';
import { embeddingProvider } from '../src/catalog/embeddings.js';
import { normaliseVector, scan, semanticSearch, semanticState, syncSemanticIndex } from '../src/catalog/semantic.js';
import { semanticQueryText } from '../src/catalog/semanticText.js';
import { FEATURE_LABEL, attributesOf } from '../src/catalog/attributes.js';
import { categoriesOf } from '../src/catalog/constraints.js';
import { rangeOf } from '../src/catalog/audience.js';

const DEFAULT_QUERIES = [
  'rain protection for golf',
  'stretchy trousers for playing golf',
  'something warm but not bulky for a cold morning',
  'smart golf outfit for a summer trip',
  'something lightweight for hot weather golf',
  'a sleeveless warm outer layer',
];

const queries = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_QUERIES;

const provider = embeddingProvider();
if (!provider) {
  console.error('No embedding provider: set OPENAI_API_KEY.');
  process.exit(1);
}

const pulledAt = Date.now();
const catalogue = await syncCatalogue();
console.log(`catalogue: ${catalogue.count} products in ${((Date.now() - pulledAt) / 1000).toFixed(1)}s`);

const builtAt = Date.now();
const state = await syncSemanticIndex();
const dims = Number(provider.name.split('/')[1]) || 0;
console.log(
  `index: ${state.status}, ${state.indexed}/${state.catalogue} products, ${provider.name}, built in ${((Date.now() - builtAt) / 1000).toFixed(1)}s, ` +
    `vectors ~${((state.indexed * dims * 4) / 1024 / 1024).toFixed(1)}MB${state.lastError ? `, last error: ${state.lastError}` : ''}`,
);

for (const query of queries) {
  const startedAt = performance.now();
  const outcome = await semanticSearch(query, 10);
  const total = performance.now() - startedAt;
  // The same query again: served from the query cache.
  const againAt = performance.now();
  await semanticSearch(query, 10);
  const cachedMs = performance.now() - againAt;
  console.log(`\n"${query}"\n  embedded as: ${semanticQueryText(query)}`);
  if (!outcome.available) {
    console.log(`  unavailable: ${outcome.reason}`);
    continue;
  }
  // The in-memory scan on its own, with a vector of the right size.
  const probe = normaliseVector(Array.from({ length: dims }, (_, i) => Math.sin(i + 1)));
  const scanStarted = performance.now();
  scan(probe, 10);
  const scanMs = performance.now() - scanStarted;
  console.log(`  cache miss ${total.toFixed(0)}ms, cache hit ${cachedMs.toFixed(0)}ms, scan alone ${scanMs.toFixed(1)}ms`);
  outcome.results.forEach((result, i) => {
    const { features } = attributesOf(result.product);
    console.log(
      `  ${String(i + 1).padStart(2)}. ${result.product.title}  [${result.product.productType} | ${[...categoriesOf(result.product)].join('/')} | ${rangeOf(result.product)}]  ` +
        `${features.map((feature) => FEATURE_LABEL[feature]).join(', ') || '-'}  ${result.similarity.toFixed(3)}`,
    );
  });
}
console.log(`\nfinal state: ${JSON.stringify(semanticState())}`);
process.exit(0);
