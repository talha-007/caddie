import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { env } from '../env.js';
import { log } from '../lib/logger.js';
import { buildReport } from '../usage/report.js';
import { usage } from '../usage/store.js';
import { renderAdminPage } from './adminPage.js';

/**
 * The usage dashboard, for us rather than for customers.
 *
 * It shows what we are spending on OpenAI, which model and which kind of call
 * it went on, which conversations cost it, and what was actually said. That
 * last part is why it is behind a token: it reads back what customers typed.
 */

export const adminRouter: Router = Router();

/**
 * Compared in constant time, and hashed first so the comparison does not leak
 * the token's length. Overkill for an internal page, but it is the difference
 * between a guessable secret and one that is not, and it costs nothing.
 */
function matches(supplied: string): boolean {
  const expected = env.adminToken;
  if (!expected) return false;

  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function tokenFrom(req: Request): string {
  const header = req.get('x-admin-token');
  if (header) return header;
  const query = req.query.token;
  return typeof query === 'string' ? query : '';
}

/**
 * 404 rather than 401, always.
 *
 * A 401 confirms there is something here and invites guessing at it; the
 * server is reachable through a public dev tunnel, so that matters. Not
 * configuring ADMIN_TOKEN at all leaves the route simply absent.
 */
function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!env.adminToken) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const supplied = tokenFrom(req);
  if (!supplied || !matches(supplied)) {
    log.warn('admin.rejected', { path: req.path });
    res.status(404).json({ error: 'not_found' });
    return;
  }

  next();
}

/**
 * Never cached and never indexed: these responses hold spend and
 * conversations, and a shared browser cache is not the place for either.
 */
function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
}

/*
 * Applied per route rather than with router.use, because this router is
 * mounted at the root so it can own both /admin and /api/admin. As middleware
 * it would run for every request the app receives and 404 the lot.
 */
const guarded: RequestHandler[] = [requireToken, noStore];

/** Bounded so a stray ?days=3650 cannot ask for everything at once. */
function windowDays(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 7;
  return Math.min(Math.max(Math.round(parsed), 1), 7);
}

adminRouter.get('/admin', guarded, (req: Request, res: Response) => {
  // The page carries the token so its own fetches are authenticated. Serving
  // it already required the token, so this exposes nothing new.
  res.type('html').send(renderAdminPage(tokenFrom(req)));
});

adminRouter.get('/api/admin/usage', guarded, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await buildReport(windowDays(req.query.days)));
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/api/admin/usage/:sessionId', guarded, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId ?? '';
    if (!sessionId) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }

    const report = await buildReport(7);
    res.json({
      sessionId,
      session: report.sessions.find((row) => row.sessionId === sessionId) ?? null,
      transcript: await usage.transcript(sessionId),
    });
  } catch (err) {
    next(err);
  }
});
