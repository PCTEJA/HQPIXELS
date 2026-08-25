/**
 * Cloudflare Turnstile widget.
 *
 * The script is loaded on demand — never in the entry bundle — because most
 * visitors never reach a form that needs it.
 *
 * Worth being explicit: this widget is a UX affordance, not a security control.
 * The token it produces means nothing until the Worker exchanges it with
 * Cloudflare's siteverify endpoint and checks the action and hostname. A client
 * that skips the widget entirely simply fails server-side, which is exactly what
 * tests/unit/turnstile.test.ts asserts.
 */

import { useEffect, useId, useRef, useState } from 'react';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'cf-turnstile-script';

type TurnstileAction = 'signin' | 'reserve' | 'upload' | 'checkout' | 'abuse-report';

interface TurnstileRenderOptions {
  sitekey: string;
  action: string;
  theme: 'dark' | 'light' | 'auto';
  size: 'normal' | 'flexible' | 'compact';
  callback: (token: string) => void;
  'error-callback': () => void;
  'expired-callback': () => void;
  'timeout-callback': () => void;
  appearance: 'always' | 'execute' | 'interaction-only';
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof document === 'undefined') return Promise.reject(new Error('no document'));
  if (window.turnstile !== undefined) return Promise.resolve();
  if (scriptPromise !== null) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    if (existing !== null) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Turnstile script failed')));
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => {
      scriptPromise = null;
      reject(new Error('Turnstile script failed to load'));
    });
    document.head.appendChild(script);
  });

  return scriptPromise;
}

export interface TurnstileProps {
  readonly action: TurnstileAction;
  readonly onToken: (token: string | null) => void;
  readonly className?: string;
}

export function Turnstile({ action, onToken, className }: TurnstileProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const describedById = useId();

  // Keep the latest callback without re-rendering the widget: re-rendering it
  // would discard a token the user already solved for.
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (typeof siteKey !== 'string' || siteKey === '') {
      setStatus('error');
      return;
    }

    let cancelled = false;

    void loadTurnstileScript()
      .then(() => {
        if (cancelled || containerRef.current === null || window.turnstile === undefined) return;

        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          // The action is bound into the token and re-checked server-side, which
          // is what stops a token from the cheap sign-in widget being replayed
          // against checkout.
          action,
          theme: 'dark',
          size: 'flexible',
          appearance: 'always',
          callback: (token: string) => onTokenRef.current(token),
          'error-callback': () => {
            setStatus('error');
            onTokenRef.current(null);
          },
          'expired-callback': () => {
            // Clearing the token forces a fresh solve rather than submitting a
            // stale one that the server would reject.
            onTokenRef.current(null);
          },
          'timeout-callback': () => onTokenRef.current(null),
        });

        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
      const widgetId = widgetIdRef.current;
      if (widgetId !== null && window.turnstile !== undefined) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // The widget may already be gone if the script was unloaded.
        }
      }
      widgetIdRef.current = null;
    };
  }, [action, siteKey]);

  return (
    <div className={className}>
      <div ref={containerRef} aria-describedby={describedById} />

      {status === 'loading' && (
        <p className="text-xs text-ink-subtle" role="status">
          Loading verification…
        </p>
      )}

      {status === 'error' && (
        <p className="field-error" role="alert">
          We could not load the human-verification widget. Disable any script blockers for
          challenges.cloudflare.com and reload, or contact us and we will help you claim directly.
        </p>
      )}

      <p id={describedById} className="sr-only">
        This checks that you are a person and not an automated script. It is required before
        reserving space or paying.
      </p>
    </div>
  );
}

/** Resets the widget so a failed submission can be retried with a fresh token. */
export function resetTurnstile(): void {
  if (typeof window !== 'undefined' && window.turnstile !== undefined) {
    try {
      window.turnstile.reset();
    } catch {
      // Nothing to reset.
    }
  }
}
