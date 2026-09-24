import type { CaddieAttachment, CaddieMessage, ChatRequest, PageContext } from '@caddie/shared';

const BASE = (import.meta.env.VITE_CADDIE_API_URL ?? 'http://localhost:8787').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new ApiError(detail?.detail ?? `Request failed (${res.status})`, res.status);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return unwrap<T>(res);
}

export function sendMessage(sessionId: string, text: string, context?: PageContext) {
  const body: ChatRequest = { sessionId, text, ...(context ? { context } : {}) };
  return post<{ sessionId: string; message: CaddieMessage }>('/api/chat', body);
}

/** Runs a tool directly. Useful while building UI before the AI understands the phrasing. */
export interface ToolResponse {
  sessionId: string;
  speech: string;
  attachment?: CaddieAttachment;
}

export function runTool(sessionId: string, name: string, args: Record<string, unknown>) {
  return post<ToolResponse>(`/api/tools/${name}`, {
    sessionId,
    args,
  });
}

export interface VoiceResponse {
  sessionId: string;
  /** What the customer actually said, as the server heard it. */
  transcript: string;
  message: CaddieMessage;
}

/**
 * Sends one recorded clip. The body is the audio itself - no form wrapper -
 * and the server transcribes it and answers in the same round trip.
 */
export function sendVoice(sessionId: string, clip: Blob) {
  // Browsers report types like "audio/webm;codecs=opus"; the server wants the
  // plain type it can map to a file extension for transcription.
  const contentType = (clip.type || 'audio/webm').split(';')[0] as string;

  return fetch(`${BASE}/api/voice?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: clip,
  }).then((res) => unwrap<VoiceResponse>(res));
}

export interface CaddieEvent {
  type: 'attachment' | 'speech' | 'status';
  sessionId: string;
  at: string;
  attachment?: CaddieAttachment;
  text?: string;
}

/**
 * Opens the session event stream. The server pushes product cards here during
 * a voice call, so the screen keeps up with what the Caddie is saying.
 */
export function openEventStream(sessionId: string, onEvent: (event: CaddieEvent) => void): () => void {
  const source = new EventSource(`${BASE}/api/events/${encodeURIComponent(sessionId)}`);

  const handle = (event: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(event.data) as CaddieEvent);
    } catch {
      // A malformed frame is not worth killing the stream over.
    }
  };

  source.addEventListener('attachment', handle as EventListener);
  source.addEventListener('speech', handle as EventListener);
  source.addEventListener('status', handle as EventListener);

  return () => source.close();
}
