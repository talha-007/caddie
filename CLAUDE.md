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
| `packages/shared` | both | The contract. Change it here first, then tell the other person. |

**Work in your own app.** If a change on one side forces a change on the other,
say so rather than editing across the line.

## Running it

```bash
npm install
cp .env.example .env                    # SHOPIFY_STORE_DOMAIN at minimum
npm run dev:server                      # :8787
npm run dev --workspace=@caddie/widget  # :5173
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

**Product ids arrive in two forms.** The mirror is keyed by GID, but a theme's
`{{ product.id }}` and `ShopifyAnalytics.meta` both give a bare number, and the
model drops the prefix often enough to matter. `productById` in
`apps/server/src/catalog/sync.ts` takes either - go through it rather than
reading `byId`. A miss there falls through to throttled UCP and comes back
"product not found", which reads like a broken catalogue rather than an id.

**Money is already in major units.** `{ amount: 42, currency: 'GBP' }` is
£42.00. The Shopify payloads use minor units; the conversion happens once, in
`apps/server/src/shopify/money.ts`, and nothing downstream deals in pence.

**`message.text` is for reading, `attachment` is for rendering.** Never parse a
price or a product name out of the text — it is written by a model.

**A bundle deal is not a product.** The Ambassador Pack and the other deals are
priced at checkout by a discount (SupaEasy) that matches properties the theme's
bundle builder writes on each cart line. `buildBundleCartItems` in
`packages/shared/src/bundleCart.ts` reproduces those lines exactly, and
`test/bundleCart.test.ts` checks it against a copy of the theme's own code. If
Druids' developers change `snippets/bundle-builder-script-v4.liquid`, update both,
then check the pack price at checkout on the preview theme. Never add pack
pieces one by one, and never remove one piece alone - either loses the price.

**Cart updates replace rather than merge.** Shopify's `update_cart` sets the
cart's lines to exactly what you send, so sending one line deletes the rest.
Go through `addToCart` / `setLineQuantity` in `apps/server/src/shopify/catalog.ts`.

**Sizes come on two scales, and in words.** Tops are lettered (S-4XL), bottoms
carry waist numbers (32, 34). They are not one scale: a customer who says
"medium" has told you nothing about which trousers fit. Filtering trousers by
"M" silently dropped every pair, so an outfit arrived with nothing to wear
below the waist. Customers and the model both say "Medium" where the catalogue
says "M", and an exact string match empties the whole result. Everything that
compares a size goes through `src/recommend/sizeWords.ts`, which normalises the
word, ignores a size it cannot read rather than filtering on it, and only
applies a size to products sized on that same scale.

**Search matches literal words, so a recommendation cannot depend on the
customer's phrasing.** "A pack of basic clothing" returns nothing - no product
has "basic" in its name - and the customer hears that we have nothing in their
budget. Both `recommend_pack` and `recommend_outfit` search garment words first
and fall back to the customer's own wording, never the other way round.

**A pack has a price of its own, and it is not the sum of its pieces.** The
Ambassador Pack is £99 for six garments that add up to more. `recommend_pack`
returns the pack's Shopify price as `total` and the pieces as `items`; adding
the items up quotes a different number to the one on the product page. Packs
are products, so `isPack` in `src/recommend/packs.ts` keeps them out of
garment selection - otherwise a pack ends up inside a pack, or worn as a top.

**A product on the Online Store is not necessarily buyable.** The Storefront
API, which the basket runs on, reads its own publication. Seed a product and
publish it with REST `published_scope: 'web'` and it is searchable, renders
fine, and fails at the basket with *"The merchandise with id ... does not
exist"* - the one error that looks like a bug in our code and is not. The seed
scripts publish to the headless publication as well; if you add products any
other way, check `resourcePublications` before assuming the cart is broken.

**A price is per variant, not per product.** `product.price` is Shopify's
`minVariantPrice`. Adding those up gave a pack total a customer buying at 2XL
could not check out at, and let garments past a budget filter they could not
afford. Everything that prices a recommendation goes through
`src/recommend/pricing.ts`, which uses the variant for the size being bought
and marks the figure inexact when the variant is not pinned yet - and the
Caddie then says "that is a starting price" rather than quoting it as settled.

**Push to talk loses words in three places.** `getUserMedia` on the button
press means the first word goes into a device that has not started - keep the
stream open between turns instead. `autoGainControl: false` gives a truer
level reading and a worse recording, so leave it on. And stopping the recorder
on the release takes the tail of the last word with it, so keep going for
about 200ms. All three, and the two that follow from keeping the microphone
open, are written up in `docs/widget-update-prompt.md` - they were found in a
test UI that no longer exists, and the widget has not had them applied yet.

**Never send silence to the transcriber.** Given a clip with no speech in it,
a transcription model does not return nothing - it invents, out of whatever
vocabulary the prompt gave it. Ours listed garments and sizes, and a customer
who tapped the mic and said nothing had "I need a medium polo, a large
midlayer, and an extra-large gilet" appear as their own message. The prompt in
`src/ai/transcribe.ts` is now the brand name and nothing else; do not put
garments or sizes back into it. Short clips are refused and a transcript
claiming more words than the clip could hold is dropped - but the real guard
is in the browser, which knows whether the microphone heard anything at all.
Any UI that records audio needs that check.

**Cart writes must not run alongside each other.** The model issues one
`add_to_cart` per garment, and the tool batch used to run in parallel - so
four adds all read an empty `session.cartId`, all four opened a *separate*
basket, and the customer was told four items had gone in at £100 while seeing
one at £58. `writesToCart` in `src/ai/openai.ts` keeps those calls sequential,
each re-reading the session so the second add finds the first one's basket.
Searches still run together. Add a third cart-writing tool and name it there,
or `test/cartOrder.test.ts` will fail.

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
| Search, product detail | **local mirror**, `src/catalog/` | Unlimited and instant. Kept current by webhooks, not polling. |
| The catalogue pull | Admin API | A background job, not buyer traffic. Its own generous quota. |
| The basket, on the store | **The theme's own cart**, changed by the widget (`apps/widget/src/lib/themeCart.ts`) | One basket - the one the cart icon shows and the bundle discounts apply to. The server decides the change and hands the widget a `CartAction`. |
| The basket, dev harness | **Storefront API**, `src/shopify/storefrontCart.ts` | Used only where there is no theme cart (localhost). |
| Bundle deals | **Live theme**, read by `src/catalog/bundles.ts` | Recipes and prices come from the deal pages' bundle-builder settings; only the handles in `SHOPIFY_BUNDLE_DEALS` are sold. |
| UCP | fallback only | Still wired up, still throttled. Not a path to rely on. |

`GET /health` reports the catalogue size and age, and which cart path is live.

### Keeping the mirror current

Three things, cheapest first:

1. **Webhooks** do the real work. Shopify posts to `/api/shopify/webhook` the
   moment a product or stock level moves, and we re-read that one product. The
   mirror is current within seconds and it costs nothing - which matters on a
   busy store, where stock moves constantly and any fixed interval is either
   stale or wasteful. Register them with
   `npm run webhooks --workspace=@caddie/server`, and **re-run it whenever
   `CADDIE_PUBLIC_URL` changes** or Shopify posts into a dead tunnel forever.
2. **A delta pull** every minute asks only for what changed - 9 cost points
   against 72 for a full page - covering webhooks missed during a restart.
3. **A full reconcile** every half hour, which also notices deletions.

Webhook bodies must stay raw: the HMAC is over the exact bytes Shopify sent, so
the route is mounted **before** `express.json`. Moving it below cost an
afternoon once - the parser turns the body into an object, the signature can no
longer be checked, and hashing an object throws inside an async handler, which
takes the whole process down.

Storefront traffic does not touch any of this. Shoppers browsing the store
consume the Storefront API's quota, not the Admin API's, so how busy the shop
is has no bearing on the sync.

### At the real catalogue size

The live store is about 2,400 active products and 4,000 overall, which is a
hundred times the test store. Measured at that size:

| | |
| --- | --- |
| Memory held by the mirror | 3 MB |
| Search | 0.3-3.5ms |
| An outfit (8 searches) | ~28ms |
| Full reconcile | 49 pages, 3,528 cost points, ~20s |
| Averaged Admin API load | 2 points/sec against a 200/sec budget - 1% |

Search is indexed, not scanned. Scanning every product per query was 25ms and
an outfit was 204ms, and Node runs one thread, so that is 200ms of blocking
every other customer behind it. The index is built once per catalogue change
and a query only looks at products containing one of the words.

**The server does not take traffic until the first pull lands.** Until the
mirror is ready, searches fall back to the throttled endpoint, and a restart
under load would send every waiting customer at exactly the thing the mirror
exists to avoid. Twenty seconds of slower boot is the better trade.

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

### Seeing where it goes

`GET /admin` is the usage dashboard: spend by model and by kind of call, cost
per thousand conversations, cache hit rate, which conversations cost what, and
what was said in them. Set `ADMIN_TOKEN` to open it - without one the route
404s rather than 401s, because the server is reachable through a public tunnel
and a 401 is an invitation.

Three things it will not tell you honestly unless you know them:

- **The money is our arithmetic, not OpenAI's.** Rates live in
  `src/usage/pricing.ts` and are maintained by hand. A model with no rate in
  that table reads as zero, so the dashboard names it rather than hiding it.
- **Voice minutes are estimated from audio size.** The `gpt-4o-*-transcribe`
  models only return `json` or `text`; `verbose_json`, the response format
  carrying a real duration, is whisper-1 only.
- **`prompt_tokens` already includes the cached ones.** Billing both at the
  full input rate overstates a cached turn about fourfold, which at our hit
  rate is most of them. `test/usage.test.ts` pins this down.

Conversations are kept for seven days and then expire. Client labels are a
salted hash of the address rather than the address, salted with `ADMIN_TOKEN`
so every instance derives the same label.

## Running under load

The things that only bite at scale, and what handles them.

| | |
| --- | --- |
| **Session memory** | History keeps the words, never the attachment. A session holding ten replies with their payloads was 153KB; without them it is 2KB. At a thousand live sessions that is 149MB against 3MB, for data nothing reads back. |
| **Upstream timeouts** | Node's `fetch` has none, so a hung dependency holds a customer's request until the socket gives up. Everything outbound goes through `fetchWithTimeout` in `src/lib/http.ts`. |
| **Model concurrency** | Capped by a semaphore (`OPENAI_MAX_CONCURRENT`, default 25). Past that they queue here rather than becoming a wall of 429s at the provider. `GET /health` shows `inFlight` and `queued`. |
| **Provider 429s** | One short retry, honouring `retry-after`. OpenAI's limit clears in seconds, unlike Shopify's. |
| **Webhook bursts** | A bulk edit fires one webhook per product. They are collected for 1.5s; past fifteen it does a single delta pull rather than 2,442 separate reads. |
| **Overlapping syncs** | One delta at a time. On a large catalogue a pull can outlast its own interval, and two would race to write the mirror. |
| **One bad request** | `unhandledRejection` is logged and survived - a malformed webhook took the whole process down once. An `uncaughtException` still exits, because the process state is then unknown. |
| **Deploys** | SIGTERM finishes what is in flight, with a 15s cap for SSE streams. |
| **Readiness** | `/health` returns 503 until the catalogue has landed, so a load balancer holds traffic off an instance that cannot search. |

## Running more than one instance

Set `REDIS_URL` and run as many as you like. Without it everything falls back
to this process's memory, which is correct for one instance and for local work.

Four things need sharing, and only the first is obvious:

| | Why it breaks otherwise |
| --- | --- |
| **Sessions** | The next message can land on another instance. The customer loses their size, their budget and their basket mid-conversation. |
| **Rate limits** | Per-instance counters mean the real limit is the limit times the size of the fleet. |
| **The event stream** | An SSE connection lives on the instance that accepted it, but the message producing a card may be handled by another. The card is published into the wrong process and never reaches the screen - with nothing in the logs to say so. |
| **Catalogue changes** | Shopify posts a webhook to one instance. The others serve the old price until their own delta pull, so two customers can be quoted differently for the same minute. |

The mirror itself is fine duplicated: each instance holds its own copy and they
are kept in step by the change channel above.

**`append`, not `save`, for conversation history.** A route reads the session,
the model's tools write to it during the turn, and saving the snapshot read at
the start undoes every one of them. In memory this happened to work because
both held the same object; over Redis they are copies and the last write won.
That bug cost the opening turn of every conversation and is what
`test/sessionStore.test.ts` pins down.

Verified against two instances sharing one Redis: a conversation moving between
them keeps its history and size profile, a card raised on one arrives on the
other's stream, and 46 messages alternating between instances were cut off at
the shared cap of 40.

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
