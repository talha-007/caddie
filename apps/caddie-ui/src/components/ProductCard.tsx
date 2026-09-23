import { useState } from 'react';
import type { Money, Product } from '@caddie/shared';

export function formatMoney(money: Money): string {
  const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
  const symbol = symbols[money.currency];
  const amount = money.amount.toFixed(2);
  return symbol ? `${symbol}${amount}` : `${amount} ${money.currency}`;
}

/**
 * Asks the Shopify CDN for an image the size we actually draw.
 *
 * The catalogue hands back 1440px originals for a card about 170px wide. Left
 * alone that is seconds of grey box on a phone, which reads as broken. The CDN
 * resizes on the fly from a `width` parameter.
 */
function sized(url: string, width: number): string {
  if (!url.includes('cdn.shopify.com')) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('width', String(width));
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Which of a product's option values can actually be bought.
 *
 * The list of choices comes from `options` - `variants` only says which of
 * those are in stock, and may not even cover them all. Building the picker
 * from `variants` is the bug that silently adds whichever size came first.
 */
function availability(product: Product, optionName: string): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const variant of product.variants) {
    const value = variant.options[optionName];
    if (value) map.set(value, variant.available);
  }
  return map;
}

interface ProductCardProps {
  product: Product;
  /** Shown above the title in an outfit, e.g. "top". */
  slot?: string;
  busy?: boolean;
  onAdd?: (product: Product, options: Record<string, string>) => void;
}

export function ProductCard({ product, slot, busy, onAdd }: ProductCardProps) {
  const [chosen, setChosen] = useState<Record<string, string>>({});

  // Anything with a single value is not a choice, it is a fact.
  const choices = product.options.filter((option) => option.values.length > 1);
  const ready = choices.every((option) => chosen[option.name]);

  return (
    <article className="card">
      <div className="card__media">
        {product.imageUrl ? (
          <img
            src={sized(product.imageUrl, 360)}
            srcSet={`${sized(product.imageUrl, 360)} 1x, ${sized(product.imageUrl, 720)} 2x`}
            alt={product.title}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="card__media-empty" aria-hidden="true" />
        )}
      </div>

      <div className="card__body">
        {slot ? <span className="card__slot">{slot}</span> : null}
        <h4 className="card__title" title={product.title}>
          {product.title}
        </h4>
        <p className="card__price">{formatMoney(product.price)}</p>

        {/*
          A select rather than a row of chips: seven sizes wrap to three rows
          and push the Add button out of the card, and on a phone this gets the
          native picker for free.
        */}
        {choices.map((option) => {
          const stock = availability(product, option.name);
          return (
            <label className="card__option" key={option.name}>
              <span className="card__option-name">{option.name}</span>
              <select
                className="select"
                value={chosen[option.name] ?? ''}
                onChange={(event) =>
                  setChosen((prev) => ({ ...prev, [option.name]: event.target.value }))
                }
              >
                <option value="">Choose…</option>
                {option.values.map((value) => {
                  // Unknown means this call did not return it, not out of stock.
                  const inStock = stock.get(value) !== false;
                  return (
                    <option key={value} value={value} disabled={!inStock}>
                      {inStock ? value : `${value} — out of stock`}
                    </option>
                  );
                })}
              </select>
            </label>
          );
        })}

        {onAdd ? (
          <button
            type="button"
            className="btn btn--primary btn--block"
            disabled={busy || !ready}
            onClick={() => onAdd(product, chosen)}
          >
            {ready ? 'Add to basket' : `Choose a ${choices[0]?.name.toLowerCase() ?? 'size'}`}
          </button>
        ) : null}
      </div>
    </article>
  );
}

interface CarouselProps {
  products: Product[];
  busy?: boolean;
  onAdd?: (product: Product, options: Record<string, string>) => void;
}

export function ProductCarousel({ products, busy, onAdd }: CarouselProps) {
  if (products.length === 0) {
    return <p className="empty">Nothing matched that. Try describing it a different way.</p>;
  }
  return (
    <div className="carousel" role="list">
      {products.map((product) => (
        <div role="listitem" key={product.id}>
          <ProductCard product={product} busy={busy} onAdd={onAdd} />
        </div>
      ))}
    </div>
  );
}
