import { describe, expect, it } from 'vitest';
import { consume, LIMITS, resetLimits } from '../src/lib/rateLimit.js';

describe('rate limiting', () => {
  it('allows a normal conversation and stops a script', () => {
    resetLimits();
    const limit = { max: 3, windowMs: 60_000 };
    expect(consume('a', limit).ok).toBe(true);
    expect(consume('a', limit).ok).toBe(true);
    expect(consume('a', limit).ok).toBe(true);

    const blocked = consume('a', limit);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it('keeps keys apart, so one customer cannot lock out another', () => {
    resetLimits();
    const limit = { max: 1, windowMs: 60_000 };
    expect(consume('one', limit).ok).toBe(true);
    expect(consume('one', limit).ok).toBe(false);
    expect(consume('two', limit).ok).toBe(true);
  });

  it('lets a session through again once the window passes', () => {
    resetLimits();
    const limit = { max: 1, windowMs: 1 };
    expect(consume('b', limit).ok).toBe(true);
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(consume('b', limit).ok).toBe(true);
        resolve(undefined);
      }, 5);
    });
  });

  it('gives a real conversation room to breathe', () => {
    // A dozen turns is a long conversation; the limit must not bite first.
    expect(LIMITS.perSession.max).toBeGreaterThan(20);
    expect(LIMITS.voicePerSession.max).toBeLessThanOrEqual(LIMITS.perSession.max);
  });
});
