# Druids Personal Caddie

Voice and chat shopping assistant embedded in the Druids Shopify storefront.
Two builders, 14 days. Plan: [docs/ROADMAP.md](docs/ROADMAP.md).

The customer asks for something; the Caddie finds real products, recommends a
size, builds a pack or an outfit, and fills a real Shopify basket.

## Who owns what

| Path | Owner | |
| --- | --- | --- |
| `apps/server` | Talha | AI, Vapi, Shopify, recommendations, cart |
| `apps/widget` | Amir | The storefront widget |
| `apps/caddie-ui` | Talha | A second, plainer UI that keeps the backend unblocked |
| `packages/shared` | both | The contract. Change it here first, then tell the other person. |

**Work in your own app.** If a change on one side forces a change on the other,
say so rather than editing across the line.

## Running it

```bash
npm install
cp .env.example .env                    # SHOPIFY_STORE_DOMAIN at minimum
npm run dev:server                      # :8787
npm run dev --workspace=@caddie/ui      # :5174  (or @caddie/widget on :5173)
```

`GET /health` says which model is answering, whether voice is on, and whether
Shopify is reading our own agent profile.

**`.env` is not hot-reloaded.** `tsx watch` restarts on source changes only, so
after editing `.env`, touch a source file or restart. A setting that seems
ignored is usually this.

## The one rule

**Shopify owns product data. We own recommendations. The AI owns neither.**

Products, prices, variants, stock and the cart come from Shopify and nowhere
else. Sizes, packs and outfits are decided by our code in
`apps/server/src/recommend/`. The model runs the conversation and calls tools —
it never states a price or a product it has not just fetched.

This is enforced in three places and all three have to stay true:

1. the system prompt in `apps/server/src/ai/prompt.ts`
2. tools returning `speech` (what may be said) separately from `attachment`
   (what gets rendered) and `facts` (grounding data, never read aloud)
3. the UI rendering `attachment`, never parsing message text

Full list: [docs/RULES.md](docs/RULES.md). It is short, and every rule in it
exists because the Caddie broke it once.

## Things that cause silent bugs

**`options` are not `variants`.** `product.options` is every size on offer;
`variants` are concrete combinations. Shopify returns a *default* variant even
when the customer has chosen nothing, so a size picker built from `variants`
silently adds whichever size came back first. Build the picker from `options`;
use `variants` only for availability.

**Money is already in major units.** `{ amount: 42, currency: 'GBP' }` is
£42.00. The Shopify payloads use minor units; the conversion happens once, in
`apps/server/src/shopify/money.ts`, and nothing downstream deals in pence.

**`message.text` is for reading, `attachment` is for rendering.** Never parse a
price or a product name out of the text — it is written by a model.

**Cart updates replace rather than merge.** Shopify's `update_cart` sets the
cart's lines to exactly what you send, so sending one line deletes the rest.
Go through `addToCart` / `setLineQuantity` in `apps/server/src/shopify/catalog.ts`.

**Outfit slots can be missing.** If nothing in stock fits a slot we leave it
out rather than pad the outfit. Do not assume four pieces.

**A `null` size is a real answer**, not a failure: not enough information yet,
or socks, which Druids sizes by style. Render `reason`.

**Search does not filter by range or brand exactly.** It is semantic, so it
always returns its nearest guesses — asking for something we do not stock still
comes back full. The store also holds generic demo products, filtered out by
`SHOPIFY_BRAND_TAG`, so an empty result can be correct.

## The store

`qqfeqi-xb.myshopify.com` is a test store, priced in GBP. It holds 24 real
Druids products and 25 generic demo items. Details, and the deliberate
out-of-stock variant that exists so the unhappy path can be tested, are in
[docs/STORE.md](docs/STORE.md).

## How we talk to Shopify, and why

The UCP catalogue endpoint (`/api/ucp/mcp`) is throttled hard. Trip it and the
reply is `Too many requests, please retry after 3253 seconds` - the best part
of an hour with no catalogue at all, and no way to lift it. A day of testing
was enough to trip it. At a thousand active customers it is hopeless: one
outfit alone fires up to eight searches.

So nothing customer-facing calls it.

| What | Where | Why |
| --- | --- | --- |
| Search, product detail | **local mirror**, `src/catalog/` | Unlimited and instant. Shopify sees one pull every 5 minutes however many customers there are. |
| The catalogue pull | Admin API | A background job, not buyer traffic. Its own generous quota. |
| The basket | **Storefront API**, `src/shopify/storefrontCart.ts` | Cannot be mirrored - it is live and per customer. Shopify does not rate-limit buyer traffic here. |
| UCP | fallback only | Still wired up, still throttled. Not a path to rely on. |

`GET /health` reports the catalogue size and age, and which cart path is live.

**The mirror is the reason search is fast.** A search is a few milliseconds of
scoring in memory rather than a network round trip, and `src/catalog/search.ts`
ranks on the words a customer actually uses. When nothing matches, nothing
comes back - which is the honest answer, and better than the semantic search it
replaced, which always returned something whether we stocked it or not.

The trade is freshness: stock can be up to one refresh interval stale. Adding
to the basket still checks the variant live, so the worst case is offering
something that sold out in the last few minutes.

**Without `SHOPIFY_STOREFRONT_TOKEN` the basket falls back to UCP** and will
not survive real traffic. If the Caddie suddenly cannot find anything, check
the log for `shopify.ucp.locked_out` before assuming the code broke.

## Cost

About $3.20-$3.90 per thousand conversations on `gpt-4.1-mini`, plus $0.003 a
minute for voice transcription. `openai.turn` logs the tokens for every turn,
so this is measured rather than guessed.

**Do not shorten the system prompt to save money.** It was tried and measured:
trimming 2,900 tokens made things ~40% *more* expensive. The prompt and tool
schemas are identical on every call, so they cache at a quarter of the input
price; a longer stable prefix caches better than a shorter one. Cache hit rate
fell from ~85% to ~55% and cost rose from $2.92 to $4.11 per thousand.

What actually costs money is anything that **varies** per call - conversation
history, FACTS blocks, the on-screen context. Trim there.

Abuse and off-topic messages are screened by `src/ai/guard.ts` before the
expensive loop, on the cheapest model available, and obvious cases are caught
by local rules for nothing at all. `src/lib/rateLimit.ts` caps what one session
or address can spend.

## Checks

```bash
npm run typecheck
npm run test
npm run eval:model --workspace=@caddie/server -- <port> <model>
```

`eval:model` runs the ways the Caddie has actually misled a customer —
inventing a product, guessing a price, calling mens kit womens. Run it before
changing `OPENAI_MODEL` and on Day 11.

**UI work is checked by driving it, not by typechecking it.** Layout
regressions, images that never load and buttons below the fold do not show up
in a compiler. Open it, look at it, and measure the thing you changed.

## Style

British English in anything a customer reads. The Caddie speaks in one or two
sentences and never reads a list aloud — the products are on screen.

Comments explain why, not what. Several in this codebase record a specific
failure; leave those alone unless the failure is no longer possible.
