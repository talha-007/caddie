# The rules

Short list. If a change breaks one of these, it does not ship.

## 1. Shopify owns product data. We own recommendations.

Products, prices, variants, stock and the cart come from the Shopify catalog
(UCP, at `/api/ucp/mcp`) and nowhere else. Sizes, packs and outfits are decided by our code in
`apps/server/src/recommend/`.

Where the line lives in code: `apps/server/src/shopify/` is the only directory
allowed to fetch product data. If you find a price coming from anywhere else,
that is the bug.

## 2. The AI never invents a product, a price or a stock level.

The model gets a short line to say and nothing else. Every number on screen
comes from the structured attachment, not from the model's sentence. If a tool
returns nothing, the Caddie says so - it does not fill the gap.

This is enforced in three places, and all three have to stay true:

- the system prompt in `apps/server/src/ai/prompt.ts`
- tool results returning `speech` separately from `attachment`
- the widget rendering `attachment`, never parsing message text

## 3. No fake data in a journey once that journey is "done".

Placeholder data is fine while building, but it gets removed the day the
journey is marked complete, and Day 10 is the hard stop for all of it. The one
exception is `data/size-chart.json`, which is placeholder *structure* waiting
for the real Druids numbers - it is marked at the top of the file.

## 4. Variants are checked before anything is added to the basket.

`get_product_details` first, then `add_to_cart` with a real variant id. Never
add a variant the customer has not actually chosen a size and colour for.

## 5. Types change in `packages/shared` first.

It is the contract between the two halves. Change it there, then tell the other
person in standup. Do not add a field to one side and hope.

## 6. Testing starts Day 11, not Day 14.

Both of us run all three journeys end to end. Talha fixes AI and backend, Amir
fixes UI. Bugs get written down, not just mentioned.
