# Phase 2B todo. Feature playbook steps verbatim, then task units.

## Feature playbook
- [ ] 1. `how` over the affected subsystem. (done from merged PR #13 code reads this session and last; discovery module, routes, schema, checker all inspected at origin/main f99e8fb)
- [ ] 2. `architect` for parallel design exploration. skip: design is decision-complete and approved by the user after three review rounds; reopening it would break scope.
- [ ] 3. Throughput checkpoint (four items below).
- [ ] 4. Delegate code-writing to a subagent. skip: code-coupled single feature plus one migration goes to a single owner per the playbook's own closing rule; subagent dispatch was unavailable in this host last session. Owner keeps review separation by an independent review attempt at the end; if dispatch fails, record BLOCKED: independent review.
- [ ] 5. Verify on the matching surface.
- [ ] 6. Rebase into small, ordered commits.
- [ ] 7. If the design is contested, `interrogate` before shipping. skip: design settled and approved; SQL shape fork is empirical and settled by local D1 measurement, not debate.
- [ ] 8. Run Opening a PR.

## Throughput checkpoint
- Blocking first steps: baseline tests green on origin/main; query-plan and rows-read harness understood before index decisions.
- Independent workstreams: n/a: one coupled feature, shared writes serialize in one worktree.
- Shared mutable state: single owner, single worktree off origin/main; the dirty codex/journal-cover-grid checkout is never touched.
- Smallest safe decomposition: one owner because state, cursor, SQL, and UI share one contract; units below sequence the work.

## Units (each ends green before the next starts)
- [ ] U1. Baseline: focused discovery tests pass untouched.
- [ ] U2. Tests first: shared state v2, ordering comparator, cursor v2 binding.
- [ ] U3. Server: status filter, four sorts, ordering contract, matched SKU, projection.
- [ ] U4. Migration 0019 plus schema and checker registration; collation DDL test.
- [ ] U5. Scale evidence at 100k: query plans, deep-page seeks, rows read; finalize index set and SQL shapes from measurements.
- [ ] U6. Products page: status and sort selects, price range, variant count, matched SKU, empty-state reset.
- [ ] U7. Docs: evidence and Recently updated semantics.
- [ ] U8. Gates in order: focused tests, 100k scale, lint, format, typecheck, check:migrations, fresh build plus check:bundle, full suite.
- [ ] U9. Browser verification on compiled local preview only.
- [ ] U10. Independent review attempt; PR opened; no merge.

## Invariants
- Local only. No deployment, no remote migration, no production data, no merge.
- SKU search stays case-sensitive. Commerce writes untouched.
