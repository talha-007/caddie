import { EventEmitter } from 'node:events';
import type { CaddieAttachment } from '@caddie/shared';
import { log } from '../lib/logger.js';
import { redis, redisSubscriber } from '../lib/redis.js';

/**
 * During a voice call the model speaks, but the cards have to appear on
 * screen. Tool results are published here and streamed to the widget over SSE,
 * so the UI stays in step with what the Caddie just said.
 *
 * Across instances this needs Redis, and it is the least obvious of the
 * shared-state problems: an SSE connection lives on whichever instance
 * accepted it, but the customer's next message can be handled by another. The
 * card would then be published into the wrong process and never reach the
 * screen, with nothing in the logs to say so.
 *
 * So every event goes out over Redis pub/sub, every instance listens, and each
 * delivers to whatever streams it happens to be holding. With no REDIS_URL it
 * is a plain in-process emitter, which is correct for a single instance.
 */

export interface CaddieEvent {
  type: 'attachment' | 'speech' | 'status';
  sessionId: string;
  at: string;
  attachment?: CaddieAttachment;
  text?: string;
}

const CHANNEL = 'caddie:events';

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let subscribed = false;

/** Starts listening for events raised on other instances. */
function ensureSubscribed(): void {
  if (subscribed) return;
  const sub = redisSubscriber();
  if (!sub) return;
  subscribed = true;

  sub.subscribe(CHANNEL).catch((err) => log.error('bus.subscribe_failed', { err: String(err) }));

  sub.on('message', (channel, payload) => {
    if (channel !== CHANNEL) return;
    try {
      const event = JSON.parse(payload) as CaddieEvent;
      // Deliver locally only; re-publishing would loop forever.
      emitter.emit(event.sessionId, event);
    } catch {
      log.warn('bus.unreadable_event');
    }
  });
}

export function publish(event: Omit<CaddieEvent, 'at'>): void {
  const full: CaddieEvent = { ...event, at: new Date().toISOString() };

  const client = redis();
  if (!client) {
    emitter.emit(full.sessionId, full);
    return;
  }

  /*
   * Published rather than emitted locally, and then delivered by the
   * subscription above - including back to this instance. One path for every
   * event means a card cannot arrive twice on the instance that made it and
   * once everywhere else.
   */
  client.publish(CHANNEL, JSON.stringify(full)).catch((err) => {
    log.warn('bus.publish_failed', { err: String(err) });
    // Redis is down; at least serve the customers on this instance.
    emitter.emit(full.sessionId, full);
  });
}

export function subscribe(sessionId: string, listener: (event: CaddieEvent) => void): () => void {
  ensureSubscribed();
  emitter.on(sessionId, listener);
  return () => emitter.off(sessionId, listener);
}

/** How many streams this instance is holding open. */
export function openStreams(): number {
  return emitter.eventNames().length;
}
