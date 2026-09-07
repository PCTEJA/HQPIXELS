/**
 * The claim wizard: Choose -> Preview -> Pay.
 *
 * Design commitments visible in this file:
 *
 *   * The exact total in USD is shown at every step, from the server's quote,
 *     never estimated on the client.
 *   * The terms checkbox starts unchecked and is not pre-checked under any
 *     circumstance. The server additionally requires a literal `true`.
 *   * The hold countdown is real and reflects the server's `expiresAt`. When it
 *     runs low the UI says what will happen rather than pressuring the buyer.
 *   * No fake urgency: no artificial timers, no "3 people are viewing this",
 *     no discount that expires.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  CELL_LOGICAL_SIZE,
  MAX_ALT_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_UPLOAD_BYTES,
} from '@shared/constants';
import { computeQuote } from '@shared/pricing';
import { decodeOccupancy, isRectAvailable } from '@shared/occupancy';
import { normalizeDestinationUrl } from '@shared/url-safety';
import { ApiRequestError } from '../lib/api';
import {
  useAcceptTerms,
  useCompleteUpload,
  useCreateCheckout,
  useCreateReservation,
  usePricing,
  useQuote,
  useRequestUploadTicket,
  useReservation,
  useSetPlacementDetails,
  useWallManifest,
  uploadImageToProvider,
} from '../lib/queries';
import { useSession } from '../lib/session';
import { formatCents, formatCountdown, formatRectPixels } from '../lib/format';
import { useCountdown } from '../lib/hooks';
import { WallSurface } from '../components/wall/WallSurface';
import { Alert, Button, Checkbox, LiveRegion, TextField } from '../components/primitives';
import { Turnstile, resetTurnstile } from '../components/Turnstile';
import { SignInDialog } from '../components/SignInDialog';
import { RemoveHoldButton } from '../components/RemoveHoldButton';

type Step = 'choose' | 'preview' | 'pay';

/** Must match CURRENT_TERMS_VERSION in worker/routes/reservations.ts. */
const TERMS_VERSION = '2026-08-01';

export function ClaimPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const session = useSession();

  const existingReservationId = params.get('reservation');

  const [requestedStep, setStep] = useState<Step>('preview');
  // Navigation can remove the hold without remounting this page. Never show
  // a preview/pay heading when there is no reservation to render beneath it.
  const step = existingReservationId === null ? 'choose' : requestedStep;
  const [selection, setSelection] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  const [signInOpen, setSignInOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const manifest = useWallManifest();
  const pricing = usePricing();
  const serverQuote = useQuote(selection);
  const reservation = useReservation(existingReservationId);

  // Resume an in-progress claim.
  useEffect(() => {
    if (reservation.data === undefined) return;
    const state = reservation.data.reservation.state;
    if (state === 'reserved' || state === 'ready_for_checkout' || state === 'payment_failed') {
      setStep('preview');
      setSelection({
        x: reservation.data.reservation.x,
        y: reservation.data.reservation.y,
        w: reservation.data.reservation.w,
        h: reservation.data.reservation.h,
      });
    } else if (state === 'checkout_created') {
      setStep('pay');
    }
  }, [reservation.data]);

  /**
   * Local price preview.
   *
   * Instant feedback while dragging, using the same shared pricing engine the
   * server uses. It is a PREVIEW: the number the buyer commits to is always the
   * server's, and the reservation call rejects any disagreement.
   */
  const previewQuote = useMemo(() => {
    if (selection === null || pricing.data === undefined) return null;
    try {
      return computeQuote(
        {
          version: pricing.data.version,
          currency: 'USD',
          centsPerLogicalPixel: pricing.data.centsPerLogicalPixel,
          zoneMultipliers: pricing.data.zoneMultipliers,
          minCells: pricing.data.minCells,
          maxCells: pricing.data.maxCells,
          reservationTtlSeconds: pricing.data.reservationTtlSeconds,
        },
        selection,
      );
    } catch {
      return null;
    }
  }, [selection, pricing.data]);

  const activeQuote = serverQuote.data?.quote ?? previewQuote;

  return (
    <div>
      <h1 className="text-3xl font-semibold">Claim your plot</h1>
      <p className="mt-2 max-w-2xl text-ink-muted">
        Pick an area, add your artwork and link, then pay once. Minimum purchase is one{' '}
        {CELL_LOGICAL_SIZE} x {CELL_LOGICAL_SIZE} pixel unit.
      </p>

      <Stepper current={step} />

      <LiveRegion message={announcement} />

      {step === 'choose' && (
        <ChooseStep
          manifest={manifest.data ?? null}
          manifestError={manifest.isError ? manifest.error.message : null}
          selection={selection}
          onSelectionChange={setSelection}
          quote={activeQuote}
          serverAvailable={serverQuote.data?.available ?? null}
          quoteError={serverQuote.isError ? serverQuote.error.message : null}
          quoteLoading={serverQuote.isFetching}
          reservationTtlSeconds={pricing.data?.reservationTtlSeconds ?? 2700}
          authenticated={session.authenticated}
          emailVerified={session.user?.emailVerified ?? false}
          onRequestSignIn={() => setSignInOpen(true)}
          onReserved={(reservationId) => {
            // Use the same reservation-specific route as Dashboard's resume
            // link, so the new hold and its preview travel together.
            void navigate(`/claim/resume?reservation=${encodeURIComponent(reservationId)}`, {
              replace: true,
            });
            setStep('preview');
            setAnnouncement('Your units are held. Add your artwork and link next.');
          }}
          pricingVersion={pricing.data?.version ?? null}
        />
      )}

      {step === 'preview' && existingReservationId !== null && (
        <PreviewStep
          reservationId={existingReservationId}
          onReady={() => {
            setStep('pay');
            setAnnouncement('Your details are saved. Review and pay next.');
          }}
          onExpired={() => {
            setStep('choose');
            setSelection(null);
            setParams({}, { replace: true });
            setAnnouncement('Your hold expired and the units returned to the wall.');
          }}
        />
      )}

      {step === 'pay' && existingReservationId !== null && (
        <PayStep
          reservationId={existingReservationId}
          onBack={() => setStep('preview')}
          onExpired={() => {
            setStep('choose');
            setSelection(null);
            setParams({}, { replace: true });
          }}
        />
      )}

      {existingReservationId !== null && step !== 'choose' && (
        <section className="glass mt-6 p-5">
          <RemoveHoldButton
            key={existingReservationId}
            reservationId={existingReservationId}
            onRemoved={() => {
              setStep('choose');
              setSelection(null);
              setParams({}, { replace: true });
              setAnnouncement('Hold removed. Your plot is available to claim again.');
            }}
          />
        </section>
      )}

      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} redirectPath="/claim" />

      <p className="mt-10 text-xs text-ink-subtle">
        Prices are in US dollars. Payments are processed by Stripe; we never see your card details.
        Read the <Link to="/content-policy">content policy</Link>,{' '}
        <Link to="/refund-policy">refund policy</Link> and <Link to="/terms">terms</Link> before
        buying. Questions? <Link to="/contact">Contact us</Link>.
      </p>

      {/* Navigating away mid-claim is fine; the hold persists server-side. */}
      <p className="mt-2 text-xs text-ink-subtle">
        You can close this page and come back &mdash; your hold is kept until the countdown ends,
        and you will find it again on your <Link to="/dashboard">dashboard</Link>.
      </p>

      <button
        type="button"
        onClick={() => navigate('/wall')}
        className="sr-only"
        // A keyboard escape hatch out of the wizard that does not rely on the
        // header being reachable.
      >
        Leave the claim flow and browse the wall
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Stepper
// -----------------------------------------------------------------------------

function Stepper({ current }: { current: Step }): React.JSX.Element {
  const steps: ReadonlyArray<{ id: Step; label: string }> = [
    { id: 'choose', label: 'Choose' },
    { id: 'preview', label: 'Preview' },
    { id: 'pay', label: 'Pay' },
  ];
  const currentIndex = steps.findIndex((s) => s.id === current);

  return (
    <nav aria-label="Progress" className="my-8">
      <ol className="flex items-center gap-2">
        {steps.map((step, index) => {
          const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
          return (
            <li key={step.id} className="flex flex-1 items-center gap-2">
              <span
                aria-current={state === 'current' ? 'step' : undefined}
                className={[
                  'flex items-center gap-2 rounded-control px-3 py-2 text-sm font-medium',
                  state === 'current'
                    ? 'bg-cyan/12 text-cyan ring-1 ring-cyan/40'
                    : state === 'done'
                      ? 'text-success'
                      : 'text-ink-subtle',
                ].join(' ')}
              >
                <span
                  aria-hidden="true"
                  className="tabular flex h-5 w-5 items-center justify-center rounded-full border border-current text-[0.6875rem]"
                >
                  {state === 'done' ? '✓' : index + 1}
                </span>
                {step.label}
                {state === 'done' && <span className="sr-only">(completed)</span>}
              </span>
              {index < steps.length - 1 && (
                <span aria-hidden="true" className="h-px flex-1 bg-hairline" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// -----------------------------------------------------------------------------
// Step 1: Choose
// -----------------------------------------------------------------------------

interface ChooseStepProps {
  readonly manifest: import('@shared/api-types').WallManifest | null;
  readonly manifestError: string | null;
  readonly selection: { x: number; y: number; w: number; h: number } | null;
  readonly onSelectionChange: (rect: { x: number; y: number; w: number; h: number } | null) => void;
  readonly quote: import('@shared/pricing').Quote | null;
  readonly serverAvailable: boolean | null;
  readonly quoteError: string | null;
  readonly quoteLoading: boolean;
  readonly reservationTtlSeconds: number;
  readonly authenticated: boolean;
  readonly emailVerified: boolean;
  readonly onRequestSignIn: () => void;
  readonly onReserved: (reservationId: string) => void;
  readonly pricingVersion: number | null;
}

function ChooseStep(props: ChooseStepProps): React.JSX.Element {
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [priceChanged, setPriceChanged] = useState<number | null>(null);
  const createReservation = useCreateReservation();
  const occupancyBitmap = props.manifest?.occupancyBitmap;
  const occupancy = useMemo(
    () => (occupancyBitmap === undefined ? null : decodeOccupancy(occupancyBitmap)),
    [occupancyBitmap],
  );
  const selectionUnavailable =
    props.selection !== null &&
    (props.serverAvailable === false ||
      (occupancy !== null && !isRectAvailable(occupancy, props.selection)));

  const selectionFeedback = props.selection !== null && (
    <div id="selection-feedback" className="space-y-3">
      {selectionUnavailable && (
        <Alert tone="warning" title="Some selected units are unavailable">
          Your selection overlaps units that are already held or claimed. Move or resize your
          selection to choose available units.
        </Alert>
      )}
      {props.quoteError !== null ? (
        <Alert tone="danger" title="We could not check this selection">
          {props.quoteError} Move or resize your selection to try again.
        </Alert>
      ) : props.quoteLoading ? (
        <p className="text-xs text-ink-subtle" role="status">
          Checking availability…
        </p>
      ) : !selectionUnavailable && props.serverAvailable === true ? (
        <p className="text-xs text-success" role="status">
          All units in that rectangle are available.
        </p>
      ) : null}
    </div>
  );

  const canReserve =
    props.selection !== null &&
    props.quote !== null &&
    props.pricingVersion !== null &&
    props.serverAvailable === true &&
    !selectionUnavailable &&
    !props.quoteLoading &&
    props.quoteError === null &&
    props.authenticated &&
    props.emailVerified &&
    turnstileToken !== null &&
    !createReservation.isPending;

  const reserve = async (): Promise<void> => {
    if (
      props.selection === null ||
      props.quote === null ||
      props.pricingVersion === null ||
      turnstileToken === null
    ) {
      return;
    }

    setError(null);
    setPriceChanged(null);

    try {
      const result = await createReservation.mutateAsync({
        rect: props.selection,
        pricingVersion: props.pricingVersion,
        // The server recomputes this and refuses to proceed if it disagrees.
        expectedTotalCents: props.quote.totalCents,
        turnstileToken,
        acceptedTermsVersion: TERMS_VERSION,
      });
      props.onReserved(result.reservation.id);
    } catch (caught) {
      // A used Turnstile token cannot be replayed, so always get a fresh one.
      resetTurnstile();
      setTurnstileToken(null);

      if (caught instanceof ApiRequestError) {
        if (caught.code === 'quote_changed') {
          const body = caught.body as { quote?: { totalCents?: number } } | null;
          setPriceChanged(body?.quote?.totalCents ?? null);
          setError(caught.message);
          return;
        }
        setError(caught.message);
        return;
      }
      setError('We could not hold those units. Please try again.');
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div>
        {props.manifestError !== null ? (
          <Alert tone="danger" title="The wall could not load">
            {props.manifestError}
          </Alert>
        ) : props.manifest === null ? (
          <div
            className="grid-motif flex h-96 items-center justify-center rounded-card border border-hairline"
            role="status"
          >
            <p className="text-sm text-ink-subtle">Loading the wall…</p>
          </div>
        ) : (
          <WallSurface
            manifest={props.manifest}
            mode="select"
            selection={props.selection}
            onSelectionChange={props.onSelectionChange}
            heightClass="h-[min(64vh,620px)]"
          />
        )}
      </div>

      {/* --- summary panel ------------------------------------------------- */}
      <aside className="glass h-fit p-5 lg:sticky lg:top-24" aria-label="Selection summary">
        <h2 className="text-base font-semibold">Your selection</h2>

        {props.selection === null ? (
          <p className="mt-3 text-sm text-ink-muted">
            Drag a rectangle on the wall, or focus the wall and use the arrow keys with Shift held.
          </p>
        ) : (
          <>
            <dl className="mt-4 space-y-2.5 text-sm">
              <Row label="Position">
                <span className="tabular">
                  {props.selection.x * CELL_LOGICAL_SIZE}, {props.selection.y * CELL_LOGICAL_SIZE}
                </span>
              </Row>
              <Row label="Size">
                <span className="tabular">{formatRectPixels(props.selection)}</span>
              </Row>
              <Row label="Units">
                <span className="tabular">{props.selection.w * props.selection.h}</span>
              </Row>
              <Row label="Total pixels">
                <span className="tabular">
                  {(props.selection.w * props.selection.h * 100).toLocaleString('en-US')}
                </span>
              </Row>
            </dl>

            {props.quote !== null && (
              <div className="mt-4 border-t border-hairline pt-4">
                {props.quote.lines.length > 1 && (
                  <ul className="mb-3 space-y-1.5 text-xs text-ink-muted">
                    {props.quote.lines.map((line) => (
                      <li key={line.multiplierBp} className="flex justify-between gap-3">
                        <span>
                          {line.label} &times; {line.cells}
                        </span>
                        <span className="tabular">{formatCents(line.amountCents)}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-ink-muted">Total</span>
                  <span className="tabular text-2xl font-semibold text-cta">
                    {formatCents(props.quote.totalCents)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-subtle">
                  One-time payment in USD. Price version {props.quote.pricingVersion}.
                </p>
              </div>
            )}
          </>
        )}

        {/* --- gates --------------------------------------------------------- */}
        <div className="mt-5 space-y-3">
          {(!props.authenticated || !props.emailVerified) && selectionFeedback}
          {!props.authenticated ? (
            <>
              <Button variant="primary" className="w-full" onClick={props.onRequestSignIn}>
                Sign in to continue
              </Button>
              <p className="text-xs text-ink-subtle">
                We need an account so we can send your receipt and let you manage the placement
                later.
              </p>
            </>
          ) : !props.emailVerified ? (
            <Alert tone="warning" title="Confirm your email">
              Click the link we emailed you before buying space. Reload this page once you have.
            </Alert>
          ) : (
            <>
              {props.selection !== null && (
                <Turnstile action="reserve" onToken={setTurnstileToken} />
              )}

              {priceChanged !== null && (
                <Alert tone="warning" title="The price changed">
                  The current total for this selection is {formatCents(priceChanged)}. Nothing has
                  been charged. Re-check the total above and try again.
                </Alert>
              )}

              {error !== null && priceChanged === null && (
                <Alert tone="danger" title="We could not hold those units">
                  {error}
                </Alert>
              )}

              {selectionFeedback}

              <Button
                variant="cta"
                className="w-full"
                aria-describedby={props.selection !== null ? 'selection-feedback' : undefined}
                disabled={!canReserve}
                loading={createReservation.isPending}
                loadingLabel="Holding your units"
                onClick={() => void reserve()}
              >
                Hold these units
              </Button>

              <p className="text-xs text-ink-subtle">
                Holding does not charge you. Your units are reserved for{' '}
                {Math.round(props.reservationTtlSeconds / 60)} minutes while you add your artwork.
              </p>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Step 2: Preview
// -----------------------------------------------------------------------------

function PreviewStep({
  reservationId,
  onReady,
  onExpired,
}: {
  reservationId: string;
  onReady: () => void;
  onExpired: () => void;
}): React.JSX.Element {
  const reservation = useReservation(reservationId);
  const setDetails = useSetPlacementDetails(reservationId);
  const requestTicket = useRequestUploadTicket();
  const completeUpload = useCompleteUpload(reservationId);

  const [title, setTitle] = useState('');
  const [altText, setAltText] = useState('');
  const [destination, setDestination] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [renderNote, setRenderNote] = useState<string | null>(null);

  const expiresAt = reservation.data?.reservation.expiresAt ?? null;
  const { secondsRemaining, expired } = useCountdown(expiresAt);

  useEffect(() => {
    if (expired && expiresAt !== null) onExpired();
  }, [expired, expiresAt, onExpired]);

  // Seed the form from whatever is already saved, so a returning buyer does not
  // retype everything.
  useEffect(() => {
    if (reservation.data === undefined) return;
    const placement = reservation.data.placement;
    setTitle((current) => (current === '' ? placement.title : current));
    setAltText((current) => (current === '' ? placement.altText : current));
    setDestination((current) => (current === '' ? (placement.destinationUrl ?? '') : current));
  }, [reservation.data]);

  // Revoke the object URL when it changes or unmounts; leaking blob URLs holds
  // the whole file in memory.
  useEffect(() => {
    return () => {
      if (localPreview !== null) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const chosen = event.target.files?.[0] ?? null;
    setErrors((prev) => ({ ...prev, file: '' }));

    if (chosen === null) {
      setFile(null);
      return;
    }

    // Client-side checks for fast feedback only. The server re-checks magic
    // bytes, real dimensions and pixel count, and is the authority.
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(chosen.type)) {
      setErrors((prev) => ({ ...prev, file: 'Choose a JPEG, PNG or WebP image.' }));
      setFile(null);
      return;
    }
    if (chosen.size > MAX_UPLOAD_BYTES) {
      setErrors((prev) => ({
        ...prev,
        file: `That image is ${Math.round(chosen.size / 1024)} KB. The limit is ${Math.floor(
          MAX_UPLOAD_BYTES / 1024,
        )} KB.`,
      }));
      setFile(null);
      return;
    }

    setFile(chosen);
    if (localPreview !== null) URL.revokeObjectURL(localPreview);
    setLocalPreview(URL.createObjectURL(chosen));
  };

  const uploadArtwork = async (): Promise<void> => {
    if (file === null || turnstileToken === null) return;
    setFormError(null);
    setUploadProgress(0);

    try {
      const ticket = await requestTicket.mutateAsync({
        reservationId,
        contentType: file.type,
        byteSize: file.size,
        turnstileToken,
      });

      // Straight to the image provider: the bytes never pass through our API.
      await uploadImageToProvider(ticket.uploadUrl, file, setUploadProgress);

      const result = await completeUpload.mutateAsync({ imageAssetId: ticket.imageAssetId });
      setRenderNote(result.renderNote);
      setUploadProgress(1);
    } catch (caught) {
      setUploadProgress(null);
      resetTurnstile();
      setTurnstileToken(null);
      setFormError(
        caught instanceof ApiRequestError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : 'The upload failed. Please try again.',
      );
    }
  };

  const saveDetails = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);
    setErrors({});

    // Validate the URL with the same module the server uses, so the buyer sees
    // the real reason rather than a generic failure after a round trip.
    const urlCheck = normalizeDestinationUrl(destination);
    if (!urlCheck.ok) {
      setErrors({ destinationUrl: urlCheck.message });
      return;
    }

    try {
      const result = await setDetails.mutateAsync({
        title,
        altText,
        destinationUrl: destination,
      });
      if (result.ready) onReady();
      else setFormError('Add your artwork before continuing.');
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        setErrors(caught.fields ?? {});
        if (caught.fields === undefined) setFormError(caught.message);
      } else {
        setFormError('We could not save those details.');
      }
    }
  };

  if (reservation.isPending) {
    return (
      <p role="status" className="text-sm text-ink-subtle">
        Loading your hold…
      </p>
    );
  }

  if (reservation.isError) {
    return (
      <Alert tone="danger" title="We could not find that hold">
        {reservation.error.message} It may have expired.{' '}
        <Link to="/claim">Start a new selection</Link>.
      </Alert>
    );
  }

  const data = reservation.data;
  if (data === undefined) return <></>;

  const rect = {
    x: data.reservation.x,
    y: data.reservation.y,
    w: data.reservation.w,
    h: data.reservation.h,
  };
  const previewSrc = localPreview ?? data.placement.imageUrl;
  const hasArtwork = data.placement.imageUrl !== null || uploadProgress === 1;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-6">
        <HoldBanner secondsRemaining={secondsRemaining} expiresAt={expiresAt} />

        <form
          onSubmit={(event) => void saveDetails(event)}
          className="glass space-y-5 p-5"
          noValidate
        >
          <h2 className="text-base font-semibold">Your artwork and link</h2>

          {/* --- file ------------------------------------------------------- */}
          <div>
            <label htmlFor="artwork" className="field-label">
              Artwork{' '}
              <span className="text-danger" aria-hidden="true">
                *
              </span>
              <span className="sr-only">(required)</span>
            </label>
            <input
              id="artwork"
              type="file"
              accept={ALLOWED_IMAGE_MIME_TYPES.join(',')}
              onChange={onFileChange}
              className="field-input file:mr-3 file:rounded-md file:border-0 file:bg-surface-raised file:px-3 file:py-1.5 file:text-sm file:text-ink"
              aria-describedby="artwork-hint"
              aria-invalid={errors.file !== undefined && errors.file !== '' ? true : undefined}
            />
            <span id="artwork-hint" className="field-hint">
              JPEG, PNG or WebP. Up to {Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB. For a sharp
              result, export at exactly {rect.w * CELL_LOGICAL_SIZE} x {rect.h * CELL_LOGICAL_SIZE}{' '}
              pixels, or an exact multiple.
            </span>
            {errors.file !== undefined && errors.file !== '' && (
              <span role="alert" className="field-error">
                {errors.file}
              </span>
            )}
          </div>

          {file !== null && !hasArtwork && (
            <div className="space-y-3">
              <Turnstile action="upload" onToken={setTurnstileToken} />
              <Button
                variant="primary"
                onClick={() => void uploadArtwork()}
                disabled={turnstileToken === null}
                loading={requestTicket.isPending || completeUpload.isPending}
                loadingLabel="Uploading"
              >
                Upload artwork
              </Button>
              {uploadProgress !== null && uploadProgress < 1 && (
                <div>
                  <div
                    role="progressbar"
                    aria-valuenow={Math.round(uploadProgress * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Upload progress"
                    className="h-1.5 overflow-hidden rounded-full bg-surface-raised"
                  >
                    <div
                      className="h-full bg-cyan transition-[width]"
                      style={{ width: `${Math.round(uploadProgress * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-ink-subtle">
                    {Math.round(uploadProgress * 100)}% uploaded
                  </p>
                </div>
              )}
            </div>
          )}

          {hasArtwork && (
            <Alert tone="success" title="Artwork received">
              We checked the file type and dimensions. It stays private until a moderator approves
              your placement.
              {renderNote !== null && <> {renderNote}</>}
            </Alert>
          )}

          {/* --- text ------------------------------------------------------- */}
          <TextField
            label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={MAX_TITLE_LENGTH}
            required
            counter={{ current: title.length, max: MAX_TITLE_LENGTH }}
            error={errors.title}
            hint="Shown when someone hovers or focuses your plot."
          />

          <TextField
            label="Image description (alt text)"
            value={altText}
            onChange={(event) => setAltText(event.target.value)}
            maxLength={MAX_ALT_TEXT_LENGTH}
            required
            counter={{ current: altText.length, max: MAX_ALT_TEXT_LENGTH }}
            error={errors.altText}
            hint="Describe the image so people using a screen reader know what it shows. Required."
          />

          <TextField
            label="Destination link"
            type="url"
            inputMode="url"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="https://example.com/your-page"
            required
            error={errors.destinationUrl}
            hint="https:// preferred. We show visitors the hostname before they leave, and we re-check the link periodically."
          />

          {formError !== null && (
            <Alert tone="danger" title="Not saved">
              {formError}
            </Alert>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              loading={setDetails.isPending}
              loadingLabel="Saving"
              disabled={!hasArtwork}
            >
              Save and continue
            </Button>
            <Link to="/dashboard" className="btn btn-ghost no-underline">
              Finish later
            </Link>
          </div>
        </form>
      </div>

      {/* --- live preview -------------------------------------------------- */}
      <aside className="glass h-fit p-5 lg:sticky lg:top-24" aria-label="Placement preview">
        <h2 className="text-base font-semibold">How it will look</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          {formatRectPixels(rect)} at grid {rect.x * CELL_LOGICAL_SIZE},{rect.y * CELL_LOGICAL_SIZE}
        </p>

        <div
          className="mt-4 grid place-items-center rounded-card border border-hairline bg-surface-sunken p-4"
          // A checkerboard behind the artwork so transparency is visible rather
          // than reading as white.
          style={{
            backgroundImage:
              'linear-gradient(45deg, #0e151d 25%, transparent 25%), linear-gradient(-45deg, #0e151d 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #0e151d 75%), linear-gradient(-45deg, transparent 75%, #0e151d 75%)',
            backgroundSize: '12px 12px',
            backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px',
          }}
        >
          {previewSrc !== null ? (
            <img
              src={previewSrc}
              alt={altText === '' ? 'Your uploaded artwork' : altText}
              className="max-h-56 object-contain"
              style={{
                // Match the real aspect ratio of the plot.
                aspectRatio: `${rect.w} / ${rect.h}`,
                imageRendering: 'pixelated',
              }}
            />
          ) : (
            <p className="py-10 text-center text-xs text-ink-subtle">
              Upload artwork to see it here
            </p>
          )}
        </div>

        <dl className="mt-4 space-y-2 text-sm">
          <Row label="Title">
            <span className="truncate">{title === '' ? '—' : title}</span>
          </Row>
          <Row label="Links to">
            <span className="tabular truncate text-xs">
              {destination === '' ? '—' : safeHost(destination)}
            </span>
          </Row>
          <Row label="Total">
            <span className="tabular font-semibold text-cta">
              {formatCents(data.reservation.totalCents)}
            </span>
          </Row>
        </dl>
      </aside>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Step 3: Pay
// -----------------------------------------------------------------------------

function PayStep({
  reservationId,
  onBack,
  onExpired,
}: {
  reservationId: string;
  onBack: () => void;
  onExpired: () => void;
}): React.JSX.Element {
  const reservation = useReservation(reservationId);
  const acceptTerms = useAcceptTerms(reservationId);
  const createCheckout = useCreateCheckout();

  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPolicy, setAcceptedPolicy] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);

  const expiresAt = reservation.data?.reservation.expiresAt ?? null;
  const { secondsRemaining, expired } = useCountdown(expiresAt);
  const minRemaining = reservation.data?.checkoutMinRemainingSeconds ?? 1800;

  useEffect(() => {
    if (expired && expiresAt !== null) onExpired();
  }, [expired, expiresAt, onExpired]);

  const data = reservation.data;

  const tooCloseToExpiry = expiresAt !== null && secondsRemaining < minRemaining;

  const pay = async (): Promise<void> => {
    if (turnstileToken === null || !acceptedTerms || !acceptedPolicy) return;
    setError(null);

    try {
      // Recorded against THIS reservation, so a dispute can be answered with the
      // exact version accepted at the exact time.
      await acceptTerms.mutateAsync({ termsVersion: TERMS_VERSION });

      const session = await createCheckout.mutateAsync({ reservationId, turnstileToken });

      setRedirecting(true);
      // Full navigation to Stripe-hosted Checkout. Card details never touch us.
      window.location.assign(session.url);
    } catch (caught) {
      resetTurnstile();
      setTurnstileToken(null);
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'We could not start the payment. Nothing has been charged.',
      );
    }
  };

  if (reservation.isPending) {
    return (
      <p role="status" className="text-sm text-ink-subtle">
        Loading your hold…
      </p>
    );
  }

  if (data === undefined) {
    return (
      <Alert tone="danger" title="We could not find that hold">
        <Link to="/claim">Start a new selection</Link>.
      </Alert>
    );
  }

  const rect = {
    x: data.reservation.x,
    y: data.reservation.y,
    w: data.reservation.w,
    h: data.reservation.h,
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <HoldBanner secondsRemaining={secondsRemaining} expiresAt={expiresAt} />

      {/* A plain, non-canvas summary of exactly what is being bought. */}
      <div className="glass p-5">
        <h2 className="text-base font-semibold">Review your purchase</h2>

        <div className="mt-4 flex gap-4">
          {data.placement.imageUrl !== null && (
            <img
              src={data.placement.imageUrl}
              alt={data.placement.altText}
              className="h-20 w-20 shrink-0 rounded-md border border-hairline object-contain"
              style={{ imageRendering: 'pixelated' }}
            />
          )}
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{data.placement.title}</p>
            <p className="mt-0.5 truncate text-sm text-ink-muted">{data.placement.altText}</p>
            <p className="tabular mt-1 truncate text-xs text-cyan">
              {data.placement.destinationHost ?? '—'}
            </p>
          </div>
        </div>

        <dl className="mt-5 space-y-2.5 border-t border-hairline pt-4 text-sm">
          <Row label="Position">
            <span className="tabular">
              {rect.x * CELL_LOGICAL_SIZE}, {rect.y * CELL_LOGICAL_SIZE}
            </span>
          </Row>
          <Row label="Size">
            <span className="tabular">{formatRectPixels(rect)}</span>
          </Row>
          <Row label="Units">
            <span className="tabular">{data.reservation.cells}</span>
          </Row>
          <Row label="Price version">
            <span className="tabular">{data.reservation.pricingVersion}</span>
          </Row>
        </dl>

        <div className="mt-4 flex items-baseline justify-between border-t border-hairline pt-4">
          <span className="font-medium">Total due today</span>
          <span className="tabular text-3xl font-semibold text-cta">
            {formatCents(data.reservation.totalCents)}
          </span>
        </div>
        <p className="mt-1 text-xs text-ink-subtle">
          One-time payment in US dollars. No subscription, no renewal. Any sales tax that applies
          will be shown by Stripe before you confirm.
        </p>
      </div>

      {/* --- consent ------------------------------------------------------- */}
      <div className="glass space-y-4 p-5">
        <h2 className="text-base font-semibold">Before you pay</h2>

        {/*
          Both boxes start unchecked and there is no `defaultChecked` anywhere.
          The server requires a literal `true` for each, so a pre-checked box
          could not produce a valid request even if one were added.
        */}
        <Checkbox
          checked={acceptedPolicy}
          onChange={(event) => setAcceptedPolicy(event.target.checked)}
          label={
            <>
              My artwork and destination link follow the{' '}
              <Link to="/content-policy">content policy</Link>. I understand a person reviews every
              placement, and that a rejected placement is refunded in full.
            </>
          }
        />

        <Checkbox
          checked={acceptedTerms}
          onChange={(event) => setAcceptedTerms(event.target.checked)}
          label={
            <>
              I agree to the <Link to="/terms">terms of service</Link>,{' '}
              <Link to="/refund-policy">refund policy</Link> and{' '}
              <Link to="/privacy">privacy policy</Link> (version {TERMS_VERSION}).
            </>
          }
        />

        {tooCloseToExpiry ? (
          <Alert tone="warning" title="Your hold is nearly up">
            There is not enough time left on this hold to open a payment page. Let it lapse and
            select again &mdash; nothing has been charged, and the units go straight back on the
            wall.
          </Alert>
        ) : (
          <Turnstile action="checkout" onToken={setTurnstileToken} />
        )}

        {error !== null && (
          <Alert tone="danger" title="Payment could not start">
            {error}
          </Alert>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="cta"
            onClick={() => void pay()}
            disabled={
              !acceptedTerms || !acceptedPolicy || turnstileToken === null || tooCloseToExpiry
            }
            loading={createCheckout.isPending || acceptTerms.isPending || redirecting}
            loadingLabel={redirecting ? 'Opening Stripe' : 'Preparing payment'}
          >
            Pay {formatCents(data.reservation.totalCents)} with Stripe
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Back to artwork
          </Button>
        </div>

        <p className="text-xs text-ink-subtle">
          You will be taken to Stripe&rsquo;s secure payment page. HQPixels never sees or stores
          your card details. After paying you will come back here and we will show you the status.
        </p>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Shared bits
// -----------------------------------------------------------------------------

function HoldBanner({
  secondsRemaining,
  expiresAt,
}: {
  secondsRemaining: number;
  expiresAt: string | null;
}): React.JSX.Element | null {
  if (expiresAt === null) return null;

  const countdown = formatCountdown(expiresAt);
  const low = secondsRemaining < 300;

  return (
    <div
      className={[
        'flex flex-wrap items-center justify-between gap-3 rounded-card border px-4 py-3 text-sm',
        low ? 'border-warning/40 bg-warning/8' : 'border-hairline bg-surface',
      ].join(' ')}
      // polite, not assertive: a countdown that interrupts a screen reader every
      // second would make the form unusable.
      role="status"
      aria-live="polite"
    >
      <p className="text-ink-muted">
        {countdown === null ? (
          'Your hold has ended.'
        ) : (
          <>
            Your units are held for{' '}
            <span className="tabular font-semibold text-ink">{countdown}</span>
          </>
        )}
      </p>
      <p className="text-xs text-ink-subtle">
        {low
          ? 'When it ends the units return to the wall. Nothing has been charged.'
          : 'No charge until you confirm payment.'}
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}

/** Hostname for the preview, or a clear "not valid yet" rather than raw input. */
function safeHost(raw: string): string {
  const result = normalizeDestinationUrl(raw);
  return result.ok ? result.host : 'not a valid link yet';
}

export default ClaimPage;
