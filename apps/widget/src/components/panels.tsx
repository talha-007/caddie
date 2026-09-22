import type {
  CaddieAttachment,
  Cart,
  OutfitRecommendation,
  PackRecommendation,
  Product,
  SizeRecommendation,
} from '@caddie/shared';
import { formatMoney, ProductCard, ProductCarousel } from './ProductCard.js';

/**
 * One panel per attachment kind. The Caddie's words come from the model; every
 * number and product name on screen comes from these payloads, never from the
 * message text.
 */

/* ---------------- Size ---------------- */

export function SizePanel({ recommendation }: { recommendation: SizeRecommendation }) {
  if (!recommendation.size) {
    return (
      <section className="caddie-panel">
        <p className="caddie-panel__lead">{recommendation.reason}</p>
        {recommendation.missing.length > 0 ? (
          <p className="caddie-muted">Still need: {recommendation.missing.join(', ')}.</p>
        ) : null}
      </section>
    );
  }

  const confident = recommendation.confidence >= 0.5;

  return (
    <section className="caddie-panel caddie-panel--size">
      <span className="caddie-panel__label">Your size</span>
      <p className="caddie-size">{recommendation.size}</p>
      <p className="caddie-panel__lead">{recommendation.reason}</p>
      <div className="caddie-size__meta">
        <span className={`caddie-chip${confident ? '' : ' caddie-chip--soft'}`}>
          {confident ? 'Confident' : 'Best guess'}
        </span>
        {recommendation.alternativeSize ? (
          <span className="caddie-muted">If you are between sizes, {recommendation.alternativeSize} also works.</span>
        ) : null}
      </div>
    </section>
  );
}

/* ---------------- Pack ---------------- */

interface PackPanelProps {
  recommendation: PackRecommendation;
  onSwap?: (product: Product) => void;
  onAddAll?: (products: Product[]) => void;
}

export function PackPanel({ recommendation, onSwap, onAddAll }: PackPanelProps) {
  return (
    <section className="caddie-panel">
      <header className="caddie-panel__header">
        <span className="caddie-panel__label">Your pack</span>
        <strong className={recommendation.overBudget ? 'caddie-total is-over' : 'caddie-total'}>
          {formatMoney(recommendation.total)}
        </strong>
      </header>
      <p className="caddie-panel__lead">{recommendation.reason}</p>
      <ProductCarousel products={recommendation.items} onSelect={onSwap} />
      {recommendation.items.length > 0 && onAddAll ? (
        <button type="button" className="caddie-btn" onClick={() => onAddAll(recommendation.items)}>
          Add all {recommendation.items.length} to basket
        </button>
      ) : null}
    </section>
  );
}

/* ---------------- Outfit ---------------- */

interface OutfitPanelProps {
  recommendation: OutfitRecommendation;
  onAddAll?: (products: Product[]) => void;
}

export function OutfitPanel({ recommendation, onAddAll }: OutfitPanelProps) {
  return (
    <section className="caddie-panel">
      <header className="caddie-panel__header">
        <span className="caddie-panel__label">The look</span>
        <strong className="caddie-total">{formatMoney(recommendation.total)}</strong>
      </header>
      <p className="caddie-panel__lead">{recommendation.reason}</p>
      <div className="caddie-carousel" role="list">
        {recommendation.pieces.map((piece) => (
          <div role="listitem" key={`${piece.slot}-${piece.product.id}`}>
            <ProductCard product={piece.product} slot={piece.slot} />
          </div>
        ))}
      </div>
      {recommendation.pieces.length > 0 && onAddAll ? (
        <button
          type="button"
          className="caddie-btn"
          onClick={() => onAddAll(recommendation.pieces.map((piece) => piece.product))}
        >
          Add the outfit
        </button>
      ) : null}
    </section>
  );
}

/* ---------------- Basket ---------------- */

interface BasketPanelProps {
  cart: Cart;
  onChangeQuantity?: (lineId: string, quantity: number) => void;
}

export function BasketPanel({ cart, onChangeQuantity }: BasketPanelProps) {
  if (cart.lines.length === 0) {
    return <p className="caddie-empty">Your basket is empty.</p>;
  }

  return (
    <section className="caddie-panel">
      <header className="caddie-panel__header">
        <span className="caddie-panel__label">Basket</span>
        <strong className="caddie-total">{formatMoney(cart.subtotal)}</strong>
      </header>

      <ul className="caddie-basket">
        {cart.lines.map((line) => (
          <li key={line.lineId} className="caddie-basket__line">
            {line.imageUrl ? <img src={line.imageUrl} alt="" loading="lazy" /> : <div className="caddie-basket__thumb" />}
            <div className="caddie-basket__detail">
              <p className="caddie-basket__title">{line.title}</p>
              <p className="caddie-muted">{line.variantTitle}</p>
            </div>
            <div className="caddie-basket__qty">
              {onChangeQuantity ? (
                <>
                  <button type="button" aria-label="Decrease" onClick={() => onChangeQuantity(line.lineId, line.quantity - 1)}>
                    -
                  </button>
                  <span>{line.quantity}</span>
                  <button type="button" aria-label="Increase" onClick={() => onChangeQuantity(line.lineId, line.quantity + 1)}>
                    +
                  </button>
                </>
              ) : (
                <span>x{line.quantity}</span>
              )}
            </div>
            <span className="caddie-basket__price">{formatMoney(line.lineTotal)}</span>
          </li>
        ))}
      </ul>

      {cart.checkoutUrl ? (
        <a className="caddie-btn caddie-btn--primary" href={cart.checkoutUrl}>
          Checkout
        </a>
      ) : null}
    </section>
  );
}

/* ---------------- Switch ---------------- */

interface ResultPanelProps {
  attachment: CaddieAttachment | null;
  onAdd?: (product: Product) => void;
  onAddAll?: (products: Product[]) => void;
  onChangeQuantity?: (lineId: string, quantity: number) => void;
}

export function ResultPanel({ attachment, onAdd, onAddAll, onChangeQuantity }: ResultPanelProps) {
  if (!attachment) return null;

  switch (attachment.kind) {
    case 'products':
      return <ProductCarousel products={attachment.products} onAdd={onAdd} />;
    case 'size':
      return <SizePanel recommendation={attachment.recommendation} />;
    case 'pack':
      return <PackPanel recommendation={attachment.recommendation} onAddAll={onAddAll} />;
    case 'outfit':
      return <OutfitPanel recommendation={attachment.recommendation} onAddAll={onAddAll} />;
    case 'cart':
      return <BasketPanel cart={attachment.cart} onChangeQuantity={onChangeQuantity} />;
    default:
      return null;
  }
}
