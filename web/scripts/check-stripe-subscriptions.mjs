// Read-only acceptance check against an exported actual Stripe endpoint object.
import { readFileSync } from 'node:fs';
import { missingStripeSubscriptions } from '../src/server/stripe-events.ts';
if (!process.argv[2])
  throw new Error('Usage: node scripts/check-stripe-subscriptions.mjs endpoint.json');
const endpoint = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (endpoint.status !== 'enabled' || endpoint.api_version !== '2026-09-30.endive')
  throw new Error('Endpoint must be enabled on API version 2026-09-30.endive');
const missing = missingStripeSubscriptions(endpoint.enabled_events ?? []);
if (missing.length) throw new Error(`Missing subscriptions: ${missing.join(', ')}`);
console.log(
  'Exported Stripe endpoint subscriptions match the required manifest. Verify its URL and account before release.'
);
