import { createAuthClient } from 'better-auth/react';
import { adminClient, magicLinkClient, twoFactorClient } from 'better-auth/client/plugins';
import { ac, roles } from './permissions';

export const authClient = createAuthClient({
  plugins: [adminClient({ ac, roles }), magicLinkClient(), twoFactorClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
