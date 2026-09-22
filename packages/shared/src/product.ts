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
  url: string;
  imageUrl: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  price: Money;
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
}

export interface Cart {
  id: string;
  checkoutUrl: string | null;
  lines: CartLine[];
  subtotal: Money;
  totalQuantity: number;
}
