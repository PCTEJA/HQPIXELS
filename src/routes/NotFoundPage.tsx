/**
 * 404 Not Found page.
 *
 * Provides helpful navigation links rather than a dead end. Imported
 * non-lazily by App.tsx because it is part of the catch-all route.
 */

import { Link } from 'react-router-dom';

export function NotFoundPage(): React.JSX.Element {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
      <p className="text-6xl font-bold text-ink-subtle">404</p>
      <h1 className="mt-4 text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 max-w-md text-ink-muted">
        The page you are looking for does not exist or may have been moved.
      </p>

      <nav className="mt-8 flex flex-wrap justify-center gap-3" aria-label="Suggested pages">
        <Link to="/wall" className="btn btn-primary no-underline">
          View the wall
        </Link>
        <Link to="/claim" className="btn btn-cta no-underline">
          Claim your space
        </Link>
      </nav>

      <div className="mt-6 flex flex-wrap justify-center gap-4 text-sm">
        <Link to="/faq" className="text-cyan hover:underline">
          FAQ
        </Link>
        <Link to="/contact" className="text-cyan hover:underline">
          Contact us
        </Link>
        <Link to="/" className="text-cyan hover:underline">
          Home
        </Link>
      </div>
    </div>
  );
}

export default NotFoundPage;
