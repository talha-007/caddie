import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaddieAttachment, CaddieMessage } from '@caddie/shared';
import { openEventStream, sendMessage } from './api.js';

/** One session id per browser tab, reused across page views in the same visit. */
function useSessionId(): string {
  return useMemo(() => {
    const key = 'druids-caddie-session';
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
    return id;
  }, []);
}

function message(role: CaddieMessage['role'], text: string, attachment?: CaddieAttachment): CaddieMessage {
  return { id: crypto.randomUUID(), role, text, createdAt: new Date().toISOString(), ...(attachment ? { attachment } : {}) };
}

export interface CaddieState {
  sessionId: string;
  messages: CaddieMessage[];
  /** The most recent structured result - what the main panel renders. */
  attachment: CaddieAttachment | null;
  busy: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
  clearError: () => void;
}

export function useCaddie(): CaddieState {
  const sessionId = useSessionId();
  const [messages, setMessages] = useState<CaddieMessage[]>([]);
  const [attachment, setAttachment] = useState<CaddieAttachment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef(new Set<string>());

  // Voice-driven results arrive here rather than as a chat response.
  useEffect(() => {
    return openEventStream(sessionId, (event) => {
      if (event.type === 'attachment' && event.attachment) {
        setAttachment(event.attachment);
      }
      if (event.type === 'speech' && event.text && !seen.current.has(event.at)) {
        seen.current.add(event.at);
        setMessages((prev) => [...prev, message('assistant', event.text as string)]);
      }
    });
  }, [sessionId]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      setBusy(true);
      setError(null);
      setMessages((prev) => [...prev, message('user', trimmed)]);

      try {
        const reply = await sendMessage(sessionId, trimmed);
        seen.current.add(reply.message.createdAt);
        setMessages((prev) => [...prev, reply.message]);
        if (reply.message.attachment) setAttachment(reply.message.attachment);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      } finally {
        setBusy(false);
      }
    },
    [busy, sessionId],
  );

  return {
    sessionId,
    messages,
    attachment,
    busy,
    error,
    send,
    clearError: useCallback(() => setError(null), []),
  };
}
