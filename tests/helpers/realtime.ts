import { withOverrides } from './fixtures';

type RealtimeNamespace = Cloudflare.Env['REALTIME'];

/** The REALTIME namespace with `broadcast` answered by the test; every other member stays real. */
export function realtimeWithBroadcast(
  namespace: RealtimeNamespace,
  broadcast: () => Promise<void>
): RealtimeNamespace {
  return withOverrides(namespace, {
    getByName: (name) => withOverrides(namespace.getByName(name), { broadcast }),
  });
}
