import type { Cart, Product } from './product.js';
import type { SizeInput } from './recommendation.js';
import type { OutfitRecommendation, PackRecommendation, SizeRecommendation } from './recommendation.js';

export type Role = 'user' | 'assistant';

/**
 * A single turn in the Caddie conversation. `text` is what gets spoken or
 * printed; `attachment` is the structured payload the UI renders as cards.
 */
export interface CaddieMessage {
  id: string;
  role: Role;
  text: string;
  createdAt: string;
  attachment?: CaddieAttachment;
}

export type CaddieAttachment =
  | { kind: 'products'; products: Product[] }
  | { kind: 'size'; recommendation: SizeRecommendation }
  | { kind: 'pack'; recommendation: PackRecommendation }
  | { kind: 'outfit'; recommendation: OutfitRecommendation }
  | { kind: 'cart'; cart: Cart };

/**
 * What the storefront page the widget sits on knows about itself.
 *
 * The theme passes it as data attributes, so it arrives by way of the browser.
 * Treat it as a pointer, never a fact: the ids say which product to look up,
 * and the Caddie still fetches it from Shopify before describing or pricing it.
 */
export interface PageContext {
  pageType: 'product' | 'collection' | 'cart' | 'other';
  /** Shopify product GID, the same id MCP uses, e.g. gid://shopify/Product/123. */
  productId?: string;
  productHandle?: string;
  productTitle?: string;
  /** The variant currently selected on the product page, as a GID. */
  variantId?: string;
}

/**
 * Everything the Caddie remembers about one conversation.
 *
 * The client holds this and sends it back on every request, which is what
 * lets the backend stay stateless: a message can land on any server behind
 * the load balancer and that server knows the customer without having seen
 * them before. Treat it as opaque - read `message` and `attachment` for
 * anything you render, and pass this straight back untouched.
 *
 * It arrives through the browser, so the server trusts it exactly as far as
 * it trusts any other input: sizes and preferences shape a recommendation but
 * are never stated back as fact, ids are looked up in Shopify rather than
 * believed, and the basket is whatever Shopify says it is.
 */
export interface CaddieState {
  /** Everything we have learned about fit. */
  sizeProfile: SizeInput;
  preferences: {
    colour?: string;
    budgetAmount?: number;
    currency?: string;
    audience?: 'men' | 'women';
  };
  /** The last thing we showed, so "that one" and "cheaper" resolve. */
  lastShown?: {
    kind: 'products' | 'pack' | 'outfit';
    items: Array<{ id: string; title: string }>;
    query?: string;
    budgetAmount?: number;
    colour?: string;
  };
  /** Shopify cart id, once the customer adds anything. */
  cartId?: string;
  /** The storefront page they are on, so a spoken "this" still resolves. */
  page?: PageContext;
  /**
   * What was said. Words only - the server strips attachments before handing
   * this back, because a payload is rendered once and never read again, and
   * carrying it would make every request an order of magnitude larger.
   */
  messages: CaddieMessage[];
}

export interface ChatRequest {
  sessionId: string;
  text: string;
  /** Where the customer is standing in the shop, if the theme tells us. */
  context?: PageContext;
  /**
   * The state from the previous reply. Omit it on the first message of a
   * conversation; send it back unchanged on every one after that.
   */
  state?: CaddieState;
}

export interface ChatResponse {
  sessionId: string;
  /** Store this and send it back as `state` on the next message. */
  state: CaddieState;
  message: CaddieMessage;
}

export interface ApiError {
  error: string;
  detail?: string;
}
