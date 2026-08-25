/**
 * Admin dashboard.
 *
 * The moderation control centre. All actions are gated on admin status, which
 * requires THREE things: valid session, database `is_admin`, and email in
 * `ADMIN_EMAIL_ALLOWLIST`. Even a database compromise alone does not grant
 * admin access.
 *
 * Every action here is recorded in the append-only audit log by the database,
 * which cannot be edited even by the service role.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../lib/session';
import { formatCents, formatCount, formatDateTime, formatRelativeTime } from '../lib/format';
import {
  useAdminQueue,
  useAdminHealth,
  useAdminAudit,
  useModerate,
  useBulkDisableHost,
  useRebuildManifest,
  type ModerationStatus,
  type AdminQueueItem,
  type ModerationDecision,
} from '../lib/queries';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  LiveRegion,
  TextArea,
  TextField,
} from '../components/primitives';
import { useAnnouncer } from '../lib/hooks';

type AdminTab = 'queue' | 'health' | 'audit';

export function AdminPage(): React.JSX.Element {
  const session = useSession();
  const { message: announcement, announce } = useAnnouncer();

  const [activeTab, setActiveTab] = useState<AdminTab>('queue');
  const [queueStatus, setQueueStatus] = useState<ModerationStatus>('pending_review');

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
    <div className="max-w-6xl">
      <LiveRegion message={announcement} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">Admin</h1>
          <p className="mt-1 text-ink-muted">Moderation queue, system health, and audit log.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/dashboard" className="btn btn-ghost no-underline">
            &larr; Dashboard
          </Link>
        </div>
      </div>

      {/* Tab navigation */}
      <nav aria-label="Admin sections" className="mt-6 flex gap-1 border-b border-hairline">
        <TabButton active={activeTab === 'queue'} onClick={() => setActiveTab('queue')}>
          Moderation Queue
        </TabButton>
        <TabButton active={activeTab === 'health'} onClick={() => setActiveTab('health')}>
          Health
        </TabButton>
        <TabButton active={activeTab === 'audit'} onClick={() => setActiveTab('audit')}>
          Audit Log
        </TabButton>
      </nav>

      {/* Tab content */}
      <div className="mt-6">
        {activeTab === 'queue' && (
          <QueuePanel status={queueStatus} onStatusChange={setQueueStatus} announce={announce} />
        )}
        {activeTab === 'health' && <HealthPanel announce={announce} />}
        {activeTab === 'audit' && <AuditPanel />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={[
        'px-4 py-2 text-sm font-medium transition-colors',
        active ? 'border-b-2 border-cyan text-cyan' : 'text-ink-muted hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Queue Panel
// -----------------------------------------------------------------------------

function QueuePanel({
  status,
  onStatusChange,
  announce,
}: {
  status: ModerationStatus;
  onStatusChange: (status: ModerationStatus) => void;
  announce: (message: string) => void;
}): React.JSX.Element {
  const session = useSession();
  const queue = useAdminQueue(status, session.authenticated && session.user?.isAdmin === true);

  const [selectedItem, setSelectedItem] = useState<AdminQueueItem | null>(null);
  const [bulkHostDialogOpen, setBulkHostDialogOpen] = useState(false);

  const statuses: { value: ModerationStatus; label: string }[] = [
    { value: 'pending_review', label: 'Pending Review' },
    { value: 'active', label: 'Active' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'disabled', label: 'Disabled' },
    { value: 'all', label: 'All' },
  ];

  return (
    <section aria-labelledby="queue-heading">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="queue-heading" className="text-xl font-semibold">
          Moderation Queue
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setBulkHostDialogOpen(true)}>
            Bulk Disable by Host
          </Button>
        </div>
      </div>

      {/* Status filter */}
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {statuses.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => onStatusChange(s.value)}
            aria-pressed={status === s.value}
            className={[
              'rounded-control px-3 py-1.5 text-sm transition-colors',
              status === s.value
                ? 'bg-cyan text-obsidian'
                : 'bg-surface text-ink-muted hover:bg-surface-raised hover:text-ink',
            ].join(' ')}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Queue content */}
      <div className="mt-6">
        {queue.isPending && (
          <p role="status" className="text-sm text-ink-subtle">
            Loading queue&hellip;
          </p>
        )}

        {queue.isError && (
          <Alert tone="danger" title="Could not load queue">
            {queue.error.message}
          </Alert>
        )}

        {queue.isSuccess && queue.data.items.length === 0 && (
          <EmptyState title="No items">No placements match the selected filter.</EmptyState>
        )}

        {queue.isSuccess && queue.data.items.length > 0 && (
          <ul className="space-y-3">
            {queue.data.items.map((item) => (
              <li key={item.placementId}>
                <QueueItem item={item} onSelect={() => setSelectedItem(item)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Placement detail dialog */}
      {selectedItem !== null && (
        <PlacementDetailDialog
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          announce={announce}
        />
      )}

      {/* Bulk disable dialog */}
      <BulkDisableDialog
        open={bulkHostDialogOpen}
        onClose={() => setBulkHostDialogOpen(false)}
        announce={announce}
      />
    </section>
  );
}

function QueueItem({
  item,
  onSelect,
}: {
  item: AdminQueueItem;
  onSelect: () => void;
}): React.JSX.Element {
  const statusBadge = {
    pending_review: { tone: 'pending' as const, label: 'Pending' },
    active: { tone: 'verified' as const, label: 'Active' },
    rejected: { tone: 'pending' as const, label: 'Rejected' },
    disabled: { tone: 'pending' as const, label: 'Disabled' },
  }[item.moderationState] ?? { tone: 'pending' as const, label: item.moderationState };

  return (
    <article className="glass p-4">
      <div className="flex flex-wrap items-start gap-4">
        {/* Thumbnail */}
        {item.imageReviewUrl !== null ? (
          <img
            src={item.imageReviewUrl}
            alt={item.altText}
            className="h-16 w-16 shrink-0 rounded-md border border-hairline object-contain"
            style={{ imageRendering: 'pixelated' }}
          />
        ) : (
          <div
            aria-hidden="true"
            className="grid h-16 w-16 shrink-0 place-items-center rounded-md border border-dashed border-hairline-bright text-xs text-ink-subtle"
          >
            no image
          </div>
        )}

        {/* Details */}
        <div className="min-w-48 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{item.title}</h3>
            <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>
          </div>
          <p className="mt-1 text-sm text-ink-muted">
            {item.w} &times; {item.h} at ({item.x}, {item.y}) &mdash;{' '}
            {formatCount(item.logicalPixels)} pixels &mdash; {formatCents(item.quotedTotalCents)}
          </p>
          <p className="mt-1 text-sm text-ink-subtle">
            Owner: {item.ownerDisplayName ?? item.ownerEmail}
          </p>
          <p className="mt-1 text-sm text-ink-subtle">
            Destination: <span className="text-cyan">{item.destinationHost}</span>
          </p>
          <p className="mt-1 text-xs text-ink-subtle">
            Created {formatRelativeTime(item.createdAt)}
            {item.paidAt !== null && ` \u2022 Paid ${formatRelativeTime(item.paidAt)}`}
          </p>
        </div>

        {/* Action */}
        <Button variant="primary" onClick={onSelect}>
          Review
        </Button>
      </div>
    </article>
  );
}

// -----------------------------------------------------------------------------
// Placement Detail Dialog
// -----------------------------------------------------------------------------

function PlacementDetailDialog({
  item,
  onClose,
  announce,
}: {
  item: AdminQueueItem;
  onClose: () => void;
  announce: (message: string) => void;
}): React.JSX.Element {
  const moderate = useModerate();
  const [reason, setReason] = useState('');
  const [actionInProgress, setActionInProgress] = useState<ModerationDecision | null>(null);

  const handleModerate = async (decision: ModerationDecision): Promise<void> => {
    if (decision === 'reject' || decision === 'disable') {
      if (reason.trim().length < 3) {
        announce('A reason is required for this action.');
        return;
      }
    }

    setActionInProgress(decision);
    try {
      const variables: {
        placementId: string;
        decision: ModerationDecision;
        reason?: string;
        refund?: boolean;
      } = {
        placementId: item.placementId,
        decision,
      };
      const trimmedReason = reason.trim();
      if (trimmedReason) variables.reason = trimmedReason;
      if (decision === 'reject') variables.refund = true;
      const result = await moderate.mutateAsync(variables);

      const messages: Record<ModerationDecision, string> = {
        approve: 'Placement approved. Now live on the wall.',
        reject: result.refund?.succeeded
          ? 'Placement rejected and refund issued.'
          : result.refund?.needsManualAction
            ? 'Placement rejected. Refund requires manual action \u2014 check runbook.'
            : 'Placement rejected.',
        disable: 'Placement disabled and removed from the wall.',
        reenable: 'Placement re-enabled and restored to the wall.',
      };
      announce(messages[decision]);
      onClose();
    } catch {
      announce('Action failed. Check the error and try again.');
    } finally {
      setActionInProgress(null);
    }
  };

  const isPending = item.moderationState === 'pending_review';
  const isActive = item.moderationState === 'active';
  const isDisabled = item.moderationState === 'disabled';

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title="Placement Review"
      description={`Review and moderate placement ${item.placementId.slice(0, 8)}\u2026`}
      maxWidth="lg"
    >
      <div className="space-y-4">
        {/* Image preview */}
        <div className="flex justify-center">
          {item.imageReviewUrl !== null ? (
            <img
              src={item.imageReviewUrl}
              alt={item.altText}
              className="max-h-64 rounded-md border border-hairline object-contain"
              style={{ imageRendering: 'pixelated' }}
            />
          ) : (
            <div className="grid h-32 w-32 place-items-center rounded-md border border-dashed border-hairline-bright text-ink-subtle">
              No image uploaded
            </div>
          )}
        </div>

        {/* Details */}
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-subtle">Title</dt>
            <dd className="font-medium">{item.title}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Alt text</dt>
            <dd>{item.altText}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Destination</dt>
            <dd>
              <a
                href={item.destinationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan hover:underline"
              >
                {item.destinationUrl}
              </a>
            </dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Owner</dt>
            <dd>{item.ownerDisplayName ?? item.ownerEmail}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Position</dt>
            <dd>
              ({item.x}, {item.y}) \u2014 {item.w} &times; {item.h} units
            </dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Price</dt>
            <dd>{formatCents(item.quotedTotalCents)}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Created</dt>
            <dd>{formatDateTime(item.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Paid</dt>
            <dd>{item.paidAt !== null ? formatDateTime(item.paidAt) : 'Not yet'}</dd>
          </div>
        </dl>

        {/* Reason field for negative actions */}
        <TextArea
          label="Reason (required for reject/disable)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="This is recorded in the audit log and may be shown to the buyer."
          counter={{ current: reason.length, max: 500 }}
        />

        {/* Error display */}
        {moderate.isError && (
          <Alert tone="danger" title="Action failed">
            {moderate.error.message}
          </Alert>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2 pt-2">
          {isPending && (
            <>
              <Button
                variant="primary"
                loading={actionInProgress === 'approve'}
                onClick={() => void handleModerate('approve')}
              >
                Approve
              </Button>
              <Button
                variant="danger"
                loading={actionInProgress === 'reject'}
                onClick={() => void handleModerate('reject')}
              >
                Reject &amp; Refund
              </Button>
            </>
          )}

          {isActive && (
            <Button
              variant="danger"
              loading={actionInProgress === 'disable'}
              onClick={() => void handleModerate('disable')}
            >
              Disable
            </Button>
          )}

          {isDisabled && (
            <Button
              variant="primary"
              loading={actionInProgress === 'reenable'}
              onClick={() => void handleModerate('reenable')}
            >
              Re-enable
            </Button>
          )}

          <Button variant="ghost" onClick={onClose} disabled={actionInProgress !== null}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Bulk Disable Dialog
// -----------------------------------------------------------------------------

function BulkDisableDialog({
  open,
  onClose,
  announce,
}: {
  open: boolean;
  onClose: () => void;
  announce: (message: string) => void;
}): React.JSX.Element | null {
  const bulkDisable = useBulkDisableHost();
  const [host, setHost] = useState('');
  const [reason, setReason] = useState('');

  const handleSubmit = async (): Promise<void> => {
    if (host.trim().length < 3) {
      announce('Enter a valid hostname.');
      return;
    }
    if (reason.trim().length < 3) {
      announce('A reason is required.');
      return;
    }

    try {
      const result = await bulkDisable.mutateAsync({
        host: host.trim().toLowerCase(),
        reason: reason.trim(),
      });
      announce(
        `Disabled ${result.disabled} placement${result.disabled === 1 ? '' : 's'} linking to ${result.host}.`,
      );
      setHost('');
      setReason('');
      onClose();
    } catch {
      announce('Bulk disable failed. Check the error.');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Bulk Disable by Host"
      description="Disable all placements linking to a specific domain."
    >
      <div className="space-y-4">
        <Alert tone="warning" title="Use with caution">
          This will immediately remove all matching placements from the wall. Use only for confirmed
          malicious domains.
        </Alert>

        <TextField
          label="Hostname"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="example.com"
          hint="Enter the domain without protocol (e.g., example.com)"
          required
        />

        <TextArea
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Recorded in the audit log."
          required
          counter={{ current: reason.length, max: 500 }}
        />

        {bulkDisable.isError && (
          <Alert tone="danger" title="Failed">
            {bulkDisable.error.message}
          </Alert>
        )}

        <div className="flex gap-2 pt-2">
          <Button
            variant="danger"
            loading={bulkDisable.isPending}
            onClick={() => void handleSubmit()}
          >
            Disable All
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={bulkDisable.isPending}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Health Panel
// -----------------------------------------------------------------------------

function HealthPanel({ announce }: { announce: (message: string) => void }): React.JSX.Element {
  const session = useSession();
  const health = useAdminHealth(session.authenticated && session.user?.isAdmin === true);
  const rebuildManifest = useRebuildManifest();

  const handleRebuild = async (): Promise<void> => {
    try {
      const result = await rebuildManifest.mutateAsync();
      announce(
        `Manifest rebuilt. Version ${result.version}, ${result.placementCount} placements, ${result.durationMs}ms.`,
      );
    } catch {
      announce('Manifest rebuild failed.');
    }
  };

  if (health.isPending) {
    return (
      <p role="status" className="text-sm text-ink-subtle">
        Loading health status&hellip;
      </p>
    );
  }

  if (health.isError) {
    return (
      <Alert tone="danger" title="Could not load health status">
        {health.error.message}
      </Alert>
    );
  }

  const data = health.data;
  if (data === undefined) return <></>;

  return (
    <section aria-labelledby="health-heading">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="health-heading" className="text-xl font-semibold">
          System Health
        </h2>
        <Button
          variant="primary"
          loading={rebuildManifest.isPending}
          onClick={() => void handleRebuild()}
        >
          Rebuild Manifest
        </Button>
      </div>

      {rebuildManifest.isError && (
        <Alert tone="danger" title="Rebuild failed" className="mt-4">
          {rebuildManifest.error.message}
        </Alert>
      )}

      {/* Status indicators */}
      <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <HealthStat
          label="Database"
          value={data.dbConnected ? 'Connected' : 'Disconnected'}
          status={data.dbConnected ? 'ok' : 'error'}
        />
        <HealthStat label="Environment" value={data.environment} status="neutral" />
        <HealthStat
          label="Image Pipeline"
          value={data.imagePipelineConfigured ? 'Configured' : 'Not configured'}
          status={data.imagePipelineConfigured ? 'ok' : 'warning'}
        />
        <HealthStat
          label="Manual Approval"
          value={data.manualApprovalRequired ? 'Required' : 'Auto-approve'}
          status="neutral"
        />
      </dl>

      {/* Counts */}
      <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Pending placements" value={formatCount(data.pendingPlacements)} />
        <Stat label="Active reservations" value={formatCount(data.activeReservations)} />
        <Stat label="Analytics backlog" value={formatCount(data.analyticsBacklog)} />
        <Stat label="Admin allowlist size" value={formatCount(data.adminAllowlistSize)} />
      </dl>

      {/* Last job run */}
      {data.lastJobRun !== null && (
        <div className="mt-6">
          <h3 className="text-lg font-semibold">Last Job Run</h3>
          <div className="glass mt-2 p-4">
            <dl className="grid gap-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-ink-subtle">Job</dt>
                <dd className="font-mono">{data.lastJobRun.job}</dd>
              </div>
              <div>
                <dt className="text-ink-subtle">Status</dt>
                <dd>
                  <Badge tone={data.lastJobRun.status === 'success' ? 'verified' : 'pending'}>
                    {data.lastJobRun.status}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-ink-subtle">Duration</dt>
                <dd>{data.lastJobRun.durationMs}ms</dd>
              </div>
              <div>
                <dt className="text-ink-subtle">Run at</dt>
                <dd>{formatRelativeTime(data.lastJobRun.runAt)}</dd>
              </div>
            </dl>
          </div>
        </div>
      )}

      {/* Recent errors */}
      {data.recentErrors.length > 0 && (
        <div className="mt-6">
          <h3 className="text-lg font-semibold">Recent Errors</h3>
          <ul className="mt-2 space-y-2">
            {data.recentErrors.map((error, i) => (
              <li key={i} className="glass p-3">
                <p className="font-mono text-sm text-danger">{error.message}</p>
                <p className="mt-1 text-xs text-ink-subtle">
                  Count: {error.count} \u2014 Last seen {formatRelativeTime(error.lastSeen)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function HealthStat({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: 'ok' | 'warning' | 'error' | 'neutral';
}): React.JSX.Element {
  const colors = {
    ok: 'text-success',
    warning: 'text-warning',
    error: 'text-danger',
    neutral: 'text-ink',
  }[status];

  return (
    <div className="glass px-4 py-3">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className={`text-lg font-semibold ${colors}`}>{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="glass px-4 py-3">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="text-lg font-semibold tabular">{value}</dd>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Audit Panel
// -----------------------------------------------------------------------------

function AuditPanel(): React.JSX.Element {
  const session = useSession();
  const [limit] = useState(50);
  const audit = useAdminAudit(session.authenticated && session.user?.isAdmin === true, limit);

  if (audit.isPending) {
    return (
      <p role="status" className="text-sm text-ink-subtle">
        Loading audit log&hellip;
      </p>
    );
  }

  if (audit.isError) {
    return (
      <Alert tone="danger" title="Could not load audit log">
        {audit.error.message}
      </Alert>
    );
  }

  const data = audit.data;
  if (data === undefined) return <></>;

  return (
    <section aria-labelledby="audit-heading">
      <h2 id="audit-heading" className="text-xl font-semibold">
        Audit Log
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Every admin action is recorded and cannot be deleted or modified.
      </p>

      {data.items.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="No audit entries">The audit log is empty.</EmptyState>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                <th className="px-3 py-2 font-medium text-ink-subtle">Time</th>
                <th className="px-3 py-2 font-medium text-ink-subtle">Action</th>
                <th className="px-3 py-2 font-medium text-ink-subtle">Target</th>
                <th className="px-3 py-2 font-medium text-ink-subtle">Actor</th>
                <th className="px-3 py-2 font-medium text-ink-subtle">Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((entry) => (
                <tr key={entry.id} className="border-b border-hairline-bright">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-subtle">
                    {formatRelativeTime(entry.createdAt)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{entry.action}</td>
                  <td className="px-3 py-2 text-xs">
                    {entry.targetType}
                    {entry.targetId !== null && (
                      <span className="ml-1 text-ink-subtle">
                        ({entry.targetId.slice(0, 8)}\u2026)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{entry.actorLabel}</td>
                  <td
                    className="max-w-xs truncate px-3 py-2 text-xs"
                    title={JSON.stringify(entry.detail)}
                  >
                    {Object.keys(entry.detail).length > 0
                      ? JSON.stringify(entry.detail).slice(0, 50)
                      : '\u2014'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default AdminPage;
