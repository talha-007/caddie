import type { Product } from '@caddie/shared';

/**
 * A product priced at nothing in every variant is a placeholder, not
 * something for sale. The live store holds "MENS", "LADIES", "AW26" and
 * "LOOK 1" at £0.00, and "the polo looks good, add it" once matched LOOK 1
 * and put it in a basket (journey test, 29 Sep). Kept here, with no other
 * imports, so the identity index, the name lookup and the brand filter can
 * all apply the same rule without a cycle.
 */
export function isPlaceholder(product: Product): boolean {
  const priced = (amount: number | undefined) => typeof amount === 'number' && amount > 0;
  return product.variants.length > 0 && product.variants.every((variant) => !priced(variant.price?.amount)) && !priced(product.price?.amount);
}
