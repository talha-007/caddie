import { log } from '../lib/logger.js';
import { redis, redisEnabled } from '../lib/redis.js';

/**
 * What we spent, and on whose conversation.
 *
 * Every paid call the server makes records one of these: the chat loop, the
 * guard that screens messages before it, and voice transcription. Until this
 * existed the tokens were logged and nothing else, so "what does this cost"
 * could only be answered by reading logs, and "who is using it" not at all -
 * the turn log carried no session id.
 *
 * Two rules it has to keep:
 *
 *  - **Never break a turn.** Recording is bookkeeping. Every write is caught
 *    and dropped on the floor rather than failing a customer's message.
 *  - **Never grow without bound.** At a thousand active sessions this is the
 *    one structure that sees every single turn, so it is capped by both age
 *    and count, in memory and in Redis.
 */

export type UsageKind = 'chat' | 'guard' | 'transcribe';

export interface UsageEvent {
  at: number;
  sessionId: string;
  kind: UsageKind;
  model: string;
  promptTokens: number;
  /** Of `promptTokens`, how many were served from the prompt cache. */
  cachedTokens: number;
  completionTokens: number;
  audioSeconds: number;
  costUsd: number;
  ms: number;
  /** Model round trips in the turn, for chat. */
  steps?: number;
  /** For the guard: what it decided, so refusals can be counted. */
  outcome?: string;
  /**
   * A short hash of the caller's address, not the address itself.
   *
   * Enough to see that one client is burning the budget, or that fifty
   * sessions are really one script. Keeping the raw address would make this an
   * ops screen holding personal data for a week, for no extra answer.
   */
  client?: string;
}

export interface TranscriptLine {
  at: number;
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Seven days, agreed deliberately. Long enough to read back why a conversation
 * went wrong on Monday; short enough that what customers typed does not pile
 * up indefinitely. Both stores expire on the same clock.
 */
const RETENTION_MS = 1000 * 60 * 60 * 24 * 7;
const RETENTION_SECONDS = Math.floor(RETENTION_MS / 1000);

/**
 * Caps, for the case the retention window alone is not enough. A busy day on
 * the real store is far more than the test one, and an ops screen is not worth
 * a server running out of memory.
 */
const MAX_EVENTS = 50_000;
const MAX_LINES_PER_SESSION = 80;
/** Matches the chat route's own input cap, so nothing is truncated twice. */
const MAX_TEXT = 2000;

export interface UsageStore {
  record(event: UsageEvent): Promise<void>;
  recordMessage(sessionId: string, line: TranscriptLine): Promise<void>;
  /** Newest first. */
  since(fromMs: number): Promise<UsageEvent[]>;
  transcript(sessionId: string): Promise<TranscriptLine[]>;
}

function trimText(text: string): string {
  const clean = text.trim();
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}...` : clean;
}

class MemoryUsageStore implements UsageStore {
  private events: UsageEvent[] = [];
  private readonly transcripts = new Map<string, TranscriptLine[]>();

  async record(event: UsageEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    this.sweep();
  }

  async recordMessage(sessionId: string, line: TranscriptLine): Promise<void> {
    const lines = this.transcripts.get(sessionId) ?? [];
    lines.push({ ...line, text: trimText(line.text) });
    this.transcripts.set(sessionId, lines.slice(-MAX_LINES_PER_SESSION));
  }

  async since(fromMs: number): Promise<UsageEvent[]> {
    return this.events.filter((event) => event.at >= fromMs).sort((a, b) => b.at - a.at);
  }

  async transcript(sessionId: string): Promise<TranscriptLine[]> {
    return [...(this.transcripts.get(sessionId) ?? [])].sort((a, b) => a.at - b.at);
  }

  private sweep(): void {
    const cutoff = Date.now() - RETENTION_MS;
    if (this.events.length && this.events[0]!.at < cutoff) {
      this.events = this.events.filter((event) => event.at >= cutoff);
    }
    for (const [id, lines] of this.transcripts) {
      const last = lines[lines.length - 1];
      if (!last || last.at < cutoff) this.transcripts.delete(id);
    }
  }
}

const EVENTS_KEY = 'usage:events';
const convoKey = (sessionId: string) => `usage:convo:${sessionId}`;

/**
 * Shared, because the dashboard is meant to show the whole fleet.
 *
 * Per-instance counters would show one process's slice and silently
 * understate everything - the same trap the rate limiter had.
 */
class RedisUsageStore implements UsageStore {
  async record(event: UsageEvent): Promise<void> {
    const client = redis();
    if (!client) return;

    // A sorted set scored by time, so expiry and "since" are the same query.
    await client
      .multi()
      .zadd(EVENTS_KEY, event.at, JSON.stringify(event))
      .zremrangebyscore(EVENTS_KEY, '-inf', Date.now() - RETENTION_MS)
      .zremrangebyrank(EVENTS_KEY, 0, -(MAX_EVENTS + 1))
      .exec();
  }

  async recordMessage(sessionId: string, line: TranscriptLine): Promise<void> {
    const client = redis();
    if (!client) return;

    const key = convoKey(sessionId);
    await client
      .multi()
      .rpush(key, JSON.stringify({ ...line, text: trimText(line.text) }))
      .ltrim(key, -MAX_LINES_PER_SESSION, -1)
      .expire(key, RETENTION_SECONDS)
      .exec();
  }

  async since(fromMs: number): Promise<UsageEvent[]> {
    const client = redis();
    if (!client) return [];

    const raw = await client.zrevrangebyscore(EVENTS_KEY, '+inf', fromMs);
    return raw.map(parseEvent).filter((event): event is UsageEvent => event !== null);
  }

  async transcript(sessionId: string): Promise<TranscriptLine[]> {
    const client = redis();
    if (!client) return [];

    const raw = await client.lrange(convoKey(sessionId), 0, -1);
    return raw.map(parseLine).filter((line): line is TranscriptLine => line !== null);
  }
}

function parseEvent(raw: string): UsageEvent | null {
  try {
    return JSON.parse(raw) as UsageEvent;
  } catch {
    return null;
  }
}

function parseLine(raw: string): TranscriptLine | null {
  try {
    return JSON.parse(raw) as TranscriptLine;
  } catch {
    return null;
  }
}

export const usage: UsageStore = redisEnabled() ? new RedisUsageStore() : new MemoryUsageStore();

/**
 * Fire and forget.
 *
 * Called from the middle of a customer's turn, so it must not be awaited into
 * the response path and must not throw out of it. A dropped usage row costs us
 * a line on a dashboard; a thrown one costs the customer their answer.
 */
export function record(event: UsageEvent): void {
  void usage.record(event).catch((err) => log.warn('usage.record_failed', { err: String(err) }));
}

export function recordMessage(sessionId: string, role: TranscriptLine['role'], text: string): void {
  if (!text.trim()) return;
  void usage
    .recordMessage(sessionId, { at: Date.now(), role, text })
    .catch((err) => log.warn('usage.message_failed', { err: String(err) }));
}

export { RETENTION_MS };
