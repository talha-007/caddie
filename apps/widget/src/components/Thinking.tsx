import { useEffect, useState } from 'react';
import type { Journey } from '@caddie/shared';
import { CheckIcon } from './icons.js';

/**
 * The "Finding your perfect pack..." card from the concept. The steps
 * describe what the server really does for that journey; they tick along on a
 * timer because the server does not report progress, and the last one stays
 * open until the answer arrives.
 */
const STEPS: Record<Journey | 'default', { title: string; steps: string[] }> = {
  size: {
    title: 'Finding your perfect fit…',
    steps: ['Reading your answers', 'Checking the Druids size guide', 'Working out your best size'],
  },
  pack: {
    title: 'Finding your perfect pack…',
    steps: ['Searching the Ambassador range', 'Matching your conditions', 'Checking prices and live stock', 'Finalising your pack'],
  },
  outfit: {
    title: 'Finding the perfect pieces…',
    steps: ['Understanding the occasion', 'Matching colours and styles', 'Checking prices and live stock', 'Building your look'],
  },
  default: {
    title: 'On it…',
    steps: ['Understanding your request', 'Searching the Druids store', 'Checking live stock'],
  },
};

const STEP_MS = 1100;

export function Thinking({ journey }: { journey: Journey | null }) {
  const { title, steps } = STEPS[journey ?? 'default'];
  const [done, setDone] = useState(0);

  useEffect(() => {
    setDone(0);
    const timer = setInterval(() => setDone((n) => Math.min(n + 1, steps.length - 1)), STEP_MS);
    return () => clearInterval(timer);
  }, [steps.length, journey]);

  return (
    <div className="caddie-thinking" role="status" aria-live="polite">
      <span className="caddie-thinking__ring" aria-hidden="true" />
      <div>
        <p className="caddie-thinking__title">{title}</p>
        <ul className="caddie-thinking__steps">
          {steps.map((step, index) => (
            <li key={step} className={index < done ? 'is-done' : index === done ? 'is-active' : ''}>
              <span className="caddie-thinking__tick" aria-hidden="true">
                {index < done ? <CheckIcon size={12} /> : null}
              </span>
              {step}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
