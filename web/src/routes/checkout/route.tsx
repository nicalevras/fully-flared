import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';
import { Route as RootRoute } from '../__root';
export const Route = createFileRoute('/checkout')({ component: CheckoutLayout });
function CheckoutLayout() {
  const { storeName } = RootRoute.useLoaderData();
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-zinc-100">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-4">
          <Link to="/">{storeName}</Link>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
