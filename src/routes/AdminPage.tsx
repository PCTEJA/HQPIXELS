/**
 * Admin dashboard (placeholder).
 *
 * The full admin surface is built in Task B. This stub gates on admin status
 * and provides navigation back to the dashboard. It exists to satisfy the
 * route import in App.tsx without breaking the build.
 */

import { Link } from 'react-router-dom';
import { useSession } from '../lib/session';
import { Alert, EmptyState } from '../components/primitives';

export function AdminPage(): React.JSX.Element {
  const session = useSession();

  if (session.status === 'loading') {
    return (
      <p role="status" className="text-sm text-ink-subtle">
        Loading&hellip;
      </p>
    );
  }

  // Gate: must be signed in as an admin
  if (!session.authenticated || !session.user?.isAdmin) {
    return (
      <EmptyState
        title="Access denied"
        action={
          <Link to="/dashboard" className="btn btn-primary mt-2 no-underline">
            Go to your dashboard
          </Link>
        }
      >
        This page is only available to administrators.
      </EmptyState>
    );
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-3xl font-semibold">Admin</h1>

      <Alert tone="info" title="Coming soon" className="mt-6">
        <p className="text-sm">
          The full admin surface &mdash; moderation queue, image review, health panel, and audit log
          viewer &mdash; is implemented in the next task.
        </p>
      </Alert>

      <div className="mt-8">
        <Link to="/dashboard" className="text-cyan hover:underline">
          &larr; Back to dashboard
        </Link>
      </div>
    </div>
  );
}

export default AdminPage;
