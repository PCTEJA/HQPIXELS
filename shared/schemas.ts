/**
 * Zod schemas shared by the client and the Worker.
 *
 * The client uses them for immediate feedback. The Worker re-validates every
 * single one on arrival — the client copy is a convenience, never a control.
 * Anything security-relevant (price, ownership, state) is additionally
 * recomputed server-side from database rows rather than trusted from the body.
 */

import { z } from 'zod';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  GRID_SIZE,
  MAX_ABUSE_REPORT_LENGTH,
  MAX_ADMIN_NOTE_LENGTH,
  MAX_ALT_TEXT_LENGTH,
  MAX_DESTINATION_URL_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_SELECTION_CELLS,
  MAX_TITLE_LENGTH,
  MAX_UPLOAD_BYTES,
  MIN_SELECTION_CELLS,
} from './constants';
import { normalizeDestinationUrl } from './url-safety';
import {
  codepointLength,
  hasMeaningfulContent,
  normalizeHandle,
  normalizeSingleLine,
  RESERVED_HANDLES,
} from './text';

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------

export const uuidSchema = z.string().uuid();

/** A cell coordinate: integer 0..99. */
export const cellCoordSchema = z
  .number()
  .int()
  .min(0)
  .max(GRID_SIZE - 1);

/** A cell span: integer 1..100. */
export const cellSpanSchema = z.number().int().min(1).max(GRID_SIZE);

/**
 * A rectangle of cells. Contiguity is implied by the shape: a rectangle is
 * always contiguous, which is why the API takes x/y/w/h rather than a list of
 * cells. Bounds and area are enforced here and again in SQL.
 */
export const rectSchema = z
  .object({
    x: cellCoordSchema,
    y: cellCoordSchema,
    w: cellSpanSchema,
    h: cellSpanSchema,
  })
  .strict()
  .superRefine((rect, ctx) => {
    if (rect.x + rect.w > GRID_SIZE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['w'],
        message: 'Selection extends past the right edge of the wall.',
      });
    }
    if (rect.y + rect.h > GRID_SIZE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['h'],
        message: 'Selection extends past the bottom edge of the wall.',
      });
    }
    const cells = rect.w * rect.h;
    if (cells < MIN_SELECTION_CELLS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Select at least one unit.' });
    }
    if (cells > MAX_SELECTION_CELLS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A single claim can cover at most ${MAX_SELECTION_CELLS} units.`,
      });
    }
  });

export type RectInput = z.infer<typeof rectSchema>;

/** Turnstile response token. Cloudflare's tokens are opaque and bounded. */
export const turnstileTokenSchema = z
  .string()
  .min(10, 'Verification token missing.')
  .max(2048, 'Verification token malformed.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(5)
  .max(254)
  .email('Enter a valid email address.')
  // Defence in depth against header/log injection via an email field.
  .refine((v) => !/[\s<>"'`;]/.test(v), 'Enter a valid email address.');

/** Single-line buyer text, normalised then length-checked. */
function singleLineText(maxLength: number, fieldLabel: string) {
  return z
    .string()
    .max(maxLength * 4, `${fieldLabel} is too long.`) // cheap pre-filter before normalising
    .transform((v) => normalizeSingleLine(v, maxLength))
    .refine(
      (v) => codepointLength(v) <= maxLength,
      `${fieldLabel} must be ${maxLength} characters or fewer.`,
    );
}

export const titleSchema = singleLineText(MAX_TITLE_LENGTH, 'Title').refine(
  hasMeaningfulContent,
  'Enter a title with at least one letter or number.',
);

export const altTextSchema = singleLineText(MAX_ALT_TEXT_LENGTH, 'Alt text').refine(
  hasMeaningfulContent,
  'Describe the image so screen reader users know what it shows.',
);

export const displayNameSchema = singleLineText(MAX_DISPLAY_NAME_LENGTH, 'Display name').refine(
  hasMeaningfulContent,
  'Enter a display name with at least one letter or number.',
);

export const handleSchema = z
  .string()
  .max(40)
  .transform((v) => normalizeHandle(v))
  .refine(
    (v): v is string => v !== null,
    'Use 3-30 characters: lowercase letters, numbers, - or _.',
  )
  .refine((v) => !RESERVED_HANDLES.has(v), 'That handle is reserved.');

/**
 * Destination URL. The transform stores the *canonical* form, so downstream code
 * never sees the raw buyer string.
 */
export const destinationUrlSchema = z
  .string()
  .max(MAX_DESTINATION_URL_LENGTH * 2)
  .transform((raw, ctx) => {
    const result = normalizeDestinationUrl(raw);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message });
      return z.NEVER;
    }
    return result;
  });

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------

export const magicLinkRequestSchema = z
  .object({
    email: emailSchema,
    turnstileToken: turnstileTokenSchema,
    /** Where to land after sign-in. Validated against an allowlist of app paths. */
    redirectPath: z
      .string()
      .max(200)
      .optional()
      .refine(
        (v) => v === undefined || /^\/(?:[A-Za-z0-9\-._~/]*)$/.test(v),
        'Invalid redirect target.',
      ),
  })
  .strict();

export const oauthStartSchema = z
  .object({
    provider: z.enum(['google', 'github']),
    redirectPath: z
      .string()
      .max(200)
      .optional()
      .refine(
        (v) => v === undefined || /^\/(?:[A-Za-z0-9\-._~/]*)$/.test(v),
        'Invalid redirect target.',
      ),
  })
  .strict();

export const profileUpdateSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    handle: handleSchema.optional(),
  })
  .strict()
  .refine((v) => v.displayName !== undefined || v.handle !== undefined, 'Nothing to update.');

// -----------------------------------------------------------------------------
// Reservations
// -----------------------------------------------------------------------------

/**
 * Reservation request.
 *
 * `expectedTotalCents` and `pricingVersion` are NOT how the price is decided.
 * They are an agreement check: the server computes the real total from the
 * pricing row and the rectangle, and returns 409 `quote_changed` if the client
 * disagrees. That gives the buyer an honest "the price changed, here is the new
 * one" instead of a silent charge difference.
 */
export const createReservationSchema = z
  .object({
    rect: rectSchema,
    pricingVersion: z.number().int().positive(),
    expectedTotalCents: z.number().int().positive().max(100_000_000),
    turnstileToken: turnstileTokenSchema,
    acceptedTermsVersion: z.string().min(1).max(32),
  })
  .strict();

export const quoteQuerySchema = z
  .object({
    x: z.coerce.number().pipe(cellCoordSchema),
    y: z.coerce.number().pipe(cellCoordSchema),
    w: z.coerce.number().pipe(cellSpanSchema),
    h: z.coerce.number().pipe(cellSpanSchema),
  })
  .strict();

export const reservationIdParamSchema = z.object({ reservationId: uuidSchema }).strict();

// -----------------------------------------------------------------------------
// Uploads
// -----------------------------------------------------------------------------

export const uploadUrlRequestSchema = z
  .object({
    reservationId: uuidSchema,
    /** Declared type. Verified again against magic bytes after upload. */
    contentType: z.enum(ALLOWED_IMAGE_MIME_TYPES),
    /** Declared size. Enforced again by the image provider and by magic-byte checks. */
    byteSize: z.number().int().positive().max(MAX_UPLOAD_BYTES, 'Images must be 2 MB or smaller.'),
    turnstileToken: turnstileTokenSchema,
  })
  .strict();

export const uploadCompleteSchema = z
  .object({
    reservationId: uuidSchema,
    /** Provider-generated id. We never accept a caller-chosen object key. */
    imageAssetId: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/, 'Malformed asset id.'),
  })
  .strict();

// -----------------------------------------------------------------------------
// Placement details
// -----------------------------------------------------------------------------

export const placementDetailsSchema = z
  .object({
    reservationId: uuidSchema,
    title: titleSchema,
    altText: altTextSchema,
    destinationUrl: destinationUrlSchema,
  })
  .strict();

/**
 * What an owner may change after going live. Coordinates, size, price and owner
 * are absent by design — those are immutable for the life of the placement.
 * Changing the artwork or link re-enters moderation.
 */
export const placementEditSchema = z
  .object({
    title: titleSchema.optional(),
    altText: altTextSchema.optional(),
    destinationUrl: destinationUrlSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.title !== undefined || v.altText !== undefined || v.destinationUrl !== undefined,
    'Nothing to update.',
  );

export const acceptTermsSchema = z
  .object({
    reservationId: uuidSchema,
    /** Must be literally true. A missing or falsy value is a validation error,
     *  which is what makes a pre-checked box impossible to fake server-side. */
    acceptedContentPolicy: z.literal(true),
    acceptedTerms: z.literal(true),
    termsVersion: z.string().min(1).max(32),
  })
  .strict();

// -----------------------------------------------------------------------------
// Checkout
// -----------------------------------------------------------------------------

/**
 * Note what is NOT here: amount, currency, price, quantity, line items,
 * success URL. All of those are derived server-side. The client can only say
 * "start checkout for this reservation".
 */
export const createCheckoutSchema = z
  .object({
    reservationId: uuidSchema,
    turnstileToken: turnstileTokenSchema,
  })
  .strict();

// -----------------------------------------------------------------------------
// Admin
// -----------------------------------------------------------------------------

export const adminNoteSchema = z
  .string()
  .max(MAX_ADMIN_NOTE_LENGTH)
  .transform((v) => normalizeSingleLine(v, MAX_ADMIN_NOTE_LENGTH));

export const moderationDecisionSchema = z
  .object({
    placementId: uuidSchema,
    decision: z.enum(['approve', 'reject', 'disable', 'reenable']),
    /** Required for anything negative so the audit trail always has a reason. */
    reason: adminNoteSchema.optional(),
    /** Only meaningful for `reject`: issue a full refund via Stripe. */
    refund: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.decision === 'reject' || v.decision === 'disable') && !v.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A reason is required and is recorded in the audit log.',
      });
    }
  });

export const adminListQuerySchema = z
  .object({
    status: z
      .enum(['pending_review', 'active', 'rejected', 'disabled', 'all'])
      .default('pending_review'),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const pricingVersionCreateSchema = z
  .object({
    centsPerLogicalPixel: z.number().int().min(1).max(100_000),
    zoneMultipliers: z
      .array(
        z
          .object({
            label: singleLineText(40, 'Zone label'),
            x: cellCoordSchema,
            y: cellCoordSchema,
            w: cellSpanSchema,
            h: cellSpanSchema,
            multiplierBp: z.number().int().min(1).max(1_000_000),
          })
          .strict(),
      )
      .max(20),
    notes: adminNoteSchema.optional(),
    activate: z.boolean().default(false),
  })
  .strict();

// -----------------------------------------------------------------------------
// Public / abuse
// -----------------------------------------------------------------------------

export const abuseReportSchema = z
  .object({
    placementId: uuidSchema,
    category: z.enum(['malware', 'phishing', 'adult', 'illegal', 'misleading', 'broken', 'other']),
    details: z
      .string()
      .max(MAX_ABUSE_REPORT_LENGTH)
      .transform((v) => normalizeSingleLine(v, MAX_ABUSE_REPORT_LENGTH)),
    turnstileToken: turnstileTokenSchema,
  })
  .strict();

export const placementIdParamSchema = z.object({ placementId: uuidSchema }).strict();

export const rankingsQuerySchema = z
  .object({
    board: z
      .enum(['largest_owners', 'top_supporters', 'most_visited', 'rising'])
      .default('largest_owners'),
  })
  .strict();

// -----------------------------------------------------------------------------
// Inferred types
// -----------------------------------------------------------------------------

export type CreateReservationInput = z.infer<typeof createReservationSchema>;
export type UploadUrlRequestInput = z.infer<typeof uploadUrlRequestSchema>;
export type PlacementDetailsInput = z.infer<typeof placementDetailsSchema>;
export type PlacementEditInput = z.infer<typeof placementEditSchema>;
export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;
export type ModerationDecisionInput = z.infer<typeof moderationDecisionSchema>;
export type AbuseReportInput = z.infer<typeof abuseReportSchema>;
export type MagicLinkRequestInput = z.infer<typeof magicLinkRequestSchema>;
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;
export type PricingVersionCreateInput = z.infer<typeof pricingVersionCreateSchema>;
