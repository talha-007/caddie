# Druids Personal Caddie

Voice and chat shopping assistant for the Druids store. Two week sprint, two builders.

| | |
| --- | --- |
| **Talha** | AI, Vapi, Shopify catalog, backend, recommendation logic, cart, release |
| **Amir** | UI, product cards, basket, mobile and device testing |

How it works, the rules it must not break, and what has gone wrong before: [CLAUDE.md](CLAUDE.md).

## Getting started

```bash
npm install
cp .env.example .env    # fill in SHOPIFY_STORE_DOMAIN at minimum
npm run dev:server      # http://localhost:8787
npm run dev:widget      # http://localhost:5173
```

### Which brain is answering

Text chat picks the best available of three, in this order:

| | When | What it is |
| --- | --- | --- |
| **OpenAI** | `OPENAI_API_KEY` set | A real tool-calling loop in our own process. This is the text path that ships. |
| **Vapi chat** | Vapi keys set, no OpenAI key | The same assistant that handles voice, answering text. |
| **Keyword router** | no keys at all | `src/ai/devRouter.ts`. No AI, but it calls the real tools against the real store, so the UI can be built with no keys whatsoever. |

Voice always goes through Vapi, which calls the same tools over the webhook.
One system prompt, one tool registry, so the two paths cannot drift apart.

`GET /health` tells you which mode is live.

Check the store connection before anything else:

```bash
curl http://localhost:8787/health/shopify
```

## Layout

```
apps/server     Node + TypeScript. Vapi webhook, Shopify UCP client, recommendations. (Talha)
apps/widget     React + Vite. The Caddie widget, embeddable in the Shopify theme.      (Amir)
packages/shared TypeScript types both sides import. The contract between us.
```

Change a type in `packages/shared` and both sides see it immediately - that is
the point. If you need a new field on a product or a recommendation, add it
there first and tell the other person.

## How a request flows

```
Customer speaks   ──> Vapi ──> POST /api/vapi/webhook ──> tool runs
Customer types    ──> POST /api/chat                  ──> tool runs
                                                            │
                                     Shopify UCP  <─────────┤ products, prices, cart
                                     our own code <─────────┘ size, pack, outfit logic
                                                            │
                        widget <── SSE /api/events/:id ─────┘ cards on screen
```

The model gets a short spoken line. The widget gets the structured payload. The
model never has to repeat a price, so it never gets one wrong.

## Shopify Storefront MCP: two endpoints

We use Shopify's Storefront MCP, which is current and needs no authentication.
It is split across two endpoints, and that trips people up:

| Endpoint | Tools | We use it for |
| --- | --- | --- |
| `https://<store>/api/ucp/mcp` | `search_catalog`, `lookup_catalog`, `get_product`, `create_cart`, `get_cart`, `update_cart` | everything |
| `https://<store>/api/mcp` | `search_shop_policies_and_faqs` (and, per the docs, the cart tools) | nothing yet |

The catalog tools were renamed and moved to the `/api/ucp/mcp` endpoint so they
conform to UCP (Universal Commerce Protocol). If you find a tutorial calling
`search_shop_catalog` or `get_product_details` on `/api/mcp`, it predates that
move — the names are `search_catalog` and `get_product` now.

On our dummy store, `tools/list` on `/api/mcp` returns only the policies tool,
though the docs say the cart tools live there too. It does not matter to us: the
UCP endpoint carries a full cart API and that is the one we have tested against.
Worth re-checking on the real Druids store.

Four UCP behaviours follow from all this, and each one has already bitten once:

**Every call carries an agent profile.** Shopify fetches
`meta["ucp-agent"].profile` on each request to see what our agent supports, so
it has to be a publicly reachable URL. We serve ours at
`/ucp/agent-profile.json` — set `CADDIE_PUBLIC_URL` (ngrok in dev) and the
server uses it. Until you do it falls back to Shopify's published example
profile, which works but describes someone else's agent. `GET /health` tells
you which one is in use.

**Prices are integers in minor units.** `{ amount: 2400, currency: "PKR" }` is
PKR 24.00. [money.ts](apps/server/src/shopify/money.ts) converts at the
boundary and nothing downstream deals in minor units. A missed conversion is
the Caddie saying a price 100x wrong, out loud, to a customer.

**Cart updates replace, they do not merge.** `update_cart` sets the cart's lines
to exactly what you send, so sending one line deletes everything else. Use
`addToCart` and `setLineQuantity` in
[catalog.ts](apps/server/src/shopify/catalog.ts), which read-modify-write around
that, rather than calling `update_cart` yourself.

**Options are not variants.** A product's `options` are every size on offer; a
`variant` is one combination with its own id and stock. Ask which size, then
call `get_product_details` again with it to get the variant to add. Shopify
returns a default variant even when nothing was chosen, so "one variant came
back" never means "the customer picked".

## Useful endpoints

| Endpoint | What it is for |
| --- | --- |
| `GET /health` | Is the server up, is Vapi configured |
| `GET /health/shopify` | Is the store reachable, which UCP tools it exposes, plus a real sample search |
| `GET /api/tools` | Tool definitions, including the exact JSON to give Vapi |
| `POST /api/tools/:name` | Run one tool directly, no AI. Build and debug UI with this |
| `POST /api/chat` | Text chat |
| `POST /api/voice` | Voice in, chat out: post a recording, get the transcript and the reply |
| `GET /api/events/:sessionId` | SSE stream of cards and speech for a session |
| `POST /api/vapi/webhook` | Where Vapi sends tool calls |
| `GET /ucp/agent-profile.json` | Our UCP agent profile, which Shopify fetches on every catalog call |

Try a tool without the AI:

```bash
curl -X POST http://localhost:8787/api/tools/find_my_size \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test","args":{"heightValue":180,"heightUnit":"cm","weightValue":80,"weightUnit":"kg"}}'
```

## Connecting Vapi

1. Create an assistant in Vapi, copy its id and your keys into `.env`.
2. Expose the server: `ngrok http 8787`, then set `CADDIE_PUBLIC_URL` to the https URL.
3. `npm run sync:assistant --workspace=@caddie/server`

That pushes the system prompt from `src/ai/prompt.ts` and every tool definition
to Vapi. **Edit the prompt in this repo, not in the Vapi dashboard** - the sync
overwrites the dashboard.

## Putting the widget on the storefront

```bash
VITE_CADDIE_ASSET_BASE=https://cdn.shopify.com/.../assets/ \
VITE_CADDIE_API_URL=https://caddie.example.com \
npm run build --workspace=@caddie/widget
```

Upload everything in `apps/widget/dist/` to the theme assets, then in the theme:

```html
<link rel="stylesheet" href="{{ 'caddie.css' | asset_url }}" />
<script type="module" src="{{ 'caddie.js' | asset_url }}"></script>
```

`type="module"` matters: the Vapi voice SDK is a lazy chunk, so a customer who
never taps the mic never downloads it (155kB entry vs 470kB if bundled). That
is also why `VITE_CADDIE_ASSET_BASE` has to be set - the chunk is fetched
relative to it.

Remember to add the storefront origin to `CORS_ORIGINS` on the server.

### Theme hooks

On product templates, give the mount node the product so the Caddie knows what
the customer is looking at (full list in `apps/widget/src/lib/context.ts`):

```liquid
<div id="druids-caddie"
     data-page-type="product"
     data-product-id="{{ product.id }}"
     data-product-title="{{ product.title | escape }}"
     data-product-image="{{ product.featured_image | image_url: width: 200 }}"
     data-variant-id="{{ product.selected_or_first_available_variant.id }}"></div>
```

- **Open buttons anywhere in the theme:** `<button data-caddie-open="size">Find My Size with Caddie</button>`
  (`size`, `pack`, `outfit`, or empty for the home screen), or `window.DruidsCaddie.open('size')`.
- **Hide the floating launcher** when the theme has its own buttons: `data-launcher="false"` on the mount node.
- **Raise the launcher** above a sticky add-to-cart bar: `#druids-caddie .caddie-root { --caddie-launcher-offset: 88px; }`
- **Events out:** `caddie:size-recommended` (`detail.size`) so the product form can preselect the size, and
  `caddie:cart-updated` (`detail.totalQuantity`) for the header cart count.

## Checks

```bash
npm run typecheck
npm run test
npm run build
```

### Honesty checks

`scripts/evalModel.mjs` runs the ways the Caddie has actually misled a customer
during development - inventing a product, guessing a price, calling mens kit
womens - against whichever model is answering. Run it before changing
`OPENAI_MODEL`, and on Day 11.

```bash
OPENAI_MODEL=gpt-4.1-mini PORT=8899 npx tsx src/index.ts   # in one terminal
npm run eval:model --workspace=@caddie/server -- 8899 gpt-4.1-mini
```

Measured on a five-message journey (search, pack, cheaper, size, add to basket):

| model | honesty checks | cost per 1000 conversations |
| --- | --- | --- |
| gpt-4.1 | 8/8, 8/8 | $16.39 |
| **gpt-4.1-mini** | **8/8, 8/8** | **$3.51** |
| gpt-5-mini | 6/8, 8/8 | $1.65 |

gpt-5-mini is the cheapest but was dropped: asked for a womens polo in a store
that stocks none, it quoted a size and offered to go and find one, three times
out of three. Voice transcription adds about $0.003/minute on top.

The scores depend on the prompt as much as the model. The hedging case ("not
listed exactly, but the closest match is...") only passes because the prompt
names that phrasing and forbids it.

## Before the pilot

Things deliberately left as placeholders, each marked `TODO` in the code:

- `apps/server/data/size-chart.json` is placeholder sizing. Replace with the real Druids size guide (Day 4).
- `CADDIE_PUBLIC_URL` is unset, so catalog calls go out under Shopify's example agent profile rather than ours. Set it once the server has a public URL.
- The store is the `qqfeqi-xb` dummy store, priced in PKR. Swap `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_BUYER_CURRENCY` and `SHOPIFY_BUYER_COUNTRY` when the real Druids store is ready.
- Sessions are in memory, so a server restart forgets every conversation. Fine for the sprint, swap for Redis before real traffic.
- `compareAtPrice` (RRP) is in the shared `Product` type but the server normaliser does not read it yet, so pack savings and RRP strike-throughs stay hidden until it does.
- `PageContext` is sent with every chat message, but the prompt does not use it yet.
