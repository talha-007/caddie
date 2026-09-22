import type { VoiceState } from '../lib/useVapi.js';
import { MicIcon, StopIcon } from './icons.js';

const LABELS: Record<VoiceState['status'], string> = {
  idle: 'Talk to your Caddie',
  connecting: 'Connecting…',
  listening: 'Listening…',
  speaking: 'Caddie is talking',
  error: 'Tap to try again',
};

/**
 * The mic. Hidden entirely when voice is not configured - a customer should
 * never see a setup message - and the dev console says why instead.
 */
export function VoiceButton({ voice, large }: { voice: VoiceState; large?: boolean }) {
  if (!voice.supported) return null;

  const live = voice.status === 'listening' || voice.status === 'speaking';

  return (
    <button
      type="button"
      className={`caddie-mic caddie-mic--${voice.status}${large ? ' caddie-mic--large' : ''}`}
      onClick={() => (voice.active ? voice.stop() : voice.start())}
      aria-pressed={voice.active}
      aria-label={voice.active ? 'End voice chat' : LABELS[voice.status]}
    >
      <span
        className="caddie-mic__pulse"
        // The ring tracks mic level so the customer can see they are being heard.
        style={{ transform: `scale(${1 + (live ? Math.min(voice.volume, 1) * 0.6 : 0)})` }}
        aria-hidden="true"
      />
      {voice.active && !large ? <StopIcon size={20} /> : <MicIcon size={large ? 30 : 22} />}
    </button>
  );
}

/** The listening strip above the composer while a call is live. */
export function VoiceBar({ voice }: { voice: VoiceState }) {
  if (!voice.supported || (!voice.active && !voice.error)) return null;

  return (
    <div className={`caddie-voicebar caddie-voicebar--${voice.status}`} role="status" aria-live="polite">
      <Wave volume={voice.status === 'idle' || voice.status === 'error' ? 0 : voice.volume} />
      <div className="caddie-voicebar__text">
        <span className="caddie-voicebar__label">{voice.error ?? LABELS[voice.status]}</span>
        {voice.partial ? <span className="caddie-voicebar__partial">“{voice.partial}”</span> : null}
      </div>
    </div>
  );
}

/** Five bars that follow the voice level; still when nobody is talking. */
export function Wave({ volume }: { volume: number }) {
  const level = Math.min(Math.max(volume, 0), 1);
  return (
    <span className="caddie-wave" aria-hidden="true">
      {[0.5, 0.8, 1, 0.8, 0.5].map((weight, index) => (
        <span key={index} style={{ transform: `scaleY(${0.25 + level * weight * 0.75})` }} />
      ))}
    </span>
  );
}
