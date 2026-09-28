# Single-product basket journey — preview-store acceptance checklist

Status: BROWSER PASS PENDING. Fake-cart and API-only replays are not Shopify acceptance.

## Builds to pair

- Server: `customer-journey` at `1b13921` + source patch (see `VERSION` and `source.patch` beside the widget build). Start the fixed build with `npm run build -w @caddie/server` then `npm start -w @caddie/server` on its own port (not the `tsx watch` process).
- Widget: `apps/widget/builds/acceptance-<rev>-<src-hash>/druids-online/caddie.js` (API `https://caddie.druids.online`) or `.../live/caddie.js` (API `https://209-97-131-33.nip.io/caddie`). SHA-256 in the report. Contract `cart-ops/1` is baked into both.
- Pair them. An old widget on the new server is refused adds with "please refresh the page, or use the Add button". A new widget on an old server refuses to run unstamped adds and says "this page and the assistant are out of step".

## Before starting

1. Nobody is on the preview theme. Use a fresh incognito window (empty cart, no Caddie session).
2. Pick an ordinary polo whose M and L are both in stock right now (check `/products/<handle>.js` `variants[].available`). Do not assume last week's stock.
3. Add one unrelated line by the theme's own button (a cap, say) so "unrelated lines unchanged" can be checked.
4. Open DevTools › Network, filter `cart` and `api/session`.

## The journey

| Step | Do | Check in the Caddie thread | Check in the drawer | Check in the cart response |
| --- | --- | --- | --- | --- |
| A | Open the polo page | — | — | `GET /cart.js`: only the cap |
| B | Pick M on the Caddie card, press Add | "Updating your basket…" then "Added the <colour> <polo> in M." | polo M ×1 and the cap | `POST /cart/add.js` 200, then `POST /api/session/<id>/cart-outcome` 200 with `{"status":"applied"}`; `GET /cart.js` shows the M variant ×1 |
| C | — | no colour or size question follows | — | — |
| D | Type "Change that polo to L." | "Updating your basket…" then "Done - the <colour> <polo> is now in L." | polo L ×1, no M, cap unchanged | `add.js` (L) → `cart.js` → `change.js` (the M key, quantity 0) → `cart.js`; `cart-outcome` `{"status":"applied"}` |
| E | Type "What is in my basket?" | "In your basket: <colour> <polo> in L x1; <cap> …" (sizes and quantities from the cart, nothing about M) | same | — |
| F | Type "yes" | no new line, no "would you like it in…", no second add | unchanged | no `add.js` |
| G | Type "Make it two." | "Updating your basket…" then "Done - 2 x <polo> in L in your basket." | polo L ×2 | `change.js` quantity 2; outcome applied |
| H | New incognito window. Open the polo page, type "Add this in M" (or "Add the <polo> in M") | "Updating your basket…" then "Added the <colour> <polo> in M." | polo M ×1 | `add.js` 200; outcome applied |

Any step where the thread, the drawer and `/cart.js` disagree is a fail. Note the exact text.

## Failure recovery (DevTools only — no inventory changes, no real customers' carts)

1. Rejected by the store: DevTools › Network › right-click `add.js` › Block request URL is NOT the test here (that is a network block). Instead, pick a variant the theme reports sold out (`available: false`) and ask Caddie to add it, or in Sources override the `add.js` response to `422 {"description":"The product 'X' is already sold out."}`. Expect "That size is unavailable." with the cart unchanged (`cart-outcome` `status: "failed"`, `failure: "rejected"`).
2. Request blocked (never reaches the store): block `*/cart/add.js`, then add. Expect "I couldn't confirm the update yet. I'm checking your basket." and, after the automatic re-read, either the confirmation (if it did land) or the same uncertainty; a later "add it" gets "I couldn't confirm your last basket update, so I haven't sent it again. Please check your basket with the cart icon…". No second `add.js`. Unblock, refresh: the widget reconciles on load (`cart-outcome` with `status: "uncertain"`), then the hold lifts once the read shows the change or the store refuses it.
3. Answer lost after dispatch: Network throttling "Offline" immediately after clicking Add (or a 20s custom throttle so `add.js` exceeds the 15s deadline). Expect `failure: "timeout"`, uncertain wording, no replay, and confirmation on the reconcile once online.
4. Acknowledgement lost: block `*/api/session/*/cart-outcome`, then add. Expect the cart changed once, the thread saying it could not confirm yet, and on unblock + refresh a single "Added…" (`cart-outcome` answered `applied` once, `duplicate` on any repeat).
5. Partial replacement: override `change.js` to 500 during a "Change that polo to L". Expect "The <polo> in L is in your basket, but I couldn't take out the M - both are there for now. Shall I remove the M?"; "yes" removes the M line only.

## Rollout and rollback (paired)

- Roll out: start the fixed server on its port; point the host/tunnel at it; upload the matching `caddie.js`/`caddie.css`. Order does not matter for safety: each side refuses the mismatch instead of guessing.
- Roll back: restore the previous `caddie.js`/`caddie.css` and the previous server together. Before rolling the server back, look at `GET /admin` or the logs for `gateway.dispatched` without a matching `cart.outcome` in the last minute: those operations stay recorded as dispatched or uncertain in the session store and are not cleared; the old server simply never settles them, and those shoppers' Caddie basket writes stay held until their session expires (two hours idle). Do not clear Redis or sessions to make the rollback look clean.
