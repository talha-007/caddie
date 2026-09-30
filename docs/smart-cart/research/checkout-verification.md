# Smart Cart Phase 4: checkout verification

Written for: the Caddie team (Talha, Amir), and whoever approves the cart experiments.

Branch `smart-cart-phase-4`, made from `smart-cart-phase-3`. No code changed, nothing committed.

## Update, 1 Oct 2026: tested by hand on the copied theme

Talha ran the tests by hand in a private browser on the unpublished theme (`159899418724`), against a local server on `smart-cart-widget-preview`. Lines were added **through the Caddie**, which attaches only the trigger. The evidence is the Shopify cart drawer and the Caddie basket, both reading the same cart. **The raw `/cart.js` JSON was not captured**, so the exact line-level field names below remain UNVERIFIED.

| Test | Basket | Observed | Result |
| --- | --- | --- | --- |
| Any 3 Polos | Legacy Polo Grey £18 + Legacy Polo Black £18 + Abstract Emotive White £24 (£60.00) | Subtotal **£59.99**; Grey line shown at £17.99 | **Applied.** Saving £0.01, exactly sale total − £59.99, as the script says |
| Any 2 Men's Trousers, bare trigger | Men's Clima Golf Trousers Black 30/30 **× 2 on one line**, £30 each | Line at **£24.50** each (was £30.00), labelled **"ANY 2 TROUSERS"** | **Applied.** £60 → £49 |
| Any 2 Shorts, bare trigger | Comfort Shorts Navy 30 **× 2 on one line**, £26 each | Line at **£22.50** each (was £26.00), labelled **"ANY 2 SHORTS"** | **Applied.** £52 → £45 |
| Both in one basket | the two lines above | Subtotal **£94.00** (from £112.00) | both deals applied independently |
| Trousers + shorts added with the **theme's own** Add buttons | 1 trousers + 1 shorts | no trigger on the lines; no deal card in the Caddie | expected: those theme routes don't stamp |

What this proves:
- **A bare trigger works for trousers and shorts.** Ordinary lines carrying only `__any-2-trousers` / `__any-2-trouser-shorts` (plus nothing from the v4 pack builder) get the deal. The "bare trouser trigger experiment" question is answered **yes**.
- **Quantity on one line counts as units.** A single line of quantity 2 met each threshold, as the static analysis predicted.
- **Caddie-stamped lines are discounted by SupaEasy.**
- **The saving is the gap between sale prices and the deal price, and can be pennies.** The polo basket saved £0.01 because the three polos already cost £60.00 at sale prices. SupaEasy is behaving as written. Whether a deal that small should be promoted is a business decision; the Caddie applies no minimum of its own.
- **The drawer shows it applied** by printing the discount title under the line and crossing out the pre-deal price.

Still not verified: the exact `/cart.js` field names and values (`line_level_discount_allocations`, `discount_application.title`, `original_line_price`, `final_line_price`, `total_discount`). Also untested: the variant-target leak case and a line carrying two triggers.

## Status on 30 Sep: STOPPED before the experiments

**The cart experiments (Tasks 2 to 6 and 8) were not run.** Every cart on this store is a live-store cart, because there is no development store and no development theme. Creating even an anonymous throwaway cart means writing to the production storefront's cart API. After the first attempt, which changed nothing (see below), the session's permission check refused further cart writes to the live store. The brief says: *"If a safe development cart cannot be used, STOP and report that rather than performing experiments on production."* So I stopped.

The work that needs only reads is done: the environment, the cart-level schema, `attribute_2`, and a proposed verification contract. The experiment runner is written and ready (see "Recommendation for Phase 5"). It needs your explicit go-ahead, or it can be run on a proper development store.

---

## Safe environment used

| Check | Finding |
| --- | --- |
| Theme | `159899418724`, "Copy of  DRUIDS - SPORT TYPE - AsimAli", confirmed **role `UNPUBLISHED`** through the Admin API (updated 2026-09-29). Live theme: `159972884580` "Autumn 2026", `MAIN`. |
| Development theme | **None.** `themes(roles: DEVELOPMENT)` returns nothing. |
| Development store | **None.** The old test store is gone (CLAUDE.md). |
| Route | `https://www.druids.com/<path>?preview_theme_id=159899418724`, from a fresh cookie jar with no customer login. Market set to GB through `/localization`. `/cart.js` reported `currency: "GBP"`. |
| Disposable cart | Yes in principle: a new anonymous cart tied to no customer, never checked out, to be cleared with `/cart/clear.js`. **However, a preview theme does not isolate the cart.** Carts and discount Functions are store-wide, so the experiment would still run on the production store's cart and discount engine. |
| SupaEasy | Not changed. Only read, through `discountNodes` and metafields, with the read-only Admin token. |
| Customer baskets | None touched. A new anonymous cart cannot reach another shopper's cart. |
| Side effects of an anonymous cart | Adding to a cart does not reserve stock, sends no email, and makes no order. It may appear in Shopify's "added to cart" session analytics. |

### What was actually sent

The polo run was the first and only attempt:
- **6 `POST /cart/add.js`**: all rejected `400 Required parameter missing or invalid: items`. The cause is not confirmed; the check was refused. The likely cause is a redirect dropping the JSON body.
- **1 `POST /cart/change.js`**: rejected `400`.
- **1 `POST /cart/clear.js`**.

All six `/cart.js` reads in that run are byte-identical: an empty cart, `item_count: 0`. **No line was ever created.** No further cart request was made after the refusal.

## Actual /cart.js discount schema

**Cart level, observed on this store** (anonymous GET, empty cart, token redacted):

```json
{
  "token": "<redacted>", "note": null, "attributes": {},
  "original_total_price": 0, "total_price": 0, "total_discount": 0,
  "total_weight": 0.0, "item_count": 0, "items": [],
  "requires_shipping": false, "currency": "GBP",
  "items_subtotal_price": 0,
  "cart_level_discount_applications": [], "discount_codes": []
}
```

Present: `original_total_price`, `items_subtotal_price`, `total_price`, `total_discount`, `currency`, `cart_level_discount_applications`, `discount_codes`. All amounts are in minor units (pence).

**Line level: NOT OBSERVED.** It needs a line in a cart. The fields Shopify documents are `original_price`, `discounted_price`, `final_price`, `original_line_price`, `line_price`, `final_line_price`, `total_discount`, `line_level_total_discount`, `discounts[]`, and `line_level_discount_allocations[] { amount, discount_application { type, title, description, value, value_type, allocation_method, target_selection, target_type } }`.

The widget's own `AjaxCart` type already reads `final_price` and `final_line_price`, so those two are known to exist here. Whether this store fills `line_level_discount_allocations` for SupaEasy's Function discounts, and what `title` it carries, is **UNVERIFIED**.

The minimum fields for A to E, as a hypothesis until an experiment confirms them:

| Need | Field | Status |
| --- | --- | --- |
| A. enough triggered units | `items[].properties[trigger]`, `items[].quantity` (Phase 3 already reads these) | confirmed |
| B. the discount actually applied | `items[].line_level_discount_allocations[]` non-empty on triggered lines, and `final_line_price < original_line_price` | **unverified** |
| C. the actual saving | the sum of `line_level_discount_allocations[].amount` (or `original_line_price − final_line_price`) over the offer's lines | **unverified** |
| D. currency | cart `currency` | confirmed (`GBP`) |
| E. which offer | `discount_application.title`, expected to be the SupaEasy message (`ANY 3 POLO BUNDLE`, `ANY 2 TROUSERS`, `ANY 2 SHORTS`) | **unverified** |

## Polo baseline results

**NOT RUN.** The runner builds a cart with the exact properties the theme's `QUICK_CART` writes (`snippets/application_script.liquid:187-196`):

```json
{ "__Localization": "GB", "__Product_Url": "/products/abstract-emotive-black",
  "__data_three_polo": "3_Polo_Bundle", "__3_Polo_Bundle": "3_Polo_Bundle" }
```

- **Products:** three Abstract Emotive polos, XL, £24 each, all tagged `bundle_threepolo`. Three cost £72 against £59.99, so an expected saving of £12.01 if the static analysis holds.
- **States to capture:** 1 → 2 → 3 lines → back to 2 (trigger kept) → 3 again; one line of quantity 3 → 2 → 4; three untriggered polos as a control.

## Bare trouser trigger result

**NOT RUN. UNVERIFIED.**

- **Products:** two Men's Clima Golf Trousers, 30/30, £30 each, both in the live `any-2-trousers-step-*` collections. Two cost £60 against £49, so a saving of £11 is expected.
- **Properties:** only `__Localization`, `__Product_Url` and `__any-2-trousers = any-2-trousers`, with no v4 pack properties. There is also a trigger-only variant of the test.

Note on choosing products: most live-universe trousers are sale-priced at £20 (the joggers), and two of them cost £40, under the £49 pack price. The SupaEasy script skips a set that costs no more than the pack price, so **a correct bare-trigger test must use trousers whose pair costs more than £49**. The same applies to Smart Cart messaging later: QUALIFIED with no saving is a real outcome.

## Bare shorts trigger result

**NOT RUN. UNVERIFIED.**

- **Products:** two Comfort Shorts, size 30, £26 each, in the live shorts step collections. Two cost £52 against £45, so an expected saving of £7.
- **Pricing trap:** a pair of Clima shorts at £24 each costs £48 and would save only £3. Sale lines at £15 to £16 would save nothing.

## Variant-target behaviour

**NOT RUN. UNVERIFIED.**

- **Planned:** trouser X with the trigger, plus trouser Y with the trigger, plus X again untriggered. The untriggered line carries different properties, so Shopify should keep it as a separate line; the runner counts X's lines to confirm that.
- **Second case:** X triggered plus X plain first, then Y triggered.
- **Shorts:** repeated for shorts as well.

What the script does (Phase 2, static): the trousers and shorts discounts target `productVariant: { id }` with no quantity. So whether Shopify spreads the discount onto the untriggered X line is exactly what needs observing.

## attribute_2 result

**UNCLEAR. Probably reads nothing today.** Found by read-only means:

- **Who uses it:** `ANY 2 TROUSERS MENS` and `ANY 2 SHORTS` (and `LADIES ANY 2 TROUSERS`, `KIDS ANY 2 TROUSERS`, `KIDS LAYERING DUO`) check `[line.attribute, line.attribute_2]`. `ANY 3 POLO COLLECTION` checks `line.attribute` only.
- **One shared function:** all of these run the **same SupaEasy function** (`functionId edd1e5e5-…`, input `productDiscount_multi_mix`), so they share one input query. The per-discount settings carry `paK`, then `paK2` to `paK6`, and **`paK2` is `""` on both V1 discounts**. The likely binding is `attribute_2 ← attribute(key: paK2)`, which would read a blank key and return nothing. This is an inference, not a reading.
- **Input query not readable:** `shopifyFunctions` lists only the calling app's functions (it returned 0), and the metafields hold the script, not the input query.
- **Vestigial:** SupaEasy's saved build chat on `RAINSUIT SPECIAL MENS` (2026-05-07) has a Druids developer asking *"I see reference of line.attribute_2 but that's not supposed to be used by the code, why is it there?"*. SupaEasy then removed it from that discount only. That points to leftover template code, not a real second trigger.
- **Settle it:** read it in the SupaEasy app, or run a test with a line carrying an unrelated property and no trigger.

## Dual-trigger result

**NOT RUN. UNVERIFIED.**

- **Planned:** two triggered polos, plus one trouser line carrying both `__3_Polo_Bundle` and `__any-2-trousers`, plus one triggered trouser.
- **Combination settings (static):** both discounts allow combining with other product discounts. Polo `productDiscounts: true`; trousers `productDiscounts: true`.

## Proposed discount verification contract

Proposed only; BasketSync is not extended. It is built on the observed cart fields plus the documented line fields, and each unverified field is marked so it can be confirmed or dropped after the experiment.

```ts
// BasketSync, cart level
currency: string;                 // cart.currency              (observed)
originalTotal?: number;           // cart.original_total_price  (observed, minor units)
finalTotal?: number;              // cart.total_price           (observed)
totalDiscount?: number;           // cart.total_discount        (observed)

// BasketSync, per line
originalLinePrice?: number;       // item.original_line_price   (unverified)
finalLinePrice?: number;          // item.final_line_price      (read by the widget today)
lineLevelTotalDiscount?: number;  // item.line_level_total_discount (unverified)
discountAllocations?: Array<{     // item.line_level_discount_allocations (unverified)
  amount: number;                 //   .amount
  title?: string;                 //   .discount_application.title
  type?: string;                  //   .discount_application.type ("automatic" expected)
}>;
```

Answers, pending the experiment:

- **What proves an offer applied:** an allocation on the offer's **triggered lines**, and `final_line_price < original_line_price` on them. It must not be a cart-level total, which mixes in other discounts.
- **Whether to trust the title:** as a label only. It is the SupaEasy "message", edited freely in the app (`ANY 3 POLO BUNDLE`), and not an identifier. Match it against the message read from the live SupaEasy configuration, never against a hard-coded string.
- **Fallback when titles differ or are missing:** attribute by line. An allocation that appears only on lines carrying offer X's trigger belongs to X. That is ambiguous only on a dual-trigger line, which no live path makes.
- **The saving:** **read it**, as the sum of `amount` over the offer's lines, converted once through the existing money conversion. Never compute `sum − pack price`. If the variant-leakage experiment shows discount landing on untriggered lines of the same variant, those amounts belong to the offer too, and the triggered-lines rule must widen to the variant for trousers and shorts.

## Go/no-go for Caddie trigger stamping

> **Superseded on 1 Oct by the hand tests above.** Polos: **YES**. Trousers: **YES**. Shorts: **YES**. Discount verification: **PARTIALLY**: the discount title and the reduced line price are visible, but the `/cart.js` field names are still not captured. The 30 Sep answers follow for the record.

### POLOS: **NO (not proven)**

The static evidence is strong: a property-only rule, and the theme's quick-add path writes exactly this. But no cart has shown the discount on this store, and the brief requires the real `/cart.js`. Run the polo baseline first.

### TROUSERS: **NO (not proven)**

Whether a bare `__any-2-trousers` works outside the v4 builder is the key unanswered question. Statically, the SupaEasy script needs nothing else. But the v4 pack lines also carry `__bundle_version_2`, which triggers the "Bundle discount reject" rule, and price properties that a legacy script reads. Neither is proven irrelevant to this discount. Variant-target leakage is also unmeasured.

### SHORTS: **NO (not proven)**

Same as trousers.

### DISCOUNT VERIFICATION: **PARTIALLY**

The cart-level fields exist on this store: `currency`, `original_total_price`, `total_price`, `total_discount`, `cart_level_discount_applications`, `discount_codes`. They cannot attribute a saving to an offer. The line-level fields that would (`line_level_discount_allocations[].amount` / `.discount_application.title`, `original_line_price`, `final_line_price`) are unverified for SupaEasy Function discounts here.

## Remaining risks

- **Everything above is unverified** until a real cart is observed.
- **Price traps:** sale-priced pairs and trios can qualify and still save nothing (the script skips a set costing no more than the pack price). QUALIFIED ≠ saving.
- **Variant targeting** on trousers and shorts may spread the discount onto an untriggered line of the same variant.
- **`attribute_2`** is probably empty, but not confirmed.
- **Preview themes do not isolate carts:** any future experiment on this store touches the production discount engine. A development store with SupaEasy installed and the three discounts copied would be the only fully isolated environment.
- **Runner not yet working:** the first attempt's adds were refused with 400, probably because a redirect dropped the JSON body. This is unconfirmed; the check itself was refused. Fix it before running.

## Recommendation for Phase 5

1. **Decide the environment.** One of:
   - **(a) Explicitly approve** running the prepared runner on the live store: new anonymous carts, the preview theme, cleared after each run, no checkout, about 60 cart calls in total. Add a permission rule, or run it yourself. The runner is `scratchpad/p4/run.py` with helpers `cart.py` / `env.py`, not in the repository. Its experiments are `polo`, `poloqty`, `polocontrol`, `trousers`, `trousersmin`, `shorts`, `leak`, `leak2`, `shortsleak`, `dual`. It needs the 400 on add fixed first (see "Remaining risks").
   - **(b) Do the same by hand** in a private browser window on the preview theme, copying `/cart.js` after each state.
   - **(c) Set up a development store** with SupaEasy and copies of the three discounts.
2. **Fill this report's UNVERIFIED sections** from the captures, and settle the verification contract.
3. **Only then** extend BasketSync with the confirmed fields, and design trigger stamping for polos first.
4. Trousers and shorts wait for the bare-trigger and leakage results.

Phase 4 stops here.
