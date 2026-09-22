import { useState, type ReactNode } from 'react';
import { CloudIcon, FlagIcon, HangerIcon, PlaneIcon, SunIcon, WeatherMixIcon } from '../icons.js';
import { ChipGroup } from './ChipGroup.js';

/**
 * The quick start for Ambassador Pack and Build Outfit. Unlike sizing these
 * go to the Caddie as a sentence, so the AI keeps the whole request in its
 * memory and "cheaper" or "in navy" afterwards just works.
 */

interface Choice {
  value: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  /** How this choice reads inside the sentence we send. */
  phrase: string;
}

interface JourneyConfig {
  ask: string;
  choices: Choice[];
  budgets: number[];
  counts?: number[];
  submit: string;
  sentence: (choice: Choice, budget: number | null, count: number | null) => string;
}

const CONFIG: Record<'pack' | 'outfit', JourneyConfig> = {
  pack: {
    ask: 'What conditions do you usually play in?',
    choices: [
      { value: 'mixed', label: 'Mixed conditions', hint: 'All-round play', icon: <WeatherMixIcon />, phrase: 'mixed conditions' },
      { value: 'hot', label: 'Hot weather', icon: <SunIcon />, phrase: 'hot weather' },
      { value: 'cool', label: 'Cooler weather', icon: <CloudIcon />, phrase: 'cooler weather' },
    ],
    budgets: [60, 100, 150],
    counts: [3, 4, 6],
    submit: 'Find my pack',
    sentence: (choice, budget, count) =>
      [
        `Help me choose an Ambassador Pack${count ? ` of ${count} pieces` : ''} for ${choice.phrase}`,
        budget ? `under £${budget}` : '',
      ]
        .filter(Boolean)
        .join(' '),
  },
  outfit: {
    ask: "What's the outfit for?",
    choices: [
      { value: 'club', label: 'Match day at my club', icon: <FlagIcon />, phrase: 'match day at my club' },
      { value: 'trip', label: 'A golf trip somewhere warm', icon: <PlaneIcon />, phrase: 'a golf trip somewhere warm' },
      { value: 'winter', label: 'Winter rounds', icon: <CloudIcon />, phrase: 'cold winter rounds' },
      { value: 'everyday', label: 'Everyday rounds', icon: <HangerIcon />, phrase: 'everyday rounds' },
    ],
    budgets: [100, 150, 200],
    submit: 'Build my outfit',
    sentence: (choice, budget) => `Build me an outfit for ${choice.phrase}${budget ? ` under £${budget}` : ''}`,
  },
};

interface JourneyFormProps {
  journey: 'pack' | 'outfit';
  disabled: boolean;
  onSubmit: (text: string) => void;
}

export function JourneyForm({ journey, disabled, onSubmit }: JourneyFormProps) {
  const config = CONFIG[journey];
  const [choice, setChoice] = useState<string | null>(null);
  const [budget, setBudget] = useState<string | null>(null);
  const [count, setCount] = useState<string | null>(null);
  const picked = config.choices.find((c) => c.value === choice);

  return (
    <form
      className="caddie-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!picked || disabled) return;
        onSubmit(config.sentence(picked, budget ? Number(budget) : null, count ? Number(count) : null));
      }}
    >
      <fieldset className="caddie-form__q">
        <legend className="caddie-form__ask">{config.ask}</legend>
        <ChipGroup
          variant="cards"
          options={config.choices.map(({ value, label, hint, icon }) => ({ value, label, icon, ...(hint ? { hint } : {}) }))}
          value={choice}
          onChange={setChoice}
        />
      </fieldset>

      {config.counts ? (
        <fieldset className="caddie-form__q">
          <legend className="caddie-form__ask">How many pieces?</legend>
          <ChipGroup
            options={config.counts.map((n) => ({ value: String(n), label: String(n) }))}
            value={count}
            onChange={setCount}
          />
        </fieldset>
      ) : null}

      <fieldset className="caddie-form__q">
        <legend className="caddie-form__ask">Any budget in mind?</legend>
        <ChipGroup
          options={config.budgets.map((n) => ({ value: String(n), label: `Under £${n}` }))}
          value={budget}
          onChange={setBudget}
        />
      </fieldset>

      <button type="submit" className="caddie-btn caddie-btn--primary caddie-btn--block" disabled={!picked || disabled}>
        {config.submit}
      </button>
      <p className="caddie-muted caddie-form__alt">Or just tell me what you're after.</p>
    </form>
  );
}
