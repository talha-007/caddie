import { syncCatalogue, catalogueState, allProducts } from './src/catalog/sync.ts';
import { searchLocal } from './src/catalog/search.ts';

const t0 = Date.now();
const state = await syncCatalogue();
console.log(`synced ${state.count} products in ${Date.now() - t0}ms`);

for (const q of ['navy polo', 'shorts', 'hoodie', 'tour short navy', 'socks', 'trousers', 'jacket']) {
  const t = Date.now();
  const hits = searchLocal({ query: q, limit: 3 });
  console.log(`  "${q}" -> ${Date.now() - t}ms | ${hits.map((h) => h.title).join(' | ') || '(nothing)'}`);
}
