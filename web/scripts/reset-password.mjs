// Local operator utility: reset a user's password hash in D1 using Better
// Auth's own hasher (same format the auth library verifies against).
// Usage: TARGET_EMAIL=you@example.com NEW_PASSWORD=... node scripts/reset-password.mjs
import { writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hashPassword } from 'better-auth/crypto';

const email = process.env.TARGET_EMAIL;
const newPassword = process.env.NEW_PASSWORD;
if (!email || !newPassword) {
  console.error('Set TARGET_EMAIL and NEW_PASSWORD in the environment.');
  process.exit(1);
}

function queryOne(sql) {
  writeFileSync('.reset-query.sql', sql);
  try {
    const out = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'store-db', '--local', '--json', '--file', '.reset-query.sql'],
      { encoding: 'utf-8', shell: true }
    );
    const parsed = JSON.parse(out.slice(out.indexOf('[')));
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((s) => s.results ?? [])[0];
  } finally {
    unlinkSync('.reset-query.sql');
  }
}

const user = queryOne(`SELECT id FROM user WHERE email = '${email.replace(/'/g, "''")}';`);
if (!user) {
  console.error(`No user with email ${email}`);
  process.exit(1);
}

const hash = await hashPassword(newPassword);
queryOne(
  `UPDATE account SET password = '${hash}' WHERE user_id = '${user.id}' AND provider_id = 'credential';`
);
console.log(`Password updated for ${email}`);
