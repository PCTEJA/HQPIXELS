/**
 * Manage one owned placement.
 *
 * Editable: title, alt text, destination link.
 * Not editable, ever: position, size, price, owner. Those are immutable in the
 * database, so this form could not change them even if it tried.
 *
 * Changing the destination takes the placement off the wall and re-queues it for
 * review. That is stated plainly before saving, because otherwise "get approved
 * with something innocuous, then swap the link" would bypass the content policy
 * entirely.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CELL_LOGICAL_SIZE, MAX_ALT_TEXT_LENGTH, MAX_TITLE_LENGTH } from '@shared/constants';
import { normalizeDestinationUrl } from '@shared/url-safety';
import { api, ApiRequestError } from '../lib/api';
import { useDashboard } from '../lib/queries';
import { useSession } from '../lib/session';
import { formatCents, formatCount, formatDateTime } from '../lib/format';
import { Alert, Badge, Button, EmptyState, TextField } from '../components/primitives';
import { RemoveHoldButton } from '../components/RemoveHoldButton';

interface EditResponse {
  readonly updated: boolean;
  readonly requiresModeration: boolean;
  readonly message: string;
  readonly manualReviewReasons?: string[];
}

export function PlacementDetailPage(): React.JSX.Element {
  const { placementId } = useParams<{ placementId: string }>();
  const session = useSession();
  const dashboard = useDashboard(session.authenticated);

  const [title, setTitle] = useState('');
  const [altText, setAltText] = useState('');
  const [destination, setDestination] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<EditResponse | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const placement = (dashboard.data?.placements as unknown as ReadonlyArray<Row> | undefined)?.find(
    (row) => row.placementId === placementId,
  );

  useEffect(() => {
    if (placement === undefined) return;
    setTitle(placement.title);
    setAltText(placement.altText);
    setDestination(placement.destinationUrl ?? '');
  }, [placement]);

  if (!session.authenticated) {
    return <EmptyState title="Sign in to manage your placement" />;
  }

  if (dashboard.isPending) {
    return (
      <p role="status" className="text-sm text-ink-subtle">
        Loading…
      </p>
    );
  }

  if (placement === undefined) {
    return (
      <EmptyState
        title="We could not find that placement"
        action={
          <Link to="/dashboard" className="btn btn-ghost mt-2 no-underline">
            Back to your dashboard
          </Link>
        }
      >
        It may belong to a different account, or the id may be wrong.
      </EmptyState>
    );
  }

  const destinationChanged =
    destination.trim() !== '' && destination.trim() !== (placement.destinationUrl ?? '');

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);
    setErrors({});
    setResult(null);

    const body: Record<string, string> = {};
    if (title !== placement.title) body.title = title;
    if (altText !== placement.altText) body.altText = altText;

    if (destinationChanged) {
      const check = normalizeDestinationUrl(destination);
      if (!check.ok) {
        setErrors({ destinationUrl: check.message });
        return;
      }
      body.destinationUrl = destination;
    }

    if (Object.keys(body).length === 0) {
      setFormError('Nothing has changed.');
      return;
    }

    setSaving(true);
    try {
      const response = await api.patch<EditResponse>(
        `/api/dashboard/placements/${placement.placementId}`,
        body,
      );
      setResult(response.data);
      await dashboard.refetch();
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        setErrors(caught.fields ?? {});
        if (caught.fields === undefined) setFormError(caught.message);
      } else {
        setFormError('We could not save that change.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/dashboard" className="text-sm">
        &larr; Back to your dashboard
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {placement.title === '' ? 'Untitled placement' : placement.title}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">{placement.statusLabel}</p>
        </div>
        {placement.shareUrl !== null && (
          <a href={placement.shareUrl} className="btn btn-ghost no-underline">
            See on the wall
          </a>
        )}
      </div>

      {['draft', 'reserved', 'ready_for_checkout'].includes(placement.state) && (
        <section className="glass mt-6 p-5">
          <RemoveHoldButton reservationId={placement.reservationId} />
        </section>
      )}

      {/* --- immutable facts ------------------------------------------------ */}
      <section aria-labelledby="facts-heading" className="glass mt-6 p-5">
        <h2 id="facts-heading" className="text-base font-semibold">
          Fixed details
        </h2>
        <p className="mt-1 text-xs text-ink-subtle">
          Position, size, price and ownership cannot be changed after purchase. This is enforced by
          the database, not just by this page.
        </p>

        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <Fact label="Position">
            {placement.x * CELL_LOGICAL_SIZE}, {placement.y * CELL_LOGICAL_SIZE}
          </Fact>
          <Fact label="Size">
            {placement.w * CELL_LOGICAL_SIZE} x {placement.h * CELL_LOGICAL_SIZE} pixels
          </Fact>
          <Fact label="Pixels owned">{formatCount(placement.logicalPixels)}</Fact>
          <Fact label="Paid">
            {placement.amountPaidCents > 0 ? formatCents(placement.amountPaidCents) : 'not yet'}
          </Fact>
          <Fact label="Claimed">{formatDateTime(placement.createdAt)}</Fact>
          <Fact label="Went live">
            {placement.activatedAt === null ? 'not yet' : formatDateTime(placement.activatedAt)}
          </Fact>
          <Fact label="Placement id">
            <span className="tabular text-xs">{placement.placementId}</span>
          </Fact>
          <Fact label="Status">
            {placement.placementStatus === 'active' ? (
              <Badge tone="verified">Live</Badge>
            ) : (
              <Badge tone="pending">{placement.placementStatus.replace(/_/g, ' ')}</Badge>
            )}
          </Fact>
        </dl>
      </section>

      {/* --- editable ------------------------------------------------------- */}
      {placement.editable ? (
        <form
          onSubmit={(event) => void save(event)}
          className="glass mt-6 space-y-5 p-5"
          noValidate
        >
          <h2 className="text-base font-semibold">Editable details</h2>

          <TextField
            label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={MAX_TITLE_LENGTH}
            counter={{ current: title.length, max: MAX_TITLE_LENGTH }}
            error={errors.title}
          />

          <TextField
            label="Image description (alt text)"
            value={altText}
            onChange={(event) => setAltText(event.target.value)}
            maxLength={MAX_ALT_TEXT_LENGTH}
            counter={{ current: altText.length, max: MAX_ALT_TEXT_LENGTH }}
            error={errors.altText}
            hint="Describe the image for people using a screen reader."
          />

          <TextField
            label="Destination link"
            type="url"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            error={errors.destinationUrl}
            hint="We show visitors the hostname before they leave."
          />

          {destinationChanged && (
            <Alert tone="warning" title="This will take your placement off the wall">
              Changing the destination sends the placement back through review, so it is hidden
              until a moderator approves it &mdash; usually within one business day. Your payment
              and your plot are unaffected.
            </Alert>
          )}

          {formError !== null && (
            <Alert tone="danger" title="Not saved">
              {formError}
            </Alert>
          )}

          {result !== null && (
            <Alert tone={result.updated ? 'success' : 'info'} title="Saved">
              {result.message}
            </Alert>
          )}

          <Button type="submit" variant="primary" loading={saving} loadingLabel="Saving">
            Save changes
          </Button>
        </form>
      ) : (
        <Alert tone="info" className="mt-6" title="This placement cannot be edited right now">
          {placement.statusHelp ??
            'Editing is available while a hold is active, and once a placement is live.'}
        </Alert>
      )}

      {/* --- artwork -------------------------------------------------------- */}
      {placement.imageUrl !== null && (
        <section aria-labelledby="artwork-heading" className="glass mt-6 p-5">
          <h2 id="artwork-heading" className="text-base font-semibold">
            Current artwork
          </h2>
          <img
            src={placement.imageUrl}
            alt={placement.altText}
            className="mt-3 max-h-64 rounded-md border border-hairline object-contain"
            style={{ imageRendering: 'pixelated' }}
          />
          <p className="mt-3 text-xs text-ink-subtle">
            To replace the artwork, <Link to="/contact">contact us</Link>. We handle it manually so
            the replacement goes through the same checks as the original.
          </p>
        </section>
      )}

      {/* --- metrics -------------------------------------------------------- */}
      <section aria-labelledby="metrics-heading" className="mt-6">
        <h2 id="metrics-heading" className="text-base font-semibold">
          Performance
        </h2>
        <dl className="mt-3 grid gap-4 sm:grid-cols-3">
          <div className="glass p-4">
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Impressions</dt>
            <dd className="tabular mt-1 text-2xl font-semibold">
              {formatCount(placement.metrics.impressions)}
            </dd>
            <dd className="mt-1 text-xs text-ink-subtle">
              Times your plot was inside a rendered view of the wall. An estimate, reported by
              browsers.
            </dd>
          </div>
          <div className="glass p-4">
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Clicks (all time)</dt>
            <dd className="tabular mt-1 text-2xl font-semibold">
              {formatCount(placement.metrics.clicks)}
            </dd>
            <dd className="mt-1 text-xs text-ink-subtle">
              Outbound clicks that passed our duplicate and bot filters.
            </dd>
          </div>
          <div className="glass p-4">
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Clicks (7 days)</dt>
            <dd className="tabular mt-1 text-2xl font-semibold">
              {formatCount(placement.metrics.clicks7d)}
            </dd>
            <dd className="mt-1 text-xs text-ink-subtle">
              Aggregated in five-minute buckets; can lag a few minutes.
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

interface Row {
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
  readonly destinationUrl: string | null;
  readonly destinationHost: string | null;
  readonly imageUrl: string | null;
  readonly amountPaidCents: number;
  readonly createdAt: string;
  readonly activatedAt: string | null;
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

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-grid pb-2">
      <dt className="text-sm text-ink-subtle">{label}</dt>
      <dd className="tabular text-sm text-ink">{children}</dd>
    </div>
  );
}

export default PlacementDetailPage;
