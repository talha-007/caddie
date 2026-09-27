import type { Product } from '@caddie/shared';
import { identityProducts, resolveCustomerProductIdentity } from '../catalog/productIdentity.js';
import { productById } from '../catalog/sync.js';
import { resolveProduct } from './screen.js';
import { focusProduct, type ShoppingFocus } from './focus.js';
import type { CaddieSession, PendingAction } from './store.js';

/**
 * What the customer is shopping for right now - one answer, for every tool.
 *
 * Before Phase 3B each tool chose for itself between the focus, the product
 * the model last looked up (focusProductId), the card last touched
 * (cardFocus), the last search (lastSearch), the pack last built
 * (packInFocus) and whatever was on screen. They disagreed: a product the
 * model merely looked up became "it", an old pack answered a bare "34" long
 * after the customer had moved to polos. Three things, kept apart:
 *
 *   focus     what they are talking about and shopping for - moved only by
 *             their words, a card they tap, or a card they point at
 *             (session/focus.ts). The mission, its constraints, the product
 *             in hand, the pack being built.
 *   screen    what is in front of them now (lastShown). Pointed at, it can
 *             become the focus; being visible never does.
 *   history   what came before: packsShown, lastOutfit, recentShown,
 *             lastLead. Used to vary results, find a pack they go back to,
 *             or compare "cheaper" - never as what they want now.
 *
 * The page they are on is trusted, but answers only "this" when nothing
 * stronger is in focus (session/screen.ts), and never moves the focus.
 */

export function currentFocus(session: CaddieSession): ShoppingFocus | undefined {
  return session.activeShoppingContext;
}

/** The mission they are on, counted from one; 0 before they have asked for anything. */
export function currentMission(session: CaddieSession): number {
  return session.activeShoppingContext?.mission ?? (session.activeShoppingContext ? 1 : 0);
}

/** The customer turn the mission began on - sizes said before it were for something else. */
export function missionStart(session: CaddieSession): number {
  const focus = session.activeShoppingContext;
  return focus?.missionTurn ?? focus?.turn ?? 1;
}

/** The product in hand: one they named, tapped or pointed at - never one the model looked up. */
export function currentProduct(session: CaddieSession): Product | null {
  return focusProduct(session.activeShoppingContext);
}

/** The pack they are building, if one is in hand. */
export function currentPack(session: CaddieSession): string | undefined {
  return session.activeShoppingContext?.pack;
}

export interface Screen {
  kind: 'products' | 'pack' | 'outfit';
  products: Product[];
  bundle?: string;
  query?: string;
}

/** What is on their screen now - to point at, never to decide what they want. */
export function currentScreen(session: CaddieSession): Screen | null {
  const shown = session.lastShown;
  if (!shown) return null;
  const products = shown.items.map((item) => (item.id ? productById(item.id) : null)).filter((product): product is Product => !!product);
  return { kind: shown.kind, products, ...(shown.bundle ? { bundle: shown.bundle } : {}), ...(shown.query ? { query: shown.query } : {}) };
}

/**
 * The card they tapped, while it is still what they are talking about: the
 * product in focus is that card, and no newer screen of results has replaced
 * the one it was tapped on. "Is it waterproof?" keeps it; "tell me about the
 * Warrior jacket" or a new search lets it go.
 */
export function tappedSinceLastSaid(session: CaddieSession): string | undefined {
  const id = session.activeShoppingContext?.productId;
  const choice = id ? session.cardChoices?.[id] : undefined;
  if (!id || !choice) return undefined;
  return choice.at > (session.shownAt ?? 0) ? id : undefined;
}

/**
 * A basket add still waiting, if it belongs to this mission. The Action
 * Gateway owns it (tools/actionGateway.ts); a new mission simply means it is
 * no longer theirs to finish - "M" after "show me jackets" is not the size
 * of the polo asked about before.
 */
export function livePending(session: CaddieSession): PendingAction | undefined {
  const pending = session.pendingAction;
  if (!pending) return undefined;
  if (pending.mission !== undefined && pending.mission !== currentMission(session)) return undefined;
  return pending;
}


export type TrustedTarget =
  | { status: 'product'; products: Product[]; how: 'named' | 'pointed' | 'in-hand' | 'page' }
  | { status: 'ambiguous'; designs: string[] }
  | { status: 'none' };

/** "This", "it", "that one": words that point at what they are looking at. */
const DEICTIC = /\b(this|it|that|these|this one|that one)\b/i;

/**
 * The product a read-only question is about, from the customer's evidence
 * only - in this order: a product they name, a card they point at ("the
 * second one"), the product in hand (named, tapped or pointed at before),
 * and the page they are on, for "this" and nothing else. A product the
 * model passes is a proposal checked against this; with nothing here, the
 * answer is to ask which, never to take the model's pick (Phase 3B).
 */
export function trustedProductTarget(session: CaddieSession, said: string): TrustedTarget {
  const identity = resolveCustomerProductIdentity(said);
  if (identity.status === 'exact') return { status: 'product', products: [identity.product], how: 'named' };
  if (identity.status === 'family') return { status: 'product', products: identityProducts(identity), how: 'named' };
  if (identity.status === 'ambiguous') return { status: 'ambiguous', designs: identity.designs.map((design) => design.design) };
  const pointed = session.lastShown?.kind === 'pack' ? null : resolveProduct(session, said);
  if (pointed && /^(number \d|last on screen|on screen, from what they described)/.test(pointed.how)) return { status: 'product', products: [pointed.product], how: 'pointed' };
  const held = currentProduct(session);
  if (held) return { status: 'product', products: [held], how: 'in-hand' };
  const page = session.page?.pageType === 'product' && session.page.productId ? productById(session.page.productId) : null;
  if (page && DEICTIC.test(said)) return { status: 'product', products: [page], how: 'page' };
  return { status: 'none' };
}

/** Whether the model's product is one the trusted target covers - the same design. */
export function agreesWithTarget(target: TrustedTarget, proposed: Product | null): boolean {
  if (!proposed || target.status !== 'product') return false;
  const design = (title: string) => title.split(/\s+-\s+/)[0]!.trim().toUpperCase();
  return target.products.some((product) => product.id === proposed.id || design(product.title) === design(proposed.title));
}
