import { isPriced, priceOf } from './pricing.js';
import type { UsageEvent, UsageKind } from './store.js';
import { usage } from './store.js';

/**
 * Turns raw events into the numbers the dashboard shows.
 *
 * Kept apart from the route so the arithmetic can be tested without a server,
 * and apart from the store so it does not care whether the events came from
 * memory or Redis.
 */

export interface KindRow {
  kind: UsageKind;
  calls: number;
  costUsd: number;
  /** Share of total spend, 0-1. Where the money actually goes. */
  share: number;
}

export interface ModelRow {
  model: string;
  calls: number;
  costUsd: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  cacheHitRate: number;
  priced: boolean;
}

export interface DayRow {
  day: string;
  costUsd: number;
  conversations: number;
  turns: number;
}

export interface SessionRow {
  sessionId: string;
  firstAt: number;
  lastAt: number;
  turns: number;
  costUsd: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  /** Messages the guard turned away. A high count is someone probing it. */
  declined: number;
  voiceSeconds: number;
  client: string | null;
}

export interface UsageReport {
  generatedAt: number;
  windowDays: number;
  totals: {
    costUsd: number;
    conversations: number;
    turns: number;
    promptTokens: number;
    cachedTokens: number;
    completionTokens: number;
    cacheHitRate: number;
    voiceSeconds: number;
    declined: number;
    costPerThousandConversations: number;
    /** The cost we would have paid with no prompt caching at all. */
    costWithoutCacheUsd: number;
  };
  byKind: KindRow[];
  byModel: ModelRow[];
  byDay: DayRow[];
  sessions: SessionRow[];
  /**
   * Models we saw but hold no rate for, so their spend reads as zero. Shown
   * on the dashboard rather than swallowed - a cost screen that silently
   * undercounts is worse than one that admits a gap.
   */
  unpricedModels: string[];
}

function rate(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** UTC, and labelled as such on screen - the team is not all in one place. */
function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function summarise(events: UsageEvent[], windowDays: number): UsageReport {
  const totals = {
    costUsd: 0,
    conversations: 0,
    turns: 0,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    cacheHitRate: 0,
    voiceSeconds: 0,
    declined: 0,
    costPerThousandConversations: 0,
    costWithoutCacheUsd: 0,
  };

  const kinds = new Map<UsageKind, KindRow>();
  const models = new Map<string, ModelRow>();
  const days = new Map<string, { costUsd: number; turns: number; sessions: Set<string> }>();
  const sessions = new Map<string, SessionRow>();
  const unpriced = new Set<string>();

  for (const event of events) {
    totals.costUsd += event.costUsd;
    totals.promptTokens += event.promptTokens;
    totals.cachedTokens += event.cachedTokens;
    totals.completionTokens += event.completionTokens;
    totals.voiceSeconds += event.audioSeconds;
    if (event.kind === 'chat') totals.turns += 1;
    if (event.outcome && event.outcome !== 'allow') totals.declined += 1;

    if (!isPriced(event.model)) unpriced.add(event.model);

    /*
     * What the same turn would have cost with nothing cached. The gap between
     * this and the real figure is what the long stable prompt buys us, and the
     * reason shortening it made things more expensive.
     */
    const price = priceOf(event.model);
    if (price) {
      totals.costWithoutCacheUsd +=
        (event.promptTokens * price.input + event.completionTokens * price.output) / 1_000_000;
    }

    const kind = kinds.get(event.kind) ?? { kind: event.kind, calls: 0, costUsd: 0, share: 0 };
    kind.calls += 1;
    kind.costUsd += event.costUsd;
    kinds.set(event.kind, kind);

    const model = models.get(event.model) ?? {
      model: event.model,
      calls: 0,
      costUsd: 0,
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
      cacheHitRate: 0,
      priced: isPriced(event.model),
    };
    model.calls += 1;
    model.costUsd += event.costUsd;
    model.promptTokens += event.promptTokens;
    model.cachedTokens += event.cachedTokens;
    model.completionTokens += event.completionTokens;
    models.set(event.model, model);

    const day = days.get(dayOf(event.at)) ?? { costUsd: 0, turns: 0, sessions: new Set<string>() };
    day.costUsd += event.costUsd;
    if (event.kind === 'chat') day.turns += 1;
    day.sessions.add(event.sessionId);
    days.set(dayOf(event.at), day);

    const session = sessions.get(event.sessionId) ?? {
      sessionId: event.sessionId,
      firstAt: event.at,
      lastAt: event.at,
      turns: 0,
      costUsd: 0,
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
      declined: 0,
      voiceSeconds: 0,
      client: event.client ?? null,
    };
    session.firstAt = Math.min(session.firstAt, event.at);
    session.lastAt = Math.max(session.lastAt, event.at);
    session.costUsd += event.costUsd;
    session.promptTokens += event.promptTokens;
    session.cachedTokens += event.cachedTokens;
    session.completionTokens += event.completionTokens;
    session.voiceSeconds += event.audioSeconds;
    if (event.kind === 'chat') session.turns += 1;
    if (event.outcome && event.outcome !== 'allow') session.declined += 1;
    if (!session.client && event.client) session.client = event.client;
    sessions.set(event.sessionId, session);
  }

  totals.conversations = sessions.size;
  totals.cacheHitRate = rate(totals.cachedTokens, totals.promptTokens);
  totals.costPerThousandConversations =
    totals.conversations > 0 ? (totals.costUsd / totals.conversations) * 1000 : 0;

  for (const row of kinds.values()) row.share = rate(row.costUsd, totals.costUsd);
  for (const row of models.values()) row.cacheHitRate = rate(row.cachedTokens, row.promptTokens);

  return {
    generatedAt: Date.now(),
    windowDays,
    totals,
    byKind: [...kinds.values()].sort((a, b) => b.costUsd - a.costUsd),
    byModel: [...models.values()].sort((a, b) => b.costUsd - a.costUsd),
    byDay: [...days.entries()]
      .map(([day, value]) => ({
        day,
        costUsd: value.costUsd,
        conversations: value.sessions.size,
        turns: value.turns,
      }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    sessions: [...sessions.values()].sort((a, b) => b.lastAt - a.lastAt),
    unpricedModels: [...unpriced],
  };
}

export async function buildReport(windowDays: number): Promise<UsageReport> {
  const events = await usage.since(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  return summarise(events, windowDays);
}
