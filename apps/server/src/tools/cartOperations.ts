import { createHash, randomUUID } from 'node:crypto';
import type { BasketSync, CartAction, CartExpectation, CartOutcomeReport, CartOutcomeResponse } from '@caddie/shared';
import { productById } from '../catalog/sync.js';
import { log } from '../lib/logger.js';
import { noteShoppingConstraints } from '../session/focus.js';
import { sessions, type CaddieSession, type CartOperationRecord } from '../session/store.js';
import { evaluateSmartCart } from '../smartCart/index.js';

/**
 * A basket change on the storefront is made by the widget, in the theme's
 * own cart, after the server has validated it. Until now the server counted
 * it as made the moment it handed the change over: "Added" was said, the
 * waiting action was cleared and the product marked as in the basket while
 * /cart/add.js could still refuse it - and when it did, the reply, the
 * server and the shopper's cart disagreed (audit finding B2).
 *
 * So a validated change is now an operation: recorded here as dispatched,
 * stamped on the CartActions the widget carries out, and completed only when
 * the widget reports what the cart showed afterwards and that report bears
 * out the change asked for - the quantity that had to rise did, the line
 * that had to go went. The evidence is the theme's /cart.js read in the
 * shopper's browser: what their cart page shows, not a receipt signed by
 * Shopify. Anything the read cannot settle stays uncertain, and is said so.
 */

/** How long a dispatched operation may wait for its report before it is treated as uncertain and stops blocking new changes. */
export const OUTCOME_TIMEOUT_MS = 45_000;

/** What a planner hands the gateway when the change is one the widget must confirm. */
export interface PlannedOperation {
  kind: 'add-product' | 'update-line';
  expect: CartExpectation;
  /** A replacement: the line going out, as the basket held it. */
  outgoing?: { lineId: string; variantId: string; quantity: number; title: string; choice: string };
  onApplied: { liked?: string[]; rejected?: string[]; lastAdded?: boolean };
  wording: { title: string; choice: string; quantity: number };
}

/** The cart's quantities by numeric variant id, added across lines of the same variant. */
export function quantitiesOf(lines: Array<{ variantId?: string; quantity: number }> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of lines ?? []) {
    if (!line.variantId) continue;
    const key = numeric(line.variantId);
    out[key] = (out[key] ?? 0) + (Number(line.quantity) || 0);
  }
  return out;
}

const numeric = (id: string) => String(id).split('/').pop() ?? String(id);

/**
 * What makes a line distinct from another of the same variant - its
 * properties and selling plan - as a short hash. The values themselves are
 * never kept: they are the client's text, and would go into the model's
 * instructions.
 */
export function lineFingerprint(line: { properties?: Record<string, string> | null; sellingPlanId?: string | null }): string {
  const props = line.properties ?? {};
  const canonical = JSON.stringify(Object.keys(props).sort().map((key) => [key, String(props[key] ?? '')]));
  return createHash('sha1').update(`${line.sellingPlanId ?? ''}|${canonical}`).digest('hex').slice(0, 16);
}

/** The lines of a widget's read the session will keep - the same ones for the basket and for Smart Cart. */
function keptLines(lines: BasketSync['lines']): BasketSync['lines'] {
  return lines.filter((line) => typeof line?.key === 'string' && typeof line?.productId === 'string').slice(0, 100);
}

/**
 * Everything a fresh cart read sets on the session: the basket, and Smart
 * Cart progress worked out from the same lines. The session's basket keeps
 * only a fingerprint of each line's properties, so the triggers are read here,
 * from the read itself, and never from a basket that could be older.
 */
export function basketPatch(lines: BasketSync['lines'], currency?: string): Pick<CaddieSession, 'basket' | 'smartCart' | 'cartCurrency'> {
  const kept = keptLines(lines);
  return {
    basket: basketFromSync(kept),
    ...(typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? { cartCurrency: currency.toUpperCase() } : {}),
    smartCart: evaluateSmartCart(
      kept.map((line) => ({
        key: String(line.key),
        ...(line.variantId ? { variantId: numeric(String(line.variantId)) } : {}),
        quantity: Number(line.quantity) || 0,
        properties: line.properties ?? null,
        ...(Array.isArray(line.discounts) ? { discounts: line.discounts.slice(0, 20).map((d) => ({ title: String(d?.title ?? '').slice(0, 200), amount: Math.max(0, Math.round(Number(d?.amount) || 0)) })) } : {}),
      })),
    ),
  };
}

/** The line as the session keeps it, from the widget's read: names from our own catalogue, never from the request. */
export function basketFromSync(lines: BasketSync['lines']): NonNullable<CaddieSession['basket']> {
  return keptLines(lines)
    .map((line) => {
      const product = productById(String(line.productId));
      const variant = product?.variants.find((entry) => numeric(entry.id) === numeric(String(line.variantId)));
      return {
        lineId: String(line.key).slice(0, 200),
        productId: String(line.productId),
        ...(line.variantId ? { variantId: numeric(String(line.variantId)).slice(0, 40) } : {}),
        fingerprint: lineFingerprint(line),
        title: product?.title ?? 'an item from the store',
        variantTitle: variant ? Object.values(variant.options).filter((value) => value !== 'Default Title').join(' / ') : '',
        quantity: Number(line.quantity) || 0,
        ...(line.bundle ? { bundle: String(line.bundle).slice(0, 100) } : {}),
        ...(line.bundleName ? { bundleName: String(line.bundleName).slice(0, 100) } : {}),
      };
    });
}

/**
 * Record the change as dispatched and stamp it on the actions, so the report
 * that comes back can be tied to exactly this change - this session, this
 * variant, this quantity, this line going out - and to nothing else.
 */
export function dispatch(session: CaddieSession, planned: PlannedOperation, actions: CartAction[], meta: { source: string; turn: number; mission?: number; productId?: string; variantId?: string }): { actions: CartAction[]; record: CartOperationRecord } {
  const id = `op-${randomUUID()}`;
  const record: CartOperationRecord = {
    id,
    kind: planned.kind,
    status: 'dispatched',
    ...(meta.productId ? { productId: meta.productId } : {}),
    ...(meta.variantId ? { variantId: numeric(meta.variantId) } : {}),
    quantity: planned.wording.quantity,
    ...(planned.outgoing ? { outgoing: planned.outgoing } : {}),
    expect: planned.expect,
    before: quantitiesOf(session.basket),
    ...(session.cartToken ? { cartToken: session.cartToken } : {}),
    onApplied: planned.onApplied,
    wording: planned.wording,
    source: meta.source,
    turn: meta.turn,
    ...(meta.mission !== undefined ? { mission: meta.mission } : {}),
    createdAt: Date.now(),
  };
  const stamped = actions.map((action) => (action.type === 'add' || action.type === 'change' ? { ...action, operationId: id, expect: planned.expect } : action));
  return { actions: stamped, record };
}

/**
 * Several lines out together, one operation each. The widget runs one action
 * per operation id and skips a repeat of the id as already done - six changes
 * under one id took one line out and left five (live, 29 Sep). Each line
 * gets its own record and expectation; the batch is confirmed once, when the
 * last of them settles (settleOutcome).
 */
export function dispatchBatch(session: CaddieSession, planned: PlannedOperation[], title: string, actions: CartAction[], meta: { source: string; turn: number; mission?: number; productId?: string }): { actions: CartAction[]; records: CartOperationRecord[] } {
  const batchId = `batch-${randomUUID()}`;
  const createdAt = Date.now();
  const records: CartOperationRecord[] = [];
  const stamped = actions.map((action, i) => {
    const plan = planned[i];
    if (!plan || (action.type !== 'add' && action.type !== 'change')) return action;
    const id = `op-${randomUUID()}`;
    records.push({
      id,
      kind: plan.kind,
      status: 'dispatched',
      ...(meta.productId ? { productId: meta.productId } : {}),
      quantity: plan.wording.quantity,
      expect: plan.expect,
      before: quantitiesOf(session.basket),
      ...(session.cartToken ? { cartToken: session.cartToken } : {}),
      onApplied: plan.onApplied,
      wording: plan.wording,
      source: meta.source,
      turn: meta.turn,
      ...(meta.mission !== undefined ? { mission: meta.mission } : {}),
      createdAt,
      batch: { id: batchId, size: actions.length, title },
    });
    return { ...action, operationId: id, expect: plan.expect };
  });
  return { actions: stamped, records };
}

/** The operations the session keeps: the latest few, so a report for an old one is still answered. Enough for a whole pack out plus history. */
export function keepOperations(existing: Record<string, CartOperationRecord> | undefined, ...records: CartOperationRecord[]): Record<string, CartOperationRecord> {
  const all = { ...(existing ?? {}), ...Object.fromEntries(records.map((record) => [record.id, record])) };
  const ids = Object.values(all)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 24)
    .map((entry) => entry.id);
  return Object.fromEntries(ids.map((id) => [id, all[id]!]));
}

/**
 * A dispatched operation nobody has reported on by the deadline is uncertain:
 * not failed - there is no evidence - and not forgotten. The deadline is for
 * the customer's controls (the widget's own deadlines end its waiting); the
 * hold on further Caddie basket changes stays until a report settles the
 * operation, so the same change is never sent again on a guess. Browsing,
 * chat, the theme's own basket and checkout are never held.
 */
export async function expireDispatched(sessionId: string, session: CaddieSession, now = Date.now()): Promise<CaddieSession> {
  const ops = session.cartOperations ?? {};
  const stale = Object.values(ops).filter((op) => op.status === 'dispatched' && now - op.createdAt > OUTCOME_TIMEOUT_MS);
  if (!stale.length) return session;
  const cartOperations = { ...ops };
  for (const op of stale) cartOperations[op.id] = { ...op, status: 'uncertain', text: UNCERTAIN };
  log.warn('cart.operation_timed_out', { sessionId, operations: stale.map((op) => op.id), ageMs: stale.map((op) => now - op.createdAt) });
  return sessions.patch(sessionId, { cartOperations });
}

/**
 * The operation still holding this session's basket changes, if any:
 * dispatched or uncertain, not yet settled by evidence. Read from the
 * records themselves, so a pack offer or a question that takes the one
 * pending slot cannot lift the hold.
 */
export function unsettledOperation(session: CaddieSession): CartOperationRecord | undefined {
  return Object.values(session.cartOperations ?? {})
    .filter((record) => record.status === 'dispatched' || record.status === 'uncertain')
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/* ---------------- the words ---------------- */

export const UPDATING = 'Updating your basket…';
/** Said with a re-read scheduled (the widget rechecks on this answer): a check really is underway. */
export const UNCERTAIN = "I couldn't confirm the update yet. I'm checking your basket.";
export const STILL_UPDATING = "I'm still updating your basket - one moment.";
/** Said when nothing is checking: how to see for themselves, and that nothing is sent again on a guess. */
export const UNCERTAIN_HELD = "I couldn't confirm your last basket update, so I haven't sent it again. Please check your basket with the cart icon - if the item isn't there, use the Add button on the product page - and I'll carry on from what it shows.";

function spoken(record: CartOperationRecord): string {
  const { title, choice } = record.wording;
  return choice ? `${title} in ${choice}` : title;
}

function appliedText(record: CartOperationRecord): string {
  if (record.outgoing) return `Done - the ${record.wording.title} is now in ${record.wording.choice}.`;
  if (record.kind === 'update-line') {
    if (record.quantity === 0) return `Removed the ${spoken(record)} from your basket.`;
    return `Done - ${record.quantity} x ${spoken(record)} in your basket.`;
  }
  return `Added the ${spoken(record)}${record.quantity > 1 ? ` x ${record.quantity}` : ''}.`;
}

/* ---------------- the report, judged ---------------- */

/** A line's quantity, by variant and fingerprint - the one line, not every line of that variant. */
function lineQuantity(lines: BasketSync['lines'] | undefined, variantId: string, fingerprint: string | undefined): number {
  return (lines ?? [])
    .filter((line) => numeric(String(line.variantId)) === numeric(variantId) && (fingerprint === undefined || lineFingerprint(line) === fingerprint))
    .reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
}

export type Verdict = 'applied' | 'failed' | 'partial' | 'uncertain';

/**
 * What the report says happened, judged by the change asked for - not by
 * the widget's word for it, and not by whether the variant is there.
 *
 *   - bound to this session's operation (the caller found the record by id
 *     under the session's own ownership check) and to the cart it was made
 *     for: a report about another cart token settles nothing;
 *   - each line asked for is judged as a line - the variant with the
 *     properties and selling plan it had - not as a total for the variant,
 *     so a second line of the same variant does not stand in for it;
 *   - an add must rise by the quantity asked; a removal must fall by the
 *     line's quantity; part of either done is partial, never success;
 *   - nothing changed is a failure only with evidence: the store's refusal,
 *     or a read after the deadline that still shows no change.
 */
export function judge(record: CartOperationRecord, report: Pick<CartOutcomeReport, 'status' | 'before' | 'after' | 'failure'>, now = Date.now()): Verdict {
  if (!report.after) return 'uncertain';
  if (record.cartToken && report.after.cartToken && report.after.cartToken !== record.cartToken) return 'uncertain';
  const before = report.before?.lines;
  const beforeTotals = report.before ? quantitiesOf(report.before.lines) : record.before;
  const after = report.after.lines;
  const adds = record.expect.add ?? [];
  const removes = record.expect.remove ?? [];
  const addRose = adds.map((line) => {
    // An add lands on the line of the variant carrying exactly what it was sent with - no properties, or a Smart Cart trigger - or merges into it.
    const landing = lineFingerprint({ properties: line.properties ?? {} });
    const was = before ? lineQuantity(before, line.variantId, landing) : (beforeTotals[numeric(line.variantId)] ?? 0);
    const is = lineQuantity(after, line.variantId, landing);
    const total = quantitiesOf(after)[numeric(line.variantId)] ?? 0;
    const wasTotal = beforeTotals[numeric(line.variantId)] ?? 0;
    return { rose: is - was >= line.quantity && total - wasTotal >= line.quantity, unchanged: is === was && total === wasTotal };
  });
  const removeFell = removes.map((line) => {
    // The line as it was: by its key in the read before, else as the record held it - never every line of the variant.
    const beforeLine = before?.find((entry) => entry.key === line.key);
    const fingerprint = beforeLine ? lineFingerprint(beforeLine) : record.outgoing?.lineId === line.key ? record.outgoing.fingerprint : undefined;
    const was = before ? lineQuantity(before, line.variantId, fingerprint) : (beforeTotals[numeric(line.variantId)] ?? 0);
    const is = lineQuantity(after, line.variantId, fingerprint);
    return { fell: was - is >= line.quantity, unchanged: is === was };
  });
  const steps = [...addRose.map((step) => step.rose), ...removeFell.map((step) => step.fell)];
  const unchanged = addRose.every((step) => step.unchanged) && removeFell.every((step) => step.unchanged);
  if (!steps.length) return report.status === 'applied' ? 'applied' : 'uncertain';
  if (steps.every(Boolean)) return 'applied';
  if (steps.some(Boolean)) return 'partial';
  /*
   * Nothing changed is a failure only when the store refused the request and
   * said so (rejected): a read that shows no change - however late - is not
   * proof the request will never land, so the operation stays uncertain, held
   * and recoverable. `now` is kept for the caller's logging only.
   */
  void now;
  if (unchanged && report.status === 'failed' && (report.failure ?? 'rejected') === 'rejected') return 'failed';
  return 'uncertain';
}

/** The customer's words for a refused request, from Shopify's. */
function failureText(record: CartOperationRecord, report: Pick<CartOutcomeReport, 'error' | 'after'>): string {
  const soldOut = /sold out|not available|unavailable|out of stock|inventory/i.test(report.error ?? '');
  const size = record.wording.choice ? 'That size is unavailable.' : 'That item is unavailable.';
  const head = soldOut || !report.error ? size : `I couldn't update your basket: ${report.error.replace(/[.\s]+$/, '')}.`;
  if (record.outgoing && report.after) {
    const still = quantitiesOf(report.after.lines)[numeric(record.outgoing.variantId)] ?? 0;
    if (still >= record.outgoing.quantity) return `${head} Your original ${record.wording.title} in ${record.outgoing.choice} is still in the basket.`;
  }
  return head;
}

/**
 * The widget's report on an operation, judged and recorded once. A repeat
 * of the same report gets the same answer and changes nothing; a report for
 * an operation this session never made is refused; a report that does not
 * bear out the change leaves the operation uncertain and asks for another
 * read. Only an applied change completes the action - and consumes the
 * customer's authorisation - exactly once.
 */
export async function settleOutcome(sessionId: string, report: CartOutcomeReport): Promise<CartOutcomeResponse> {
  const session = await sessions.getOrCreate(sessionId);
  const record = session.cartOperations?.[report.operationId];
  if (!record) {
    log.warn('cart.outcome_unknown', { sessionId, operationId: report.operationId });
    return { status: 'unknown' };
  }
  if (record.status === 'applied' || record.status === 'failed' || record.status === 'partial') {
    log.info('cart.outcome_duplicate', { sessionId, operationId: record.id, status: record.status });
    return { status: 'duplicate', ...(record.text ? { text: record.text } : {}) };
  }
  const verdict = judge(record, report, Date.now());
  // A report about an older operation never overwrites what a newer one settled: the basket and "last added" follow the newest only.
  const newest = Object.values(session.cartOperations ?? {}).every((other) => other.createdAt <= record.createdAt);
  const fresh = report.after && newest ? basketPatch(report.after.lines, report.after.currency) : undefined;
  const pendingIsThis = session.pendingAction?.dispatched === record.id;
  log.info('cart.outcome', { sessionId, operationId: record.id, kind: record.kind, reported: report.status, verdict, error: report.error ?? null });

  if (verdict === 'uncertain') {
    await sessions.patch(sessionId, {
      cartOperations: { ...session.cartOperations, [record.id]: { ...record, status: 'uncertain', text: UNCERTAIN, ...(report.error ? { error: report.error } : {}) } },
      ...(fresh ?? {}),
    });
    return { status: 'uncertain', text: UNCERTAIN, recheck: true };
  }

  const text = verdict === 'applied' ? appliedText(record) : verdict === 'failed' ? failureText(record, report) : partialText(record, report);
  const resolved: CartOperationRecord = { ...record, status: verdict, text, resolvedAt: Date.now(), ...(report.error ? { error: report.error } : {}) };
  const patch: Partial<CaddieSession> = {
    cartOperations: { ...session.cartOperations, [record.id]: resolved },
    ...(fresh ?? {}),
  };
  /*
   * One line of a batch: settled quietly, unless it is the last. Then the
   * batch is confirmed once - "Removed the whole pack from your basket" -
   * or what is still in is named, and the waiting record ends with it.
   */
  if (record.batch) {
    const siblings = Object.values(patch.cartOperations!).filter((entry) => entry.batch?.id === record.batch!.id);
    const settled = siblings.length >= record.batch.size && siblings.every((entry) => entry.status !== 'dispatched' && entry.status !== 'uncertain');
    if (!settled) {
      await sessions.patch(sessionId, patch);
      return { status: verdict, text: '' };
    }
    const stillIn = siblings.filter((entry) => entry.status !== 'applied');
    const summary = stillIn.length
      ? `I took out ${siblings.length - stillIn.length} of the ${record.batch.size} - the ${stillIn.map((entry) => entry.wording.title).join(', ')} ${stillIn.length === 1 ? 'is' : 'are'} still in your basket.`
      : `Removed the ${record.batch.title} from your basket.`;
    patch.cartOperations![record.id] = { ...resolved, text: summary };
    if (session.pendingAction?.awaiting === 'outcome' && siblings.some((entry) => entry.id === session.pendingAction?.dispatched)) patch.pendingAction = undefined;
    await sessions.patch(sessionId, patch);
    await sessions.append(sessionId, [{ id: `op-${record.batch.id}`, role: 'assistant', text: summary, createdAt: new Date().toISOString() }]);
    log.info('cart.batch_settled', { sessionId, batch: record.batch.id, size: record.batch.size, stillIn: stillIn.length });
    return { status: verdict, text: summary };
  }
  if (verdict === 'applied') {
    if (pendingIsThis) patch.pendingAction = undefined;
    if (record.onApplied.lastAdded && record.productId && newest) patch.lastAdded = { productId: record.productId, turn: customerTurns(session), byOperation: true };
    if (record.onApplied.liked?.length || record.onApplied.rejected?.length) {
      await noteShoppingConstraints(sessionId, { ...(record.onApplied.liked?.length ? { liked: record.onApplied.liked } : {}), ...(record.onApplied.rejected?.length ? { rejected: record.onApplied.rejected } : {}) }, 'customer-confirmation');
    }
  } else if (verdict === 'failed') {
    if (pendingIsThis) patch.pendingAction = undefined;
  } else {
    // Partial: the new size is in, the old one is not out. Their yes takes the old one out; nothing is undone on their behalf.
    const outgoingLine = report.after?.lines.find((line) => numeric(String(line.variantId)) === numeric(record.outgoing?.variantId ?? '') && !line.bundle && (!record.outgoing?.fingerprint || lineFingerprint(line) === record.outgoing.fingerprint));
    patch.pendingAction = outgoingLine
      ? { type: 'update-line', productIds: record.productId ? [record.productId] : [], lineId: outgoingLine.key, variantId: numeric(String(outgoingLine.variantId)), lineFingerprint: lineFingerprint(outgoingLine), quantity: 0, awaiting: 'confirmation', missing: ['confirmation'], authorized: false, question: text, turn: customerTurns(session), mission: record.mission }
      : undefined;
  }
  await sessions.patch(sessionId, patch);
  // The words go into the conversation as the Caddie's, so the next turn knows what happened.
  await sessions.append(sessionId, [{ id: `op-${record.id}`, role: 'assistant', text, createdAt: new Date().toISOString() }]);
  return { status: verdict, text };
}

function partialText(record: CartOperationRecord, report: Pick<CartOutcomeReport, 'after'>): string {
  const outgoing = record.outgoing;
  if (!outgoing && (record.expect.add ?? []).length > 1 && report.after) {
    const totals = quantitiesOf(report.after.lines);
    const landed = (record.expect.add ?? []).filter((line) => (totals[numeric(line.variantId)] ?? 0) - (record.before[numeric(line.variantId)] ?? 0) >= line.quantity).length;
    return `Only ${landed} of the ${(record.expect.add ?? []).length} items went into your basket. I'm checking the rest.`;
  }
  const stillIn = outgoing && report.after ? (quantitiesOf(report.after.lines)[numeric(outgoing.variantId)] ?? 0) > 0 : false;
  if (outgoing && stillIn) return `The ${record.wording.title} in ${record.wording.choice} is in your basket, but I couldn't take out the ${outgoing.choice} - both are there for now. Shall I remove the ${outgoing.choice}?`;
  return `The ${spoken(record)} is in your basket, but I couldn't finish the change. I'm checking your basket.`;
}

/** A line as the customer would say it: "white Elite Polo in L x2". */
export function sayLine(line: { title: string; variantTitle: string; quantity: number }, garment: (title: string) => string, colour: (title: string) => string): string {
  const name = `${colour(line.title).toLowerCase()} ${garment(line.title)}`.trim();
  return `${name}${line.variantTitle ? ` in ${line.variantTitle}` : ''} x${line.quantity}`;
}

/**
 * The basket in code's words: the lines the widget last reported, and any
 * change still being confirmed, kept apart from them. The one source for
 * "what is in my basket?" and for the reply checker's basket claims - never
 * the model's memory of an earlier turn.
 */
export function basketStatement(session: CaddieSession, garment: (title: string) => string, colour: (title: string) => string): { speech: string; facts: string } {
  const lines = session.basket ?? [];
  const unsettled = unsettledOperation(session);
  const said = lines.length ? `In your basket: ${lines.map((line) => sayLine(line, garment, colour)).join('; ')}.` : 'Your basket is empty at the moment.';
  const pendingLine = unsettled
    ? unsettled.outgoing
      ? ` A change is still being confirmed: the ${unsettled.wording.title} from ${unsettled.outgoing.choice} to ${unsettled.wording.choice}.`
      : unsettled.kind === 'update-line'
        ? ` A change is still being confirmed: the ${unsettled.wording.title} to ${unsettled.quantity === 0 ? 'none' : `x${unsettled.quantity}`}.`
        : ` One more is still being confirmed: the ${unsettled.wording.title}${unsettled.wording.choice ? ` in ${unsettled.wording.choice}` : ''}${unsettled.quantity > 1 ? ` x${unsettled.quantity}` : ''}.`
    : '';
  return {
    speech: `${said}${pendingLine}`,
    facts: `Basket (the store cart as last reported, the only basket truth): ${lines.length ? lines.map((line) => `${line.title} [${line.variantTitle || 'one size'}] x${line.quantity}`).join('; ') : 'empty'}.${unsettled ? ` Still being confirmed, NOT in the basket yet: ${unsettled.wording.title} ${unsettled.wording.choice} x${unsettled.quantity} (${unsettled.status}).` : ''} State sizes and quantities only from this line; never from earlier turns.`,
  };
}

/** The customer's message count - the same stamp the gateway uses for lastAdded. */
function customerTurns(session: CaddieSession): number {
  return session.messages.filter((message) => message.role === 'user').length;
}
