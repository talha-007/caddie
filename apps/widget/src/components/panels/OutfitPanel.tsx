import type { OutfitRecommendation } from '@caddie/shared';
import { formatMoney, plural } from '../../lib/format.js';
import { ProductRow } from '../ProductCard.js';
import { useShop } from '../ShopContext.js';
import { AddAllButton } from './PackPanel.js';
import { useChoices } from './useChoices.js';

const SLOT_LABELS: Record<string, string> = { top: 'Top', bottom: 'Bottoms', layer: 'Layer', accessory: 'Accessory' };

/** Outfit builder: one row per slot, each with its own size, then the whole look. */
export function OutfitPanel({ recommendation, latest }: { recommendation: OutfitRecommendation; latest: boolean }) {
  const shop = useShop();
  const products = recommendation.pieces.map((piece) => piece.product);
  const choices = useChoices(products);

  if (recommendation.pieces.length === 0) {
    return <p className="caddie-card caddie-empty">{recommendation.reason}</p>;
  }

  return (
    <section className="caddie-card caddie-outfit">
      <header className="caddie-card__header">
        <div className="caddie-card__heading">
          <span className="caddie-eyebrow caddie-eyebrow--accent">Your Caddie recommendation</span>
          <span className="caddie-muted">{plural(recommendation.pieces.length, 'item')}</span>
        </div>
        <strong className="caddie-card__total">{formatMoney(recommendation.total)}</strong>
      </header>

      <p className="caddie-card__lead">{recommendation.reason}</p>

      <div className="caddie-rows">
        {recommendation.pieces.map((piece) => (
          <ProductRow
            key={`${piece.slot}-${piece.product.id}`}
            product={piece.product}
            slot={SLOT_LABELS[piece.slot] ?? piece.slot}
            swappable={latest}
            onChoice={choices.onChoice}
          />
        ))}
      </div>

      <div className="caddie-total">
        <span className="caddie-total__label">Total</span>
        <strong className="caddie-total__value">{formatMoney(recommendation.total)}</strong>
      </div>

      <AddAllButton
        ready={choices.ready}
        missing={choices.missing}
        count={products.length}
        label={products.length > 1 ? 'Add the outfit to basket' : undefined}
        onAdd={() => shop.addToBasket(choices.items)}
      />
    </section>
  );
}
