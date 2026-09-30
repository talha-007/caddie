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
/**
 * What the store cart must show once an operation has been carried out, in
 * the widget's read-back: the change, not the state. A variant that was
 * already in the basket proves nothing about whether this add went in; its
 * quantity rising by the amount asked for does.
 */
export interface CartExpectation {
  /**
   * Lines whose quantity must rise by this much (numeric variant ids), on the
   * line carrying exactly these properties - none, unless the add stamped a
   * Smart Cart offer trigger.
   */
  add?: Array<{ variantId: string; quantity: number; properties?: Record<string, string> }>;
  /** Lines that must be gone, or reduced by this much - the old size of a replacement. Keyed as held; re-resolved by variant when the cart re-keys. */
  remove?: Array<{ key: string; variantId: string; quantity: number }>;
}

/**
 * A change the server has validated and handed to the widget to make - carried
 * on every CartAction of that change. The widget reports what the cart then
 * showed under this id (CartOutcomeReport), and only then does the server
 * count the change as made. A model's reply is not a receipt; nor is the
 * action itself.
 */
export interface CartOperationRef {
  /** Stable, chosen by the server; one per validated change. */
  operationId: string;
  expect: CartExpectation;
}

export type CartAction =
  | ({
      type: 'add';
      /**
       * `properties`: line item properties to add with the line - only ever a
       * Smart Cart offer trigger the server chose (e.g. __3_Polo_Bundle), so
       * SupaEasy prices the line as part of that offer. Never a price.
       */
      lines: Array<{ variantId: string; quantity: number; properties?: Record<string, string> }>;
      /** Cart line keys to remove once the add has succeeded - a swap. */
      removeKeys?: string[];
    } & Partial<CartOperationRef>)
  | ({ type: 'change'; lineKey: string; quantity: number } & Partial<CartOperationRef>)
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
/**
 * The contract between widget and server for basket changes: a widget that
 * sends this in x-caddie-widget can carry an operation out and report on it;
 * a server that returns it from the claim will only count a change as made
 * on that report. Either side without it does not start such a change.
 */
export const CART_OPS_CONTRACT = 'cart-ops/1';

export interface BasketSync {
  /** The theme cart's own token, so an operation is judged against the cart it was made for and no other. */
  cartToken?: string;
  /** The cart's currency (ISO code), as /cart.js reports it - which market's prices the lines are in. */
  currency?: string;
  lines: Array<{
    key: string;
    productId: string;
    variantId: string;
    title: string;
    variantTitle: string;
    quantity: number;
    /** The line's properties, as the theme's cart holds them - what tells two lines of one variant apart. */
    properties?: Record<string, string>;
    /** The selling plan the line was added under, when the store sells that way - part of what makes a line distinct. */
    sellingPlanId?: string;
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

/**
 * POST /api/session/:id/choice - the customer picked an option on a product
 * card themselves.
 *
 * Only what they actually picked is sent, never the card's starting values:
 * a size the card opened on is our guess, a size they tapped is theirs. The
 * server trusts these for this one product - "add it" then means this
 * product, in this size - and never makes them their size for anything else.
 */
export interface CardChoice {
  productId: string;
  /** Only the options the customer picked on this card, by option name: { Size: 'M' }. */
  options: Record<string, string>;
  /** The variant those choices match, when the card already knows it. */
  variantId?: string;
}

export interface ChatRequest {
  sessionId: string;
  text: string;
  /** Where the customer is standing in the shop, if the theme tells us. */
  /** Optional. The server ignores it until the prompt makes use of it. */
  context?: PageContext;
  /**
   * The store cart as the widget read it just before sending, on the
   * storefront. The separate basket sync is fire-and-forget on open, so a
   * message typed straight away could reach the server before its basket
   * did - and "remove all of these" was answered "which item?" over a
   * basket the server had not yet seen. Sent with the message, the server is
   * never blind to what the words are about.
   */
  basket?: BasketSync;
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

/*
 * The widget's own basket changes, made through the server's Action Gateway.
 *
 * The card's Add button, the pack's Add button and the basket's quantity
 * buttons used to write straight to the theme's cart: no check that the
 * variant was real and in stock, no pack price check, no pack replacement.
 * The click is still the customer's authority - the server checks everything
 * else and hands back the CartActions for the widget to make, exactly as it
 * does for an add the Caddie makes in chat.
 */

/** POST /api/session/:id/add - the Add button on a product card (or "Add all"). */
export interface UiAddRequest {
  /** Each with the options on the card's pickers at the moment of the click. */
  items: Array<{ productId: string; options: Record<string, string>; quantity?: number }>;
}

/** POST /api/session/:id/add-pack - the Add button on a pack card. */
export interface UiPackAddRequest {
  /** The deal's handle, as the pack card carries it. */
  handle: string;
  /** Every piece on the card, in step order, with its pickers' options. */
  pieces: Array<{ productId: string; options: Record<string, string> }>;
}

/** POST /api/session/:id/cart-line - a quantity button, or remove, in the basket. */
export interface UiCartLineRequest {
  lineId: string;
  /** 0 removes the line. */
  quantity: number;
}

/**
 * POST /api/session/:id/cart-outcome - what the store cart showed after the
 * widget carried out an operation. The evidence is the theme's own /cart.js
 * read in the shopper's browser - what the shopper's cart page would show -
 * not a signed receipt from Shopify; the server judges the expected change
 * against it and can still call the outcome uncertain.
 */
export interface CartOutcomeReport {
  operationId: string;
  /** What the widget observed: every step accepted; a step refused with nothing changed; the add in but the removal not; or the cart could not be read. */
  status: 'applied' | 'failed' | 'partial' | 'uncertain';
  /** The cart read just before the first request, and after the last (or after a failure). Null when a read failed. */
  before: BasketSync | null;
  after: BasketSync | null;
  /** Shopify's own words for a refused request. */
  error?: string;
  /**
   * How the request failed, when it did: the store answered and refused
   * (rejected - the only failure with an observed outcome); the request
   * never got an answer (network - it may or may not have reached the
   * store); or the widget stopped waiting (timeout - the store may still
   * finish). Only `rejected` can settle an operation as failed.
   */
  failure?: 'rejected' | 'network' | 'timeout';
  evidence: 'ajax-cart-read';
}

export interface CartOutcomeResponse {
  /** The operation as the server now records it. `duplicate` repeats an earlier answer; `unknown` is not this session's operation. */
  status: 'applied' | 'failed' | 'partial' | 'uncertain' | 'duplicate' | 'unknown';
  /** What the Caddie says about it, for the thread. */
  text?: string;
  /** The widget should read the cart again and report once more. */
  recheck?: boolean;
}

/** The answer to all three. */
export interface UiActionResponse {
  ok: boolean;
  /** The changes to make in the store's own cart (on the storefront). */
  actions?: CartAction[];
  /** The basket after the change, where the server holds the cart itself (the dev harness). */
  cart?: Cart;
  /** When nothing changed: what is needed, in words to show the customer. */
  message?: string;
}

/**
 * POST /api/session/:id/claim - the widget's session id, made its own.
 *
 * The id alone is not a permission: the token that comes back is, and goes
 * in the x-caddie-session-token header of every request about the session.
 * Keep it where the id is kept, and never put it in a URL.
 */
export interface SessionClaimResponse {
  sessionId: string;
  sessionToken: string;
  /** The basket-change contract this server speaks (CART_OPS_CONTRACT); absent on an older server. */
  contract?: string;
}
