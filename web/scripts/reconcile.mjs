// Stripe <-> orders <-> stock reconciliation (LAUNCH.md soak).
// Usage: node scripts/reconcile.mjs [--remote]
// Local invariants are checked against D1 via wrangler. The Stripe leg runs
// only when a real STRIPE_SECRET_KEY (sk_test_/sk_live_, not the local dummy)
// is present in the environment; otherwise it is reported as SKIP, never PASS.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLimits } from '../src/schemas/limits.ts';

const remote = process.argv.includes('--remote');
const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const soakPath = join(webDir, '..', 'docs', 'SOAK.md');

function query(sql) {
  const folder = mkdtempSync(join(tmpdir(), 'store-reconcile-'));
  const tmp = join(folder, 'query.sql');
  writeFileSync(tmp, sql);
  try {
    const out = execFileSync(
      process.execPath,
      [
        join(webDir, 'node_modules/wrangler/bin/wrangler.js'),
        'd1',
        'execute',
        'store-db',
        remote ? '--remote' : '--local',
        '--json',
        '--file',
        tmp,
      ],
      { cwd: webDir, encoding: 'utf-8', shell: false }
    );
    const jsonStart = out.indexOf('[');
    const parsed = JSON.parse(out.slice(jsonStart));
    const statements = Array.isArray(parsed) ? parsed : [parsed];
    return statements.flatMap((s) => s.results ?? []);
  } finally {
    rmSync(tmp, { force: true });
    rmdirSync(folder);
  }
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// 1. Reserved counters equal active reservation sums, per SKU.
const reservedMismatch = query(`
  SELECT s.sku FROM stock s
  WHERE s.reserved != COALESCE((SELECT SUM(qty) FROM reservations r WHERE r.sku = s.sku AND r.status = 'active'), 0)`);
check(
  'stock.reserved == active reservations',
  reservedMismatch.length === 0,
  reservedMismatch.length ? reservedMismatch.map((r) => r.sku).join(',') : 'all SKUs agree'
);

// 2. Ledger sums reproduce the counters (ledger is the audit source).
const ledgerMismatch = query(`
  SELECT s.sku FROM stock s
  WHERE s.on_hand != COALESCE((SELECT SUM(delta_on_hand) FROM stock_ledger l WHERE l.sku = s.sku), 0)
     OR s.reserved != COALESCE((SELECT SUM(delta_reserved) FROM stock_ledger l WHERE l.sku = s.sku), 0)`);
check(
  'stock counters == ledger sums',
  ledgerMismatch.length === 0,
  ledgerMismatch.length ? ledgerMismatch.map((r) => r.sku).join(',') : 'all SKUs agree'
);

// 3. Paid orders hold no active reservations; no negative availability.
const paidWithHolds = query(`
  SELECT o.number FROM orders o JOIN reservations r ON r.order_id = o.id
  WHERE o.payment_status = 'paid' AND r.status = 'active'`);
check('paid orders have no active holds', paidWithHolds.length === 0);
const negative = query(
  'SELECT s.sku FROM stock s JOIN variants v ON v.sku=s.sku WHERE s.reserved<0 OR (v.continue_selling=0 AND (s.on_hand<0 OR s.reserved>s.on_hand))'
);
check('stock never negative / never over-reserved', negative.length === 0);

// 4. Match the configured hold/grace window and preserve existing active holds.
const storedLimits = query("SELECT key,value FROM settings WHERE key='checkout_session_minutes'");
const { checkout_session_minutes: sessionMinutes } = parseLimits(
  Object.fromEntries(storedLimits.map((row) => [row.key, row.value]))
);
const staleMinutes = sessionMinutes + 18;
const stuck = query(`
  SELECT number FROM orders WHERE status = 'pending_payment' AND datetime(created_at) < datetime('now', '-${staleMinutes} minutes') AND stripe_payment_intent_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=orders.id AND ci.flow='manual_capture')
  AND NOT EXISTS(SELECT 1 FROM reservations r WHERE r.order_id=orders.id AND r.status='active')`);
check(
  'no stuck pending_payment orders',
  stuck.length === 0,
  stuck.length
    ? stuck.map((r) => r.number).join(',')
    : `none older than ${staleMinutes}m without active holds`
);

// 5. Stripe leg.
const key = process.env.STRIPE_SECRET_KEY ?? '';
const realKey =
  process.argv.includes('--stripe') &&
  /^(sk_test_|sk_live_)/.test(key) &&
  key.length > 30 &&
  !key.includes('dummy');
if (!realKey) {
  console.log(
    'SKIP  Stripe API comparison — no real STRIPE_SECRET_KEY in environment (local dummy only)'
  );
  checks.push({ name: 'stripe comparison', ok: true, detail: 'SKIP (no real key)' });
} else {
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions?limit=100', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    check('stripe API comparison', false, `Stripe returned ${res.status}`);
  } else {
    const data = await res.json();
    const paidSessions = new Set(
      (data.data ?? []).filter((s) => s.payment_status === 'paid').map((s) => s.id)
    );
    const paidOrders = query(
      `SELECT stripe_checkout_session_id FROM orders WHERE payment_status = 'paid' AND stripe_checkout_session_id IS NOT NULL`
    );
    const missing = paidOrders.filter((o) => !paidSessions.has(o.stripe_checkout_session_id));
    check(
      'stripe paid sessions == paid orders',
      missing.length === 0,
      missing.length
        ? `${missing.length} paid orders not in Stripe list`
        : `${paidOrders.length} paid orders verified`
    );
  }
}

const failed = checks.filter((c) => !c.ok);
const stamp = new Date().toISOString();
const line = `| ${stamp.slice(0, 10)} | ${stamp.slice(11, 19)}Z | ${failed.length === 0 ? 'CLEAN' : 'FAILED: ' + failed.map((f) => f.name).join('; ')} | ${checks
  .map((c) => c.detail || c.name)
  .join('; ')
  .slice(0, 300)} |\n`;
if (remote && realKey && !existsSync(soakPath)) {
  writeFileSync(
    soakPath,
    '# Reconciliation soak log\n\nStarted at first production deploy; 14 consecutive CLEAN days required before launch (plan Step 9). Each row is one `scripts/reconcile.mjs` run.\n\n| Date | Time | Result | Detail |\n|---|---|---|---|\n'
  );
}
if (remote && realKey) appendFileSync(soakPath, line);
console.log(
  failed.length === 0
    ? remote && realKey
      ? 'RECONCILIATION CLEAN'
      : 'LOCAL INVARIANTS CLEAN — remote reconciliation not verified'
    : 'RECONCILIATION FAILED'
);
process.exit(failed.length ? 1 : 0);
