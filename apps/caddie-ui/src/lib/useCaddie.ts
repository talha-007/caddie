import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaddieAttachment, CaddieMessage } from '@caddie/shared';
import { ApiError, openEventStream, runTool, sendMessage, sendVoice } from './api.js';

/** One session per tab, so a reload does not start a new customer. */
function useSessionId(): string {
  return useMemo(() => {
    const key = 'druids-caddie-session';
    try {
      const existing = sessionStorage.getItem(key);
      if (existing) return existing;
      const id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
      return id;
    } catch {
      // Private mode, or storage blocked. A per-load session still works.
      return crypto.randomUUID();
    }
  }, []);
}

function message(role: CaddieMessage['role'], text: string, attachment?: CaddieAttachment): CaddieMessage {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    createdAt: new Date().toISOString(),
    ...(attachment ? { attachment } : {}),
  };
}

export interface CaddieState {
  sessionId: string;
  messages: CaddieMessage[];
  /** The latest structured result - what the main panel renders. */
  attachment: CaddieAttachment | null;
  busy: boolean;
  /** Set while a recording is being transcribed, which is the slow part. */
  listening: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
  sendAudio: (audio: Blob) => Promise<void>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<void>;
  clearError: () => void;
}

export function useCaddie(): CaddieState {
  const sessionId = useSessionId();
  const [messages, setMessages] = useState<CaddieMessage[]>([]);
  const [attachment, setAttachment] = useState<CaddieAttachment | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Replies arrive over the stream as well as in the response. Show once. */
  const seen = useRef(new Set<string>());

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

  const fail = useCallback((err: unknown) => {
    setError(err instanceof ApiError ? err.message : 'Something went wrong.');
  }, []);

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
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    [busy, fail, sessionId],
  );

  const sendAudio = useCallback(
    async (audio: Blob) => {
      if (busy) return;
      setBusy(true);
      setListening(true);
      setError(null);

      try {
        const reply = await sendVoice(sessionId, audio);
        seen.current.add(reply.message.createdAt);
        // Show what we heard, then the answer. Without the transcript nobody
        // can tell a bad answer from a bad recording.
        setMessages((prev) => [
          ...prev,
          ...(reply.transcript ? [message('user', reply.transcript)] : []),
          reply.message,
        ]);
        if (reply.message.attachment) setAttachment(reply.message.attachment);
      } catch (err) {
        fail(err);
      } finally {
        setListening(false);
        setBusy(false);
      }
    },
    [busy, fail, sessionId],
  );

  /**
   * Calls a tool directly, for things the customer does by tapping rather than
   * asking - picking a size, adding to the basket, changing a quantity.
   */
  const callTool = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const result = await runTool(sessionId, name, args);
        if (result.attachment) setAttachment(result.attachment);
        if (result.speech) setMessages((prev) => [...prev, message('assistant', result.speech)]);
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    [busy, fail, sessionId],
  );

  return {
    sessionId,
    messages,
    attachment,
    busy,
    listening,
    error,
    send,
    sendAudio,
    callTool,
    clearError: useCallback(() => setError(null), []),
  };
}
