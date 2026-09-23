# Kickoff prompt for the widget

Paste this into a fresh Claude Code session opened at the repo root. The repo's
`CLAUDE.md` loads automatically and carries the rest of the context, so this
only needs to say what to build and where the traps are.

---

You are working on the Druids Personal Caddie, a voice and chat shopping
assistant that sits on the Druids Shopify storefront. I own the widget UI;
Talha owns the backend. Read `CLAUDE.md` and `docs/API.md` before writing
anything — `docs/API.md` is the full API reference with real captured payloads.

**Build in `apps/widget`. Do not edit `apps/server` or `apps/caddie-ui`.** If
you need something the API does not do, tell me and I will ask Talha, rather
than changing the server yourself. `packages/shared` holds the types both sides
import — import from it instead of redeclaring shapes, and tell me before
changing it.

## The backend is already running and real

```
https://n64krb4g-8787.inc1.devtunnels.ms
```

That is Talha's machine behind a tunnel, not a deployment. It returns real
products from a real Shopify store and fills a real basket. No auth, no keys,
CORS is open in development. A `502` means his laptop is asleep — tell me, do
not debug it.

Point the widget at it with `VITE_CADDIE_API_URL`, or run the backend locally
on `:8787` if you have the repo's `.env`.

Check it first:

```bash
curl https://n64krb4g-8787.inc1.devtunnels.ms/health
```

## What to build

The three journeys the release is judged on:

1. **Size** — the customer gives a measurement or their height and weight, the
   Caddie recommends a size, they add it.
2. **Pack** — several items within a budget, the customer swaps one, adds them.
3. **Outfit** — built around an item or an occasion, the customer changes
   colour or price, adds it.

Plus: chat, push-to-talk voice, product cards, basket with checkout, and the
loading and error states. Day-by-day scope is in `docs/ROADMAP.md`.

## What will silently break if you get it wrong

These are not style preferences. Each one has already caused a real bug.

- **Build the size picker from `product.options`, never from `variants`.**
  Shopify returns a default variant even when nothing has been chosen, so a
  picker built from `variants` adds whichever size came back first without
  telling anyone. Use `variants` only to mark what is out of stock.
- **Do not let anything be added without a chosen size.** Lock the button and
  say what is needed.
- **`message.text` is for reading; `attachment` is for rendering.** Never parse
  a price or a product name out of the text — a model wrote it.
- **Money is already in pounds.** `{ amount: 42 }` is £42.00, not 42p. Format
  from `currency`; do not hard-code `£`.
- **Outfit slots can be missing.** Nothing is padded, so do not assume four.
- **A `null` size is a real answer** — show `reason` rather than an error.
- **Show the voice `transcript`.** When the Caddie answers oddly the first
  question is whether it misheard, and without it on screen nobody can tell.
- **Replies take 3–10 seconds.** The backend is really searching Shopify. Build
  the loading state for that, not for 300ms.

## Things that look like bugs and are not

- `TOUR SHORT - NAVY` in waist 40 is **out of stock on purpose**, so the
  unhappy path can be tested. Do not "fix" it.
- A search returning nothing can be correct. The store also holds generic demo
  products which are filtered out, so only Druids kit comes back.
- The Caddie saying "we do not stock womens polos" is correct — the test store
  has none.

## How to check your work

Drive it in a browser and look at it. Layout regressions, images that never
load and buttons below the fold do not show up in a typecheck. Measure the
thing you changed — for instance, that a whole product card fits the scroll
pane with its Add button visible, at 390px wide as well as on desktop.

There is a second, plainer UI at `apps/caddie-ui` that already does all of this
against the same API. **Read it when you are unsure what an endpoint returns or
how a flow hangs together** — it is a reference, not a design to copy. The
styling there is deliberately plain; yours is the one that has to look like
Druids.

Start by reading `CLAUDE.md`, `docs/API.md`, and `apps/caddie-ui/src/lib/api.ts`,
then tell me what you plan to build first.
