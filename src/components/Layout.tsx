/**
 * Page shell: skip link, header, main landmark, footer.
 *
 * The wall route opts out of the normal page padding because it is a full-bleed
 * canvas, but it keeps the same landmarks so the document outline stays
 * consistent for screen readers.
 */

import { useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Header } from './Header';
import { Footer } from './Footer';

export function Layout({ children }: { children: ReactNode }): React.JSX.Element {
  const location = useLocation();
  const isFullBleed = location.pathname.startsWith('/wall');

  return (
    <>
      {/* First focusable element on the page. Keyboard users should not have to
          tab through the whole nav to reach the content. */}
      <a href="#main" className="skip-link">
        Skip to main content
      </a>

      <Header />

      <main
        id="main"
        // tabIndex -1 so the skip link can move focus here, without adding it to
        // the tab order.
        tabIndex={-1}
        className={
          isFullBleed
            ? 'outline-none'
            : 'mx-auto w-full max-w-6xl px-4 pb-24 pt-8 outline-none sm:px-6'
        }
      >
        {children}
      </main>

      {/* The wall is a full-viewport canvas; a footer under it would push the
          canvas off screen on mobile. */}
      {!isFullBleed && <Footer />}
    </>
  );
}
