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
  error: string | null;
  supported: boolean;
  start: () => Promise<void>;
  stop: () => void;
}

export function useVapi(sessionId: string): VoiceState {
  const publicKey = import.meta.env.VITE_VAPI_PUBLIC_KEY;
  const assistantId = import.meta.env.VITE_VAPI_ASSISTANT_ID;
  const supported = Boolean(publicKey && assistantId);

  const clientRef = useRef<Vapi | null>(null);
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [volume, setVolume] = useState(0);
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
    });
    instance.on('speech-start', () => setStatus('speaking'));
    instance.on('speech-end', () => setStatus('listening'));
    instance.on('volume-level', (level: number) => setVolume(level));
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
  }, []);

  return { status, volume, error, supported, start, stop };
}
