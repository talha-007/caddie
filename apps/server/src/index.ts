import { pathToFileURL } from 'node:url';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { startCatalogueSync } from './catalog/sync.js';
import { env } from './env.js';
import { CaddieError } from './lib/errors.js';
import { log } from './lib/logger.js';
import { chatRouter } from './routes/chat.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { toolsRouter } from './routes/tools.js';
import { ucpRouter } from './routes/ucp.js';
import { voiceRouter } from './routes/voice.js';
import { vapiRouter } from './routes/vapi.js';

export function createApp() {
  const app = express();

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
  // Pull the catalogue now and keep it warm. Everything customer-facing reads
  // the mirror, so Shopify's throttled endpoint is never in the hot path.
  startCatalogueSync();

  createApp().listen(env.port, () => {
    log.info('caddie.server.listening', {
      port: env.port,
      env: env.nodeEnv,
      chat: env.openai.apiKey ? `openai:${env.openai.model}` : env.vapi.privateKey ? 'vapi' : 'dev-router',
    });
  });
}
