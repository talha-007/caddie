# Caddie API

Everything the widget needs from the backend. Types for all of this live in
`packages/shared` — import them rather than redeclaring, and they will tell you
when something changes.

## Backend URL

```
https://n64krb4g-8787.inc1.devtunnels.ms
```

**This is Talha's laptop behind a VS Code tunnel, not a deployed server.** It
works while his machine is awake and the tunnel is forwarded. A `502` means it
is down — message him rather than debugging your code. The URL changes if the
tunnel is recreated.

No auth, no keys. CORS allows any origin in development, so it works from
localhost, from your own tunnel, and from a phone.

Check it is alive:

```bash
curl https://n64krb4g-8787.inc1.devtunnels.ms/health
```

## Sessions

Every call takes a `sessionId` — any stable string, one per customer per visit.
It is how the Caddie remembers the conversation: measurements, budget, colour,
and the basket. Send the same one throughout a visit; a new one starts a new
customer.

## Chat

```
POST /api/chat
{ "sessionId": "abc", "text": "build me a pack under £100" }

→ { "sessionId": "abc", "message": { ... } }
```

### Telling the Caddie which page they are on

`context` is optional and the server now uses it, so a customer on a product
page can say "does this come in a large" without naming anything:

```jsonc
{
  "sessionId": "abc",
  "text": "does this come in a large?",
  "context": {
    "pageType": "product",          // product | collection | cart | other
    "productId": "gid://shopify/Product/9713581359329",
    "productTitle": "VENTO POLO - WHITE/ ORANGE",   // optional
    "productHandle": "vento-polo",                  // optional
    "variantId": "gid://shopify/ProductVariant/..." // optional
  }
}
```

Send it on every message; it is remembered on the session, so a **voice** turn
- which carries no context of its own - still knows the page.

A bare numeric id (`"9713581359329"`) is accepted as well as a GID, because
that is what a theme's `{{ product.id }}` gives you.

Only `productId` does any work. The title and handle are a convenience for the
logs and the prompt - the Caddie always loads the product from Shopify before
it describes, prices or adds it, so nothing you put in `context` can make it
quote a price that is not real.

The `message` is a `CaddieMessage`:

```jsonc
{
  "id": "3c365e5b-...",
  "role": "assistant",
  "text": "I've put together a 3 piece pack, £68 in total.",  // what to display
  "createdAt": "2026-09-22T18:23:59.537Z",
  "attachment": { ... }                                       // what to render
}
```

**`text` is for reading. `attachment` is for rendering.** Never parse prices or
product names out of `text` — it is written by the model and is deliberately
vague about specifics. Every fact you display comes from `attachment`.

Replies take **3–10 seconds** because the Caddie is searching the real store
behind the scenes. Plan the loading state around that, not around 300ms.

## Voice

```
POST /api/voice?sessionId=abc
Content-Type: <the blob's own type, e.g. audio/webm>
Body: the raw MediaRecorder blob — not multipart, not base64

→ { "sessionId": "abc", "transcript": "I need a navy polo", "message": { ... } }
```

```js
const blob = new Blob(chunks, { type: recorder.mimeType });
const res = await fetch(`${API}/api/voice?sessionId=${sessionId}`, {
  method: 'POST',
  headers: { 'Content-Type': blob.type },
  body: blob,
});
```

`transcript` is what we heard. **Show it.** When the Caddie answers oddly, the
first question is always whether it misheard, and without this on screen nobody
can tell a bad answer from a bad recording.

Errors worth handling: `400 empty_audio` (nothing recorded — a mis-tapped mic),
`413 audio_too_large` (over 25MB), `501 voice_unavailable` (key not set).

This is speech in, text out. The Caddie does not speak back yet; that comes
with Vapi.

## Live updates (SSE)

```
GET /api/events/:sessionId
```

Open this as an `EventSource` as soon as you have a session id. During a voice
call the Caddie answers out loud while the cards arrive here, so the screen
keeps up with the conversation.

Events: `attachment` (render it), `speech` (a line the Caddie said), `status`.
Each `data:` payload is JSON. The stream sends a comment every 20s to stay open.

Chat replies carry their attachment in the response *and* publish it here, so
guard against rendering the same thing twice.

## Running a tool directly

```
POST /api/tools/:name
{ "sessionId": "abc", "args": { ... } }

→ { "sessionId": "abc", "speech": "...", "attachment": { ... } }
```

No AI involved — useful for building a component against real data without
talking your way to the right state. `GET /api/tools` lists them all with their
parameters.

Handy ones:

```jsonc
POST /api/tools/search_products     { "args": { "query": "navy polo", "limit": 6 } }
POST /api/tools/find_my_size        { "args": { "audience": "men", "chestCm": 107 } }
POST /api/tools/recommend_pack      { "args": { "query": "golf kit", "budgetAmount": 100 } }
POST /api/tools/recommend_outfit    { "args": { "seed": "match day", "colour": "navy" } }
POST /api/tools/add_to_cart         { "args": { "productId": "gid://...", "options": { "Size": "34" } } }
POST /api/tools/view_cart           { "args": {} }
```

## Attachments

Five kinds. Switch on `kind`.

### products

```jsonc
{
  "kind": "products",
  "products": [{
    "id": "gid://shopify/Product/9737782395105",
    "title": "TOUR SHORT - NAVY",
    "url": "https://qqfeqi-xb.myshopify.com/products/tour-short-navy",
    "imageUrl": "https://cdn.shopify.com/.../everyday-shorts--navy.png",
    "tags": ["druids-product", "golf-clothing", "mens", "navy", "shorts"],
    "price": { "amount": 42, "currency": "GBP" },
    "options": [{ "name": "Size", "values": ["30","32","34","36","38","40"] }],
    "variants": [
      { "id": "gid://shopify/ProductVariant/49197065961697",
        "title": "30", "available": true,
        "price": { "amount": 42, "currency": "GBP" },
        "options": { "Size": "30" } }
    ],
    "description": "Lightweight four-way stretch golf short..."
  }]
}
```

**Build the size picker from `options`, never from `variants`.** Shopify hands
back a default variant even when the customer has chosen nothing, so a picker
built from `variants` silently adds whatever size happened to come first. Use
`options.values` for the choices, and `variants` only to check availability of
one the customer has actually picked.

`imageUrl`, `description`, `vendor` and `productType` can all be `null`. Titles
run long and are shouty (`VENTO POLO - NAVY/ WHITE`) — clamp them.

### size

```jsonc
{
  "kind": "size",
  "recommendation": {
    "size": "L",                 // null when it cannot say - render the reason
    "confidence": 1,
    "alternativeSize": "XL",
    "reason": "At 107cm chest, the Druids size guide puts you in a L.",
    "basis": "measurement",      // measurement | estimate | usual-size | none
    "missing": [],               // what it still needs, e.g. ["audience"]
    "measureAdvice": "Measure at the fullest part of the chest..."
  }
}
```

`size` can be `null` — when it needs more information, or for socks, which
Druids sizes by style rather than measurement. Show `reason` in that case.

The Caddie explains `basis` and confidence out loud, so the panel does not need
to. Showing the size clearly is enough.

### pack

```jsonc
{
  "kind": "pack",
  "recommendation": {
    "items": [ /* products */ ],
    "total": { "amount": 68, "currency": "GBP" },
    "overBudget": false,
    "reason": "Here is a 3 piece pack inside your £100 budget."
  }
}
```

### outfit

```jsonc
{
  "kind": "outfit",
  "recommendation": {
    "pieces": [{ "slot": "top", "product": { /* product */ } }],
    "total": { "amount": 100, "currency": "GBP" },
    "reason": "Built around match day, leaning navy."
  }
}
```

Slots are `top`, `bottom`, `layer`, `accessory`. **Any of them can be missing**
— if nothing in stock genuinely fits a slot we leave it out rather than pad the
outfit, so do not assume four pieces.

### cart

```jsonc
{
  "kind": "cart",
  "cart": {
    "id": "gid://shopify/Cart/...",
    "checkoutUrl": "https://qqfeqi-xb.myshopify.com/cart/c/...",
    "lines": [{
      "lineId": "gid://shopify/CartLine/...",
      "variantId": "gid://shopify/ProductVariant/...",
      "title": "TOUR SHORT - NAVY - 34",
      "imageUrl": "https://cdn.shopify.com/...",
      "quantity": 1,
      "unitPrice": { "amount": 42, "currency": "GBP" },
      "lineTotal": { "amount": 42, "currency": "GBP" }
    }],
    "subtotal": { "amount": 42, "currency": "GBP" },
    "totalQuantity": 1
  }
}
```

`checkoutUrl` is a real Shopify checkout — send the customer straight there.
`productId` is empty on cart lines; Shopify identifies a line by its variant.

## Money

```jsonc
{ "amount": 42, "currency": "GBP" }   // £42.00
```

**Already in pounds.** Not pence. Format with the currency code — the store is
GBP now but that is a setting, so do not hard-code `£`.

## Adding to the basket

Do not send a variant id. Send the product and what the customer chose:

```jsonc
POST /api/tools/add_to_cart
{ "args": { "productId": "gid://shopify/Product/...", "options": { "Size": "34" }, "quantity": 1 } }
```

The server resolves the variant, checks stock, and returns the updated cart.
Omit `options` when the product has nothing to choose. If a size is needed and
missing, you get back a question in `speech` rather than a guess.

Out of stock comes back as a normal reply, not an error:
`"The TOUR SHORT - NAVY in 40 is out of stock. Shall I check another size?"`
That one is out of stock on purpose, so it can be tested — do not report it as
a bug.

## Errors

```jsonc
{ "error": "upstream_error", "detail": "Shopify UCP tool search_catalog failed" }
```

`400` bad input · `413` audio too large · `429 rate_limited` too many
requests, `retryAfter` is in seconds · `501` feature not configured ·
`502 upstream_error` Shopify or OpenAI failed · `500` our bug.

A `429` is not a bug to work around. The endpoint is public and spends money
on every call, so a session gets 40 messages an hour and voice 30. Show the
`detail` text and let the customer try again.

Messages that are clearly not about shopping - homework, code, attempts to
change how the Caddie behaves - come back as a normal reply declining, not an
error, so there is nothing special to render.

A `502` is usually transient — offer a retry rather than a dead end.

## Things to know

- **Only Druids products come back.** The test store also holds generic demo
  stock (jeans, dresses) which is filtered out. If a search returns nothing,
  that can be correct.
- **Prices and stock are live.** Everything comes from the real Shopify
  catalogue, so results change as the store changes.
- **Sessions are in memory.** A backend restart forgets every conversation and
  basket. Expect it during the sprint.
