import { useCallback, useState } from 'react';
import type { Product, ProductVariant } from '@caddie/shared';
import type { BasketItem } from '../../lib/useCaddie.js';

/**
 * Collects the variant chosen on each card of a pack or outfit, so "Add all"
 * only lights up once every piece has a real size and colour (RULE 4).
 */
export function useChoices(products: Product[]) {
  const [chosen, setChosen] = useState<Record<string, ProductVariant | null>>({});

  const onChoice = useCallback((productId: string, variant: ProductVariant | null) => {
    setChosen((prev) => (prev[productId]?.id === variant?.id ? prev : { ...prev, [productId]: variant }));
  }, []);

  const items: BasketItem[] = [];
  let missing = 0;
  for (const product of products) {
    const variant = chosen[product.id];
    if (variant) {
      items.push({ productId: product.id, options: variant.options, title: product.title, variantId: variant.id, price: variant.price.amount });
    }
    else missing += 1;
  }

  return { onChoice, items, missing, ready: products.length > 0 && missing === 0 };
}
