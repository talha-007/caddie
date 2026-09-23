import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Push to talk.
 *
 * Holds the mic open while the button is held, then hands back one blob. The
 * stream is stopped between recordings rather than kept open, so the browser's
 * recording indicator goes away and the customer can see we are not listening.
 */

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'unsupported';

/** Safari will not take webm; it wants mp4. Pick whatever the browser admits to. */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

export interface Recorder {
  state: RecorderState;
  /** 0-1, for the level ring. */
  level: number;
  error: string | null;
  start: () => Promise<void>;
  /** Resolves with the recording, or null if nothing usable was captured. */
  stop: () => Promise<Blob | null>;
}

export function useRecorder(): Recorder {
  const supported =
    typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';

  const [state, setState] = useState<RecorderState>(supported ? 'idle' : 'unsupported');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);

  const teardown = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  /** Drives the ring around the mic button so the customer sees they are heard. */
  const watchLevel = useCallback((stream: MediaStream) => {
    try {
      const context = new AudioContext();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128);
        setLevel(peak);
        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // Level metering is decoration; recording still works without it.
    }
  }, []);

  const start = useCallback(async () => {
    if (!supported || recorderRef.current) return;
    setError(null);
    setState('requesting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start();
      recorderRef.current = recorder;
      watchLevel(stream);
      setState('recording');
    } catch (err) {
      teardown();
      setState('idle');
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      setError(denied ? 'I need microphone access to listen.' : 'Could not start the microphone.');
    }
  }, [supported, teardown, watchLevel]);

  const stop = useCallback(async (): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    if (!recorder) return null;
    recorderRef.current = null;

    const blob = await new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];
        // A tap rather than a hold produces a handful of bytes and no speech.
        const captured = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        resolve(captured.size > 1000 ? captured : null);
      };
      recorder.stop();
    });

    teardown();
    setState('idle');
    return blob;
  }, [teardown]);

  return { state, level, error, start, stop };
}
