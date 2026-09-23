import { describe, expect, it } from 'vitest';
import { costOfAudio, costOfTokens, isPriced, priceOf } from '../src/usage/pricing.js';
import { summarise } from '../src/usage/report.js';
import type { UsageEvent } from '../src/usage/store.js';

function event(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    at: Date.parse('2026-09-23T10:00:00Z'),
    sessionId: 's1',
    kind: 'chat',
    model: 'gpt-4.1-mini',
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    audioSeconds: 0,
    costUsd: 0,
    ms: 0,
    ...over,
  };
}

describe('what a call costs', () => {
  /*
   * The one that matters. OpenAI's prompt_tokens already includes the cached
   * ones, so billing both at the full input rate - the obvious reading -
   * overstates a cached turn roughly fourfold. At the ~85% hit rate we run at,
   * that is most turns, and the dashboard would have been wrong about the
   * single number it exists to report.
   */
  it('bills cached input at the cached rate and does not count it twice', () => {
    // 1,000 prompt of which 800 cached, so 200 fresh.
    const cost = costOfTokens('gpt-4.1-mini', 1000, 800, 100);

    const fresh = (200 * 0.4) / 1_000_000;
    const cached = (800 * 0.1) / 1_000_000;
    const output = (100 * 1.6) / 1_000_000;

    expect(cost).toBeCloseTo(fresh + cached + output, 12);
  });

  it('is cheaper with a cache hit than without', () => {
    const cold = costOfTokens('gpt-4.1-mini', 1000, 0, 100);
    const warm = costOfTokens('gpt-4.1-mini', 1000, 900, 100);
    expect(warm).toBeLessThan(cold);
  });

  it('survives a cached count larger than the prompt', () => {
    // Nonsense from upstream should not produce a negative bill.
    expect(costOfTokens('gpt-4.1-mini', 100, 500, 0)).toBeGreaterThanOrEqual(0);
  });

  it('prices a dated model name as its base model', () => {
    expect(costOfTokens('gpt-4.1-mini-2025-04-14', 1000, 0, 0)).toBe(costOfTokens('gpt-4.1-mini', 1000, 0, 0));
  });

  /* gpt-4.1-mini starts with gpt-4.1, and gpt-4.1 is five times the price. */
  it('does not let a mini model fall through to its full-size namesake', () => {
    expect(priceOf('gpt-4.1-mini')?.input).toBe(0.4);
    expect(priceOf('gpt-4.1-nano')?.input).toBe(0.1);
    expect(priceOf('gpt-4.1')?.input).toBe(2.0);
  });

  it('says so rather than guessing when it holds no rate', () => {
    expect(isPriced('some-new-model')).toBe(false);
    expect(costOfTokens('some-new-model', 10_000, 0, 5_000)).toBe(0);
  });

  it('bills transcription by the minute', () => {
    expect(costOfAudio('gpt-4o-mini-transcribe', 60)).toBeCloseTo(0.003, 10);
    expect(costOfAudio('gpt-4o-mini-transcribe', 30)).toBeCloseTo(0.0015, 10);
  });
});

describe('the usage report', () => {
  const events: UsageEvent[] = [
    event({ sessionId: 'a', costUsd: 0.01, promptTokens: 1000, cachedTokens: 800, completionTokens: 50 }),
    event({ sessionId: 'a', costUsd: 0.02, promptTokens: 2000, cachedTokens: 1600, completionTokens: 90 }),
    event({ sessionId: 'b', costUsd: 0.03, promptTokens: 1000, cachedTokens: 0, completionTokens: 40 }),
    event({ sessionId: 'b', kind: 'guard', model: 'gpt-4.1-nano', costUsd: 0.001, promptTokens: 120, outcome: 'off_topic' }),
    event({ sessionId: 'c', kind: 'transcribe', model: 'gpt-4o-mini-transcribe', costUsd: 0.002, audioSeconds: 40 }),
  ];

  const report = summarise(events, 7);

  it('counts a conversation once however many turns it took', () => {
    expect(report.totals.conversations).toBe(3);
    expect(report.totals.turns).toBe(3);
  });

  it('adds the spend up across every kind of call', () => {
    expect(report.totals.costUsd).toBeCloseTo(0.063, 10);
  });

  it('scales to a thousand conversations, which is how we quote it', () => {
    expect(report.totals.costPerThousandConversations).toBeCloseTo((0.063 / 3) * 1000, 6);
  });

  it('counts what the guard turned away', () => {
    expect(report.totals.declined).toBe(1);
    expect(report.sessions.find((s) => s.sessionId === 'b')?.declined).toBe(1);
  });

  it('puts the most expensive kind of call first', () => {
    expect(report.byKind[0]?.kind).toBe('chat');
    expect(report.byKind.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 6);
  });

  it('keeps voice seconds against the session that spoke', () => {
    expect(report.sessions.find((s) => s.sessionId === 'c')?.voiceSeconds).toBe(40);
  });

  /*
   * A cost screen that silently reads zero for a model nobody priced is worse
   * than one that admits the gap, so the gap is part of the report.
   */
  it('names any model it has no rate for', () => {
    const withUnknown = summarise([event({ model: 'gpt-9-turbo' })], 7);
    expect(withUnknown.unpricedModels).toContain('gpt-9-turbo');
  });

  it('shows what caching saved', () => {
    expect(report.totals.costWithoutCacheUsd).toBeGreaterThan(0);
    expect(report.totals.cacheHitRate).toBeGreaterThan(0);
  });

  it('is empty rather than broken with nothing to report', () => {
    const empty = summarise([], 7);
    expect(empty.totals.costUsd).toBe(0);
    expect(empty.totals.costPerThousandConversations).toBe(0);
    expect(empty.totals.cacheHitRate).toBe(0);
    expect(empty.sessions).toEqual([]);
  });
});
