import { useRef, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { authClient } from '../../lib/auth-client';
import { getAuthConfig } from '../../lib/authFns';
import { TurnstileWidget } from '../../components/TurnstileWidget';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

export const Route = createFileRoute('/_shop/auth/forgot')({
  loader: async () => getAuthConfig({ data: {} }),
  head: () => ({
    meta: [{ title: 'Reset your password' }, { name: 'robots', content: 'noindex' }],
  }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const { turnstileSiteKey } = Route.useLoaderData();
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileResetRef = useRef<(() => void) | null>(null);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function requestReset() {
    setBusy(true);
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/auth/reset',
      fetchOptions: turnstileToken
        ? { headers: { 'x-captcha-response': turnstileToken } }
        : undefined,
    });
    setMessage(
      error?.status === 429
        ? 'Too many requests. Wait a minute and try again.'
        : 'If an account exists for that email, a reset link is on its way.'
    );
    setTurnstileToken('');
    turnstileResetRef.current?.();
    setBusy(false);
  }

  return (
    <main className="mx-auto max-w-md py-14 lg:py-20">
      <Card className="p-6 sm:p-8">
        <h1 className="text-center text-[24px] font-medium tracking-tight">Reset your password</h1>
        <p className="mt-1.5 text-center text-sm text-zinc-500">
          Enter your account email and we will send you a reset link.
        </p>
        <form
          className="mt-6 space-y-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void requestReset();
          }}
        >
          <div>
            <Label htmlFor="forgot-email">Email</Label>
            <Input
              id="forgot-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </div>
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            action="auth"
            onToken={setTurnstileToken}
            resetRef={turnstileResetRef}
          />
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={busy || !email || (Boolean(turnstileSiteKey) && !turnstileToken)}
          >
            {busy ? 'One moment…' : 'Send reset link'}
          </Button>
        </form>
        {message ? (
          <Alert className="mt-4 text-center" role="status">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}
      </Card>
      <p className="mt-5 text-center text-[13px] text-zinc-500">
        <Link to="/auth/sign-in" className="font-medium text-zinc-950 underline underline-offset-2">
          Back to sign in
        </Link>
      </p>
    </main>
  );
}
