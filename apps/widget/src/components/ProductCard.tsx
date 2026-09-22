import type { Money, Product } from '@caddie/shared';

export function formatMoney(money: Money): string {
  const symbol = money.currency === 'GBP' ? '£' : money.currency === 'USD' ? '$' : '';
  return symbol ? `${symbol}${money.amount.toFixed(2)}` : `${money.amount.toFixed(2)} ${money.currency}`;
}

interface ProductCardProps {
  product: Product;
  /** Shown above the title in an outfit, e.g. "top". */
  slot?: string;
  selected?: boolean;
  onSelect?: (product: Product) => void;
  onAdd?: (product: Product) => void;
}

export function ProductCard({ product, slot, selected, onSelect, onAdd }: ProductCardProps) {
  return (
    <article
      className={`caddie-card${selected ? ' is-selected' : ''}`}
      onClick={onSelect ? () => onSelect(product) : undefined}
    >
      <div className="caddie-card__media">
        {product.imageUrl ? (
          <img src={product.imageUrl} alt={product.title} loading="lazy" />
        ) : (
          <div className="caddie-card__media-empty" aria-hidden="true" />
        )}
      </div>
      <div className="caddie-card__body">
        {slot ? <span className="caddie-card__slot">{slot}</span> : null}
        <h4 className="caddie-card__title">{product.title}</h4>
        <p className="caddie-card__price">{formatMoney(product.price)}</p>
        {onAdd ? (
          <button
            type="button"
            className="caddie-btn caddie-btn--small"
            onClick={(event) => {
              event.stopPropagation();
              onAdd(product);
            }}
          >
            Add
          </button>
        ) : null}
      </div>
    </article>
  );
}

interface CarouselProps {
  products: Product[];
  selectedId?: string | null;
  onSelect?: (product: Product) => void;
  onAdd?: (product: Product) => void;
}

export function ProductCarousel({ products, selectedId, onSelect, onAdd }: CarouselProps) {
  if (products.length === 0) {
    return <p className="caddie-empty">Nothing matched that. Try describing it a different way.</p>;
  }
  return (
    <div className="caddie-carousel" role="list">
      {products.map((product) => (
        <div role="listitem" key={product.id}>
          <ProductCard
            product={product}
            selected={product.id === selectedId}
            onSelect={onSelect}
            onAdd={onAdd}
          />
        </div>
      ))}
    </div>
  );
}
