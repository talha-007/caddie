import { useEffect } from 'react';
import type { SizeRecommendation } from '@caddie/shared';
import { announceSize } from '../../lib/events.js';
import { productOptions } from '../../lib/variants.js';
import { CheckIcon, RulerIcon } from '../icons.js';
import { ProductRow } from '../ProductCard.js';
import { usePageProduct, useShop } from '../ShopContext.js';

/**
 * Find My Size result. On a product page it also shows that product's size
 * run with the recommendation marked, and lets them add it in that size.
 */
export function SizePanel({ recommendation, latest }: { recommendation: SizeRecommendation; latest: boolean }) {
  const shop = useShop();
  const pageProduct = usePageProduct();

  // Tell the theme once, so it can preselect the size on its own product form.
  useEffect(() => {
    if (latest) announceSize(recommendation, pageProduct);
  }, [latest, pageProduct, recommendation]);

  if (!recommendation.size) {
    return (
      <section className="caddie-card caddie-size caddie-size--pending">
        <div className="caddie-size__head">
          <span className="caddie-orb caddie-orb--soft" aria-hidden="true">
            <RulerIcon />
          </span>
          <p className="caddie-card__lead">{recommendation.reason}</p>
        </div>
        {recommendation.missing.length > 0 ? (
          <p className="caddie-muted">Still need: {recommendation.missing.join(', ')}.</p>
        ) : null}
        {latest ? (
          <button type="button" className="caddie-btn caddie-btn--block" onClick={() => shop.startJourney('size')}>
            Answer a few quick questions
          </button>
        ) : null}
      </section>
    );
  }

  const confident = recommendation.confidence >= 0.5;
  const sizeRun = pageProduct ? productOptions(pageProduct).find((option) => option.kind === 'size') : undefined;
  const recommended = recommendation.size.toLowerCase();
  // The server sometimes echoes the same size back as the alternative; that reads oddly.
  const alternative =
    recommendation.alternativeSize && recommendation.alternativeSize.toLowerCase() !== recommended
      ? recommendation.alternativeSize
      : null;

  return (
    <section className="caddie-card caddie-size">
      <div className="caddie-size__head">
        <span className="caddie-orb" aria-hidden="true">
          <CheckIcon />
        </span>
        <div>
          <span className="caddie-eyebrow caddie-eyebrow--accent">Recommended for you</span>
          <p className="caddie-size__value">Size {recommendation.size}</p>
        </div>
      </div>
      <p className="caddie-card__lead">{recommendation.reason}</p>

      <div className="caddie-size__meta">
        <span className={`caddie-chip${confident ? ' caddie-chip--success' : ' caddie-chip--soft'}`}>
          {confident ? 'Confident fit' : 'Best guess'}
        </span>
        {alternative ? (
          <span className="caddie-muted">Between sizes? {alternative} also works.</span>
        ) : null}
      </div>

      {sizeRun ? (
        <ul className="caddie-size-run" aria-label={`${sizeRun.name} options`}>
          {sizeRun.values.map((value) => {
            const mine = value.toLowerCase() === recommended;
            return (
              <li key={value} className={`caddie-size-run__item${mine ? ' is-mine' : ''}`}>
                {mine ? <span className="caddie-size-run__tag">Your size</span> : null}
                {value}
              </li>
            );
          })}
        </ul>
      ) : null}

      {pageProduct && latest ? (
        <div className="caddie-size__product">
          <span className="caddie-eyebrow">The one you're looking at</span>
          <ProductRow product={pageProduct} />
        </div>
      ) : null}
    </section>
  );
}
