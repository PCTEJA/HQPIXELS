/**
 * Sign-in.
 *
 * Three options, no passwords: Google, GitHub, email magic link. That removes
 * credential stuffing, password reuse, reset flows and password storage from the
 * threat model entirely.
 *
 * Note the response to a magic-link request is always the same sentence whether
 * or not the address has an account. That is deliberate: a different message
 * would turn this form into an account-enumeration oracle.
 */

import { useState } from 'react';
import { api, ApiRequestError } from '../lib/api';
import { Alert, Button, Dialog, TextField } from './primitives';
import { Turnstile, resetTurnstile } from './Turnstile';

export interface SignInDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly redirectPath: string;
}

export function SignInDialog({
  open,
  onClose,
  redirectPath,
}: SignInDialogProps): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [oauthPending, setOauthPending] = useState<'google' | 'github' | null>(null);

  const startOauth = async (provider: 'google' | 'github'): Promise<void> => {
    setError(null);
    setOauthPending(provider);
    try {
      const response = await api.post<{ url: string }>('/api/auth/oauth/start', {
        provider,
        redirectPath,
      });
      // A full navigation, not a popup: popups are blocked often enough that the
      // flow becomes unreliable, and the redirect is what carries the PKCE
      // verifier cookie.
      window.location.assign(response.data.url);
    } catch (caught) {
      setOauthPending(null);
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'We could not start that sign-in. Please try again.',
      );
    }
  };

  const sendMagicLink = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setFieldError(undefined);

    if (turnstileToken === null) {
      setError('Complete the human-verification check first.');
      return;
    }

    setSending(true);
    try {
      await api.post('/api/auth/magic-link', {
        email,
        turnstileToken,
        redirectPath,
      });
      setSent(true);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        setFieldError(caught.fields?.email);
        setError(caught.fields?.email === undefined ? caught.message : null);
        // A used token cannot be reused, so always get a fresh one for a retry.
        resetTurnstile();
        setTurnstileToken(null);
      } else {
        setError('We could not send that link. Please try again.');
      }
    } finally {
      setSending(false);
    }
  };

  const handleClose = (): void => {
    // Reset so reopening does not show a stale "check your inbox".
    setSent(false);
    setError(null);
    setFieldError(undefined);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Sign in to HQPixels"
      description="No password needed. Choose a provider or get a one-time link by email."
      maxWidth="sm"
    >
      {sent ? (
        <div className="space-y-4">
          <Alert tone="success" title="Check your inbox">
            If that address can sign in, a one-time link is on its way. It expires shortly, and it
            only works once.
          </Alert>
          <p className="text-sm text-ink-subtle">
            Nothing arrived? Check your spam folder, then try again in a few minutes. Repeated
            requests are rate limited to protect inboxes from abuse.
          </p>
          <Button variant="ghost" onClick={handleClose} className="w-full">
            Close
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          {error !== null && (
            <Alert tone="danger" title="Sign-in failed">
              {error}
            </Alert>
          )}

          <div className="space-y-2">
            <Button
              variant="ghost"
              className="w-full"
              loading={oauthPending === 'google'}
              loadingLabel="Redirecting to Google"
              onClick={() => void startOauth('google')}
            >
              Continue with Google
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              loading={oauthPending === 'github'}
              loadingLabel="Redirecting to GitHub"
              onClick={() => void startOauth('github')}
            >
              Continue with GitHub
            </Button>
          </div>

          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-hairline" />
            <span className="text-xs uppercase tracking-wider text-ink-subtle">or</span>
            <span className="h-px flex-1 bg-hairline" />
          </div>

          <form onSubmit={(event) => void sendMagicLink(event)} className="space-y-4" noValidate>
            <TextField
              label="Email address"
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              inputMode="email"
              required
              maxLength={254}
              error={fieldError}
              hint="We will email you a one-time sign-in link."
            />

            <Turnstile action="signin" onToken={setTurnstileToken} />

            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={sending}
              loadingLabel="Sending link"
              disabled={email.trim() === '' || turnstileToken === null}
            >
              Email me a sign-in link
            </Button>
          </form>

          <p className="text-xs leading-relaxed text-ink-subtle">
            By signing in you agree to our{' '}
            <a href="/terms" className="text-ink-muted">
              terms of service
            </a>{' '}
            and{' '}
            <a href="/privacy" className="text-ink-muted">
              privacy policy
            </a>
            . We never sell your data.
          </p>
        </div>
      )}
    </Dialog>
  );
}
