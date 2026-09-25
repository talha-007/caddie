import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Push to talk.
 *
 * The customer records a clip in the browser and we post the audio to
 * POST /api/voice, which transcribes it and answers in the same round trip.
 * There is no live transcript on the way up - what they said appears as their
 * own message once the server has heard it.
 *
 * Almost everything below is here because of a specific failure. Read
 * docs/widget-update-prompt.md section 4 before changing any of it:
 *
 *   - the microphone stays open between turns, because opening it on the press
 *     swallows the first word of every clip
 *   - the metering graph is built once per stream and never closed while the
 *     track is live, because closing it degrades the *next* recording
 *   - the recorder runs on ~200ms past the release, because people let go on
 *     the last word rather than after it
 *   - a clip the microphone never heard is not sent, because a transcription
 *     model given silence invents words and they arrive as the customer's own
 *   - and that silence check fails open, because a dead audio graph reads
 *     exactly like a quiet room
 */

export type VoiceStatus = 'idle' | 'starting' | 'recording' | 'sending' | 'error';

export interface VoiceState {
  status: VoiceStatus;
  /** 0-1 microphone level, for the waveform. */
  level: number;
  /** How long the current clip is, in seconds. */
  seconds: number;
  error: string | null;
  /**
   * A nudge, not a failure: the clip was too short or silent. Nothing is
   * broken, so it is shown quietly and clears itself - a red "could not hear
   * anything (level 0.008)" read as if the microphone had failed.
   */
  hint: string | null;
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
/** The tail of the last word lives here. */
const TAIL_MS = 200;
/**
 * How long the microphone stays open after a turn once the panel is closed.
 * While the panel is open it stays open throughout - see VoiceOptions.warm.
 */
const IDLE_RELEASE_MS = 25_000;
/** Below this peak the microphone heard nothing worth a transcription. */
const SILENCE_PEAK = 0.02;
/** Fewer readings than this is no evidence either way, so we send anyway. */
const MIN_METERED_FRAMES = 5;

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

export interface VoiceOptions {
  /**
   * The Caddie panel is open, so a press is likely: hold the microphone open
   * for as long as it is.
   *
   * Released 25 seconds after each clip, the mic was closed again by the time
   * most customers spoke next - reading the cards takes longer than that - so
   * nearly every press reopened it, and the opening swallowed their first
   * words: "I need five polos" reached the server as "Live follows". Opened
   * on panel-open only when permission is already granted, so the browser's
   * prompt still comes from a deliberate tap, never from opening the panel.
   */
  warm?: boolean;
}

/** Whether the microphone is already allowed, so opening it cannot raise a prompt. */
async function micGranted(): Promise<boolean> {
  try {
    const result = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    return result?.state === 'granted';
  } catch {
    // Firefox does not know the name: it is then opened on the first press.
    return false;
  }
}

export function useVoice(onClip: (clip: Blob) => Promise<void>, options: VoiceOptions = {}): VoiceState {
  // getUserMedia only exists on https (and localhost), which the storefront is.
  const supported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia);

  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  // A hint is a passing remark: it goes by itself.
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), 4000);
    return () => clearTimeout(timer);
  }, [hint]);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);

  // Kept between turns. Only `release` takes these down.
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const frame = useRef(0);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tail = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef(0);
  const cancelled = useRef(false);
  /** Loudest sample of this clip, and how many readings it came from. */
  const peak = useRef(0);
  const frames = useRef(0);
  /**
   * Set the instant a press arrives, not when getUserMedia resolves - two fast
   * taps used to open two recorders and the second one won the refs.
   */
  const opening = useRef(false);
  /**
   * A stop or cancel that landed while the microphone was still coming up. It
   * has nothing to stop yet, so we remember it and apply it the moment the
   * recorder exists - otherwise the clip ran on to the 30 second limit with no
   * way to end it.
   */
  const pending = useRef<'stop' | 'cancel' | null>(null);
  /** A stop is already in flight, including its tail. Ignore further ones. */
  const stopping = useRef(false);

  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;
  const warmRef = useRef(Boolean(options.warm));
  warmRef.current = Boolean(options.warm);
  /** One getUserMedia at a time: the panel warming it and a press can race. */
  const acquiring = useRef<Promise<MediaStream> | null>(null);

  /** Everything that belongs to one clip. The microphone itself survives this. */
  const endTurn = useCallback(() => {
    cancelAnimationFrame(frame.current);
    if (ticker.current) clearInterval(ticker.current);
    if (limit.current) clearTimeout(limit.current);
    if (tail.current) clearTimeout(tail.current);
    ticker.current = null;
    limit.current = null;
    tail.current = null;
    recorder.current = null;
    opening.current = false;
    stopping.current = false;
    setLevel(0);
  }, []);

  /**
   * Hand the microphone back. Order matters: the AudioContext goes first,
   * while the track is still live. Closing it after, or with the source node
   * still attached to a live track, degrades the track and the next recording
   * comes back near silent.
   */
  const release = useCallback(() => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = null;
    analyser.current = null;
    const context = audio.current;
    audio.current = null;
    void context?.close().catch(() => undefined);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }, []);

  /** Nothing has used the microphone for a while: let the indicator clear. */
  const scheduleRelease = useCallback(() => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = null;
    // Held for as long as the panel is open; the countdown starts when it closes.
    if (warmRef.current) return;
    idle.current = setTimeout(release, IDLE_RELEASE_MS);
  }, [release]);

  useEffect(
    () => () => {
      endTurn();
      release();
    },
    [endTurn, release],
  );

  /**
   * The microphone, opened once and kept. autoGainControl stays on: turning it
   * off reads the level more truthfully and records worse, and a quiet talker
   * losing consonants costs more than a slightly optimistic meter.
   */
  const microphone = useCallback(async (): Promise<MediaStream> => {
    const live = stream.current;
    if (live && live.getAudioTracks().some((track) => track.readyState === 'live')) return live;
    // A track that ended (unplugged, or another app took the device) cannot be
    // revived - drop the whole graph and open a fresh one.
    if (live) release();

    if (!acquiring.current) {
      acquiring.current = navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .finally(() => {
          acquiring.current = null;
        });
    } else {
      return acquiring.current;
    }
    const source = await acquiring.current;
    stream.current = source;
    // If the device disappears mid-session, do not keep a dead stream around.
    source.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (stream.current === source && !recorder.current) release();
      };
    });

    try {
      const context = new (window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      audio.current = context;
      // Autoplay policy can hand back a suspended context, which reads as a
      // dead microphone: a flat wave and a clip we would refuse to send.
      if (context.state === 'suspended') await context.resume().catch(() => undefined);
      const node = context.createAnalyser();
      node.fftSize = 512;
      context.createMediaStreamSource(source).connect(node);
      analyser.current = node;
    } catch {
      // No meter is survivable: the recording works, and the silence check
      // fails open when it has nothing to go on.
      analyser.current = null;
    }
    return source;
  }, [release]);

  // Open with the panel, when already allowed; closed panel, the usual countdown.
  const warm = Boolean(options.warm);
  useEffect(() => {
    if (!supported) return;
    if (!warm) {
      // Mid-clip is the recorder's business; otherwise let the indicator clear soon.
      if (!recorder.current && stream.current) scheduleRelease();
      return;
    }
    if (idle.current) clearTimeout(idle.current);
    idle.current = null;
    let stale = false;
    void micGranted().then((granted) => {
      if (stale || !granted || !warmRef.current) return;
      microphone().catch(() => undefined); // the press will try again, and explain
    });
    return () => {
      stale = true;
    };
  }, [microphone, scheduleRelease, supported, warm]);

  /**
   * Drives the waveform, and watches for a microphone that heard nothing.
   * Sampled a few times a second, not every frame.
   */
  const meter = useCallback(() => {
    const node = analyser.current;
    peak.current = 0;
    frames.current = 0;
    if (!node) return;
    const data = new Uint8Array(node.frequencyBinCount);
    let last = 0;

    const read = (now: number) => {
      frame.current = requestAnimationFrame(read);
      if (now - last < 70) return;
      last = now;
      node.getByteTimeDomainData(data);
      let sum = 0;
      let loudest = 0;
      for (const value of data) {
        const offset = value - 128;
        sum += offset ** 2;
        loudest = Math.max(loudest, Math.abs(offset) / 128);
      }
      peak.current = Math.max(peak.current, loudest);
      frames.current += 1;
      // RMS, lifted a little so normal speech fills the bars.
      setLevel(Math.min(1, Math.sqrt(sum / data.length) / 40));
    };
    frame.current = requestAnimationFrame(read);
  }, []);

  const finish = useCallback(
    async (parts: BlobPart[], type: string) => {
      const clip = new Blob(parts, { type });
      const tooShort = Date.now() - startedAt.current < MIN_CLIP_MS || clip.size < 1024;
      if (tooShort) {
        setStatus('idle');
        setHint('Hold the mic while you speak.');
        return;
      }

      // The microphone was running and never heard anything. Given silence a
      // transcription model invents words, and they arrive as the customer's
      // own message - so this clip stops here.
      //
      // Fails open on purpose: too few readings is no evidence, and a dead
      // audio graph reads exactly like a quiet room. A stray clip costs a
      // fraction of a penny; refusing someone who is talking costs the sale.
      const measured = frames.current >= MIN_METERED_FRAMES;
      if (measured && peak.current <= SILENCE_PEAK) {
        setStatus('idle');
        setHint("I didn't catch that - hold the mic and try again.");
        // The peak is logged because when this goes wrong, that number is the
        // difference between a bad threshold and a dead audio graph. Not shown:
        // it means nothing to a customer.
        console.info('[caddie] no speech in clip, peak level', peak.current.toFixed(3));
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
    if (!supported || recorder.current || opening.current) return;
    setHint(null);
    opening.current = true;
    pending.current = null;
    stopping.current = false;
    if (idle.current) clearTimeout(idle.current);
    idle.current = null;
    setError(null);
    setStatus('starting');
    cancelled.current = false;

    try {
      const source = await microphone();

      const mimeType = pickMimeType();
      const instance = new MediaRecorder(source, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      instance.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      instance.onerror = () => {
        chunks.current = [];
        endTurn();
        scheduleRelease();
        setStatus('error');
        setError('The recording stopped unexpectedly. Tap the mic to try again.');
      };
      instance.onstop = () => {
        const parts = chunks.current;
        const type = instance.mimeType || mimeType || 'audio/webm';
        chunks.current = [];
        endTurn();
        // Keep the microphone warm for the next turn, then let it go.
        scheduleRelease();
        if (cancelled.current) {
          setStatus('idle');
          return;
        }
        void finish(parts, type);
      };

      recorder.current = instance;
      startedAt.current = Date.now();
      instance.start(200);
      meter();

      // They let go while the browser was still asking for the microphone.
      if (pending.current) {
        cancelled.current = pending.current === 'cancel';
        pending.current = null;
        opening.current = false;
        instance.stop();
        return;
      }

      opening.current = false;
      setStatus('recording');
      setSeconds(0);
      ticker.current = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 250);
      limit.current = setTimeout(() => recorder.current?.stop(), MAX_CLIP_MS);
    } catch (err) {
      pending.current = null;
      endTurn();
      release();
      setStatus('error');
      setError(describe(err));
    }
  }, [endTurn, finish, meter, microphone, release, scheduleRelease, supported]);

  const halt = useCallback((discard: boolean, delay: number) => {
    const instance = recorder.current;
    if (!instance) {
      // Still waiting on the microphone: apply this as soon as there is one.
      if (opening.current) pending.current = discard ? 'cancel' : 'stop';
      return;
    }
    if (stopping.current || instance.state !== 'recording') return;
    stopping.current = true;
    cancelled.current = discard;

    const close = () => {
      tail.current = null;
      if (instance.state !== 'recording') return;
      try {
        // Flush what this timeslice is still holding before closing.
        instance.requestData();
      } catch {
        // Not every browser allows it; stop() flushes anyway.
      }
      instance.stop();
    };

    if (delay > 0) tail.current = setTimeout(close, delay);
    else close();
  }, []);

  // People let go as they finish the last word rather than after it, so the
  // recorder runs on a fraction longer - otherwise "polos" arrives as "polo".
  const stop = useCallback(() => halt(false, TAIL_MS), [halt]);
  // A discard wants nothing kept, so it does not wait.
  const cancel = useCallback(() => halt(true, 0), [halt]);

  return {
    status,
    level,
    seconds,
    error,
    hint,
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
