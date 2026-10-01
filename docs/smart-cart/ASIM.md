# Smart Cart: what changed in the theme, and what to keep

For Asim. The state at 1 Oct 2026, on the **copied theme (159899418724, not published)**. The live theme is unchanged.

## In one paragraph

SupaEasy's "any N" deals (any 3 polos, any 2 trousers, any 2 shorts, for men, ladies and kids) only price a cart line that carries the deal's **key**, a hidden line item property such as `__3_Polo_Bundle=3_Polo_Bundle`. Until now only the deal pages wrote it, so a polo added from its product page paid full price. Smart Cart writes the key **wherever** a qualifying product is added, and shows the customer how close they are to the deal in the bag. SupaEasy is still the only thing that sets a price. Nothing in Smart Cart calculates a discount.

## The keys

One product gets at most one key. A product that would match two gets none, because SupaEasy checks only the key, never the product, so a wrong key means a wrong price.

| Deal (SupaEasy title) | Key = value | Which products |
| --- | --- | --- |
| ANY 3 POLO BUNDLE (3 for £59.99) | `__3_Polo_Bundle=3_Polo_Bundle` | tag `bundle_threepolo` |
| ANY 3 POLO LADIES BUNDLE (3 for £59.99) | `__bundle_threepolo_ladies=bundle_threepolo_ladies` | tag `bundle_threepolo_ladies` |
| ANY 3 POLO KIDS BUNDLE (3 for £49) | `__bundle_threepolo_kids=bundle_threepolo_kids` | tag `bundle_threepolo_kids` |
| ANY 2 TROUSERS (2 for £49) | `__any-2-trousers=any-2-trousers` | collection `men-golf-trousers` |
| LADIES ANY 2 TROUSERS (2 for £49) | `__ladies-any-2-trousers=ladies-any-2-trousers` | `ladies-trousers`, **except** anything also in `ladies-shorts` |
| KIDS ANY 2 TROUSERS (2 for £49) | `__kids-any-2-trousers=kids-any-2-trousers` | `kids-trousers` |
| ANY 2 SHORTS (2 for £45) | `__any-2-trouser-shorts=any-2-trouser-shorts` | `men-golf-shorts` |
| LADIES ANY 2 SHORTS (2 for £45) | `__any-2-shorts=ladies` | `ladies-shorts` |
| KIDS ANY 2 SHORTS (2 for £45) | `__any-2-shorts=kids` | `kids-shorts` |

The last two share one key. SupaEasy tells them apart by the **value**, so `ladies` and `kids` must be written exactly.

**Fixed packs are deliberately left out:** Ambassador, Rainsuit, Layering Duo, Players, Prestige and Summer. SupaEasy counts units carrying a pack's key, not the pack's recipe, so a pack key on single adds would let six polos through at the Ambassador price. Packs are still sold only through their pack pages. The £55 "LADIES ANY 3 POLO" discount is also left out (Druids: £59.99 is the right one).

## Theme files

All the final versions are in `docs/smart-cart/theme-snippets/` in the Caddie repo. **If you edit any of these, keep the Smart Cart parts.** Each is marked with a `Smart Cart` comment.

| File | What Smart Cart does there |
| --- | --- |
| `snippets/smart-cart-deal-key.liquid` (new) | Decides the key for a product, with the rules above. Every other file asks it rather than repeating the rules. |
| `blocks/buy-buttons.liquid` | The product page's Add writes the key (a hidden `properties[...]` input). |
| `snippets/quick-add.liquid` | Quick add writes the key. |
| `snippets/sport-collection-card3.liquid` | Collection cards carry `data-deal-key` / `data-deal-value`... |
| `snippets/sport-collection-card3-assets.liquid` | ...which the card's Add and size sheet send as properties. |
| `snippets/sport-cart-progress.liquid` | **Updated 1 Oct.** The deal box at the top of the bag. |
| `snippets/cart-products.liquid` | **Updated 1 Oct.** The line under each product: "Part of Any 3 Polos" / "✓ Any 3 Polos applied". |

The drawer's Complete the Look "+" also writes the key for the men's deals, from an earlier edit.

### What changed on 1 Oct (please re-paste these two)

Druids asked for the saving as a percentage, and for deals that save next to nothing not to be shown ("1p is not a discount").

- **`sport-cart-progress.liquid`**
  - When SupaEasy has applied a deal, it now reads "✓ Deal applied · you save £12.01 (16%)". The percentage is the saving divided by the deal lines' `original_line_price`, rounded down.
  - A finished deal that saved **under 5%** is hidden completely, and so is one that saved nothing.
  - The old "Your polos qualify · priced at checkout" line is gone: a finished deal either shows its saving or isn't shown.
  - While a deal is still being built, the progress still shows, because the theme can't know what the missing items will cost.
- **`cart-products.liquid`:** the "✓ … applied" line label is hidden when that line's own saving is under 5%.

**The 5% figure lives in three places and must stay the same in all three:**
- `sc_min_percent` in `sport-cart-progress.liquid`;
- the `5` in `cart-products.liquid`;
- `MIN_SAVING_PERCENT` in the Caddie server (`apps/server/src/smartCart/config.ts`).

It's our figure until Druids confirm one.

## A theme editor change (no code)

On the page **`choose-two-trousers-temp`**, the gender select section has a card per sport. Four of them write the **men's** trousers key on women's and juniors' trousers. Druids want them pointed at the right deals. On each card, set **"Script Properties (one per line, KEY=VALUE)"** to:

| Card | Script Properties |
| --- | --- |
| WOMEN, padel | `__ladies-any-2-trousers=ladies-any-2-trousers` |
| WOMEN, fishing | `__ladies-any-2-trousers=ladies-any-2-trousers` |
| JUNIORS, padel | `__kids-any-2-trousers=kids-any-2-trousers` |
| JUNIORS, fishing | `__kids-any-2-trousers=kids-any-2-trousers` |

The golf cards are already correct, and the Men cards stay as they are.

## The Caddie's side, briefly

The Caddie is the chat and voice assistant, loaded by the theme's `caddie.js` / `caddie.css`.

- **It reads the real cart** (`/cart.js`) before each reply and whenever the bag changes. It watches the `#cart-drawer` redraw on this theme, so it needs no events from you.
- **It writes the same keys** on what it adds itself, with the same rules as the theme.
- **It fixes lines added without a key (new).** If a qualifying item is in the bag with no properties at all, the Caddie re-writes that line with its key (`/cart/change.js`, same quantity), and the bag then counts it. This covers items added before the theme stamped keys, and any add path that still doesn't: an add-on app, or a section this copy hasn't had updated. A line with **any** properties of its own (a pack piece, an app's line, a line that already has a key) is never touched.
- **It shows the same deal card in its own basket,** with the same 5% rule and the same "you save £x (y%)" wording, plus a "Show me polos" button.
- **All of this runs only where the Caddie's tag carries `data-smart-cart-preview="true"`,** which is set on the copied theme only.

## Before the copied theme is published

1. Upload the latest `caddie.js` and `caddie.css` (Talha has the builds).
2. Remove `data-smart-cart-debug` from the Caddie tag. Keep `data-smart-cart-preview="true"`.
3. Make the four trouser card changes above.
4. Don't rename any key or change a value. If a SupaEasy discount ever changes its key, the Caddie's rules (`apps/server/src/smartCart/config.ts`) and `smart-cart-deal-key.liquid` must change with it.

## Coming next

Druids want deal changes to need no developer. The plan:
- read prices, keys, titles and markets straight from SupaEasy;
- move the "which products qualify" rules into one setting in Shopify admin, which both `smart-cart-deal-key.liquid` and the Caddie read.

When that lands, the hard-coded lists in the snippets above will be replaced by that setting. We'll send the new versions.
