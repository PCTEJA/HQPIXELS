import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError } from '../lib/api';
import { queryKeys } from '../lib/queries';
import { Alert, Button } from './primitives';

export function RemoveHoldButton({
  reservationId,
  onRemoved,
}: {
  reservationId: string;
  onRemoved?: () => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await api.post(`/api/reservations/${reservationId}/cancel`);
      setRemoved(true);
      await Promise.all(
        [
          queryKeys.dashboard,
          queryKeys.reservation(reservationId),
          queryKeys.manifest,
          queryKeys.stats,
        ].map((queryKey) => client.invalidateQueries({ queryKey })),
      );
      onRemoved?.();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not remove the hold. Please try again.',
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-3">
      {removed ? (
        <Alert tone="success" title="Hold removed">
          This plot is available to claim again.
        </Alert>
      ) : (
        <>
          <p className="text-sm text-ink-muted">
            Release this unpaid plot so it can be claimed again.
          </p>
          <Button
            variant="ghost"
            loading={pending}
            loadingLabel="Removing hold"
            onClick={() => void remove()}
          >
            Remove hold
          </Button>
        </>
      )}
      {error !== null && (
        <Alert tone="danger" title="Hold not removed">
          {error}
        </Alert>
      )}
    </div>
  );
}
