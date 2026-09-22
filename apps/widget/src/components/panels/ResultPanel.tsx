import type { CaddieAttachment } from '@caddie/shared';
import { ProductGrid } from '../ProductCard.js';
import { useShop } from '../ShopContext.js';
import { BasketPanel } from './BasketPanel.js';
import { OutfitPanel } from './OutfitPanel.js';
import { PackPanel } from './PackPanel.js';
import { SizePanel } from './SizePanel.js';

/**
 * One panel per attachment kind. The Caddie's words come from the model; every
 * number and product name on screen comes from these payloads, never from the
 * message text.
 *
 * `latest` is true for the newest card only - older cards stay readable but
 * stop offering "swap" and similar actions that refer to "the current one".
 */
export function ResultPanel({ attachment, latest }: { attachment: CaddieAttachment; latest: boolean }) {
  const shop = useShop();

  switch (attachment.kind) {
    case 'products':
      return <ProductGrid products={attachment.products} addable />;
    case 'size':
      return <SizePanel recommendation={attachment.recommendation} latest={latest} />;
    case 'pack':
      return <PackPanel recommendation={attachment.recommendation} latest={latest} />;
    case 'outfit':
      return <OutfitPanel recommendation={attachment.recommendation} latest={latest} />;
    case 'cart':
      // An old basket snapshot would be wrong by now; the newest one shows the live cart.
      return latest ? <BasketPanel cart={shop.cart ?? attachment.cart} /> : <BasketPanel cart={attachment.cart} />;
    default:
      return null;
  }
}
