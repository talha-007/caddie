import type { SmartCartOfferConfig } from './types.js';

/**
 * The V1 offers, as the live SupaEasy discounts read them
 * (docs/smart-cart/research/supaeasy-and-theme.md): each counts units on
 * lines carrying its trigger property, and nothing else about the product.
 *
 * Static for now. A reader of the live SupaEasy configuration can replace this
 * list without touching the evaluator, which takes the offers as an argument.
 *
 * Trousers and shorts qualify by the copied (sport) theme's collections -
 * men-golf-trousers and men-golf-shorts, what its deal pages pick from - the
 * theme Smart Cart is previewed on. The live theme's any-2 pages use their
 * own narrower step collections (Phase 2).
 *
 * Not here, on purpose: `__three-polo-deal` (stamped by a live page, read by
 * no active discount); ladies polos (two active ladies polo discounts at
 * different prices, £59.99 and £55 - waiting on which is meant); and every
 * fixed pack - Ambassador, Prestige, Players, Rainsuit, Layering duos,
 * condition packs. SupaEasy counts only units carrying a pack's key, not
 * its recipe, so a pack key on single adds would give six polos the
 * Ambassador price. Packs are sold through the pack builder only.
 */
export const SMART_CART_OFFERS: readonly SmartCartOfferConfig[] = [
  {
    id: 'any-3-polos',
    name: 'Any 3 Polos',
    triggerKey: '__3_Polo_Bundle',
    triggerValue: '3_Polo_Bundle',
    threshold: 3,
    qualifies: { tag: 'bundle_threepolo' },
    gatePrice: { amount: 59.99, currency: 'GBP' },
    display: { deal: '3 for £59.99', units: 'polos', one: 'polo', many: 'polos', title: 'Any 3 Polos' },
  },
  {
    id: 'any-2-mens-trousers',
    name: "Any 2 Men's Trousers",
    triggerKey: '__any-2-trousers',
    triggerValue: 'any-2-trousers',
    threshold: 2,
    qualifies: { collections: ['men-golf-trousers'] },
    gatePrice: { amount: 49, currency: 'GBP' },
    display: { deal: '2 for £49', units: 'trousers', one: 'pair of trousers', many: 'pairs of trousers', title: 'Any 2 Trousers' },
  },
  {
    id: 'any-2-shorts',
    name: 'Any 2 Shorts',
    triggerKey: '__any-2-trouser-shorts',
    triggerValue: 'any-2-trouser-shorts',
    threshold: 2,
    qualifies: { collections: ['men-golf-shorts'] },
    gatePrice: { amount: 45, currency: 'GBP' },
    display: { deal: '2 for £45', units: 'shorts', one: 'pair of shorts', many: 'pairs of shorts', title: 'Any 2 Shorts' },
  },
  /*
   * Ladies and kids "any N" deals: each its own SupaEasy discount, read the
   * same way. Keys and values as the copied theme's deal pages write them;
   * women's and juniors' trousers take their own keys, not the men's that two
   * of those cards also carry (the same £49 in the UK either way).
   */
  {
    id: 'any-3-polos-kids',
    name: 'Any 3 Polos (Kids)',
    triggerKey: '__bundle_threepolo_kids',
    triggerValue: 'bundle_threepolo_kids',
    threshold: 3,
    qualifies: { tag: 'bundle_threepolo_kids' },
    gatePrice: { amount: 49, currency: 'GBP' },
    display: { deal: '3 for £49', units: 'kids polos', one: 'kids polo', many: 'kids polos', title: 'Any 3 Kids Polos' },
  },
  {
    id: 'any-2-trousers-ladies',
    name: 'Any 2 Trousers (Ladies)',
    triggerKey: '__ladies-any-2-trousers',
    triggerValue: 'ladies-any-2-trousers',
    threshold: 2,
    qualifies: { collections: ['ladies-trousers'] },
    gatePrice: { amount: 49, currency: 'GBP' },
    display: { deal: '2 for £49', units: 'ladies trousers', one: 'pair of ladies trousers', many: 'pairs of ladies trousers', title: 'Any 2 Ladies Trousers' },
  },
  {
    id: 'any-2-trousers-kids',
    name: 'Any 2 Trousers (Kids)',
    triggerKey: '__kids-any-2-trousers',
    triggerValue: 'kids-any-2-trousers',
    threshold: 2,
    qualifies: { collections: ['kids-trousers'] },
    gatePrice: { amount: 49, currency: 'GBP' },
    display: { deal: '2 for £49', units: 'kids trousers', one: 'pair of kids trousers', many: 'pairs of kids trousers', title: 'Any 2 Kids Trousers' },
  },
  {
    id: 'any-2-shorts-ladies',
    name: 'Any 2 Shorts (Ladies)',
    triggerKey: '__any-2-shorts',
    triggerValue: 'ladies',
    matchValue: 'ladies',
    threshold: 2,
    qualifies: { collections: ['ladies-shorts'] },
    gatePrice: { amount: 45, currency: 'GBP' },
    display: { deal: '2 for £45', units: 'ladies shorts', one: 'pair of ladies shorts', many: 'pairs of ladies shorts', title: 'Any 2 Ladies Shorts' },
  },
  {
    id: 'any-2-shorts-kids',
    name: 'Any 2 Shorts (Kids)',
    triggerKey: '__any-2-shorts',
    triggerValue: 'kids',
    matchValue: 'kids',
    threshold: 2,
    qualifies: { collections: ['kids-shorts'] },
    gatePrice: { amount: 45, currency: 'GBP' },
    display: { deal: '2 for £45', units: 'kids shorts', one: 'pair of kids shorts', many: 'pairs of kids shorts', title: 'Any 2 Kids Shorts' },
  },
];
