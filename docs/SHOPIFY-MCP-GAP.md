# The store speaks UCP, the server speaks Storefront MCP

**Status:** blocking. Product search, packs, outfits, basket and checkout all fail.
Sizing is unaffected (it is our own code).
**Owner:** Talha - `apps/server/src/shopify/` is the only place allowed to fetch
product data (RULES.md #1), so this is a backend change. The widget needs no
changes: it only talks to our own API.

## Symptom

```
POST /api/tools/search_products  ->  {"error":"upstream_error","detail":"Shopify MCP error: Invalid params"}
```

`GET /health/shopify` returns `ok: true`, which is misleading - it reaches the
store, but the tool list it prints contains only `search_shop_policies_and_faqs`.

## Cause

`src/shopify/mcpClient.ts` calls `https://<domain>/api/mcp` and
`src/shopify/catalog.ts` calls `search_shop_catalog` / `get_product_details` /
`update_cart` - the Storefront MCP names. On `qqfeqi-xb.myshopify.com`:

| Endpoint | Tools it exposes |
| --- | --- |
| `/api/mcp` | `search_shop_policies_and_faqs` only. No catalogue at all. |
| `/api/ucp/mcp` | `search_catalog`, `lookup_catalog`, `get_product`, `create_cart`, `update_cart`, `get_cart`, `cancel_cart`, `create_checkout`, `update_checkout`, `complete_checkout`, `cancel_checkout`, `get_checkout`, `get_order` |

So the catalogue is there, under the Universal Commerce Protocol, with different
names and a different payload shape.

## What changes

**1. Endpoint.** `mcpClient.ts` line ~33: `/api/mcp` -> `/api/ucp/mcp`.

**2. Every call needs a `meta.ucp-agent.profile`,** and the store fetches that
URL before it will answer. A made-up URL gets you:

```json
{"error":{"code":-32001,"message":"UCP discovery failed",
 "data":{"code":"profile_unreachable","content":"Unable to fetch agent profile: Network error"}}}
```

That is as far as I could verify without a public URL. It means the server has to
serve a UCP agent profile at a publicly reachable address before any catalogue
call succeeds - which is presumably what the empty `CADDIE_PUBLIC_URL` in `.env`
is for (ngrok in dev). Worth confirming the exact profile document UCP expects.

**3. Arguments are nested.** Every tool takes `meta` plus one object
(`catalog`, `cart` or `checkout`) rather than flat parameters:

```jsonc
// search_catalog
{ "meta": { "ucp-agent": { "profile": "https://<public-url>/<agent-profile>" } },
  "catalog": {
    "query": "polo shirt",
    "context": { "address_country": "GB", "currency": "GBP" }   // SHOPIFY_BUYER_COUNTRY / _CURRENCY fit here
  } }

// get_product  (replaces get_product_details)
{ "meta": {...}, "catalog": { "id": "<product id>", "selected": [{ "name": "Size", "label": "M" }] } }

// create_cart / update_cart
{ "meta": {...}, "cart": { "line_items": [{ "item": { "id": "<variant id>" }, "quantity": 1 }] } }
```

`get_product` takes `selected` as an array of `{name, label}` pairs, not the
`{ "Size": "M" }` record `getProductDetails` currently sends.

**4. Prices are integers in minor units.** `{"amount": 2500, "currency": "GBP"}`
is £25.00. `toMoney` in `catalog.ts` would read that as £2,500.00. Divide by 100.

**5. Carts are created, not upserted.** UCP has `create_cart` and `update_cart`
as separate calls, so `updateCart()` needs to branch on whether
`session.cartId` exists. Checkout is its own set of tools, so `cart.checkoutUrl`
may now come from `create_checkout` rather than the cart.

## What is unknown until one call succeeds

The response shapes. The normalisers (`toProduct`, `toVariant`, `toCartLine`)
are written defensively but guess at field names. Log one raw `search_catalog`
response and one `get_product` response before trusting them - the same advice
Day 2 of the roadmap already gives.

## Also in `.env`, unread by any code

`OPENAI_API_KEY`, `SHOPIFY_BUYER_COUNTRY`, `SHOPIFY_BUYER_CURRENCY`,
`SHOPIFY_BRAND_TAG`, `DRUIDS_STORE`, `DUMMY_STORE_CLIENT_ID`,
`DUMMY_STORE_SECRET`, `DUMMY_STORE_ACCESS_TOKEN`, `SHOPIFY_DUMMY_STORE_URL`.
The buyer country and currency map onto `catalog.context` above;
`SHOPIFY_BRAND_TAG` sounds like the filter that keeps demo products out of
recommendations. Worth deciding which are real and deleting the rest.

## How to reproduce

```bash
npm run dev:server
curl http://localhost:8787/health/shopify          # one tool, no catalogue

curl -X POST https://qqfeqi-xb.myshopify.com/api/ucp/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # the real toolset
```

## Widget side, for when this lands

Two optional fields were added to `packages/shared` (RULES.md #5) that the
server does not fill yet:

- `Product.compareAtPrice` - the RRP. The pack panel shows "You save £x" only
  when every item carries one, and never works a saving out for itself.
- `ChatRequest.context` - which product page the customer is on
  (`pageType`, `productId`, `productHandle`, `productTitle`, `variantId`).
  The widget sends it on every message; the prompt ignores it for now.

The widget also expects `find_my_size` not to echo the recommended size back as
`alternativeSize` (it currently does; the UI hides it).
