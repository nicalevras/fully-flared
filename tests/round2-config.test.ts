import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exactDevOrigins } from '../web/src/server/origins';
import { resolveAuthBaseUrl } from '../web/src/server/session';

it('unset development origins keep localhost usable, exact hosts are accepted and wildcards rejected', () => {
  expect(exactDevOrigins(undefined)).toEqual([]);
  expect(resolveAuthBaseUrl(undefined, new Request('http://localhost:8799'))).toBe(
    'http://localhost:8799'
  );
  expect(exactDevOrigins('https://your-tunnel-hostname.example.com,http://localhost:8799')).toEqual(
    ['https://your-tunnel-hostname.example.com', 'http://localhost:8799']
  );
  expect(() => exactDevOrigins('https://*.example.com')).toThrow();
});

it.each([
  ['BETTER_AUTH_URL', 'REPLACE_WITH_STORE_URL'],
  ['OWNER_EMAIL', ''],
  ['OWNER_EMAIL', 'not-an-email'],
])('deployment CLI rejects invalid %s=%j with otherwise valid configuration', (key, value) => {
  const folder = mkdtempSync(join(tmpdir(), 'store-config-test-'));
  const config = join(folder, 'wrangler.json');
  const valid = {
    name: 'store-config-test',
    compatibility_date: '2026-10-17',
    vars: {
      BETTER_AUTH_URL: 'https://store.example.com',
      OWNER_EMAIL: 'owner@example.com',
      QUEUE_NAMES: {
        JOBS: 'jobs',
        NOTIFICATIONS: 'mail',
        CATALOG_JOBS: 'store-catalog',
        DLQ: 'dead',
      },
    },
    routes: [{ pattern: 'store.example.com', custom_domain: true }],
    queues: {
      producers: [
        { binding: 'JOBS', queue: 'jobs' },
        { binding: 'NOTIFICATIONS', queue: 'mail' },
        { binding: 'CATALOG_JOBS', queue: 'store-catalog' },
      ],
      consumers: [
        { queue: 'store-catalog', max_concurrency: 1, dead_letter_queue: 'dead' },
        { queue: 'dead' },
      ],
    },
  };
  const run = (vars: Record<string, unknown>) => {
    writeFileSync(config, JSON.stringify({ ...valid, vars }));
    return spawnSync(
      process.execPath,
      [resolve('web/scripts/validate-deploy.mjs'), '--config', config],
      { encoding: 'utf8' }
    );
  };
  try {
    const invalid = run({ ...valid.vars, [key]: value });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain(key);
    expect(run(valid.vars).status).toBe(0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
