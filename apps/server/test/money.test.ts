import { describe, expect, it } from 'vitest';
import { addMoney, decimalsFor, fromMinorUnits, readMoney, toMinorUnits } from '../src/shopify/money.js';
import { authHeader } from '../src/shopify/storefrontCart.js';

/**
 * UCP quotes prices in minor units. Getting this wrong makes the Caddie say a
 * price that is out by a factor of 100, so it is worth pinning down.
 */

describe('minor units', () => {
  it('converts two-decimal currencies', () => {
    expect(fromMinorUnits(2400, 'PKR')).toEqual({ amount: 24, currency: 'PKR' });
    expect(fromMinorUnits(600, 'USD')).toEqual({ amount: 6, currency: 'USD' });
    expect(fromMinorUnits(12999, 'GBP')).toEqual({ amount: 129.99, currency: 'GBP' });
  });

  it('leaves zero-decimal currencies whole', () => {
    expect(decimalsFor('JPY')).toBe(0);
    expect(fromMinorUnits(2500, 'JPY')).toEqual({ amount: 2500, currency: 'JPY' });
  });

  it('handles three-decimal currencies', () => {
    expect(decimalsFor('KWD')).toBe(3);
    expect(fromMinorUnits(1500, 'KWD')).toEqual({ amount: 1.5, currency: 'KWD' });
  });

  it('round trips', () => {
    for (const [minor, currency] of [
      [12999, 'GBP'],
      [2500, 'JPY'],
      [1500, 'KWD'],
    ] as const) {
      expect(toMinorUnits(fromMinorUnits(minor, currency))).toBe(minor);
    }
  });

  it('reads a bare integer using the parent currency', () => {
    // Cart totals carry the amount only; the currency sits on the cart.
    expect(readMoney(4800, 'PKR')).toEqual({ amount: 48, currency: 'PKR' });
  });

  it('reads a money object and ignores the fallback', () => {
    expect(readMoney({ amount: 600, currency: 'USD' }, 'GBP')).toEqual({ amount: 6, currency: 'USD' });
  });

  it('does not accumulate float error when adding', () => {
    const total = addMoney([
      { amount: 0.1, currency: 'GBP' },
      { amount: 0.2, currency: 'GBP' },
    ]);
    expect(total).toEqual({ amount: 0.3, currency: 'GBP' });
  });
});

/**
 * Sending a private Storefront token in the public header returns a 401 with
 * an empty message, which reads exactly like a bad token. The token had just
 * been issued, so that is how it was read - and the wrong thing was replaced
 * before anyone tried the other header.
 */
describe('which header a Storefront token goes in', () => {
  it('sends a shpat_ token as a private token', () => {
    expect(authHeader('shpat_0123456789abcdef')).toEqual({
      'Shopify-Storefront-Private-Token': 'shpat_0123456789abcdef',
    });
  });

  it('sends a bare 32-character token as a public one', () => {
    const token = 'a'.repeat(32);
    expect(authHeader(token)).toEqual({ 'X-Shopify-Storefront-Access-Token': token });
  });

  it('never sends both, so a 401 is never ambiguous', () => {
    for (const token of ['shpat_abc', 'b'.repeat(32)]) {
      expect(Object.keys(authHeader(token))).toHaveLength(1);
    }
  });
});
