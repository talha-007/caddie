import type { Request } from 'express';

/**
 * A stable key for rate limiting.
 *
 * Behind a tunnel or a proxy, req.ip is the proxy, so the forwarded address is
 * closer to the truth. It is spoofable - this deters casual abuse and keeps a
 * runaway script from emptying the OpenAI budget; it is not a security
 * boundary.
 */
export function clientKey(req: Request): string {
  const forwarded = req.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || req.ip || 'unknown';
}
