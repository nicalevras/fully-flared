import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_shop/auth/')({
  beforeLoad: () => {
    throw redirect({ to: '/auth/sign-in' });
  },
});
