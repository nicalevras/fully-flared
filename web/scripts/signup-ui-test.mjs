// Sign-up UI gate: the auth page must offer account creation, not only
// sign-in. Requires the dev server running.
// Usage: node scripts/signup-ui-test.mjs [baseUrl]
const base = process.argv[2] ?? 'http://localhost:8799';
const res = await fetch(`${base}/auth/sign-in`);
if (!res.ok) throw new Error(`GET /auth/sign-in -> ${res.status}`);
const html = await res.text();
const checks = {
  'create-account toggle present': html.includes('Create account'),
  'sign-in still present': html.includes('Sign in'),
  'password field present': html.includes('type="password"'),
};
let failed = false;
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
