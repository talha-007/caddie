# Caddie UI (ours)

A working widget for the Caddie backend, so the AI side is not blocked waiting
on the UI.

**This is not Amir's widget.** He owns `apps/widget`; nothing here touches it.
When his lands, the two get reconciled — this one is a driver, not a
replacement, and it is deliberately plain.

## Running it

```bash
npm run dev:server                      # backend on :8787
npm run dev --workspace=@caddie/ui      # this, on :5174
```

Point it somewhere else with `VITE_CADDIE_API_URL`. The dev server binds to all
interfaces, so a phone on the same network can reach it for device testing.

## What it does

Chat, push-to-talk voice, product cards with a size picker, size / pack /
outfit / basket panels, and checkout through to the real Shopify cart. The API
it speaks is in [docs/API.md](../../docs/API.md).

## Decisions worth keeping

**The size picker is built from `product.options`, never from `variants`.**
Shopify returns a default variant even when the customer has chosen nothing, so
a picker built from `variants` silently adds whichever size came back first.
`variants` is used only to mark what is out of stock.

**Add is locked until a size is chosen.** The button says "Choose a size" until
it can do the right thing.

**Images are requested at the size they are drawn.** The catalogue hands back
1440px originals for a 172px card; without a `width` parameter that is seconds
of grey box on a phone, which reads as broken.

**The size picker is a `select`, not chips.** Seven sizes wrap to three rows of
chips and push the Add button out of the card — measured against the pane, not
guessed — and a native select gets the proper picker on a phone.

**The transcript of what we heard is shown.** When the Caddie answers oddly the
first question is whether it misheard, and without this nobody can tell.

## Checking it still works

There is no unit test suite here; it is checked by driving it. The quickest
loop is Playwright against a running pair of servers — open the panel, send
"build me a pack under 100", and confirm a whole card fits the results pane
with its Add button visible. Layout regressions do not show up in a typecheck.
