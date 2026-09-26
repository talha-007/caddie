import type { BasketSync, CaddieAttachment, CaddieMessage, CardChoice, CartAction, ChatRequest, PageContext, ProfileRequest, SessionRestartResponse, ShopperSizes } from '@caddie/shared';
import { onStorefront } from './themeCart.js';

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

/**
 * Where this shopper's basket lives. On the storefront it is the store's own
 * cart, and the server hands the widget changes to make rather than keeping a
 * basket of its own (see themeCart.ts).
 */
function cartHeader(): Record<string, string> {
  return { 'x-caddie-cart': onStorefront() ? 'theme' : 'storefront' };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cartHeader() },
    body: JSON.stringify(body),
  });
  return unwrap<T>(res);
}

/** The store cart as the widget read it, so the Caddie can see what is really in it. */
export function syncBasket(sessionId: string, basket: BasketSync) {
  return post<{ ok: boolean }>(`/api/session/${encodeURIComponent(sessionId)}/basket`, basket);
}

/** Who they shop for and their sizes, from the quick start. */
export function saveProfile(sessionId: string, profile: ProfileRequest) {
  return post<{ ok: boolean; shopper: ShopperSizes }>(`/api/session/${encodeURIComponent(sessionId)}/profile`, profile);
}

/** An option the customer picked on a product card themselves - so "add it" knows. See CardChoice. */
export function sendCardChoice(sessionId: string, choice: CardChoice) {
  return post<{ ok: boolean }>(`/api/session/${encodeURIComponent(sessionId)}/choice`, choice);
}

/** A clean chat on the same basket - behind "New chat". */
export function restartSession(sessionId: string) {
  return post<SessionRestartResponse>(`/api/session/${encodeURIComponent(sessionId)}/restart`, {});
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
  actions?: CartAction[];
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
 * The languages this shopper is likely to speak, most likely first: the
 * storefront page's own (Shopify sets <html lang> to the shopper's chosen
 * language), then the browser's. The server checks the language it detects in
 * a clip against these, and hears it again if the two disagree.
 */
function customerLanguages(): string[] {
  const page = typeof document !== 'undefined' ? document.documentElement.lang : '';
  const browser = typeof navigator !== 'undefined' ? [...(navigator.languages ?? [navigator.language])] : [];
  return [...new Set([page, ...browser].filter(Boolean))].slice(0, 6);
}

/**
 * Sends one recorded clip. The body is the audio itself - no form wrapper -
 * and the server transcribes it and answers in the same round trip.
 */
export function sendVoice(sessionId: string, clip: Blob) {
  // Browsers report types like "audio/webm;codecs=opus"; the server wants the
  // plain type it can map to a file extension for transcription.
  const contentType = (clip.type || 'audio/webm').split(';')[0] as string;
  const lang = encodeURIComponent(customerLanguages().join(','));

  return fetch(`${BASE}/api/voice?sessionId=${encodeURIComponent(sessionId)}&lang=${lang}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...cartHeader() },
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
