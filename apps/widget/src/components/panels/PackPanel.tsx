import type { PackRecommendation } from '@caddie/shared';
import { formatMoney, plural, saving, sumMoney } from '../../lib/format.js';
import { BasketIcon, SparkleIcon } from '../icons.js';
import { ProductTile } from '../ProductCard.js';
import { onStorefront } from '../../lib/themeCart.js';
import { useShop } from '../ShopContext.js';
import { useChoices } from './useChoices.js';

/**
 * A pack: the pieces side by side, one total, one "Add all".
 *
 * Two kinds arrive here. One of the store's bundle deals (`bundle` set) - the
 * Ambassador Pack and the rest - with its real name and fixed price, added as
 * one bundle so the store charges the pack price. Or a selection of pieces
 * put together to a budget, which is not a deal and is never called one: it
 * was labelled "Your Ambassador Pack" at the sum of its prices, which Druids
 * does not sell.
 */
export function PackPanel({ recommendation, latest }: { recommendation: PackRecommendation; latest: boolean }) {
  const shop = useShop();
  const { items, total, overBudget, reason, bundle } = recommendation;
  // A deal can only go in whole: every step needs its piece.
  const complete = !bundle || bundle.steps.every((step) => step.productId);
  const choices = useChoices(items);

  if (items.length === 0) {
    return <p className="caddie-card caddie-empty">{reason}</p>;
  }

  // Only claim a saving when every piece carries a real RRP from Shopify.
  // For a deal, the saving is the pieces at their own prices against the pack price.
  const rrp = bundle
    ? sumMoney(items.map((item) => item.price))
    : items.every((item) => item.compareAtPrice)
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
          <span className="caddie-eyebrow caddie-eyebrow--accent">{bundle ? bundle.title : 'Your selection'}</span>
          <span className="caddie-muted">{plural(items.length, 'piece')}</span>
        </div>
      </header>

      <p className="caddie-card__lead">{reason}</p>

      <div className="caddie-grid" role="list">
        {items.map((product) => (
          <div role="listitem" key={product.id}>
            <ProductTile
              product={product}
              {...(bundle ? { slot: bundle.steps.find((step) => step.productId === product.id)?.title ?? '' } : {})}
              swappable={latest}
              onChoice={choices.onChoice}
            />
          </div>
        ))}
      </div>

      {/* No price as if it could be paid, for a pack that cannot be bought yet. */}
      {bundle?.blocked ? null : (
        <div className={`caddie-total${overBudget ? ' is-over' : ''}`}>
          <div>
            <span className="caddie-total__label">{bundle ? 'Pack price' : 'Total'}</span>
            {rrp && saved ? <s className="caddie-price__rrp">RRP {formatMoney(rrp)}</s> : null}
          </div>
          <div className="caddie-total__value">
            <strong>{formatMoney(total)}</strong>
            {saved ? <span className="caddie-total__saving">You save {formatMoney(saved)}</span> : null}
          </div>
        </div>
      )}

      {overBudget ? (
        <p className="caddie-notice caddie-notice--warning" role="status">
          This is a little over your budget. Ask for something cheaper, or swap a piece.
        </p>
      ) : null}

      {bundle?.blocked ? (
        // Cannot be bought yet: a quiet line, not a warning - nothing has gone wrong for them.
        <p className="caddie-notice caddie-notice--hint" role="status">
          {bundle.blocked}
        </p>
      ) : bundle && (!complete || !onStorefront()) ? (
        // Off the storefront, or a step with nothing in stock: the deal page can finish it - if there is one.
        bundle.url ? (
          <a className="caddie-btn caddie-btn--primary caddie-btn--block" href={bundle.url} target="_top">
            Build it on the {bundle.title.toLowerCase()} page
          </a>
        ) : null
      ) : (
        <AddAllButton
          ready={choices.ready}
          missing={choices.missing}
          count={items.length}
          {...(bundle ? { label: `Add the ${bundle.title.toLowerCase()} to basket` } : {})}
          onAdd={() => (bundle ? shop.addPack(bundle, choices.items) : shop.addToBasket(choices.items))}
        />
      )}
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
