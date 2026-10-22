import type { WorkerEnv } from './env';

// Cloudflare Turnstile server-side validation (Siteverify). Enforced only
// when TURNSTILE_SECRET_KEY is configured; TURNSTILE_SITE_KEY is the public
// widget key stored as a D1 store setting. Validation is fail-closed and
// checks success, the per-surface action, and the exact request hostname.
export type TurnstileCheck = {
  expectedAction: string;
  expectedHostname: string;
  remoteIp?: string | undefined;
};

type SiteverifyResponse = {
  success?: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
};

export async function verifyTurnstile(
  env: WorkerEnv,
  token: string | undefined,
  check: TurnstileCheck
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // Bot challenge is not configured for this install.
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;
  if (!check.expectedHostname) return false;

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret,
        response: token,
        ...(check.remoteIp ? { remoteip: check.remoteIp } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const result = (await response.json()) as SiteverifyResponse;
    return (
      result.success === true &&
      result.action === check.expectedAction &&
      result.hostname === check.expectedHostname
    );
  } catch {
    return false;
  }
}
