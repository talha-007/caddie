import { useEffect, useState } from 'react';
import type { Money, Product, ProductVariant } from '@caddie/shared';
import { formatMoney, saving } from '../lib/format.js';
import { ShirtIcon, SwapIcon } from './icons.js';
import { chosenColour, ProductOptions, useProductChoice } from './ProductOptions.js';
import { useShop } from './ShopContext.js';

/**
 * Product cards. Every name, price and option here comes from the product
 * payload (Shopify MCP) - nothing is taken from the Caddie's sentence.
 */

export function ProductImage({ product, size }: { product: Product; size?: 'row' }) {
  const [failed, setFailed] = useState(false);
  const className = `caddie-media${size === 'row' ? ' caddie-media--row' : ''}`;
  if (!product.imageUrl || failed) {
    return (
      <div className={`${className} caddie-media--empty`} aria-hidden="true">
        <ShirtIcon size={size === 'row' ? 24 : 32} />
      </div>
    );
  }
  return (
    <div className={className}>
      <img src={product.imageUrl} alt={product.title} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </div>
  );
}

export function Price({ price, compareAt }: { price: Money; compareAt?: Money | null | undefined }) {
  const saved = saving(price, compareAt);
  return (
    <p className="caddie-price">
      <strong>{formatMoney(price)}</strong>
      {saved && compareAt ? (
        <>
          {' '}
          <s className="caddie-price__rrp">RRP {formatMoney(compareAt)}</s>
        </>
      ) : null}
    </p>
  );
}

/** Tells the parent panel which variant the customer settled on, for "Add all". */
type ChoiceListener = (productId: string, variant: ProductVariant | null) => void;

function useReportChoice(productId: string, variant: ProductVariant | null, onChoice?: ChoiceListener) {
  const variantId = variant?.id ?? null;
  useEffect(() => {
    onChoice?.(productId, variant);
    // Report on change of the chosen variant only.
  }, [productId, variantId]);
}

interface CardProps {
  product: Product;
  /** e.g. "Top" in an outfit. */
  slot?: string;
  /** Show an Add button on the card itself. */
  addable?: boolean;
  /** Offer "swap this one" - it asks the Caddie, which re-runs the recommendation. */
  swappable?: boolean;
  onChoice?: ChoiceListener;
}

function AddButton({ product, variant, label = 'Add' }: { product: Product; variant: ProductVariant | null; label?: string }) {
  const shop = useShop();
  return (
    <button
      type="button"
      className="caddie-btn caddie-btn--primary caddie-btn--small"
      disabled={!variant || shop.busy}
      onClick={() => variant && shop.addToBasket([{ variantId: variant.id, title: product.title }])}
      aria-label={variant ? `Add ${product.title} to basket` : `Choose options for ${product.title} first`}
    >
      {label}
    </button>
  );
}

function SwapButton({ product }: { product: Product }) {
  const shop = useShop();
  return (
    <button
      type="button"
      className="caddie-icon-btn caddie-icon-btn--small"
      aria-label={`Swap ${product.title} for something else`}
      disabled={shop.busy}
      onClick={() => shop.send(`Swap the ${product.title} for something else`)}
    >
      <SwapIcon size={16} />
    </button>
  );
}

/** Grid card - packs and search results. */
export function ProductTile({ product, slot, addable, swappable, onChoice }: CardProps) {
  const choice = useProductChoice(product);
  useReportChoice(product.id, choice.variant, onChoice);
  const colour = chosenColour(choice);
  const price = choice.variant?.price ?? product.price;

  return (
    <article className="caddie-tile">
      <div className="caddie-tile__media">
        <ProductImage product={product} />
        {swappable ? <SwapButton product={product} /> : null}
      </div>
      <div className="caddie-tile__body">
        {slot ? <span className="caddie-eyebrow">{slot}</span> : null}
        <h4 className="caddie-tile__title">{product.title}</h4>
        {colour ? <p className="caddie-tile__meta">{colour}</p> : null}
        <Price price={price} compareAt={product.compareAtPrice} />
        <ProductOptions product={product} choice={choice} compact />
        {addable ? <AddButton product={product} variant={choice.variant} /> : null}
      </div>
    </article>
  );
}

/** List row - outfits and the product page, where each piece gets its own Add. */
export function ProductRow({ product, slot, addable = true, swappable, onChoice }: CardProps) {
  const choice = useProductChoice(product);
  useReportChoice(product.id, choice.variant, onChoice);
  const colour = chosenColour(choice);
  const price = choice.variant?.price ?? product.price;

  return (
    <article className="caddie-row">
      <ProductImage product={product} size="row" />
      <div className="caddie-row__body">
        {slot ? <span className="caddie-eyebrow">{slot}</span> : null}
        <h4 className="caddie-row__title">
          {product.title}
          {colour ? <span className="caddie-row__colour"> · {colour}</span> : null}
        </h4>
        <Price price={price} compareAt={product.compareAtPrice} />
        <div className="caddie-row__controls">
          <ProductOptions product={product} choice={choice} />
          <div className="caddie-row__actions">
            {swappable ? <SwapButton product={product} /> : null}
            {addable ? <AddButton product={product} variant={choice.variant} /> : null}
          </div>
        </div>
      </div>
    </article>
  );
}

export function ProductGrid({ products, addable }: { products: Product[]; addable?: boolean }) {
  if (products.length === 0) {
    return <p className="caddie-empty">Nothing matched that. Try describing it a different way.</p>;
  }
  return (
    <div className="caddie-grid" role="list">
      {products.map((product) => (
        <div role="listitem" key={product.id}>
          <ProductTile product={product} addable={addable} />
        </div>
      ))}
    </div>
  );
}

