import type { Product } from '@caddie/shared';
import { matchesColourText, parseColours } from '../catalog/colour.js';
import { distinctiveWords } from '../catalog/lookup.js';
import { productById } from '../catalog/sync.js';
import type { CaddieSession } from './store.js';

/**
 * Which product the customer means.
 *
 * "The second one", "the navy one", "the jacket", "the Vento", "this" - the
 * words people use for what is in front of them. Left to the model, these
 * were guessed: it copied an id from the wrong card, or asked "which
 * product?" about the only one on screen. Resolved here from what is actually
 * on screen, the page they are on and their basket, in that order of trust.
 * Null when it genuinely cannot tell - then the question is fair.
 */

export interface Resolved {
  product: Product;
  /** How it was worked out, for the facts: "second on screen", "the page they are on". */
  how: string;
}

const ORDINALS: Array<[RegExp, number]> = [
  [/\b(first|1st|number one|no\.? ?1|#1)\b/, 0],
  [/\b(second|2nd|number two|no\.? ?2|#2)\b/, 1],
  [/\b(third|3rd|number three|no\.? ?3|#3)\b/, 2],
  [/\b(fourth|4th|number four|no\.? ?4|#4)\b/, 3],
  [/\b(fifth|5th|number five|no\.? ?5|#5)\b/, 4],
  [/\b(sixth|6th|number six|no\.? ?6|#6)\b/, 5],
];

const KINDS: Array<[RegExp, RegExp]> = [
  [/\b(polo|polos|shirt|tee)\b/, /polo|shirt|tee/i],
  [/\b(jacket|gilet|coat|vest)\b/, /jacket|gilet|vest|coat/i],
  [/\b(midlayer|mid-layer|hoodie|jumper|sweater|quarter zip)\b/, /midlayer|hoodie|sweat|quarter zip|1\/4 zip/i],
  [/\b(trousers?|joggers?|pants|chinos?)\b/, /trouser|jogger|pant|chino/i],
  [/\b(shorts|skort)\b/, /short|skort/i],
  [/\b(belt)\b/, /belt/i],
  [/\b(cap|hat|beanie)\b/, /cap|hat|beanie/i],
  [/\b(socks?)\b/, /sock/i],
];

function screenProducts(session: CaddieSession): Product[] {
  return (session.lastShown?.items ?? [])
    .filter((item) => item.id)
    .map((item) => productById(item.id))
    .filter((product): product is Product => !!product);
}

export function resolveProduct(session: CaddieSession, text: string): Resolved | null {
  const said = text.toLowerCase();
  const screen = screenProducts(session);
  const page = session.page?.pageType === 'product' && session.page.productId ? productById(session.page.productId) : null;

  // "The second one" - a position on screen.
  for (const [pattern, index] of ORDINALS) {
    if (pattern.test(said) && screen[index]) return { product: screen[index]!, how: `number ${index + 1} on screen` };
  }
  if (/\b(last one|the last)\b/.test(said) && screen.length) return { product: screen[screen.length - 1]!, how: 'last on screen' };

  // Narrow what is on screen by what they said: the kind of garment, the colour, a name.
  const kind = KINDS.find(([words]) => words.test(said))?.[1];
  const colours = parseColours(said).colours.map((colour) => colour.word).join(' or ');
  // A word is a name only if something they can see is called it: "Vento", "Elite" - not "stock" or "does".
  const visibleWords = new Set(
    [...screen, ...(page ? [page] : [])].flatMap((product) => product.title.toLowerCase().split(/[^a-z0-9]+/)),
  );
  const names = distinctiveWords(said).filter((word) => word.length > 2 && visibleWords.has(word));
  const narrow = (pool: Product[]) =>
    pool.filter(
      (product) =>
        (!kind || kind.test(product.title)) &&
        (!colours || matchesColourText(product, colours) > 0) &&
        (!names.length || names.some((word) => product.title.toLowerCase().includes(word))),
    );
  if (kind || colours || names.length) {
    const matches = narrow(screen);
    if (matches.length === 1) return { product: matches[0]!, how: 'on screen, from what they described' };
    // Their own name for it, and nothing on screen fits: the page they are on, if it does.
    if (!matches.length && page && narrow([page]).length) return { product: page, how: 'the page they are on' };
  }

  // "It", "that one": what was just talked about, then the page - what they are looking at.
  if (/\b(this|it|that|this one|that one)\b/.test(said)) {
    const focus = session.focusProductId ? productById(session.focusProductId) : null;
    if (focus) return { product: focus, how: 'the one just talked about' };
    if (page) return { product: page, how: 'the page they are on' };
    if (screen.length === 1) return { product: screen[0]!, how: 'the only one on screen' };
  }

  // Nothing said about which, but only one thing to mean.
  if (!kind && !colours && !names.length) {
    if (screen.length === 1) return { product: screen[0]!, how: 'the only one on screen' };
    if (!screen.length && page) return { product: page, how: 'the page they are on' };
  }
  return null;
}
