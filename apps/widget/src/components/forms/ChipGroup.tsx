import type { ReactNode } from 'react';

export interface ChipOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  icon?: ReactNode;
}

/** A single-choice row of chips (or cards, with `variant="cards"`). Tap again to clear. */
export function ChipGroup<T extends string>({
  options,
  value,
  onChange,
  variant = 'chips',
}: {
  options: Array<ChipOption<T>>;
  value: T | null;
  onChange: (value: T | null) => void;
  variant?: 'chips' | 'cards';
}) {
  return (
    <div className={variant === 'cards' ? 'caddie-choice-cards' : 'caddie-chips'}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            className={`${variant === 'cards' ? 'caddie-choice-card' : 'caddie-chip-btn'}${selected ? ' is-selected' : ''}`}
            onClick={() => onChange(selected ? null : option.value)}
          >
            {option.icon ? <span className="caddie-choice-card__icon">{option.icon}</span> : null}
            <span>
              {option.label}
              {option.hint ? <small className="caddie-choice-card__hint">{option.hint}</small> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
