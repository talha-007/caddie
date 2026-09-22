import { useRef } from 'react';
import type { VoiceState } from '../lib/useVoice.js';
import { CloseIcon, MicIcon, StopIcon } from './icons.js';

/**
 * Push to talk: hold the mic and speak, or tap it once and tap again to send.
 * Hidden entirely where recording is impossible (an old browser, or a page
 * served over plain http) rather than showing a broken button.
 */

const LABELS: Record<VoiceState['status'], string> = {
  idle: 'Hold to talk, or tap to start',
  starting: 'Turning the microphone on…',
  recording: 'Listening… tap to send',
  sending: 'Transcribing…',
  error: 'Tap to try again',
};

/** A tap is a toggle; anything longer is hold-to-talk and sends on release. */
const HOLD_MS = 600;

export function VoiceButton({ voice, large }: { voice: VoiceState; large?: boolean }) {
  const pressedAt = useRef(0);
  if (!voice.supported) return null;

  const recording = voice.status === 'recording' || voice.status === 'starting';

  const down = () => {
    if (voice.status === 'sending') return;
    if (recording) return;
    pressedAt.current = Date.now();
    void voice.start();
  };

  const up = () => {
    if (!recording) return;
    if (Date.now() - pressedAt.current < HOLD_MS) return; // tapped: stay recording
    voice.stop();
  };

  return (
    <button
      type="button"
      className={`caddie-mic caddie-mic--${voice.status}${large ? ' caddie-mic--large' : ''}`}
      onPointerDown={down}
      onPointerUp={up}
      onPointerLeave={up}
      onPointerCancel={() => voice.cancel()}
      onKeyDown={(event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        if (recording) voice.stop();
        else void voice.start();
      }}
      disabled={voice.status === 'sending'}
      aria-pressed={recording}
      aria-label={LABELS[voice.status]}
    >
      <span
        className="caddie-mic__pulse"
        // The ring tracks the microphone so the customer can see they are heard.
        style={{ transform: `scale(${1 + (recording ? Math.min(voice.level, 1) * 0.6 : 0)})` }}
        aria-hidden="true"
      />
      {/* A stop square, not an arrow - the composer next to it already has one. */}
      {recording && !large ? <StopIcon size={18} /> : <MicIcon size={large ? 30 : 22} />}
    </button>
  );
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The strip above the composer while recording, transcribing, or after a failure. */
export function VoiceBar({ voice }: { voice: VoiceState }) {
  if (!voice.supported) return null;
  if (!voice.active && !voice.error) return null;

  if (voice.error) {
    return (
      <p className="caddie-notice caddie-notice--error" role="alert">
        <span>{voice.error}</span>
        <button type="button" className="caddie-link" onClick={voice.clearError}>
          Dismiss
        </button>
      </p>
    );
  }

  const recording = voice.status === 'recording';

  return (
    <div className="caddie-voicebar" role="status" aria-live="polite">
      <Wave level={recording ? voice.level : 0} />
      <div className="caddie-voicebar__text">
        <span className="caddie-voicebar__label">
          {voice.status === 'sending' ? 'Transcribing…' : voice.status === 'starting' ? 'One moment…' : 'Listening…'}
        </span>
        {recording ? <span className="caddie-voicebar__time">{clock(voice.seconds)}</span> : null}
      </div>
      {recording ? (
        <div className="caddie-voicebar__actions">
          <button type="button" className="caddie-icon-btn caddie-icon-btn--small" onClick={voice.cancel} aria-label="Discard this recording">
            <CloseIcon size={18} />
          </button>
          <button type="button" className="caddie-btn caddie-btn--primary caddie-btn--small" onClick={voice.stop}>
            Send
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Five bars that follow the microphone; still when nobody is talking. */
export function Wave({ level }: { level: number }) {
  const value = Math.min(Math.max(level, 0), 1);
  return (
    <span className="caddie-wave" aria-hidden="true">
      {[0.5, 0.8, 1, 0.8, 0.5].map((weight, index) => (
        <span key={index} style={{ transform: `scaleY(${0.25 + value * weight * 0.75})` }} />
      ))}
    </span>
  );
}
