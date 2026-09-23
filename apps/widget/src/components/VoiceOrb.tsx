import { useRef, type CSSProperties } from 'react';
import type { VoiceState } from '../lib/useVoice.js';
import { CloseIcon, MicIcon, StopIcon } from './icons.js';

/**
 * The voice orb: speaking is the primary interaction, so the mic is the
 * centrepiece of the panel rather than a button beside a text box.
 *
 * Push to talk is unchanged - hold the orb and speak, or tap once and tap
 * again to send. Only the presentation is new.
 *
 * Four states, and every one of them is something `useVoice` really reports:
 *
 *   idle       the bloom breathes
 *   listening  rings ripple and the core swells with the live mic level
 *   thinking   a conic shimmer turns while the clip uploads or the model works
 *   error      desaturated, with a calm retry line
 *
 * There is deliberately no "speaking" state: this Caddie answers in text, so
 * nothing reports output volume to animate against.
 */

export type OrbState = 'idle' | 'listening' | 'thinking' | 'error';

export function orbState(voice: VoiceState, busy: boolean): OrbState {
  if (!voice.supported || voice.status === 'error') return 'error';
  if (voice.status === 'recording' || voice.status === 'starting') return 'listening';
  if (voice.status === 'sending' || busy) return 'thinking';
  return 'idle';
}

const STATUS: Record<OrbState, string> = {
  idle: 'Tap to talk',
  // Says how to finish, now that no Send button does.
  listening: 'Listening… tap to send',
  thinking: 'Thinking…',
  error: 'Tap to try again',
};

const UNSUPPORTED = 'Voice needs a newer browser';

/** A tap is a toggle; anything longer is hold-to-talk and sends on release. */
const HOLD_MS = 600;

/** Spoken label for the orb, which is now the only way to send a clip. */
function orbHint(label: string, recording: boolean): string {
  return recording ? `${label}. Tap to send, or hold and release.` : `${label}. Hold to talk, or tap to start.`;
}

/** The press behaviour every orb shares - identical to the old mic button. */
function usePress(voice: VoiceState) {
  const pressedAt = useRef(0);
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

  const onKeyDown = (event: { key: string; preventDefault: () => void }) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (recording) voice.stop();
    else void voice.start();
  };

  return { recording, down, up, onKeyDown };
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Discard and the running clock, offered only while a clip is actually being
 * recorded.
 *
 * There is deliberately no Send button. Sending is the orb's job, WhatsApp
 * style: release a hold, or tap the orb a second time. A separate Send gave
 * the same action two controls, and the one people reached for was the orb.
 */
function Takes({ voice }: { voice: VoiceState }) {
  if (voice.status !== 'recording') return null;
  return (
    <div className="caddie-voice__takes">
      <button
        type="button"
        className="caddie-icon-btn caddie-icon-btn--small"
        onClick={voice.cancel}
        aria-label="Discard this recording"
      >
        <CloseIcon size={18} />
      </button>
      <span className="caddie-voice__time">{clock(voice.seconds)}</span>
    </div>
  );
}

/** The one place a microphone failure is explained, wherever the orb is. */
function VoiceError({ voice }: { voice: VoiceState }) {
  if (!voice.error) return null;
  return (
    <p className="caddie-notice caddie-notice--error" role="alert">
      <span>{voice.error}</span>
      <button type="button" className="caddie-link" onClick={voice.clearError}>
        Dismiss
      </button>
    </p>
  );
}

interface OrbProps {
  voice: VoiceState;
  /** The Caddie is working on the last thing said: the orb shimmers. */
  busy: boolean;
}

/** The hero: the middle of the home screen, and the whole point of the widget. */
export function VoiceOrb({ voice, busy }: OrbProps) {
  const { recording, down, up, onKeyDown } = usePress(voice);
  const state = orbState(voice, busy);
  // Only the live microphone drives the core; everything else rests at zero.
  const level = state === 'listening' ? Math.min(Math.max(voice.level, 0), 1) : 0;
  const label = voice.supported ? STATUS[state] : UNSUPPORTED;

  return (
    <div className="caddie-voice">
      <button
        type="button"
        className={`caddie-voiceorb caddie-voiceorb--${state}`}
        style={{ '--caddie-level': level } as CSSProperties}
        onPointerDown={down}
        onPointerUp={up}
        onPointerLeave={up}
        onPointerCancel={() => voice.cancel()}
        onKeyDown={onKeyDown}
        disabled={!voice.supported || voice.status === 'sending'}
        aria-pressed={recording}
        aria-label={voice.supported ? orbHint(label, recording) : UNSUPPORTED}
      >
        <span className="caddie-voiceorb__bloom" aria-hidden="true" />
        <span className="caddie-voiceorb__ring" aria-hidden="true" />
        <span className="caddie-voiceorb__ring caddie-voiceorb__ring--late" aria-hidden="true" />
        <span className="caddie-voiceorb__core" aria-hidden="true">
          <span className="caddie-voiceorb__shimmer" />
        </span>
        <span className="caddie-voiceorb__glyph">{recording ? <StopIcon size={28} /> : <MicIcon size={32} />}</span>
      </button>

      <p className="caddie-voice__status" role="status" aria-live="polite">
        {label}
      </p>
      <Wave level={level} />
      {voice.supported && voice.status !== 'recording' ? (
        <p className="caddie-voice__hint">You can also just tell me naturally…</p>
      ) : null}
      <Takes voice={voice} />
      <VoiceError voice={voice} />
    </div>
  );
}

/**
 * The waveform from the concept: one flowing line across the panel, not a row
 * of bars. Its amplitude follows the microphone, so a quiet room draws an
 * almost flat line and a spoken sentence makes it swell.
 */
export function Wave({ level }: { level: number }) {
  const value = Math.min(Math.max(level, 0), 1);
  // A resting ripple, so the line still reads as alive between words.
  const amplitude = 1.5 + value * 12;
  const crest = 20 - amplitude;
  // Q sets the first arc; every T mirrors it, which gives a true sine.
  const path = `M0 20 Q 15 ${crest} 30 20 T 60 20 T 90 20 T 120 20 T 150 20 T 180 20 T 210 20 T 240 20`;

  return (
    <span className="caddie-wave" aria-hidden="true">
      <svg viewBox="0 0 240 40" preserveAspectRatio="none" focusable="false">
        {/* A soft echo under the line gives it the depth the concept has. */}
        <path className="caddie-wave__echo" d={path} />
        <path className="caddie-wave__line" d={path} />
      </svg>
    </span>
  );
}

/**
 * The same orb, shrunk to a pill, so the customer can keep talking while a
 * size, pack, outfit or basket panel fills the screen.
 */
export function VoiceDock({ voice, busy }: OrbProps) {
  const { recording, down, up, onKeyDown } = usePress(voice);
  const state = orbState(voice, busy);
  const level = state === 'listening' ? Math.min(Math.max(voice.level, 0), 1) : 0;
  const label = voice.supported ? STATUS[state] : UNSUPPORTED;

  return (
    <div className="caddie-dock">
      <VoiceError voice={voice} />
      {/*
       * The label sits OUTSIDE the bar. Inside it, the pill's glass surface
       * read as part of the button, so "Tap to talk" looked like a caption
       * printed on the control rather than a status line above it.
       */}
      <div className="caddie-dock__text">
        <span className="caddie-dock__status" role="status" aria-live="polite">
          {label}
        </span>
        {recording ? <Wave level={level} /> : null}
      </div>

      <div className="caddie-dock__bar">
        <button
          type="button"
          className={`caddie-voiceorb caddie-voiceorb--pill caddie-voiceorb--${state}`}
          style={{ '--caddie-level': level } as CSSProperties}
          onPointerDown={down}
          onPointerUp={up}
          onPointerLeave={up}
          onPointerCancel={() => voice.cancel()}
          onKeyDown={onKeyDown}
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

        <Takes voice={voice} />
      </div>
    </div>
  );
}
