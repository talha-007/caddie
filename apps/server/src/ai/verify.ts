import type { CaddieAttachment, Product } from '@caddie/shared';
import { garmentName } from '../catalog/colourways.js';
import { distinctiveWords } from '../catalog/lookup.js';
import { allProducts, catalogueVersion } from '../catalog/sync.js';

/**
 * What the Caddie says, checked against what it was told - before the
 * customer hears it.
 *
 * The prompt says never to state a price or a product a tool did not give,
 * and the model mostly does not. "Mostly" is where the trust goes: "six
 * polos" for a pack with one polo, "£159.99 fixed pack price" for pieces that
 * cost £130, a price remembered from three turns ago. None of those needs
 * judgement to catch - a price is in the tool results or it is not - so this
 * is code, with no model call, on every reply.
 */

export interface Violation {
  kind: 'price' | 'product' | 'count';
  claim: string;
}

const PRICE = /£\s?(\d{1,5}(?:[.,]\d{1,2})?)/g;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
/** A count of garments a card could hold: "six polos", "4 jackets". */
const COUNT = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:[a-z-]+\s+){0,2}?(polos|jackets|gilets|midlayers|hoodies|trousers|shorts|joggers|caps|belts|socks)\b/gi;
const KIND_OF: Record<string, RegExp> = {
  polos: /polo/i, jackets: /jacket/i, gilets: /gilet/i, midlayers: /midlayer/i, hoodies: /hoodie/i,
  trousers: /trouser/i, shorts: /short/i, joggers: /jogger/i, caps: /cap\b/i, belts: /belt/i, socks: /sock/i,
};

function amounts(text: string): number[] {
  return [...text.matchAll(PRICE)].map((match) => Number(match[1]!.replace(',', '.')));
}

/** The store's garment names worth checking - "vento polo", not "golf polo". Rebuilt when the catalogue changes. */
let names: string[] = [];
let namesVersion = -1;
function garmentNames(): string[] {
  if (namesVersion === catalogueVersion()) return names;
  const set = new Set<string>();
  for (const product of allProducts()) {
    const name = garmentName(product.title);
    if (name.split(' ').length >= 2 && distinctiveWords(name).length) set.add(name);
  }
  names = [...set].sort((a, b) => b.length - a.length);
  namesVersion = catalogueVersion();
  return names;
}

function cardProducts(attachment?: CaddieAttachment): Product[] {
  if (!attachment) return [];
  if (attachment.kind === 'products') return attachment.products;
  if (attachment.kind === 'pack') return attachment.recommendation.items;
  if (attachment.kind === 'outfit') return attachment.recommendation.pieces.map((piece) => piece.product);
  return [];
}

export function verifyReply(reply: string, evidence: string, attachment?: CaddieAttachment): Violation[] {
  const violations: Violation[] = [];
  const known = amounts(evidence);
  const close = (a: number, b: number) => Math.abs(a - b) < 0.011;

  // Every price: in the evidence, or the difference of two that are (a saving).
  for (const amount of amounts(reply)) {
    if (known.some((value) => close(value, amount))) continue;
    const saving = known.some((a) => known.some((b) => a > b && close(a - b, amount)));
    if (!saving) violations.push({ kind: 'price', claim: `£${amount}` });
  }

  // Every product name: one the tools or the screen mentioned.
  const said = reply.toLowerCase();
  const told = evidence.toLowerCase();
  for (const name of garmentNames()) {
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (pattern.test(said) && !pattern.test(told)) violations.push({ kind: 'product', claim: name });
  }

  // "Six polos" when the card holds one.
  const products = cardProducts(attachment);
  if (products.length) {
    for (const match of reply.matchAll(COUNT)) {
      const n = NUMBER_WORDS[match[1]!.toLowerCase()] ?? Number(match[1]);
      const kind = KIND_OF[match[2]!.toLowerCase()];
      const onCard = kind ? products.filter((product) => kind.test(product.title)).length : products.length;
      if (onCard && n > onCard) violations.push({ kind: 'count', claim: match[0] });
    }
  }
  return violations;
}

/** The reply without the sentences that make an unbacked claim - the last resort. */
export function withoutClaims(reply: string, violations: Violation[]): string {
  // Split at a stop followed by a space - "£159.99" is not two sentences.
  const sentences = reply.split(/(?<=[.!?])\s+/);
  const bad = (sentence: string) => violations.some((violation) => sentence.toLowerCase().includes(violation.claim.toLowerCase()));
  return sentences.filter((sentence) => !bad(sentence)).join(' ').trim();
}
