import type { VoiceState } from '../lib/useVapi.js';

const LABELS: Record<VoiceState['status'], string> = {
  idle: 'Talk to the Caddie',
  connecting: 'Connecting...',
  listening: 'Listening',
  speaking: 'Caddie is talking',
  error: 'Tap to try again',
};

export function VoiceButton({ voice }: { voice: VoiceState }) {
  if (!voice.supported) {
    return (
      <p className="caddie-muted caddie-voice__disabled">
        Voice is off - add VITE_VAPI_PUBLIC_KEY and VITE_VAPI_ASSISTANT_ID to .env
      </p>
    );
  }

  const active = voice.status === 'listening' || voice.status === 'speaking';

  return (
    <div className="caddie-voice">
      <button
        type="button"
        className={`caddie-mic caddie-mic--${voice.status}`}
        onClick={() => (active ? voice.stop() : voice.start())}
        aria-pressed={active}
        aria-label={LABELS[voice.status]}
      >
        <span
          className="caddie-mic__pulse"
          // The ring tracks mic level so the customer can see they are being heard.
          style={{ transform: `scale(${1 + Math.min(voice.volume, 1) * 0.6})` }}
        />
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12Z"
          />
        </svg>
      </button>
      <span className="caddie-voice__label">{LABELS[voice.status]}</span>
      {voice.error ? <span className="caddie-error">{voice.error}</span> : null}
    </div>
  );
}
