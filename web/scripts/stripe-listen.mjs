// Only --print is used by local verification; starting Stripe CLI requires a connected account.
import { spawnSync } from 'node:child_process';
import { stripeListenArguments } from '../src/server/stripe-events.ts';

const base = process.argv.find((arg) => /^https?:\/\//.test(arg)) ?? 'http://localhost:8799';
const args = stripeListenArguments(base);
if (process.argv.includes('--print')) {
  console.log(['stripe', ...args].join(' '));
} else {
  const result = spawnSync('stripe', args, { stdio: 'inherit', shell: false });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
