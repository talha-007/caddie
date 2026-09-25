import { useState, type ReactNode } from 'react';
import type { Journey, ShopperSizes } from '@caddie/shared';
import type { VoiceState } from '../lib/useVoice.js';
import { HangerIcon, RulerIcon, ShirtIcon, SparkleIcon, TagIcon } from './icons.js';
import { QuickStart, describeSizes } from './QuickStart.js';
import { SuggestionChips } from './SuggestionChips.js';
import { VoiceOrb } from './VoiceOrb.js';

/**
 * The welcome screen, built around the voice orb: speak first, tap a journey
 * if you would rather not. On a product page, sizing leads with that product.
 */

const JOURNEYS: Array<{ journey: Journey; title: string; blurb: string; icon: ReactNode }> = [
  // Find My Size is parked for now - uncomment to bring the card back.
  // { journey: 'size', title: 'Find My Size', blurb: 'A few quick questions, one confident size.', icon: <RulerIcon /> },
  { journey: 'pack', title: 'Choose My Ambassador Pack', blurb: 'The right pack for how and where you play.', icon: <TagIcon /> },
  { journey: 'outfit', title: 'Build My Outfit', blurb: 'A complete look, inside your budget.', icon: <HangerIcon /> },
];

interface HomeProps {
  productTitle: string | undefined;
  voice: VoiceState;
  busy: boolean;
  onJourney: (journey: Journey) => void;
  onAsk: (text: string) => void;
  /** Who they shop for and their sizes, once given. */
  sizes: ShopperSizes | null;
  onProfile: (profile: ShopperSizes) => void;
}

export function Home({ productTitle, voice, busy, onJourney, onAsk, sizes, onProfile }: HomeProps) {
  // Changing who they shop for or their size, after it was given.
  const [editing, setEditing] = useState(false);
  return (
    <div className="caddie-home">
      <div className="caddie-home__hero">
        <VoiceOrb voice={voice} busy={busy} />
        <h2 className="caddie-home__title">How can I help you today?</h2>
        <ul className="caddie-marks">
          <li>
            <HangerIcon size={15} /> Expert styling
          </li>
          <li aria-hidden="true" className="caddie-marks__dot" />
          <li>
            <ShirtIcon size={15} /> Real products
          </li>
          <li aria-hidden="true" className="caddie-marks__dot" />
          <li>
            <SparkleIcon size={15} /> Built for golfers
          </li>
        </ul>
      </div>

      {/* Who and what size first: then the first thing shown is their range, in their size. */}
      {sizes?.range && !editing ? (
        <div className="caddie-profile-line">
          <span>Shopping for {describeSizes(sizes)}</span>
          <button type="button" className="caddie-link" disabled={busy} onClick={() => setEditing(true)}>
            Change
          </button>
        </div>
      ) : (
        <QuickStart
          initial={sizes}
          busy={busy}
          {...(sizes?.range ? { onCancel: () => setEditing(false) } : {})}
          onDone={(profile) => {
            setEditing(false);
            onProfile(profile);
          }}
        />
      )}

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

      <SuggestionChips last={null} disabled={busy} onPick={onAsk} />
    </div>
  );
}
