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
import { AdminNav } from '../../components/AdminNav';
import { RealtimeRefresh } from '../../components/RealtimeRefresh';

const getNavigation = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('cloudflare:workers');
  try {
    const staff = await requireStaff(env.DB, getRequest());
    return { staff, storeName: (await getSettings(env.DB)).storeName, redirect: null };
  } catch (error) {
    if (error instanceof AuthError)
      return {
        staff: null,
        storeName: '',
        redirect:
          error.code === 'TWO_FACTOR_REQUIRED' ? ('/account' as const) : ('/auth/sign-in' as const),
      };
    throw error;
  }
});
export const Route = createFileRoute('/admin')({
  beforeLoad: async ({ location }) => {
    const navigation = await getNavigation();
    if (navigation.redirect === '/auth/sign-in')
      throw redirect({ to: navigation.redirect, search: { redirect: location.href } });
    if (navigation.redirect) throw redirect({ to: navigation.redirect });
    return navigation;
  },
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
  const { storeName, staff } = Route.useRouteContext();
  return (
    <div className="min-h-screen bg-white sm:pl-[190px] min-[56.25rem]:pl-[222px]">
      <a
        href="#admin-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:text-zinc-950 focus:shadow"
      >
        Skip to content
      </a>
      <AdminNav storeName={storeName} role={staff?.role} />
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
