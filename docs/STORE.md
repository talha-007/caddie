# The test store

`qqfeqi-xb.myshopify.com` — Talha's dummy Shopify store. We build and test the
Caddie against this, and embed the widget in its theme, before anything touches
a real Druids store.

## What is in it

49 products, and they are not all Druids:

| | Count | Vendor | Tagged | Product types |
| --- | --- | --- | --- | --- |
| Real Druids kit | 24 | `Druids` | `druids-product` | POLOS, MIDLAYERS, GOLF HOODIES, GILETS, JACKETS, SHORTS, TROUSERS, HEADWEAR, SOCKS |
| Generic demo stock | 25 | `Otaku Oasi` | — | Jeans, Dresses, Bags, Belts, Skirts, T-Shirts … |

**The Caddie must only ever recommend the first group.** `SHOPIFY_BRAND_TAG`
does this: the server filters search results down to products carrying
`druids-product`. Without it, "show me some trousers" answers with High-Rise
Wide Leg Jeans, which is exactly the kind of thing rule 2 in
[RULES.md](RULES.md) exists to prevent.

UCP search has no vendor filter and the payload carries no vendor field, which
is why we match on the tag rather than the vendor.

## What we added

The store had no Druids bottoms or accessories, so an outfit could not be
completed. These were created through the Admin API:

| Product | Type | Price | Sizes |
| --- | --- | --- | --- |
| TOUR SHORT - NAVY | SHORTS | 42 | 30–40 (40 deliberately out of stock) |
| TOUR SHORT - KHAKI | SHORTS | 42 | 30–40 |
| TECH TROUSER - BLACK | TROUSERS | 58 | 30–40 |
| TOUR BEANIE - BLACK | HEADWEAR | 22 | One Size |
| PERFORMANCE SOCKS - WHITE | SOCKS | 16 | S/M, L/XL |

Two deliberate choices in there:

- **TOUR SHORT - NAVY in waist 40 is out of stock on purpose.** Day 8 requires
  that we check variants before adding them, and that path needs something real
  to fail against. Do not "fix" it.
- **Bottoms use waist sizes, not S/M/L**, because that is how Druids sizes them.
  They were seeded with letter sizes first and converted by
  `scripts/resizeBottoms.mjs`, since `find_my_size` answers "34" and the product
  has to offer a 34.
- **The images are borrowed from the demo products.** They depict the right
  garment, but they are not Druids photography. Replace before the client sees
  it.

Everything else sells when out of stock, so a demo never dies on an inventory
count.

## Currency

The store is in PKR, but the Druids products were imported with pound values in
the price field — a £24 polo is sitting there as Rs 24. Budgets are therefore
meaningless: a pack of three "costs" Rs 56 while a pair of demo jeans is
Rs 25,790.

The fix is to switch the store's base currency to GBP in **Settings → General →
Store defaults → Currency display**. Shopify keeps the number and changes only
the label, so every Druids price becomes correct in one step, and the five
products above were priced with that in mind.

This cannot be done over the Admin API — there is no mutation for base currency,
and it is a deliberate, account-level change. It has to be done in the admin UI.

After the switch, set `SHOPIFY_BUYER_CURRENCY=GBP` and `SHOPIFY_BUYER_COUNTRY=GB`
in `.env`. The 25 demo products will then read as £6,690–£63,790, which is
harmless — the brand tag keeps them out of the Caddie's mouth.

## Gotchas

**New products are not published by default.** `productSet` creates them
unpublished, and publishing over GraphQL needs `write_publications`, which our
token does not have. The REST endpoint accepts it under `write_products`:

```
PUT /admin/api/2025-07/products/{id}.json
{"product":{"id":<id>,"published":true,"published_scope":"web"}}
```

**The catalog search index lags.** A newly published product is visible to
`lookup_catalog` immediately but takes a while to appear in `search_catalog`.
If a product you just created does not show up, check `lookup_catalog` before
assuming something is broken.

## Token scopes

`DUMMY_STORE_ACCESS_TOKEN` has `write_products`, `write_inventory` and
`read_products`, which covers catalogue work. It does **not** have
`read_locations`, `write_publications` or `read_markets`, so setting real
inventory quantities, publishing over GraphQL and configuring Markets all have
to happen in the admin UI.

## The UCP agent profile

Shopify fetches our agent profile on **every** catalog call, and it is fussy
about it. Two rejections we hit, and what they mean:

| Error | Cause |
| --- | --- |
| `profile_unreachable` | The URL is not publicly reachable. localhost never works. |
| `profile_malformed: Invalid cache control` | The response was not cacheable. A **VS Code dev tunnel injects `Cache-Control: no-cache, no-store`** on the way out, which fails even though our own server sets a valid header. |
| `profile_malformed: Missing payment handlers` | `payment_handlers` was absent. It has to be present even when empty. |

The profile is static - it says nothing about where our server lives - so in
dev we publish it to the Shopify CDN, which serves it with a year-long
max-age, and skip the tunnel entirely:

```bash
npm run publish:profile --workspace=@caddie/server
```

That prints a `UCP_AGENT_PROFILE_URL=` line for `.env`. Re-run it after editing
`data/agent-profile.json`.

In production, leave `UCP_AGENT_PROFILE_URL` empty and let `CADDIE_PUBLIC_URL`
point at the deployed server's `/ucp/agent-profile.json`, which sets its own
cache headers.

`GET /health` reports which profile is in use and whether it is ours.
