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
 * One panel per attachment kind.
 *
 * The Caddie explains itself in the conversation, so these stay quiet: show
 * what was found, and let the words do the explaining.
 */

export function SizePanel({ recommendation }: { recommendation: SizeRecommendation }) {
  // No size is a real answer: not enough information yet, or socks, which
  // Druids sizes by style. The reason says which.
  if (!recommendation.size) {
    return (
      <section className="panel">
        <span className="panel__label">Size</span>
        <p className="panel__lead">{recommendation.reason}</p>
        {recommendation.measureAdvice ? <p className="muted">{recommendation.measureAdvice}</p> : null}
      </section>
    );
  }

  return (
    <section className="panel panel--size">
      <span className="panel__label">Your size</span>
      <p className="size">{recommendation.size}</p>
      <p className="panel__lead">{recommendation.reason}</p>
      {recommendation.alternativeSize ? (
        <p className="muted">If you are between sizes, {recommendation.alternativeSize} also works.</p>
      ) : null}
    </section>
  );
}

interface AddProps {
  busy?: boolean;
  onAdd?: (product: Product, options: Record<string, string>) => void;
}

export function PackPanel({ recommendation, busy, onAdd }: { recommendation: PackRecommendation } & AddProps) {
  return (
    <section className="panel">
      <header className="panel__head">
        <span className="panel__label">Your pack</span>
        <strong className={recommendation.overBudget ? 'total total--over' : 'total'}>
          {formatMoney(recommendation.total)}
        </strong>
      </header>
      <p className="panel__lead">{recommendation.reason}</p>
      <ProductCarousel products={recommendation.items} busy={busy} onAdd={onAdd} />
    </section>
  );
}

export function OutfitPanel({ recommendation, busy, onAdd }: { recommendation: OutfitRecommendation } & AddProps) {
  return (
    <section className="panel">
      <header className="panel__head">
        <span className="panel__label">The look</span>
        <strong className="total">{formatMoney(recommendation.total)}</strong>
      </header>
      <p className="panel__lead">{recommendation.reason}</p>
      {/* Slots can be missing - nothing in stock fitted, so nothing was padded. */}
      <div className="carousel" role="list">
        {recommendation.pieces.map((piece) => (
          <div role="listitem" key={`${piece.slot}-${piece.product.id}`}>
            <ProductCard product={piece.product} slot={piece.slot} busy={busy} onAdd={onAdd} />
          </div>
        ))}
      </div>
    </section>
  );
}

interface BasketProps {
  cart: Cart;
  busy?: boolean;
  onChangeQuantity?: (lineId: string, quantity: number) => void;
}

export function BasketPanel({ cart, busy, onChangeQuantity }: BasketProps) {
  if (cart.lines.length === 0) {
    return <p className="empty">Your basket is empty.</p>;
  }

  return (
    <section className="panel">
      <header className="panel__head">
        <span className="panel__label">Basket</span>
        <strong className="total">{formatMoney(cart.subtotal)}</strong>
      </header>

      <ul className="basket">
        {cart.lines.map((line) => (
          <li key={line.lineId} className="basket__line">
            {line.imageUrl ? <img src={line.imageUrl} alt="" loading="lazy" /> : <div className="basket__thumb" />}
            <div className="basket__detail">
              <p className="basket__title">{line.title}</p>
              <p className="muted">{formatMoney(line.unitPrice)} each</p>
            </div>
            <div className="qty">
              <button
                type="button"
                aria-label="Fewer"
                disabled={busy}
                onClick={() => onChangeQuantity?.(line.lineId, line.quantity - 1)}
              >
                −
              </button>
              <span>{line.quantity}</span>
              <button
                type="button"
                aria-label="More"
                disabled={busy}
                onClick={() => onChangeQuantity?.(line.lineId, line.quantity + 1)}
              >
                +
              </button>
            </div>
            <span className="basket__price">{formatMoney(line.lineTotal)}</span>
          </li>
        ))}
      </ul>

      {cart.checkoutUrl ? (
        <a className="btn btn--primary btn--block" href={cart.checkoutUrl} target="_blank" rel="noreferrer">
          Checkout
        </a>
      ) : null}
    </section>
  );
}

interface ResultPanelProps {
  attachment: CaddieAttachment | null;
  busy?: boolean;
  onAdd?: (product: Product, options: Record<string, string>) => void;
  onChangeQuantity?: (lineId: string, quantity: number) => void;
}

export function ResultPanel({ attachment, busy, onAdd, onChangeQuantity }: ResultPanelProps) {
  if (!attachment) return null;

  switch (attachment.kind) {
    case 'products':
      return <ProductCarousel products={attachment.products} busy={busy} onAdd={onAdd} />;
    case 'size':
      return <SizePanel recommendation={attachment.recommendation} />;
    case 'pack':
      return <PackPanel recommendation={attachment.recommendation} busy={busy} onAdd={onAdd} />;
    case 'outfit':
      return <OutfitPanel recommendation={attachment.recommendation} busy={busy} onAdd={onAdd} />;
    case 'cart':
      return <BasketPanel cart={attachment.cart} busy={busy} onChangeQuantity={onChangeQuantity} />;
    default:
      return null;
  }
}
