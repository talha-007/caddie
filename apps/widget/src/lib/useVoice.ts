import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Push to talk.
 *
 * The customer records a clip in the browser and we post the audio to
 * POST /api/voice, which transcribes it and answers in the same round trip.
 * There is no live transcript on the way up - what they said appears as their
 * own message once the server has heard it.
 */

export type VoiceStatus = 'idle' | 'starting' | 'recording' | 'sending' | 'error';

export interface VoiceState {
  status: VoiceStatus;
  /** 0-1 microphone level, for the waveform. */
  level: number;
  /** How long the current clip is, in seconds. */
  seconds: number;
  error: string | null;
  supported: boolean;
  /** Recording or uploading - the composer dims while this is true. */
  active: boolean;
  start: () => Promise<void>;
  /** Stop and send. */
  stop: () => void;
  /** Stop and throw the clip away. */
  cancel: () => void;
  clearError: () => void;
}

/** Long enough that a mis-tap does not cost a round trip. */
const MIN_CLIP_MS = 700;
/** The Caddie is not a dictaphone; stop before the upload gets silly. */
const MAX_CLIP_MS = 30_000;

/** The first format this browser can record: Chrome and Android give webm, iOS Safari mp4. */
function pickMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type));
}

function describe(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'I need permission to use your microphone. Allow it in your browser, then tap again.';
  }
  if (name === 'NotFoundError') return 'No microphone found on this device.';
  if (name === 'NotReadableError') return 'Your microphone is busy in another app.';
  return err instanceof Error ? err.message : 'The recording failed.';
}

export function useVoice(onClip: (clip: Blob) => Promise<void>): VoiceState {
  // getUserMedia only exists on https (and localhost), which the storefront is.
  const supported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia);

  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const frame = useRef(0);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef(0);
  const cancelled = useRef(false);
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;

  const teardown = useCallback(() => {
    cancelAnimationFrame(frame.current);
    if (ticker.current) clearInterval(ticker.current);
    if (limit.current) clearTimeout(limit.current);
    ticker.current = null;
    limit.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void audio.current?.close().catch(() => undefined);
    audio.current = null;
    recorder.current = null;
    setLevel(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  /** Drives the waveform. Sampled a few times a second, not every frame. */
  const meter = useCallback((source: MediaStream) => {
    try {
      const context = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      audio.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(source).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let last = 0;

      const read = (now: number) => {
        frame.current = requestAnimationFrame(read);
        if (now - last < 70) return;
        last = now;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) sum += (value - 128) ** 2;
        // RMS, lifted a little so normal speech fills the bars.
        setLevel(Math.min(1, Math.sqrt(sum / data.length) / 40));
      };
      frame.current = requestAnimationFrame(read);
    } catch {
      // No meter is survivable; the recording itself still works.
    }
  }, []);

  const finish = useCallback(
    async (parts: BlobPart[], type: string) => {
      const clip = new Blob(parts, { type });
      const tooShort = Date.now() - startedAt.current < MIN_CLIP_MS || clip.size < 1024;
      if (tooShort) {
        setStatus('error');
        setError('That was too short. Hold the mic while you speak.');
        return;
      }
      setStatus('sending');
      try {
        await onClipRef.current(clip);
        setStatus('idle');
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : 'I could not send that clip.');
      }
    },
    [],
  );

  const start = useCallback(async () => {
    if (!supported || recorder.current) return;
    setError(null);
    setStatus('starting');
    cancelled.current = false;

    try {
      const source = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      stream.current = source;

      const mimeType = pickMimeType();
      const instance = new MediaRecorder(source, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      instance.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      instance.onstop = () => {
        const parts = chunks.current;
        const type = instance.mimeType || mimeType || 'audio/webm';
        chunks.current = [];
        teardown();
        if (cancelled.current) {
          setStatus('idle');
          return;
        }
        void finish(parts, type);
      };

      recorder.current = instance;
      startedAt.current = Date.now();
      instance.start(200);
      setStatus('recording');
      setSeconds(0);
      meter(source);

      ticker.current = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 250);
      limit.current = setTimeout(() => recorder.current?.stop(), MAX_CLIP_MS);
    } catch (err) {
      teardown();
      setStatus('error');
      setError(describe(err));
    }
  }, [finish, meter, supported, teardown]);

  const stop = useCallback(() => {
    if (!recorder.current) return;
    cancelled.current = false;
    recorder.current.stop();
  }, []);

  const cancel = useCallback(() => {
    if (!recorder.current) return;
    cancelled.current = true;
    recorder.current.stop();
  }, []);

  return {
    status,
    level,
    seconds,
    error,
    supported,
    active: status === 'starting' || status === 'recording' || status === 'sending',
    start,
    stop,
    cancel,
    clearError: useCallback(() => {
      setError(null);
      setStatus('idle');
    }, []),
  };
}
