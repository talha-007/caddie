# Widget catch-up: what changed on the server

Paste this to a coding agent working in `apps/widget`.

---

You are working on `apps/widget` in the Druids Personal Caddie monorepo. It is
the storefront widget, and it is the only app you may edit — `apps/server`,
`apps/caddie-ui` and `packages/shared` belong to someone else. If something
here seems to need a server change, say so instead of making it.

The branch has fallen a long way behind. Merge or rebase onto `main` first,
then work through the list below. Read `docs/API.md` for the full contract and
the root `CLAUDE.md` for the rules the whole project runs on.

## 1. The Add button is broken. Fix this first.

`add_to_cart` no longer accepts a variant id. The model used to invent them —
a different fabricated id each time — so the tool was changed to take a product
id plus the options the customer chose, and resolve the variant server side.

In `src/lib/useCaddie.ts`, the `addToBasket` loop currently sends:

```ts
await runTool(sessionId, 'add_to_cart', { variantId: item.variantId, quantity: 1 });
```

It needs to send the product id and the chosen options instead:

```ts
await runTool(sessionId, 'add_to_cart', {
  productId: item.productId,
  options: { Size: item.size },   // whatever the customer actually picked
  quantity: 1,
});
```

`BasketItem` carries a `variantId` today, so it will need the product id and
the chosen option values instead. The variant is still the right thing to
*resolve* in the UI — you need it to know the size is in stock — it is just no
longer what you send.

Until this is done the Add button fails against the current server.

## 2. Conversation state now lives with you

**This is the significant one.** The backend is stateless: it keeps nothing
between requests. Every reply carries a `state` object, and you send it back on
the next request. That is what lets a message land on any server behind the
load balancer and still know the customer.

```ts
// Every response now has it:
const { message, state } = await sendMessage(sessionId, text, context, state);

// Keep it, and send it back next time.
```

Rules:

- **Treat it as opaque.** Do not read from it, do not write to it, do not
  reshape it. Store it and hand it back unchanged. Everything you render comes
  from `message` and `message.attachment`, exactly as before.
- **Omit it on the first message** of a conversation. Send it on every one
  after that.
- **Keep it in memory** for the life of the widget instance. `sessionStorage`
  is reasonable if you want it to survive a page navigation within the
  storefront; do not put it in `localStorage`, because it holds what the
  customer said.
- It runs about **1.5KB after six messages** and is capped at forty.

Three places send it:

| Where | How |
| --- | --- |
| `POST /api/chat` | `state` field in the JSON body |
| `POST /api/tools/:name` | `state` field alongside `sessionId` and `args` |
| `POST /api/voice` | `x-caddie-state` header, **base64 encoded** - see below |

**The tools route matters as much as chat.** That is how your Add button
reaches the basket, and the cart id lives in the state. Miss it there and every
add opens a fresh basket — the customer watches their first item vanish.

The voice header must be base64, not raw JSON:

```ts
function packState(state: CaddieState): string {
  const utf8 = new TextEncoder().encode(JSON.stringify(state));
  let binary = '';
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return btoa(binary);
}
```

The state carries what was said, and what the Caddie says is full of pound
signs. A browser throws `Cannot convert argument to a ByteString` on a header
value outside Latin-1 - so raw JSON passes every test you write until someone
mentions a price. `apps/caddie-ui/src/lib/api.ts` has this working if you want
a reference.

All three responses return an updated `state`. Always keep the newest one.

If you send no state at all, the server falls back to remembering the session
itself for two hours. That still works, so nothing breaks the moment you
merge — but it only works with one server, so it is not where we are going.

## 3. Packs are real now, and a pack price is not the sum of its pieces

The Caddie sells the actual Druids packs. Ask for the Ambassador Pack and you
get the real one at **£99** for six garments that add up to £148.

`PackRecommendation` has an optional `pack` field when it is one of the real
ones:

```ts
recommendation.pack?  // { productId, title, price, slots }
recommendation.total  // the pack's own price when pack is set - NOT a sum
recommendation.items  // the garments filling it
```

Your `PackPanel` already renders `recommendation.total` rather than summing the
items, so it is correct as it stands. Two things you could now do properly:

- Show `pack.title` as a heading when `pack` is set, so it reads as "Golf
  Ambassador Pack — £99" rather than an anonymous bundle.
- The real saving is `sum(items) - total`, which for the Ambassador Pack is
  about £49. That is a true number rather than an RRP comparison.

**Never add the items up and show that as the price.** It is a different number
from the one on the Druids product page.

You can also revert your `JourneyForm` workaround that asks the pack journey
for polos instead of a pack — the real thing works now.

## 4. The page context you were already sending is now used

`readPageContext` has been feeding the server product ids all along and the
server ignored them. It does not any more. A customer on a product page can say
"does this come in a large?" without naming anything and the Caddie knows what
"this" is.

Nothing to change. Worth knowing so you can test it: mount the widget with
`data-page-type="product"` and `data-product-id` set, then ask about "this".

One detail — a theme's `{{ product.id }}` is a bare number, not a GID. The
server now accepts either, so your `toProductGid` conversion is belt and braces
rather than required.

## 5. Sizes are read properly now

The server understands "Medium" as well as "M", and knows that trousers are
sized by waist rather than S/M/L. If your size form sends whole words, that is
fine. A `null` size is still a real answer, not a failure — render `reason`.

## How to check you are done

Run the widget against a local server and confirm all of these:

1. Ask for a size, then an outfit. The outfit respects the size.
2. Add two different products to the basket. **The second does not replace the
   first.** This is the one that catches a missing `state` on the tools route.
3. Ask about the Ambassador Pack. It shows £99 and six pieces, and the price
   on screen is £99 rather than £148.
4. On a product page mount, ask "does this come in a large?" without naming the
   product.
5. Reload the widget mid-conversation. With state kept in `sessionStorage` the
   Caddie still knows the customer; without it, it starts fresh. Either is
   acceptable — just know which you built.

The server is checked with `npm run typecheck` and `npm run test` from the
repository root. UI is checked by driving it, not by typechecking it — open it
and look at it.
