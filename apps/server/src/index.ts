import { pathToFileURL } from 'node:url';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { startCatalogueSync, stopCatalogueSync, syncCatalogue } from './catalog/sync.js';
import { verifyEnvironment } from './startupCheck.js';
import { env } from './env.js';
import { CaddieError } from './lib/errors.js';
import { log } from './lib/logger.js';
import { adminRouter } from './routes/admin.js';
import { chatRouter } from './routes/chat.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { toolsRouter } from './routes/tools.js';
import { shopifyWebhookRouter } from './routes/shopifyWebhook.js';
import { ucpRouter } from './routes/ucp.js';
import { voiceRouter } from './routes/voice.js';
import { vapiRouter } from './routes/vapi.js';

export function createApp() {
  const app = express();

  /*
   * Before the JSON parser, on purpose. Shopify signs the exact bytes it
   * sent, and once express.json has turned the body into an object those
   * bytes are gone - the HMAC cannot be checked, and every webhook is
   * rejected or, worse, crashes on a body that is not a Buffer.
   */
  app.use('/api/shopify/webhook', shopifyWebhookRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(
    cors({
      /*
       * Any origin in development, the allow-list in production.
       *
       * Device testing serves the widget from whatever tunnel the tester has
       * open, so its origin is not knowable in advance. Pinning the list in
       * dev just means someone loses an afternoon to a CORS error on a phone.
       * CORS_ORIGINS still applies in production, where it matters.
       */
      origin: env.isProd ? (env.corsOrigins.includes('*') ? true : env.corsOrigins) : true,
      credentials: false,
    }),
  );

  app.use('/health', healthRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/tools', toolsRouter);
  app.use('/api/voice', voiceRouter);
  app.use('/api/vapi', vapiRouter);
  app.use('/ucp', ucpRouter);
  // Owns both /admin and /api/admin, so it mounts at the root.
  app.use(adminRouter);

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof CaddieError) {
      log.warn('request.failed', { code: err.code, message: err.message });
      return res.status(err.status).json({ error: err.code, detail: err.message });
    }
    log.error('request.crashed', { err: String(err) });
    return res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

const isEntrypoint = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isEntrypoint) {
  /*
   * One bad request must not take the server down for everyone.
   *
   * A malformed webhook did exactly that once: it threw inside an async
   * handler, which Node treats as an unhandled rejection and, by default,
   * fatal. Logging and carrying on is right for a rejection - the request
   * that caused it has already failed, and the rest of the process is fine.
   *
   * An uncaught exception is different: the process may be in an unknown
   * state, so it says so and leaves, and whatever supervises it starts a
   * clean one.
   */
  process.on('unhandledRejection', (reason) => {
    log.error('process.unhandled_rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (err) => {
    log.error('process.uncaught_exception', { err: String(err), stack: err.stack });
    process.exit(1);
  });

  /*
   * Pull the catalogue before taking traffic.
   *
   * The full range is about 2,400 products and takes twenty-odd seconds. Until
   * it lands, searches fall back to Shopify's throttled endpoint - and a
   * restart under load would send every waiting customer at the one thing the
   * mirror exists to avoid. Better to start a few seconds later.
   */
  const boot = async () => {
    /*
     * Before anything else, and fatal on purpose.
     *
     * A box with half its environment missing should fail here with the
     * variable named, not on a customer's first message. It has to exit
     * rather than throw: the unhandledRejection handler logs and survives,
     * which is right for one bad request and wrong for a bad deploy - the
     * orchestrator needs a non-zero exit to know the release failed instead
     * of leaving a half-alive instance in the load balancer.
     */
    try {
      verifyEnvironment();
    } catch (err) {
      log.error('env.invalid', { err: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }

    try {
      const state = await syncCatalogue();
      log.info('catalogue.ready', { products: state.count });
    } catch (err) {
      // Start anyway: the delta and reconcile timers will keep trying, and a
      // Caddie that cannot search is still better than no server at all.
      log.error('catalogue.boot_failed', { err: String(err) });
    }

    startCatalogueSync();

    const server = createApp().listen(env.port, () => {
      log.info('caddie.server.listening', {
        port: env.port,
        env: env.nodeEnv,
        chat: env.openai.apiKey ? `openai:${env.openai.model}` : env.vapi.privateKey ? 'vapi' : 'dev-router',
      });
    });

    /*
     * Finish what is in flight before going.
     *
     * A deploy in the middle of a conversation should not drop it - a model
     * call can be several seconds, and cutting it leaves the customer with a
     * spinner and us with a charge for an answer nobody read. SSE streams are
     * long-lived by design, so there is a cap on how long we wait for them.
     */
    let closing = false;
    const shutdown = (signal: string) => {
      if (closing) return;
      closing = true;
      log.info('caddie.server.closing', { signal });

      stopCatalogueSync();
      server.close(() => {
        log.info('caddie.server.closed');
        process.exit(0);
      });

      setTimeout(() => {
        log.warn('caddie.server.forced', { after: '15s' });
        process.exit(0);
      }, 15_000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  };

  void boot();
}
