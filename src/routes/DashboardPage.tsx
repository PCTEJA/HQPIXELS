/**
 * Buyer dashboard.
 *
 * Return value for the buyer: real status, real metrics with their limitations
 * stated, and a share link. Metrics are labelled as estimates where they are
 * estimates.
 */

import { Link } from 'react-router-dom';
import { CELL_LOGICAL_SIZE } from '@shared/constants';
import { useDashboard } from '../lib/queries';
import { useSession } from '../lib/session';
import { formatCents, formatCount, formatCountdown, formatRelativeTime } from '../lib/format';
import { Alert, Badge, Button, EmptyState } from '../components/primitives';

export function DashboardPage(): React.JSX.Element {
  const session = useSession();
  const dashboard = useDashboard(session.authenticated);

  if (session.status === 'loading') {
    return (
      <p role="status" className="text-sm text-ink-subtle">
        Loading…
      </p>
    );
  }

  if (!session.authenticated) {
    return (
      <EmptyState
        title="Sign in to see your placements"
        action={
          <Link to="/" className="btn btn-primary mt-2 no-underline">
            Back to the wall
          </Link>
        }
      >
        Use the Sign in button in the header. We do not use passwords &mdash; you can sign in with
        Google, GitHub or a one-time email link.
      </EmptyState>
    );
  }

  if (dashboard.isPending) {
    return (
      <p role="status" className="text-sm text-ink-subtle">
        Loading your dashboard…
      </p>
    );
  }

  if (dashboard.isError) {
    return (
      <EmptyState title="We could not load your dashboard">{dashboard.error.message}</EmptyState>
    );
  }

  const data = dashboard.data;
  if (data === undefined) return <></>;

  const placements = data.placements as unknown as ReadonlyArray<DashboardRow>;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">Your dashboard</h1>
          <p className="mt-1 text-ink-muted">
            {data.profile.displayName ?? data.profile.email}
            {data.profile.foundingBuyer && (
              <span className="ml-2 align-middle">
                <Badge tone="founding">Founding buyer</Badge>
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/claim" className="btn btn-cta no-underline">
            Claim more space
          </Link>
          <Button variant="ghost" onClick={() => void session.signOut()}>
            Sign out
          </Button>
        </div>
      </div>

      {!data.profile.emailVerified && (
        <Alert tone="warning" className="mt-6" title="Confirm your email address">
          You need a confirmed email address before you can buy space. Check your inbox for our
          verification link.
        </Alert>
      )}

      {/* --- totals --------------------------------------------------------- */}
      <dl className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Live placements" value={formatCount(data.totals.activePlacements)} />
        <Stat label="Pixels owned" value={formatCount(data.totals.logicalPixelsOwned)} />
        <Stat label="Total spent" value={formatCents(data.totals.lifetimeSpendCents)} />
        <Stat label="Impressions" value={formatCount(data.totals.impressions)} estimate />
        <Stat label="Clicks" value={formatCount(data.totals.clicks)} />
      </dl>

      <p className="mt-3 max-w-3xl text-xs leading-relaxed text-ink-subtle">{data.metricsNote}</p>

      {/* --- placements ----------------------------------------------------- */}
      <section aria-labelledby="placements-heading" className="mt-10">
        <h2 id="placements-heading" className="text-xl font-semibold">
          Your placements
        </h2>

        {placements.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="You have not claimed any space yet"
              action={
                <Link to="/claim" className="btn btn-cta mt-2 no-underline">
                  Claim your first plot
                </Link>
              }
            >
              When you do, this page will show its status, impressions and clicks.
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-4 space-y-4">
            {placements.map((placement) => (
              <li key={placement.placementId}>
                <PlacementRow placement={placement} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-10 text-sm text-ink-subtle">
        Need to change something we do not let you edit here, or want a placement removed?{' '}
        <Link to="/contact">Contact us</Link> and quote the placement id.
      </p>
    </div>
  );
}

interface DashboardRow {
  readonly placementId: string;
  readonly reservationId: string;
  readonly state: string;
  readonly placementStatus: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly logicalPixels: number;
  readonly title: string;
  readonly altText: string;
  readonly destinationHost: string | null;
  readonly imageUrl: string | null;
  readonly amountPaidCents: number;
  readonly quotedTotalCents: number;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly activatedAt: string | null;
  readonly moderationNote: string | null;
  readonly statusLabel: string;
  readonly statusHelp: string | null;
  readonly shareUrl: string | null;
  readonly editable: boolean;
  readonly metrics: {
    readonly impressions: number;
    readonly clicks: number;
    readonly clicks7d: number;
    readonly lastClickAt: string | null;
  };
}

function PlacementRow({ placement }: { placement: DashboardRow }): React.JSX.Element {
  const needsAction = placement.state === 'reserved' || placement.state === 'ready_for_checkout';
  const countdown =
    placement.expiresAt !== null && needsAction ? formatCountdown(placement.expiresAt) : null;

  return (
    <article className="glass p-4">
      <div className="flex flex-wrap items-start gap-4">
        {placement.imageUrl !== null ? (
          <img
            src={placement.imageUrl}
            alt={placement.altText}
            className="h-16 w-16 shrink-0 rounded-md border border-hairline object-contain"
            style={{ imageRendering: 'pixelated' }}
          />
        ) : (
          <div
            aria-hidden="true"
            className="grid h-16 w-16 shrink-0 place-items-center rounded-md border border-dashed border-hairline-bright text-xs text-ink-subtle"
          >
            no art
          </div>
        )}

        <div className="min-w-48 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-ink">
              {placement.title === '' ? 'Untitled placement' : placement.title}
            </h3>
            <StatusPill state={placement.state} label={placement.statusLabel} />
          </div>

          <p className="tabular mt-1 text-xs text-ink-subtle">
            {placement.w * CELL_LOGICAL_SIZE} x {placement.h * CELL_LOGICAL_SIZE} px at{' '}
            {placement.x * CELL_LOGICAL_SIZE},{placement.y * CELL_LOGICAL_SIZE} &middot;{' '}
            {formatCount(placement.logicalPixels)} pixels
          </p>

          {placement.statusHelp !== null && (
            <p className="mt-2 max-w-xl text-sm text-ink-muted">{placement.statusHelp}</p>
          )}

          {placement.moderationNote !== null && (
            <Alert tone="warning" className="mt-3" title="Note from our review team">
              {placement.moderationNote}
            </Alert>
          )}

          {countdown !== null && (
            <p className="mt-2 text-sm text-warning" role="status">
              Hold ends in <span className="tabular font-semibold">{countdown}</span>
            </p>
          )}
        </div>

        {/* --- metrics ------------------------------------------------------ */}
        <dl className="grid shrink-0 grid-cols-3 gap-4 text-center sm:gap-6">
          <div>
            <dt className="text-[0.6875rem] uppercase tracking-wide text-ink-subtle">
              Impressions
            </dt>
            <dd className="tabular mt-0.5 font-semibold">
              {formatCount(placement.metrics.impressions)}
            </dd>
            <dd className="text-[0.625rem] text-ink-subtle">estimate</dd>
          </div>
          <div>
            <dt className="text-[0.6875rem] uppercase tracking-wide text-ink-subtle">Clicks</dt>
            <dd className="tabular mt-0.5 font-semibold">
              {formatCount(placement.metrics.clicks)}
            </dd>
            <dd className="text-[0.625rem] text-ink-subtle">filtered</dd>
          </div>
          <div>
            <dt className="text-[0.6875rem] uppercase tracking-wide text-ink-subtle">Last click</dt>
            <dd className="mt-0.5 text-xs">
              {placement.metrics.lastClickAt === null
                ? '—'
                : formatRelativeTime(placement.metrics.lastClickAt)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        <Link
          to={`/dashboard/placements/${placement.placementId}`}
          className="btn btn-ghost min-h-9 px-3 py-1.5 text-xs no-underline"
        >
          {placement.editable ? 'Manage' : 'Details'}
        </Link>

        {needsAction && (
          <Link
            to={`/claim/resume?reservation=${placement.reservationId}`}
            className="btn btn-cta min-h-9 px-3 py-1.5 text-xs no-underline"
          >
            Finish this claim
          </Link>
        )}

        {placement.shareUrl !== null && (
          <a
            href={placement.shareUrl}
            className="btn btn-ghost min-h-9 px-3 py-1.5 text-xs no-underline"
          >
            See on the wall
          </a>
        )}

        <span className="tabular ml-auto text-xs text-ink-subtle">
          {placement.amountPaidCents > 0
            ? `Paid ${formatCents(placement.amountPaidCents)}`
            : `Quoted ${formatCents(placement.quotedTotalCents)}`}{' '}
          &middot; {formatRelativeTime(placement.createdAt)}
        </span>
      </div>
    </article>
  );
}

function StatusPill({ state, label }: { state: string; label: string }): React.JSX.Element {
  if (state === 'active') return <Badge tone="verified">{label}</Badge>;
  if (state === 'paid_pending_review') return <Badge tone="pending">{label}</Badge>;
  if (state === 'reserved' || state === 'ready_for_checkout' || state === 'checkout_created') {
    return <Badge tone="pending">{label}</Badge>;
  }
  return <Badge tone="sponsored">{label}</Badge>;
}

function Stat({
  label,
  value,
  estimate = false,
}: {
  label: string;
  value: string;
  estimate?: boolean;
}): React.JSX.Element {
  return (
    <div className="glass p-4">
      <dt className="text-xs uppercase tracking-[0.08em] text-ink-subtle">{label}</dt>
      <dd className="tabular mt-1.5 text-2xl font-semibold text-ink">{value}</dd>
      {estimate && <dd className="mt-0.5 text-[0.625rem] text-ink-subtle">estimate</dd>}
    </div>
  );
}

export default DashboardPage;
