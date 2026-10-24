import { betterAuth } from 'better-auth/minimal';
import type { BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { admin, captcha, magicLink, twoFactor } from 'better-auth/plugins';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { tanstackStartCookies } from 'better-auth/tanstack-start';
import { getDb, schema } from '../db/client';
import { queueEmail } from '../server/email';
import { waitUntil } from '../server/exec-context';
import { ac, roles } from './permissions';
import { AccountDeletionError, deleteAccountAtomically } from '../server/account-deletion';

// ownerEmails comes from the OWNER_EMAIL Worker variable (comma-separated).
// The owner account itself is created from variables by
// scripts/bootstrap-owner.mjs (OWNER_EMAIL + OWNER_PASSWORD secret). This
// hook is what grants the role: a verified account created with a listed
// email is created as `owner` only while no owner exists; every other
// sign-up is a customer. Staff below owner are created in the admin.
async function markTwoFactorPassed(db: D1Database, userId: string, sessionId: string) {
  await db
    .prepare(
      `INSERT INTO staff_two_factor_sessions (session_id, user_id, verified_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET verified_at = excluded.verified_at`
    )
    .bind(sessionId, userId, new Date().toISOString())
    .run();
}

/** Listed after twoFactor(): plugin after-hooks run in plugin order, so a
 *  pending challenge has already nulled newSession here. A live session
 *  on a 2FA account means a trusted device passed the gate. */
function trustedDeviceMarker(db: D1Database) {
  return {
    id: 'trusted-device-marker',
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === '/sign-in/email',
          handler: createAuthMiddleware(async (ctx) => {
            const data = ctx.context.newSession;
            if (data?.user.twoFactorEnabled && data.session.id) {
              await markTwoFactorPassed(db, data.user.id, data.session.id);
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

async function tokenFromReturned(returned: unknown): Promise<string | null> {
  try {
    if (returned instanceof Response) {
      const body = (await returned.clone().json()) as { token?: unknown };
      return typeof body.token === 'string' ? body.token : null;
    }
    if (returned && typeof returned === 'object' && 'token' in returned) {
      const token = (returned as { token?: unknown }).token;
      return typeof token === 'string' ? token : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function createAuth(
  db: D1Database,
  baseURL: string,
  secret?: string,
  ownerEmails: string[] = [],
  turnstileSecretKey?: string,
  appName = 'Store',
  trustedOrigins: string[] = []
) {
  if (!secret) {
    // Fail closed: sessions signed with an ephemeral secret would silently
    // break (and weaken) auth. Set BETTER_AUTH_SECRET via wrangler secret.
    throw new Error('BETTER_AUTH_SECRET is not configured');
  }
  const owners = new Set(ownerEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const adminPlugin = admin({ defaultRole: 'customer', adminRoles: ['owner', 'admin'], ac, roles });
  return betterAuth({
    appName,
    baseURL,
    trustedOrigins: [baseURL, ...trustedOrigins],
    secret,
    // Block HTTP exposure while retaining the store's guarded server-side API calls.
    disabledPaths: Object.values(adminPlugin.endpoints).map((endpoint) => endpoint.path),
    database: drizzleAdapter(getDb(db), { provider: 'sqlite', schema }),
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      // Better Auth docs (advanced backgroundTasks): on Cloudflare Workers
      // the handler must hand promises to ctx.waitUntil or background work
      // (verification/magic-link mail) may be dropped when the response ends.
      backgroundTasks: {
        handler: (p) => waitUntil(p),
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: 'database',
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-in/magic-link': { window: 60, max: 5 },
        '/sign-up/email': { window: 60, max: 10 },
        '/two-factor/verify-totp': { window: 60, max: 10 },
        '/two-factor/verify-otp': { window: 60, max: 10 },
        '/two-factor/verify-backup-code': { window: 60, max: 10 },
        '/request-password-reset': { window: 60, max: 3 },
        '/get-session': false,
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        // The store transaction removes the identity and anonymizes financial links;
        // Better Auth then finishes its idempotent cleanup and cookie removal.
        beforeDelete: async (user) => {
          const current = await db
            .prepare('SELECT role FROM user WHERE id=?')
            .bind(user.id)
            .first<{ role: string }>();
          if (current?.role === 'owner' || current?.role === 'admin') {
            throw new APIError('FORBIDDEN', {
              message: 'Another owner must demote this account before it can be deleted.',
            });
          }
          try {
            // Installed 1.7.10 safely repeats cleanup after this atomic deletion.
            await deleteAccountAtomically(db, user.id);
          } catch (error) {
            if (error instanceof AccountDeletionError)
              throw new APIError(error.status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', {
                message: error.message,
              });
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Account deletion failed. Please try again.',
            });
          }
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Staff must use password + TOTP. A magic link would create a staff
        // session without the second factor, so staff addresses are refused
        // at the send step (before any link is issued).
        if (ctx.path === '/sign-in/magic-link') {
          const email = typeof ctx.body?.email === 'string' ? ctx.body.email.toLowerCase() : '';
          if (email) {
            const row = await db
              .prepare('SELECT role FROM user WHERE email = ?')
              .bind(email)
              .first<{ role: string }>();
            if (row && isStaff(row.role)) {
              throw new APIError('FORBIDDEN', {
                message:
                  'Staff accounts must sign in with a password and two-factor authentication.',
                code: 'STAFF_MAGIC_LINK_DISABLED',
              });
            }
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith('/two-factor/verify-')) {
          const token = await tokenFromReturned(ctx.context.returned);
          if (!token) return;
          const session = await db
            .prepare('SELECT id, user_id FROM session WHERE token = ?')
            .bind(token)
            .first<{ id: string; user_id: string }>();
          if (session) await markTwoFactorPassed(db, session.user_id, session.id);
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (newUser) => {
            // Bootstrap window: the OWNER_EMAIL grant only exists while no
            // owner does. Once an owner exists, listed emails sign up as
            // customers like anyone else, and further owners are promoted
            // by an existing owner in the admin. This closes the grant
            // permanently instead of leaving it live for the deployment's life.
            let grantOwner = false;
            // The OWNER_EMAIL grant additionally requires a verified email:
            // a public signup that merely names the owner's address must
            // never become the owner. The bootstrap script verifies the
            // account through deployment access (wrangler) first.
            if (owners.has(newUser.email.toLowerCase()) && newUser.emailVerified) {
              const row = await db
                .prepare(`SELECT COUNT(*) AS c FROM user WHERE role = 'owner'`)
                .first<{ c: number }>();
              grantOwner = (row?.c ?? 0) === 0;
            }
            return {
              data: {
                ...newUser,
                role: grantOwner ? 'owner' : (newUser.role ?? 'customer'),
              },
            };
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await queueEmail(db, {
          to: user.email,
          subject: 'Reset your password',
          text: `Reset your password using this link (expires in 1 hour): ${url}`,
          html: `<p>Reset your password using this link (expires in 1 hour):</p><p><a href="${url}">${url}</a></p>`,
        });
      },
    },
    emailVerification: {
      // Sent through the transactional outbox (Cloudflare Email Service).
      // Not awaited: Better Auth's docs warn that awaiting the send leaks
      // account-existence timing.
      sendVerificationEmail: async ({ user, url }) => {
        // Returned (not swallowed): Better Auth routes this promise through
        // the backgroundTasks handler above, so delivery is guaranteed by
        // ctx.waitUntil instead of racing the end of the response.
        await queueEmail(db, {
          to: user.email,
          subject: 'Verify your email address',
          text: `Verify your email address: ${url}`,
          html: `<p>Verify your email address:</p><p><a href="${url}">${url}</a></p>`,
        });
      },
    },
    plugins: [
      adminPlugin,
      ...(turnstileSecretKey
        ? [captcha({ provider: 'cloudflare-turnstile', secretKey: turnstileSecretKey })]
        : []),
      twoFactor({ issuer: appName }),
      trustedDeviceMarker(db),
      magicLink({
        // Better Auth 1.7.10 awaits sendMagicLink inline (it is not routed
        // through backgroundTasks; verified in the installed dist and the
        // plugin source). That is safe here because this callback only
        // enqueues a durable outbox row (one D1 insert + queue send) — the
        // email itself is sent later by the queue consumer/cron. Keep this
        // callback enqueue-only; never send mail inline from it.
        sendMagicLink: async ({ email, url }) => {
          await queueEmail(db, {
            to: email,
            subject: 'Your sign-in link',
            text: `Sign in using this link (expires soon): ${url}`,
            html: `<p>Sign in using this link (expires soon):</p><p><a href="${url}">${url}</a></p>`,
          });
        },
      }),
      tanstackStartCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

// One module-level instance per configuration inside an isolate: creating
// Better Auth is not free, and several helpers in one request must share it.
// Workers bindings arrive per request, so the cache key is the binding plus
// the public configuration, never a secret value in plaintext.
const authInstances = new WeakMap<object, Map<string, Auth>>();

export function getAuthInstance(
  db: D1Database,
  config: {
    baseURL: string;
    secret?: string | undefined;
    ownerEmails?: string[];
    turnstileSecretKey?: string | undefined;
    appName?: string | undefined;
    trustedOrigins?: string[];
  }
): Auth {
  const key = [
    config.baseURL,
    config.trustedOrigins?.join(',') ?? '',
    config.ownerEmails?.join(',') ?? '',
    config.turnstileSecretKey ? 'turnstile' : '',
    config.appName ?? 'Store',
    config.secret ? 'secret' : '',
  ].join('|');
  let byConfig = authInstances.get(db);
  if (!byConfig) {
    byConfig = new Map<string, Auth>();
    authInstances.set(db, byConfig);
  }
  const existing = byConfig.get(key);
  if (existing) return existing;
  const auth = createAuth(
    db,
    config.baseURL,
    config.secret,
    config.ownerEmails ?? [],
    config.turnstileSecretKey,
    config.appName ?? 'Store',
    config.trustedOrigins ?? []
  );
  byConfig.set(key, auth);
  return auth;
}

export function ownerEmailsFromEnv(env: { OWNER_EMAIL?: unknown }): string[] {
  const raw = env.OWNER_EMAIL;
  return typeof raw === 'string' ? raw.split(',') : [];
}

export const STAFF_ROLES = ['owner', 'manager', 'support', 'warehouse'] as const;
export function isStaff(role: string | null | undefined): boolean {
  return role === 'admin' || (STAFF_ROLES as readonly string[]).includes(role ?? '');
}
