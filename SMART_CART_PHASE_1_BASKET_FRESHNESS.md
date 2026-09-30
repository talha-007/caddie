# Smart Cart Phase 1: basket freshness

Written for: the Caddie team (Talha, Amir) and whoever designs Smart Cart Phase 2.

Branch `smart-cart-phase-1`, from `main` at `7b13e25`. Not committed, not deployed.

Scope: basket freshness only. **No Smart Cart, SupaEasy, offer or pricing logic was added.** `cart-ops/1`, `CartAction` formats, the Action Gateway, cart-outcome settlement, add/remove semantics and pack semantics are unchanged.

---

## What changed for the customer

- Every typed chat turn now reaches the server with a snapshot of the real theme cart, read from `/cart.js` just before the message is sent. The server applies it before the conversation runs.
- Voice turns report the same snapshot to the server immediately before the audio is sent. The voice endpoint takes raw audio, so the basket cannot travel in the same request.
- When the rest of the theme changes the cart, Caddie reads it back once and updates the server. This covers the product page Add button, collection quick add, product cards, the cart drawer, the cart page and the live pack pages.

## Files changed

| File | Change |
| --- | --- |
| `apps/widget/src/lib/themeCart.ts` | New `basketForTurn()` does a bounded `/cart.js` read through the existing `readRaw` and `basketSync`. New `watchThemeCart()` wraps the theme's `RE_RENDER_DRAWER`. `announceToTheme()` now marks Caddie's own re-render so it is not read back. |
| `apps/widget/src/lib/api.ts` | `sendMessage()` takes an optional basket and includes it in `ChatRequest.basket`. |
| `apps/widget/src/lib/useCaddie.ts` | `send()` reads the basket before posting. `sendClip()` syncs the basket before the voice request. A new effect installs `watchThemeCart(refreshCart)` on the storefront. |
| `apps/server/src/routes/chat.ts` | Logs only: `chat.basket_applied`, and `chat.basket_missing` when a current widget in theme mode sent no basket. The existing apply logic is untouched. |
| `apps/widget/test/basketFreshness.test.ts` | New, 10 tests. |
| `apps/server/test/chatBasket.test.ts` | New, 5 tests. |

`packages/shared/src/chat.ts` was not changed: `ChatRequest.basket?: BasketSync` already existed. No new dependencies.

## How the fresh basket reaches `/api/chat`

```
customer presses Send
  → useCaddie.send()
      → onStorefront() ? basketForTurn() : null
          → readRaw()  GET {root}/cart.js        (existing reader, 15s abort)
          → raced against TURN_BASKET_MS = 2.5s
          → basketSync(raw)                        (existing BasketSync builder)
      → sendMessage(sessionId, text, page, undefined, basket)
          → POST /api/chat { sessionId, text, context?, basket? }
  → routes/chat.ts
      → noteCartMode (x-caddie-cart: theme)
      → if basket && cartMode === 'theme': session.basket = basketFromSync(lines), cartToken  (existing)
      → converse()
```

`/cart.js` stays the only source of truth. The server's copy is replaced by what the widget has just read, never by anything else. There is one `BasketSync` builder (`basketSync`) and one server conversion (`basketFromSync`), both reused unchanged.

## External cart events: what the real theme does

I inspected the live theme read-only through the Admin API (the same path `catalog/bundles.ts` uses), not assumed. The theme is "Autumn 2026" (`gid://shopify/OnlineStoreTheme/159972884580`), 520 files, 235 of them non-minified JS/Liquid downloaded and searched.

- **The theme dispatches no cart events.** There is no `cart:update`, `cart:refresh`, `cart:change`, PubSub, or jQuery `ajaxCart` event. The only `cart:update` / `cart:refresh` dispatches on the page are Caddie's own, and nothing in the theme listens to them. The widget comment calling them "Horizon" events described a theme that is not live.
- **What every theme cart path does call on success** is the global function `RE_RENDER_DRAWER()`, defined at the top level of `snippets/application_script.liquid`. The layout renders it at `layout/theme.liquid:410`. Because it is a top-level declaration in a classic script, it lives on `window` and is called by bare name, so a wrapper on `window.RE_RENDER_DRAWER` sees every call.

| Theme path | Theme function | Calls `RE_RENDER_DRAWER` after the cart changes |
| --- | --- | --- |
| Product page Add | `QUICK_CART` (from `sections/main-product.liquid`) → `/cart/add.js` | Yes |
| Collection / quick add | `QUICK_CART` (from `main-collection`, `featured-collections*`, `product-card`, `collection-product-card`, `product-card-recommendation`) | Yes |
| Cart drawer quantity | `UPDATE_QTY` → `/cart/change.js` | Yes |
| Cart drawer remove / line update | `UPDATE_LINE_ITEM` → `/cart/update.js` | Yes |
| Cart drawer remove pack | `REMOVE_BUNDLES` → `/cart/update.js` | Yes |
| Cart page | `sections/cart__main.liquid` → `change.js` / `update.js` | Yes |
| Pack pages (bundle builder v4, 128 live page templates) | `/cart/add.js` | Yes |
| Opening the drawer | `OPEN_DRAWER` | Yes, though nothing changed; this causes one harmless re-read |

**Subscribed to:** the theme's `RE_RENDER_DRAWER`, through a wrapper installed by `watchThemeCart()`.

- The theme's own function still runs, unchanged.
- Calls are debounced, so rapid drawer clicks produce one read after 400ms.
- A call made by Caddie's own `announceToTheme()` is ignored through the `ownRender` flag. `refreshCart()`, the resync, never announces to the theme, so the resync cannot re-trigger itself.
- The wrapper is re-installed on `window` load in case the theme defines the function after the widget mounts. It is never double-wrapped, and it is removed on unmount.
- There is no polling and no MutationObserver.

**Not subscribed to:** `cart:update` / `cart:refresh`. In this theme only Caddie emits them, so listening would add nothing but a loop risk. Caddie's own events keep carrying `detail.sourceId = 'druids-caddie'` for any future theme that does listen.

## Add-to-cart routes that still cannot be observed immediately

- **Bundle builders v2, v3, v6 and the unversioned builder** add to the cart without calling `RE_RENDER_DRAWER`. They are used only by `page.bundle-builder*.json` and `page.theme-bundle-test.json`, which look like test pages. These changes are picked up at the next chat turn or panel open.
- **The condition-pack "sport bundle" builder** lives in the unpublished theme (`SHOPIFY_CONDITION_PACKS_THEME_ID`) and was not inspected. **UNCLEAR** whether it calls `RE_RENDER_DRAWER`. Check it before that theme is published.
- **Other tabs, checkout, and Shopify apps** calling the cart API directly are not observed. The GiftKart snippet has its own cart calls without `RE_RENDER_DRAWER`, but the live layout does not render it. These are caught at the next chat turn or panel open.
- **A theme change that renames or wraps `RE_RENDER_DRAWER` differently** would silently stop the external resync. The per-turn read would still keep each chat turn fresh.

## Failure behaviour

| Situation | Behaviour |
| --- | --- |
| `/cart.js` read fails (error or non-JSON) | `basketForTurn()` returns null and logs `console.warn('[caddie] could not read the cart before sending; sending without it')`. The message is sent without `basket`. The server logs `chat.basket_missing` and keeps its previous copy. |
| `/cart.js` read hangs | The turn waits at most 2.5s (`TURN_BASKET_MS`), then continues as above. The underlying request still ends at its own 15s abort. |
| An empty basket really read | Sent and applied: an empty cart is a real state. |
| A basket failing validation | The whole request is refused (400) by the existing zod schema, as before. Nothing is half-applied. |
| Off the storefront (dev harness) | No read, no basket. The Storefront API cart path is unchanged. |
| External resync read fails | The existing `refreshCart()` keeps what it had. |
| Theme has no `RE_RENDER_DRAWER` | Nothing is wrapped and nothing polls. |

The customer-visible latency added to a typed turn is one `/cart.js` read, same origin, typically well under the 2.5s cap. It is not measured on the live store (**UNCLEAR** until tested on a phone).

## Tests added

Widget, `apps/widget/test/basketFreshness.test.ts` (fake Shopify cart plus a fake Caddie server):

1. A chat message includes the latest `/cart.js` snapshot in the `BasketSync` shape.
2. A failing `/cart.js` read still sends the message, with no `basket` key, and warns.
3. A hanging read gives up at the deadline.
4. The theme's `RE_RENDER_DRAWER` triggers exactly one resync and still re-renders; unmount restores the original.
5. Five rapid theme re-renders coalesce into one resync.
6. Caddie's own `announceToTheme` (three times) causes no resync, while the theme is still told.
7. No `RE_RENDER_DRAWER`: nothing is wrapped and nothing polls over 60s.
8. A function defined after mount is wrapped on window load.
9. A remount never double-wraps.
10. A stamped Caddie add through `runOperation` still lands and reports applied, with no theme-change resync.

Server, `apps/server/test/chatBasket.test.ts` (real chat route; `converse` replaced to record the basket it saw):

1. The supplied basket is applied before the conversation runs, and titles come from the catalogue.
2. A really-read empty basket is applied.
3. No basket keeps the server's previous copy.
4. A malformed basket is refused, not half-applied.
5. Outside theme mode, a basket in the message is ignored.

Not covered: the `useCaddie` hook wiring itself. The widget has no React hook or component test tooling, and adding any is outside this phase. The pieces the hook calls are each tested. The hook change is three lines per site.

## Quality gates (run 30 Sep on this branch)

| Check | Before (`7b13e25`) | After |
| --- | --- | --- |
| `npm run typecheck` (all workspaces) | 0 errors | 0 errors |
| Server tests (vitest) | 74 files, 1,309 tests, all pass | 75 files, 1,314 tests, all pass |
| Widget tests (vitest + jsdom) | 5 files, 32 tests, all pass | 6 files, 42 tests, all pass |

No existing test was changed or weakened.

## Risks and unresolved issues

- **Not tested on the real theme or a phone.** The event analysis comes from the theme's source; the behaviour needs checking on the preview store: add from the product page, change and remove in the drawer, then ask Caddie what is in the basket.
- **Wrapping a theme global** depends on the theme keeping `RE_RENDER_DRAWER` a top-level function. If Druids' developers rename it or move it into a module, external resync stops silently, while per-turn freshness still works. The dependency is documented in the `watchThemeCart` comment.
- **`OPEN_DRAWER` also calls `RE_RENDER_DRAWER`**, so opening the drawer causes one extra `/cart.js` read and basket sync. It is debounced and harmless.
- **The unpublished condition-pack builder** was not inspected (see above).
- **Deployment pairing:** the widget build and the server should be deployed together, as for `cart-ops/1`. An older server ignores the new `basket` field (its zod body schema is not strict, so unknown keys are dropped); the widget still works against it, just without the per-turn freshness. The widget build in `apps/widget/builds/local` has **not** been rebuilt for this branch.
- The server's `chat.basket_missing` warning will also fire for a current widget whose read timed out; it is a signal, not an error.

## Confirmation

No Smart Cart evaluator, offer qualification, SupaEasy logic, bundle pricing, Smart Cart prompts or offer wording was added. The system prompt, tools, Action Gateway, `CartAction` formats, `cart-ops/1`, cart-outcome settlement, add/remove semantics and pack semantics are unchanged. Phase 1 stops here.
