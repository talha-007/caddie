import type { Request, RequestHandler } from 'express';
import { log } from './logger.js';
import { consumeShared, type Limit } from './rateLimit.js';
import { clientKey } from './request.js';

/**
 * A rate limit on a route that changes a shopper's session.
 *
 * /choice, /basket, /profile and the direct tool route were reachable by any
 * script, as often as it liked, for any session id. Counted per session and
 * per address, as /api/chat is, in the same shared counters.
 */
export function limitRoute(
  scope: string,
  sessionOf: (req: Request) => string | undefined,
  perSession: Limit,
  perAddress?: Limit,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const sessionId = sessionOf(req) || 'none';
      const [bySession, byAddress] = await Promise.all([
        consumeShared(`${scope}:${sessionId}`, perSession),
        perAddress ? consumeShared(`${scope}-ip:${clientKey(req)}`, perAddress) : Promise.resolve(null),
      ]);
      const limited = !bySession.ok ? bySession : byAddress && !byAddress.ok ? byAddress : null;
      if (limited) {
        log.warn('route.rate_limited', { scope, sessionId });
        res.set('Retry-After', String(limited.retryAfter ?? 60));
        res.status(429).json({ error: 'rate_limited', retryAfter: limited.retryAfter });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
