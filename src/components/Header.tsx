/**
 * Site header.
 *
 * The wordmark is set in type rather than as an image so the interface does not
 * depend on a particular logo export. When a transparent-background mark is
 * dropped into /public/logo.svg it renders alongside the wordmark; until then
 * the glyph tile below stands in. Either way the layout does not inherit the
 * logo's colour cast.
 */

import { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useSession } from '../lib/session';
import { SignInDialog } from './SignInDialog';
import { useEscapeKey } from '../lib/hooks';

const NAV_ITEMS: ReadonlyArray<{ to: string; label: string }> = [
  { to: '/wall', label: 'The wall' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/rankings', label: 'Rankings' },
  { to: '/stats', label: 'Stats' },
  { to: '/faq', label: 'FAQ' },
];

export function Header(): React.JSX.Element {
  const session = useSession();
  const location = useLocation();
  const [signInOpen, setSignInOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEscapeKey(mobileOpen, () => setMobileOpen(false));

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-hairline bg-obsidian/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link
            to="/"
            className="flex items-center gap-2.5 text-ink no-underline"
            aria-label="HQPixels home"
          >
            <BrandMark />
            <span className="text-[1.0625rem] font-semibold tracking-tight">
              HQ<span className="text-cyan">Pixels</span>
            </span>
          </Link>

          <nav aria-label="Main" className="ml-2 hidden items-center gap-1 md:flex">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  [
                    'rounded-control px-3 py-2 text-sm font-medium no-underline transition-colors',
                    isActive
                      ? 'bg-surface text-ink'
                      : 'text-ink-muted hover:bg-surface hover:text-ink',
                  ].join(' ')
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {session.status === 'loading' ? (
              // A fixed-size placeholder, not a spinner: this slot swapping size
              // on load is a visible layout shift on every page load.
              <div
                className="h-11 w-24 animate-pulse rounded-control bg-surface"
                aria-hidden="true"
              />
            ) : session.authenticated ? (
              <>
                {session.user?.isAdmin === true && (
                  <Link to="/admin" className="btn btn-ghost hidden sm:inline-flex">
                    Admin
                  </Link>
                )}
                <Link to="/dashboard" className="btn btn-ghost">
                  Dashboard
                </Link>
                <Link to="/claim" className="btn btn-cta">
                  Claim your plot
                </Link>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-ghost" onClick={() => setSignInOpen(true)}>
                  Sign in
                </button>
                <Link to="/claim" className="btn btn-cta hidden sm:inline-flex">
                  Claim your plot
                </Link>
              </>
            )}

            <button
              type="button"
              className="btn btn-ghost md:hidden"
              aria-expanded={mobileOpen}
              aria-controls="mobile-nav"
              onClick={() => setMobileOpen((open) => !open)}
            >
              <span className="sr-only">{mobileOpen ? 'Close menu' : 'Open menu'}</span>
              <MenuIcon open={mobileOpen} />
            </button>
          </div>
        </div>

        {mobileOpen && (
          <nav
            id="mobile-nav"
            aria-label="Main, mobile"
            className="border-t border-hairline bg-surface px-4 py-2 md:hidden"
          >
            <ul className="flex flex-col">
              {NAV_ITEMS.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    onClick={() => setMobileOpen(false)}
                    className={({ isActive }) =>
                      [
                        'block rounded-control px-3 py-3 text-base no-underline',
                        isActive ? 'bg-surface-raised text-ink' : 'text-ink-muted',
                      ].join(' ')
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
              {session.authenticated && (
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOpen(false);
                      void session.signOut();
                    }}
                    className="block w-full rounded-control px-3 py-3 text-left text-base text-ink-muted"
                  >
                    Sign out
                  </button>
                </li>
              )}
            </ul>
          </nav>
        )}
      </header>

      <SignInDialog
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        redirectPath={location.pathname === '/' ? '/dashboard' : location.pathname}
      />
    </>
  );
}

/**
 * Placeholder brand mark: a 3x3 lattice of squares echoing the wall's grid.
 *
 * Deliberately drawn in the interface's own palette rather than sampling the
 * logo, so replacing /public/logo.svg later needs no CSS changes.
 */
function BrandMark(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="grid h-8 w-8 shrink-0 grid-cols-3 grid-rows-3 gap-[2px] rounded-md border border-hairline-bright bg-surface p-[3px]"
    >
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => (
        <span
          key={index}
          className={[
            'rounded-[1px]',
            index === 4 ? 'bg-cyan' : index % 3 === 0 ? 'bg-hairline-bright' : 'bg-hairline',
          ].join(' ')}
        />
      ))}
    </span>
  );
}

function MenuIcon({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      {open ? (
        <path
          d="M4 4l10 10M14 4L4 14"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M2 5h14M2 9h14M2 13h14"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
