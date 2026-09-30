# Smart Cart widget preview

Written for: Talha and Amir, who will put this on the copied Druids theme and test it.

Branch `smart-cart-widget-preview`, made from `smart-cart-phase-4`. It carries the uncommitted Phase 1 and Phase 3 work in the same working tree. Nothing is committed, uploaded or published.

The Caddie basket screen can now show read-only Smart Cart progress ("2 of 3 polos"), as the server evaluated it from the real cart. It shows **only** where the theme's Caddie mount node carries `data-smart-cart-preview="true"`. The live theme doesn't set this, so on the live theme nothing changes.

> **Amir:** `packages/shared` changed (a new `smartCart.ts`, and `BasketSyncResponse` for `POST /api/session/:id/basket`), and your widget files were edited under this brief. The details are below.

---

## Files changed

| File | Change |
| --- | --- |
| `packages/shared/src/smartCart.ts` | **New contract.** `SmartCartProgressStatus`, `SmartCartOfferView`, `SmartCartView`, `BasketSyncResponse`. |
| `packages/shared/src/index.ts` | Exports it. |
| `apps/server/src/smartCart/view.ts` | New. `smartCartView(state)` turns session state into the wire view: no line keys, variant ids or trigger keys. It returns `null` when there is no state. |
| `apps/server/src/smartCart/types.ts` / `config.ts` / `index.ts` | The status type now comes from shared. The display metadata gains `units` ("polos", "trousers", "shorts"). The view is exported. |
| `apps/server/src/routes/session.ts` | `POST /:id/basket` answers `{ ok, lines, smartCart }`, evaluated from the basket it just applied. |
| `apps/widget/src/lib/smartCart.ts` | New. Wording (`smartCartLines`), the out-of-order guard (`newerSmartCart`), and the debug text. |
| `apps/widget/src/components/SmartCartProgress.tsx` | New. The preview component. |
| `apps/widget/src/lib/context.ts` | `WidgetContext.smartCartPreview`, read from `data-smart-cart-preview`. |
| `apps/widget/src/lib/api.ts` | `syncBasket` is typed to return `BasketSyncResponse`. |
| `apps/widget/src/lib/useCaddie.ts` | `smartCart` state. Every basket sync (all 11 call sites) goes through one `pushBasket` that stores the reply's state. |
| `apps/widget/src/Caddie.tsx` | The basket screen renders `<SmartCartProgress>` above `<BasketPanel>`. |
| `apps/widget/src/styles.css` | `.caddie-smartcart*` styles. |
| `apps/server/test/smartCart.test.ts`, `smartCartSession.test.ts` | +4 tests. One existing assertion now includes the new `units` field; its meaning is unchanged. |
| `apps/widget/test/smartCartPreview.test.ts` | New, 22 tests. |
| `apps/widget/builds/{live,local}/` | Preview builds (see `SMART_CART_STAMPING.md`). |

`apps/widget/src/lib/themeCart.ts` shows as modified only because of Phase 1; this work didn't touch it.

## API and shared contract changes

```ts
// packages/shared/src/smartCart.ts
type SmartCartProgressStatus = 'INACTIVE' | 'IN_PROGRESS' | 'ONE_AWAY' | 'QUALIFIED';
interface SmartCartOfferView {
  offerId: string; name: string; status: SmartCartProgressStatus;
  qualifyingUnits: number; requiredUnits: number; remainingUnits: number;
  display?: { deal: string; units: string };   // display only, never arithmetic
}
interface SmartCartView { offers: SmartCartOfferView[]; evaluatedAt: number }
interface BasketSyncResponse { ok: boolean; lines: number; smartCart: SmartCartView | null }
```

- **`POST /api/session/:id/basket`**: was `{ ok, lines }`, now `{ ok, lines, smartCart }`. The change is additive: an older widget ignores the new field, and a newer widget talking to an older server gets no `smartCart` and keeps showing nothing.
- **Nothing else:** no other route, the chat response, the claim, SSE or `cart-ops/1` changed.

## How SmartCartState reaches React

```
theme cart changes / panel opens / basket opens / Caddie operation settles / voice pre-sync / page load
  → useCaddie pushBasket(basketSync())        (all basket syncs, no new ones, no polling)
      → POST /api/session/:id/basket
          → basketPatch(lines)                (Phase 3: basket + smartCart from the same read)
          → reply.smartCart = smartCartView(...)
      → setSmartCart(newerSmartCart(current, reply.smartCart))
  → Caddie.tsx basket screen → <SmartCartProgress view={caddie.smartCart} enabled={context.smartCartPreview} />
```

- **The server is the only authority.** React never looks at a trigger, a property or a product name.
- **A failed sync** throws, and the existing `.catch(() => undefined)` runs, so **the previous state is kept**. This matches Phase 1 and Phase 3.
- **Out-of-order replies:** an older `evaluatedAt` never replaces a newer one.
- **A real empty cart** gives every offer INACTIVE, and the preview disappears.
- **Where a basket isn't synced:** the chat turn's basket (`/api/chat`) is applied on the server as before, but the chat reply doesn't carry the state. The basket screen refreshes on open anyway: `openBasket` and panel open both call `refreshCart()`, which syncs.

## Component behaviour and exact wording

The component renders nothing when the preview is off, when there is no state, or when every offer is INACTIVE. Otherwise it shows each non-INACTIVE offer in server order, with no "main" offer, as progress text, a bar and a message:

| Offer | Units | Status | Progress line | Message |
| --- | --- | --- | --- | --- |
| Any 3 Polos | 1 | IN_PROGRESS | `1 of 3 polos` | `Add 2 more to reach the 3 for £59.99 offer` |
| Any 3 Polos | 2 | ONE_AWAY | `2 of 3 polos` | `Add 1 more to reach the 3 for £59.99 offer` (emphasised) |
| Any 3 Polos | 3+ | QUALIFIED | `3 of 3 polos` | `Qualifying basket — final discount confirmation is still handled by SupaEasy` |
| Any 2 Trousers | 1 | ONE_AWAY | `1 of 2 trousers` | `Add 1 more to reach the 2 for £49 offer` |
| Any 2 Trousers | 2+ | QUALIFIED | `2 of 2 trousers` | `Qualifying basket — …` (as above) |
| Any 2 Shorts | 1 | ONE_AWAY | `1 of 2 shorts` | `Add 1 more to reach the 2 for £45 offer` |
| Any 2 Shorts | 2+ | QUALIFIED | `2 of 2 shorts` | `Qualifying basket — …` |

- The progress line caps at the threshold ("3 of 3"); the debug line shows the real count.
- The "3 for £59.99" wording comes from the server's display metadata and is never used in arithmetic.
- It never says "discount applied", "unlocked", "saving", "you've earned", "your price" or "£x off". A test checks every state's text against that list.

**Debug section** (preview only, small and muted, under a dashed rule):

```
Preview status: Any 3 Polos: ONE_AWAY · Triggered 2 / 3
Evaluated: 14:32:10
```

It shows one status line per shown offer, and `evaluatedAt` as local 24-hour time, for comparing against `/cart.js`. There are no tokens, line keys, variant ids, trigger keys or gids; a test checks this.

## Preview gating

The widget already reads its configuration from data attributes on the `#druids-caddie` mount node (`lib/context.ts`, e.g. `data-launcher="false"`). The preview uses the same mechanism:

```html
data-smart-cart-preview="true"
```

- Only the exact string `true` turns it on. Absent, `false` or empty means off; a test covers this.
- No theme id is hard-coded anywhere.
- The live theme ("Autumn 2026", `159972884580`) doesn't set the attribute, so even if this build were uploaded there, nothing would show.

## Copied-theme setup (Amir)

Theme: "Copy of  DRUIDS - SPORT TYPE - AsimAli" (`159899418724`, unpublished). Its `layout/theme.liquid` already mounts the Caddie (lines 142 to 154 in the copy I read on 29 Sep).

1. **Upload the build to the copied theme only.** Replace that theme's `assets/caddie.js` and `assets/caddie.css` with `apps/widget/builds/<target>/caddie.js` and `caddie.css`. Pick `<target>` by the server the copied theme should talk to:
   - `live` → `https://caddie.druids.online` (production)
   - `local` → `https://n64krb4g-8787.inc1.devtunnels.ms`, a local server on this branch. The tunnel must be up and the server running, and the server's CORS must allow `www.druids.com`.
2. **Turn the preview on:** in the copied theme's `layout/theme.liquid`, add one attribute to the existing mount node:

   ```liquid
   <div id="druids-caddie"
     data-smart-cart-preview="true"
     {% if template contains 'product' %}
     ...
   ```

3. **Deploy this branch's server to that target first.** An older server answers `/basket` without `smartCart`, and the preview then shows nothing, silently. `GET /health` does not report this.
4. **Test:** open `https://www.druids.com/?preview_theme_id=159899418724`. Add polos with the theme's own Add buttons (these stamp `__3_Polo_Bundle` for products tagged `bundle_threepolo`), or trousers or shorts through the deal pages. Open the Caddie and tap the basket. Compare the debug line with `/cart.js`.
   - **Caddie's own adds write no trigger**, so they never move the progress. That is correct for now.

Build details (superseded: these builds were rebuilt with Caddie stamping and the price check; see `SMART_CART_STAMPING.md` for current hashes):

| Target | API | `caddie.js` sha256 | `caddie.css` sha256 |
| --- | --- | --- | --- |
| `druids-online` | `https://caddie.druids.online` | `5a75ae35…0ed6fbd` | `eff6704c…099edbd2` |
| `live` | `https://209-97-131-33.nip.io/caddie` | `3d3644cd…f385666ea5` | `eff6704c…099edbd2` |
| `local` | `https://n64krb4g-8787.inc1.devtunnels.ms` (dev tunnel to a local server on :8787) | `cde119b7…6f5413722` | `eff6704c…099edbd2` |

- Built from `7b13e25` plus this working tree with `vite build --mode production`. Each is one file with no lazy chunks, so the asset base URL doesn't matter.
- Checked in each bundle: the API URL, the preview flag and the QUALIFIED wording are present, `cart-ops/1` is baked in, and it is the React production build.
- Size: 230 kB `caddie.js` (74 kB gzip), 36 kB `caddie.css`. The last acceptance build was 227 kB.

## Tests and results (30 Sep 2026)

| Check | Before (the `smart-cart-phase-3` tree) | After |
| --- | --- | --- |
| `npm run typecheck` (all workspaces) | 0 errors | 0 errors |
| Server tests | 77 files, 1,364 tests, all pass | 77 files, **1,368** tests, all pass |
| Widget tests | 6 files, 42 tests, all pass | **7 files, 64 tests**, all pass |
| `npm run build --workspace=@caddie/widget` | — | passes (`tsc --noEmit` + `vite build`) |

New widget tests (`test/smartCartPreview.test.ts`, 22):
- **Nothing to show:** no state, all inactive and preview off each render nothing; preview on renders.
- **Wording:** polo IN_PROGRESS, ONE_AWAY and QUALIFIED ("qualifying basket", never "discount applied"); 4 polos shows "3 of 3" plus the true count in debug; trousers ONE_AWAY and QUALIFIED; shorts ONE_AWAY; several offers shown independently.
- **Debug:** shows the evaluation time and no keys, ids or tokens.
- **Gating:** `data-smart-cart-preview` off by default, on only for `"true"`.
- **Sync state:** the `/basket` reply carries the state and it is kept; a failed sync keeps the previous state; an older server keeps the previous state; a late reply never replaces a newer one; an empty basket clears the UI.
- **Basket screen:** with the preview on, progress sits above unchanged basket lines; with it off, the markup is byte-identical to the basket panel alone.

New server tests (+4):
- `/basket` returns the evaluated view, with no line keys, variant ids or trigger keys;
- an empty basket returns all INACTIVE, not null;
- `smartCartView(undefined)` is `null`;
- the view carries progress and wording only.

**Not tested:** the `useCaddie` hook wiring itself, as in Phase 1. The widget has no React hook test tooling. The pieces it composes (`syncBasket` reply, `newerSmartCart`, component, gating) are each tested, and the hook change is one wrapper plus a rename at 11 sites.

**Screenshots:** none. The repository has no browser tooling (Playwright was deliberately not added), and UI checks on the preview store are done by hand.

## Anything else Amir needs to do

- Steps 1 to 3 of "Copied-theme setup" above. Nothing else in the theme.
- When the preview is no longer wanted, remove the attribute. The code can stay dormant.
- **If the sport-bundle builder** on the copied theme adds to the cart without calling `RE_RENDER_DRAWER`, the progress updates when the Caddie panel or basket is next opened, not instantly. Phase 1 flagged this as UNCLEAR for that builder.

## Confirmation

- No trigger properties are written. Caddie's add-to-cart behaviour, `cart-ops/1` and the Action Gateway are unchanged.
- No SupaEasy call or change.
- No price, saving or discount is calculated, and no offer is claimed as applied. The display prices are metadata text only.
- The live theme is not touched; nothing was uploaded or published.
- No ladies or kids offers were added.
- The widget never evaluates Smart Cart itself; the server remains the authority.

Stopping here. Trigger stamping has not been started.
