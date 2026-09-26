import { useState } from 'react';
import type { ShopperSizes } from '@caddie/shared';
import { CloseIcon } from './icons.js';

/**
 * Who are you shopping for, and in what size - asked first, in two taps.
 *
 * Everything after depends on it: mens, ladies and kids are separate ranges on
 * separate size scales, and a card that opens on the customer's own size is one
 * tap from the basket instead of three. Waist is asked only for mens, whose
 * trousers use a different scale to their tops; ladies' and kids' bottoms use
 * the same sizes as their tops. Every step can be skipped.
 */

type Range = NonNullable<ShopperSizes['range']>;

const RANGES: Array<{ value: Range; label: string }> = [
  { value: 'men', label: 'Men' },
  { value: 'women', label: 'Ladies' },
  { value: 'kids', label: 'Kids' },
];

/** The sizes Druids stocks in each range, as the store names them. */
const SIZES: Record<Range, string[]> = {
  men: ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'],
  women: ['8', '10', '12', '14', '16', '18'],
  kids: ['6/8', '8/10', '10/12', '12/14'],
};

const WAISTS = ['30', '32', '34', '36', '38', '40', '42'];

const RANGE_LABEL: Record<Range, string> = { men: 'Men', women: 'Ladies', kids: 'Kids' };

export function describeSizes(sizes: ShopperSizes | null): string | null {
  if (!sizes?.range) return null;
  return [RANGE_LABEL[sizes.range], sizes.size, sizes.waist ? `${sizes.waist} waist` : null].filter(Boolean).join(' · ');
}

interface QuickStartProps {
  initial?: ShopperSizes | null;
  busy: boolean;
  onDone: (profile: ShopperSizes) => void;
  /** Shown when changing answers already given. */
  onCancel?: () => void;
}

export function QuickStart({ initial, busy, onDone, onCancel }: QuickStartProps) {
  const [range, setRange] = useState<Range | null>(initial?.range ?? null);
  const [size, setSize] = useState<string | null>(initial?.size ?? null);
  const [step, setStep] = useState<'range' | 'size' | 'waist'>(initial?.range ? 'size' : 'range');

  const finish = (waist: string | null, chosenSize = size) => {
    if (!range) return;
    onDone({ range, ...(chosenSize ? { size: chosenSize } : {}), ...(waist ? { waist } : {}) });
  };

  const pickSize = (value: string | null) => {
    setSize(value);
    if (range === 'men') setStep('waist');
    else finish(null, value);
  };

  return (
    <section className={`caddie-card caddie-quickstart${onCancel ? ' has-close' : ''}`} aria-label="Quick start">
      {/* Closing, like any other panel: a cross in the corner rather than a word at the bottom. */}
      {onCancel ? (
        <button type="button" className="caddie-icon-btn caddie-icon-btn--small caddie-quickstart__close" aria-label="Close without changing" onClick={onCancel}>
          <CloseIcon size={16} />
        </button>
      ) : null}
      {step === 'range' ? (
        <>
          <p className="caddie-quickstart__question">Who are you shopping for?</p>
          <div className="caddie-chips">
            {RANGES.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`caddie-chip-btn${range === option.value ? ' is-selected' : ''}`}
                disabled={busy}
                onClick={() => {
                  setRange(option.value);
                  if (option.value !== initial?.range) setSize(null);
                  setStep('size');
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {step === 'size' && range ? (
        <>
          <p className="caddie-quickstart__question">
            {range === 'kids' ? 'What size do they wear?' : 'What size do you usually wear?'}
          </p>
          <div className="caddie-chips">
            {SIZES[range].map((value) => (
              <button
                key={value}
                type="button"
                className={`caddie-chip-btn${size === value ? ' is-selected' : ''}`}
                disabled={busy}
                onClick={() => pickSize(value)}
              >
                {range === 'kids' ? `${value} yrs` : value}
              </button>
            ))}
            <button type="button" className="caddie-chip-btn caddie-chip-btn--quiet" disabled={busy} onClick={() => pickSize(null)}>
              Not sure
            </button>
          </div>
          <button type="button" className="caddie-link caddie-quickstart__back" onClick={() => setStep('range')}>
            {RANGE_LABEL[range]} - change
          </button>
        </>
      ) : null}

      {step === 'waist' ? (
        <>
          <p className="caddie-quickstart__question">And your waist, for trousers and shorts?</p>
          <div className="caddie-chips">
            {WAISTS.map((value) => (
              <button
                key={value}
                type="button"
                className={`caddie-chip-btn${initial?.waist === value ? ' is-selected' : ''}`}
                disabled={busy}
                onClick={() => finish(value)}
              >
                {value}"
              </button>
            ))}
            <button type="button" className="caddie-chip-btn caddie-chip-btn--quiet" disabled={busy} onClick={() => finish(null)}>
              Skip
            </button>
          </div>
          <button type="button" className="caddie-link caddie-quickstart__back" onClick={() => setStep('size')}>
            Back
          </button>
        </>
      ) : null}
    </section>
  );
}
