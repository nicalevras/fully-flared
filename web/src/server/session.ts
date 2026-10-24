import { getAuthInstance, isStaff, ownerEmailsFromEnv, type Auth } from '../lib/auth';
import { getSettings } from './settings';
import { workerEnv, exactDevOrigins, runtimeConfigSchema } from './env';
import { roleCan, type statement } from '../lib/permissions';

export type AuthErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'TWO_FACTOR_REQUIRED';

/** Typed auth failure: loaders and routes branch on `code`, never on message text. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Check the endpoint's permission after requireStaff has authenticated its caller. */
export function requireStaffPermission(
  staff: { role?: string | null | undefined },
  resource: keyof typeof statement,
  action: string
): void {
  if (!roleCan(staff.role, resource, action)) {
    throw new AuthError('FORBIDDEN', `Permission required: ${resource}.${action}`);
  }
}

/**
 * Resolve the Better Auth base URL. A valid configured URL always wins
 * (Better Auth docs: links/trusted origins must not follow the request
 * Host). The wrangler placeholder (`REPLACE_WITH_STORE_URL`) or any other
 * invalid value only falls back to the request origin for loopback hosts,
 * so `wrangler dev` works untouched while a misconfigured production
 * deploy still fails closed instead of trusting a spoofed Host.
 */
export function resolveAuthBaseUrl(
  configured: string | undefined,
  request: Request,
  devOrigins: string[] = []
): string {
  // Installer placeholders (REPLACE_WITH_*) count as unset, never as a URL.
  const requestOrigin = new URL(request.url).origin;
  if (devOrigins.includes(requestOrigin)) return requestOrigin;
  const raw = configured?.trim();
  const candidate = raw && !raw.startsWith('REPLACE_WITH_') ? raw : undefined;
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch {
      // Fall through to the loopback/dev handling below.
    }
  }
  const requestUrl = new URL(request.url);
  const host = requestUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return requestUrl.origin;
  }
  throw new Error(
    'BETTER_AUTH_URL is not configured: set it to the store public URL (wrangler vars) before serving auth.'
  );
}

// The store name only feeds Better Auth's appName/TOTP issuer. Reading
// settings from D1 on every auth call put a query on the hottest path in
// the app; cache it per isolate for 60s (a rename lags at most a minute,
// and only in the issuer label).
let appNameCache: { value: string; at: number } | null = null;
const APP_NAME_TTL_MS = 60_000;

export async function getAppName(db: D1Database): Promise<string> {
  if (appNameCache && Date.now() - appNameCache.at < APP_NAME_TTL_MS) return appNameCache.value;
  const settings = await getSettings(db).catch(() => null);
  const value = settings?.storeName || 'Store';
  appNameCache = { value, at: Date.now() };
  return value;
}

export async function getRequestAuth(db: D1Database, request: Request): Promise<Auth> {
  runtimeConfigSchema.parse(workerEnv);
  const baseURL = resolveAuthBaseUrl(
    workerEnv.BETTER_AUTH_URL,
    request,
    exactDevOrigins(workerEnv.DEV_TRUSTED_ORIGINS)
  );
  return getAuthInstance(db, {
    baseURL,
    trustedOrigins: exactDevOrigins(workerEnv.DEV_TRUSTED_ORIGINS),
    secret: workerEnv.BETTER_AUTH_SECRET,
    ownerEmails: ownerEmailsFromEnv(workerEnv),
    turnstileSecretKey: workerEnv.TURNSTILE_SECRET_KEY,
    appName: await getAppName(db),
  });
}

export async function getSession(db: D1Database, request: Request) {
  const auth = await getRequestAuth(db, request);
  return auth.api.getSession({ headers: request.headers });
}

export async function getSessionUser(db: D1Database, request: Request) {
  const session = await getSession(db, request);
  return session?.user ?? null;
}

export async function hasPassedTwoFactor(db: D1Database, sessionId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT session_id FROM staff_two_factor_sessions WHERE session_id = ?')
    .bind(sessionId)
    .first();
  return Boolean(row);
}

/** Better Auth's two-factor plugin adds this flag to the user object;
 *  the base user type does not declare it. One Zod-checked read instead
 *  of s unknown as casts at every call site. */
import * as z from 'zod';
const twoFactorUserSchema = z.looseObject({ twoFactorEnabled: z.boolean().optional() });
export function twoFactorEnabledOf(user: unknown): boolean {
  const parsed = twoFactorUserSchema.safeParse(user);
  return parsed.success ? Boolean(parsed.data.twoFactorEnabled) : false;
}

export async function requireStaff(db: D1Database, request: Request) {
  return (await requireStaffSession(db, request)).user;
}

export async function requireStaffSession(db: D1Database, request: Request) {
  const session = await getSession(db, request);
  const user = session?.user;
  if (!user) throw new AuthError('UNAUTHENTICATED', 'Sign in required');
  if (!isStaff(user.role)) throw new AuthError('FORBIDDEN', 'Staff access required');
  // Plan Step 4: staff two-factor is mandatory, and it must have been passed
  // by this session (password sign-in deletes the provisional session until
  // TOTP verification creates the real one; magic-link staff sign-in is
  // refused in the auth hooks). A role granted to an already-signed-in
  // customer session has no marker and is locked out until they sign in
  // again through the full gate. Marker error lets loaders redirect instead
  // of 500.
  const twoFactorEnabled = twoFactorEnabledOf(user);
  if (!twoFactorEnabled)
    throw new AuthError('TWO_FACTOR_REQUIRED', 'Two-factor authentication required');
  if (!session.session?.id || !(await hasPassedTwoFactor(db, session.session.id))) {
    throw new AuthError('TWO_FACTOR_REQUIRED', 'Two-factor authentication required');
  }
  return { user, sessionId: session.session.id };
}
