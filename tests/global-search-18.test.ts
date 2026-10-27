import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { readFileSync } from 'node:fs';
import { globalSearch } from '../web/src/server/admin-global-search';
import { createSearchGate, runLatestSearch } from '../web/src/lib/global-search';

let db: D1Database, dispose: () => Promise<void>;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 10 });
  await db
    .prepare(
      `INSERT INTO orders (id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, created_at, updated_at)
       VALUES ('o1', 'FF-1001', 'paid', 'paid', 'tee@example.invalid', 'USD', 1000, 1000, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`
    )
    .run();
});
afterEach(async () => {
  await dispose();
});

describe('Phase 18 global search', () => {
  it('finds a product by title and by SKU prefix', async () => {
    const byTitle = await globalSearch(db, 'tee', { orders: true, customers: true });
    expect(byTitle.products.map((p) => p.id)).toContain('p1');
    const bySku = await globalSearch(db, 'TEE', { orders: true, customers: true });
    expect(bySku.products.map((p) => p.id)).toContain('p1');
  });

  it('finds an order by number and a guest contact by email', async () => {
    const byNumber = await globalSearch(db, 'FF-100', { orders: true, customers: true });
    expect(byNumber.orders.map((o) => o.number)).toEqual(['FF-1001']);
    const byEmail = await globalSearch(db, 'tee@example', { orders: true, customers: true });
    expect(byEmail.customers).toEqual([
      { email: 'tee@example.invalid', accountId: null, guestOrderCount: 1, accountOrderCount: 0 },
    ]);
  });

  it('respects permission gates and short queries', async () => {
    const gated = await globalSearch(db, 'FF-100', { orders: false, customers: false });
    expect(gated.orders).toEqual([]);
    expect(gated.customers).toEqual([]);
    const short = await globalSearch(db, 't', { orders: true, customers: true });
    expect(short).toEqual({ products: [], orders: [], customers: [] });
  });
});

describe('Phase 18 global search dialog request gate', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('discards a stale response after a newer search applies', async () => {
    const gate = createSearchGate();
    let current = 'alpha';
    const oldSearch = deferred<string>();
    const oldOutcome = runLatestSearch(
      gate,
      'alpha',
      () => current,
      () => oldSearch.promise
    );
    current = 'alpine';
    const newOutcome = await runLatestSearch(
      gate,
      'alpine',
      () => current,
      async () => 'new'
    );
    expect(newOutcome).toEqual({ applied: true, value: 'new' });
    oldSearch.resolve('old');
    await expect(oldOutcome).resolves.toEqual({ applied: false });
  });

  it('discards an in-flight response when the query drops below two characters', async () => {
    const gate = createSearchGate();
    let current = 'alpha';
    const search = deferred<string>();
    const outcome = runLatestSearch(
      gate,
      'alpha',
      () => current,
      () => search.promise
    );
    current = 'a';
    gate.invalidate();
    search.resolve('late');
    await expect(outcome).resolves.toEqual({ applied: false });
  });

  it('surfaces a current search failure and ignores a stale failure', async () => {
    const gate = createSearchGate();
    let current = 'alpha';
    const staleSearch = deferred<string>();
    const staleOutcome = runLatestSearch(
      gate,
      'alpha',
      () => current,
      () => staleSearch.promise
    );
    current = 'alpine';
    staleSearch.reject(new Error('late failure'));
    await expect(staleOutcome).resolves.toEqual({ applied: false });
    await expect(
      runLatestSearch(
        gate,
        'alpine',
        () => current,
        async () => {
          throw new Error('current failure');
        }
      )
    ).rejects.toThrow('current failure');
  });

  it('merges bounded order and account email candidates in sorted order', async () => {
    await db
      .prepare(
        "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('u-search','Search','tee@account.invalid',1,1,1)"
      )
      .run();
    const found = await globalSearch(db, 'tee@', { orders: true, customers: true });
    expect(found.customers.map((customer) => customer.email)).toEqual([
      'tee@account.invalid',
      'tee@example.invalid',
    ]);
  });

  it('keeps dialog safety behavior and the mobile trigger wired', () => {
    const dialog = readFileSync('web/src/components/GlobalSearch.tsx', 'utf8');
    const nav = readFileSync('web/src/components/AdminNav.tsx', 'utf8');
    expect(dialog).toContain('createSearchGate');
    expect(dialog).toContain('runLatestSearch');
    expect(dialog).toContain('role="alert"');
    expect(dialog).toContain('returnFocusRef');
    expect(dialog).toContain("e.key === 'Escape'");
    expect(dialog).toContain('GlobalSearchMobileTrigger');
    expect(nav).toContain('<GlobalSearchMobileTrigger />');
  });
});
