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

export interface Product {
  id: string;
  title: string;
  url: string;
  imageUrl: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  price: Money;
  /** Populated by getProductDetails, empty from a plain search. */
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
