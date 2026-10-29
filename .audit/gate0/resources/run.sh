#!/bin/sh
set -eu
# Run from the repository root after creating the isolated main archive.
sh .audit/gate0/resources/prepare-baseline.sh
node_modules/.bin/vitest run --config .audit/gate0/resources/vitest.config.ts -t 'records ' > .audit/gate0/resources/run.log 2>&1
node_modules/.bin/vitest run --config .audit/gate0/resources/vitest.config.ts -t supplemental > .audit/gate0/resources/supplemental.log 2>&1
node .audit/gate0/resources/cost-sheet.mjs
