import { expect, it, vi } from 'vitest';
import { checkoutFailureDetails } from '../web/src/server/checkout-intents';

vi.mock('../web/src/server/env', () => ({ workerEnv: {} }));

it('identifies local D1 commit-token failure without exposing its message', () => {
  const details = checkoutFailureDetails(
    new Error(
      'D1_ERROR: Failed to get session commit token: internal error; reference = private-reference'
    )
  );
  expect(details.reason).toBe('d1_commit_token');
  expect(JSON.stringify(details)).not.toContain('private-reference');
});

it('retains safe provider diagnostics but excludes request data and echoed PII', () => {
  const details = checkoutFailureDetails({
    name: 'Error',
    type: 'StripeConnectionError',
    code: 'ETIMEDOUT',
    param: 'customer',
    requestId: 'req_fixture',
    message: 'Request for shopper@example.test failed',
    headers: { Authorization: 'secret' },
    cause: { code: 'ECONNRESET' },
  });
  expect(details).toMatchObject({
    type: 'StripeConnectionError',
    code: 'ETIMEDOUT',
    requestId: 'req_fixture',
    causeCode: 'ECONNRESET',
  });
  expect(JSON.stringify(details)).not.toMatch(/shopper|Authorization|secret/);
  expect(checkoutFailureDetails(new Error('Provider deadline exceeded')).reason).toBe(
    'provider_deadline'
  );
});
