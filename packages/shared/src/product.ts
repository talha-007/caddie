/**
 * The product shape both the server and the widget agree on.
 *
 * RULE: every field here originates from Shopify MCP. Nothing in this object
 * is ever written by the AI. If a value is missing, it stays missing - we do
 * not guess prices, names or availability.
 */
export interface Money {
  amount: number;
  currency: string;
}

export interface ProductVariant {
  id: string;
  title: string;
  available: boolean;
  price: Money;
  /** e.g. { Size: 'M', Colour: 'Navy' } */
  options: Record<string, string>;
  /**
   * Shopify's inventory item behind this variant. Server-side only: it is how
   * an inventory webhook finds the product whose stock just moved.
   */
  inventoryItemId?: string;
}

/**
 * The choices a customer picks from, e.g. { name: 'Size', values: ['S','M'] }.
 *
 * Options and variants are not the same thing: options are every choice the
 * product offers, variants are the concrete combinations. A product detail
 * lookup returns all the options but only the variant matching what has been
 * chosen so far, so the size picker is built from `options` and the thing you
 * add to the basket comes from `variants`.
 */
export interface ProductOption {
  name: string;
  values: string[];
}

export interface Product {
  id: string;
  title: string;
  /**
   * Shopify's handle, "elite-polo-navy". Optional: the server's catalogue
   * mirror fills it, and it is used to match a product by name. The widget
   * does not need it.
   */
  handle?: string;
  url: string;
  imageUrl: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  price: Money;
  /**
   * The RRP when the product is on sale ("RRP £39.00, save £15.00"). Optional
   * until the server normaliser reads it from MCP - the widget only shows a
   * saving when this is present, it never works one out on its own.
   */
  compareAtPrice?: Money | null;
  /** Every choice on offer. Build the picker from this. */
  options: ProductOption[];
  /**
   * The variants matching what has been chosen. A detail lookup with a chosen
   * size returns exactly one; with nothing chosen it may return a default.
   * Only add to the basket when you have the one the customer actually picked.
   */
  variants: ProductVariant[];
  description: string | null;
}

export interface CartLine {
  lineId: string;
  productId: string;
  variantId: string;
  title: string;
  variantTitle: string;
  imageUrl: string | null;
  quantity: number;
  unitPrice: Money;
  lineTotal: Money;
  /** Set when the line is a piece of a bundle deal: the pack it belongs to, by name. */
  bundle?: string;
}

export interface Cart {
  id: string;
  checkoutUrl: string | null;
  lines: CartLine[];
  subtotal: Money;
  totalQuantity: number;
}
