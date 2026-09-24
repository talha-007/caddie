import type { CaddieAttachment, CaddieMessage, CaddieState } from '@caddie/shared';

/**
 * Everything this app knows about the backend.
 *
 * Shapes are documented in docs/API.md. Three rules worth repeating here
 * because they are easy to get wrong in components:
 *
 *  - `message.text` is for reading. Every fact you display comes from
 *    `attachment`, never from parsing the text.
 *  - Money is already in major units: { amount: 42 } is £42.00, not 42p.
 *  - The backend keeps nothing between requests. Every reply carries `state`;
 *    hold it and send it straight back. It is opaque - never read it, never
 *    reshape it, just hand it over.
 */

const BASE = (import.meta.env.VITE_CADDIE_API_URL ?? 'http://localhost:8787').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Turns a failed response into something worth showing a customer. */
async function toError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };

  if (res.status === 502) {
    return new ApiError('The store is not answering right now. Try again in a moment.', 502, body.error);
  }
  if (res.status === 501) {
    return new ApiError('That is not switched on yet.', 501, body.error);
  }
  return new ApiError(body.detail ?? `Something went wrong (${res.status}).`, res.status, body.error);
}

export async function sendMessage(sessionId: string, text: string, state?: CaddieState) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, text, ...(state ? { state } : {}) }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as { sessionId: string; message: CaddieMessage; state: CaddieState };
}

/**
 * The state, packed for an HTTP header.
 *
 * Base64 because the state carries what was said, and what the Caddie says is
 * full of pound signs - a browser throws on a header value outside Latin-1,
 * so the raw JSON would work until the first time a price came up.
 */
function packState(state: CaddieState): string {
  const utf8 = new TextEncoder().encode(JSON.stringify(state));
  let binary = '';
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface VoiceReply {
  sessionId: string;
  /** What we heard. Always shown - a bad answer is often a bad transcript. */
  transcript: string;
  message: CaddieMessage;
  state: CaddieState;
}

export async function sendVoice(sessionId: string, audio: Blob, state?: CaddieState): Promise<VoiceReply> {
  const res = await fetch(`${BASE}/api/voice?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    // Raw body, not multipart. The server reads the blob straight off it, so
    // the state has to travel in a header rather than alongside it.
    headers: {
      'Content-Type': audio.type || 'audio/webm',
      ...(state ? { 'x-caddie-state': packState(state) } : {}),
    },
    body: audio,
  });
  if (!res.ok) {
    const error = await toError(res);
    if (error.code === 'empty_audio') {
      throw new ApiError('I did not hear anything - hold the button while you talk.', 400, error.code);
    }
    throw error;
  }
  return (await res.json()) as VoiceReply;
}

/** Runs a tool with no AI in the way. Used for picking a size and adding it. */
export async function runTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  state?: CaddieState,
) {
  const res = await fetch(`${BASE}/api/tools/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The state matters as much here as on chat: add_to_cart needs the basket
    // the customer already has, and that id lives nowhere else.
    body: JSON.stringify({ sessionId, args, ...(state ? { state } : {}) }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as {
    sessionId: string;
    speech: string;
    attachment?: CaddieAttachment;
    state: CaddieState;
  };
}

export interface CaddieEvent {
  type: 'attachment' | 'speech' | 'status';
  sessionId: string;
  at: string;
  attachment?: CaddieAttachment;
  text?: string;
}

/**
 * The session's event stream.
 *
 * Chat replies carry their attachment directly, so this mainly matters once
 * voice is driving the conversation - the cards land here while the Caddie is
 * still talking.
 */
export function openEventStream(sessionId: string, onEvent: (event: CaddieEvent) => void): () => void {
  const source = new EventSource(`${BASE}/api/events/${encodeURIComponent(sessionId)}`);

  const handle = (event: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(event.data) as CaddieEvent);
    } catch {
      // A malformed frame is not worth tearing the stream down for.
    }
  };

  source.addEventListener('attachment', handle as EventListener);
  source.addEventListener('speech', handle as EventListener);
  source.addEventListener('status', handle as EventListener);

  return () => source.close();
}

export async function health() {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as {
    ok: boolean;
    chatMode: string;
    voice: string;
  };
}

export { BASE as apiBase };
