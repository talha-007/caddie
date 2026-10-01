# Smart Cart

Written for: the Caddie team (Talha, Amir) and the web team (Asim).

Druids' multi-buy deals are priced at checkout by SupaEasy, a Shopify discount app:

| Deal | UK price | Units |
| --- | --- | --- |
| Any 3 Polos | £59.99 | 3 |
| Any 2 Men's Trousers | £49 | 2 |
| Any 2 Shorts | £45 | 2 |

SupaEasy discounts a cart line **only** when it carries the deal's trigger property. It never looks at the product itself. Some of the theme's add buttons attach the trigger and some don't, so a customer can hold three qualifying polos and still pay full price.

Smart Cart makes the Caddie's own adds attach the trigger, and shows the customer how close they are to each deal. **SupaEasy stays the only thing that prices anything.**

Status: working on the copied theme ("Copy of  DRUIDS - SPORT TYPE - AsimAli", `159899418724`), behind a flag. The live theme is unchanged.

## How it works

1. **The Caddie reads the real cart.** Every chat and voice turn reads `/cart.js` first. Cart changes made with the theme's own buttons are picked up too:
   - on the live theme, through `RE_RENDER_DRAWER`;
   - on the copied theme, through `#cart-drawer` being redrawn;
   - anywhere, through `cart:refresh` / `cart:update` events.

   Code: `apps/widget/src/lib/themeCart.ts`.
2. **The server counts progress** from the trigger properties on the cart lines, exactly as SupaEasy reads them. A value that is present and non-empty counts, and quantity counts as units. Nothing is inferred from the product's name, type, tag or collection. Code: `apps/server/src/smartCart/evaluate.ts`.
3. **Caddie adds attach the trigger** when the theme turns the preview on. The rule for which products qualify is the theme's own:

| Deal | Trigger stamped | Qualifies by |
| --- | --- | --- |
| Any 3 Polos | `__3_Polo_Bundle = 3_Polo_Bundle` | product tag `bundle_threepolo` |
| Any 2 Men's Trousers | `__any-2-trousers = any-2-trousers` | collection `men-golf-trousers` |
| Any 2 Shorts | `__any-2-trouser-shorts = any-2-trouser-shorts` | collection `men-golf-shorts` |

   Code: `smartCart/eligibility.ts`, the add planner in `tools/index.ts`, and `smartCart/config.ts`.
   - Collection membership is loaded from the Admin API at boot and at every reconcile; `/health` shows it under `smartCart`. Until it has loaded, trousers and shorts are added unstamped: full price, never a wrong discount.
   - A product that would match two deals is stamped for neither.
   - The cart-outcome check expects the add on the line carrying exactly the properties sent.
4. **The price check.** SupaEasy discounts a set only by what its items' **sale** prices come to above the deal price, and most Druids stock is already reduced. So the server asks whether the deal would lower the price at all, and hides the card when it wouldn't (e.g. two £20 joggers against 2 for £49). It uses the catalogue's variant prices, GBP only; any other currency returns "can't tell" and shows neutral wording. The deal price is used only for this yes/no. Code: `smartCart/value.ts`.
5. **The Caddie basket** shows a deal card per deal in progress: dots, the deal, one sentence, and **Show me polos / trousers / shorts** when a qualifying product would make the deal worth it. Suggestions are deterministic: in stock, not already in the basket, priced so the set saves something, cheapest first (`POST /api/session/:id/smart-cart/suggest`). Code: `apps/widget/src/components/SmartCartProgress.tsx` and `lib/smartCart.ts`.

The card never says "save", "saving", "unlock", "£x off" or "your price". Tests check this.

| Basket | Card |
| --- | --- |
| 1 of 3 polos | ●○○ POLO DEAL · 3 FOR £59.99 — "Add 2 more polos to complete the deal" [Show me polos] |
| 2 of 3 polos | ●●○ (highlighted) — "Just 1 more polo to complete the deal" |
| 3 of 3 polos | ●●● (dark) — "Your polos qualify for 3 for £59.99" · "The deal price is worked out at checkout." |
| 1 pair of trousers | ●○ TROUSER DEAL · 2 FOR £49 — "Just 1 more pair of trousers to complete the deal" |
| Deal would save nothing | no card |

## Turning it on (copied theme only)

1. **Deploy this code's server** to the API the build points at. An older server returns no Smart Cart state, and the preview stays blank.
2. **Build the widget** for that API:

   ```bash
   cd apps/widget
   VITE_CADDIE_API_URL=https://caddie.druids.online npx vite build --mode production --outDir builds/live --emptyOutDir
   VITE_CADDIE_API_URL=https://n64krb4g-8787.inc1.devtunnels.ms npx vite build --mode production --outDir builds/local --emptyOutDir
   ```

   `builds/` is git-ignored.
3. **Upload** `builds/<target>/caddie.js` and `caddie.css` to the copied theme's assets, never the live theme's.
4. **Set the flag** on the Caddie mount node in the copied theme's `layout/theme.liquid`:

   ```liquid
   <div id="druids-caddie"
     data-smart-cart-preview="true"
     {% if template contains 'product' %}
   ```

   Add `data-smart-cart-debug="true"` as well to show the tester's line (status, triggered units, whether the deal lowers the price, evaluation time). Remove it before anyone other than testers sees the preview.

Without `data-smart-cart-preview`, the widget sends no `x-caddie-smart-cart` header. The server then stamps nothing and the card never renders. The header is re-read on every request, so a session moving to the live theme stops stamping on its next add.

## Testing

On `https://www.druids.com/?preview_theme_id=159899418724`, in a private window, add through the **Caddie** and compare with the Shopify bag and `/cart.js`:

- Two Men's Clima Golf Trousers at £30 each should give **£49** ("ANY 2 TROUSERS" under the line).
- Two Comfort Shorts at £26 each should give **£45** ("ANY 2 SHORTS").
- Three polos: the deal takes off only what their sale prices come to above £59.99. Three polos at £18, £18 and £24 (£60.00) saved **£0.01**, which is correct.
- Items added with the theme's own trousers or shorts buttons carry no trigger and aren't discounted. That's a theme gap.

Confirmed by hand on 1 Oct 2026; see `research/checkout-verification.md`.

## Contract (`packages/shared`)

- **`CartAction` `add` lines and `CartExpectation.add`:** optional `properties`. It is only ever a trigger the server chose.
- **`BasketSync`:** optional `currency`.
- **`POST /api/session/:id/basket`** returns `BasketSyncResponse { ok, lines, smartCart }`. `SmartCartView` carries progress, `worthwhile` and `canSuggest` per deal, and display wording only: no line keys, variant ids or prices.
- **Header:** `SMART_CART_HEADER` (`x-caddie-smart-cart: preview`).
- **Suggest route:** `SmartCartSuggestRequest` / `SmartCartSuggestResponse`.

Deploy the widget and server together. An older widget ignores `properties`, so a stamped add lands plain and is reported as unconfirmed.

## Not done

- **The real saving in the Caddie basket** ("Deal saving −£x", pre-deal prices crossed out), read from `/cart.js`. It needs the raw discount fields captured once.
- **Theme side (web team):**
  - attach the trigger on the theme's own trousers and shorts buttons and the Complete the Look "+";
  - show deal progress and the saving in the cart drawer.
- **Later:** chat wording about deal progress, labels on basket lines, and ladies and kids deals (several conflicting SupaEasy discounts; see `research/supaeasy-and-theme.md`).
- **Untested edge cases:** a trousers deal when the same variant is also in the cart without the trigger, and a line carrying two triggers.

## For the theme team

`BRIEF.md` explains the whole of Smart Cart for the Druids team. `ASIM.md` is the theme developer's brief: the keys, the theme files and what to keep when editing them. `theme-snippets/` holds the 7 theme files applied to the copied theme, with a `README.md` on how to apply them.

## Research

- `research/supaeasy-and-theme.md`: the SupaEasy configuration of every deal, which theme routes attach which trigger, the live theme compared with the copied theme, and the ladies polo conflict.
- `research/checkout-verification.md`: the checkout tests and what they proved.
- `research/eligible/*.json`: the qualifying product lists taken from both themes on 30 Sep 2026.
