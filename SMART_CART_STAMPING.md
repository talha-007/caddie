# Smart Cart: Caddie stamping and honest nudges

Written for: Talha, Amir (the widget and shared-contract changes) and Asim (the copied theme it runs on).

Branch `smart-cart-widget-preview`. It builds on Phases 1 and 3 and the widget preview (`SMART_CART_WIDGET_PREVIEW.md`). Nothing is committed, uploaded or published.

## What it does

On the **copied theme only** (the Caddie mount node has `data-smart-cart-preview="true"`):

1. **The Caddie's own adds attach the offer trigger.** A product that qualifies for Any 3 Polos, Any 2 Men's Trousers or Any 2 Shorts goes into the store cart carrying `__3_Polo_Bundle`, `__any-2-trousers` or `__any-2-trouser-shorts`. That is the same property the theme's own Add buttons write, so SupaEasy prices it as part of the offer. Every Caddie add route stamps: chat, product cards, "add everything", a waiting "yes", voice.
2. **Nudges appear only when the offer would lower the price.** Most Druids stock is already on sale. SupaEasy discounts a set only by what it costs above the deal price, so two £20 joggers against "2 for £49" save nothing. The server now checks this, and the widget hides the nudge when the answer is no.
3. **"Show me polos" / "Show me trousers" / "Show me shorts".** Under a worthwhile nudge there is a button that suggests qualifying products priced so that finishing the set really saves money. The products appear as normal cards in the chat, and adding one is stamped like any other Caddie add.

On the **live theme** nothing changes. The widget doesn't send the preview header, so the server stamps nothing and the preview doesn't render.

## Which products qualify

| Offer | Trigger stamped | Qualifies by | Source of the rule |
| --- | --- | --- | --- |
| Any 3 Polos | `__3_Polo_Bundle = 3_Polo_Bundle` | product tag `bundle_threepolo` (any case) | the theme's `QUICK_CART`, live and copied |
| Any 2 Men's Trousers | `__any-2-trousers = any-2-trousers` | the `men-golf-trousers` collection | the copied theme's trousers deal page |
| Any 2 Shorts | `__any-2-trouser-shorts = any-2-trouser-shorts` | the `men-golf-shorts` collection | the copied theme's shorts deal page |

- **Name never decides:** a product's name never qualifies it. A test proves that an untagged polo with "bundle" in its name gets no stamp.
- **Ladies and kids excluded:** products tagged `bundle_threepolo_ladies` are left out, and ladies and kids offers stay out of V1.
- **Ambiguous products:** a product matching two offers gets neither stamp, and this is logged.
- **Collections:** membership is read from the Admin API at boot and every reconcile interval. `/health` shows it under `smartCart`. **Until it has loaded, trousers and shorts are added unstamped.** That is today's behaviour, never a wrong discount.
- **Trousers and shorts use the copied theme's collections,** because that is where this runs. The live theme's any-2 pages use narrower step collections (Phase 2). If the live theme is ever the target, change `qualifies` in `apps/server/src/smartCart/config.ts`.

## How stamping flows

```
widget (preview on)  --x-caddie-smart-cart: preview-->  every request
server noteCartMode  -> session.smartCartPreview = header present   (re-read per request)
gateway add planner  -> triggerPropertiesFor(product)  -> CartAction add line { variantId, quantity, properties }
                     -> operation.expect.add carries the same properties
widget addLines      -> /cart/add.js items[].properties     (only when the server sent them)
cart-outcome judge   -> the add is confirmed on the line carrying exactly those properties
```

- **The header is read on every request.** The same session moving from the copied theme to the live one stops stamping on its very next add; a test covers this.
- **The outcome check changed in one place.** Before, an add was expected to land on the plain line, the one with no properties. Now it is expected on the line with exactly the properties sent: the plain line when nothing was stamped, as before, or the stamped line.
- **No other changes:** packs (`add-bundle`), removals, quantity changes and swaps are untouched.

## The price check (worthwhile)

`apps/server/src/smartCart/value.ts`. It uses the catalogue's variant prices (the price the line is charged at), in pence, and applies only to GBP carts.

- **Qualified:** worthwhile if any of SupaEasy's sets (dearest first) costs more than the deal price.
- **Not yet qualified:** worthwhile if the units held, plus the dearest qualifying in-stock product for each missing unit, would cost more than the deal price. The **floor** is the price each missing unit must exceed for the set to save anything.
- **Another currency, or an unknown price:** `null`, meaning it can't be told. The neutral wording stays and no button is shown.

It never produces a figure the customer sees. The deal price is used only for this comparison. Any saving is SupaEasy's, read from the cart (still unbuilt, pending the Phase 4 `/cart.js` capture).

Examples (real sale prices):

| Basket | Result |
| --- | --- |
| 3 × Floral Panel Polo £24 (£72 vs £59.99) | worthwhile |
| 2 × £24 + 1 × £10 polo (£58) | **not worthwhile**, hidden |
| 2 × £20 joggers vs £49 | **not worthwhile**, hidden |
| 2 × £24 polos held | worthwhile, suggests polos over £11.99 |
| 2 × £10 polos held | a third would need to cost over £39.99; none that dear, so hidden |

## What the customer sees (copied theme)

A deal card above the basket in the Caddie: progress dots, the deal, one sentence, and a button when there's something worth suggesting.

| State | Card |
| --- | --- |
| 1 of 3 polos | ●○○ POLO DEAL · 3 FOR £59.99 — "Add 2 more polos to complete the deal" · [Show me polos] |
| 2 of 3 polos | ●●○ (highlighted) — "Just 1 more polo to complete the deal" · [Show me polos] |
| 3 of 3 polos | ●●● (dark card) — "Your polos qualify for 3 for £59.99" · "The deal price is worked out at checkout." |
| 1 of 2 trousers | ●○ TROUSER DEAL · 2 FOR £49 — "Just 1 more pair of trousers to complete the deal" |
| Not worthwhile | no card |
| Can't tell (another currency) | the card, without the button |
| Show me polos | switches to the chat: "Polos that complete the 3 for £59.99 offer" plus up to 6 product cards |

- It never says "saving", "unlock", "save", "£x off" or "your price", and it never shows status codes; tests check both.
- **The tester's line** (`Preview status: … · Triggered 2 / 3 · Lowers price: yes`, plus the evaluation time) no longer shows to customers. It appears only when the mount node also has `data-smart-cart-debug="true"`, which works only alongside the preview attribute. It is the only place a hidden deal shows up, with the reason.

## Contract changes (`packages/shared`), for Amir

- **`CartAction` `add` lines:** optional `properties?: Record<string, string>`. It is only ever an offer trigger the server chose.
- **`CartExpectation.add`:** optional `properties`, so the outcome is judged on the stamped line.
- **`BasketSync`:** optional `currency`.
- **`SmartCartOfferView`:** adds `worthwhile: boolean | null` and `canSuggest: boolean`.
- **New:** `SMART_CART_HEADER` / `SMART_CART_PREVIEW`, `SmartCartSuggestRequest`, `SmartCartSuggestResponse`.
- **New route:** `POST /api/session/:id/smart-cart/suggest { offerId }`.
- `cart-ops/1` is not bumped. The new fields are optional, and an older widget ignores `properties`: it adds a plain line, and the outcome judge then reports the stamped add as unconfirmed, not applied. Deploy the widget and server together.

## Files changed in this step

| Area | Files |
| --- | --- |
| Shared | `packages/shared/src/chat.ts`, `smartCart.ts` |
| Server, Smart Cart | `smartCart/config.ts`, `types.ts`, `index.ts`, `view.ts`, new `eligibility.ts`, new `value.ts` |
| Server, wiring | `tools/index.ts` (stamp in the add planner), `tools/cartOperations.ts` (judge by landing fingerprint; `basketPatch` currency), `lib/request.ts` (preview header), `routes/session.ts` (suggest route; currency), `routes/chat.ts` (currency), `routes/health.ts`, `session/store.ts` (`cartCurrency`, `smartCartPreview`), `catalog/bundles.ts` (`collectionProducts` exported), `index.ts` (load collections) |
| Widget | `lib/api.ts` (header, `suggestForOffer`), `lib/themeCart.ts` (properties on add; currency), `lib/smartCart.ts` (hide not-worthwhile; button; debug), `lib/useCaddie.ts` (`suggestOffer`), `components/SmartCartProgress.tsx`, `Caddie.tsx`, `embed.tsx`, `styles.css` |
| Tests | new `apps/server/test/smartCartStamping.test.ts` (31), new `apps/widget/test/smartCartStamping.test.ts` (5), `apps/widget/test/smartCartPreview.test.ts` (+6). Existing view assertions gained the two new fields; one test offer gained the new config fields. |

## Results (30 Sep 2026)

| Check | Before this step | After |
| --- | --- | --- |
| `npm run typecheck` | 0 errors | 0 errors |
| Server tests | 77 files, 1,368 | **78 files, 1,399**, all pass |
| Widget tests | 7 files, 64 | **8 files, 75**, all pass |
| Widget build | passes | passes |

## Builds for the copied theme

`apps/widget/builds/<target>/caddie.js` and `caddie.css`. Only these two targets exist; the older builds were cleared out.

| Target | API | `caddie.js` sha256 |
| --- | --- | --- |
| `live` | `https://caddie.druids.online` (production) | `794f6b97…a699f52` |
| `local` | `https://n64krb4g-8787.inc1.devtunnels.ms` | `165f780f…e5d5df47` |

`caddie.css` (both): `0f59ead1…1fafffc1`.

Each was checked for the API URL, the preview header, `cart-ops/1` and the React production build.

**Setup is unchanged** (`SMART_CART_WIDGET_PREVIEW.md`): upload the build to the copied theme only, add `data-smart-cart-preview="true"` to `#druids-caddie`, and deploy **this branch's server** to the matching API. With an older server, the preview shows nothing and adds stay unstamped.

## Test on the copied theme

1. Open `https://www.druids.com/?preview_theme_id=159899418724` in a private window, then open the Caddie.
2. Ask for a Floral Panel Polo in M and add it. In `/cart.js`, the new line should carry `"__3_Polo_Bundle": "3_Polo_Bundle"`.
3. Add a second £24 polo. The basket screen shows "2 of 3 polos" and "Show me polos". Tap it, add one of the suggested polos, and check that `/cart.js` shows the discount titled "ANY 3 POLO BUNDLE" on the three lines.
4. Add two Clima trousers (£30) through the Caddie. **This is the Phase 4 bare-trigger test.** If `/cart.js` shows "ANY 2 TROUSERS", trousers work. If not, stop and tell me.
5. Try two £20 joggers: no nudge should appear, and the debug line should say `Lowers price: no - hidden`.

## Risks

- **Confirmed on 1 Oct:** Caddie-stamped trousers, shorts and polos are discounted by SupaEasy (see the Phase 4 report). The saving can be as small as a penny when sale prices already sit near the deal price, and the Caddie applies no minimum of its own.
- **The copied theme's cart changes are picked up live.** It has no `RE_RENDER_DRAWER` and fires no cart events, so the Caddie also watches `#cart-drawer` being redrawn (`watchThemeCart`), ignoring the redraw its own change sets off.
- **The price check uses the catalogue's prices,** which are up to one sync interval stale. That's fine for deciding whether to show a nudge; it never affects what is charged.
- **A stamped line and a plain line of the same variant** can sit side by side (e.g. one added by the theme's standard form). How SupaEasy's variant targeting treats that on trousers and shorts is still untested (Phase 4).
- **An older widget build talking to this server:** a stamped add lands plain and is reported unconfirmed. Deploy both together.

## Not done

- Discount confirmation (reading the applied saving from `/cart.js`). It needs the Phase 4 capture and new `BasketSync` price fields.
- The theme cart drawer, the other theme add routes, and the Complete the Look **+** button. These belong to Asim and the web team.
- Chat wording (the model mentioning offer progress) and ladies and kids offers.
