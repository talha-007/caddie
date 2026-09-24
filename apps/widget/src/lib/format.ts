import type { Money } from '@caddie/shared';

const formatters = new Map<string, Intl.NumberFormat>();

export function formatMoney(money: Money): string {
  let formatter = formatters.get(money.currency);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat('en-GB', { style: 'currency', currency: money.currency });
    } catch {
      // An unknown currency code would throw - fall back to the plain number.
      return `${money.amount.toFixed(2)} ${money.currency}`;
    }
    formatters.set(money.currency, formatter);
  }
  return formatter.format(money.amount);
}

/** The saving on a sale item, or null when there is no genuine RRP to compare with. */
export function saving(price: Money, compareAt: Money | null | undefined): Money | null {
  if (!compareAt || compareAt.currency !== price.currency) return null;
  const amount = Number((compareAt.amount - price.amount).toFixed(2));
  return amount > 0 ? { amount, currency: price.currency } : null;
}

export function sumMoney(values: Money[]): Money | null {
  const first = values[0];
  if (!first) return null;
  if (values.some((value) => value.currency !== first.currency)) return null;
  return { amount: Number(values.reduce((total, value) => total + value.amount, 0).toFixed(2)), currency: first.currency };
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
