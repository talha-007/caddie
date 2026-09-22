import type { Money } from '@caddie/shared';
import { env } from '../env.js';

/**
 * UCP quotes every price as an integer in the currency's ISO 4217 minor units,
 * paired with a currency code: { amount: 2400, currency: "PKR" } is PKR 24.00.
 *
 * We convert to major units here, at the edge, so nothing downstream - and
 * above all nothing the Caddie says out loud - is ever out by a factor of 100.
 */

/** Currencies with no minor unit. Everything else is assumed to have two. */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'UYI',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/** Currencies with three minor digits. */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** What a bare number from the customer means - the store's own currency. */
export function storeCurrency(): string {
  return env.shopify.defaultCurrency;
}

export function decimalsFor(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

export function fromMinorUnits(amount: number, currency: string): Money {
  const decimals = decimalsFor(currency);
  const divisor = 10 ** decimals;
  return {
    amount: Number((amount / divisor).toFixed(decimals)),
    currency: currency.toUpperCase(),
  };
}

export function toMinorUnits(money: Money): number {
  return Math.round(money.amount * 10 ** decimalsFor(money.currency));
}

/**
 * Reads a UCP money object: `{ amount, currency }`, or a bare integer when the
 * currency is carried by the parent (cart totals and line items do this).
 */
export function readMoney(raw: unknown, fallbackCurrency: string): Money {
  if (typeof raw === 'number') return fromMinorUnits(raw, fallbackCurrency);
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const amount = Number(obj.amount ?? 0);
    const currency = String(obj.currency ?? fallbackCurrency);
    return fromMinorUnits(Number.isFinite(amount) ? amount : 0, currency);
  }
  return { amount: 0, currency: fallbackCurrency.toUpperCase() };
}

export function addMoney(values: Money[], fallbackCurrency = 'GBP'): Money {
  const currency = values[0]?.currency ?? fallbackCurrency;
  const decimals = decimalsFor(currency);
  const total = values.reduce((sum, value) => sum + value.amount, 0);
  return { amount: Number(total.toFixed(decimals)), currency };
}
