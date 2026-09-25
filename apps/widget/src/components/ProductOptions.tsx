import { useCallback, useEffect, useState } from 'react';
import type { Product, ProductVariant } from '@caddie/shared';
import {
  initialSelection,
  isValueAvailable,
  matchVariant,
  nothingToChoose,
  productOptions,
  sameId,
  swatchColour,
  type Selection,
} from '../lib/variants.js';
import { useShop } from './ShopContext.js';

/**
 * The customer's choice of size and colour for one product.
 *
 * A search result often has no variants yet, so `full` stays null until the
 * customer taps "Choose size" and we load the real options from Shopify.
 */
export interface ProductChoice {
  full: Product | null;
  selection: Selection;
  /** The customer's variant: only ever one that matches every choice. */
  variant: ProductVariant | null;
  loading: boolean;
  /** Checking that combination with the store. */
  resolving: boolean;
  /** Every option chosen, but that combination is not in stock. */
  soldOut: boolean;
  choose: (name: string, value: string) => void;
  load: () => Promise<void>;
}

export function useProductChoice(product: Product): ProductChoice {
  const shop = useShop();
  const full = shop.details[product.id] ?? (product.variants.length > 0 ? product : null);
  const onThisPage = Boolean(shop.page.productId && sameId(shop.page.productId, product.id));
  // Chosen in conversation first, then the variant on the page they are looking at.
  const pickedId = shop.picked[product.id] ?? null;
  // A size worked out for them wins; otherwise the size and waist they gave us.
  const hints = {
    size: shop.size?.size ?? shop.sizes?.size ?? null,
    waist: shop.sizes?.waist ?? null,
    variantId: pickedId ?? (onThisPage ? (shop.page.variantId ?? null) : null),
  };

  const [selection, setSelection] = useState<Selection>(() => (full ? initialSelection(full, hints) : {}));
  const [loading, setLoading] = useState(false);

  // Variants arrived after the first render - start from the same sensible defaults.
  const fullId = full?.id;
  useEffect(() => {
    if (full && Object.keys(selection).length === 0) setSelection(initialSelection(full, hints));
    // Only when the loaded product changes, not on every selection.
  }, [fullId]);

  // Sizes agreed by talking move the pickers too, not only the basket.
  useEffect(() => {
    if (full && pickedId) setSelection(initialSelection(full, hints));
  }, [pickedId, fullId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await shop.loadProduct(product);
    } finally {
      setLoading(false);
    }
  }, [product, shop]);

  const choose = useCallback((name: string, value: string) => {
    setSelection((prev) => ({ ...prev, [name]: value }));
  }, []);

  /*
   * The server sends every option but only the variant matching what has been
   * chosen, so once the customer has picked everything we ask it for that exact
   * combination. A variant we already hold that matches is used as it is.
   */
  const options = full ? productOptions(full) : [];
  const complete = Boolean(full) && options.length > 0 && options.every((option) => selection[option.name]);
  const local = full ? matchVariant(full, selection) : null;
  const key = `${full?.id ?? ''}|${JSON.stringify(selection)}`;
  const [resolved, setResolved] = useState<{ key: string; variant: ProductVariant | null } | null>(null);
  const [resolving, setResolving] = useState(false);
  const { resolveVariant } = shop;

  useEffect(() => {
    if (!full || !complete || local) return;
    let cancelled = false;
    setResolving(true);
    void resolveVariant(full.id, selection)
      .then((variant) => {
        if (!cancelled) setResolved({ key, variant });
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
    // The selection, folded into `key`, is what drives this.
  }, [complete, full, key, local, resolveVariant]);

  const settled = local ?? (resolved?.key === key ? resolved.variant : null);
  const variant = full && (complete || nothingToChoose(full)) ? settled : null;

  return {
    full,
    selection,
    variant: variant?.available ? variant : null,
    loading,
    resolving,
    soldOut: Boolean(variant && !variant.available),
    choose,
    load,
  };
}

interface ProductOptionsProps {
  product: Product;
  choice: ProductChoice;
  /** Tighter spacing for grid tiles. */
  compact?: boolean;
}

export function ProductOptions({ product, choice, compact }: ProductOptionsProps) {
  if (!choice.full) {
    return (
      <button type="button" className="caddie-btn caddie-btn--ghost caddie-btn--block" onClick={choice.load} disabled={choice.loading}>
        {choice.loading ? 'Loading sizes…' : 'Choose size'}
      </button>
    );
  }

  const full = choice.full;
  const options = productOptions(full);
  if (options.length === 0) return null;

  return (
    <div className={`caddie-options${compact ? ' caddie-options--compact' : ''}`}>
      {options.map((option) =>
        option.kind === 'colour' ? (
          <div key={option.name} className="caddie-swatches" role="radiogroup" aria-label={`${option.name} for ${product.title}`}>
            {option.values.map((value) => {
              const colour = swatchColour(value);
              const selected = choice.selection[option.name] === value;
              const available = isValueAvailable(full, choice.selection, option.name, value);
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`${value}${available ? '' : ' (sold out)'}`}
                  title={value}
                  className={`caddie-swatch${selected ? ' is-selected' : ''}${available ? '' : ' is-unavailable'}`}
                  onClick={() => choice.choose(option.name, value)}
                >
                  <span
                    className={`caddie-swatch__dot${colour ? '' : ' caddie-swatch__dot--unknown'}`}
                    style={colour ? { background: colour } : undefined}
                  />
                </button>
              );
            })}
          </div>
        ) : (
          <label key={option.name} className="caddie-select">
            <span className="caddie-visually-hidden">
              {option.name} for {product.title}
            </span>
            <select
              value={choice.selection[option.name] ?? ''}
              onChange={(event) => choice.choose(option.name, event.target.value)}
            >
              <option value="" disabled>
                {option.name}
              </option>
              {option.values.map((value) => {
                const available = isValueAvailable(full, choice.selection, option.name, value);
                return (
                  <option key={value} value={value} disabled={!available}>
                    {available ? value : `${value} – sold out`}
                  </option>
                );
              })}
            </select>
          </label>
        ),
      )}
    </div>
  );
}

/** "Navy" - the colour the customer picked, shown under the title. */
export function chosenColour(choice: ProductChoice): string | null {
  if (!choice.full) return null;
  const colour = productOptions(choice.full).find((option) => option.kind === 'colour');
  return colour ? (choice.selection[colour.name] ?? null) : null;
}
