# Personal Caddie - 2 week roadmap

From `Personal Caddie - 2 Week Roadmap.pdf`, turned into something we can tick
off. Standup every day, 10-15 minutes: done, doing, blocked.

**Definition of done for any day:** it runs against the real store, the other
person has seen it work, and no placeholder data is left in that flow.

---

## Week 1 - Build the core

### Day 1 - Foundations
**Talha**
- [ ] Set up Vapi, assistant created, keys in `.env` - **blocked, needs keys**
- [x] Connect the AI - done as our own OpenAI tool-calling loop rather than via Vapi
- [x] Backend running (`npm run dev:server`, `/health` green)
- [x] One simple AI tool working end to end - eight of them

**Amir**
- [ ] Caddie widget running (`npm run dev:widget`)
- [ ] Chat and voice buttons in place
- [ ] Basic message and product-card UI

*Scaffolded already: server, widget shell, chat, SSE, tool registry, product card, voice button.*

### Day 2 - Live products
**Talha**
- [x] Shopify Storefront MCP connected (UCP endpoint) - `GET /health/shopify` returns the tool list and real products
- [x] Product search returning real Druids products - off the local mirror, not UCP
- [x] Product details and variants verified (option names, stock flags)

**Amir**
- [ ] UI wired to real product results
- [ ] Image, name, price and options all render
- [ ] Long titles, missing images and 0 results all handled

> Day 2 is the day the normalisers in `src/shopify/catalog.ts` get checked
> against what this store actually returns. Log one raw payload and read it.
>
> Already verified against `qqfeqi-xb.myshopify.com` (44 live Druids products):
> search, product detail, and add / merge / remove on the cart. Four UCP
> behaviours that cost time if you do not know them — agent profile must be
> publicly reachable, prices are in minor units, cart updates replace rather
> than merge, and options are not variants — are written up in the README.

### Day 3 - Search via AI
**Talha**
- [x] Product search works through the AI, not just the dev router (OpenAI tool-calling loop)
- [x] System prompt tightened (`src/ai/prompt.ts`)
- [x] AI confirmed not inventing products or prices - it slipped three times, see below

**Amir**
- [ ] Product carousel
- [ ] Product selection
- [ ] Loading and error states

> Three real slips found by trying to make it lie, all now closed:
> 1. Called six mixed polos "six black polos" - it only knew the result count,
>    so it filled the gap with the customer's own words. Tools now return a
>    FACTS block listing what actually came back.
> 2. Confirmed a product that does not exist ("the Tour Championship jacket")
>    because semantic search always returns neighbours. Search results are now
>    worded as "closest matches", and the prompt says a result is not proof.
> 3. **Invented variant ids** when asked to add to the basket - a different
>    fabricated id each time. Instructions did not stop it, so `add_to_cart`
>    no longer accepts a variant id at all: it takes a product id plus the
>    chosen options and resolves the variant server side.

### Day 4 - Find my size
**Talha**
- [x] **Replaced `data/size-chart.json` with the real Druids size guide** (druids.com published charts)
- [x] Size recommendation returning sensible sizes across the range
- [x] Tested with a spread of customer measurements (`npm run test`)

> Shopify does not carry body measurements. Its catalogue gives us the sizes a
> product *offers* and some fit prose ("Relaxed Fit", "the model is 6'1" and
> wears a medium"), but the chest-to-size mapping is not in it.
>
> The chart is ported from Talha's try-on work:
> `druids-automation/druids-tryon/widget/src/sizeGuide.ts`, which mirrors the
> live Size Guide popup. **That file is the source of truth** - if it changes,
> change `data/size-chart.json` with it.
>
> Mens and womens are different systems (S-4XL by chest vs UK 8-18), so the
> Caddie asks which range rather than assuming, unless the customer is already
> browsing one. Belts have their own chart; socks have none at all, and the
> Caddie says so instead of calling a size.
>
> Druids publishes no height/weight mapping, so inferring a size from those is
> **our** estimate. It is weighted far lower, capped at 0.55 confidence, and the
> Caddie says "that is my estimate rather than a measurement". Do not let that
> slip: a wrong size is a return.

**Amir**
- [ ] Size questions UI
- [ ] Recommended size shown clearly, with the "not certain" state handled

### Day 5 - Ambassador pack
**Talha**
- [x] Pack recommendation live
- [x] Budget, colour and size preferences respected
- [x] Real Shopify products only

**Amir**
- [ ] Pack UI, multiple products together
- [ ] Total price
- [ ] Over-budget state

**End of week 1:** search, size and pack all live on real products. No fake data in those three.

---

## Week 2 - Complete, polish and test

### Day 6 - Outfit builder
**Talha**
- [x] Outfit recommendation live
- [x] Matching on style, colour and budget
- [x] Real products per slot

**Amir**
- [ ] Outfit display, complete look
- [ ] Total price

### Day 7 - Conversation memory
**Talha**
- [x] Conversation details saved across turns - Redis-backed, so it survives more than one instance
- [x] "Cheaper", "different colour", "another product" all work
- [x] Conversation still feels natural, not interrogative

**Amir**
- [ ] UI updates when a recommendation changes
- [ ] Replace and change states

### Day 8 - Basket and cart
**Talha**
- [x] Shopify cart connected - on the Storefront API, which buyer traffic is not rate limited on
- [x] Add, remove, change quantity - verified end to end against the real store
- [x] Variants checked before adding
- [x] Off UCP. Adding a second item no longer clears the first.

**Amir**
- [ ] Basket UI: size, colour, quantity, total
- [ ] Checkout button

### Day 9 - Voice quality
**Talha**
- [x] Voice in, chat out - the mic works today through transcription
- [ ] Interruptions handled - **needs Vapi**
- [ ] Spoken replies - **needs Vapi**
- [x] Short replies work: "yes", "no", "show another"

**Amir**
- [ ] Voice UI polished
- [ ] Listening, speaking, loading states
- [ ] Mobile voice controls easy to hit

### Day 10 - Connect everything
**Talha**
- [ ] Everything connected
- [ ] **All test and fake data removed**
- [ ] Every recommendation uses real Druids products

**Amir**
- [ ] Complete UI finished
- [ ] Desktop and mobile layouts checked
- [ ] Fake product data gone

### Day 11 - Testing starts
**Talha**
- [ ] Size journey
- [ ] Pack journey
- [ ] Outfit journey
- [ ] AI and backend problems fixed

**Amir**
- [ ] Same 3 journeys
- [ ] UI bugs reported (write them down)
- [ ] Product cards and basket checked

### Day 12 - Bug fixing
**Talha**
- [ ] Important backend and AI bugs fixed
- [ ] Errors and slow responses checked
- [ ] Cart and variant handling checked

**Amir**
- [ ] iPhone Safari
- [ ] Android Chrome
- [ ] Desktop Chrome / Edge / Safari

### Day 13 - Stress test
**Talha**
- [ ] Conversations stress tested
- [ ] Wrong inputs handled
- [ ] Tool, voice and Shopify errors fixed

**Amir**
- [ ] Responsive bugs fixed
- [ ] Loading and error states fixed
- [ ] Final visual cleanup

### Day 14 - Release
**Talha**
- [ ] Final integration
- [ ] Final AI test
- [ ] Secrets and production settings checked
- [ ] Release approved

**Amir**
- [ ] Final device test
- [ ] Final UI check
- [ ] All 3 journeys confirmed start to checkout

---

## The three journeys that must work

1. **Size** - customer gives height, weight and usual size, Caddie recommends a size, customer adds it.
2. **Pack** - customer asks for several products with a budget, Caddie recommends, customer changes one, adds them.
3. **Outfit** - customer gives an item or occasion, Caddie builds an outfit, customer changes colour or price, adds it.
