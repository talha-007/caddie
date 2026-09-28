import { beforeEach, describe, expect, it } from 'vitest';
import type { CartAction } from '@caddie/shared';
import { alreadyRun, inFlight, noteDone, noteReported, noteStarted } from '../src/lib/operations.js';

/**
 * The tab's record of operations handed to it: the same operation is never
 * run twice, and one still unanswered survives a refresh so it can be
 * reconciled from the cart - never replayed.
 */
const action: Extract<CartAction, { type: 'add' }> = { type: 'add', operationId: 'op-a', lines: [{ variantId: '611', quantity: 1 }], expect: { add: [{ variantId: '611', quantity: 1 }] } };

beforeEach(() => sessionStorage.clear());

describe('5. the same operation delivered twice', () => {
  it('is run once: started, it is already run; done, it stays run', () => {
    expect(alreadyRun('op-a')).toBe(false);
    noteStarted({ operationId: 'op-a', action, startedAt: 1 });
    expect(alreadyRun('op-a')).toBe(true);
    noteDone('op-a');
    expect(alreadyRun('op-a')).toBe(true);
    expect(inFlight()).toEqual([]);
    // A later operation for another item is its own.
    expect(alreadyRun('op-b')).toBe(false);
  });
});

describe('15. a refresh during an unresolved operation', () => {
  it('keeps the operation, and its report once the cart has been changed, for reconciliation - not for replay', () => {
    noteStarted({ operationId: 'op-a', action, startedAt: 1 });
    noteReported('op-a', { operationId: 'op-a', status: 'applied', before: { lines: [] }, after: { lines: [{ key: 'k', productId: 'gid://shopify/Product/61', variantId: 'gid://shopify/ProductVariant/611', title: '', variantTitle: 'M', quantity: 1 }] }, evidence: 'ajax-cart-read' });
    // "After the refresh": read back from storage.
    const [kept] = inFlight();
    expect(kept?.operationId).toBe('op-a');
    expect(kept?.report?.status).toBe('applied');
    expect(kept?.report?.after?.lines[0]?.quantity).toBe(1);
  });

  it('storage that cannot be read leaves nothing to replay', () => {
    sessionStorage.setItem('druids-caddie-cart-ops', 'not json');
    expect(inFlight()).toEqual([]);
    expect(alreadyRun('op-a')).toBe(false);
  });
});
