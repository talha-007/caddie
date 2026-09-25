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

/**
 * Records where this shopper's basket lives, from the widget's x-caddie-cart
 * header. On the storefront the widget sends "theme": the basket is the
 * store's own cart in their browser, and the tools hand the widget changes
 * instead of keeping a basket of their own. Returns the session as it should
 * now be read, so a tool running in this same request sees the mode.
 */
export async function noteCartMode<T extends { id: string; cartMode?: 'theme' | 'storefront' }>(
  req: Request,
  session: T,
  patch: (id: string, change: { cartMode: 'theme' | 'storefront' }) => Promise<unknown>,
): Promise<T> {
  const header = req.get('x-caddie-cart');
  const mode = header === 'theme' ? 'theme' : header === 'storefront' ? 'storefront' : undefined;
  if (!mode || session.cartMode === mode) return session;
  await patch(session.id, { cartMode: mode });
  return { ...session, cartMode: mode };
}
