# Smart Cart: the complete brief

Written for: the Druids team (commercial and web, including Asim) and the Caddie team.

Status on 1 Oct 2026: working on the copied theme ("Copy of  DRUIDS - SPORT TYPE - AsimAli", `159899418724`) and on the Caddie's local server. Nothing is live on the published theme or the production Caddie yet.

---

## 1. The problem

Druids sells multi-buy deals such as **Any 3 Polos for £59.99**. The discount is applied by **SupaEasy**, a Shopify app, at checkout. But a customer who picked three polos from normal product pages often paid full price: some add-to-cart buttons told SupaEasy the item was part of a deal, and others didn't. Nobody could see why, and the customer was never told they were one item away.

Smart Cart fixes both:
1. **Every way of adding a qualifying product marks it for the deal**, so SupaEasy discounts it.
2. **The customer sees their progress**: "Any 3 Polos · 2/3 · Choose any 1 more polo to complete the deal". Then they see the real saving once it's applied.

**SupaEasy stays the only thing that sets prices.** Smart Cart never calculates a discount.

## 2. How SupaEasy works

We read SupaEasy's settings with **read-only** access and **changed nothing**: no discount, price, key or setting. What we found:

- **Each deal or pack is an automatic discount with a "key".** For example, Any 3 Polos looks for the key `__3_Polo_Bundle` on a basket line.
- **SupaEasy checks only the key, never the product.** Any line carrying the key (with a non-empty value) counts, whatever the product is. So *which products can get the key* is decided by the website (the theme and the Caddie), not by SupaEasy.
- **Quantity counts as units.** One line with quantity 2 counts as 2.
- **It prices from the sale price actually charged,** never the crossed-out "was" price. It groups the dearest items first, and takes off only what a set costs **above** the deal price. If the items already cost the deal price or less, **the saving is nothing**. That's correct, not a fault. Example: three polos at £18 + £18 + £24 = £60.00 → deal £59.99 → saving **£0.01**.
- **Each deal has a price per market** (UK, Ireland, US…). A market not on its list gets no discount.
- **In the basket,** the discount shows under the product with the deal's name ("ANY 3 POLO BUNDLE", "ANY 2 TROUSERS"), and the line price drops.

## 3. The two kinds of deals

### "Any N" deals: any qualifying items

Any 3 polos, any 2 trousers, any 2 shorts. Every qualifying item counts on its own, so **the key on each item is all that's needed**. Smart Cart covers these:

| Deal | Key written on the item | Which products | UK |
| --- | --- | --- | --- |
| Any 3 Polos (men) | `__3_Polo_Bundle` = `3_Polo_Bundle` | tag `bundle_threepolo` | £59.99 |
| Any 2 Trousers (men) | `__any-2-trousers` = `any-2-trousers` | collection `men-golf-trousers` | £49 |
| Any 2 Shorts (men) | `__any-2-trouser-shorts` = `any-2-trouser-shorts` | collection `men-golf-shorts` | £45 |
| Any 3 Kids Polos | `__bundle_threepolo_kids` = `bundle_threepolo_kids` | tag `bundle_threepolo_kids` | £49 |
| Any 2 Ladies Trousers | `__ladies-any-2-trousers` = `ladies-any-2-trousers` | collection `ladies-trousers` | £49 |
| Any 2 Kids Trousers | `__kids-any-2-trousers` = `kids-any-2-trousers` | collection `kids-trousers` | £49 |
| Any 2 Ladies Shorts | `__any-2-shorts` = **`ladies`** | collection `ladies-shorts` | £45 |
| Any 2 Kids Shorts | `__any-2-shorts` = **`kids`** | collection `kids-shorts` | £45 |
| Any 3 Ladies Polos | `__bundle_threepolo_ladies` = `bundle_threepolo_ladies` | tag `bundle_threepolo_ladies` | £59.99 |

- **Ladies and kids shorts share one key.** SupaEasy tells them apart by the **value**, which must be exactly `ladies` or `kids`.
- **A product matching two deals gets no key,** as a safety rule. A wrong key means a wrong price. One exception was decided on 1 Oct: ladies shorts are also in the `ladies-trousers` collection, and the **shorts deal wins** for them.
- **Ladies polos use the £59.99 deal** (`__bundle_threepolo_ladies`, the key the product pages already write), decided on 1 Oct. The £55 discount (`__any-three-ladies-polos`) is not used.
- **The UK deal price is only shown in a GBP basket.** SupaEasy charges other markets their own deal price, so elsewhere the deal is named without a price, and any saving is shown in that currency.

### Fixed packs: a set recipe

Ambassador (6 pieces: jacket, midlayer, polo, trousers, belt or cap, socks), Prestige, Players, Rainsuit, Layering Duo, Summer and the condition packs. These are **recipes** built step by step on a pack page.

**Smart Cart does not touch fixed packs, on purpose.** Their SupaEasy discount doesn't check the recipe either. The Ambassador discount only checks "6 units carrying `__golf-ambassador-pack`". If we put a pack key on single items, **six polos would get the Ambassador price**. So pack keys come **only** from the pack pages, where the steps control what goes in. Packs keep working exactly as before.

### Can one product be in both?

Yes. The same trousers can be "any 2 trousers" **and** the trousers step of an Ambassador pack. **Each basket line counts towards one deal only: the one whose key it carries.** That depends on how it was added: a product page or collection card writes the "any N" key, the pack page writes the pack key. There's no double discount, because a line only ever carries one key.

`eligibility/products.csv` lists every active product and every deal or pack it can go into.

## 4. What we built

### In the Caddie (server and widget)

- **Fresh basket.** Before every chat or voice turn, and whenever the theme's cart changes, the Caddie reads the real Shopify cart (`/cart.js`). Its basket is never a copy that can drift.
- **Progress, counted exactly as SupaEasy counts.** The server counts units carrying each deal's key (`apps/server/src/smartCart/`). No product names, no guessing, no AI.
- **Keys on the Caddie's own adds.** When the Caddie adds a qualifying product, it writes the same key the theme writes. SupaEasy then prices it normally.
- **Honest nudges.** The card appears only if the deal would actually lower the price at today's sale prices. Two £20 joggers against "2 for £49" save nothing, so no nudge is shown.
- **"Show me polos / trousers / shorts".** This suggests in-stock qualifying products, not already in the basket, that would make the deal worth it.
- **Wording.** "Any 3 Polos · 3 for £59.99 · Choose any 2 more polos to complete the deal". It never says "save £x", "unlocked" or "your price" before SupaEasy has actually applied a discount.
- **Switched on only where the theme asks.** The copied theme's Caddie tag carries `data-smart-cart-preview="true"`; the live theme doesn't, so it's unchanged.

### In the theme (copied theme, 7 files)

All in `docs/smart-cart/theme-snippets/`, applied and checked on 30 Sep:

| File | What it does |
| --- | --- |
| `snippets/smart-cart-deal-key.liquid` (new) | Decides the key for a product, with the same rules as the Caddie. Used by the files below. |
| `blocks/buy-buttons.liquid` | Product page **Add** writes the key |
| `snippets/quick-add.liquid` | Standard **quick add** writes the key |
| `snippets/sport-collection-card3.liquid` + `-assets.liquid` | **Collection page cards** (Add and the size sheet) write the key |
| `snippets/sport-cart-progress.liquid` | The **deal box** at the top of the bag: progress, then "✓ Deal applied · you save £x" (read from Shopify) |
| `snippets/cart-products.liquid` | The line under each product: "Part of Any 3 Polos" / "✓ Any 3 Polos applied" |

(An earlier edit also makes the drawer's Complete the Look "+" write the key for the men's deals.)

## 5. How it works for a customer

1. They add a polo **any way they like**: product page, collection card, quick add, the drawer "+" or the Caddie. The line gets `__3_Polo_Bundle`.
2. The bag shows **Any 3 Polos · 1/3 · Choose any 2 more polos to complete the deal**. The Caddie's basket shows the same, with a **Show me polos** button.
3. At three polos, SupaEasy applies the deal. The bag shows **✓ Deal applied · you save £12.01**, and each line shows "✓ Any 3 Polos applied" with the pre-deal price crossed out.

## 6. Proven on the copied theme

| Basket | Before | After |
| --- | --- | --- |
| 2 × Men's Clima Golf Trousers (£30), added by the Caddie | £60.00 | **£49.00** ("ANY 2 TROUSERS") |
| 2 × Comfort Shorts (£26), added by the Caddie | £52.00 | **£45.00** ("ANY 2 SHORTS") |
| 3 × Abstract Emotive Polo (£24) | £72.00 | **£59.99**, "you save £12.01" |
| 3 polos at £18, £18, £24 | £60.00 | £59.99, a 1p saving (correct by SupaEasy's rules) |

Also checked: product pages and collection cards on the preview now carry the right key on every men's polo, trouser and short.

## 7. Problems found, for Druids

1. **Four packs on the copied Ambassador page won't be discounted.** Ladies Mixed, Ladies Cool & Wet, Kids Mixed and Kids Cool & Wet write keys that no SupaEasy discount reads. **Fix before that theme goes live:** add the discounts in SupaEasy, or point those cards at existing keys.
2. **Three SupaEasy packs can't be bought anywhere.** Caddy Club Ambassador, Caddy Club Rainsuit and Ladies Summer Bundle are active, but no page writes their keys.
3. **Two copied-theme cards write the men's trousers key on women's and juniors' trousers.** It's the same £49 in the UK, but the wrong deal name.
4. **27 ladies shorts are also in the `ladies-trousers` collection.** Decided: the shorts deal wins. Tidying the collection would still be cleaner.
5. **Ladies polos:** decided, the £59.99 deal. The £55 discount (`LADIES ANY 3 POLO`) is still live in SupaEasy, and only one copied-theme card writes its key. Worth switching that discount off, or pointing that card at the £59.99 key.
6. **Some deals are no longer worth much.** Many polos, trousers and shorts are already on sale close to or below the deal price, so a deal can save pennies or nothing. That's a pricing decision, not a technical one.

## 8. What's next

- **Deploy the Caddie server** (`caddie.druids.online`) with this code, and upload the matching widget build, when approved.
- **Before the copied theme is published:** fix problem 1, and remove the test flag `data-smart-cart-debug`.
- **Tell Asim** that the 7 theme files changed, so his later edits don't overwrite them.
- **Optional later:** fixed packs recognised from single adds (only safely, by matching the full recipe), the Caddie mentioning deal progress in chat, and ladies polos once decided.

## 9. Spoken replies (separate feature)

The Caddie can now read its answer aloud when the customer asks by **voice**. Typed questions stay silent.

- **Model:** `gpt-4o-mini-tts-2025-12-15`. The "GPT 6.1 sol" model on the account is not a speech model: OpenAI's speech endpoint refused it.
- **Voice:** `sage`, chosen from nine samples. Its instructions: a friendly, relaxed London golf-shop assistant; natural southern British accent; conversational pace; lower, natural pitch. All set in `.env` (`OPENAI_VOICE_MODEL`, `OPENAI_VOICE`, `OPENAI_VOICE_INSTRUCTIONS`); off unless `OPENAI_VOICE_MODEL` is set.
- **Safety:** only the Caddie's own checked reply is spoken, looked up by message id. What you hear matches the screen, and nobody can use it to speak arbitrary text.
- **Why it isn't heard yet on the copied theme:** the theme's `caddie.js` is an older build from before this feature. Upload `apps/widget/builds/local/caddie.js` and `caddie.css` to fix it.
- **Also needed:** the per-minute price in the usage dashboard, and approval to deploy.

### What voice costs

These are OpenAI's published rates for these models as we know them. **Check them on OpenAI's pricing page before relying on them**, because rates change. Model names are as reported by the server's `/health`.

| Part of a voice turn | Model | Rate | A typical Caddie turn |
| --- | --- | --- | --- |
| Hearing the customer (speech to text) | `gpt-4o-transcribe` | about **$0.006 per minute** of audio | a 5-second question ≈ **$0.0005** |
| Speaking the reply (text to speech) | `gpt-4o-mini-tts` | about **$0.015 per minute** of speech ($0.60 per million text tokens in, $12 per million audio tokens out) | a 1–2 sentence reply, ~8 seconds ≈ **$0.002** |
| Working out the answer (chat) | `gpt-4.1-mini` | measured at $3.20–$3.90 per 1,000 conversations | unchanged by voice |

**In round numbers,** voice adds about **$2.50 per 1,000 voice turns** (≈ $0.0025 each, around a fifth of a penny), on top of the chat cost. Typed turns cost nothing extra: only voice questions get a spoken reply.

- **Cost is capped per request:** a spoken reply is limited to 1,000 characters.
- **Cost is capped per shopper:** each session may ask for 60 spoken replies an hour, each address 300.
- **The usage dashboard (`/admin`)** records every spoken reply as `speak`, but shows its cost as **£0** until the per-minute rate is added to `apps/server/src/usage/pricing.ts`. We haven't guessed the rate there.
- **A cheaper option:** `gpt-4o-mini-transcribe` would halve the hearing cost (about $0.003 per minute), at some accuracy cost on accents and brand names.

## Where everything is

| What | Where |
| --- | --- |
| This brief | `docs/smart-cart/BRIEF.md` |
| Technical guide (Caddie) | `docs/smart-cart/README.md` |
| Theme files and how to apply them | `docs/smart-cart/theme-snippets/` (start with its `README.md`) |
| Which product is in which deal or pack | `docs/smart-cart/eligibility/README.md`, `products.csv` |
| SupaEasy research and checkout tests | `docs/smart-cart/research/` |
| Caddie code | `apps/server/src/smartCart/`, `apps/widget/src/components/SmartCartProgress.tsx` |
