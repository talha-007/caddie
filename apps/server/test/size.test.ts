import { describe, expect, it } from 'vitest';
import { recommendSize, toCm, toKg } from '../src/recommend/size.js';

/**
 * The chest and waist figures these assert against are Druids' own published
 * charts (see data/size-chart.json). The height and weight cases assert our
 * inference, which is deliberately held to a lower confidence.
 */

describe('unit conversion', () => {
  it('converts inches to cm', () => {
    expect(Math.round(toCm(70, 'in'))).toBe(178);
  });

  it('converts pounds to kg', () => {
    expect(Math.round(toKg(180, 'lb'))).toBe(82);
  });
});

describe('recommendSize, against the published chart', () => {
  it('reads a chest measurement straight off the Druids chart', () => {
    // 100cm sits inside M (96-104).
    const result = recommendSize({ audience: 'men', chestCm: 100 });
    expect(result.size).toBe('M');
    expect(result.basis).toBe('measurement');
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('handles the whole published range', () => {
    const cases: Array<[number, string]> = [
      [92, 'S'],
      [100, 'M'],
      [108, 'L'],
      [116, 'XL'],
      [124, '2XL'],
      [132, '3XL'],
      [140, '4XL'],
    ];
    for (const [chestCm, expected] of cases) {
      expect(recommendSize({ audience: 'men', chestCm }).size).toBe(expected);
    }
  });

  it('sizes shorts off the waist', () => {
    // 88cm sits inside the 34 band (86-91).
    const result = recommendSize({ audience: 'men', waistCm: 88, category: 'shorts' });
    expect(result.size).toBe('34');
    expect(result.basis).toBe('measurement');
  });

  it('sizes trousers off the waist', () => {
    expect(recommendSize({ audience: 'men', waistCm: 93, category: 'trousers' }).size).toBe('36');
  });
});

describe('recommendSize, without a measurement', () => {
  it('asks for more when it has nothing to go on', () => {
    const result = recommendSize({ audience: 'men' });
    expect(result.size).toBeNull();
    expect(result.basis).toBe('none');
    expect(result.missing).toContain('height');
  });

  it('estimates from height and weight, but says so', () => {
    const result = recommendSize({
      audience: 'men',
      heightValue: 180,
      heightUnit: 'cm',
      weightValue: 80,
      weightUnit: 'kg',
    });
    expect(result.size).not.toBeNull();
    expect(result.basis).toBe('estimate');
    expect(result.reason).toMatch(/estimate/i);
  });

  it('never lets an estimate claim measurement-level confidence', () => {
    const estimate = recommendSize({ audience: 'men', heightValue: 180, heightUnit: 'cm', weightValue: 80, weightUnit: 'kg' });
    const measured = recommendSize({ audience: 'men', chestCm: 100 });
    expect(estimate.confidence).toBeLessThanOrEqual(0.55);
    expect(measured.confidence).toBeGreaterThan(estimate.confidence);
  });

  it('offers Druids own measuring advice when it is only estimating', () => {
    const result = recommendSize({ audience: 'men', heightValue: 180, heightUnit: 'cm', weightValue: 80, weightUnit: 'kg' });
    expect(result.measureAdvice).toMatch(/fullest part of the chest/i);
  });

  it('a real measurement beats height and weight', () => {
    // Height and weight alone would say M; a 118cm chest is XL on the chart.
    const result = recommendSize({
      audience: 'men',
      heightValue: 180,
      heightUnit: 'cm',
      weightValue: 80,
      weightUnit: 'kg',
      chestCm: 118,
    });
    expect(result.size).toBe('XL');
  });

  it('falls back to the usual size with low confidence', () => {
    const result = recommendSize({ audience: 'men', usualSize: 'L' });
    expect(result.size).toBe('L');
    expect(result.basis).toBe('usual-size');
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe('fit preference', () => {
  it('sizes up for relaxed and down for tight', () => {
    const base = { audience: 'men', chestCm: 100 } as const;
    const regular = recommendSize({ ...base, fitPreference: 'regular' });
    const relaxed = recommendSize({ ...base, fitPreference: 'relaxed' });
    const tight = recommendSize({ ...base, fitPreference: 'tight' });

    expect(regular.size).toBe('M');
    expect(relaxed.size).toBe('L');
    expect(tight.size).toBe('S');
  });
});

describe('edges', () => {
  it('refuses a chart it does not have', () => {
    expect(recommendSize({ audience: 'men', category: 'not-a-real-category', chestCm: 100 }).size).toBeNull();
  });

  it('never returns a size outside the chart', () => {
    const result = recommendSize({ audience: 'men', chestCm: 250 });
    if (result.size) {
      expect(['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL']).toContain(result.size);
    }
  });
});

describe('mens and womens are different systems', () => {
  it('refuses to answer without knowing which range', () => {
    const result = recommendSize({ chestCm: 100 });
    expect(result.size).toBeNull();
    expect(result.missing).toContain('audience');
    expect(result.reason).toMatch(/mens or the womens/i);
  });

  it('gives a UK dress size for womens, not a letter size', () => {
    const result = recommendSize({ audience: 'women', chestCm: 100 });
    expect(result.size).toBe('12');
    expect(result.basis).toBe('measurement');
  });

  it('gives a different answer per audience for the same chest', () => {
    const men = recommendSize({ audience: 'men', chestCm: 100 });
    const women = recommendSize({ audience: 'women', chestCm: 100 });
    expect(men.size).toBe('M');
    expect(women.size).toBe('12');
  });

  it('sizes womens shorts on the womens waist chart', () => {
    // 82cm is a womens 14 (81-84), but a mens 32 (81-86).
    expect(recommendSize({ audience: 'women', waistCm: 82, category: 'shorts' }).size).toBe('14');
    expect(recommendSize({ audience: 'men', waistCm: 82, category: 'shorts' }).size).toBe('32');
  });

  it('has skorts for women and not for men', () => {
    expect(recommendSize({ audience: 'women', waistCm: 78, category: 'skort' }).size).toBe('12');
    expect(recommendSize({ audience: 'men', waistCm: 78, category: 'skort' }).size).toBeNull();
  });
});

describe('categories beyond tops and bottoms', () => {
  it('resolves spoken category names to the right chart', () => {
    // A hoodie shares the polo chest chart.
    expect(recommendSize({ audience: 'men', chestCm: 108, category: 'hoodie' }).size).toBe('L');
    expect(recommendSize({ audience: 'men', chestCm: 108, category: 'gilet' }).size).toBe('L');
    expect(recommendSize({ audience: 'men', waistCm: 88, category: 'joggers' }).size).toBe('34');
  });

  it('sizes belts', () => {
    expect(recommendSize({ audience: 'men', waistCm: 82, category: 'belt' }).size).toBe('M/L');
    expect(recommendSize({ audience: 'men', waistCm: 96, category: 'belt' }).size).toBe('XL/2XL');
  });

  it('refuses to size socks, because Druids publishes no chart', () => {
    const result = recommendSize({ audience: 'men', waistCm: 82, category: 'socks' });
    expect(result.size).toBeNull();
    expect(result.reason).toMatch(/varies by style/i);
  });
});
