import { useCallback, useEffect, useState } from 'react';
import type { Product, ProductVariant } from '@caddie/shared';
import {
  initialSelection,
  isValueAvailable,
  matchVariant,
  nothingToChoose,
  productOptions,
  suggestedSize,
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
  /** The size we recommended, when no size is chosen yet - shown as a hint, never as a choice. */
  suggested?: string;
  choose: (name: string, value: string) => void;
  load: () => Promise<void>;
}

export function useProductChoice(product: Product): ProductChoice {
  const shop = useShop();
  const full = shop.details[product.id] ?? (product.variants.length > 0 ? product : null);
  const onThisPage = Boolean(shop.page.productId && sameId(shop.page.productId, product.id));
  // Chosen in conversation first, then the variant on the page they are looking at.
  const pickedId = shop.picked[product.id] ?? null;
  /*
   * Their own size and waist - as the server holds them, so the Caddie counts
   * what the card shows. A size we recommended is a suggestion beside the
   * picker (suggestedSize), never the card's selection.
   */
  const hints = {
    size: shop.sizes?.size ?? null,
    waist: shop.sizes?.waist ?? null,
    // Agreed in conversation - theirs, every option of it.
    pickedVariantId: pickedId,
    // The page's variant - the theme's default as often as their pick: its colour only.
    variantId: onThisPage ? (shop.page.variantId ?? null) : null,
  };

  const [selection, setSelection] = useState<Selection>(() => (full ? initialSelection(full, hints) : {}));
  /*
   * What the customer has picked on this card themselves. The card opens on
   * a sensible size - ours, not theirs - so only a tap or a change counts,
   * and only these are sent to the Caddie.
   */
  const [picked, setPicked] = useState<Selection>({});
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

  const { chooseOnCard } = shop;
  const choose = useCallback(
    (name: string, value: string) => {
      setSelection((prev) => ({ ...prev, [name]: value }));
      const next = { ...picked, [name]: value };
      setPicked(next);
      const variant = full ? matchVariant(full, { ...selection, [name]: value }) : null;
      chooseOnCard({ productId: product.id, options: next, ...(variant ? { variantId: variant.id } : {}) });
    },
    [chooseOnCard, full, picked, product.id, selection],
  );

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

  const sizeOption = full ? productOptions(full).find((option) => option.kind === 'size') : undefined;
  const suggested = full && sizeOption && !selection[sizeOption.name] ? suggestedSize(full, shop.size?.size) : undefined;

  return {
    full,
    selection,
    ...(suggested ? { suggested } : {}),
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

/*
 * Size, waist and leg pickers are hidden for now - we are not showing them on
 * the card. Colour swatches stay. Everything behind this flag still works:
 * the selection, the variant matching and "Add" are untouched, so flipping it
 * back to true brings the pickers back exactly as they were.
 */
const SHOW_SIZE_OPTIONS: boolean = false;

export function ProductOptions({ product, choice, compact }: ProductOptionsProps) {
  // Nothing loaded yet: with the size pickers hidden there is nothing to ask for.
  if (!choice.full && !SHOW_SIZE_OPTIONS) return null;

  if (!choice.full) {
    return (
      <button type="button" className="caddie-btn caddie-btn--ghost caddie-btn--block" onClick={choice.load} disabled={choice.loading}>
        {choice.loading ? 'Loading sizes…' : 'Choose size'}
      </button>
    );
  }

  const full = choice.full;
  // Colour only while SHOW_SIZE_OPTIONS is off.
  const options = productOptions(full).filter((option) => SHOW_SIZE_OPTIONS || option.kind === 'colour');
  if (options.length === 0) return null;
  /*
   * Trousers have a waist and a leg: each choice says which it is ("Waist 34",
   * "Leg 32"), or two pickers reading "34" and "32" cannot be told apart.
   */
  const named = options.filter((option) => option.kind !== 'colour').length > 1;

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
                {shortName(option)}
              </option>
              {option.values.map((value) => {
                const available = isValueAvailable(full, choice.selection, option.name, value);
                return (
                  <option key={value} value={value} disabled={!available}>
                    {named ? `${shortName(option)} ${value}` : value}
                    {available ? '' : ' – sold out'}
                  </option>
                );
              })}
            </select>
            {option.kind === 'size' && choice.suggested ? (
              <button type="button" className="caddie-suggested" onClick={() => choice.choose(option.name, choice.suggested!)}>
                Suggested: {choice.suggested}
              </button>
            ) : null}
          </label>
        ),
      )}
    </div>
  );
}

/** What a picker is, in a word that fits a narrow tile: "Size", "Waist", "Leg". */
function shortName(option: { name: string; kind: string }): string {
  if (/waist/i.test(option.name)) return 'Waist';
  if (/leg|length|inseam/i.test(option.name)) return 'Leg';
  if (option.kind === 'size') return 'Size';
  const name = option.name.trim().toLowerCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** "Navy" - the colour the customer picked, shown under the title. */
export function chosenColour(choice: ProductChoice): string | null {
  if (!choice.full) return null;
  const colour = productOptions(choice.full).find((option) => option.kind === 'colour');
  return colour ? (choice.selection[colour.name] ?? null) : null;
}
