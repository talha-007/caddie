import { describe, expect, it } from 'vitest';
import { recommendSize, toCm, toKg } from '../src/recommend/size.js';

/**
 * These lock the behaviour, not the numbers. When the real Druids size chart
 * replaces the placeholder on Day 4, expected sizes here will need updating -
 * the rules being tested should not.
 */

describe('unit conversion', () => {
  it('converts inches to cm', () => {
    expect(Math.round(toCm(70, 'in'))).toBe(178);
  });

  it('converts pounds to kg', () => {
    expect(Math.round(toKg(180, 'lb'))).toBe(82);
  });
});

describe('recommendSize', () => {
  it('asks for more when it has nothing to go on', () => {
    const result = recommendSize({});
    expect(result.size).toBeNull();
    expect(result.missing).toContain('height');
    expect(result.missing).toContain('weight');
  });

  it('recommends from height and weight', () => {
    const result = recommendSize({
      heightValue: 178,
      heightUnit: 'cm',
      weightValue: 78,
      weightUnit: 'kg',
    });
    expect(result.size).not.toBeNull();
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('treats imperial input the same as metric', () => {
    const metric = recommendSize({ heightValue: 178, heightUnit: 'cm', weightValue: 82, weightUnit: 'kg' });
    const imperial = recommendSize({ heightValue: 70, heightUnit: 'in', weightValue: 181, weightUnit: 'lb' });
    expect(imperial.size).toBe(metric.size);
  });

  it('sizes up for a relaxed fit and down for a tight one', () => {
    const base = { heightValue: 178, heightUnit: 'cm', weightValue: 78, weightUnit: 'kg' } as const;
    const regular = recommendSize({ ...base, fitPreference: 'regular' });
    const relaxed = recommendSize({ ...base, fitPreference: 'relaxed' });
    const tight = recommendSize({ ...base, fitPreference: 'tight' });

    expect(relaxed.size).not.toBe(regular.size);
    expect(tight.size).not.toBe(regular.size);
    expect(relaxed.size).not.toBe(tight.size);
  });

  it('prefers a chest measurement over height and weight', () => {
    const result = recommendSize({
      heightValue: 178,
      heightUnit: 'cm',
      weightValue: 78,
      weightUnit: 'kg',
      chestCm: 118,
    });
    expect(result.size).toBe('XL');
  });

  it('falls back to the usual size with low confidence', () => {
    const result = recommendSize({ usualSize: 'L' });
    expect(result.size).toBe('L');
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it('refuses a size it cannot support', () => {
    const result = recommendSize({ category: 'not-a-real-category', heightValue: 180 });
    expect(result.size).toBeNull();
  });

  it('never returns a size outside the chart', () => {
    const result = recommendSize({ heightValue: 210, heightUnit: 'cm', weightValue: 180, weightUnit: 'kg' });
    if (result.size) {
      expect(['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']).toContain(result.size);
    }
  });
});
