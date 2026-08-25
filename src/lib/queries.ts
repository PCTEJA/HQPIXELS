/**
 * Server state, via TanStack Query.
 *
 * The interesting part is the wall manifest. Rather than a WebSocket per visitor
 * (which at 100k concurrent viewers would be 100k open connections and a
 * completely different cost model), a VISIBLE tab polls a tiny version endpoint
 * once a minute and only refetches the full manifest when the version actually
 * changed. A hidden tab polls nothing.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  DashboardResponse,
  PublicRankings,
  PublicStats,
  WallManifest,
} from '@shared/api-types';
import { CLIENT_MANIFEST_POLL_MS } from '@shared/constants';
import type { Quote } from '@shared/pricing';
import type { ApiRequestError } from './api';
import { api } from './api';
import { useDocumentVisible } from './hooks';

export const queryKeys = {
  manifest: ['manifest'] as const,
  manifestVersion: ['manifest', 'version'] as const,
  stats: ['stats'] as const,
  rankings: ['rankings'] as const,
  pricing: ['pricing'] as const,
  quote: (x: number, y: number, w: number, h: number) => ['quote', x, y, w, h] as const,
  dashboard: ['dashboard'] as const,
  reservation: (id: string) => ['reservation', id] as const,
  checkoutStatus: (id: string) => ['checkout-status', id] as const,
  adminQueue: (status: string) => ['admin', 'queue', status] as const,
  adminHealth: ['admin', 'health'] as const,
  adminAudit: (limit: number, before?: string) =>
    ['admin', 'audit', limit, before ?? 'latest'] as const,
};

// -----------------------------------------------------------------------------
// Public reads
// -----------------------------------------------------------------------------

export interface PricingInfo {
  readonly version: number;
  readonly currency: 'USD';
  readonly centsPerLogicalPixel: number;
  readonly minimumPurchaseCents: number;
  readonly zoneMultipliers: ReadonlyArray<{
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
    multiplierBp: number;
  }>;
  readonly minCells: number;
  readonly maxCells: number;
  readonly reservationTtlSeconds: number;
  readonly grid: {
    readonly size: number;
    readonly cellLogicalSize: number;
    readonly totalCells: number;
  };
}

export function usePricing(): UseQueryResult<PricingInfo, ApiRequestError> {
  return useQuery({
    queryKey: queryKeys.pricing,
    queryFn: async () => (await api.get<PricingInfo>('/api/public/pricing')).data,
    // Prices change on a deliberate admin action, not continuously.
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
}

/**
 * The wall manifest.
 *
 * `staleTime: Infinity` is intentional: this query is never refetched on a timer.
 * Invalidation comes exclusively from `useManifestVersionWatcher` noticing that
 * the server's version number changed, which is what keeps the polling cost to a
 * few hundred bytes a minute per visible tab.
 */
export function useWallManifest(): UseQueryResult<WallManifest, ApiRequestError> {
  return useQuery({
    queryKey: queryKeys.manifest,
    queryFn: async () => (await api.get<WallManifest>('/api/public/wall-manifest')).data,
    staleTime: Infinity,
    gcTime: 60 * 60_000,
    // The wall is the product. Keep showing the last good copy rather than an
    // empty grid if a refetch fails.
    placeholderData: (previous) => previous,
    retry: 2,
  });
}

/**
 * Watches the manifest version and invalidates the manifest when it moves.
 *
 * Deliberately NOT a WebSocket or SSE stream for the MVP: a 30-60 second delay in
 * seeing someone else's new placement is imperceptible, and conditional polling
 * costs nothing at the edge. Revisit only if a measured product need appears.
 */
export function useManifestVersionWatcher(): void {
  const queryClient = useQueryClient();
  const visible = useDocumentVisible();

  useQuery({
    queryKey: queryKeys.manifestVersion,
    queryFn: async () => {
      const response = await api.get<{ manifestVersion: number }>('/api/public/manifest-version');
      const next = response.data.manifestVersion;

      const current = queryClient.getQueryData<WallManifest>(queryKeys.manifest);
      if (current !== undefined && current.manifestVersion !== next) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.manifest });
      }

      return next;
    },
    // The two halves of the "no WebSocket" decision: poll only while visible,
    // and never in the background.
    refetchInterval: visible ? CLIENT_MANIFEST_POLL_MS : false,
    refetchIntervalInBackground: false,
    enabled: visible,
    staleTime: 0,
    gcTime: 5 * 60_000,
  });
}

export function usePublicStats(): UseQueryResult<PublicStats, ApiRequestError> {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: async () => (await api.get<PublicStats>('/api/public/stats')).data,
    staleTime: 60_000,
  });
}

export function usePublicRankings(): UseQueryResult<PublicRankings, ApiRequestError> {
  return useQuery({
    queryKey: queryKeys.rankings,
    queryFn: async () => (await api.get<PublicRankings>('/api/public/rankings')).data,
    staleTime: 5 * 60_000,
  });
}

// -----------------------------------------------------------------------------
// Quote
// -----------------------------------------------------------------------------

export interface QuoteResult {
  readonly quote: Quote;
  readonly unavailableCells: ReadonlyArray<{ x: number; y: number }>;
  readonly available: boolean;
  readonly reservationTtlSeconds: number;
  readonly note: string;
}

/**
 * Server-authoritative quote for the current selection.
 *
 * The client also computes a preview locally (see `computeQuote` in
 * shared/pricing) for instant feedback while dragging; this call is what the
 * purchase screen shows, because it is the number the server will stand behind.
 */
export function useQuote(
  rect: { x: number; y: number; w: number; h: number } | null,
): UseQueryResult<QuoteResult, ApiRequestError> {
  return useQuery({
    queryKey: rect === null ? ['quote', 'none'] : queryKeys.quote(rect.x, rect.y, rect.w, rect.h),
    queryFn: async () => {
      if (rect === null) throw new Error('no selection');
      const params = new URLSearchParams({
        x: String(rect.x),
        y: String(rect.y),
        w: String(rect.w),
        h: String(rect.h),
      });
      return (await api.get<QuoteResult>(`/api/public/quote?${params.toString()}`)).data;
    },
    enabled: rect !== null,
    // Availability changes constantly; a cached "available" would be a lie.
    staleTime: 0,
    gcTime: 30_000,
    retry: 1,
  });
}

// -----------------------------------------------------------------------------
// Buyer dashboard
// -----------------------------------------------------------------------------

export interface DashboardData extends DashboardResponse {
  readonly metricsNote: string;
}

export function useDashboard(enabled: boolean): UseQueryResult<DashboardData, ApiRequestError> {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: async () => (await api.get<DashboardData>('/api/dashboard')).data,
    enabled,
    staleTime: 30_000,
    // Never retry an auth failure: it will not succeed and it delays the
    // sign-in prompt.
    retry: (attempt, error) => attempt < 2 && !error.isAuthError,
  });
}

// -----------------------------------------------------------------------------
// Claim flow
// -----------------------------------------------------------------------------

export interface ReservationDetail {
  readonly reservation: {
    readonly id: string;
    readonly state: string;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly cells: number;
    readonly logicalPixels: number;
    readonly totalCents: number;
    readonly currency: 'USD';
    readonly pricingVersion: number;
    readonly quoteBreakdown: unknown;
    readonly expiresAt: string;
    readonly createdAt: string;
    readonly checkoutAttempt: number;
    readonly acceptedTermsVersion: string | null;
  };
  readonly placement: {
    readonly id: string;
    readonly status: string;
    readonly title: string;
    readonly altText: string;
    readonly destinationUrl: string | null;
    readonly destinationHost: string | null;
    readonly imageUrl: string | null;
    readonly imageWidth: number | null;
    readonly imageHeight: number | null;
    readonly moderationState: string;
  };
  readonly checkoutMinRemainingSeconds: number;
  readonly termsVersion: string;
}

export function useReservation(
  reservationId: string | null,
): UseQueryResult<ReservationDetail, ApiRequestError> {
  return useQuery({
    queryKey:
      reservationId === null ? ['reservation', 'none'] : queryKeys.reservation(reservationId),
    queryFn: async () =>
      (await api.get<ReservationDetail>(`/api/reservations/${reservationId ?? ''}`)).data,
    enabled: reservationId !== null,
    staleTime: 10_000,
    retry: (attempt, error) => attempt < 1 && !error.isAuthError,
  });
}

export interface CheckoutStatus {
  readonly reservationId: string;
  readonly reservationState: string;
  readonly paymentStatus: string;
  readonly placementStatus: string;
  readonly amountCents: number;
  readonly currency: 'USD';
  readonly fulfilled: boolean;
  readonly shareUrl: string | null;
  readonly moderationNote: string | null;
  readonly nextStep: string | null;
}

/**
 * Polls the checkout status after returning from Stripe.
 *
 * Read-only: this endpoint cannot fulfil a payment, and neither can this hook.
 * Fulfilment happens only via a signature-verified webhook. Polling stops as soon
 * as the state is terminal so a forgotten tab does not poll forever.
 */
export function useCheckoutStatus(
  reservationId: string | null,
  options: { pollWhilePending: boolean },
): UseQueryResult<CheckoutStatus, ApiRequestError> {
  const visible = useDocumentVisible();

  return useQuery({
    queryKey:
      reservationId === null
        ? ['checkout-status', 'none']
        : queryKeys.checkoutStatus(reservationId),
    queryFn: async () =>
      (await api.get<CheckoutStatus>(`/api/checkout/status/${reservationId ?? ''}`)).data,
    enabled: reservationId !== null,
    refetchInterval: (query) => {
      if (!options.pollWhilePending || !visible) return false;
      const data = query.state.data;
      if (data === undefined) return 3000;
      // Terminal states: stop.
      const terminal = [
        'active',
        'paid_pending_review',
        'rejected_refunded',
        'expired',
        'payment_failed',
      ];
      return terminal.includes(data.reservationState) ? false : 3000;
    },
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

// -----------------------------------------------------------------------------
// Mutations
// -----------------------------------------------------------------------------

export interface CreateReservationVariables {
  readonly rect: { x: number; y: number; w: number; h: number };
  readonly pricingVersion: number;
  readonly expectedTotalCents: number;
  readonly turnstileToken: string;
  readonly acceptedTermsVersion: string;
}

export interface CreateReservationResult {
  readonly reservation: ReservationDetail['reservation'];
  readonly quote: Quote;
  readonly placement: { readonly id: string };
  readonly upload: { readonly maxBytes: number; readonly allowedTypes: readonly string[] };
}

export function useCreateReservation(): UseMutationResult<
  CreateReservationResult,
  ApiRequestError,
  CreateReservationVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables) =>
      (await api.post<CreateReservationResult>('/api/reservations', variables)).data,
    onSuccess: () => {
      // A successful claim changes availability for everyone.
      void queryClient.invalidateQueries({ queryKey: queryKeys.manifest });
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
    // Never auto-retry: a retry could produce a second reservation.
    retry: false,
  });
}

export function useSetPlacementDetails(reservationId: string): UseMutationResult<
  {
    ready: boolean;
    state: string;
    placementId: string;
    destinationHost: string;
    manualReviewReasons: string[];
  },
  ApiRequestError,
  { title: string; altText: string; destinationUrl: string }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables) =>
      (
        await api.patch<{
          ready: boolean;
          state: string;
          placementId: string;
          destinationHost: string;
          manualReviewReasons: string[];
        }>(`/api/reservations/${reservationId}/details`, variables)
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reservation(reservationId) });
    },
    retry: false,
  });
}

export function useAcceptTerms(
  reservationId: string,
): UseMutationResult<
  { accepted: boolean; termsVersion: string },
  ApiRequestError,
  { termsVersion: string }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables) =>
      (
        await api.post<{ accepted: boolean; termsVersion: string }>(
          `/api/reservations/${reservationId}/accept-terms`,
          {
            acceptedContentPolicy: true,
            acceptedTerms: true,
            termsVersion: variables.termsVersion,
          },
        )
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reservation(reservationId) });
    },
    retry: false,
  });
}

export interface UploadTicket {
  readonly uploadUrl: string;
  readonly imageAssetId: string;
  readonly expiresAt: string;
  readonly maxBytes: number;
  readonly allowedTypes: readonly string[];
}

export function useRequestUploadTicket(): UseMutationResult<
  UploadTicket,
  ApiRequestError,
  { reservationId: string; contentType: string; byteSize: number; turnstileToken: string }
> {
  return useMutation({
    mutationFn: async (variables) =>
      (await api.post<UploadTicket>('/api/uploads/ticket', variables)).data,
    retry: false,
  });
}

export function useCompleteUpload(reservationId: string): UseMutationResult<
  {
    ready: boolean;
    state: string;
    image: { width: number; height: number; mime: string; bytes: number; previewPath: string };
    renderNote: string | null;
  },
  ApiRequestError,
  { imageAssetId: string }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables) =>
      (
        await api.post<{
          ready: boolean;
          state: string;
          image: {
            width: number;
            height: number;
            mime: string;
            bytes: number;
            previewPath: string;
          };
          renderNote: string | null;
        }>('/api/uploads/complete', { reservationId, imageAssetId: variables.imageAssetId })
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reservation(reservationId) });
    },
    retry: false,
  });
}

export function useCreateCheckout(): UseMutationResult<
  { url: string; sessionId: string; expiresAt: string; reused: boolean },
  ApiRequestError,
  { reservationId: string; turnstileToken: string }
> {
  return useMutation({
    mutationFn: async (variables) =>
      (
        await api.post<{ url: string; sessionId: string; expiresAt: string; reused: boolean }>(
          '/api/checkout/session',
          variables,
        )
      ).data,
    // Absolutely never retried. A retry is how duplicate charges happen, and the
    // server's idempotency key is the safety net, not a reason to be careless.
    retry: false,
  });
}

/** Direct upload to the image provider. Bypasses our API entirely, by design. */
export async function uploadImageToProvider(
  uploadUrl: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  // XMLHttpRequest rather than fetch, purely because fetch still has no upload
  // progress events and a 2 MB upload on a slow connection needs a progress bar.
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl, true);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed with status ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed. Check your connection.')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
    xhr.addEventListener('timeout', () => reject(new Error('Upload timed out.')));

    xhr.timeout = 120_000;
    xhr.send(form);
  });
}

// -----------------------------------------------------------------------------
// Admin queries
// -----------------------------------------------------------------------------

export type ModerationStatus = 'pending_review' | 'active' | 'rejected' | 'disabled' | 'all';

export interface AdminQueueItem {
  readonly placementId: string;
  readonly reservationId: string;
  readonly title: string;
  readonly altText: string;
  readonly destinationUrl: string;
  readonly destinationHost: string;
  readonly ownerEmail: string;
  readonly ownerDisplayName: string | null;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly logicalPixels: number;
  readonly quotedTotalCents: number;
  readonly placementStatus: string;
  readonly moderationState: string;
  readonly imageReviewUrl: string | null;
  readonly createdAt: string;
  readonly paidAt: string | null;
}

export interface AdminQueueResponse {
  readonly items: readonly AdminQueueItem[];
  readonly nextCursor: string | null;
  readonly status: ModerationStatus;
}

export function useAdminQueue(
  status: ModerationStatus,
  enabled: boolean,
): UseQueryResult<AdminQueueResponse, ApiRequestError> {
  return useQuery({
    queryKey: queryKeys.adminQueue(status),
    queryFn: async () =>
      (await api.get<AdminQueueResponse>(`/api/admin/queue?status=${status}`)).data,
    enabled,
    staleTime: 30_000,
    retry: (attempt, error) => attempt < 1 && !error.isAuthError,
  });
}

export interface AdminHealthResponse {
  readonly dbConnected: boolean;
  readonly lastJobRun: {
    readonly job: string;
    readonly runAt: string;
    readonly status: string;
    readonly durationMs: number;
  } | null;
  readonly pendingPlacements: number;
  readonly activeReservations: number;
  readonly recentErrors: readonly {
    readonly message: string;
    readonly count: number;
    readonly lastSeen: string;
  }[];
  readonly analyticsBacklog: number;
  readonly environment: string;
  readonly imagePipelineConfigured: boolean;
  readonly manualApprovalRequired: boolean;
  readonly adminAllowlistSize: number;
}

export function useAdminHealth(
  enabled: boolean,
): UseQueryResult<AdminHealthResponse, ApiRequestError> {
  return useQuery({
    queryKey: queryKeys.adminHealth,
    queryFn: async () => (await api.get<AdminHealthResponse>('/api/admin/health')).data,
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: (attempt, error) => attempt < 1 && !error.isAuthError,
  });
}

export interface AdminAuditEntry {
  readonly id: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly actorId: string | null;
  readonly actorLabel: string;
  readonly detail: Record<string, unknown>;
  readonly createdAt: string;
  readonly requestId: string | null;
}

export interface AdminAuditResponse {
  readonly items: readonly AdminAuditEntry[];
}

export function useAdminAudit(
  enabled: boolean,
  limit = 50,
  before?: string,
): UseQueryResult<AdminAuditResponse, ApiRequestError> {
  return useQuery({
    queryKey: ['admin', 'audit', limit, before ?? 'latest'],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (before) params.set('before', before);
      return (await api.get<AdminAuditResponse>(`/api/admin/audit?${params.toString()}`)).data;
    },
    enabled,
    staleTime: 30_000,
    retry: (attempt, error) => attempt < 1 && !error.isAuthError,
  });
}

// -----------------------------------------------------------------------------
// Admin mutations
// -----------------------------------------------------------------------------

export type ModerationDecision = 'approve' | 'reject' | 'disable' | 'reenable';

export interface ModerationResult {
  readonly decision: ModerationDecision;
  readonly placementId: string;
  readonly manifestVersion?: number;
  readonly takenDown?: boolean;
  readonly refund?: {
    readonly attempted: boolean;
    readonly succeeded: boolean;
    readonly amountCents: number | null;
    readonly needsManualAction: boolean;
  };
}

export function useModerate(): UseMutationResult<
  ModerationResult,
  ApiRequestError,
  { placementId: string; decision: ModerationDecision; reason?: string; refund?: boolean }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables) =>
      (await api.post<ModerationResult>('/api/admin/moderate', variables)).data,
    onSuccess: () => {
      // Invalidate queue and manifest after moderation
      void queryClient.invalidateQueries({ queryKey: ['admin', 'queue'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.manifest });
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminHealth });
    },
    retry: false,
  });
}

export interface BulkDisableResult {
  readonly host: string;
  readonly disabled: number;
}

export function useBulkDisableHost(): UseMutationResult<
  BulkDisableResult,
  ApiRequestError,
  { host: string; reason: string }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables) =>
      (await api.post<BulkDisableResult>('/api/admin/disable-host', variables)).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'queue'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.manifest });
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminHealth });
    },
    retry: false,
  });
}

export interface ManifestRebuildResult {
  readonly version: number;
  readonly placementCount: number;
  readonly durationMs: number;
}

export function useRebuildManifest(): UseMutationResult<
  ManifestRebuildResult,
  ApiRequestError,
  void
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () =>
      (await api.post<ManifestRebuildResult>('/api/admin/manifest/rebuild', {})).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.manifest });
    },
    retry: false,
  });
}
