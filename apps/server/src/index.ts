import { pathToFileURL } from 'node:url';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
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
      origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
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
  createApp().listen(env.port, () => {
    log.info('caddie.server.listening', {
      port: env.port,
      env: env.nodeEnv,
      chat: env.openai.apiKey ? `openai:${env.openai.model}` : env.vapi.privateKey ? 'vapi' : 'dev-router',
    });
  });
}
