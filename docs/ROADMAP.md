# Personal Caddie - 2 week roadmap

From `Personal Caddie - 2 Week Roadmap.pdf`, turned into something we can tick
off. Standup every day, 10-15 minutes: done, doing, blocked.

**Definition of done for any day:** it runs against the real store, the other
person has seen it work, and no placeholder data is left in that flow.

---

## Week 1 - Build the core

### Day 1 - Foundations
**Talha**
- [ ] Set up Vapi, assistant created, keys in `.env`
- [ ] Connect the AI (`npm run sync:assistant`, ngrok pointing at the webhook)
- [ ] Backend running (`npm run dev:server`, `/health` green)
- [ ] One simple AI tool working end to end

**Amir**
- [ ] Caddie widget running (`npm run dev:widget`)
- [ ] Chat and voice buttons in place
- [ ] Basic message and product-card UI

*Scaffolded already: server, widget shell, chat, SSE, tool registry, product card, voice button.*

### Day 2 - Live products
**Talha**
- [ ] Shopify MCP connected - `GET /health/shopify` returns the tool list
- [ ] Product search returning real Druids products
- [ ] Product details and variants verified (option names, stock flags)

**Amir**
- [ ] UI wired to real product results
- [ ] Image, name, price and options all render
- [ ] Long titles, missing images and 0 results all handled

> Day 2 is the day the normalisers in `src/shopify/catalog.ts` get checked
> against what this store actually returns. Log one raw payload and read it.

### Day 3 - Search via AI
**Talha**
- [ ] Product search works through the AI, not just the dev router
- [ ] System prompt tightened (`src/ai/prompt.ts`)
- [ ] AI confirmed not inventing products or prices - try to make it slip

**Amir**
- [ ] Product carousel
- [ ] Product selection
- [ ] Loading and error states

### Day 4 - Find my size
**Talha**
- [ ] **Replace `data/size-chart.json` with the real Druids size guide**
- [ ] Size recommendation returning sensible sizes across the range
- [ ] Tested with a spread of customer measurements (`npm run test`)

**Amir**
- [ ] Size questions UI
- [ ] Recommended size shown clearly, with the "not certain" state handled

### Day 5 - Ambassador pack
**Talha**
- [ ] Pack recommendation live
- [ ] Budget, colour and size preferences respected
- [ ] Real Shopify products only

**Amir**
- [ ] Pack UI, multiple products together
- [ ] Total price
- [ ] Over-budget state

**End of week 1:** search, size and pack all live on real products. No fake data in those three.

---

## Week 2 - Complete, polish and test

### Day 6 - Outfit builder
**Talha**
- [ ] Outfit recommendation live
- [ ] Matching on style, colour and budget
- [ ] Real products per slot

**Amir**
- [ ] Outfit display, complete look
- [ ] Total price

### Day 7 - Conversation memory
**Talha**
- [ ] Conversation details saved across turns
- [ ] "Cheaper", "different colour", "another product" all work
- [ ] Conversation still feels natural, not interrogative

**Amir**
- [ ] UI updates when a recommendation changes
- [ ] Replace and change states

### Day 8 - Basket and cart
**Talha**
- [ ] Shopify cart connected
- [ ] Add, remove, change quantity
- [ ] Variants checked before adding

**Amir**
- [ ] Basket UI: size, colour, quantity, total
- [ ] Checkout button

### Day 9 - Voice quality
**Talha**
- [ ] Voice conversations improved
- [ ] Interruptions handled
- [ ] Short replies work: "yes", "no", "show another"

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
