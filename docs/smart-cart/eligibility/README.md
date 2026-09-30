# Which products are eligible for which deal or pack

Written for: the Caddie team and the Druids web team.

Generated read-only on 1 Oct 2026. It combines four sources:
- the SupaEasy configuration;
- the live theme's pack pages;
- the copied (sport) theme's pack pages;
- the Caddie's "any N" rules.

Collection membership comes from the Admin API, active products only. `products.csv` lists every active product with everything it can go into.

**How eligibility works.** A SupaEasy discount never checks the product; it only checks for its key on the cart line. So "eligible" means **a page, a button or the Caddie will put that key on this product**:
- **"any N" deals:** any product matching the rule;
- **fixed packs:** one product from each step's collection, added together on the pack page.

## Overview

| Deal or pack (SupaEasy) | Kind | UK price | Eligible products | Sold through |
| --- | --- | --- | --- | --- |
| AMBASSADOR PACK MENS | fixed pack | 99.99 | 321 | copied /pages/choose-ambassador-pack-temp (men / warm); live /pages/golf-ambassador-pack; live /pages/golf-ambassador-pack-app; live /pages/golf-ambassador-pack-eur |
| ANY 2 SHORTS | any N | 45 | 39 | Caddie + theme Add buttons (any N) (men); copied /pages/choose-two-short-temp (men); live /pages/any-2-trouser-shorts |
| ANY 2 TROUSERS MENS | any N | 49 | 92 | Caddie + theme Add buttons (any N) (men); copied /pages/choose-two-trousers-temp (juniors); copied /pages/choose-two-trousers-temp (men); copied /pages/choose-two-trousers-temp (women); live /pages/any-2-trousers-app; live /pages/any-2-trousers-eur |
| ANY 3 POLO COLLECTION | any N | 59.99 | 592 | Caddie + theme Add buttons (any N) (men); copied /pages/choose-three-polo-temp (men) |
| ANY 3 POLO KIDS COLLECTION | any N | 49 | 100 | Caddie + theme Add buttons (any N) (juniors); copied /pages/choose-three-polo-temp (juniors) |
| ANY 3 POLO LADIES COLLECTION | any N | 59.99 | 180 | copied /pages/choose-three-polo-temp (women) |
| CADDY CLUB AMBASSADOR PACK | fixed pack | 99.99 | 0 | **nowhere** |
| CADDY CLUB RAINSUIT SPECIAL | fixed pack | 99 | 0 | **nowhere** |
| CADDY CLUB SUMMER BUNDLE | fixed pack | 49 | 60 | live /pages/caddy-club-summer-bundle |
| KIDS AMBASSADOR PACK | fixed pack | 85 | 251 | copied /pages/choose-ambassador-pack-temp (juniors / warm); live /pages/kids-ambassador; live /pages/kids-ambassador-app; live /pages/kids-ambassador-eur |
| KIDS ANY 2 TROUSERS | any N | 49 | 18 | Caddie + theme Add buttons (any N) (juniors); copied /pages/choose-two-trousers-temp (juniors) |
| KIDS LAYERING DUO | fixed pack | 49 | 54 | copied /pages/choose-layering-duo (juniors) |
| KIDS RAIN SUIT | fixed pack | 79 | 60 | copied /pages/choose-anyrainsuit (juniors); live /pages/kids-rainsuit-app |
| LADIES & KIDS ANY 2 SHORTS | any N | 45 | 47 | Caddie + theme Add buttons (any N) (juniors); Caddie + theme Add buttons (any N) (women); copied /pages/choose-two-short-temp (juniors); copied /pages/choose-two-short-temp (women) |
| LADIES AMBASSADOR PACK | fixed pack | 99.99 | 294 | copied /pages/choose-ambassador-pack-temp (women / warm); live /pages/ladies-ambassador-pack |
| LADIES ANY 2 TROUSERS | any N | 49 | 41 | Caddie + theme Add buttons (any N) (women); copied /pages/choose-two-trousers-temp (women) |
| LADIES ANY 3 POLO | any N | 55 | 180 | copied /pages/choose-three-polo-temp (women) |
| LADIES RAIN SUIT PACK | fixed pack | 99 | 49 | copied /pages/choose-anyrainsuit (women) |
| LADIES SUMMER BUNDLE | fixed pack | 49 | 0 | **nowhere** |
| MENS & LADIES LAYRING DUO | fixed pack | 49 | 250 | copied /pages/choose-layering-duo (men); copied /pages/choose-layering-duo (women) |
| MENS AMB PACK MIXED &  COOL WET | fixed pack | 129.99, 159.99 | 237 | copied /pages/choose-ambassador-pack-temp (men / coolwet); copied /pages/choose-ambassador-pack-temp (men / mixed) |
| PLAYERS BUNDLE MENS | fixed pack | 49 | 184 | live /pages/players-bundle; live /pages/players-bundle-app; live /pages/players-bundle-eur |
| PRESTIGE PACK MENS | fixed pack | 69 | 160 | live /pages/prestige-pack; live /pages/prestige-pack-app; live /pages/prestige-pack-eur |
| RAINSUIT SPECIAL MENS | fixed pack | ? | 86 | copied /pages/choose-anyrainsuit (men); live /pages/any-rainsuit; live /pages/any-rainsuit-app; live /pages/any-rainsuit-eur |

## SupaEasy discounts (active)

| Discount | Key | Units | UK price | Title(s) in the cart |
| --- | --- | --- | --- | --- |
| AMBASSADOR PACK MENS | `__golf-ambassador-pack` | 6 | 99.99 | AMBASSADOR PACK |
| ANY 2 SHORTS | `__any-2-trouser-shorts` | 2 | 45 | ANY 2 SHORTS |
| ANY 2 TROUSERS MENS | `__any-2-trousers` | 2 | 49 | ANY 2 TROUSERS |
| ANY 3 POLO COLLECTION | `__3_Polo_Bundle` | 3 | 59.99 | ANY 3 POLO BUNDLE |
| ANY 3 POLO KIDS COLLECTION | `__bundle_threepolo_kids` | 3 | 49 | ANY 3 POLO KIDS BUNDLE |
| ANY 3 POLO LADIES COLLECTION | `__bundle_threepolo_ladies` | 3 | 59.99 | ANY 3 POLO LADIES BUNDLE |
| CADDY CLUB AMBASSADOR PACK | `__caddy-club-ambassador-pack` | 6 | 99.99 | CADDY CLUB AMBASSADOR PACK |
| CADDY CLUB RAINSUIT SPECIAL | `__caddy-club-rainsuit-special` | 3 | 99 | CADDY CLUB RAINSUIT SPECIAL |
| CADDY CLUB SUMMER BUNDLE | `__caddy-club-summer-bundle` | 3 | 49 | CADDY CLUB SUMMER BUNDLE |
| KIDS AMBASSADOR PACK | `__kids-ambassador` | 6 | 85 | KIDS AMBASSADOR PACK |
| KIDS ANY 2 TROUSERS | `__kids-any-2-trousers` | 2 | 49 | KIDS ANY 2 TROUSERS |
| KIDS LAYERING DUO | `__kids-mens-layering-duo` | 2 | 49 | KIDS LAYERING DUO |
| KIDS RAIN SUIT | `__kids-rainsuit` | 3 | 79 | KIDS RAIN SUIT |
| LADIES & KIDS ANY 2 SHORTS | `__any-2-shorts` | 2 | 45 | LADIES ANY 2 SHORTS, KIDS ANY 2 SHORTS |
| LADIES AMBASSADOR PACK | `__ladies-ambassador-pack` | 6 | 99.99 | LADIES AMBASSADOR PACK |
| LADIES ANY 2 TROUSERS | `__ladies-any-2-trousers` | 2 | 49 | LADIES ANY 2 TROUSERS |
| LADIES ANY 3 POLO | `__any-three-ladies-polos` | 3 | 55 | LADIES ANY 3 POLO |
| LADIES RAIN SUIT PACK | `__ladies-rainsuit` | 3 | 99 | LADIES RAIN SUIT PACK |
| LADIES SUMMER BUNDLE | `__players-bundle-ladies` | 3 | 49 |  |
| MENS & LADIES LAYRING DUO | `__layering-duo` | 2 | 49 | MENS LAYERING DUO, LADIES LAYERING DUO |
| MENS AMB PACK MIXED &  COOL WET | `__amb-mens-condition` | 6 | 129.99, 159.99 | MIXED CONDITIONS AMBASSADOR PACK®, COOL AND WET AMBASSADOR PACK® |
| PLAYERS BUNDLE MENS | `__players-bundle` | 3 | 49 |  |
| PRESTIGE PACK MENS | `__prestige-pack` | 3 | 69 | PRESTIGE PACK |
| RAINSUIT SPECIAL MENS | `__any-rainsuit` | 3 | ? | RAINSUIT SPECIAL |

## Where each SupaEasy key is written, and what goes in

Only routes a customer can reach: a **published** live page, a page on the copied theme (previewed, not yet live), or the Caddie and theme Add buttons for the "any N" deals.

### ANY 3 POLO COLLECTION: `__3_Polo_Bundle` = `3_Polo_Bundle`
Caddie + theme Add buttons (any N) · for men

| Step | Collection / rule | Active products |
| --- | --- | --- |
| any qualifying item | `tag:bundle_threepolo` | 590 |

### ANY 3 POLO COLLECTION: `__3_Polo_Bundle` = `3_Polo_Bundle`
copied theme /pages/choose-three-polo-temp · for men · UK £59.99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (polo, pick 3) | `all-polos` | 478 |

### MENS AMB PACK MIXED &  COOL WET: `__amb-mens-condition` = `coolwet`
copied theme /pages/choose-ambassador-pack-temp · for men / coolwet · UK £159.99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (men-jacket, pick 1) | `ambassador-pack-jacket-gilet` | 42 |
| Step 2 (men-midlayer, pick 1) | `midlayer-1` | 46 |
| Step 3 (men-polo, pick 1) | `polo-3` | 44 |
| Step 4 (men-trouser, pick 1) | `trouser-shorts` | 32 |
| Step 5 (men-belt, pick 1) | `belt-cap` | 68 |
| Step 6 (men-socks, pick 1) | `socks-ambassador-pack` | 5 |

### MENS AMB PACK MIXED &  COOL WET: `__amb-mens-condition` = `mixed`
copied theme /pages/choose-ambassador-pack-temp · for men / mixed · UK £129.99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (men-jacket, pick 1) | `ambassador-pack-jacket-gilet` | 42 |
| Step 2 (men-midlayer, pick 1) | `midlayer-1` | 46 |
| Step 3 (men-polo, pick 1) | `polo-3` | 44 |
| Step 4 (men-trouser, pick 1) | `trouser-shorts` | 32 |
| Step 5 (men-belt, pick 1) | `belt-cap` | 68 |
| Step 6 (men-socks, pick 1) | `socks-ambassador-pack` | 5 |

### LADIES & KIDS ANY 2 SHORTS: `__any-2-shorts` = `kids`
Caddie + theme Add buttons (any N) · for juniors

| Step | Collection / rule | Active products |
| --- | --- | --- |
| any qualifying item | `kids-shorts` | 19 |

### LADIES & KIDS ANY 2 SHORTS: `__any-2-shorts` = `ladies`
Caddie + theme Add buttons (any N) · for women

| Step | Collection / rule | Active products |
| --- | --- | --- |
| any qualifying item | `ladies-shorts` | 28 |

### LADIES & KIDS ANY 2 SHORTS: `__any-2-shorts` = `kids`
copied theme /pages/choose-two-short-temp · for juniors · UK £45 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (juniors, pick 2) | `kids-shorts` | 19 |

### LADIES & KIDS ANY 2 SHORTS: `__any-2-shorts` = `ladies`
copied theme /pages/choose-two-short-temp · for women · UK £45 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (women, pick 2) | `ladies-shorts` | 28 |

### ANY 2 SHORTS: `__any-2-trouser-shorts` = `any-2-trouser-shorts`
Caddie + theme Add buttons (any N) · for men

| Step | Collection / rule | Active products |
| --- | --- | --- |
| any qualifying item | `men-golf-shorts` | 39 |

### ANY 2 SHORTS: `__any-2-trouser-shorts` = `any-2-trouser-shorts`
copied theme /pages/choose-two-short-temp · for men · UK £45 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (men, pick 2) | `men-golf-shorts` | 39 |

### ANY 2 SHORTS: `__any-2-trouser-shorts` = `any-2-trouser-shorts`
live page /pages/any-2-trouser-shorts · UK £45 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| PICK ITEM 1 | `any-2-trouser-shorts-1` | 33 |
| PICK ITEM 2 | `any-2-trouser-shorts-2` | 33 |

### ANY 2 TROUSERS MENS: `__any-2-trousers` = `any-2-trousers`
Caddie + theme Add buttons (any N) · for men

| Step | Collection / rule | Active products |
| --- | --- | --- |
| any qualifying item | `men-golf-trousers` | 33 |

### ANY 2 TROUSERS MENS: `__any-2-trousers` = `any-2-trousers`
copied theme /pages/choose-two-trousers-temp · for juniors · UK £85 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (juniors, pick 2) | `kids-trousers` | 18 |

### ANY 2 TROUSERS MENS: `__any-2-trousers` = `any-2-trousers`
copied theme /pages/choose-two-trousers-temp · for men · UK £99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (men, pick 2) | `men-golf-trousers` | 33 |

### ANY 2 TROUSERS MENS: `__any-2-trousers` = `any-2-trousers`
copied theme /pages/choose-two-trousers-temp · for women · UK £99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (women, pick 2) | `ladies-trousers` | 41 |

### ANY 2 TROUSERS MENS: `__any-2-trousers` = `any-2-trousers`
live page /pages/any-2-trousers-app · UK £49 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| PICK ITEM 1 | `any-2-trousers-step-1` | 25 |
| PICK ITEM 2 | `any-2-trousers-step-2` | 25 |

### ANY 2 TROUSERS MENS: `__any-2-trousers` = `any-2-trousers`
live page /pages/any-2-trousers-eur · UK £49 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| PICK ITEM 1 | `any-2-trousers-step-1` | 25 |
| PICK ITEM 2 | `any-2-trousers-step-2` | 25 |

### RAINSUIT SPECIAL MENS: `__any-rainsuit` = `any-rainsuit`
copied theme /pages/choose-anyrainsuit · for men · UK £99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (men, pick 1) | `any-jacket-for-any-rainsuit-bundle` | 39 |
| Step 2 (men-pant, pick 1) | `any-pants-for-any-rainsuit-bundle` | 2 |
| Step 3 (men-hat, pick 1) | `bundle-beanies` | 45 |

### RAINSUIT SPECIAL MENS: `__any-rainsuit` = `any-rainsuit`
live page /pages/any-rainsuit · UK £99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| ANY RAIN JACKET | `any-jacket-for-any-rainsuit-bundle` | 39 |
| ANY RAIN PANTS | `any-pants-for-any-rainsuit-bundle` | 2 |
| FREE HAT | `bundle-beanies` | 45 |

### RAINSUIT SPECIAL MENS: `__any-rainsuit` = `any-rainsuit`
live page /pages/any-rainsuit-app · UK £99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| ANY RAIN JACKET | `any-jacket-for-any-rainsuit-bundle` | 39 |
| ANY RAIN PANTS | `any-pants-for-any-rainsuit-bundle` | 2 |
| FREE HAT | `bundle-beanies` | 45 |

### RAINSUIT SPECIAL MENS: `__any-rainsuit` = `any-rainsuit`
live page /pages/any-rainsuit-eur · UK £99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| ANY RAIN JACKET | `any-jacket-for-any-rainsuit-bundle` | 39 |
| ANY RAIN PANTS | `any-pants-for-any-rainsuit-bundle` | 2 |
| FREE HAT | `bundle-beanies` | 45 |

### LADIES ANY 3 POLO: `__any-three-ladies-polos` = `any-three-ladies-polos`
copied theme /pages/choose-three-polo-temp · for women · UK £55 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (polo, pick 3) | `ladies-polos` | 180 |

### ANY 3 POLO KIDS COLLECTION: `__bundle_threepolo_kids` = `bundle_threepolo_kids`
Caddie + theme Add buttons (any N) · for juniors

| Step | Collection / rule | Active products |
| --- | --- | --- |
| any qualifying item | `tag:bundle_threepolo_kids` | 100 |

### ANY 3 POLO KIDS COLLECTION: `__bundle_threepolo_kids` = `bundle_threepolo_kids`
copied theme /pages/choose-three-polo-temp · for juniors · UK £49 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (polo, pick 3) | `kids-golf-polo-shirts` | 93 |

### ANY 3 POLO LADIES COLLECTION: `__bundle_threepolo_ladies` = `bundle_threepolo_ladies`
copied theme /pages/choose-three-polo-temp · for women · UK £55 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (polo, pick 3) | `ladies-polos` | 180 |

### CADDY CLUB SUMMER BUNDLE: `__caddy-club-summer-bundle` = `caddy-club-summer-bundle`
live page /pages/caddy-club-summer-bundle · UK £49 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| ANY POLO | `caddy-club-summer-bundle-any-polo` | 43 |
| ANY SHORTS | `caddy-club-summer-bundle-any-shorts` | 15 |
| ANY HAT/BELT | `caddy-club-ambassador-pack-trousers-belt-hat` | 2 |

### AMBASSADOR PACK MENS: `__golf-ambassador-pack` = `golf-ambassador-pack`
copied theme /pages/choose-ambassador-pack-temp · for men / warm · UK £99.99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (men-jacket, pick 1) | `ambassador-pack-jacket-gilet` | 42 |
| Step 2 (men-midlayer, pick 1) | `midlayer-1` | 46 |
| Step 3 (men-polo, pick 1) | `polo-3` | 44 |
| Step 4 (men-trouser, pick 1) | `trouser-shorts` | 32 |
| Step 5 (men-belt, pick 1) | `belt-cap` | 68 |
| Step 6 (men-socks, pick 1) | `socks-ambassador-pack` | 5 |

### AMBASSADOR PACK MENS: `__golf-ambassador-pack` = `golf-ambassador-pack`
live page /pages/golf-ambassador-pack · UK £99.99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| JACKET / GILET | `jacket-gilet` | 102 |
| MIDLAYER | `midlayer-1` | 46 |
| POLO | `polo-3` | 44 |
| TROUSER / SHORTS | `trouser-shorts` | 32 |
| BELT / CAP | `belt-cap` | 68 |
| SOCKS | `socks-ambassador-pack` | 5 |

### AMBASSADOR PACK MENS: `__golf-ambassador-pack` = `golf-ambassador-pack`
live page /pages/golf-ambassador-pack-app · UK £99.99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| JACKET / GILET | `ambassador-pack-jacket-gilet` | 42 |
| MIDLAYER | `midlayer-1` | 46 |
| POLO | `polo-3` | 44 |
| TROUSERS / SHORTS | `trouser-shorts` | 32 |
| BELT / HAT | `belt-cap` | 68 |
| SOCKS | `socks-ambassador-pack` | 5 |

### AMBASSADOR PACK MENS: `__golf-ambassador-pack` = `golf-ambassador-pack`
live page /pages/golf-ambassador-pack-eur · UK £99.99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| JACKET / GILET | `ambassador-pack-jacket-gilet` | 42 |
| MIDLAYER | `midlayer-1` | 46 |
| POLO | `polo-3` | 44 |
| TROUSERS / SHORTS | `trouser-shorts` | 32 |
| BELT / HAT | `belt-cap` | 68 |
| SOCKS | `socks-ambassador-pack` | 5 |

### KIDS AMBASSADOR PACK: `__kids-ambassador` = `kids-ambassador`
copied theme /pages/choose-ambassador-pack-temp · for juniors / warm · UK £85 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (juniors-jacket, pick 1) | `kids-jackets` | 39 |
| Step 2 (juniors-midlayer, pick 1) | `kids-midlayers` | 54 |
| Step 3 (juniors-polo, pick 1) | `kids-golf-polo-shirts` | 93 |
| Step 4 (juniors-trouser, pick 1) | `kids-bottoms` | 31 |
| Step 5 (juniors-belt, pick 1) | `kids-belts-and-caps` | 31 |
| Step 6 (juniors-socks, pick 1) | `kids-socks` | 3 |

### KIDS AMBASSADOR PACK: `__kids-ambassador` = `kids-ambassador`
live page /pages/kids-ambassador · UK £85 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| JACKET / GILET | `kids-jackets` | 39 |
| MIDLAYERS | `kids-midlayers` | 54 |
| POLOS | `kids-golf-polo-shirts` | 93 |
| TROUSERS / SHORTS | `kids-bottoms` | 31 |
| BELT / HAT | `kids-belts-and-caps` | 31 |
| SOCKS | `kids-socks` | 3 |

### KIDS AMBASSADOR PACK: `__kids-ambassador` = `kids-ambassador`
live page /pages/kids-ambassador-app · UK £85 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| JACKET / GILET | `kids-jackets` | 39 |
| MIDLAYERS | `kids-midlayers` | 54 |
| POLOS | `kids-golf-polo-shirts` | 93 |
| TROUSERS / JOGGERS | `kids-bottoms` | 31 |
| BELT / HAT | `kids-belts-and-caps` | 31 |
| SOCKS | `kids-socks` | 3 |

### KIDS AMBASSADOR PACK: `__kids-ambassador` = `kids-ambassador`
live page /pages/kids-ambassador-eur · UK £85 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| JACKET / GILET | `kids-jackets` | 39 |
| MIDLAYERS | `kids-midlayers` | 54 |
| POLOS | `kids-golf-polo-shirts` | 93 |
| TROUSERS / SHORTS | `kids-bottoms` | 31 |
| BELT / HAT | `kids-belts-and-caps` | 31 |
| SOCKS | `kids-socks` | 3 |

### NO ACTIVE SUPAEASY DISCOUNT: `__kids-ambassador-coolwet` = `kids-ambassador-coolwet`
copied theme /pages/choose-ambassador-pack-temp · for juniors / coolwet · UK £85 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (juniors-jacket, pick 1) | `kids-jackets` | 39 |
| Step 2 (juniors-midlayer, pick 1) | `kids-midlayers` | 54 |
| Step 3 (juniors-polo, pick 1) | `kids-golf-polo-shirts` | 93 |
| Step 4 (juniors-trouser, pick 1) | `kids-bottoms` | 31 |
| Step 5 (juniors-belt, pick 1) | `kids-belts-and-caps` | 31 |
| Step 6 (juniors-socks, pick 1) | `kids-socks` | 3 |

### NO ACTIVE SUPAEASY DISCOUNT: `__kids-ambassador-mixed` = `kids-ambassador-mixed`
copied theme /pages/choose-ambassador-pack-temp · for juniors / mixed · UK £85 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (juniors-jacket, pick 1) | `kids-jackets` | 39 |
| Step 2 (juniors-midlayer, pick 1) | `kids-midlayers` | 54 |
| Step 3 (juniors-polo, pick 1) | `kids-golf-polo-shirts` | 93 |
| Step 4 (juniors-trouser, pick 1) | `kids-bottoms` | 31 |
| Step 5 (juniors-belt, pick 1) | `kids-belts-and-caps` | 31 |
| Step 6 (juniors-socks, pick 1) | `kids-socks` | 3 |

### KIDS ANY 2 TROUSERS: `__kids-any-2-trousers` = `kids-any-2-trousers`
Caddie + theme Add buttons (any N) · for juniors

| Step | Collection / rule | Active products |
| --- | --- | --- |
| any qualifying item | `kids-trousers` | 18 |

### KIDS ANY 2 TROUSERS: `__kids-any-2-trousers` = `kids-any-2-trousers`
copied theme /pages/choose-two-trousers-temp · for juniors · UK £85 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (juniors, pick 2) | `kids-trousers` | 18 |

### KIDS LAYERING DUO: `__kids-mens-layering-duo` = `kids-mens-layering-duo`
copied theme /pages/choose-layering-duo · for juniors · UK £49 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (juniors, pick 2) | `kids-midlayers` | 54 |

### KIDS RAIN SUIT: `__kids-rainsuit` = `kids-rainsuit`
copied theme /pages/choose-anyrainsuit · for juniors · UK £79 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (juniors-jacket, pick 1) | `kids-rain-jackets` | 13 |
| Step 2 (juniors-trouser, pick 1) | `kids-rain-trousers` | 2 |
| Step 3 (juniors-cap, pick 1) | `kids-rain-suit-free-beanie` | 45 |

### KIDS RAIN SUIT: `__kids-rainsuit` = `kids-rainsuit`
live page /pages/kids-rainsuit-app · UK £79 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| RAIN JACKET | `kids-rain-jackets` | 13 |
| RAIN TROUSERS | `kids-rain-trousers` | 2 |
| FREE HAT | `kids-rain-suit-free-beanie` | 45 |

### LADIES AMBASSADOR PACK: `__ladies-ambassador-pack` = `ladies-ambassador-pack`
copied theme /pages/choose-ambassador-pack-temp · for women / warm · UK £99.99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (women-jacket, pick 1) | `ladies-ambassador-pack-jacket` | 66 |
| Step 2 (women-midlayer, pick 1) | `ladies-ambassador-pack-midlayer` | 50 |
| Step 3 (women-polo, pick 1) | `ladies-ambassador-pack-polo` | 71 |
| Step 4 (women-trouser, pick 1) | `ladies-ambassador-pack-pants` | 48 |
| Step 5 (women-belt, pick 1) | `ladies-ambassador-pack-cap-or-belt` | 52 |
| Step 6 (women-socks, pick 1) | `ladies-ambassador-pack-socks` | 7 |

### LADIES AMBASSADOR PACK: `__ladies-ambassador-pack` = `ladies-ambassador-pack`
live page /pages/ladies-ambassador-pack · UK £99.99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| JACKET / GILET | `ladies-ambassador-pack-jacket` | 66 |
| MIDLAYER | `ladies-ambassador-pack-midlayer` | 50 |
| POLO | `ladies-ambassador-pack-polo` | 71 |
| TROUSERS/SHORTS | `ladies-ambassador-pack-pants` | 48 |
| BELT/HAT | `ladies-ambassador-pack-cap-or-belt` | 52 |
| SOCKS | `ladies-ambassador-pack-socks` | 7 |

### NO ACTIVE SUPAEASY DISCOUNT: `__ladies-ambassador-pack-coolwet` = `ladies-ambassador-pack-coolwet`
copied theme /pages/choose-ambassador-pack-temp · for women / coolwet · UK £99.99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (women-jacket, pick 1) | `ladies-ambassador-pack-jacket` | 66 |
| Step 2 (women-midlayer, pick 1) | `ladies-ambassador-pack-midlayer` | 50 |
| Step 3 (women-polo, pick 1) | `ladies-ambassador-pack-polo` | 71 |
| Step 4 (women-trouser, pick 1) | `ladies-ambassador-pack-pants` | 48 |
| Step 5 (women-belt, pick 1) | `ladies-ambassador-pack-cap-or-belt` | 52 |
| Step 6 (women-socks, pick 1) | `ladies-ambassador-pack-socks` | 7 |

### NO ACTIVE SUPAEASY DISCOUNT: `__ladies-ambassador-pack-mixed` = `ladies-ambassador-pack-mixed`
copied theme /pages/choose-ambassador-pack-temp · for women / mixed · UK £99.99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (women-jacket, pick 1) | `ladies-ambassador-pack-jacket` | 66 |
| Step 2 (women-midlayer, pick 1) | `ladies-ambassador-pack-midlayer` | 50 |
| Step 3 (women-polo, pick 1) | `ladies-ambassador-pack-polo` | 71 |
| Step 4 (women-trouser, pick 1) | `ladies-ambassador-pack-pants` | 48 |
| Step 5 (women-belt, pick 1) | `ladies-ambassador-pack-cap-or-belt` | 52 |
| Step 6 (women-socks, pick 1) | `ladies-ambassador-pack-socks` | 7 |

### LADIES ANY 2 TROUSERS: `__ladies-any-2-trousers` = `ladies-any-2-trousers`
Caddie + theme Add buttons (any N) · for women

| Step | Collection / rule | Active products |
| --- | --- | --- |
| any qualifying item | `ladies-trousers` | 41 |

### LADIES ANY 2 TROUSERS: `__ladies-any-2-trousers` = `ladies-any-2-trousers`
copied theme /pages/choose-two-trousers-temp · for women · UK £99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (women, pick 2) | `ladies-trousers` | 41 |

### LADIES RAIN SUIT PACK: `__ladies-rainsuit` = `ladies-rainsuit`
copied theme /pages/choose-anyrainsuit · for women · UK £99 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (women-jacket, pick 1) | `ladies-any-rain-jacket` | 17 |
| Step 2 (women-trouser, pick 1) | `ladies-any-rain-pants` | 3 |
| Step 3 (women-cap, pick 1) | `ladies-any-rain-beanies` | 29 |

### MENS & LADIES LAYRING DUO: `__layering-duo` = `men`
copied theme /pages/choose-layering-duo · for men · UK £49 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (men, pick 2) | `mens-golf-midlayers` | 193 |

### MENS & LADIES LAYRING DUO: `__layering-duo` = `ladies`
copied theme /pages/choose-layering-duo · for women · UK £49 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| Step 1 (women, pick 2) | `ladies-midlayers` | 57 |

### PLAYERS BUNDLE MENS: `__players-bundle` = `players-bundle`
live page /pages/players-bundle · UK £49 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| ANY POLO | `polo-shorts-cap-belt-bundle-step1-polo` | 92 |
| ANY SHORTS | `polo-shorts-cap-belt-bundle-step2-shorts` | 29 |
| ANY HAT/BELT | `polo-shorts-cap-belt-bundle-step3-cap-belt` | 63 |

### PLAYERS BUNDLE MENS: `__players-bundle` = `players-bundle`
live page /pages/players-bundle-app · UK £49 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| ANY POLO | `polo-shorts-cap-belt-bundle-step1-polo` | 92 |
| ANY SHORTS | `polo-shorts-cap-belt-bundle-step2-shorts` | 29 |
| ANY BELT / CAP | `polo-shorts-cap-belt-bundle-step3-cap-belt` | 63 |

### PLAYERS BUNDLE MENS: `__players-bundle` = `players-bundle`
live page /pages/players-bundle-eur · UK £49 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| ANY POLO | `polo-shorts-cap-belt-bundle-step1-polo` | 92 |
| ANY SHORTS | `polo-shorts-cap-belt-bundle-step2-shorts` | 29 |
| ANY HAT/BELT | `polo-shorts-cap-belt-bundle-step3-cap-belt` | 63 |

### PRESTIGE PACK MENS: `__prestige-pack` = `prestige-pack`
live page /pages/prestige-pack · UK £69 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| ANY HOODIE OR SWEATER | `any-hoodie-or-sweater-for-prestige-pack` | 81 |
| ANY POLO | `any-polo-for-prestige-pack` | 54 |
| ANY GOLF JOGGERS | `any-golf-joggers-for-prestige-pack` | 25 |

### PRESTIGE PACK MENS: `__prestige-pack` = `prestige-pack`
live page /pages/prestige-pack-app · UK £69 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| ANY HOODIE OR SWEATER | `any-hoodie-or-sweater-for-prestige-pack` | 81 |
| ANY POLO | `any-polo-for-prestige-pack` | 54 |
| ANY GOLF JOGGERS | `any-golf-joggers-for-prestige-pack` | 25 |

### PRESTIGE PACK MENS: `__prestige-pack` = `prestige-pack`
live page /pages/prestige-pack-eur · UK £69 on the page

| Step | Collection / rule | Active products |
| --- | --- | --- |
| ANY HOODIE OR SWEATER | `any-hoodie-or-sweater-for-prestige-pack` | 81 |
| ANY POLO | `any-polo-for-prestige-pack` | 54 |
| ANY GOLF JOGGERS | `any-golf-joggers-for-prestige-pack` | 25 |

## Published live pages that SupaEasy does not price

Their keys are read by **no active SupaEasy discount**. They are v4 bundle-builder pages, which also write price properties (`__fixed_price` and others) for an older Shopify Script that reprices at checkout. Scripts cannot be read with our access, so whether these packs are discounted is **not verified**. None of them count towards Smart Cart.

| Page | Key | Steps |
| --- | --- | --- |
| /pages/ambassador-pack-eur | `__ambassador-pack` | JACKET / GILET; MIDLAYER; POLO; TROUSER / SHORTS; BELT / CAP; SOCKS |
| /pages/ambassador-pack-test | `__ambassador-pack-test` | JACKET / GILET; MIDLAYER; POLO; TROUSERS / SHORTS; BELT / HAT; SOCKS |
| /pages/any-2-joggers | `__any-2-joggers` | GOLF JOGGERS; GOLF JOGGERS |
| /pages/any-2-joggers-eur | `__any-2-joggers` | PICK ITEM 1; PICK ITEM 2 |
| /pages/any-2-trousers-test | `__any-2-trousers-test` | PICK ITEM 1; PICK ITEM 2 |
| /pages/any-3-t-shirts | `__any-3-t-shirts` | PICK ITEM 1; PICK ITEM 2; PICK ITEM 3 |
| /pages/any-3-t-shirts-eur | `__any-3-t-shirts` | PICK ITEM 1; PICK ITEM 2; PICK ITEM 3 |
| /pages/any-4-t-shirts | `__any-4-t-shirts` | PICK ITEM 1; PICK ITEM 2; PICK ITEM 3; PICK ITEM 4 |
| /pages/any-4-t-shirts-eur | `__any-4-t-shirts` | PICK ITEM 1; PICK ITEM 2; PICK ITEM 3; PICK ITEM 4 |
| /pages/any-polo-and-headwear | `__any-polo-and-headwear` | ANY POLO; ANY HEADWEAR |
| /pages/any-polo-and-headwear-eur | `__any-polo-and-headwear` | ANY POLO; ANY HEADWEAR |
| /pages/any-trousers-any-shorts | `__any-trousers-any-shorts` | PICK ITEM 1; PICK ITEM 2 |
| /pages/aquashield-rain-suit | `__aquashield-rain-suit` | AQUA SHIELD JACKET; RAIN TROUSERS; FREE CAP |
| /pages/aquashield-rain-suit-eur | `__aquashield-rain-suit` | AQUA SHIELD JACKET; RAIN TROUSERS; FREE CAP |
| /pages/autumn-winter-bundle | `__autumn-winter-bundle` | HOODIE; POLO; JOGGER |
| /pages/autumn-winter-eur-bundle | `__autumn-winter-eur-bundle` | HOODIE; POLO; JOGGER |
| /pages/big-d-deal | `__big-d-deal` | HOODIE; SHIRTS |
| /pages/buckle-up-bundle | `__buckle-up-bundle` | PICK ITEM 1; PICK ITEM 2 |
| /pages/buckle-up-bundle-eur | `__buckle-up-bundle` | PICK ITEM 1; PICK ITEM 2 |
| /pages/buckle-up-deal | `__buckle-up-deal` | TROUSER; BELTS |
| /pages/bundle-builder-v4 | `__bundle-builder-v4` | POLO 1; POLO 2; MIDLAYER; TROUSERS; CAP; CASUAL; Golf |
| /pages/champions-deal | `__champions-deal` | HOODIE; SHIRTS |
| /pages/gilet-long-sleeve-polo | `__gilet-long-sleeve-polo` | GILET; LONG SLEEVE POLO |
| /pages/golf-ambassador-pack-gd | `__golf-ambassador-pack-gd` | MIDLAYER OR VEST; POLO; TROUSER OR SHORTS; BELT; CAP; SOCKS |
| /pages/kids-ambassador-pack-test | `__kids-ambassador-pack-test` | JACKET / GILET; MIDLAYERS; POLOS; TROUSERS / JOGGERS; BELT / HAT; SOCKS |
| /pages/kids-rain-suit-test | `__kids-rain-suit-test` | RAIN JACKET; RAIN TROUSERS; FREE HAT |
| /pages/ladies-any-3-polo-test | `__ladies-any-3-polo-test` | PICK ITEM 1; PICK ITEM 2; PICK ITEM 3 |
| /pages/ladies-prestige-pack | `__ladies-prestige-pack` | SWEATER; ANY POLO; ANY  JOGGERS / PANTS |
| /pages/ladies-summer-bundle-app | `__ladies-summer-bundle` | PICK ITEM 1; PICK ITEM 2; PICK ITEM 3 |
| /pages/level-up-sports-pack | `__level-up-sports-pack` | PICK ITEM 1; PICK ITEM 2; PICK ITEM 3; PICK ITEM 4 |
| /pages/limited-sports-deal | `__limited-sports-deal` | PICK ITEM 1; PICK ITEM 2; PICK ITEM 3 |
| /pages/limited-sports-deal-eur | `__limited-sports-deal` | PICK ITEM 1; PICK ITEM 2; PICK ITEM 3 |
| /pages/mens-any-two-trousers-app | `__mens-any-two-trousers` | PICK ITEM 1; PICK ITEM 2 |
| /pages/new-shorts-polo-bundle | `__new-shorts-polo-bundle` | SHORTS; POLOS |
| /pages/polo-cap | `__polo-cap` | POLO; CAP |
| /pages/polo-cap-eur | `__polo-cap` | POLO; CAPS |
| /pages/prestige-pack-test | `__prestige-pack-test` | ANY HOODIE OR SWEATER; ANY POLO; ANY GOLF JOGGERS |
| /pages/rain-suit-special | `__rain-suit-special` | ANY RAIN JACKET; ANY RAIN PANTS |
| /pages/rain-suit-special-eur | `__rain-suit-special` | ANY RAIN JACKET; ANY RAIN PANTS |
| /pages/sports-shorts-t-shirt | `__sports-shorts-t-shirt` | SPORTS SHORTS; T-SHIRTS |
| /pages/sports-shorts-t-shirt-eur | `__sports-shorts-t-shirt` | SPORTS SHORTS; T-SHIRTS |
| /pages/stormtech-rain-suit | `__stormtech-rain-suit` | STORM TECH JACKETS; RAIN TROUSERS; FREE CAP |
| /pages/stormtech-rain-suit-eur | `__stormtech-rain-suit` | STORM TECH JACKETS; RAIN TROUSERS; FREE CAP |
| /pages/three-polo-deal | `__three-polo-deal` | PICK ITEM 1; PICK ITEM 2; PICK ITEM 3 |
| /pages/three-polo-deal-app | `__three-polo-deal` | PICK ITEM 1; PICK ITEM 2; PICK ITEM 3 |
| /pages/twin-stripe-rainsuit | `__twin-stripe-rainsuit` | TWIN STRIPE JACKETS; INFINITE TROUSERS; FREE CAP |
| /pages/twin-stripe-rainsuit-eur | `__twin-stripe-rainsuit` | TWIN STRIPE JACKETS; INFINITE TROUSERS; FREE CAP |

## Pack page templates that are not published

46 templates in the live theme have a bundle builder but no published page (old, test or seasonal), so they were ignored: `ambassador-pack-2`, `ambassador-pack-uk`, `any-2-shorts-app`, `any-2-trouser-short-test`, `any-2-trousers-2`, `any-2-trousers-shorts-eur`, `any-3-sports-t-shirts`, `any-rainsuit-test`, `any-three-ladies-polos-eu`, `any-trousers-any-short-eu`, `big-d-deal-eur`, `buckle-up-2`, `buckle-up-3`, `caddy-club-amb-pack`, `caddy-club-rainsuit`, `caddy-club-rainsuit-speci`, `gilet-long-sleeve-polo-eu`, `golf-ambassador-pack-ball`, `kids-ambassador-euro`, `kids-any-three-polo-app`, `kids-rainsuit-bundle`, `kids-rainsuit-bundle-eur`, `ladies-ambassador-app`, `ladies-ambassador-pack-eu`, `ladies-ambassador-test`, `ladies-any-three-polo-app`, `ladies-any-three-polo-dea`, `ladies-rain-suit-app`, `ladies-rainsuit-test`, `midlayer-polo`, `midlayer-polo-eur`, `mr-sunshine-pack`, `mr-sunshine-pack-eu`, `multi-buy`, `new-arrivals-jogger-polo`, `new-joggers-polo-eur`, `new-shorts-polo-bundle-2`, `player-bunlde-test`, `polo-shorts-capbelt`, `rainsuit-ladies`, `rainsuit-ladies-eur`, `shorts-2`, `summer-bundle-ladies`, `summer-bundle-ladies-eur`, `three-polo-deal-eur`, `trousers-belt`.

## Problems found

- **CADDY CLUB AMBASSADOR PACK** (`__caddy-club-ambassador-pack`) is active in SupaEasy, but **no page on either theme writes its key**, so it cannot be bought through the website.
- **CADDY CLUB RAINSUIT SPECIAL** (`__caddy-club-rainsuit-special`) is active in SupaEasy, but **no page on either theme writes its key**, so it cannot be bought through the website.
- **LADIES SUMMER BUNDLE** (`__players-bundle-ladies`) is active in SupaEasy, but **no page on either theme writes its key**, so it cannot be bought through the website.
- `__kids-ambassador-coolwet=kids-ambassador-coolwet` is written by copied theme /pages/choose-ambassador-pack-temp (juniors / coolwet), but **no active SupaEasy discount reads it**, and this page has no legacy v4 pricing either, so a pack built here is **not discounted**.
- `__kids-ambassador-mixed=kids-ambassador-mixed` is written by copied theme /pages/choose-ambassador-pack-temp (juniors / mixed), but **no active SupaEasy discount reads it**, and this page has no legacy v4 pricing either, so a pack built here is **not discounted**.
- `__ladies-ambassador-pack-coolwet=ladies-ambassador-pack-coolwet` is written by copied theme /pages/choose-ambassador-pack-temp (women / coolwet), but **no active SupaEasy discount reads it**, and this page has no legacy v4 pricing either, so a pack built here is **not discounted**.
- `__ladies-ambassador-pack-mixed=ladies-ambassador-pack-mixed` is written by copied theme /pages/choose-ambassador-pack-temp (women / mixed), but **no active SupaEasy discount reads it**, and this page has no legacy v4 pricing either, so a pack built here is **not discounted**.

## Summary

- Active products: 2541
- Eligible for at least one deal or pack: 1963
- Eligible for nothing: 578
