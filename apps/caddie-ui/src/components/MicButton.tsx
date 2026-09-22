import { useCallback, useRef } from 'react';
import type { Recorder } from '../lib/useRecorder.js';

/**
 * Push to talk.
 *
 * Held, not toggled: the customer can see exactly when we are listening, and
 * letting go is the obvious way to stop. Pointer events rather than
 * mouse/touch pairs, so a stylus and a finger behave the same.
 */

interface MicButtonProps {
  recorder: Recorder;
  disabled?: boolean;
  onRecorded: (audio: Blob) => void;
}

export function MicButton({ recorder, disabled, onRecorded }: MicButtonProps) {
  const holding = useRef(false);

  const begin = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled || holding.current) return;
      holding.current = true;
      // Keep receiving events if the finger slides off the button.
      event.currentTarget.setPointerCapture(event.pointerId);
      void recorder.start();
    },
    [disabled, recorder],
  );

  const end = useCallback(async () => {
    if (!holding.current) return;
    holding.current = false;
    const audio = await recorder.stop();
    if (audio) onRecorded(audio);
  }, [onRecorded, recorder]);

  if (recorder.state === 'unsupported') {
    return <p className="muted mic__note">Voice needs a browser with microphone recording.</p>;
  }

  const recording = recorder.state === 'recording';
  const label = recording ? 'Listening - let go to send' : 'Hold to talk';

  return (
    <div className="mic">
      <button
        type="button"
        className={`mic__button${recording ? ' mic__button--live' : ''}`}
        disabled={disabled}
        aria-label={label}
        aria-pressed={recording}
        onPointerDown={begin}
        onPointerUp={end}
        onPointerCancel={end}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span
          className="mic__ring"
          // Tracks the mic level, so it is obvious we can hear them.
          style={{ transform: `scale(${1 + Math.min(recorder.level, 1) * 0.8})` }}
        />
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12Z"
          />
        </svg>
      </button>
      <span className="mic__label">{recorder.error ?? label}</span>
    </div>
  );
}
