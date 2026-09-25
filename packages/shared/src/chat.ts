import type { Cart, Product } from './product.js';
import type { BundleDeal, OutfitRecommendation, PackRecommendation, SizeRecommendation } from './recommendation.js';

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
  /** Basket changes for the widget to carry out in the store's own cart. See CartAction. */
  actions?: CartAction[];
  /**
   * Who they are shopping for and their sizes, as the server now knows them -
   * so every size picker opens on their size, however they told us (the quick
   * start, "I'm usually an L" in chat, or a size recommendation).
   */
  shopper?: ShopperSizes;
}

/**
 * The range and sizes a customer has given. `size` is the lettered or ladies'
 * size for tops (L, 12, 8/10); `waist` is the number trousers and shorts use.
 * The two are separate scales - see sizeWords.ts on the server.
 */
export interface ShopperSizes {
  range?: 'men' | 'women' | 'kids';
  size?: string;
  waist?: string;
}

/** POST /api/session/:id/profile - the quick start's answers. */
export type ProfileRequest = ShopperSizes;

/**
 * A change to the store's own cart, carried out by the widget.
 *
 * On a Shopify storefront the basket customers trust - and the one the bundle
 * discounts are applied to - is the theme's cart, which lives in their
 * browser. The server cannot touch it; it decides what goes in and hands the
 * widget the change. Numeric Shopify ids, as the theme's cart endpoints take.
 */
export type CartAction =
  | {
      type: 'add';
      lines: Array<{ variantId: string; quantity: number }>;
      /** Cart line keys to remove once the add has succeeded - a swap. */
      removeKeys?: string[];
    }
  | { type: 'change'; lineKey: string; quantity: number }
  | {
      type: 'add-bundle';
      bundle: BundleDeal;
      /**
       * Packs already in the cart that this one replaces, by bundle id - a change
       * to a pack. Removed only after the new one is in, and by id rather than
       * line key, because adding to the cart re-keys the lines already there.
       */
      replaceBundles?: string[];
      /** The id to give this pack's lines, chosen by the server so it can replace it later. */
      bundleId?: string;
      /** The chosen variant for each step, in step order. */
      pieces: Array<{ variantId: string; productId: string; price: number; compareAtPrice: number | null; handle?: string }>;
    };

/**
 * The store cart as the widget last read it, sent back so the model can see
 * what is in it. Line keys are what /cart/change.js takes.
 */
export interface BasketSync {
  lines: Array<{
    key: string;
    productId: string;
    variantId: string;
    title: string;
    variantTitle: string;
    quantity: number;
    /** Set on lines that belong to a bundle deal: that pack's bundle id. */
    bundle?: string;
    /** Which deal, by page handle, e.g. "golf-ambassador-pack". */
    bundleName?: string;
  }>;
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

/**
 * POST /api/session/:id/restart - a fresh conversation on the same basket.
 *
 * Behind the widget's "New chat". The conversation otherwise carries across
 * page loads; this clears what was said and keeps what they are buying and
 * what fits them.
 */
export interface SessionRestartResponse {
  sessionId: string;
  /** The basket carried over, or null if there is none (or it has expired). */
  cart: Cart | null;
}

export interface ApiError {
  error: string;
  detail?: string;
}
