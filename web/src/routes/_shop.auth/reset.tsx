import { useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { authClient } from '../../lib/auth-client';
import { resetSearch } from '../../lib/search-params';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

export const Route = createFileRoute('/_shop/auth/reset')({
  validateSearch: resetSearch,
  head: () => ({
    meta: [{ title: 'Choose a new password' }, { name: 'robots', content: 'noindex' }],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token, error } = Route.useSearch();
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function resetPassword(resetToken: string) {
    setBusy(true);
    const result = await authClient.resetPassword({ newPassword, token: resetToken });
    if (result.error) {
      setMessage(result.error.message ?? 'That reset link is invalid or has expired.');
    } else {
      setDone(true);
      setMessage('Your password was changed and every other session was signed out.');
    }
    setBusy(false);
  }

  const usableToken = token && !error ? token : null;

  return (
    <main className="mx-auto max-w-md py-14 lg:py-20">
      <Card className="p-6 sm:p-8">
        <h1 className="text-center text-[24px] font-medium tracking-tight">
          Choose a new password
        </h1>
        {usableToken && !done ? (
          <form
            className="mt-6 space-y-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              void resetPassword(usableToken);
            }}
          >
            <div>
              <Label htmlFor="reset-password">New password</Label>
              <Input
                id="reset-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                type="password"
                autoComplete="new-password"
                required
              />
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={busy || !newPassword}>
              {busy ? 'One moment…' : 'Set new password'}
            </Button>
          </form>
        ) : null}
        {usableToken ? null : (
          <Alert className="mt-4 text-center" variant="destructive">
            <AlertDescription>
              That reset link is invalid or has expired. Request a new one.
            </AlertDescription>
          </Alert>
        )}
        {message ? (
          <Alert className="mt-4 text-center" variant={done ? 'default' : 'destructive'}>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}
      </Card>
      <p className="mt-5 text-center text-[13px] text-zinc-500">
        <Link
          to={done ? '/auth/sign-in' : '/auth/forgot'}
          className="font-medium text-zinc-950 underline underline-offset-2"
        >
          {done ? 'Sign in' : 'Request a new link'}
        </Link>
      </p>
    </main>
  );
}
