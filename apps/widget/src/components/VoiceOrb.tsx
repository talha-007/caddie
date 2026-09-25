import { useCallback, useEffect, useRef, type CSSProperties, type PointerEvent } from 'react';
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
  /*
   * Only once the recorder is really running. On a first press the mic takes
   * a moment to open, and showing "Listening" through it told people to talk
   * into nothing - their first words never reached the clip.
   */
  if (voice.status === 'recording') return 'listening';
  if (voice.status === 'starting') return 'thinking';
  if (voice.status === 'sending' || busy) return 'thinking';
  return 'idle';
}

export const STATUS: Record<OrbState, string> = {
  idle: 'Tap to talk',
  // Says how to finish, now that no Send button does.
  listening: 'Listening… tap to send',
  thinking: 'Thinking…',
  error: 'Tap to try again',
};

export const UNSUPPORTED = 'Voice needs a newer browser';

/** The status line. The mic opening is not the Caddie thinking, so it says so. */
export function statusLabel(voice: VoiceState, state: OrbState): string {
  if (!voice.supported) return UNSUPPORTED;
  if (voice.status === 'starting') return 'One moment…';
  return STATUS[state];
}

/** A tap is a toggle; anything longer is hold-to-talk and sends on release. */
const HOLD_MS = 600;

/** Spoken label for the orb, which is now the only way to send a clip. */
export function orbHint(label: string, recording: boolean): string {
  return recording ? `${label}. Tap to send, or hold and release.` : `${label}. Hold to talk, or tap to start.`;
}

/**
 * The press behaviour every orb shares.
 *
 * Two gestures, one control, the way a messaging app does it:
 *
 *   tap        starts recording and leaves it running; the next tap sends
 *   hold       records while held and sends on release
 *
 * The pointer is captured on the way down, so a finger that slides off the orb
 * - or an orb that moves because the panel relaid out the moment recording
 * started - keeps the same gesture. Before capture, that slide fired
 * pointerleave, which the orb read as a release and used to cut the clip off
 * mid-sentence and send it.
 *
 * pointercancel is treated as a release rather than a discard. The browser
 * cancels the pointer for things as ordinary as a scroll, and throwing the
 * clip away there lost recordings people had already finished speaking.
 */
export function usePress(voice: VoiceState) {
  /** The live press: which pointer, when it started, and whether it opened the mic. */
  const press = useRef<{ id: number; at: number; opened: boolean } | null>(null);
  const stopRef = useRef(voice.stop);
  stopRef.current = voice.stop;
  const recording = voice.status === 'recording' || voice.status === 'starting';

  /**
   * The release is watched on the window, not only on the orb. A pointer that
   * has been captured, retargeted or lost to another element still reports its
   * release here, and a press that never hears its release leaves the mic
   * running with no way to end the clip.
   */
  const watch = useRef<((event: globalThis.PointerEvent) => void) | null>(null);

  const settle = useCallback((pointerId: number) => {
    const current = press.current;
    if (!current || current.id !== pointerId) return;
    press.current = null;
    if (watch.current) {
      window.removeEventListener('pointerup', watch.current);
      window.removeEventListener('pointercancel', watch.current);
      watch.current = null;
    }
    if (!current.opened) {
      // A press on a clip that was already running is the tap that sends it.
      stopRef.current();
      return;
    }
    // This press opened the mic: only a real hold sends on release. A tap
    // leaves it listening until they tap again.
    if (Date.now() - current.at >= HOLD_MS) stopRef.current();
  }, []);

  // A press in flight when the panel closes must not outlive its listeners.
  useEffect(
    () => () => {
      if (!watch.current) return;
      window.removeEventListener('pointerup', watch.current);
      window.removeEventListener('pointercancel', watch.current);
      watch.current = null;
    },
    [],
  );

  const down = (event: PointerEvent<HTMLButtonElement>) => {
    if (voice.status === 'sending') return;
    if (press.current) return; // a second finger is not a second gesture
    // Keep every later event for this pointer on the orb, wherever it travels.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is a nicety; the window listener below is the real guarantee.
    }
    press.current = { id: event.pointerId, at: Date.now(), opened: !recording };
    const handler = (e: globalThis.PointerEvent) => settle(e.pointerId);
    watch.current = handler;
    window.addEventListener('pointerup', handler);
    window.addEventListener('pointercancel', handler);
    if (!recording) void voice.start();
  };

  const up = (event: PointerEvent<HTMLButtonElement>) => settle(event.pointerId);

  const onKeyDown = (event: { key: string; repeat?: boolean; preventDefault: () => void }) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (event.repeat) return; // held key: one toggle, not fifty
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
export function Takes({ voice }: { voice: VoiceState }) {
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
export function VoiceError({ voice }: { voice: VoiceState }) {
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

export interface OrbProps {
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
  const label = statusLabel(voice, state);

  return (
    <div className="caddie-voice">
      <button
        type="button"
        className={`caddie-voiceorb caddie-voiceorb--${state}`}
        style={{ '--caddie-level': level } as CSSProperties}
        onPointerDown={down}
        onPointerUp={up}
        onPointerCancel={up}
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
