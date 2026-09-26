import { claimSession } from '../../src/session/ownership.js';

/**
 * The header a session's owner sends (session/ownership.ts), claiming the
 * session the first time it is asked for - as the widget does before its
 * first request. Tests that call routes act as that session's own browser.
 */
const tokens = new Map<string, string>();

export async function ownerHeaders(sessionId: string): Promise<Record<string, string>> {
  let token = tokens.get(sessionId);
  if (!token) {
    const claimed = await claimSession(sessionId);
    if (!claimed.ok) throw new Error(`could not claim ${sessionId}: ${claimed.reason}`);
    token = claimed.sessionToken;
    tokens.set(sessionId, token);
  }
  return { 'x-caddie-session-token': token };
}

/** The session a request is about: /api/session/:id/..., or the body's sessionId. */
export function sessionOfRequest(path: string, body: unknown): string | undefined {
  const inPath = /\/api\/session\/([^/]+)\//.exec(path)?.[1];
  const inBody = typeof body === 'object' && body && 'sessionId' in body ? String((body as { sessionId: unknown }).sessionId) : undefined;
  return inPath ? decodeURIComponent(inPath) : inBody;
}
