import { useRef, useState } from 'react';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import { authClient } from '../../lib/auth-client';
import { getAuthConfig } from '../../lib/authFns';
import { signInSearch } from '../../lib/search-params';
import { TurnstileWidget } from '../../components/TurnstileWidget';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export const Route = createFileRoute('/_shop/auth/sign-in')({
  validateSearch: signInSearch,
  loader: async () => getAuthConfig({ data: {} }),
  head: () => ({ meta: [{ title: 'Sign in' }, { name: 'robots', content: 'noindex' }] }),
  component: SignInPage,
});

function SignInPage() {
  const router = useRouter();
  const { turnstileSiteKey } = Route.useLoaderData();
  const { redirect: returnTo = '/account' } = Route.useSearch();
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileResetRef = useRef<(() => void) | null>(null);
  const captchaFetchOptions = turnstileToken
    ? { headers: { 'x-captcha-response': turnstileToken } }
    : undefined;
  const resetCaptcha = () => {
    setTurnstileToken('');
    turnstileResetRef.current?.();
  };
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsTotp, setNeedsTotp] = useState(false);
  const [totpCode, setTotpCode] = useState('');

  async function withPassword() {
    setBusy(true);
    if (mode === 'signup') {
      const { error } = await authClient.signUp.email({
        name: name || email,
        email,
        password,
        fetchOptions: captchaFetchOptions,
      });
      if (error) setMessage(error.message ?? 'Sign-up failed');
      else
        setMessage('Account created. Check your email to verify your address before signing in.');
    } else {
      const { data, error } = await authClient.signIn.email({
        email,
        password,
        fetchOptions: captchaFetchOptions,
      });
      if (error) setMessage(error.message ?? 'Sign-in failed. Check your email and password.');
      else if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) {
        // Staff accounts carry mandatory two-factor: finish the second step.
        setNeedsTotp(true);
        setMessage('Enter the 6-digit code from your authenticator app.');
      } else {
        await router.invalidate();
        router.navigate({ href: returnTo });
      }
    }
    resetCaptcha();
    setBusy(false);
  }

  async function withTotp() {
    setBusy(true);
    const { error } = await authClient.twoFactor.verifyTotp({ code: totpCode });
    if (error)
      setMessage(error.message ?? 'That code did not verify. Try the current code from your app.');
    else {
      await router.invalidate();
      router.navigate({ href: returnTo });
    }
    setBusy(false);
  }
  async function withMagicLink() {
    setBusy(true);
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: returnTo,
      fetchOptions: captchaFetchOptions,
    });
    setMessage(
      error
        ? (error.message ?? 'Failed to send link')
        : 'Check your email. Your sign-in link is on its way.'
    );
    resetCaptcha();
    setBusy(false);
  }

  return (
    <main className="mx-auto max-w-md py-14 lg:py-20">
      <Card className="p-6 sm:p-8">
        <h1 className="text-center text-[24px] font-medium tracking-tight">
          {mode === 'signin' ? 'Welcome back' : 'Create your account'}
        </h1>
        <p className="mt-1.5 text-center text-sm text-zinc-500">
          {mode === 'signin'
            ? 'Sign in to track orders and check out faster.'
            : 'One account for orders, tracking, and returns.'}
        </p>

        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(value) => {
            if (value === 'signin' || value === 'signup') setMode(value);
          }}
          className="mt-6 grid w-full grid-cols-2"
          aria-label="Sign in or create account"
        >
          {(
            [
              ['signin', 'Sign in'],
              ['signup', 'Create account'],
            ] as const
          ).map(([m, label]) => (
            <ToggleGroupItem key={m} value={m} className="w-full">
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <form
          className="mt-6 space-y-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            withPassword();
          }}
        >
          {mode === 'signup' ? (
            <div>
              <Label htmlFor="auth-name">Name</Label>
              <Input
                id="auth-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                type="text"
                autoComplete="name"
                placeholder="Your name"
              />
            </div>
          ) : null}
          <div>
            <Label htmlFor="auth-email">Email</Label>
            <Input
              id="auth-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </div>
          <div>
            <Label htmlFor="auth-password">Password</Label>
            <Input
              id="auth-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              placeholder="Your password"
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
            disabled={busy || (Boolean(turnstileSiteKey) && !turnstileToken)}
          >
            {busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </Button>
          {mode === 'signin' ? (
            <p className="text-center text-[13px]">
              <Link
                to="/auth/forgot"
                className="font-medium text-zinc-950 underline underline-offset-2"
              >
                Forgot your password?
              </Link>
            </p>
          ) : null}
        </form>

        {needsTotp ? (
          <form
            className="mt-5 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              withTotp();
            }}
          >
            <div>
              <Label htmlFor="auth-totp">Authenticator code</Label>
              <Input
                id="auth-totp"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                placeholder="123456"
              />
            </div>
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={busy || totpCode.length < 6}
            >
              {busy ? 'Verifying…' : 'Verify and sign in'}
            </Button>
          </form>
        ) : null}

        <div className="my-5 flex items-center gap-3 text-xs text-zinc-400" aria-hidden>
          <Separator className="flex-1" /> or <Separator className="flex-1" />
        </div>
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          onClick={withMagicLink}
          disabled={busy || !email || (Boolean(turnstileSiteKey) && !turnstileToken)}
        >
          Email me a sign-in link instead
        </Button>

        {message ? (
          <Alert
            className="mt-4 text-center"
            variant={/fail|error|invalid|incorrect/i.test(message) ? 'destructive' : 'default'}
          >
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}
      </Card>
      <p className="mt-5 text-center text-[13px] text-zinc-500">
        Store owner? Sign in with the owner email and head to the{' '}
        <Link to="/admin" className="font-medium text-zinc-950 underline underline-offset-2">
          admin
        </Link>
        .
      </p>
    </main>
  );
}
