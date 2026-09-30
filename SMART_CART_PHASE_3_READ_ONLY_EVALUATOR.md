# Smart Cart Phase 3: read-only evaluator

Written for: the Caddie team (Talha, Amir) and whoever builds Smart Cart Phase 4.

Branch `smart-cart-phase-3`, created from `smart-cart-phase-1`, whose Phase 1 changes are still uncommitted and are carried in the same working tree. Not committed, not deployed.

The server now keeps, on every session, how far the real cart has got towards each V1 offer. It works this out from the line properties of each fresh cart read, using the rule SupaEasy applies. Nothing reads it yet: no prompt, no tool, no UI.

---

## Files changed

| File | Change |
| --- | --- |
| `apps/server/src/smartCart/types.ts` | New. The domain types. |
| `apps/server/src/smartCart/config.ts` | New. The three V1 offers (static). |
| `apps/server/src/smartCart/evaluate.ts` | New. `hasTrigger`, `progressStatus`, `evaluateSmartCart` (all pure functions). |
| `apps/server/src/smartCart/index.ts` | New. Exports. |
| `apps/server/src/session/store.ts` | `CaddieSession.smartCart?: SmartCartState`. |
| `apps/server/src/tools/cartOperations.ts` | New `basketPatch(lines)` returns `{ basket, smartCart }` from one cart read. `basketFromSync` now shares its line filter (`keptLines`) and is otherwise unchanged. `settleOutcome` applies `basketPatch` where it applied `basketFromSync`. |
| `apps/server/src/routes/chat.ts` | The chat message's basket is applied through `basketPatch`. |
| `apps/server/src/routes/session.ts` | `POST /api/session/:id/basket` is applied through `basketPatch`. |
| `apps/server/test/smartCart.test.ts` | New, 42 tests. |
| `apps/server/test/smartCartSession.test.ts` | New, 8 tests. |

No other files changed. The widget, `packages/shared`, the prompt, tools and the Action Gateway are untouched. No existing test was changed.

The session's `basket` lines keep only a fingerprint of their properties, never the values, so Smart Cart cannot be computed from `session.basket`. It is computed from the same BasketSync lines at the moment they are applied. Both use the same filter (`keptLines`: a string key and product id, first 100 lines), so `matchedLineKeys` always refer to lines in `session.basket`.

## Smart Cart types

```ts
type SmartCartOfferId = 'any-3-polos' | 'any-2-mens-trousers' | 'any-2-shorts';
type SmartCartProgressStatus = 'INACTIVE' | 'IN_PROGRESS' | 'ONE_AWAY' | 'QUALIFIED';

interface SmartCartOfferConfig { id; name; triggerKey; threshold; display?: { deal: string } } // display is metadata only
interface SmartCartOfferState {
  offerId; triggerKey; status;
  qualifyingUnits;     // not capped
  requiredUnits;       // = threshold
  remainingUnits;      // max(threshold - units, 0)
  matchedLineKeys;     // in cart order
  matchedVariantIds;   // numeric, deduplicated
}
interface SmartCartState { offers: SmartCartOfferState[]; evaluatedAt: number }
interface SmartCartLine { key; variantId?; quantity; properties? }  // what BasketSync carries
```

`primaryOffer` is left out, because nothing yet gives a deterministic reason to pick one. `evaluatedAt` is there because the read it came from can be stale (see "Stale basket behaviour").

## Config

| Offer | `triggerKey` | Threshold | `display.deal` (display only) |
| --- | --- | --- | --- |
| Any 3 Polos | `__3_Polo_Bundle` | 3 | 3 for £59.99 |
| Any 2 Men's Trousers | `__any-2-trousers` | 2 | 2 for £49 |
| Any 2 Shorts | `__any-2-trouser-shorts` | 2 | 2 for £45 |

- `evaluateSmartCart(lines, offers = SMART_CART_OFFERS)` takes the offers as an argument, so a live SupaEasy configuration reader can replace the static list without changing the evaluator. A test proves this.
- The display wording is never parsed or used in arithmetic. A test changes it and shows the state is identical. The prices are UK only.
- These triggers are deliberately left out:
  - `__three-polo-deal`, which no active discount reads;
  - every ladies and kids trigger (`__bundle_threepolo_ladies`, `__any-three-ladies-polos`, `__bundle_threepolo_kids`, `__any-2-shorts`, `__ladies-any-2-trousers`, `__kids-any-2-trousers`).

  A test asserts they are absent and never count.

## Exact evaluation rules

For each offer, independently:

1. **Trigger test (`hasTrigger`):** the line's `properties[triggerKey]` is a string and is not `""`.
2. **Units:** `floor(quantity)` when it is positive, otherwise 0. A line with 0 units matches nothing.
3. `qualifyingUnits` = the sum of units over matching lines. Distinct lines are not grouped or required, and the total is not capped.
4. **Status:**
   - 0 → `INACTIVE`
   - ≥ threshold → `QUALIFIED`
   - = threshold − 1 → `ONE_AWAY`
   - anything else → `IN_PROGRESS`
5. `remainingUnits` = `max(threshold − qualifyingUnits, 0)`.

Nothing about the product is read: not its name, type, tag, collection, price or pack membership.

### A whitespace-only value counts, which differs from the brief

The brief says the value must be non-empty "after normal string handling". The live SupaEasy script tests exactly this, with no trim:

```js
attribute && attribute.value !== null && attribute.value !== ""
```

So SupaEasy counts `"   "`. The evaluator mirrors SupaEasy: if it trimmed, it would report "not yet" for a set that checkout has already discounted. No theme path writes such a value, so this only matters in principle. If you prefer trimming, it is one line in `hasTrigger`, and the matching test is labelled.

### Other edge cases

| Case | Result |
| --- | --- |
| Trigger missing, `properties` absent or `null` | does not count |
| `""` | does not count |
| Whitespace only | **counts** (as SupaEasy does) |
| `null` / `undefined` value | does not count |
| A value that is not a string (number, object) | does not count. BasketSync carries strings; the widget stringifies every property, and anything else did not come from a cart read. SupaEasy only ever sees strings. |
| Any non-empty value, e.g. `"something else"` | counts; SupaEasy never compares the value |
| Key with different case, or without the `__` prefix | does not count; the key must match exactly |
| Unrelated properties | ignored |
| Same variant on several lines | each triggered line counts; the variant is listed once |
| Several offers in one basket | each counts only its own key |
| One line carrying two triggers | counts in full for both offers. No exclusion is invented, because the SupaEasy discounts each inspect only their own key. **No known live path writes such a line**, so what checkout does with one needs a real test later. |

## Examples

| Basket (triggered units) | Any 3 Polos | Any 2 Trousers | Any 2 Shorts |
| --- | --- | --- | --- |
| empty | INACTIVE 0, 3 left | INACTIVE 0, 2 left | INACTIVE 0, 2 left |
| 1 polo | IN_PROGRESS 1, 2 left | INACTIVE | INACTIVE |
| 2 polos on 2 lines | ONE_AWAY 2, 1 left | INACTIVE | INACTIVE |
| 1 polo line, qty 3 | QUALIFIED 3, 0 left | INACTIVE | INACTIVE |
| 4 polos | QUALIFIED 4 (not capped) | INACTIVE | INACTIVE |
| 3 untriggered polos (e.g. added by Caddie today) | INACTIVE | INACTIVE | INACTIVE |
| 1 trouser | INACTIVE | ONE_AWAY 1, 1 left | INACTIVE |
| 1 trouser line, qty 2 | INACTIVE | QUALIFIED 2 | INACTIVE |
| any-2-trousers pack (2 v4 lines with trigger) | INACTIVE | QUALIFIED 2 | INACTIVE |
| 1 short | INACTIVE | INACTIVE | ONE_AWAY 1 |
| 3 polos + 2 trousers + 1 short | QUALIFIED | QUALIFIED | ONE_AWAY |

## Pack and grouped-line behaviour

There is no pack rule at all. A line counts if and only if it carries the trigger.

- **Live any-2 trousers and shorts pages:** their v4 pack lines carry `__bundle_id`, `__Bundle_Name`, `__bundle_version_2`, the price properties and `__any-2-trousers` / `__any-2-trouser-shorts`. They **count**.
- **Trousers, shorts or polos inside an Ambassador, Prestige or other pack:** those lines carry `__<pack handle>` and no V1 trigger. They **do not count**.

Both cases are tested.

## Session integration points

Every place the server applies a fresh cart read now also sets `smartCart` from the same lines, in the same `sessions.patch` call:

| Where | When |
| --- | --- |
| `routes/chat.ts` | a chat message arrives with `basket` (theme mode), **before `converse()` runs** |
| `routes/session.ts` `POST /:id/basket` | the widget reports the cart (page load, after changes, theme re-renders, before a voice turn) |
| `tools/cartOperations.ts` `settleOutcome` | a cart outcome report carrying `after`, for the newest operation (applied, partial, failed or uncertain), exactly where the basket is set |

Unchanged:
- The dev-harness Storefront cart (`actionGateway.ts`, Storefront API mode) writes `basket` without properties and does not set `smartCart`. It is not the theme cart, so there are no SupaEasy triggers to read.
- **New chat** (`/restart`) writes a fresh record without `basket`, and so without `smartCart`. Both return with the next basket report.

`smartCart` is not injected into the model, the prompt, FACTS, the reply checker or SSE. No customer-facing text exists.

## Stale basket behaviour

| Situation | `smartCart` |
| --- | --- |
| The chat message has no basket (`/cart.js` failed or timed out; `chat.basket_missing` is logged) | **unchanged**. It is never recomputed from an invented empty basket, and stays consistent with `session.basket`, which is also kept. It may be stale until the next successful read; `evaluatedAt` shows how old. |
| No read has ever been made | **absent**, not an empty state |
| A cart really read as empty | all three offers `INACTIVE`, 0 units |
| An outcome for an older operation | unchanged, following the existing "the newest operation owns the basket" rule |
| An outcome with `after: null` | unchanged |

## Tests added

`apps/server/test/smartCart.test.ts` (42 tests, pure evaluator):
- **Config:** the exact three triggers and thresholds; `__three-polo-deal`, ladies and kids absent and never counted; every offer always reported, including for an empty basket.
- **Status:** thresholds 3 and 2 across 0 to 5 units.
- **Any 3 Polos:** empty; 1; 2 on two lines; quantity 3 on one line; 4 (uncapped); untriggered polos (plain, Caddie-style, and pack polos) don't count; empty trigger; `__data_three_polo` alone is not the trigger.
- **Any 2 Men's Trousers:** 1 → ONE_AWAY; 2 lines → QUALIFIED; quantity 2 on one line; v4 pack plus trigger counts; pack without trigger doesn't; empty trigger.
- **Any 2 Shorts:** the same cases, plus the ladies and kids `__any-2-shorts` not counting.
- **Property edge cases:** missing, `null` or absent properties; `""`; whitespace; `null` / `undefined` values; non-strings; any non-empty value; exact key; unrelated properties; same variant on several lines; quantity 0; no variant id.
- **Multi-offer:** polos plus trousers; all three at once; one line with two triggers counts for both.
- **Config replaceable:** a custom offer list works; display wording changes no number.

`apps/server/test/smartCartSession.test.ts` (8 tests, the real chat and session routes; `converse` replaced to record the state it saw):
1. A `/api/chat` basket is evaluated **before `converse()`**.
2. `/basket` re-evaluates, including going from IN_PROGRESS to QUALIFIED.
3. Untriggered lines leave every offer inactive while the basket still holds them.
4. A settled cart outcome re-evaluates from its `after` read. Caddie's own add lands as a plain line and does not count.
5. A cart really read as empty clears progress, through both chat and `/basket`.
6. A message with no basket leaves the state exactly as it was.
7. With no read ever made there is no state.
8. An outcome for an older operation doesn't overwrite the newer state.

## Test and typecheck results (30 Sep 2026)

| Check | Before (`smart-cart-phase-1` working tree, from the Phase 1 gate) | After |
| --- | --- | --- |
| `npm run typecheck` (all workspaces) | 0 errors | 0 errors |
| Server tests (vitest) | 75 files, 1,314 tests, all pass | **77 files, 1,364 tests, all pass** (+50) |
| Widget tests (vitest + jsdom) | 6 files, 42 tests, all pass | 6 files, 42 tests, all pass (no widget change) |

## What Phase 3 deliberately does NOT do

- It writes no cart lines or properties and stamps no triggers.
- It makes no SupaEasy read or change, and does not read the live SupaEasy configuration.
- It calculates no price, saving or discount, and never says an offer "is applied". QUALIFIED means only that enough triggered units are in the cart.
- It adds no UI, SSE event, prompt, FACTS, tool, reply-checker rule or customer-facing wording.
- It adds no qualifying-product lookup or recommendation (tags, collections, mirror changes).
- It makes no change to packs, `cart-ops/1`, `CartAction`, the Action Gateway or outcome settlement semantics.
- It adds no ladies or kids offers.

## Unresolved Phase 4/5 prerequisites

From Phase 2, still open:

1. **Caddie's adds carry no trigger**, so a Caddie-added polo, trouser or short never progresses an offer. Stamping needs a `cart-ops` contract change, touching Amir's widget and the gateway, plus the business decision on single-add stamping for trousers and shorts.
2. **Development-theme experiments:**
   - line-level `/cart.js` discount fields;
   - a bare `__any-2-trousers` on single adds;
   - trousers variant-target leakage onto an untriggered line of the same variant;
   - the key behind `attribute_2`.
3. **Verification fields:** BasketSync still drops `final_line_price`, `line_level_discount_allocations` and totals. Until they are carried, nothing can confirm that QUALIFIED was actually discounted.
4. **Live SupaEasy config reader** to replace `SMART_CART_OFFERS` (key, threshold, market price).
5. **Which theme is authoritative** for "which products qualify if added" (live tag and pack-page collections, or the Asim theme's collections).
6. **A line with two triggers:** confirm checkout behaviour if any path ever produces one.
7. **Whitespace-only trigger:** confirm or override the SupaEasy-mirroring choice above.
8. **Stale state exposure:** a later phase that speaks from `smartCart` should check `evaluatedAt` against the last `chat.basket_missing`.

## Confirmation

- No cart properties are written.
- No SupaEasy changes were made.
- No price is calculated.
- No offer is claimed as applied.
- No Caddie prompt or model integration exists yet.
- Ladies and kids offers remain excluded.

Phase 3 stops here.
