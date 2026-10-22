// Used only by `npx auth generate` to produce the canonical Better Auth
// Drizzle schema. Runtime auth is created per-request in src/lib/auth.ts.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { admin, magicLink, twoFactor } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../src/db/schema';

export const auth = betterAuth({
  database: drizzleAdapter(drizzle({} as unknown as D1Database, { schema }), {
    provider: 'sqlite',
    schema,
  }),
  emailAndPassword: { enabled: true },
  plugins: [
    admin({ defaultRole: 'customer' }),
    twoFactor(),
    magicLink({ sendMagicLink: async () => {} }),
  ],
});
