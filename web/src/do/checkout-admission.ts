import { DurableObject } from 'cloudflare:workers';
import {
  createAdmission,
  loadAdmissionConfig,
  parseAdmissionConfigFromDefaults,
  type AdmissionStorage,
  type AcquireResult,
} from '../server/checkout-admission';
import type { AdmissionConfig } from '../lib/settings-definitions';

// Per-store checkout admission controller (Phase 5). One instance
// ("store") owns the token bucket and active permits in SQLite
// storage; every decision runs inside a synchronous storage
// transaction, so concurrent shoppers cannot oversubscribe the
// budget. Configuration is read from D1 settings at most once a
// minute (shared in-flight read, outside any storage transaction);
// a failed refresh keeps the last bounded config, and a cold start
// uses the bounded defaults — never unlimited.
const CONFIG_TTL_MS = 60_000;

export class CheckoutAdmissionDO extends DurableObject<Cloudflare.Env> {
  private configCache: { value: AdmissionConfig; expiresAt: number } | null = null;
  private configInflight: Promise<AdmissionConfig> | null = null;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS admission_bucket (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           tokens REAL NOT NULL,
           updated_at_ms INTEGER NOT NULL
         )`
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS admission_permits (
           id TEXT PRIMARY KEY,
           deadline_ms INTEGER NOT NULL
         )`
      );
    });
  }

  private storageAdapter(): AdmissionStorage {
    const sql = this.ctx.storage.sql;
    return {
      readBucket: () => {
        const row = sql
          .exec<{ tokens: number; updated_at_ms: number }>(
            'SELECT tokens, updated_at_ms FROM admission_bucket WHERE id = 1'
          )
          .toArray()[0];
        return row ? { tokens: row.tokens, updatedAtMs: row.updated_at_ms } : null;
      },
      writeBucket: (tokens, updatedAtMs) => {
        sql.exec(
          'INSERT INTO admission_bucket (id, tokens, updated_at_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET tokens = excluded.tokens, updated_at_ms = excluded.updated_at_ms',
          tokens,
          updatedAtMs
        );
      },
      countActivePermits: (nowMs) =>
        sql
          .exec<{ n: number }>(
            'SELECT COUNT(*) AS n FROM admission_permits WHERE deadline_ms > ?',
            nowMs
          )
          .one().n,
      addPermit: (id, deadlineMs) => {
        sql.exec('INSERT INTO admission_permits (id, deadline_ms) VALUES (?, ?)', id, deadlineMs);
      },
      removePermit: (id) =>
        sql.exec('DELETE FROM admission_permits WHERE id = ?', id).rowsWritten > 0,
      deleteExpiredPermits: (nowMs) =>
        sql.exec('DELETE FROM admission_permits WHERE deadline_ms <= ?', nowMs).rowsWritten,
      nextPermitDeadline: () =>
        sql
          .exec<{ d: number | null }>('SELECT MIN(deadline_ms) AS d FROM admission_permits')
          .toArray()[0]?.d ?? null,
    };
  }

  private async currentConfig(): Promise<AdmissionConfig> {
    const now = Date.now();
    if (this.configCache && this.configCache.expiresAt > now) return this.configCache.value;
    if (!this.configInflight) {
      this.configInflight = loadAdmissionConfig(this.env.DB)
        .then((value) => {
          this.configCache = { value, expiresAt: Date.now() + CONFIG_TTL_MS };
          return value;
        })
        .catch(() => this.configCache?.value ?? parseAdmissionConfigFromDefaults())
        .finally(() => {
          this.configInflight = null;
        });
    }
    return this.configInflight;
  }

  async acquire(): Promise<AcquireResult> {
    const config = await this.currentConfig();
    const admission = createAdmission(this.storageAdapter(), () => config);
    const result = this.ctx.storage.transactionSync(() => admission.acquire(Date.now()));
    await this.scheduleAlarm();
    return result;
  }

  async release(permitId: string): Promise<void> {
    const admission = createAdmission(
      this.storageAdapter(),
      () => this.configCache?.value ?? parseAdmissionConfigFromDefaults()
    );
    this.ctx.storage.transactionSync(() => admission.release(permitId));
  }

  override async alarm(): Promise<void> {
    const admission = createAdmission(
      this.storageAdapter(),
      () => this.configCache?.value ?? parseAdmissionConfigFromDefaults()
    );
    this.ctx.storage.transactionSync(() => admission.sweepExpired(Date.now()));
    await this.scheduleAlarm();
  }

  /** Keeps one alarm armed at the next permit deadline so expired
   *  permits release their capacity even if no shopper ever returns. */
  private async scheduleAlarm(): Promise<void> {
    const next = this.storageAdapter().nextPermitDeadline();
    if (next != null) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
}
