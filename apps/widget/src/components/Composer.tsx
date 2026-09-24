import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { VoiceState } from '../lib/useVoice.js';
import { MicIcon, SendIcon, StopIcon } from './icons.js';
import { STATUS, Takes, UNSUPPORTED, VoiceError, Wave, orbHint, orbState, usePress } from './VoiceOrb.js';

/**
 * The composer: typing and talking in one bar, the way a messaging app does it.
 *
 * Empty box -> the right-hand control is the microphone orb, so speaking stays
 * the first-class way in. Type a single character and the same spot becomes
 * Send; clear the box and the microphone comes back. Only one of the two is
 * ever offered, so there is never a question of which button applies.
 *
 * While a clip is recording the text box steps aside for the waveform, the
 * running clock and Discard - the orb itself is still what sends the clip.
 */

interface ComposerProps {
  voice: VoiceState;
  /** The Caddie is working on the last thing said or typed. */
  busy: boolean;
  onSend: (text: string) => void;
  placeholder?: string;
}

/** Three lines and then it scrolls, so the thread never loses the screen. */
const MAX_ROWS = 3;

export function Composer({ voice, busy, onSend, placeholder = 'Ask me anything…' }: ComposerProps) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const { recording, down, up, onKeyDown: orbKeys } = usePress(voice);
  const state = orbState(voice, busy);
  const level = state === 'listening' ? Math.min(Math.max(voice.level, 0), 1) : 0;
  const label = voice.supported ? STATUS[state] : UNSUPPORTED;
  const ready = text.trim().length > 0;

  // Grow with the text, up to MAX_ROWS, then scroll.
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    node.style.height = 'auto';
    const line = parseFloat(getComputedStyle(node).lineHeight) || 20;
    node.style.height = `${Math.min(node.scrollHeight, line * MAX_ROWS + 20)}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setText('');
    onSend(trimmed);
    box.current?.focus();
  };

  // Enter sends, Shift+Enter starts a new line - the messaging-app convention.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className="caddie-composer">
      <VoiceError voice={voice} />

      {/* Only while recording: the status line and live waveform take the row. */}
      {recording ? (
        <div className="caddie-composer__status">
          <span className="caddie-dock__status" role="status" aria-live="polite">
            {label}
          </span>
          <Wave level={level} />
        </div>
      ) : null}

      <div className="caddie-composer__bar">
        {recording ? (
          <Takes voice={voice} />
        ) : (
          <textarea
            ref={box}
            className="caddie-composer__box"
            rows={1}
            value={text}
            placeholder={voice.supported ? placeholder : `${placeholder} (${UNSUPPORTED.toLowerCase()})`}
            aria-label="Type a message to the Caddie"
            disabled={busy && !text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
          />
        )}

        {ready && !recording ? (
          <button
            type="button"
            className="caddie-composer__send"
            onClick={submit}
            disabled={busy}
            aria-label="Send message"
          >
            <SendIcon size={20} />
          </button>
        ) : (
          <button
            type="button"
            className={`caddie-voiceorb caddie-voiceorb--pill caddie-voiceorb--${state}`}
            style={{ '--caddie-level': level } as CSSProperties}
            onPointerDown={down}
            onPointerUp={up}
            onPointerLeave={up}
            onPointerCancel={() => voice.cancel()}
            onKeyDown={orbKeys}
            disabled={!voice.supported || voice.status === 'sending'}
            aria-pressed={recording}
            aria-label={voice.supported ? orbHint(label, recording) : UNSUPPORTED}
          >
            <span className="caddie-voiceorb__bloom" aria-hidden="true" />
            <span className="caddie-voiceorb__ring" aria-hidden="true" />
            <span className="caddie-voiceorb__core" aria-hidden="true">
              <span className="caddie-voiceorb__shimmer" />
            </span>
            <span className="caddie-voiceorb__glyph">{recording ? <StopIcon size={18} /> : <MicIcon size={20} />}</span>
          </button>
        )}
      </div>
    </div>
  );
}
