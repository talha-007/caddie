import { useEffect, useRef } from 'react';
import type { Journey, SizeInput } from '@caddie/shared';
import type { ThreadMessage } from '../lib/useCaddie.js';
import { JourneyForm } from './forms/JourneyForm.js';
import { SizeForm } from './forms/SizeForm.js';
import { AddedPanel } from './panels/BasketPanel.js';
import { ResultPanel } from './panels/ResultPanel.js';
import { Thinking } from './Thinking.js';

interface ThreadProps {
  messages: ThreadMessage[];
  busy: boolean;
  busyJourney: Journey | null;
  /** Used in "What's your usual size in polo shirts?" */
  garment: string;
  onSubmitSize: (formId: string, input: SizeInput, summary: string) => void;
  onSubmitJourney: (formId: string, text: string) => void;
}

/**
 * The conversation as live captions rather than a chat log: words, product
 * cards and quick forms in the order they happened, with only the latest
 * exchange held at full strength. Everything said before it stays on screen,
 * quietened, so the thread reads like subtitles and not like messaging.
 */
export function Thread({ messages, busy, busyJourney, garment, onSubmitSize, onSubmitJourney }: ThreadProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const latestCardId = [...messages].reverse().find((m) => m.attachment)?.id;

  /*
   * A turn with nothing in it yet - a voice transcript holding its place while
   * the clip is still being transcribed - would otherwise leave a gap.
   */
  const visible = messages.filter((m) => m.text || m.attachment || m.local);

  // The newest question and the answer to it: the only two lines shown in full.
  const spoken = visible.filter((m) => m.text);
  const current = new Set(spoken.slice(-2).map((m) => m.id));

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy]);

  return (
    <div className="caddie-thread" role="log" aria-live="polite" aria-relevant="additions">
      {visible.map((message) => (
        <div key={message.id} className={`caddie-turn caddie-turn--${message.role}`}>
          {message.text ? (
            <p className={`caddie-caption caddie-caption--${message.role}${current.has(message.id) ? '' : ' is-past'}`}>
              {message.role === 'user' ? <span className="caddie-caption__who">You</span> : null}
              {message.text}
            </p>
          ) : null}

          {message.attachment ? (
            <div className="caddie-turn__card">
              <ResultPanel attachment={message.attachment} latest={message.id === latestCardId} />
            </div>
          ) : null}

          {message.local?.kind === 'size-form' && !message.local.done ? (
            <div className="caddie-turn__card">
              <SizeForm garment={garment} disabled={busy} onSubmit={(input, summary) => onSubmitSize(message.id, input, summary)} />
            </div>
          ) : null}

          {message.local?.kind === 'journey-form' && !message.local.done ? (
            <div className="caddie-turn__card">
              <JourneyForm
                journey={message.local.journey}
                disabled={busy}
                onSubmit={(text) => onSubmitJourney(message.id, text)}
              />
            </div>
          ) : null}

          {message.local?.kind === 'added' ? (
            <div className="caddie-turn__card">
              <AddedPanel count={message.local.count} cart={message.local.cart} />
            </div>
          ) : null}
        </div>
      ))}

      {busy ? (
        <div className="caddie-turn caddie-turn--assistant">
          <Thinking journey={busyJourney} />
        </div>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
