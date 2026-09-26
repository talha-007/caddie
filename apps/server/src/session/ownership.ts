import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { env } from '../env.js';
import { log } from '../lib/logger.js';
import { sessions, type CaddieSession } from './store.js';

/**
 * Who a shopping session belongs to.
 *
 * A session id is an identifier, not a permission. It was the only thing any
 * route checked: whoever sent an id could read that shopper's conversation
 * and basket from the event stream, write their profile, change their card
 * choices, and add to or empty their basket. An id travels - into logs, the
 * admin dashboard, the page - so knowing one must not be enough.
 *
 * Each session now has a capability: a random 256-bit token, handed once to
 * the browser that claims the session and never again. The server keeps only
 * its SHA-256 (`ownerHash`); the browser sends the token in a header on every
 * private request. It never appears in a URL, a log line, a tool result or
 * anything the model sees.
 *
 *   claim     the widget makes its session id itself, then claims it -
 *             POST /api/session/:id/claim - before its first private request.
 *             A session already claimed cannot be claimed again.
 *   verify    every route that reads or changes a session: the token's hash
 *             must match, compared in constant time.
 *   restart   "New chat" keeps the session, so it keeps its capability.
 *   expiry    with the session itself - two hours idle. Then the id is free
 *             and the widget claims it afresh, with a new token.
 *
 * Development may skip it, explicitly (CADDIE_DEV_OPEN_SESSIONS=1), for curl
 * and the test harness - never in production.
 */

export const SESSION_TOKEN_HEADER = 'x-caddie-session-token';

/** 256 bits from the platform's secure generator, as text safe for a header. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Whether this token is the session's. Constant time; a session never claimed belongs to no one. */
export function ownsSession(session: Pick<CaddieSession, 'ownerHash'> | null, token: string | undefined): boolean {
  if (!session?.ownerHash || !token) return false;
  const a = Buffer.from(tokenHash(token), 'hex');
  const b = Buffer.from(session.ownerHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Token-less sessions, for local tools only. Ignored in production whatever the setting. */
export function openSessionsAllowed(): boolean {
  return !env.isProd && process.env.CADDIE_DEV_OPEN_SESSIONS === '1';
}

const SESSION_ID = /^[A-Za-z0-9_.-]{8,100}$/;

/**
 * Claim a session id: a fresh token for a session nobody holds. The id the
 * widget made is kept - everything that already keys on it keeps working -
 * and only the browser that claimed it can use it from now on.
 */
export async function claimSession(id: string): Promise<{ ok: true; sessionToken: string } | { ok: false; reason: 'invalid' | 'taken' }> {
  if (!SESSION_ID.test(id)) return { ok: false, reason: 'invalid' };
  const existing = await sessions.get(id);
  if (existing?.ownerHash) return { ok: false, reason: 'taken' };
  const token = newSessionToken();
  await sessions.getOrCreate(id);
  await sessions.patch(id, { ownerHash: tokenHash(token) });
  return { ok: true, sessionToken: token };
}

/**
 * Route guard: the session named by the request, and proof it is the
 * caller's. Refused with 401 and nothing read or changed - including a
 * session that does not exist, which is never created here.
 */
export function requireSessionOwner(idOf: (req: Request) => string | undefined): RequestHandler {
  return async (req, res, next) => {
    try {
      const id = idOf(req);
      if (!id) {
        res.status(400).json({ error: 'session_required' });
        return;
      }
      if (openSessionsAllowed()) {
        next();
        return;
      }
      const session = await sessions.get(id);
      if (!ownsSession(session, req.get(SESSION_TOKEN_HEADER) ?? undefined)) {
        // Never the token, never the id in full: enough to spot a pattern, nothing to reuse.
        log.warn('session.not_owned', { path: req.baseUrl, session: id.slice(0, 8), known: !!session });
        res.status(401).json({ error: 'session_not_owned' });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
