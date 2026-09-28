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
export async function noteCartMode<T extends { id: string; cartMode?: 'theme' | 'storefront'; widgetContract?: string }>(
  req: Request,
  session: T,
  patch: (id: string, change: { cartMode?: 'theme' | 'storefront'; widgetContract?: string }) => Promise<unknown>,
): Promise<T> {
  const header = req.get('x-caddie-cart');
  const mode = header === 'theme' ? 'theme' : header === 'storefront' ? 'storefront' : undefined;
  // And which basket-change contract the widget speaks (x-caddie-widget): an older widget sends none, and gets no change it cannot report on.
  const contract = (req.get('x-caddie-widget') ?? '').slice(0, 40) || undefined;
  const change: { cartMode?: 'theme' | 'storefront'; widgetContract?: string } = {};
  if (mode && session.cartMode !== mode) change.cartMode = mode;
  if (contract && session.widgetContract !== contract) change.widgetContract = contract;
  if (!Object.keys(change).length) return session;
  await patch(session.id, change);
  return { ...session, ...change };
}
