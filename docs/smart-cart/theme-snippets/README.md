# Smart Cart theme files (copied theme only)

These files go on the copied theme, "Copy of  DRUIDS - SPORT TYPE - AsimAli" (`159899418724`). **Never the live theme.**

Each file here is a **complete** file, built from the theme's own copy on 1 Oct 2026. Only the Smart Cart lines differ from that copy.

In Shopify admin: Online Store → Themes → the copied theme → ⋯ → **Edit code**. Then:

| # | Theme file | What to do | From this folder |
| --- | --- | --- | --- |
| 1 | `snippets/smart-cart-deal-key.liquid` | **Add a new snippet** called `smart-cart-deal-key`, then paste | `smart-cart-deal-key.liquid` |
| 2 | `snippets/sport-cart-progress.liquid` | Select all, delete, paste | `sport-cart-progress.liquid` |
| 3 | `snippets/cart-products.liquid` | Select all, delete, paste | `cart-products.liquid` |
| 4 | `blocks/buy-buttons.liquid` | Select all, delete, paste | `buy-buttons.liquid` |
| 5 | `snippets/quick-add.liquid` | Select all, delete, paste | `quick-add.liquid` |
| 6 | `snippets/sport-collection-card3.liquid` | Select all, delete, paste (or add the two render lines after `data-bundle-key`) | `sport-collection-card3.liquid` |
| 7 | `snippets/sport-collection-card3-assets.liquid` | Select all, delete, paste | `sport-collection-card3-assets.liquid` |


Save each file. Do step 1 first, because steps 4 to 7 use it.

Steps 6 and 7 cover the collection-page cards. The collection grid renders `sport-collection-card3`; its card carries the key as `data-deal-key` / `data-deal-value`, and `bundleProps()` sends them on both the card's Add and its size sheet. `sport-collection-card2` and the grid's own add-to-cart script only act on `[data-spc2]` cards, which no page renders any more, so they are left alone.

All seven were applied to the copied theme on 30 Sep 2026 and checked there.

What each one does:
1. Picks the SupaEasy deal key for a product, following the Caddie's rules.
2. Shows the deal box at the top of the bag: progress, then "Deal applied · you save £x", read from Shopify.
3. Adds the quiet line under each product ("Part of the polo deal" / "✓ Polo deal applied"), and stops the deal name appearing twice.
4. Makes the product page **Add** button write the deal key.
5. Makes the **quick add** on product cards write the deal key.

**If Asim changes any of these files in the theme first,** don't paste over his change: rebuild these files from his new version (ask Talha).

**Check it worked:** add Comfort Shorts on the preview. `/cart.js?preview_theme_id=159899418724` should show `"__any-2-trouser-shorts": "any-2-trouser-shorts"` on the line, and the bag should say "Shorts deal 2 for £45 · 1/2 · Add 1 more pair of shorts to complete the deal".
