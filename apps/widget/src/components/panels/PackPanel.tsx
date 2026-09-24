import type { PackRecommendation } from '@caddie/shared';
import { formatMoney, plural, saving, sumMoney } from '../../lib/format.js';
import { BasketIcon, SparkleIcon } from '../icons.js';
import { ProductTile } from '../ProductCard.js';
import { useShop } from '../ShopContext.js';
import { useChoices } from './useChoices.js';

/** Ambassador Pack: the pieces side by side, one total, one "Add all". */
export function PackPanel({ recommendation, latest }: { recommendation: PackRecommendation; latest: boolean }) {
  const shop = useShop();
  const { items, total, overBudget, reason } = recommendation;
  const choices = useChoices(items);

  if (items.length === 0) {
    return <p className="caddie-card caddie-empty">{reason}</p>;
  }

  // Only claim a saving when every piece carries a real RRP from Shopify.
  const rrp = items.every((item) => item.compareAtPrice)
    ? sumMoney(items.map((item) => item.compareAtPrice ?? item.price))
    : null;
  const saved = rrp ? saving(total, rrp) : null;

  return (
    <section className="caddie-card caddie-pack">
      <header className="caddie-card__header">
        <span className="caddie-orb caddie-orb--small" aria-hidden="true">
          <SparkleIcon size={16} />
        </span>
        <div className="caddie-card__heading">
          <span className="caddie-eyebrow caddie-eyebrow--accent">Your Ambassador Pack</span>
          <span className="caddie-muted">{plural(items.length, 'piece')}</span>
        </div>
        {saved ? (
          <span className="caddie-save-badge">
            <small>Save</small>
            {formatMoney(saved)}
          </span>
        ) : null}
      </header>

      <p className="caddie-card__lead">{reason}</p>

      <div className="caddie-grid" role="list">
        {items.map((product) => (
          <div role="listitem" key={product.id}>
            <ProductTile product={product} swappable={latest} onChoice={choices.onChoice} />
          </div>
        ))}
      </div>

      <div className={`caddie-total${overBudget ? ' is-over' : ''}`}>
        <div>
          <span className="caddie-total__label">Pack total</span>
          {rrp && saved ? <s className="caddie-price__rrp">RRP {formatMoney(rrp)}</s> : null}
        </div>
        <div className="caddie-total__value">
          <strong>{formatMoney(total)}</strong>
          {saved ? <span className="caddie-total__saving">You save {formatMoney(saved)}</span> : null}
        </div>
      </div>

      {overBudget ? (
        <p className="caddie-notice caddie-notice--warning" role="status">
          This is a little over your budget. Ask for something cheaper, or swap a piece.
        </p>
      ) : null}

      <AddAllButton ready={choices.ready} missing={choices.missing} count={items.length} onAdd={() => shop.addToBasket(choices.items)} />
    </section>
  );
}

export function AddAllButton({
  ready,
  missing,
  count,
  label,
  onAdd,
}: {
  ready: boolean;
  missing: number;
  count: number;
  label?: string;
  onAdd: () => void;
}) {
  const shop = useShop();
  return (
    <div className="caddie-add-all">
      <button type="button" className="caddie-btn caddie-btn--primary caddie-btn--block" disabled={!ready || shop.busy} onClick={onAdd}>
        <BasketIcon size={18} />
        {label ?? (count === 1 ? 'Add to basket' : 'Add all to basket')}
      </button>
      {!ready ? (
        <p className="caddie-muted caddie-add-all__hint">
          Pick the options on {missing === count ? (count === 1 ? 'this piece' : 'each piece') : plural(missing, 'more piece')} first.
        </p>
      ) : null}
    </div>
  );
}
