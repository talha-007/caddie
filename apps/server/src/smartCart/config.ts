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
 * no active discount), and every ladies and kids offer (two active ladies
 * polo discounts at different prices - no canonical one yet).
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
    display: { deal: '3 for £59.99', units: 'polos', one: 'polo', many: 'polos', title: 'Polo deal' },
  },
  {
    id: 'any-2-mens-trousers',
    name: "Any 2 Men's Trousers",
    triggerKey: '__any-2-trousers',
    triggerValue: 'any-2-trousers',
    threshold: 2,
    qualifies: { collections: ['men-golf-trousers'] },
    gatePrice: { amount: 49, currency: 'GBP' },
    display: { deal: '2 for £49', units: 'trousers', one: 'pair of trousers', many: 'pairs of trousers', title: 'Trouser deal' },
  },
  {
    id: 'any-2-shorts',
    name: 'Any 2 Shorts',
    triggerKey: '__any-2-trouser-shorts',
    triggerValue: 'any-2-trouser-shorts',
    threshold: 2,
    qualifies: { collections: ['men-golf-shorts'] },
    gatePrice: { amount: 45, currency: 'GBP' },
    display: { deal: '2 for £45', units: 'shorts', one: 'pair of shorts', many: 'pairs of shorts', title: 'Shorts deal' },
  },
];
