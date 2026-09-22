import { Router } from 'express';
import { subscribe } from '../session/bus.js';

/**
 * Server-sent events for one session.
 *
 * The widget opens this as soon as it has a sessionId. During a voice call the
 * model speaks while the cards arrive here, so the screen matches the words.
 */

export const eventsRouter: Router = Router();

eventsRouter.get('/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);

  const unsubscribe = subscribe(sessionId, (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  // Proxies and load balancers drop idle streams; a comment every 20s keeps it open.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});
