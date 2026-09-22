import type { ReactNode } from 'react';
import type { Journey } from '@caddie/shared';
import type { VoiceState } from '../lib/useVapi.js';
import { HangerIcon, RulerIcon, ShirtIcon, SparkleIcon, TagIcon } from './icons.js';
import { SuggestionChips } from './SuggestionChips.js';
import { VoiceButton, Wave } from './VoiceButton.js';

/**
 * The welcome screen: the three journeys from the proposal, a big mic, and
 * the example questions. On a product page, sizing leads with that product.
 */

const JOURNEYS: Array<{ journey: Journey; title: string; blurb: string; icon: ReactNode }> = [
  { journey: 'size', title: 'Find My Size', blurb: 'A few quick questions, one confident size.', icon: <RulerIcon /> },
  { journey: 'pack', title: 'Choose My Ambassador Pack', blurb: 'The right pack for how and where you play.', icon: <TagIcon /> },
  { journey: 'outfit', title: 'Build My Outfit', blurb: 'A complete look, inside your budget.', icon: <HangerIcon /> },
];

interface HomeProps {
  productTitle: string | undefined;
  voice: VoiceState;
  busy: boolean;
  onJourney: (journey: Journey) => void;
  onAsk: (text: string) => void;
}

export function Home({ productTitle, voice, busy, onJourney, onAsk }: HomeProps) {
  return (
    <div className="caddie-home">
      <div className="caddie-home__hero">
        {voice.supported ? (
          <>
            <VoiceButton voice={voice} large />
            <Wave volume={voice.active ? voice.volume : 0} />
            <p className="caddie-home__voice-label">{voice.active ? 'Listening…' : 'Tap to talk to your Caddie'}</p>
          </>
        ) : (
          <span className="caddie-orb caddie-orb--hero" aria-hidden="true">
            <SparkleIcon size={30} />
          </span>
        )}
        <h2 className="caddie-home__title">How can I help you today?</h2>
        <ul className="caddie-features">
          <li>
            <HangerIcon size={18} /> Expert styling
          </li>
          <li>
            <ShirtIcon size={18} /> Real products
          </li>
          <li>
            <SparkleIcon size={18} /> Built for golfers
          </li>
        </ul>
      </div>

      <div className="caddie-journeys">
        {JOURNEYS.map(({ journey, title, blurb, icon }) => (
          <button key={journey} type="button" className="caddie-journey" disabled={busy} onClick={() => onJourney(journey)}>
            <span className="caddie-journey__icon" aria-hidden="true">
              {icon}
            </span>
            <span className="caddie-journey__text">
              <strong>{journey === 'size' && productTitle ? `Find my size in ${productTitle}` : title}</strong>
              <small>{blurb}</small>
            </span>
          </button>
        ))}
      </div>

      <div className="caddie-home__ask">
        <p className="caddie-eyebrow">Or just ask</p>
        <SuggestionChips last={null} disabled={busy} onPick={onAsk} />
      </div>
    </div>
  );
}
