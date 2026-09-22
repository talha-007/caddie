import { useState } from 'react';
import type { Fit, SizeInput } from '@caddie/shared';
import { ChipGroup } from './ChipGroup.js';

/**
 * Find My Size, the concept's "a few quick questions". It calls the
 * find_my_size tool directly with structured answers - no sentence parsing -
 * and the customer can always just say it to the Caddie instead.
 */

const USUAL_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
const NOT_SURE = 'Not sure';

const FITS: Array<{ value: Fit; label: string }> = [
  { value: 'tight', label: 'Fitted' },
  { value: 'regular', label: 'Regular' },
  { value: 'relaxed', label: 'Relaxed' },
];

type HeightUnit = 'cm' | 'ftin';
type WeightUnit = 'kg' | 'stlb';

function toNumber(value: string): number | undefined {
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface SizeFormProps {
  garment: string;
  disabled: boolean;
  onSubmit: (input: SizeInput, summary: string) => void;
}

export function SizeForm({ garment, disabled, onSubmit }: SizeFormProps) {
  const [usual, setUsual] = useState<string | null>(null);
  const [fit, setFit] = useState<Fit | null>(null);
  const [showBody, setShowBody] = useState(false);

  const [heightUnit, setHeightUnit] = useState<HeightUnit>('ftin');
  const [cm, setCm] = useState('');
  const [ft, setFt] = useState('');
  const [inches, setInches] = useState('');
  const [weightUnit, setWeightUnit] = useState<WeightUnit>('kg');
  const [kg, setKg] = useState('');
  const [st, setSt] = useState('');
  const [lb, setLb] = useState('');

  function build(): { input: SizeInput; summary: string[] } {
    const input: SizeInput = {};
    const summary: string[] = [];

    if (usual && usual !== NOT_SURE) {
      input.usualSize = usual;
      summary.push(`I usually wear ${usual}`);
    }
    if (fit) {
      input.fitPreference = fit;
      summary.push(`${FITS.find((f) => f.value === fit)?.label ?? fit} fit`);
    }

    if (showBody) {
      if (heightUnit === 'cm' && toNumber(cm)) {
        input.heightValue = toNumber(cm);
        input.heightUnit = 'cm';
        summary.push(`${cm}cm`);
      }
      const feet = toNumber(ft);
      if (heightUnit === 'ftin' && feet) {
        input.heightValue = feet * 12 + (toNumber(inches) ?? 0);
        input.heightUnit = 'in';
        summary.push(`${ft}'${inches || 0}"`);
      }
      if (weightUnit === 'kg' && toNumber(kg)) {
        input.weightValue = toNumber(kg);
        input.weightUnit = 'kg';
        summary.push(`${kg}kg`);
      }
      const stone = toNumber(st);
      if (weightUnit === 'stlb' && stone) {
        input.weightValue = stone * 14 + (toNumber(lb) ?? 0);
        input.weightUnit = 'lb';
        summary.push(`${st}st ${lb || 0}lb`);
      }
    }
    return { input, summary };
  }

  const { input, summary } = build();
  const ready = Boolean(input.usualSize || input.heightValue || input.weightValue);

  return (
    <form
      className="caddie-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !disabled) onSubmit(input, summary.join(' · '));
      }}
    >
      <fieldset className="caddie-form__q">
        <legend className="caddie-form__ask">What's your usual size in {garment}?</legend>
        <ChipGroup
          options={[...USUAL_SIZES, NOT_SURE].map((value) => ({ value, label: value }))}
          value={usual}
          onChange={setUsual}
        />
      </fieldset>

      <fieldset className="caddie-form__q">
        <legend className="caddie-form__ask">How do you like your fit?</legend>
        <ChipGroup options={FITS} value={fit} onChange={setFit} />
      </fieldset>

      <fieldset className="caddie-form__q">
        <legend className="caddie-form__ask">Anything else I should know?</legend>
        <button
          type="button"
          className={`caddie-chip-btn${showBody ? ' is-selected' : ''}`}
          aria-expanded={showBody}
          onClick={() => setShowBody((open) => !open)}
        >
          Height &amp; weight {usual === NOT_SURE || !usual ? '(helps a lot)' : '(optional)'}
        </button>

        {showBody ? (
          <div className="caddie-measure">
            <div className="caddie-measure__row">
              <span className="caddie-measure__label">Height</span>
              {heightUnit === 'cm' ? (
                <input className="caddie-input" inputMode="decimal" placeholder="180" aria-label="Height in centimetres" value={cm} onChange={(e) => setCm(e.target.value)} />
              ) : (
                <>
                  <input className="caddie-input" inputMode="numeric" placeholder="5" aria-label="Height, feet" value={ft} onChange={(e) => setFt(e.target.value)} />
                  <input className="caddie-input" inputMode="numeric" placeholder="11" aria-label="Height, inches" value={inches} onChange={(e) => setInches(e.target.value)} />
                </>
              )}
              <UnitToggle
                label="Height unit"
                options={[
                  { value: 'ftin', label: 'ft/in' },
                  { value: 'cm', label: 'cm' },
                ]}
                value={heightUnit}
                onChange={setHeightUnit}
              />
            </div>
            <div className="caddie-measure__row">
              <span className="caddie-measure__label">Weight</span>
              {weightUnit === 'kg' ? (
                <input className="caddie-input" inputMode="decimal" placeholder="82" aria-label="Weight in kilograms" value={kg} onChange={(e) => setKg(e.target.value)} />
              ) : (
                <>
                  <input className="caddie-input" inputMode="numeric" placeholder="12" aria-label="Weight, stone" value={st} onChange={(e) => setSt(e.target.value)} />
                  <input className="caddie-input" inputMode="numeric" placeholder="13" aria-label="Weight, pounds" value={lb} onChange={(e) => setLb(e.target.value)} />
                </>
              )}
              <UnitToggle
                label="Weight unit"
                options={[
                  { value: 'kg', label: 'kg' },
                  { value: 'stlb', label: 'st/lb' },
                ]}
                value={weightUnit}
                onChange={setWeightUnit}
              />
            </div>
          </div>
        ) : null}
      </fieldset>

      <button type="submit" className="caddie-btn caddie-btn--primary caddie-btn--block" disabled={!ready || disabled}>
        Find my size
      </button>
      <p className="caddie-muted caddie-form__alt">You can also just tell me naturally.</p>
    </form>
  );
}

function UnitToggle<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="caddie-units" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`caddie-units__btn${value === option.value ? ' is-selected' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
