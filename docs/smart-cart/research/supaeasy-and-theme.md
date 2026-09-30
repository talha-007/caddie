# Smart Cart Phase 2: SupaEasy and theme truth

Written for: the team designing the Smart Cart evaluator (Talha, Asim, Amir).

Branch `smart-cart-phase-1`. Read-only investigation, 30 Sep 2026. **No code, theme, SupaEasy, discount or product was changed.** Nothing was added to any cart.

## How the evidence was gathered

| Source | Access | What it gave |
| --- | --- | --- |
| Shopify Admin GraphQL `2025-07` | Caddie's existing token (app "AI AUTOMATION APP"), scopes `read_discounts`, `read_themes`, `read_products`, `read_price_rules` and others; **no write scopes**, **no `read_cart_transforms`**, no page-read scope | SupaEasy discount nodes and their configuration metafields (`scripts-migrator.*`), theme files, products, collections |
| Published theme "Autumn 2026" (`159972884580`, role MAIN) | Admin theme files, read | 235 JS/Liquid + 176 JSON files |
| Unpublished theme "Copy of  DRUIDS - SPORT TYPE - AsimAli" (`SHOPIFY_CONDITION_PACKS_THEME_ID`) | Admin theme files, read | 795 files |
| Public storefront `www.druids.com` | Anonymous GET | Page HTML (confirms which theme and builder are live), empty `/cart.js` shape |

Raw captures are in the session scratchpad, not the repository. The investigative product lists are `eligible/polos.json`, `eligible/trousers.json` and `eligible/shorts.json`, next to this report.

---

## Confirmed facts

1. **SupaEasy decides eligibility for all three V1 offers only by a line attribute (line item property) with a non-empty value.** None of the three scripts reads product, variant, collection, tag or product type. The product rule lives entirely in whatever stamps the property.
2. The three canonical triggers are **current and live** in SupaEasy: `__3_Polo_Bundle`, `__any-2-trousers`, `__any-2-trouser-shorts`, each read by an ACTIVE automatic discount.
3. On the **published** theme, the three triggers are produced as follows:
   - `__3_Polo_Bundle` by `QUICK_CART` (product page, collection grids, product cards) for products tagged `bundle_threepolo`;
   - `__any-2-trousers` by bundle builder v4 on `/pages/any-2-trousers` only;
   - `__any-2-trouser-shorts` by bundle builder v4 on `/pages/any-2-trouser-shorts` only.
4. The **unpublished** Asim theme implements the same offers with a new builder (`sport-deal-bundle-*`) whose qualifying products come from **different collections** than the live pages.
5. **Caddie's own adds write no line properties** (`apps/widget/src/lib/themeCart.ts addLines` sends `{id, quantity}` only). A polo, trouser or short added by Caddie today never counts toward any of these offers.
6. `BasketSync` already carries every line property (`properties`), so the triggers are visible to the server on every chat turn since Phase 1. It drops all price and discount fields (see "Discount evidence available").
7. SupaEasy counts **units**, not lines: one line of quantity 3 is three qualifying units.

---

## Offer-by-offer eligibility

### SupaEasy configuration (live)

| Field | Any 3 Polos | Any 2 Men's Trousers | Any 2 Shorts |
| --- | --- | --- | --- |
| Discount title | ANY 3 POLO COLLECTION | ANY 2 TROUSERS MENS | ANY 2 SHORTS |
| Node | `DiscountAutomaticNode/1162170957924` | automatic app discount | automatic app discount |
| SupaEasy function | `product-discount-advanced-multi-mix` (input `productDiscount_multi_mix`) | same | same |
| Status | ACTIVE | ACTIVE | ACTIVE |
| Dates | from 2026-05-05, no end | from 2026-04-23, no end | from 2026-04-27, no end |
| Discount class | PRODUCT | PRODUCT | PRODUCT |
| Trigger key (`paK`) | `__3_Polo_Bundle` | `__any-2-trousers` | `__any-2-trouser-shorts` |
| Trigger value | Any non-empty value | Any non-empty value | Any non-empty value |
| Second key (`paK2`) | empty | empty; the script also reads `attribute_2`, whose key is **UNCLEAR** (the function's input query is not exposed) | same as trousers |
| Threshold | 3 units | 2 units | 2 units |
| Price | market table; UK £59.99, US 99, IE 65, EU 69, … | UK £49, US 95, IE 55 | UK £45, US 80, IE 50 |
| Unknown market | no discount | no discount | no discount |
| Product IDs / variant IDs / collections / tags / types | none (`pT`, `pC`, `cT` empty; the script reads none) | none | none |
| Exclusions | none in the script | none | none |
| Customer restrictions | none in the script; automatic app discounts have no customer selection field | same | same |
| Combines with | order yes, product yes, shipping **yes** | order yes, product yes, shipping no | order yes, product yes, shipping no |
| Message (discount title shown) | `ANY 3 POLO BUNDLE` | `ANY 2 TROUSERS` | `ANY 2 SHORTS` |
| Unit price used | `line.cost.amountPerQuantity` | `line.cost.totalAmount / quantity` | same as trousers |
| Discount target | cart line id, with unit quantity | product variant id (no quantity) | same as trousers |
| Quantity on one line | counts each unit | counts each unit | counts each unit |
| Mixed designs | allowed; no design check | allowed | allowed |
| Sale items | no exclusion; a set whose units already total ≤ the pack price is skipped (no discount on that set) | same | same |
| Pack/bundle lines | no exclusion by the script; only the trigger matters | same | same |
| Other properties | ignored by the script | ignored | ignored |
| Application strategy | `ALL`; units sorted dearest first, grouped in threes, discount = set total − pack price per set | dearest first, pairs | dearest first, pairs |

Related active SupaEasy discount: **"Bundle discount reject"** (`Unified Discount Advanced Mixed`) rejects every entered discount code when any line has `__bundle_version_2`. v4 pack lines carry it; `QUICK_CART` polo lines do not. Expired and no longer relevant: "Three polo discount" (product tag `bundle_threepolo`, ended 2026-05-05) and "Three polo discount Ladies" (ended 2026-05-07).

### How each theme path decides

**Published theme "Autumn 2026"**

| Offer | Where the property is written | Which products | Rule used | Properties written |
| --- | --- | --- | --- | --- |
| Polos | `snippets/application_script.liquid QUICK_CART` | Product page (`sections/main-product.liquid`), collection grid and mobile quick add (`sections/main-collection.liquid`), featured collections, `snippets/product-card.liquid`, `product-card-recommendation.liquid`, `collection-product-card.liquid` | **Product tag** `bundle_threepolo`. Liquid on product page and cards; JS `tagsArray.includes(...)` on collection grids | `__data_three_polo=3_Polo_Bundle` and `__3_Polo_Bundle=3_Polo_Bundle` on the one added line, plus `__Localization`, `__Product_Url` |
| Trousers | `snippets/bundle-builder-script-v4.liquid` on `/pages/any-2-trousers` | Collections `any-2-trousers-step-1` and `-step-2` (identical, manual) | **Collection** (page template section settings) | `__any-2-trousers=any-2-trousers` on every pack line, plus all v4 properties (`__Bundle_Name`, `__bundle_id`, `__bundle_version_2`, `__fixed_price`, `__price_validated`, `__verified_price`, …) |
| Shorts | same builder on `/pages/any-2-trouser-shorts` | Collections `any-2-trouser-shorts-1` and `-2` (identical, manual) | **Collection** | `__any-2-trouser-shorts=any-2-trouser-shorts` on every pack line, plus v4 properties |

The v4 builder names its trigger after the page: `data_url = page.handle` with `-app` and `-eur` removed (`snippets/bundle-card-v4.liquid:141`). So:
- `/pages/any-2-trousers-eur` and `-app` also write `__any-2-trousers`.
- `/pages/any-2-shorts` writes `__any-2-shorts` (a different discount: "LADIES & KIDS ANY 2 SHORTS").
- `/pages/three-polo-deal` writes `__three-polo-deal`, **which no active SupaEasy discount reads**.

The live product page and quick add **never** stamp the trousers or shorts triggers; only the pack pages do.

**Unpublished theme "Copy of  DRUIDS - SPORT TYPE - AsimAli"**

| Offer | Page template | Mens collection | Trigger (`script_properties` on the gender card) | Also |
| --- | --- | --- | --- | --- |
| Polos | `page.choose-three-polo-temp` | `all-polos`, `gender_filter: men`, pick 3 | `__3_Polo_Bundle=3_Polo_Bundle` | `assets/sport-quick-cart-bundle.js` and `sections/sport-*-gender-select.liquid` contain `__3_Polo_Bundle` |
| Trousers | `page.choose-two-trousers-temp` | `men-golf-trousers`, pick 2 | `__any-2-trousers=any-2-trousers` | |
| Shorts | `page.choose-two-short-temp` | `men-golf-shorts`, pick 2 | `__any-2-trouser-shorts=any-2-trouser-shorts` | |

---

## Theme vs SupaEasy comparison

SupaEasy accepts **any** line carrying the trigger, so SupaEasy is never narrower than a theme. The real comparison is **live theme vs unpublished theme**, since each stamps a different product set.

| Offer | Theme vs SupaEasy | Live vs unpublished product set | Evidence |
| --- | --- | --- | --- |
| Any 3 Polos | **MATCH** by construction (SupaEasy trusts the stamp); product rule = theme | **Live broader.** 590 active tagged polos vs 478 in `all-polos`. 476 in both, **114 live only** (e.g. Graduate, Academy, Napa, Pineapple Skullz, some Elite colourways), **2 unpublished only** (Dazzle Polo Sage/White, Block Pique Polo Blue/Navy, untagged) | `eligible/polos.json` |
| Any 2 Men's Trousers | **MATCH** by construction | **Live narrower.** 25 vs 33; all 25 live are in `men-golf-trousers`; **8 unpublished only**, all thermal trousers and joggers (product type WINTER TROUSERS) | `eligible/trousers.json` |
| Any 2 Shorts | **MATCH** by construction | **Live narrower.** 33 vs 39; **6 unpublished only** (Heritage Botanic Grey/Sage, Clima Tour Winner Sage, Heritage Tex Grey, Elements Sage, Birdie Sage) | `eligible/shorts.json` |

Products SupaEasy would accept but no path stamps: none can exist, because SupaEasy has no product list. Products a theme stamps that SupaEasy rejects: none for these three triggers. `__three-polo-deal` from the live three-polo pack page is the exception: stamped, but read by nothing.

Ambiguous cases:
- **A product tagged with two polo tags** would get a concatenated value such as `3_Polo_Bundlebundle_threepolo_ladies` on the product page and cards. Today no active product has two of the three tags (overlaps are 0), so it is latent.
- **`collection-product-card.liquid`** suppresses the polo tag inside the `ladies-polos` collection only (`unless collection.handle == 'ladies-polos'`), so the same product stamps differently depending on the page it is added from.
- **Draft products** carry tags too: 923 products are tagged `bundle_threepolo`, 590 of them active.

---

## Trigger behaviour

| Question | Polos (`QUICK_CART`) | Trousers / Shorts (v4 pages) |
| --- | --- | --- |
| Exact value | `3_Polo_Bundle` (and `__data_three_polo=3_Polo_Bundle`) | `any-2-trousers` / `any-2-trouser-shorts` |
| Written on | each qualifying line as it is added (one line per add) | every line of the pack |
| Does order matter | no; SupaEasy sorts units by price | no |
| Stays when quantity falls below the threshold | yes; no theme code removes it. Drawer `UPDATE_QTY` / `UPDATE_LINE_ITEM` change quantity by line key and keep properties | yes; `REMOVE_BUNDLES` removes the whole pack's lines |
| Stale triggers removed by theme | no code found that removes these properties | no |
| Same variant added twice | Shopify merges into one line only when properties match exactly; the polo stamp is identical per product, so the same polo merges (quantity 2) | v4 lines carry a per-pack `__bundle_id` and `__bundle_date`, so each pack is separate lines |
| Caddie adds | **no properties**, never qualifies | no properties |

The shorts trigger `__any-2-trouser-shorts` is the name of the live shorts page. It must not be renamed; historical and live baskets carry it and SupaEasy reads it.

---

## Quantity behaviour

Proven statically from the scripts:

- **Any 3 Polos:** each unit of a line becomes one eligible unit (`for unitIndex < quantity`). One line of quantity 3 **counts as three**. Distinct lines, variants or designs are **not** required.
- **Any 2 Trousers / Any 2 Shorts:** same, per unit.
- **Sets:** the dearest units form the sets first. With 4 polos, the dearest 3 form a set and the cheapest is left out. A set whose units already total ≤ the pack price gets no discount.
- **Trousers and shorts target by variant id without a quantity.** The discount is spread across every line of that variant, including a line of the same variant *without* the trigger. Whether Shopify then allocates it only to the triggered units is **UNCLEAR**. This is a development-theme experiment.

---

## Packs/grouped-line behaviour

- **A polo inside an Ambassador, Prestige or other pack does not satisfy Any 3 Polos.** v4 pack lines carry `__<pack handle>` (e.g. `__golf-ambassador-pack`) and never `__3_Polo_Bundle`. Condition-pack lines carry `__amb-mens-condition`.
- **Trousers or shorts inside another pack do not qualify** for Any 2 Trousers or Any 2 Shorts, for the same reason. The *any-2 pack itself* is the qualifying route for trousers and shorts on the live store: its lines are v4 pack lines (`__bundle_id`, `__Bundle_Name=any-2-trousers`, `__bundle_version_2`, price properties) that also carry the trigger.
- **SupaEasy does not exclude bundle lines explicitly.** It excludes nothing but lines without the trigger.
- **The theme never adds a polo trigger to pack lines.** The v4 builder writes only its own page trigger.
- **Consequence for Caddie:** Caddie's pack logic (`bundle` from `__bundle_id` or `_data_bundle_id`) treats live any-2 trouser/short lines as a **pack**. Removing one line removes the pack, which matches the theme's `REMOVE_BUNDLES`. Polo offer lines are **not** packs to Caddie (no `__bundle_id`).
- **Codes:** because v4 lines carry `__bundle_version_2`, "Bundle discount reject" blocks discount codes whenever a trousers or shorts pack is in the cart, but not for QUICK_CART polo lines.
- **A line carrying two different offer triggers** is not produced by any live path found. What SupaEasy would do with one is **UNCLEAR**, since each discount only checks its own key and product discounts combine.

---

## Discount evidence available

Live `/cart.js` (anonymous, empty) returns these top-level fields: `token`, `note`, `attributes`, `original_total_price`, `total_price`, `total_discount`, `total_weight`, `item_count`, `items`, `requires_shipping`, `currency`, `items_subtotal_price`, `cart_level_discount_applications`, `discount_codes`.

Line-level fields could not be observed without adding to a cart, which I did not do. Shopify documents `original_price`, `discounted_price`, `original_line_price`, `line_price`, `final_price`, `final_line_price`, `total_discount`, `discounts[]`, `line_level_discount_allocations[] {amount, discount_application {title, type, value…}}` and `line_level_total_discount`. They are **not verified on this store** yet.

What the widget reads today (`AjaxCart` in `apps/widget/src/lib/themeCart.ts`): `token`, `item_count`, `total_price`, `currency`; per line `key`, ids, titles, `quantity`, `final_price`, `final_line_price`, `properties`, `selling_plan_allocation`.

What `BasketSync` sends to the server: `cartToken` and per line `key`, `productId`, `variantId`, `title`, `variantTitle`, `quantity`, `properties`, `sellingPlanId`, `bundle`, `bundleName`. **It drops every price and discount field**, including the ones the widget already reads.

Fields a later verification phase would need (not changed now):
- Per line: `original_line_price`, `final_line_price`, `line_level_discount_allocations[].amount` and `.discount_application.title` (to match `ANY 3 POLO BUNDLE`, `ANY 2 TROUSERS`, `ANY 2 SHORTS`), `line_level_total_discount`.
- Cart: `original_total_price`, `total_price`, `total_discount`, `cart_level_discount_applications`, `currency`.

---

## Ladies polo ambiguity

Trigger names present in theme code today:

| Trigger | Where | SupaEasy discount reading it | State |
| --- | --- | --- | --- |
| `__bundle_threepolo_ladies` | Live `QUICK_CART` for products tagged `bundle_threepolo_ladies`; unpublished theme women cards 2 and 3 | ANY 3 POLO LADIES COLLECTION, UK £59.99 | ACTIVE |
| `__any-three-ladies-polos` | Unpublished theme, women card 1 | LADIES ANY 3 POLO, UK £55, `pC` = ladies-any-three-polo-step-1/2/3 | ACTIVE |
| `__ladies-any-three-polo…` (v4 page names such as `ladies-any-three-polo-dea`, `-app`) | Live v4 templates `page.ladies-any-three-polo-*` | none found | — |
| `bundle_threepolo_ladies` tag rule | expired "Three polo discount Ladies" | — | EXPIRED |

Two **active** discounts price "3 ladies polos" at **different UK prices** (£59.99 and £55). They read different keys, so one line matches only one of them, but a basket could hold lines of both kinds and form two separate sets. The `pC` collection list on LADIES ANY 3 POLO is not read by its script; whether SupaEasy applies it outside the script is **UNCLEAR**. **No canonical ladies function can be proven.** Ladies polos stay out of V1.

---

## Recommended eligibility source

Two separate questions must not be merged:

1. **Does this cart line count toward the offer right now?** This is what SupaEasy counts.
2. **Which products may Caddie suggest and add as qualifying?** This is what makes a line count once added.

| Option | Accuracy for (1) | Accuracy for (2) | Maintainability | Runtime cost | Stale risk | Merchandising adds/removes a product | Developer deploy needed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Trigger property on the real cart line** (already in `BasketSync.properties`) | **Exact**: identical to SupaEasy's own test | n/a | high; nothing to maintain | none; data already on every turn | none; read fresh each turn | no effect | no |
| A. Product/variant id lists | poor (SupaEasy ignores ids) | exact only while copied | low | low | high; copied lists drift | needs a copy refresh | yes, or a sync job |
| B. Collection membership | poor for (1) | good for trousers/shorts **if** the collections are the ones the adding path uses (live step collections today; `men-golf-*` after the Asim theme ships) | medium | needs collections in the mirror (Admin walk, as `catalog/bundles.ts` already does for deal steps) | minutes, via sync | picked up by sync | no, once built |
| C. Tags / product type | poor for (1) | exact for **polos on the live theme** (`bundle_threepolo` is the live stamping rule); not used for trousers/shorts | high; the mirror already holds tags | none | ≤60s (delta pull) | picked up by sync | no |
| D. Reuse the theme's qualification code | n/a | exact per path, but paths disagree (tag vs collection, live vs unpublished) | low; tied to theme releases | n/a server-side | changes with each theme release | theme edits | yes |
| E. Read SupaEasy configuration | exact trigger key, prices and threshold (readable today via `scripts-migrator` metafields) | none (no product rule exists there) | medium; a script parse | one Admin read per sync | changes with SupaEasy edits | no effect | no |
| F. Page configuration (the pack page's step collections / the gender card's `script_properties`) | n/a | exact for the page that stamps the trigger | medium | theme file read, as `catalog/bundles.ts` already does | theme edits | picked up on reload | no |

Recommendation from the evidence:
- **For progress (1)**, count units on lines carrying the trigger key, read from the real cart's `properties`. This is the only rule SupaEasy applies. Read the trigger key, threshold and market price from the SupaEasy configuration (E) rather than hard-coding them.
- **For suggesting and adding (2)**, mirror whichever theme path the customer's add will go through:
  - polos: tag `bundle_threepolo` on the live theme (C), or `all-polos` + mens on the Asim theme once published (B/F);
  - trousers and shorts: the pack page's step collections (B/F).
  Which theme is authoritative after launch needs a decision (see Blockers).

---

## Required Caddie data changes

Needed later, not made now:

1. **Caddie's own adds must write the trigger property** (and `__data_three_polo` for polos, if keeping parity with `QUICK_CART`), or they will never qualify. This is a change to the add path in widget and server, and to the `cart-ops` contract.
2. **Trousers and shorts on the live theme** are only discounted as v4 pack lines from the pack page. Whether Caddie should stamp the bare trigger on single adds is a commercial decision. SupaEasy would accept it, but the theme never does it.
3. **Price and discount fields in `BasketSync`**, for verification (see "Discount evidence available").
4. **Collection membership in the catalogue mirror**, only if option B/F is chosen for trousers and shorts. `catalog/bundles.ts collectionProducts` already has the Admin walk.
5. **SupaEasy configuration reader**, to take trigger key, threshold and market prices from the live discounts, if option E is adopted. The token can read `scripts-migrator.*` metafields today.

---

## Experiments still required

On a development theme or unpublished preview, with a throwaway cart:

1. **Line-level `/cart.js` fields**: add a triggered polo and confirm `line_level_discount_allocations`, `discount_application.title = "ANY 3 POLO BUNDLE"`, `original_line_price` and `final_line_price` on this store.
2. **One line, quantity 3** of a stamped polo: confirm the £59.99 set applies (the scripts say yes).
3. **Trousers variant targeting**: two stamped trousers plus a third, unstamped line of the **same** variant. Confirm whether the discount leaks onto the unstamped line.
4. **Bare trigger outside a pack**: add two men's trousers via `/cart/add.js` with only `__any-2-trousers=any-2-trousers` and no v4 properties. Confirm "ANY 2 TROUSERS" applies. This decides requirement 2 above.
5. **`attribute_2` key** on the trousers/shorts functions: find what SupaEasy binds it to. It needs SupaEasy UI access or its input query.
6. **Ladies `pC`**: confirm whether LADIES ANY 3 POLO restricts by its collections.
7. **Unpublished builder**: confirm what `sport-quick-cart-bundle.js` writes per line (properties, `_data_bundle_id`), before that theme is published.
8. **Condition-pack builder `RE_RENDER_DRAWER`** (carried over from Phase 1).

---

## Blockers

1. **Can we deterministically tell whether a cart line qualifies for Any 3 Polos?** **YES**, for the line as it is in the cart: it has `__3_Polo_Bundle` with a non-empty value, and every unit counts. That is exactly SupaEasy's test, and `BasketSync.properties` already carries it. **PARTIALLY** for "would this product qualify if added", which depends on the adding path (tag on the live theme, `all-polos` on the unpublished one; 114 products differ).
2. **Can we deterministically tell whether a line qualifies for Any 2 Men's Trousers?** **YES** for a line in the cart (the `__any-2-trousers` key), with one open point: the unbound `attribute_2` slot could make other lines qualify (experiment 5). **PARTIALLY** for products: the live pack page uses `any-2-trousers-step-*` (25 products); the unpublished theme uses `men-golf-trousers` (33).
3. **Can we deterministically tell whether a line qualifies for Any 2 Shorts?** **YES** for a line in the cart (`__any-2-trouser-shorts`), with the same `attribute_2` caveat. **PARTIALLY** for products (33 live vs 39 unpublished).
4. **Do we need to extend Caddie's catalogue mirror with collections or other fields?** **MAYBE.** Not for progress, which is trigger-based. Yes for suggesting qualifying trousers and shorts if the chosen source is collections. Not for polos on the live theme, since tags are already in the mirror.
5. **Is any live/dev-theme experiment required before coding the evaluator?** Yes: experiments 1, 3, 4 and 5 above. 2, 6 and 7 are confirmations.

Decisions needed from the business:
- Which theme's qualifying sets are authoritative once the Asim theme ships.
- Whether Caddie may stamp triggers on single adds.
- What to do about `__three-polo-deal` (stamped by a live page, read by nothing).

---

## Recommendation for Phase 3

1. Build the evaluator on **triggered units in the real cart**: key, threshold and market price taken from the live SupaEasy discounts; progress = count of units on lines with the key; one-away = threshold − 1. No product lists, no LLM.
2. Keep **qualifying-product lookup** separate and path-specific (tag for live polos; the pack page's step collections for trousers and shorts). Pick the source after the theme decision.
3. Before any Caddie add is expected to count, agree and implement **stamping the trigger on Caddie's adds** (contract change, Amir's widget and the server gateway).
4. Run experiments 1, 3, 4 and 5 on a development theme first; they decide the verification fields and whether single-add stamping works for trousers and shorts.
5. Leave ladies and kids polos out of V1 until one canonical ladies function exists.
