import type { CartAction } from '@caddie/shared';

/**
 * The basket changes this tab has been handed and not yet had confirmed -
 * kept in sessionStorage so a refresh in the middle of one does not lose
 * it, and so the same operation is never carried out twice. An operation
 * the server has answered is remembered as done; one still waiting is
 * reconciled on the next load by reading the cart and reporting what it
 * shows, never by sending the add again.
 */

const IN_FLIGHT_KEY = 'druids-caddie-cart-ops';
const DONE_KEY = 'druids-caddie-cart-ops-done';
const DONE_LIMIT = 50;

export interface InFlightOperation {
  operationId: string;
  action: Extract<CartAction, { type: 'add' | 'change' }>;
  startedAt: number;
  /** Set once the cart has been changed (or the attempt made) and only the report is outstanding. */
  report?: import('@caddie/shared').CartOutcomeReport;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the operation still runs; only refresh recovery is lost.
  }
}

/**
 * What this widget does with the actions a reply carries. An action stamped
 * with an operation is carried out and reported. An add or change with no
 * operation comes from a server that would have counted it as made on
 * dispatch: this widget does not run it - that path is exactly what the
 * operation report replaced - and says so. Bundle actions are the pack
 * path's, unchanged in this slice.
 */
export function sortActions(actions: CartAction[] | undefined): {
  operations: Array<Extract<CartAction, { type: 'add' | 'change' }>>;
  legacy: CartAction[];
  unsupported: CartAction[];
} {
  const operations: Array<Extract<CartAction, { type: 'add' | 'change' }>> = [];
  const legacy: CartAction[] = [];
  const unsupported: CartAction[] = [];
  for (const action of actions ?? []) {
    if (action.type === 'add' || action.type === 'change') {
      if (action.operationId) operations.push(action);
      else unsupported.push(action);
    } else legacy.push(action);
  }
  return { operations, legacy, unsupported };
}

export const UNSUPPORTED_SERVER = "I couldn't update your basket from here - this page and the assistant are out of step. Please refresh, or use the Add button on the product.";

export function inFlight(): InFlightOperation[] {
  return readJson<InFlightOperation[]>(IN_FLIGHT_KEY, []);
}

export function noteStarted(op: InFlightOperation): void {
  const rest = inFlight().filter((entry) => entry.operationId !== op.operationId);
  writeJson(IN_FLIGHT_KEY, [...rest, op]);
}

/** The change is made (or refused) and the report is what remains: kept, so a lost acknowledgement is retried, not the add. */
export function noteReported(operationId: string, report: InFlightOperation['report']): void {
  writeJson(
    IN_FLIGHT_KEY,
    inFlight().map((entry) => (entry.operationId === operationId ? { ...entry, report } : entry)),
  );
}

export function noteDone(operationId: string): void {
  writeJson(IN_FLIGHT_KEY, inFlight().filter((entry) => entry.operationId !== operationId));
  const done = readJson<string[]>(DONE_KEY, []).filter((id) => id !== operationId);
  writeJson(DONE_KEY, [...done, operationId].slice(-DONE_LIMIT));
}

/** Whether this tab has already carried this operation out - a repeat delivery of the same action is not run again. */
export function alreadyRun(operationId: string): boolean {
  return readJson<string[]>(DONE_KEY, []).includes(operationId) || inFlight().some((entry) => entry.operationId === operationId);
}
