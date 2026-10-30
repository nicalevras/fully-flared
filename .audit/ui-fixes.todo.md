# Persistent tables and modal fixes
- [x] Reproduce it yourself on the matching surface via the driver skill.
- [x] Binary-search the cause.
- [x] Plan the fix. Approved implementation plan and independent designs from previous turn.
- [x] Verify on the same surface.
- [x] Stage the commits so the failing repro lands before the fix in git history.
  skip: user requested implementation, not commits. Regression tests precede final verification.
- [x] Run Opening a PR.
  skip: local implementation only, no PR requested.

throughput checkpoint: delegate disjoint table, modal/editor, and search files; root owns browser verification and integration.
Data shapes: tables always render existing page data with a ReactNode empty row; search outcomes carry query identity; suggestions cache stores successful cards plus one pending request; editor retains one stable DOM host.
Memoir session/recall tools unavailable.
