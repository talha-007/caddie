/**
 * Customer-readiness certification harness - a developer tool, never part of
 * the running server.
 *
 * Boots the real app (createApp) on its own port with the live catalogue,
 * deals, best sellers and semantic index, and records what happens per
 * request: the model's tool calls and arguments, the tool results (FACTS) it
 * was given, and the server's diagnostics. Adds read-only inspection routes
 * (/__trace, /__facts, /__state, /__commerce ...) that run.mjs reads - they
 * exist only in this process.
 *
 * Needs the same .env as the dev server (Shopify store, Admin and Storefront
 * tokens, OpenAI key). Nothing here holds a credential. See README.md.
 */
if (process.env.NODE_ENV === 'production') {
  // It opens sessions without tokens and resets rate limits: never against production.
  process.stderr.write('The certification harness refuses to run with NODE_ENV=production.\n');
  process.exit(1);
}
process.env.REDIS_URL = '';
process.env.SEMANTIC_INDEX = process.env.SEMANTIC_INDEX ?? 'on';
// This process only: run.mjs plays the widget without session tokens (Phase 2.1). Ignored in production.
process.env.CADDIE_DEV_OPEN_SESSIONS = '1';

const PORT = Number(process.env.CERT_PORT ?? 8899);
const S = new URL('../../src', import.meta.url).href;
type Entry = Record<string, unknown>;
const trace: Entry[] = [];

// Tool calls and tool results, read off the OpenAI traffic.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? '');
  if (url.includes('api.openai.com/v1/chat/completions') && init?.body) {
    try {
      const body = JSON.parse(String(init.body));
      const msgs = body.messages ?? [];
      // Tool results sent back this step (the FACTS the model reads).
      for (let i = msgs.length - 1; i >= 0 && msgs[i].role === 'tool'; i--) {
        trace.push({ kind: 'tool_result', content: String(msgs[i].content).slice(0, 4000) });
      }
      const last = msgs[msgs.length - 1];
      if (last?.role === 'system' && /Rewrite|look it up|Nothing has changed|deal|catalogue check/i.test(String(last.content))) {
        trace.push({ kind: 'nudge', content: String(last.content).slice(0, 300) });
      }
    } catch {}
    const started = performance.now();
    const res = await realFetch(input, init);
    const clone = res.clone();
    try {
      const json: any = await clone.json();
      const message = json.choices?.[0]?.message;
      for (const call of message?.tool_calls ?? []) {
        trace.push({ kind: 'tool_call', name: call.function?.name, args: call.function?.arguments, ms: Math.round(performance.now() - started) });
      }
      if (message?.content && !message?.tool_calls?.length) trace.push({ kind: 'model_text', content: message.content });
    } catch {}
    return res;
  }
  return realFetch(input, init);
}) as typeof fetch;

// Server diagnostics from the JSON logger.
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const line = String(args[0] ?? '');
    if (/"msg":"(search.|focus.|shopper.|identity.|gateway.|voice\.|reply\.|cart\.|pack\.|openai\.turn|guard\.|shopify\.)/.test(line)) {
      try {
        const parsed = JSON.parse(line);
        trace.push({ kind: 'log', msg: parsed.msg, meta: parsed.meta });
      } catch {}
    }
    if (!/"level":"(debug|info)"/.test(line)) original(...args);
  };
}

const express = (await import('express')).default;
const { syncCatalogue } = await import(`${S}/catalog/sync.ts`);
const { loadBestSellers } = await import(`${S}/catalog/bestSellers.ts`);
const { loadDeals } = await import(`${S}/catalog/bundles.ts`);
const { syncSemanticIndex } = await import(`${S}/catalog/semantic.ts`);
const { createApp } = await import(`${S}/index.ts`);

const t0 = Date.now();
await syncCatalogue();
await loadDeals().catch(() => 0);
await loadBestSellers().catch(() => 0);
const semantic = await syncSemanticIndex();
process.stdout.write(`READY catalogue+semantic in ${((Date.now() - t0) / 1000).toFixed(0)}s semantic=${semantic.status} ${semantic.indexed}\n`);

const outer = express();
outer.get('/__trace', (_req, res) => {
  res.json(trace.splice(0, trace.length));
});
// Direct tool probe: the search as the model would call it, no model involved.
const { runTool } = await import(`${S}/tools/index.ts`);
const { sessions } = await import(`${S}/session/store.ts`);
const { attributesOf } = await import(`${S}/catalog/attributes.ts`);
const { categoriesOf } = await import(`${S}/catalog/constraints.ts`);
const { rangeOf } = await import(`${S}/catalog/audience.ts`);
outer.post('/__search', express.json(), async (req, res) => {
  const { args, utterance, sessionId, shopper } = req.body;
  const session = await sessions.getOrCreate(sessionId ?? `probe-${Math.random()}`);
  if (shopper) { const { rememberShopper } = await import(`${S}/shopper/remember.ts`); await rememberShopper(session.id, shopper, 'customer-words'); }
  const result = await runTool('search_products', args, { session, utterance });
  const products = result.attachment?.kind === 'products' ? result.attachment.products : [];
  const again = await sessions.getOrCreate(session.id);
  res.json({
    profileAfter: again.shopper,
    speech: result.speech,
    facts: result.facts,
    shown: products.map((p: any) => ({ title: p.title, price: p.price.amount, variants: p.variants.map((v: any) => ({ o: v.options, a: v.available, p: v.price.amount })), fit: attributesOf(p).fit, type: p.productType, range: rangeOf(p), kinds: [...categoriesOf(p)], features: attributesOf(p).features })),
  });
});
outer.get('/__variant', async (req, res) => {
  const { productById } = await import(`${S}/catalog/sync.ts`);
  const product = productById(String(req.query.product));
  const variant = product?.variants.find((v: any) => v.id.endsWith('/' + String(req.query.variant)));
  res.json({ title: product?.title, options: variant?.options, available: variant?.available, price: variant?.price?.amount });
});
outer.get('/__variantOwner', async (req, res) => {
  const { allProducts } = await import(`${S}/catalog/sync.ts`);
  const wanted = String(req.query.variant);
  for (const product of allProducts()) {
    const variant = product.variants.find((v: any) => v.id.endsWith('/' + wanted));
    if (variant) return res.json({ productId: product.id, variantId: variant.id, title: product.title, options: variant.options, available: variant.available, price: variant.price.amount });
  }
  res.json({});
});
outer.get('/__session', async (req, res) => {
  const session = await sessions.getOrCreate(String(req.query.id));
  const p = session.shopper ?? {};
  res.json({ colours: p.colours, avoid: p.avoidColours, usualSize: p.usualSize, fit: p.fit, budget: p.budget, focus: session.focusProductId, active: session.activeShoppingContext, lastLead: session.lastLead, basket: session.basket?.map((l: any) => `${l.title} ${l.variantTitle} x${l.quantity}`) });
});
outer.get('/__facts', async (req, res) => {
  const { trustedShopperFacts, currentShoppingIntent } = await import(`${S}/shopper/facts.ts`);
  const session = await sessions.getOrCreate(String(req.query.id));
  const { sources, ...facts } = trustedShopperFacts(session);
  const f: any = session.activeShoppingContext; res.json({ durable: facts, sources, current: currentShoppingIntent(session), focus: f && { kinds: f.kinds, range: f.range, product: f.design ?? f.productId, colours: f.colours, source: f.source, mission: f.mission, missionTurn: f.missionTurn, pack: f.pack }, packChoices: session.packChoices, pending: session.pendingAction && { products: session.pendingAction.productIds.length, awaiting: session.pendingAction.awaiting, mission: session.pendingAction.mission }, deprecated: Object.fromEntries(['focusProductId','cardFocus','packInFocus','lastSearch'].filter((k) => k in session).map((k) => [k, (session as any)[k]])), recommendation: session.sizeRecommendation && { size: session.sizeRecommendation.size, scale: session.sizeRecommendation.scale, basis: session.sizeRecommendation.basis }, rawShopperUsual: session.shopper?.usualSize, mirrors: { sizeProfileUsual: session.sizeProfile.usualSize, audience: session.preferences.audience, colour: session.preferences.colour, budget: session.preferences.budgetAmount }, basket: session.basket?.map((l: any) => `${l.title} ${l.variantTitle} x${l.quantity}`) });
});
outer.get('/__commerce', async (req, res) => {
  const c = await import(`${S}/catalog/commerce.ts`);
  const { allProducts } = await import(`${S}/catalog/sync.ts`);
  const { priceRange } = await import(`${S}/recommend/pricing.ts`);
  const wanted = String(req.query.title).toUpperCase();
  const product = allProducts().find((p: any) => p.title.toUpperCase() === wanted) ?? allProducts().find((p: any) => p.title.toUpperCase().includes(wanted));
  if (!product) return res.json({ missing: wanted });
  const a = c.commerceAttributes(product);
  res.json({ title: product.title, kind: c.primaryKind(product), range: c.productRange(product), sizes: c.sizeScale(product).dimensions.map((d: any) => `${d.option}:${d.scale}[${d.values.join(',')}]`), oneSize: c.sizeScale(product).oneSize, inStock: c.availableSizes(product), features: a.features, denied: a.denied, fit: a.fit ?? null, price: priceRange(product) });
});
outer.get('/__soldout', async (_req, res) => {
  const c = await import(`${S}/catalog/commerce.ts`);
  const { allProducts } = await import(`${S}/catalog/sync.ts`);
  for (const product of allProducts()) {
    if (c.primaryKind(product) !== 'polo' || c.productRange(product) !== 'men' || !c.isBuyable(product)) continue;
    const dim = c.sizeScale(product).dimensions.find((d: any) => d.scale === 'letter');
    if (!dim) continue;
    const out = dim.values.find((v: string) => c.supportsSize(product, v) === 'sold-out');
    if (out) return res.json({ title: product.title, size: out });
  }
  res.json({});
});
outer.get('/__deals', async (_req, res) => {
  const { allDeals } = await import(`${S}/catalog/bundles.ts`);
  res.json(allDeals().map((d: any) => ({ handle: d.handle, title: d.title, range: d.range, price: d.prices?.GBP, steps: d.steps.length, format: d.format ?? null })));
});
outer.get('/__state', async (req, res) => {
  const session: any = await sessions.getOrCreate(String(req.query.id));
  const f = session.activeShoppingContext;
  res.json({ focus: f && { kinds: f.kinds, range: f.range, product: f.design ?? f.productId, colours: f.colours, mission: f.mission, pack: f.pack, constraints: f.constraints }, pending: session.pendingAction ?? null, packChoices: session.packChoices ?? null, basket: session.basket ?? [], lastAdded: session.lastAdded ?? null, sizeRecommendation: session.sizeRecommendation ?? null, shopper: session.shopper ?? null, measurements: session.sizeProfile });
});
// run.mjs sends hundreds of turns from one address: the per-address limits are reset between turns, in this process only.
outer.post('/__resetLimits', async (_req, res) => {
  const { resetLimits } = await import(`${S}/lib/rateLimit.ts`);
  resetLimits();
  res.json({ ok: true });
});
outer.post('/__verify', express.json(), async (req, res) => {
  const { verifyReply } = await import(`${S}/ai/verify.ts`);
  const { allProducts } = await import(`${S}/catalog/sync.ts`);
  const { reply, titles, evidence } = req.body;
  const products = allProducts().filter((p: any) => titles.includes(p.title));
  res.json({ found: products.map((p: any) => `${p.title} [${p.productType}]`), violations: verifyReply(reply, evidence ?? titles.join(String.fromCharCode(10)), { kind: 'products', products }) });
});
outer.use(createApp());
outer.listen(PORT, () => process.stdout.write(`LISTENING ${PORT}\n`));
