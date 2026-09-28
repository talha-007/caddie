import type {
  BasketSync,
  CaddieAttachment,
  CaddieMessage,
  CardChoice,
  CartAction,
  CartOutcomeReport,
  CartOutcomeResponse,
  ChatRequest,
  PageContext,
  ProfileRequest,
  SessionClaimResponse,
  SessionRestartResponse,
  ShopperSizes,
  UiActionResponse,
  UiAddRequest,
  UiCartLineRequest,
  UiPackAddRequest,
} from '@caddie/shared';
import { CART_OPS_CONTRACT } from '@caddie/shared';
import { onStorefront } from './themeCart.js';

const BASE = (import.meta.env.VITE_CADDIE_API_URL ?? 'http://localhost:8787').replace(/\/$/, '');

export class ApiError extends Error {
  /** Seconds the server asked us to wait, when it limited the request. */
  constructor(message: string, readonly status: number, readonly retryAfter?: number) {
    super(message);
  }
}

/**
 * A request that ran past its deadline. The widget gives up waiting - it
 * does not know whether the server, or the store's cart, went on to finish
 * the work - so what follows a timeout is a check of the basket, never a
 * repeat of the request (audit finding B5: a hung request once left every
 * control loading for good).
 */
export class TimeoutError extends ApiError {
  constructor(readonly what: string, readonly ms: number) {
    super(`${what} took longer than ${Math.round(ms / 1000)}s`, 0);
  }
}

const envMs = (key: string, fallback: number): number => {
  const raw = Number((import.meta.env as Record<string, string | undefined>)[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};
/** Deadlines, finite and configurable: the model can take a while; a basket call cannot. */
export const TIMEOUTS = {
  chat: envMs('VITE_CADDIE_CHAT_TIMEOUT_MS', 45_000),
  voice: envMs('VITE_CADDIE_VOICE_TIMEOUT_MS', 90_000),
  cart: envMs('VITE_CADDIE_CART_TIMEOUT_MS', 15_000),
};

/** fetch with a deadline: the request is aborted and a TimeoutError thrown when it passes. */
export async function fetchWithDeadline(input: string, init: RequestInit, ms: number, what: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new TimeoutError(what, ms);
    throw err;
  } finally {
    clearTimeout(timer);
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

/* ---------------- the session's own capability ---------------- */

/*
 * The session id says which conversation; it is not a permission. The server
 * hands the browser that claims a session a token, and only requests carrying
 * it can read or change that session - so an id seen in a log or the page is
 * not a way into someone's basket. Kept beside the id, for this tab only;
 * sent in a header, never in a URL.
 */
const TOKEN_HEADER = 'x-caddie-session-token';
/**
 * The basket-change contract this widget speaks, sent on every request about
 * a session; and the one the server spoke when the session was claimed. A
 * server without it hands over changes it will count as made on dispatch,
 * which this widget will not carry out: it would have no way to report them
 * (serverSupportsOperations).
 */
const WIDGET_HEADER = 'x-caddie-widget';
const serverContracts = new Map<string, string | null>();
export function serverSupportsOperations(sessionId: string): boolean {
  return serverContracts.get(currentId(sessionId)) === CART_OPS_CONTRACT;
}
const TOKEN_KEY = 'druids-caddie-session-token';
const tokens = new Map<string, Promise<string>>();

function storedToken(sessionId: string): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    const stored = raw ? (JSON.parse(raw) as { sessionId?: string; token?: string }) : null;
    return stored?.sessionId === sessionId && stored.token ? stored.token : null;
  } catch {
    return null;
  }
}

/**
 * A session this tab can no longer use: claimed, but the token never reached
 * us - the reply was lost on the way (a server restart mid-request, a tunnel
 * error). The server will not hand out its token twice, so it is gone for
 * good, and a new session takes its place (see authed).
 */
class SessionLost extends Error {}

/*
 * Claims are limited per session and per address. Once the server says wait,
 * nothing claims until then. Before this, a tab whose claim reply was lost
 * retried on every request and every 3s from the event stream - 171 claims in
 * 17 minutes, each counted, all refused.
 */
let claimsBlockedUntil = 0;

async function claim(sessionId: string): Promise<string> {
  const wait = Math.ceil((claimsBlockedUntil - Date.now()) / 1000);
  if (wait > 0) throw new ApiError('Let me catch up - try again in a minute.', 429, wait);
  const res = await fetch(`${BASE}/api/session/${encodeURIComponent(sessionId)}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (res.status === 409) throw new SessionLost(sessionId);
  if (res.status === 429) {
    const detail = (await res.json().catch(() => ({}))) as { retryAfter?: number };
    const seconds = Number(detail.retryAfter ?? res.headers.get('Retry-After') ?? 60) || 60;
    claimsBlockedUntil = Date.now() + seconds * 1000;
    throw new ApiError('Let me catch up - try again in a minute.', 429, seconds);
  }
  const body = await unwrap<SessionClaimResponse>(res);
  serverContracts.set(sessionId, body.contract ?? null);
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ sessionId, token: body.sessionToken }));
  } catch {
    // Private mode: the token lives as long as this page, like the chat.
  }
  return body.sessionToken;
}

function sessionToken(sessionId: string): Promise<string> {
  let token = tokens.get(sessionId);
  if (!token) {
    const stored = storedToken(sessionId);
    token = stored ? Promise.resolve(stored) : claim(sessionId);
    tokens.set(sessionId, token);
    token.catch(() => tokens.delete(sessionId));
  }
  return token;
}

function forgetToken(sessionId: string): void {
  tokens.delete(sessionId);
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored.
  }
}

/* ---------------- a lost session, replaced ---------------- */

type SessionReplaced = (from: string, to: string) => void;
const replacedListeners = new Set<SessionReplaced>();
/** Old id -> the one that replaced it, so a request still holding the old id follows. */
const replacements = new Map<string, string>();

/** Told when this tab's session is replaced - the hook moves everything to the new id. */
export function onSessionReplaced(listener: SessionReplaced): () => void {
  replacedListeners.add(listener);
  return () => replacedListeners.delete(listener);
}

function currentId(sessionId: string): string {
  let id = sessionId;
  while (replacements.has(id)) id = replacements.get(id)!;
  return id;
}

function replaceSession(lost: string): string {
  const fresh = crypto.randomUUID();
  replacements.set(lost, fresh);
  forgetToken(lost);
  for (const listener of replacedListeners) listener(lost, fresh);
  return fresh;
}

/** The request re-addressed to another session id: in its path, and in a JSON body that names it. */
function retarget(path: string, init: RequestInit, from: string, to: string): { path: string; init: RequestInit } {
  if (from === to) return { path, init };
  const swap = (text: string) => text.split(from).join(to);
  return { path: swap(path), init: typeof init.body === 'string' ? { ...init, body: swap(init.body) } : init };
}

/**
 * A request about this session, with its token. If the server no longer
 * knows the session - two hours idle, or a restart - it is claimed again and
 * the request sent once more. If the session was claimed but its token lost,
 * a new session replaces it and the request goes there instead.
 */
async function authed(sessionId: string, path: string, init: RequestInit & { headers?: Record<string, string> }, deadline: { ms: number; what: string } = { ms: TIMEOUTS.cart, what: 'The request' }): Promise<Response> {
  const send = async (id: string) => {
    const target = retarget(path, init, sessionId, id);
    const token = await sessionToken(id);
    return fetchWithDeadline(`${BASE}${target.path}`, { ...target.init, headers: { ...((target.init.headers as Record<string, string>) ?? {}), [TOKEN_HEADER]: token, [WIDGET_HEADER]: CART_OPS_CONTRACT } }, deadline.ms, deadline.what);
  };
  let id = currentId(sessionId);
  try {
    const res = await send(id);
    if (res.status !== 401) return res;
    forgetToken(id);
    return await send(id);
  } catch (err) {
    if (!(err instanceof SessionLost)) throw err;
    id = replaceSession(id);
    return send(id);
  }
}

async function post<T>(sessionId: string, path: string, body: unknown, deadline?: { ms: number; what: string }): Promise<T> {
  const res = await authed(
    sessionId,
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cartHeader() },
      body: JSON.stringify(body),
    },
    deadline,
  );
  return unwrap<T>(res);
}

/**
 * What the store cart showed after an operation the server handed over -
 * the only thing that completes it (server: tools/cartOperations.ts). A
 * lost acknowledgement is retried a few times here, then left to the next
 * load (operations.ts); the add itself is never sent again.
 */
export async function reportCartOutcome(sessionId: string, report: CartOutcomeReport, attempts = 3): Promise<CartOutcomeResponse> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await post<CartOutcomeResponse>(sessionId, `/api/session/${encodeURIComponent(sessionId)}/cart-outcome`, report, { ms: TIMEOUTS.cart, what: 'Confirming the basket' });
    } catch (err) {
      // A 404 is the server's answer (not this session's operation), not a delivery failure.
      if (err instanceof ApiError && err.status === 404) return { status: 'unknown' };
      last = err;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw last instanceof Error ? last : new Error('The basket update could not be confirmed.');
}

/* ---------------- the calls ---------------- */

/** The store cart as the widget read it, so the Caddie can see what is really in it. */
export function syncBasket(sessionId: string, basket: BasketSync) {
  return post<{ ok: boolean }>(sessionId, `/api/session/${encodeURIComponent(sessionId)}/basket`, basket);
}

/** Who they shop for and their sizes, from the quick start. */
export function saveProfile(sessionId: string, profile: ProfileRequest) {
  return post<{ ok: boolean; shopper: ShopperSizes }>(sessionId, `/api/session/${encodeURIComponent(sessionId)}/profile`, profile);
}

/** An option the customer picked on a product card themselves - so "add it" knows. See CardChoice. */
export function sendCardChoice(sessionId: string, choice: CardChoice) {
  return post<{ ok: boolean }>(sessionId, `/api/session/${encodeURIComponent(sessionId)}/choice`, choice);
}

/** A clean chat on the same basket - behind "New chat". */
export function restartSession(sessionId: string) {
  return post<SessionRestartResponse>(sessionId, `/api/session/${encodeURIComponent(sessionId)}/restart`, {});
}

export function sendMessage(sessionId: string, text: string, context?: PageContext, deadline: { ms: number; what: string } = { ms: TIMEOUTS.chat, what: 'The Caddie' }) {
  const body: ChatRequest = { sessionId, text, ...(context ? { context } : {}) };
  return post<{ sessionId: string; message: CaddieMessage }>(sessionId, '/api/chat', body, deadline);
}

/** Runs a tool directly. Useful while building UI before the AI understands the phrasing. */
export interface ToolResponse {
  sessionId: string;
  speech: string;
  attachment?: CaddieAttachment;
  actions?: CartAction[];
}

/**
 * The basket buttons, through the server's Action Gateway: a card's Add, a
 * pack's Add, and the basket's quantity and remove buttons. The server
 * checks the variant, its stock and a pack's price, and hands back the
 * changes for the widget to make in the store's cart - the only way the
 * widget changes it.
 */
export function addFromCard(sessionId: string, request: UiAddRequest) {
  return post<UiActionResponse>(sessionId, `/api/session/${encodeURIComponent(sessionId)}/add`, request);
}

export function addPackFromCard(sessionId: string, request: UiPackAddRequest) {
  return post<UiActionResponse>(sessionId, `/api/session/${encodeURIComponent(sessionId)}/add-pack`, request);
}

export function changeCartLine(sessionId: string, request: UiCartLineRequest) {
  return post<UiActionResponse>(sessionId, `/api/session/${encodeURIComponent(sessionId)}/cart-line`, request);
}

export function runTool(sessionId: string, name: string, args: Record<string, unknown>) {
  return post<ToolResponse>(sessionId, `/api/tools/${name}`, {
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
export async function sendVoice(sessionId: string, clip: Blob) {
  // Browsers report types like "audio/webm;codecs=opus"; the server wants the
  // plain type it can map to a file extension for transcription.
  const contentType = (clip.type || 'audio/webm').split(';')[0] as string;
  const lang = encodeURIComponent(customerLanguages().join(','));
  const res = await authed(sessionId, `/api/voice?sessionId=${encodeURIComponent(sessionId)}&lang=${lang}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...cartHeader() },
    body: clip,
  }, { ms: TIMEOUTS.voice, what: 'Listening' });
  return unwrap<VoiceResponse>(res);
}

export interface CaddieEvent {
  type: 'attachment' | 'speech' | 'status';
  sessionId: string;
  at: string;
  attachment?: CaddieAttachment;
  text?: string;
}

const EVENT_TYPES = new Set(['attachment', 'speech', 'status']);

/**
 * Opens the session event stream. The server pushes product cards here during
 * a voice call, so the screen keeps up with what the Caddie is saying.
 *
 * Read with fetch rather than EventSource, which cannot send the session's
 * token - and the stream carries this shopper's cards and basket. Reconnects
 * after a drop, as EventSource did.
 */
export function openEventStream(sessionId: string, onEvent: (event: CaddieEvent) => void): () => void {
  let stopped = false;
  let controller: AbortController | null = null;

  const deliver = (frame: string) => {
    let type = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!EVENT_TYPES.has(type) || data.length === 0) return;
    try {
      onEvent(JSON.parse(data.join('\n')) as CaddieEvent);
    } catch {
      // A malformed frame is not worth killing the stream over.
    }
  };

  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      let wait = 3000;
      try {
        const res = await authed(sessionId, `/api/events/${encodeURIComponent(sessionId)}`, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
        if (res.ok && res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
            let end = buffer.indexOf('\n\n');
            while (end >= 0) {
              deliver(buffer.slice(0, end));
              buffer = buffer.slice(end + 2);
              end = buffer.indexOf('\n\n');
            }
          }
        }
        // Limited: wait as long as the server asked before trying again.
        else if (res.status === 429) {
          const detail = (await res.json().catch(() => ({}))) as { retryAfter?: number };
          wait = (Number(detail.retryAfter) || 60) * 1000;
        }
      } catch (err) {
        // Dropped, or closed on purpose - the loop decides which. A limited claim says how long to wait.
        if (err instanceof ApiError && err.retryAfter) wait = err.retryAfter * 1000;
      }
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  };
  void run();

  return () => {
    stopped = true;
    controller?.abort();
  };
}
