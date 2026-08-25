/**
 * Session context.
 *
 * The session lives in HttpOnly cookies the browser cannot read, so the client
 * learns who it is by asking `/api/auth/session`. That call also mints the CSRF
 * token, which is why it must complete before any mutation is attempted — the
 * provider gates the app on it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, refreshSession, setCsrfToken, type SessionUser } from './api';

export interface SessionState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly user: SessionUser | null;
  readonly authenticated: boolean;
  /** Present when the session endpoint itself is unreachable. */
  readonly error: string | null;
}

export interface SessionContextValue extends SessionState {
  /** Re-read the session. Called after sign-in and after sign-out. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<SessionState>({
    status: 'loading',
    user: null,
    authenticated: false,
    error: null,
  });

  const refresh = useCallback(async () => {
    try {
      const session = await refreshSession();
      setState({
        status: 'ready',
        user: session.user,
        authenticated: session.authenticated,
        error: null,
      });
    } catch {
      // A failed session read must not be fatal: anonymous browsing is the main
      // use of the site, and the wall should still render.
      setState({
        status: 'error',
        user: null,
        authenticated: false,
        error: 'We could not confirm your sign-in status. Browsing still works.',
      });
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      const response = await api.post<{ signedOut: boolean; csrfToken: string }>(
        '/api/auth/signout',
      );
      // The server hands back an anonymous-bound CSRF token so the page keeps
      // working without a reload.
      setCsrfToken(response.data.csrfToken);
    } catch {
      // Even if the call fails, clear local state: the user asked to sign out and
      // the UI must reflect that. The cookie is cleared server-side on any
      // successful call, and is HttpOnly so we cannot clear it here.
    } finally {
      setState({ status: 'ready', user: null, authenticated: false, error: null });
      await refresh();
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionContextValue>(
    () => ({ ...state, refresh, signOut }),
    [state, refresh, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (context === null) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return context;
}

/**
 * Convenience for gated UI.
 *
 * Note this is a UI convenience ONLY. Every authorization decision is made by
 * the server; hiding a button is presentation, never a control.
 */
export function useRequireAuth(): {
  user: SessionUser | null;
  ready: boolean;
  needsSignIn: boolean;
  needsVerification: boolean;
} {
  const session = useSession();
  return {
    user: session.user,
    ready: session.status !== 'loading',
    needsSignIn: session.status !== 'loading' && !session.authenticated,
    needsVerification: session.user !== null && !session.user.emailVerified,
  };
}
