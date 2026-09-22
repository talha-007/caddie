import { EventEmitter } from 'node:events';
import type { CaddieAttachment } from '@caddie/shared';

/**
 * During a voice call the model speaks, but the cards have to appear on screen.
 * Tool results are published here and streamed to the widget over SSE, so the
 * UI stays in step with what the Caddie just said.
 */

export interface CaddieEvent {
  type: 'attachment' | 'speech' | 'status';
  sessionId: string;
  at: string;
  attachment?: CaddieAttachment;
  text?: string;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publish(event: Omit<CaddieEvent, 'at'>): void {
  emitter.emit(event.sessionId, { ...event, at: new Date().toISOString() } satisfies CaddieEvent);
}

export function subscribe(sessionId: string, listener: (event: CaddieEvent) => void): () => void {
  emitter.on(sessionId, listener);
  return () => emitter.off(sessionId, listener);
}
