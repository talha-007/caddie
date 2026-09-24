import type { Cart, Product } from './product.js';
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
 * Where the customer is on the storefront when they talk to the Caddie. The
 * theme provides it (see apps/widget/src/lib/context.ts), so the Caddie can
 * answer "what size in this?" without asking which product.
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

export interface ChatRequest {
  sessionId: string;
  text: string;
  /** Where the customer is standing in the shop, if the theme tells us. */
  /** Optional. The server ignores it until the prompt makes use of it. */
  context?: PageContext;
}

export interface ChatResponse {
  sessionId: string;
  message: CaddieMessage;
}

export interface ApiError {
  error: string;
  detail?: string;
}
