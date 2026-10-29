# Resource audit artifacts

- `measurements.md` records measured operation counts, local timing limits and the checkout gate status.
- `results.json` contains all raw successful samples and query plans.
- `monthly-budget.md` lists current prices, explicit workload assumptions and missing telemetry.
- `cost-scenarios.json` contains18 illustrative cache/CPU/page-depth scenarios.
- `run.sh` reproduces the local probes against the exact main archive. See the provenance section before running.
- `run.log` and `supplemental.log` record the passing test runs.

No deployed capacity or total monthly bill is certified. No production data, application file or infrastructure was changed by this audit.

## Restore the exact source baseline

The approval package now includes `../evidence/baseline-source.tar.gz`, produced from main `6339f228c3dd7b9a71442d0983b73695bdab306e`. Its SHA-256 is `b723f9027e8ae911be164ddbb26f0d12f8d1ab346baef3f09f98e53cadc96878`.

Run `sh .audit/gate0/resources/prepare-baseline.sh` from the repository root. It restores the archive only when the baseline is absent, and reuses installed dependencies. This improves source reproducibility but does not turn the original run into a fresh lockfile dependency installation. `run.sh` invokes this preparation automatically.
