# Druids Personal Caddie

Voice and chat shopping assistant for the Druids store. Two week sprint, two builders.

| | |
| --- | --- |
| **Talha** | AI, Vapi, Shopify MCP, backend, recommendation logic, cart, release |
| **Amir** | UI, product cards, basket, mobile and device testing |

Day by day plan: [docs/ROADMAP.md](docs/ROADMAP.md). The rules that keep us honest: [docs/RULES.md](docs/RULES.md).

## Getting started

```bash
npm install
cp .env.example .env    # fill in SHOPIFY_STORE_DOMAIN at minimum
npm run dev:server      # http://localhost:8787
npm run dev:widget      # http://localhost:5173
```

You do **not** need Vapi keys to start. Without them the server falls back to a
keyword router (`src/ai/devRouter.ts`) that calls the real tools against the
real Shopify store, so the UI can be built on day 1. Add `VAPI_PRIVATE_KEY` and
`VAPI_ASSISTANT_ID` and the same endpoints go through the AI instead.

Check the store connection before anything else:

```bash
curl http://localhost:8787/health/shopify
```

## Layout

```
apps/server     Node + TypeScript. Vapi webhook, Shopify MCP client, recommendations.  (Talha)
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
                                     Shopify MCP  <─────────┤ products, prices, cart
                                     our own code <─────────┘ size, pack, outfit logic
                                                            │
                        widget <── SSE /api/events/:id ─────┘ cards on screen
```

The model gets a short spoken line. The widget gets the structured payload. The
model never has to repeat a price, so it never gets one wrong.

## Useful endpoints

| Endpoint | What it is for |
| --- | --- |
| `GET /health` | Is the server up, is Vapi configured |
| `GET /health/shopify` | Is the store's MCP server reachable, what tools it exposes |
| `GET /api/tools` | Tool definitions, including the exact JSON to give Vapi |
| `POST /api/tools/:name` | Run one tool directly, no AI. Build and debug UI with this |
| `POST /api/chat` | Text chat |
| `GET /api/events/:sessionId` | SSE stream of cards and speech for a session |
| `POST /api/vapi/webhook` | Where Vapi sends tool calls |

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

## Before the pilot

Things deliberately left as placeholders, each marked `TODO` in the code:

- `apps/server/data/size-chart.json` is placeholder sizing. Replace with the real Druids size guide (Day 4).
- Sessions are in memory, so a server restart forgets every conversation. Fine for the sprint, swap for Redis before real traffic.
- `compareAtPrice` (RRP) is in the shared `Product` type but the server normaliser does not read it yet, so pack savings and RRP strike-throughs stay hidden until it does.
- `PageContext` is sent with every chat message, but the prompt does not use it yet.
