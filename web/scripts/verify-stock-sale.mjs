// Explicit-state check of the stock sale protocol.
// Coverage numbers and the sync commit also live in
// .grok/skills/verify-stock-sale/SKILL.md. Change both together.
//
// One SKU, continue_selling off, on_hand starts at 2, four orders of qty 1.
// Each step is one D1 batch: reserve, release, sale (markOrderPaid), restock.
// The batch is atomic. The checker reads the guards from the source. If a
// guard is gone, that step is unconditional and the search must find a break.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const INITIAL_ON_HAND = 2;
const ORDER_COUNT = 4;

const SALE_GUARD =
  "v.continue_selling = 0 AND s.on_hand - s.reserved < i.qty - COALESCE((SELECT SUM(qty) FROM reservations WHERE order_id = orders.id AND sku = i.sku AND status = 'active'),0)";
const RESERVE_GUARD = 'on_hand - reserved >=';
const RELEASE_STOCK =
  "reserved=reserved-COALESCE((SELECT SUM(qty) FROM reservations WHERE order_id=? AND sku=stock.sku AND status='active'),0)";
const RELEASE_STATUS =
  "UPDATE reservations SET status='released' WHERE order_id=? AND status='active'";
const RESTOCK_ONCE = 'restocked_at IS NULL';
const RESTOCK_COMMITTED = "status='committed'";

function sliceFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return null;
  const next = source.indexOf('\nexport ', start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function loadGuards() {
  const checkout = readFileSync(new URL('../src/server/checkout.ts', import.meta.url), 'utf8');
  const inventory = readFileSync(new URL('../src/server/inventory.ts', import.meta.url), 'utf8');
  const sale = sliceFunction(checkout, 'export async function markOrderPaid');
  const reserve = sliceFunction(inventory, 'export function reservationStatements(');
  const reserveSet = sliceFunction(inventory, 'export function reservationStatementsSetBased');
  const release = sliceFunction(inventory, 'export function releaseOrderHoldsStmts');
  const restock = sliceFunction(inventory, 'export function restockOrderStatements');
  const missing = [
    ['markOrderPaid', sale],
    ['reservationStatements', reserve],
    ['reservationStatementsSetBased', reserveSet],
    ['releaseOrderHoldsStmts', release],
    ['restockOrderStatements', restock],
  ].filter(([, body]) => !body);
  if (missing.length) {
    console.error(`modeling error: cannot find ${missing.map(([name]) => name).join(', ')}`);
    process.exit(2);
  }
  return {
    saleGuard: sale.includes(SALE_GUARD),
    reserveGuard: reserve.includes(RESERVE_GUARD) && reserveSet.includes(RESERVE_GUARD),
    releaseActiveOnly: release.includes(RELEASE_STOCK) && release.includes(RELEASE_STATUS),
    restockOnce: restock.includes(RESTOCK_ONCE) && restock.includes(RESTOCK_COMMITTED),
  };
}

function key(state) {
  return [state.onHand, state.reserved, state.restockEvents, state.phases.join('')].join(',');
}

function violation(state) {
  const held = state.phases.filter((phase) => phase === 'held').length;
  const sold = state.phases.filter((phase) => phase === 'sold' || phase === 'restocked').length;
  if (state.onHand < 0) return 'on_hand went negative: a unit was sold that the SKU did not have';
  if (state.reserved < 0) return 'reserved went negative: a hold was released that was not active';
  if (state.reserved !== held)
    return `reserved is ${state.reserved} but ${held} order${held === 1 ? '' : 's'} hold a unit`;
  if (state.onHand < state.reserved)
    return 'available stock went negative: holds exceed what is on hand';
  if (state.onHand !== INITIAL_ON_HAND + state.restockEvents - sold)
    return 'on_hand does not match units sold and units restocked';
  if (state.restockEvents > sold) return 'restocked more units than were sold';
  return null;
}

function step(state, index, phase, patch) {
  const phases = state.phases.slice();
  phases[index] = phase;
  return { ...state, ...patch, phases };
}

function successors(state, guards) {
  const out = [];
  for (let index = 0; index < ORDER_COUNT; index++) {
    const phase = state.phases[index];
    const order = index + 1;
    if (phase === 'idle') {
      const allowed = !guards.reserveGuard || state.onHand - state.reserved >= 1;
      if (allowed) {
        out.push({
          action: `Order ${order} reserves 1 unit`,
          state: step(state, index, 'held', { reserved: state.reserved + 1 }),
        });
      }
    }
    const releasable =
      phase === 'held' ||
      (!guards.releaseActiveOnly && (phase === 'sold' || phase === 'restocked'));
    if (releasable) {
      out.push({
        action:
          phase === 'held'
            ? `Order ${order} releases its hold`
            : `Order ${order} releases a hold that is no longer active`,
        state: step(state, index, phase === 'held' ? 'idle' : phase, {
          reserved: state.reserved - 1,
        }),
      });
    }
    if (phase === 'idle' || phase === 'held') {
      const hold = phase === 'held' ? 1 : 0;
      const shortfall = 1 - hold;
      const allowed = !guards.saleGuard || state.onHand - state.reserved >= shortfall;
      if (allowed) {
        out.push({
          action:
            hold === 1
              ? `Order ${order} sells its held unit`
              : `Order ${order} sells 1 unit with no hold`,
          state: step(state, index, 'sold', {
            reserved: state.reserved + shortfall - 1,
            onHand: state.onHand - 1,
          }),
        });
      }
    }
    const restockable = phase === 'sold' || (!guards.restockOnce && phase === 'restocked');
    if (restockable) {
      out.push({
        action:
          phase === 'sold'
            ? `Order ${order} restocks the unit it sold`
            : `Order ${order} restocks the same sold unit again`,
        state: step(state, index, 'restocked', {
          onHand: state.onHand + 1,
          restockEvents: state.restockEvents + 1,
        }),
      });
    }
  }
  return out;
}

function trace(seen, lastKey, lastAction) {
  const lines = [];
  let cursor = lastKey;
  while (cursor) {
    const row = seen.get(cursor);
    if (row.action) lines.push(row.action);
    cursor = row.prev;
  }
  lines.reverse();
  if (lastAction) lines.push(lastAction);
  return lines;
}

function explore(guards) {
  const start = {
    onHand: INITIAL_ON_HAND,
    reserved: 0,
    restockEvents: 0,
    phases: Array.from({ length: ORDER_COUNT }, () => 'idle'),
  };
  const initialBreak = violation(start);
  if (initialBreak) return { break: initialBreak, lines: [], end: start, states: 1 };
  const seen = new Map([[key(start), { action: null, prev: null }]]);
  const queue = [start];
  while (queue.length) {
    const state = queue.shift();
    const from = key(state);
    for (const next of successors(state, guards)) {
      const broken = violation(next.state);
      const id = key(next.state);
      if (broken) {
        return {
          break: broken,
          lines: trace(seen, from, next.action),
          end: next.state,
          states: seen.size,
        };
      }
      if (seen.has(id)) continue;
      seen.set(id, { action: next.action, prev: from });
      queue.push(next.state);
    }
  }
  return { states: seen.size };
}

const guards = loadGuards();
const missing = Object.entries(guards)
  .filter(([, present]) => !present)
  .map(([name]) => name);
const result = explore(guards);

if (missing.length || result.break) {
  if (missing.length) {
    console.error(
      `fail: source is missing a guard (${missing.join(', ')}), so that step is unconditional`
    );
  }
  if (result.break) {
    if (!missing.length) console.error('fail: the protocol breaks the stock property');
    console.error(result.break);
    result.lines.forEach((line, index) => console.error(`${index + 1}. ${line}`));
    const end = result.end;
    console.error(
      `end: on_hand=${end.onHand} reserved=${end.reserved} restocks=${end.restockEvents} orders=${end.phases.join(',')}`
    );
  } else {
    console.error('fail: the bound produced no counterexample, but a missing guard is not a pass');
  }
  process.exit(1);
}

console.log(
  `pass: ${result.states} states, 1 sku, continue_selling off, on_hand starts at ${INITIAL_ON_HAND}, ${ORDER_COUNT} orders of qty 1`
);
console.log(
  'property: on_hand stays at least reserved, reserved matches active holds, and restock does not exceed units sold'
);
console.log(
  `guards: ${Object.entries(guards)
    .map(([name, present]) => `${name}=${present ? 'present' : 'MISSING'}`)
    .join(' ')}`
);
console.log(`root: ${root}`);
