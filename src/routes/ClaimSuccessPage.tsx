/**
 * Return page after Stripe Checkout.
 *
 * IMPORTANT: this page cannot fulfil a payment. It polls a read-only status
 * endpoint whose database function is declared STABLE in PostgreSQL, so it is
 * physically incapable of writing. Publication happens only via the
 * signature-verified webhook (or the reconciler if a webhook was lost).
 *
 * Refreshing this page a hundred times therefore does nothing except re-read
 * status, which is exactly what tests/e2e/checkout.spec.ts asserts.
 */

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useCheckoutStatus } from '../lib/queries';
import { formatCents } from '../lib/format';
import { Alert, Badge, Button, EmptyState } from '../components/primitives';
import { useReducedMotion } from '../lib/hooks';

export function ClaimSuccessPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const reservationId = params.get('reservation');
  const reducedMotion = useReducedMotion();
  const [copied, setCopied] = useState(false);

  const status = useCheckoutStatus(reservationId, { pollWhilePending: true });

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (reservationId === null) {
    return (
      <EmptyState title="We do not know which claim this is">
        The link is missing its reference. Your <Link to="/dashboard">dashboard</Link> lists every
        claim and its current status.
      </EmptyState>
    );
  }

  if (status.isPending) {
    return (
      <div role="status" className="py-16 text-center">
        <p className="text-lg font-medium">Confirming your payment…</p>
        <p className="mt-2 text-sm text-ink-muted">
          We are waiting for Stripe to confirm. This usually takes a few seconds.
        </p>
      </div>
    );
  }

  if (status.isError) {
    return (
      <Alert tone="danger" title="We could not load your claim">
        {status.error.message} Your payment is unaffected &mdash; check your{' '}
        <Link to="/dashboard">dashboard</Link> in a moment.
      </Alert>
    );
  }

  const data = status.data;
  if (data === undefined) return <></>;

  const settled = data.fulfilled;
  const live = data.placementStatus === 'active';

  return (
    <div className="mx-auto max-w-2xl">
      <div className="text-center">
        <div
          aria-hidden="true"
          className={[
            'mx-auto grid h-14 w-14 place-items-center rounded-full border',
            settled ? 'border-success/50 bg-success/12' : 'border-cyan/50 bg-cyan/12',
            settled && !reducedMotion ? 'animate-activate' : '',
          ].join(' ')}
        >
          <span className={settled ? 'text-2xl text-success' : 'text-2xl text-cyan'}>
            {settled ? '✓' : '…'}
          </span>
        </div>

        <h1 className="mt-5 text-2xl font-semibold">
          {live
            ? 'Your placement is live'
            : settled
              ? 'Payment received'
              : 'Waiting for confirmation'}
        </h1>

        <p className="mt-2 text-ink-muted">
          {data.nextStep ??
            'We are still waiting for Stripe to confirm this payment. This page updates by itself.'}
        </p>
      </div>

      <div className="glass mt-8 p-5">
        <dl className="space-y-2.5 text-sm">
          <Row label="Amount">
            <span className="tabular font-semibold">{formatCents(data.amountCents)}</span>
          </Row>
          <Row label="Payment">
            <StatusBadge status={data.paymentStatus} />
          </Row>
          <Row label="Placement">
            <StatusBadge status={data.placementStatus} />
          </Row>
        </dl>

        {data.moderationNote !== null && (
          <Alert tone="warning" className="mt-4" title="Note from our review team">
            {data.moderationNote}
          </Alert>
        )}
      </div>

      {settled && !live && (
        <Alert tone="info" className="mt-6" title="What happens next">
          A person reviews every placement against our content policy before it appears on the wall.
          That usually happens within one business day. We will email you either way, and if we
          cannot approve it you get a full refund automatically.
        </Alert>
      )}

      {live && data.shareUrl !== null && (
        <div className="glass mt-6 p-5">
          <h2 className="text-base font-semibold">Share your plot</h2>
          <p className="mt-1 text-sm text-ink-muted">
            A direct link that frames your placement on the wall.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              readOnly
              value={data.shareUrl}
              aria-label="Share link"
              className="field-input tabular flex-1 text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              variant="primary"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(data.shareUrl ?? '')
                  .then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
          <p aria-live="polite" className="sr-only">
            {copied ? 'Share link copied to clipboard.' : ''}
          </p>
        </div>
      )}

      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <Link to="/dashboard" className="btn btn-primary no-underline">
          Go to your dashboard
        </Link>
        {live && data.shareUrl !== null && (
          <a href={data.shareUrl} className="btn btn-ghost no-underline">
            See it on the wall
          </a>
        )}
        <Link to="/claim" className="btn btn-ghost no-underline">
          Claim more space
        </Link>
      </div>

      <p className="mt-8 text-center text-xs text-ink-subtle">
        Stripe emails your receipt. Nothing on this page charges you or changes your order &mdash;
        it only shows the current status.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  switch (status) {
    case 'succeeded':
    case 'active':
      return <Badge tone="verified">{status === 'active' ? 'Live on the wall' : 'Paid'}</Badge>;
    case 'pending_review':
      return <Badge tone="pending">In review</Badge>;
    case 'requires_payment':
    case 'processing':
      return <Badge tone="pending">Processing</Badge>;
    case 'refunded':
    case 'rejected':
      return <Badge tone="sponsored">Refunded</Badge>;
    default:
      return <Badge tone="sponsored">{status.replace(/_/g, ' ')}</Badge>;
  }
}

export default ClaimSuccessPage;
