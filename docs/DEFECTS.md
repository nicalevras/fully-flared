# Defect Regression Register

Defect classes found in this project's early audit history, each mapped to
the fix in the current codebase and the regression test that keeps it closed.
A defect is closed only when its test exists and passes. No `TODO`/`FIXME`
ships in `web/src/`.

| #   | Defect class                                                                                     | Closed by                                              | Regression test                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | All commerce data in one Durable Object, per-statement SQL-over-RPC                              | D1 foundation (D1 is the system of record)             | `tests/defect-regressions.test.ts` (#1) — schema has no DO storage classes for commerce data                                                                    |
| 2   | Stripe key split-brain: key written to local storage at setup, checkout reads a different source | Secrets-only configuration                             | `tests/defect-regressions.test.ts` (#2) — checkout succeeds with secrets-only configuration                                                                     |
| 3   | OAuth magic link rendered in an HTTP response (account takeover)                                 | Auth/email hardening                                   | `tests/feature-gates.test.ts` (magic-link response) — no token string appears in any response body                                                              |
| 4   | Realtime socket unrouted; subscriptions in an in-memory Map lost on hibernation                  | Hibernatable WebSocket Durable Object + outbox fan-out | `tests/realtime.test.ts` — forced eviction preserves subscriptions and delivery                                                                                 |
| 5   | Cron releases reservations carts never made; checkout holds leak forever                         | Ledger-based hold/commit/release accounting            | `tests/inventory.test.ts`, `tests/checkout.test.ts`, `tests/feature-gates.test.ts` (ledger rebuild) — hold, expiry, commit, and release accounting nets to zero |
| 6   | Only `checkout.session.completed` handled; no expired/async/refund/dispute sync                  | Full webhook event set with idempotent replay          | `tests/checkout.test.ts`, `tests/webhook-backoff.test.ts` — full event set replayed 3x and out of order is idempotent                                           |
| 7   | In-memory per-isolate rate limiting keyed by a shared public key (store-wide limit)              | Platform-layer limits keyed per IP + cart token        | `tests/defect-regressions.test.ts` (#7), `tests/checkout-caps.test.ts`, `tests/turnstile.test.ts`                                                               |
| 8   | Open CORS; admin credential in browser localStorage; no rotation                                 | Session auth + scoped CORS                             | `tests/defect-regressions.test.ts` (#8), `tests/security-auth.test.ts`, `tests/customer-admin.test.ts`                                                          |
| 9   | USD hardcoded in checkout; free-shipping default; tax enabled without tax codes                  | Store-settings-driven currency/shipping/tax            | `tests/defect-regressions.test.ts` (#9) — session currency equals store setting                                                                                 |
| 10  | Test/CI coverage deleted during a rewrite and never restored                                     | Restored suites + CI gate                              | `tests/helpers.test.ts`, `tests/discounts.test.ts` passing; CI gate on every PR                                                                                 |

## Commerce remediation evidence — 2026-10-18

Earlier milestone rows describe historical defects, not deployed acceptance.
The implementation/verification ledger is `docs/archive/REMEDIATION.md`.

- Money, stock and notifications: `tests/commerce-safety.test.ts`,
  `tests/checkout.test.ts`, `tests/refunds.test.ts`, `tests/late-refund.test.ts`.
  Payment/cancellation races, receipt rollback, pending/failed partial refunds,
  return permission/recovery, atomic caps and poison inboxes are covered.
- Checkout/boundaries: `tests/remediation.test.ts`,
  `tests/config-boundaries.test.ts`, `tests/feature-gates.test.ts`. Shipping is
  required, archived parents are rejected, missing Stripe returns 503 without
  side effects, and backorders/weights reach admin and storefront controls.
- Migration/restore: `tests/restore-cli.test.ts`,
  `npm run check:migrations`. Forward upgrades preserve populated commerce
  data; recovery itself is D1 Time Travel (see root README).
- Publication/cache: `tests/catalog-publication.test.ts`,
  `tests/scaling.test.ts` and private-cache assertions in `commerce-safety`.
  D1 controls publication order; degraded search uses the complete FTS index.
- Runtime/auth: `tests/realtime-runtime.test.ts` uses actual workerd eviction.
  `web/scripts/verify-http.mjs` calls actual Start endpoints with disposable
  identity fixtures to verify authorization, statuses, redirects and ownership.

Deployment-only claims remain pending: actual Stripe subscriptions/charges,
supported-host cache hits, deployed performance and reconciliation soak.
Outbox deduplication does not promise exactly-once external email transport.
