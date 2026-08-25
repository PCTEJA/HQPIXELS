/**
 * Returned from Stripe without paying.
 *
 * Tone matters here: nothing has gone wrong, nothing has been charged, and the
 * hold is probably still alive. Saying so plainly is better than an error page,
 * and there is deliberately no "are you sure you want to miss out" prompt.
 */

import { Link, useSearchParams } from 'react-router-dom';
import { useCheckoutStatus } from '../lib/queries';
import { formatCents } from '../lib/format';
import { Alert } from '../components/primitives';

export function ClaimCancelledPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const reservationId = params.get('reservation');
  const status = useCheckoutStatus(reservationId, { pollWhilePending: false });

  const data = status.data;
  const stillHeld =
    data !== undefined &&
    ['reserved', 'ready_for_checkout', 'checkout_created', 'payment_failed'].includes(
      data.reservationState,
    );

  return (
    <div className="mx-auto max-w-xl text-center">
      <h1 className="text-2xl font-semibold">Payment not completed</h1>
      <p className="mt-3 text-ink-muted">
        You came back without paying, so <strong>nothing has been charged</strong>.
      </p>

      {data !== undefined && (
        <div className="glass mt-6 p-5 text-left">
          <p className="text-sm text-ink-muted">
            Amount that was due:{' '}
            <span className="tabular font-semibold text-ink">{formatCents(data.amountCents)}</span>
          </p>
          {stillHeld ? (
            <Alert tone="info" className="mt-4" title="Your units are still held">
              You can pick up where you left off. If the hold lapses, the units go straight back on
              the wall and you can select again &mdash; there is no penalty either way.
            </Alert>
          ) : (
            <Alert tone="warning" className="mt-4" title="That hold has ended">
              The units have returned to the wall. Choose an area again to continue.
            </Alert>
          )}
        </div>
      )}

      <div className="mt-8 flex flex-wrap justify-center gap-2">
        {stillHeld && reservationId !== null ? (
          <Link
            to={`/claim/resume?reservation=${reservationId}`}
            className="btn btn-cta no-underline"
          >
            Finish this claim
          </Link>
        ) : (
          <Link to="/claim" className="btn btn-cta no-underline">
            Choose an area
          </Link>
        )}
        <Link to="/wall" className="btn btn-ghost no-underline">
          Browse the wall
        </Link>
        <Link to="/dashboard" className="btn btn-ghost no-underline">
          Your dashboard
        </Link>
      </div>

      <p className="mt-8 text-sm text-ink-subtle">
        Changed your mind about something? <Link to="/contact">Ask us anything</Link> &mdash; we
        would rather answer a question than have you buy something you are unsure about.
      </p>
    </div>
  );
}

export default ClaimCancelledPage;
