// Create the store owner from variables: OWNER_EMAIL (wrangler var / env)
// grants the owner role at account creation. Idempotent: if the account
// already exists, it signs in and reports the existing role instead.
//
// Password handling: never pass the password inline on a command line (it
// lands in shell history and the process list). With no OWNER_PASSWORD in
// the environment this script prompts with hidden input. For automation,
// inject it from your secret manager instead, e.g.:
//   varlock run -- npm run bootstrap:owner
//   op run -- npm run bootstrap:owner
// Usage: node scripts/bootstrap-owner.mjs [baseUrl]
import { createInterface } from 'node:readline';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = new URL(process.argv[2] ?? process.env.STORE_BASE_URL ?? 'http://localhost:8799')
  .origin;
const remote = process.env.WRANGLER_REMOTE === '1';
const environment = process.env.WRANGLER_ENV;
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname);
if (!loopback && !remote && process.env.WRANGLER_REMOTE !== '0')
  throw new Error(
    'Non-loopback URL: select WRANGLER_REMOTE=0 for a local Tunnel or 1 for a deployed database'
  );
if (remote && !environment)
  throw new Error('Remote bootstrap requires WRANGLER_ENV (production or a named environment)');
if (remote && loopback)
  throw new Error('A loopback HTTP server cannot bootstrap a remote database');
const namedEnv = environment && environment !== 'production' ? environment : undefined;
const config = unstable_readConfig({
  config: join(root, 'wrangler.jsonc'),
  ...(namedEnv ? { env: namedEnv } : {}),
});
if (remote && config.vars.BETTER_AUTH_URL !== base)
  throw new Error('HTTP origin does not match the selected deployment configuration');
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
function sqlFile(sql) {
  const folder = mkdtempSync(join(tmpdir(), 'store-owner-'));
  if (!folder.startsWith(join(tmpdir(), 'store-owner-')))
    throw new Error('Unexpected temporary path');
  const file = join(folder, 'bootstrap.sql');
  writeFileSync(file, sql, { mode: 0o600 });
  try {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          wrangler,
          'd1',
          'execute',
          'DB',
          remote ? '--remote' : '--local',
          ...(namedEnv ? ['--env', namedEnv] : []),
          '--config',
          join(root, 'wrangler.jsonc'),
          '--file',
          file,
          '--json',
        ],
        { cwd: root, shell: false, encoding: 'utf8' }
      )
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const original = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (text) => {
      if (text.startsWith(question)) original(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function promptVisible(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const email = process.env.OWNER_EMAIL ?? (await promptVisible('Owner email: '));
const password = process.env.OWNER_PASSWORD ?? (await promptHidden('Owner password: '));
if (!email || !password) {
  console.error('OWNER_EMAIL and a password are required.');
  process.exit(1);
}

async function call(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

const signup = await call('/api/auth/sign-up/email', { name: 'Store Owner', email, password });
if (signup.status === 200 && signup.body?.user?.id) {
  const userId = String(signup.body.user.id);
  const escapedEmail = email.toLowerCase().replace(/'/g, "''");
  const escapedId = userId.replace(/'/g, "''");
  try {
    const results = sqlFile(
      `UPDATE user SET email_verified=1,role='owner' WHERE id='${escapedId}' AND lower(email)='${escapedEmail}' RETURNING id,email_verified,role;`
    );
    const rows = results.flatMap((result) => result.results ?? []);
    if (rows.length > 0) {
      if (
        rows.length !== 1 ||
        rows[0].id !== userId ||
        rows[0].role !== 'owner' ||
        rows[0].email_verified !== 1
      )
        throw new Error('Affected account verification failed');
      console.log(`Owner created and verified: ${email}`);
      process.exit(0);
    }
    // Better Auth conceals existing emails with a synthetic signup response.
    // Zero affected rows must fall through to password and selected-database verification.
  } catch (error) {
    console.error('Account creation succeeded, but owner verification failed:', error.message);
    process.exit(1);
  }
}

const signin = await call('/api/auth/sign-in/email', { email, password });
if (signin.status === 200 && ['owner', 'admin'].includes(signin.body?.user?.role)) {
  const existingId = String(signin.body.user.id).replace(/'/g, "''");
  const existing = sqlFile(
    `SELECT id,role,email_verified FROM user WHERE id='${existingId}' AND lower(email)='${email.toLowerCase().replace(/'/g, "''")}';`
  ).flatMap((r) => r.results ?? []);
  if (
    existing.length !== 1 ||
    existing[0].role !== signin.body.user.role ||
    existing[0].email_verified !== 1
  ) {
    console.error('Existing owner does not match selected database');
    process.exit(1);
  }
  console.log(
    `Owner already exists and password matches: ${email} role=${signin.body?.user?.role ?? ''}`
  );
  process.exit(0);
}

console.error(`Bootstrap failed. sign-up=${signup.status} sign-in=${signin.status}`);
console.error('If the account exists with a different password, sign in at /auth/sign-in instead.');
process.exit(1);
