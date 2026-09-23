import { useEffect, useRef } from 'react';
import type { Journey, SizeInput } from '@caddie/shared';
import type { ThreadMessage } from '../lib/useCaddie.js';
import { JourneyForm } from './forms/JourneyForm.js';
import { SizeForm } from './forms/SizeForm.js';
import { SparkleIcon } from './icons.js';
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

function Avatar() {
  return (
    <span className="caddie-avatar" aria-hidden="true">
      <SparkleIcon size={14} />
    </span>
  );
}

/** The conversation: words, product cards and quick forms, in the order they happened. */
export function Thread({ messages, busy, busyJourney, garment, onSubmitSize, onSubmitJourney }: ThreadProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const latestCardId = [...messages].reverse().find((m) => m.attachment)?.id;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy]);

  /*
   * A turn with nothing in it yet - a voice transcript holding its place while
   * the clip is still being transcribed - would otherwise leave a gap.
   */
  const visible = messages.filter((m) => m.text || m.attachment || m.local);

  return (
    <div className="caddie-thread" role="log" aria-live="polite" aria-relevant="additions">
      {visible.map((message) => (
        <div key={message.id} className={`caddie-turn caddie-turn--${message.role}`}>
          {message.text ? (
            <div className="caddie-turn__line">
              {message.role === 'assistant' ? <Avatar /> : null}
              <p className={`caddie-bubble caddie-bubble--${message.role}`}>{message.text}</p>
            </div>
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
