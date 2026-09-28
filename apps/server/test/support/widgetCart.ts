import type { CartAction } from '@caddie/shared';
import { settleOutcome } from '../../src/tools/cartOperations.js';

/**
 * The widget's part of a basket change, for tests that play the storefront:
 * a change the gateway hands over is not made until the widget has carried
 * it out in the theme's cart and reported what the cart then showed
 * (tools/cartOperations.ts). Tests that used to treat the handed-over
 * actions as applied now report them applied, with the fake basket before
 * and after, exactly as the widget does - so their customer-facing
 * expectations (added once, the record cleared, "make it two" changing the
 * line) hold for the same reasons they hold on the storefront.
 */
export type FakeLine = { lineId: string; productId: string; variantId?: string; title: string; variantTitle: string; quantity: number; bundle?: string };

const sync = (lines: FakeLine[]) => ({
  lines: lines.map((line) => ({ key: line.lineId, productId: line.productId, variantId: line.variantId ?? '', title: line.title, variantTitle: line.variantTitle, quantity: line.quantity, ...(line.bundle ? { bundle: line.bundle } : {}) })),
});

/** Report every operation among these actions as applied, with the fake basket as it was and as it is. */
export async function confirmApplied(sessionId: string, actions: CartAction[] | undefined, before: FakeLine[], after: FakeLine[]): Promise<void> {
  const ids = new Set<string>();
  for (const action of actions ?? []) {
    if ((action.type === 'add' || action.type === 'change') && action.operationId) ids.add(action.operationId);
  }
  for (const operationId of ids) {
    await settleOutcome(sessionId, { operationId, status: 'applied', before: sync(before), after: sync(after), evidence: 'ajax-cart-read' });
  }
}

/** Report every operation among these actions as refused by the cart, nothing changed. */
export async function confirmFailed(sessionId: string, actions: CartAction[] | undefined, basket: FakeLine[], error: string): Promise<void> {
  for (const action of actions ?? []) {
    if ((action.type === 'add' || action.type === 'change') && action.operationId) {
      await settleOutcome(sessionId, { operationId: action.operationId, status: 'failed', before: sync(basket), after: sync(basket), error, evidence: 'ajax-cart-read' });
    }
  }
}

/**
 * Play the widget for a tool result: carry the handed-over actions out on a
 * fake basket (the session's, as the widget would read the theme's) and
 * report each operation applied. Adds append a line for the variant; changes
 * set or remove the line by key. Pack lines are left to the pack path.
 */
export async function playWidget(sessionId: string, actions: CartAction[] | undefined): Promise<void> {
  if (!actions?.some((action) => (action.type === 'add' || action.type === 'change') && action.operationId)) return;
  const { sessions } = await import('../../src/session/store.js');
  const { allProducts } = await import('../../src/catalog/sync.js');
  const session = await sessions.getOrCreate(sessionId);
  const before: FakeLine[] = [...(session.basket ?? [])];
  const after: FakeLine[] = [...before];
  const owner = (variantId: string) => {
    for (const product of allProducts()) {
      const variant = product.variants.find((entry) => entry.id.split('/').pop() === String(variantId).split('/').pop());
      if (variant) return { product, variant };
    }
    return null;
  };
  for (const action of actions) {
    if (action.type === 'add') {
      for (const line of action.lines) {
        const found = owner(line.variantId);
        if (!found) continue;
        after.push({ lineId: `line-${after.length + 1}-${Math.floor(Math.random() * 1e6)}`, productId: found.product.id, variantId: found.variant.id.split('/').pop(), title: found.product.title, variantTitle: found.variant.title, quantity: line.quantity });
      }
      for (const key of action.removeKeys ?? []) {
        const at = after.findIndex((line) => line.lineId === key);
        if (at >= 0) after.splice(at, 1);
      }
    }
    if (action.type === 'change') {
      const at = after.findIndex((line) => line.lineId === action.lineKey);
      if (at >= 0) {
        if (action.quantity === 0) after.splice(at, 1);
        else after[at] = { ...after[at]!, quantity: action.quantity };
      }
    }
  }
  await confirmApplied(sessionId, actions, before, after);
}
