import {
  Outlet,
  createFileRoute,
  redirect,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { requireStaff, AuthError } from '../../server/session';
import { getRequest } from '@tanstack/react-start/server';
import { createServerFn } from '@tanstack/react-start';
import { getSettings } from '../../server/settings';
import { resolveMediaSources } from '../../server/media-source';
import { AdminNav } from '../../components/AdminNav';
import { RealtimeRefresh } from '../../components/RealtimeRefresh';

const getNavigation = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('cloudflare:workers');
  try {
    const staff = await requireStaff(env.DB, getRequest());
    const settings = await getSettings(env.DB);
    const brand = await resolveMediaSources(env.DB, [settings.logoMediaId]);
    return {
      staff,
      storeName: settings.storeName,
      logo: brand.get(settings.logoMediaId) ?? null,
      redirect: null,
    };
  } catch (error) {
    if (error instanceof AuthError)
      return {
        staff: null,
        storeName: '',
        logo: null,
        redirect:
          error.code === 'TWO_FACTOR_REQUIRED' ? ('/account' as const) : ('/auth/sign-in' as const),
      };
    throw error;
  }
});
/** Signed-out visitors go to sign-in with their page as the return path; staff who
 *  owe two-factor setup go to the account page. */
export async function enterAdmin({ location }: { location: { href: string } }) {
  const navigation = await getNavigation();
  if (navigation.redirect === '/auth/sign-in')
    throw redirect({ to: navigation.redirect, search: { redirect: location.href } });
  if (navigation.redirect) throw redirect({ to: navigation.redirect });
  return navigation;
}

export const Route = createFileRoute('/admin')({
  beforeLoad: enterAdmin,
  errorComponent: ({ reset }: ErrorComponentProps) => (
    <main className="p-8">
      <h1>Admin could not load</h1>
      <p>Try again. If the problem continues, check the server logs.</p>
      <button onClick={reset}>Try again</button>
    </main>
  ),
  component: AdminLayout,
});

function AdminLayout() {
  const { storeName, staff, logo } = Route.useRouteContext();
  return (
    <div className="min-h-screen bg-white sm:pl-[260px]">
      <a
        href="#admin-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:text-zinc-950 focus:shadow"
      >
        Skip to content
      </a>
      <AdminNav storeName={storeName} logo={logo} role={staff?.role} />
      <div
        id="admin-content"
        tabIndex={-1}
        className="mx-auto max-w-[1338px] min-w-0 px-[21px] py-6 outline-none sm:px-[30px] sm:py-8 min-[75rem]:px-[70px]"
      >
        <RealtimeRefresh />
        <Outlet />
      </div>
    </div>
  );
}
