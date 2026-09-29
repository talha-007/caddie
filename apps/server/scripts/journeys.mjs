/**
 * Twelve customer journeys, spoken the way real shoppers speak (phrasing from
 * the admin log), run end to end against a Caddie server with the widget's
 * part - carrying out and confirming basket operations - played here.
 *
 *   node scripts/journeys.mjs http://localhost:8787
 *
 * Each journey has a plain definition of done. The scorecard says which
 * reached it, how many questions the customer was asked, whether the same
 * question came twice, and what the basket ended up holding. Read the
 * transcripts as well as the score: a "done" journey with a silly question in
 * it is still a poor one. Uses the dev tool route to look products up for the
 * seeded basket and page context, so it runs against a development server.
 */
const BASE = process.argv[2] ?? process.env.BASE ?? 'http://localhost:8787';

async function claim() {
  const id = crypto.randomUUID();
  const claimed = await fetch(`${BASE}/api/session/${id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
  return { id, headers: { 'Content-Type': 'application/json', 'x-caddie-cart': 'theme', 'x-caddie-widget': 'cart-ops/1', 'x-caddie-session-token': claimed.sessionToken ?? '' } };
}

async function productByName(name) {
  const s = await claim();
  const r = await fetch(`${BASE}/api/tools/search_products`, { method: 'POST', headers: s.headers, body: JSON.stringify({ sessionId: s.id, args: { productName: name, limit: 1 } }) }).then((x) => x.json()).catch(() => null);
  return r?.attachment?.products?.[0] ?? null;
}

const results = [];
async function journey(name, done, turns, opts = {}) {
  const s = await claim();
  let basket = opts.basket ? [...opts.basket] : [];
  await fetch(`${BASE}/api/session/${s.id}/basket`, { method: 'POST', headers: s.headers, body: JSON.stringify({ cartToken: 'journeys', lines: basket }) });
  const log = [];
  let questions = 0, repeats = 0, adds = 0, packs = 0, removals = 0, cardsShown = 0;
  const seen = new Set();
  for (const text of turns) {
    const body = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: s.headers, body: JSON.stringify({ sessionId: s.id, text, ...(opts.context ? { context: opts.context } : {}), basket: { cartToken: 'journeys', lines: basket } }) }).then((r) => r.json());
    const reply = String(body.message?.text ?? body.detail ?? body.error ?? '');
    const qs = reply.split(/(?<=\?)/).filter((part) => part.includes('?')).map((part) => part.trim().toLowerCase().replace(/[^a-z ]/g, '').slice(-60));
    questions += qs.length;
    for (const q of qs) { if (seen.has(q)) repeats += 1; seen.add(q); }
    const att = body.message?.attachment;
    if (att?.products?.length || att?.kind === 'pack' || att?.kind === 'outfit') cardsShown += 1;
    const actions = body.message?.actions ?? [];
    const before = { cartToken: 'journeys', lines: basket };
    for (const a of actions) {
      if (a.type === 'add') { adds += 1; for (const l of a.lines) basket = [...basket, { key: `k${basket.length + 1}`, productId: a.productId ?? 'gid://shopify/Product/0', variantId: `gid://shopify/ProductVariant/${l.variantId}`, title: a.title ?? 'item', variantTitle: '', quantity: l.quantity }]; }
      if (a.type === 'change') { removals += a.quantity === 0 ? 1 : 0; basket = basket.map((l) => (l.key === a.lineKey ? { ...l, quantity: a.quantity } : l)).filter((l) => l.quantity > 0); }
      if (a.type === 'add-bundle') { packs += 1; for (const p of a.pieces) basket = [...basket, { key: `k${basket.length + 1}`, productId: p.productId ?? 'gid://shopify/Product/0', variantId: `gid://shopify/ProductVariant/${p.variantId}`, title: p.title ?? 'piece', variantTitle: '', quantity: 1, bundle: a.bundleId ?? 'b', bundleName: a.handle ?? 'pack' }]; }
    }
    for (const opId of [...new Set(actions.map((a) => a.operationId).filter(Boolean))]) {
      await fetch(`${BASE}/api/session/${s.id}/cart-outcome`, { method: 'POST', headers: s.headers, body: JSON.stringify({ operationId: opId, status: 'applied', before, after: { cartToken: 'journeys', lines: basket }, evidence: 'ajax-cart-read' }) });
    }
    if (actions.some((a) => a.type === 'add-bundle')) await fetch(`${BASE}/api/session/${s.id}/basket`, { method: 'POST', headers: s.headers, body: JSON.stringify({ cartToken: 'journeys', lines: basket }) });
    log.push({ text, reply, cards: att?.products ? att.products.slice(0, 4).map((p) => p.title).join(' | ') : att?.kind ?? '-', actions: actions.map((a) => a.type).join(',') });
  }
  const finished = done({ adds, packs, removals, basket, log });
  results.push({ name, finished, turns: turns.length, questions, repeats, adds, packs, removals, cardsShown });
  console.log(`\n=== ${name}  ${finished ? 'DONE' : 'NOT DONE'}  questions=${questions} repeats=${repeats} adds=${adds} packs=${packs} removals=${removals}`);
  for (const l of log) console.log(`> ${l.text}\n  cards: ${l.cards}${l.actions ? ` actions: ${l.actions}` : ''}\n  CADDIE: ${l.reply.replace(/\s+/g, ' ').slice(0, 260)}`);
}

const elite = await productByName('Elite Polo');
const jacket = await productByName('Caddy Cloud Jacket');
const line = (key, product, variantTitle) => ({ key, productId: product?.id ?? 'gid://shopify/Product/0', variantId: product?.variants?.[0]?.id ?? 'gid://shopify/ProductVariant/0', title: product?.title ?? key, variantTitle, quantity: 1 });

await journey('rain-jacket-weekend', (r) => r.adds >= 1, ['hi, I need a rain jacket for this weekend, its going to pour', "I'm a medium", 'ok add the first one']);
await journey('size-then-polos', (r) => r.adds >= 1, ["what size am I? I'm 5 foot 10 and about 80 kilos", 'ok show me polos in that size', 'add the first one please']);
await journey('pack-cold-wet', (r) => r.packs >= 1 || r.adds >= 1, ['I play in cold wet weather most of the year, what pack do you recommend', "I'm a large, 34 waist, 32 leg", 'yes please, that one', 'add it']);
await journey('outfit-under-100', (r) => r.adds >= 1, ['build me an outfit under £100, mens, medium', 'swap the polo for a navy one', 'add everything']);
await journey('product-page-questions', (r) => r.adds >= 1, ['is this waterproof?', 'what colours does it come in?', 'add it in large'], { context: elite ? { pageType: 'product', productId: elite.id, productTitle: elite.title } : undefined });
await journey('basket-housekeeping', (r) => r.removals >= 1, ["what's in my basket?", 'remove the jacket', 'make the polo two'], { basket: [line('b1', elite, 'M'), line('b2', jacket, 'M')] });
await journey('compare-two-polos', (r) => r.log.some((l) => /elite|block pique/i.test(l.reply)), ['which is better for hot weather, the elite polo or the block pique polo?', 'why?']);
await journey('change-of-mind', (r) => r.adds >= 1, ['show me navy polos', 'actually make it black', 'the second one in XL please']);
await journey('scotland-october', (r) => r.log.some((l) => l.cards !== '-'), ["I'm going to Scotland in October for a golf trip, what should I wear?", 'show me the jackets then']);
await journey('no-not-that-one', (r) => r.adds >= 1, ['show me mens jackets', 'add the first one in medium', 'no not that one, the second one']);
await journey('gift-for-dad', (r) => r.adds >= 1, ["I need a gift for my dad, he's a large, likes navy, budget is about £50", 'the polo looks good, add it']);
await journey('stock-question', (r) => r.log[0] && /warrior/i.test(r.log[0].reply), ['do you have the warrior jacket in medium?', 'what about large?']);

console.log('\n\n==== SCORECARD');
console.log('journey | done | turns | questions | repeats | adds/packs/removals');
for (const r of results) console.log(`${r.name} | ${r.finished ? 'yes' : 'NO'} | ${r.turns} | ${r.questions} | ${r.repeats} | ${r.adds}/${r.packs}/${r.removals}`);
console.log(`done ${results.filter((r) => r.finished).length}/${results.length}, questions per turn ${(results.reduce((a, r) => a + r.questions, 0) / results.reduce((a, r) => a + r.turns, 0)).toFixed(2)}`);
