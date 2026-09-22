import { useCallback, useEffect, useRef, useState } from 'react';
import type Vapi from '@vapi-ai/web';

/**
 * Voice call state.
 *
 * The sessionId goes to Vapi as call metadata, so the tool webhook can reach
 * the same conversation the chat panel is using - one Caddie, two input modes.
 */

export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';

export interface VoiceState {
  status: VoiceStatus;
  /** 0-1, for the mic level animation. */
  volume: number;
  /** What the customer is saying right now, before Vapi finalises it. */
  partial: string;
  error: string | null;
  supported: boolean;
  active: boolean;
  start: () => Promise<void>;
  stop: () => void;
}

export type TranscriptListener = (role: 'user' | 'assistant', text: string) => void;

/** Vapi types `message` as any; read the transcript fields defensively. */
function readTranscript(raw: unknown): { role: 'user' | 'assistant'; final: boolean; text: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const message = raw as Record<string, unknown>;
  if (message.type !== 'transcript' || typeof message.transcript !== 'string') return null;
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  return { role: message.role, final: message.transcriptType === 'final', text: message.transcript.trim() };
}

export function useVapi(sessionId: string, onTranscript?: TranscriptListener): VoiceState {
  const publicKey = import.meta.env.VITE_VAPI_PUBLIC_KEY;
  const assistantId = import.meta.env.VITE_VAPI_ASSISTANT_ID;
  const supported = Boolean(publicKey && assistantId);

  const clientRef = useRef<Vapi | null>(null);
  const transcriptRef = useRef(onTranscript);
  transcriptRef.current = onTranscript;

  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [volume, setVolume] = useState(0);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The Vapi SDK pulls in the whole WebRTC stack (~700kB), so it is loaded on
  // the first tap of the mic rather than on every page view.
  const client = useCallback(async (): Promise<Vapi | null> => {
    if (!supported) return null;
    if (clientRef.current) return clientRef.current;

    const { default: VapiClient } = await import('@vapi-ai/web');
    const instance = new VapiClient(publicKey as string);

    instance.on('call-start', () => setStatus('listening'));
    instance.on('call-end', () => {
      setStatus('idle');
      setVolume(0);
      setPartial('');
    });
    instance.on('speech-start', () => setStatus('speaking'));
    instance.on('speech-end', () => setStatus('listening'));
    instance.on('volume-level', (level: number) => setVolume(level));
    instance.on('message', (raw: unknown) => {
      const transcript = readTranscript(raw);
      if (!transcript || !transcript.text) return;
      if (transcript.role === 'user') setPartial(transcript.final ? '' : transcript.text);
      if (transcript.final) transcriptRef.current?.(transcript.role, transcript.text);
    });
    instance.on('error', (err: unknown) => {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Voice call failed.');
    });

    clientRef.current = instance;
    return instance;
  }, [publicKey, supported]);

  useEffect(() => {
    return () => {
      clientRef.current?.stop();
      clientRef.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    if (!assistantId) return;
    setError(null);
    setStatus('connecting');
    try {
      const instance = await client();
      await instance?.start(assistantId, { metadata: { sessionId } });
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Could not start the call.');
    }
  }, [assistantId, client, sessionId]);

  const stop = useCallback(() => {
    clientRef.current?.stop();
    setStatus('idle');
    setPartial('');
  }, []);

  const active = status === 'connecting' || status === 'listening' || status === 'speaking';

  return { status, volume, partial, error, supported, active, start, stop };
}
