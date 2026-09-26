import { createContext, useContext, useEffect } from 'react';
import type { BundleDeal, Cart, CardChoice, Journey, PageContext, Product, ProductVariant, ShopperSizes, SizeRecommendation } from '@caddie/shared';
import type { BasketItem } from '../lib/useCaddie.js';
import { sameId } from '../lib/variants.js';

/**
 * What every product card needs from the Caddie, without threading it
 * through each panel: loaded variants, the size hint, and the basket.
 */
export interface Shop {
  page: PageContext;
  details: Record<string, Product>;
  loadProduct: (product: Product) => Promise<Product | null>;
  resolveVariant: (productId: string, selection: Record<string, string>) => Promise<ProductVariant | null>;
  /** Tells the Caddie what the customer picked on a card themselves, so "add it" knows. */
  chooseOnCard: (choice: CardChoice) => void;
  size: SizeRecommendation | null;
  /** Their sizes from the quick start or the chat - the picker's starting point. */
  sizes: ShopperSizes | null;
  busy: boolean;
  addToBasket: (items: BasketItem[]) => Promise<boolean>;
  /** Variants chosen in conversation, by product id - the cards start from these. */
  picked: Record<string, string>;
  /** A bundle deal as one pack, at the pack price. */
  addPack: (bundle: BundleDeal, items: BasketItem[]) => Promise<boolean>;
  send: (text: string) => Promise<void>;
  startJourney: (journey: Journey) => void;
  /** The live basket, not the snapshot inside an old card. */
  cart: Cart | null;
  changeQuantity: (lineId: string, quantity: number) => Promise<void>;
  openBasket: () => void;
  close: () => void;
}

const ShopContext = createContext<Shop | null>(null);

export const ShopProvider = ShopContext.Provider;

export function useShop(): Shop {
  const shop = useContext(ShopContext);
  if (!shop) throw new Error('useShop must be used inside <ShopProvider>');
  return shop;
}

/**
 * The product the customer is looking at on a product page, loaded from
 * Shopify MCP. null until it loads, and always null off a product page.
 */
export function usePageProduct(): Product | null {
  const shop = useShop();
  const { productId, productTitle } = shop.page;
  const loaded = productId ? (Object.values(shop.details).find((p) => sameId(p.id, productId)) ?? null) : null;
  const { loadProduct } = shop;

  useEffect(() => {
    if (!productId || loaded) return;
    // Only the id matters for loading; nothing from this stub is ever shown.
    void loadProduct({
      id: productId,
      title: productTitle ?? '',
      url: '',
      imageUrl: null,
      vendor: null,
      productType: null,
      tags: [],
      price: { amount: 0, currency: 'GBP' },
      options: [],
      variants: [],
      description: null,
    });
  }, [loadProduct, loaded, productId, productTitle]);

  return loaded;
}
