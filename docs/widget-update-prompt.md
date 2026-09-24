# Widget catch-up: what changed on the server

Paste this to a coding agent working in `apps/widget`.

---

You are working on `apps/widget` in the Druids Personal Caddie monorepo. It is
the storefront widget, and it is the only app you may edit — `apps/server`,
and `packages/shared` belong to someone else. If something
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

## 2. Packs are real now, and a pack price is not the sum of its pieces

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

## 3. The page context you were already sending is now used

`readPageContext` has been feeding the server product ids all along and the
server ignored them. It does not any more. A customer on a product page can say
"does this come in a large?" without naming anything and the Caddie knows what
"this" is.

Nothing to change. Worth knowing so you can test it: mount the widget with
`data-page-type="product"` and `data-product-id` set, then ask about "this".

One detail — a theme's `{{ product.id }}` is a bare number, not a GID. The
server now accepts either, so your `toProductGid` conversion is belt and braces
rather than required.

## 4. Voice: five separate bugs, all yours to fix now

`apps/caddie-ui` has been removed, so the widget is the only UI. Its recorder was written before any of this was found, and every one of these was a real failure in front of a real customer. They are listed in the order they bite.

### 4a. Never send silence to the transcriber

A customer tapped the mic, said nothing, and this appeared as **their own message**:

> "I need a medium polo, a large midlayer, and an extra-large gilet."

They had not spoken. Given silence, a transcription model does not return nothing - it invents, out of whatever vocabulary it was primed with, and the server's prompt listed exactly those garments and sizes. The Caddie then went looking for them. One step further and it is a basket nobody asked for.

The server side is fixed: it sends **no prompt at all** now, refuses very short clips, and drops a transcript claiming more words than the audio could hold. But the server only sees the words that come back. **The browser knows whether the microphone heard anything**, so that is where the real check belongs.

```ts
// while recording, per animation frame
analyser.getByteTimeDomainData(data);
let peak = 0;
for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128);
loudest = Math.max(loudest, peak);
meteredFrames += 1;
```

### 4b. That check must fail open

Everything that measures level can fail quietly - the AudioContext refuses to start, the graph throws, the browser suspends it. The peak then stays at zero, which looks **identical to silence**, and a customer who spoke perfectly clearly is told they were not heard. That happened.

So only trust the reading once you have one:

```ts
const measured = meteredFrames >= 5;
const heardSomething = !measured || loudest > 0.02;
if (!heardSomething) { /* do not send; say so, and include the peak */ }
```

No frames means no evidence, and no evidence means send the audio. A stray clip costs a fraction of a penny; refusing someone who is talking costs the sale. Put the measured peak in the message you show - when it goes wrong that number is the difference between a bad threshold and a dead audio graph.

### 4c. Do not call getUserMedia on the button press

It takes a few hundred milliseconds to bring a device up, and recording starts on the press - so the first word goes into a microphone that is not running yet. **Every single recording.** Keep the stream open between turns and release it on a timer: long enough that the next turn is instant, short enough that the browser's recording indicator clears. Twenty-five seconds works.

### 4d. Leave autoGainControl on

Turning it off gives a truer level reading and a worse recording: a quiet talker stays quiet, noise suppression trims the soft consonants, and words vanish from the middle of sentences. Capture quality wins - the silence check only has to catch a dead microphone.

```ts
audio: { autoGainControl: true, noiseSuppression: true, echoCancellation: true }
```

### 4e. Never close the AudioContext while the track is live

This one is subtle and cost the most time. If you keep the microphone stream open between turns (4c) but tear the metering graph down after each one, **closing an AudioContext that still has a MediaStreamAudioSourceNode attached degrades the track** - and the *next* recording comes back near-silent. Nine seconds of speech transcribed as eight characters.

Suspending it instead is not the answer either: `resume()` is asynchronous, so the first frames of the next turn read as silence and the level never rises - which is 4b happening again.

Just stop the animation frame. Leave the context running. Close it when you release the microphone, in that order.

### 4f. Keep recording for ~200ms after the release

People let go as they finish the last word rather than after it, so stopping on the release takes the tail with it - "polos" arrives as "polo".

### How to tell which one you are hitting

The server logs every transcription with the audio size, the format and the text. In development it also **saves any clip that produced suspiciously little text to a file** and logs the path. If voice misbehaves, look there before guessing: it separates "the microphone recorded nothing", "the recording was truncated" and "good audio the model declined to transcribe", which are three different bugs that look identical from the UI.

## 5. Sizes are read properly now

The server understands "Medium" as well as "M", and knows that trousers are
sized by waist rather than S/M/L. If your size form sends whole words, that is
fine. A `null` size is still a real answer, not a failure — render `reason`.

## How to check you are done

Run the widget against a local server and confirm all of these:

1. Ask for a size, then an outfit. The outfit respects the size.
2. Add two different products to the basket. **The second does not replace the
   first.** Shopify's cart update replaces lines rather than merging them, so
   this is the one that catches a cart written the naive way.
3. Ask about the Ambassador Pack. It shows £99 and six pieces, and the price
   on screen is £99 rather than £148.
4. On a product page mount, ask "does this come in a large?" without naming the
   product.
5. **Hold the mic and say nothing, then let go.** Nothing should be sent and you
   should be told you were not heard. If a message appears, the silence guard
   is not working and the Caddie can be made to act on words nobody said.
6. Reload the widget mid-conversation. Keep the same `sessionId` and the
   Caddie still knows the customer — the conversation lives on the server,
   keyed on that id, for two hours.

The server is checked with `npm run typecheck` and `npm run test` from the
repository root. UI is checked by driving it, not by typechecking it — open it
and look at it.
