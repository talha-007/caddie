import type { CaddieAttachment, CaddieMessage, ChatRequest, PageContext } from '@caddie/shared';

const BASE = (import.meta.env.VITE_CADDIE_API_URL ?? 'http://localhost:8787').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new ApiError(detail?.detail ?? `Request failed (${res.status})`, res.status);
  }
  return res.json() as Promise<T>;
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
