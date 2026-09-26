import { useEffect, useState } from 'react';
import type { Money, Product, ProductVariant } from '@caddie/shared';
import { formatMoney, saving } from '../lib/format.js';
import { ShirtIcon, SwapIcon } from './icons.js';
import { chosenColour, ProductOptions, useProductChoice, type ProductChoice } from './ProductOptions.js';
import { useShop } from './ShopContext.js';

/**
 * Product cards. Every name, price and option here comes from the product
 * payload (Shopify MCP) - nothing is taken from the Caddie's sentence.
 */

export function ProductImage({ product, size, linked }: { product: Product; size?: 'row'; linked?: boolean }) {
  const [failed, setFailed] = useState(false);
  const className = `caddie-media${size === 'row' ? ' caddie-media--row' : ''}`;
  const image =
    !product.imageUrl || failed ? (
      <div className={`${className} caddie-media--empty`} aria-hidden="true">
        <ShirtIcon size={size === 'row' ? 24 : 32} />
      </div>
    ) : (
      <div className={className}>
        <img src={product.imageUrl} alt={product.title} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </div>
    );
  // The picture opens the product too - it is what a shopper taps first. The title link carries the name for screen readers.
  return linked && product.url ? (
    <a className="caddie-media-link" href={product.url} target="_top" tabIndex={-1} aria-hidden="true">
      {image}
    </a>
  ) : (
    image
  );
}

/**
 * The product's own page, where the photos, the description and the size
 * guide are. Opened in the same tab: the conversation is kept per tab, so it
 * is still there when they come back - a new tab would start an empty one.
 */
function ViewLink({ product }: { product: Product }) {
  if (!product.url) return null;
  return (
    <a className="caddie-view-link" href={product.url} target="_top">
      View product <span aria-hidden="true">›</span>
    </a>
  );
}

/** The name, as a link to the product when there is one. */
function ProductName({ product }: { product: Product }) {
  return product.url ? (
    <a className="caddie-name-link" href={product.url} target="_top">
      {product.title}
    </a>
  ) : (
    <>{product.title}</>
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

function AddButton({ product, choice, label = 'Add' }: { product: Product; choice: ProductChoice; label?: string }) {
  const shop = useShop();
  const { variant, resolving, soldOut } = choice;
  const text = resolving ? 'Checking…' : soldOut ? 'Sold out' : label;

  return (
    <button
      type="button"
      className="caddie-btn caddie-btn--primary caddie-btn--small"
      disabled={!variant || shop.busy || resolving}
      onClick={() =>
        variant &&
        shop.addToBasket([
          { productId: product.id, options: variant.options, title: product.title, variantId: variant.id, price: variant.price.amount },
        ])
      }
      aria-label={variant ? `Add ${product.title} to basket` : `Choose options for ${product.title} first`}
    >
      {text}
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
        <ProductImage product={product} linked />
        {swappable ? <SwapButton product={product} /> : null}
      </div>
      <div className="caddie-tile__body">
        {slot ? <span className="caddie-eyebrow">{slot}</span> : null}
        <h4 className="caddie-tile__title">
          <ProductName product={product} />
        </h4>
        {colour ? <p className="caddie-tile__meta">{colour}</p> : null}
        <Price price={price} compareAt={product.compareAtPrice} />
        <ProductOptions product={product} choice={choice} compact />
        {addable ? <AddButton product={product} choice={choice} /> : null}
        <ViewLink product={product} />
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
      <ProductImage product={product} size="row" linked />
      <div className="caddie-row__body">
        {slot ? <span className="caddie-eyebrow">{slot}</span> : null}
        <h4 className="caddie-row__title">
          <ProductName product={product} />
          {colour ? <span className="caddie-row__colour"> · {colour}</span> : null}
        </h4>
        <Price price={price} compareAt={product.compareAtPrice} />
        <ViewLink product={product} />
        <div className="caddie-row__controls">
          <ProductOptions product={product} choice={choice} />
          <div className="caddie-row__actions">
            {swappable ? <SwapButton product={product} /> : null}
            {addable ? <AddButton product={product} choice={choice} /> : null}
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

