/**
 * Media pipeline: Cloudflare Images Direct Creator Upload.
 *
 * Threat being addressed: an uploaded file is attacker-controlled bytes that we
 * will later serve to every visitor. The mitigations, in order of how much they
 * matter:
 *
 *   1. The browser never gets a general-purpose upload endpoint. It gets a
 *      one-time, short-lived, single-file URL that Cloudflare issued for this
 *      specific user and reservation — and only after auth, ownership, Turnstile
 *      and rate limiting have all passed.
 *   2. Uploads land as UNPUBLISHED (`requireSignedURLs: true`). Nothing is
 *      publicly reachable until validation and moderation complete.
 *   3. Content type is decided by MAGIC BYTES, not by the declared MIME type or
 *      the filename. A `.png` containing HTML is rejected.
 *   4. Cloudflare re-encodes every variant, which strips EXIF/XMP (GPS, camera
 *      serial, embedded thumbnails) and destroys polyglot payloads: whatever
 *      script or archive was hidden after the image data does not survive a
 *      decode-and-re-encode.
 *   5. Object keys are provider-generated ids. A buyer-supplied filename is
 *      never used as a key, so no path traversal and no filename-based
 *      content-sniffing tricks.
 *
 * SVG is not accepted at all. An SVG is an XML document that can carry script
 * and external references; there is no safe way to serve user-supplied SVG from
 * our own origin, and "sanitise it" is a losing arms race.
 */

import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXEL_COUNT,
  MAX_UPLOAD_BYTES,
  MIN_IMAGE_DIMENSION,
  type AllowedImageMime,
} from '@shared/constants';
import type { AppConfig } from '../env';

// -----------------------------------------------------------------------------
// Magic-byte sniffing
// -----------------------------------------------------------------------------

export type SniffResult =
  | {
      readonly ok: true;
      readonly mime: AllowedImageMime;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'too_small'
        | 'unknown_format'
        | 'format_not_allowed'
        | 'dimensions_unreadable'
        | 'dimensions_out_of_range'
        | 'pixel_budget_exceeded';
      readonly detected?: string;
    };

function bytesAt(buffer: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset + expected.length > buffer.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (buffer[offset + i] !== expected[i]) return false;
  }
  return true;
}

function readUint32BE(buffer: Uint8Array, offset: number): number | null {
  if (offset + 4 > buffer.length) return null;
  const a = buffer[offset];
  const b = buffer[offset + 1];
  const c = buffer[offset + 2];
  const d = buffer[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function readUint32LE(buffer: Uint8Array, offset: number): number | null {
  if (offset + 4 > buffer.length) return null;
  const a = buffer[offset];
  const b = buffer[offset + 1];
  const c = buffer[offset + 2];
  const d = buffer[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return ((d << 24) | (c << 16) | (b << 8) | a) >>> 0;
}

function readUint16BE(buffer: Uint8Array, offset: number): number | null {
  if (offset + 2 > buffer.length) return null;
  const a = buffer[offset];
  const b = buffer[offset + 1];
  if (a === undefined || b === undefined) return null;
  return (a << 8) | b;
}

/** PNG: 8-byte signature, then an IHDR chunk carrying width/height as BE uint32. */
function sniffPng(buffer: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytesAt(buffer, 0, signature)) return null;
  // IHDR must be the first chunk: length(4) type(4) at offset 8..15.
  if (!bytesAt(buffer, 12, [0x49, 0x48, 0x44, 0x52])) return null;
  const width = readUint32BE(buffer, 16);
  const height = readUint32BE(buffer, 20);
  if (width === null || height === null) return null;
  return { width, height };
}

/**
 * JPEG: walk the marker segments to find a Start-Of-Frame (SOFn) and read the
 * dimensions from it. Deliberately bounded to the first 64 KB of markers so a
 * malformed file cannot make this loop for a long time.
 */
function sniffJpeg(buffer: Uint8Array): { width: number; height: number } | null {
  if (!bytesAt(buffer, 0, [0xff, 0xd8, 0xff])) return null;

  let offset = 2;
  const limit = Math.min(buffer.length, 65_536);

  while (offset + 4 < limit) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === undefined) return null;

    // Standalone markers with no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan: no dimensions past here.
    if (marker === 0xda) return null;

    const length = readUint16BE(buffer, offset + 2);
    if (length === null || length < 2) return null;

    // SOF0/1/2/3, 5/6/7, 9/10/11, 13/14/15 all carry dimensions the same way.
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSof) {
      const height = readUint16BE(buffer, offset + 5);
      const width = readUint16BE(buffer, offset + 7);
      if (width === null || height === null) return null;
      return { width, height };
    }

    offset += 2 + length;
  }
  return null;
}

/** WebP: RIFF container. Three sub-formats (VP8, VP8L, VP8X) encode size differently. */
function sniffWebp(buffer: Uint8Array): { width: number; height: number } | null {
  if (!bytesAt(buffer, 0, [0x52, 0x49, 0x46, 0x46])) return null; // "RIFF"
  if (!bytesAt(buffer, 8, [0x57, 0x45, 0x42, 0x50])) return null; // "WEBP"

  // Lossy: "VP8 " then a 10-byte frame header. Dimensions are 14-bit
  // little-endian values, with 2 bits of scaling in the high bits.
  if (bytesAt(buffer, 12, [0x56, 0x50, 0x38, 0x20])) {
    const b26 = buffer[26];
    const b27 = buffer[27];
    const b28 = buffer[28];
    const b29 = buffer[29];
    if (b26 === undefined || b27 === undefined || b28 === undefined || b29 === undefined)
      return null;
    const width = ((b27 << 8) | b26) & 0x3fff;
    const height = ((b29 << 8) | b28) & 0x3fff;
    return { width, height };
  }

  // Lossless: "VP8L", then 14 bits width-1 and 14 bits height-1, packed LE.
  if (bytesAt(buffer, 12, [0x56, 0x50, 0x38, 0x4c])) {
    const bits = readUint32LE(buffer, 21);
    if (bits === null) return null;
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }

  // Extended: "VP8X", canvas size as two 24-bit LE values minus one.
  if (bytesAt(buffer, 12, [0x56, 0x50, 0x38, 0x58])) {
    const b24 = buffer[24];
    const b25 = buffer[25];
    const b26 = buffer[26];
    const b27 = buffer[27];
    const b28 = buffer[28];
    const b29 = buffer[29];
    if (
      b24 === undefined ||
      b25 === undefined ||
      b26 === undefined ||
      b27 === undefined ||
      b28 === undefined ||
      b29 === undefined
    ) {
      return null;
    }
    const width = ((b26 << 16) | (b25 << 8) | b24) + 1;
    const height = ((b29 << 16) | (b28 << 8) | b27) + 1;
    return { width, height };
  }

  return null;
}

/** Formats we explicitly detect in order to reject them with a clear reason. */
function detectRejectedFormat(buffer: Uint8Array): string | null {
  if (bytesAt(buffer, 0, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (bytesAt(buffer, 0, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (bytesAt(buffer, 0, [0x50, 0x4b, 0x03, 0x04])) return 'zip/office';
  if (bytesAt(buffer, 0, [0x42, 0x4d])) return 'bmp';
  if (bytesAt(buffer, 0, [0x00, 0x00, 0x01, 0x00])) return 'ico';
  if (bytesAt(buffer, 0, [0x49, 0x49, 0x2a, 0x00])) return 'tiff';
  if (bytesAt(buffer, 0, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (bytesAt(buffer, 0, [0x7f, 0x45, 0x4c, 0x46])) return 'elf';
  if (bytesAt(buffer, 0, [0x4d, 0x5a])) return 'exe';

  // Text-ish payloads: SVG, HTML, XML. Check a decoded prefix, tolerating a BOM
  // and leading whitespace — an SVG with a comment before the root element is
  // still an SVG.
  // Default TextDecoder: utf-8, non-fatal (invalid bytes become U+FFFD). That is
  // what we want — we are looking for a text signature, not decoding a document.
  const prefix = new TextDecoder()
    .decode(buffer.subarray(0, 512))
    .replace(/^[\s]*/, '')
    .toLowerCase();
  if (prefix.startsWith('<?xml') || prefix.includes('<svg')) return 'svg/xml';
  if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html')) return 'html';
  if (prefix.startsWith('#!')) return 'script';

  return null;
}

/**
 * Decide what a byte buffer actually is.
 *
 * Note the order: we sniff for an ALLOWED format first, then explicitly name
 * common rejected formats for a good error message, then fall through to
 * unknown. Nothing about the caller's declared type is consulted.
 */
export function sniffImage(buffer: Uint8Array, declaredMime?: string): SniffResult {
  if (buffer.length < 32) return { ok: false, reason: 'too_small' };

  let mime: AllowedImageMime | null = null;
  let dims: { width: number; height: number } | null = null;

  const png = sniffPng(buffer);
  if (png) {
    mime = 'image/png';
    dims = png;
  } else {
    const jpeg = sniffJpeg(buffer);
    if (jpeg) {
      mime = 'image/jpeg';
      dims = jpeg;
    } else {
      const webp = sniffWebp(buffer);
      if (webp) {
        mime = 'image/webp';
        dims = webp;
      }
    }
  }

  if (mime === null) {
    const rejected = detectRejectedFormat(buffer);
    return rejected
      ? { ok: false, reason: 'format_not_allowed', detected: rejected }
      : { ok: false, reason: 'unknown_format' };
  }

  if (dims === null) return { ok: false, reason: 'dimensions_unreadable' };

  // A declared type that disagrees with the bytes is itself a signal. We trust
  // the bytes, but a mismatch means the client is either broken or probing.
  if (
    declaredMime !== undefined &&
    (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(declaredMime) &&
    declaredMime !== mime
  ) {
    return {
      ok: false,
      reason: 'format_not_allowed',
      detected: `${mime} declared as ${declaredMime}`,
    };
  }

  if (
    dims.width < MIN_IMAGE_DIMENSION ||
    dims.height < MIN_IMAGE_DIMENSION ||
    dims.width > MAX_IMAGE_DIMENSION ||
    dims.height > MAX_IMAGE_DIMENSION
  ) {
    return { ok: false, reason: 'dimensions_out_of_range' };
  }

  // The decompression-bomb guard. A 20 KB PNG can declare 40000x40000, which is
  // 1.6 billion pixels and ~6 GB decoded. File size alone does not catch it;
  // the pixel budget does.
  if (dims.width * dims.height > MAX_IMAGE_PIXEL_COUNT) {
    return { ok: false, reason: 'pixel_budget_exceeded' };
  }

  return { ok: true, mime, width: dims.width, height: dims.height };
}

// -----------------------------------------------------------------------------
// Cloudflare Images API
// -----------------------------------------------------------------------------

export interface DirectUploadTicket {
  readonly uploadUrl: string;
  readonly imageAssetId: string;
  readonly expiresAt: string;
}

export interface ImageClient {
  /** One-time upload URL, scoped to this user and reservation. */
  createDirectUpload(input: {
    ownerId: string;
    reservationId: string;
    expiryMinutes?: number;
  }): Promise<DirectUploadTicket>;

  /** Fetch enough of the stored original to sniff it. Range request, not the whole file. */
  fetchForValidation(imageAssetId: string): Promise<{ bytes: Uint8Array; totalBytes: number }>;

  /** Make the approved variants publicly reachable. */
  publish(imageAssetId: string): Promise<void>;

  /** Remove an asset entirely (rejected upload, refunded placement). */
  delete(imageAssetId: string): Promise<void>;

  /** Public URL for a published variant. */
  publicUrl(imageAssetId: string, variant?: string): string;
}

class CloudflareImagesClient implements ImageClient {
  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get base(): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.config.images.accountId}/images`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.images.apiToken}` };
  }

  async createDirectUpload(input: {
    ownerId: string;
    reservationId: string;
    expiryMinutes?: number;
  }): Promise<DirectUploadTicket> {
    const expiryMinutes = Math.min(Math.max(input.expiryMinutes ?? 15, 2), 60);
    const expiry = new Date(Date.now() + expiryMinutes * 60_000).toISOString();

    const form = new FormData();
    // Uploaded assets stay private until publish(). This is what prevents an
    // unmoderated image from ever being publicly addressable.
    form.append('requireSignedURLs', 'true');
    form.append('expiry', expiry);
    // Metadata is how we bind the asset back to the reservation without
    // trusting the client to tell us later.
    form.append(
      'metadata',
      JSON.stringify({
        ownerId: input.ownerId,
        reservationId: input.reservationId,
        stage: 'quarantine',
      }),
    );

    const response = await this.fetchImpl(`${this.base}/v2/direct_upload`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });

    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      result?: { id?: string; uploadURL?: string };
      errors?: unknown;
    } | null;

    if (
      !response.ok ||
      payload?.success !== true ||
      !payload.result?.id ||
      !payload.result.uploadURL
    ) {
      throw new Error(`Cloudflare Images direct_upload failed (${response.status})`);
    }

    return {
      uploadUrl: payload.result.uploadURL,
      imageAssetId: payload.result.id,
      expiresAt: expiry,
    };
  }

  async fetchForValidation(
    imageAssetId: string,
  ): Promise<{ bytes: Uint8Array; totalBytes: number }> {
    // Only the first 64 KB is needed to sniff format and dimensions. Fetching
    // the whole file would let a large upload consume the Worker's memory and
    // CPU budget.
    const response = await this.fetchImpl(`${this.base}/v1/${imageAssetId}/blob`, {
      headers: { ...this.headers(), Range: 'bytes=0-65535' },
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Cloudflare Images blob fetch failed (${response.status})`);
    }

    const buffer = await response.arrayBuffer();
    const contentRange = response.headers.get('Content-Range');
    const total = contentRange?.split('/')[1];
    const totalBytes = total !== undefined ? Number.parseInt(total, 10) : buffer.byteLength;

    return {
      bytes: new Uint8Array(buffer),
      totalBytes: Number.isSafeInteger(totalBytes) ? totalBytes : buffer.byteLength,
    };
  }

  async publish(imageAssetId: string): Promise<void> {
    const form = new FormData();
    form.append('requireSignedURLs', 'false');
    form.append('metadata', JSON.stringify({ stage: 'published' }));

    const response = await this.fetchImpl(`${this.base}/v1/${imageAssetId}`, {
      method: 'PATCH',
      headers: this.headers(),
      body: form,
    });
    if (!response.ok) throw new Error(`Cloudflare Images publish failed (${response.status})`);
  }

  async delete(imageAssetId: string): Promise<void> {
    const response = await this.fetchImpl(`${this.base}/v1/${imageAssetId}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    // 404 means it is already gone, which satisfies the caller's intent.
    if (!response.ok && response.status !== 404) {
      throw new Error(`Cloudflare Images delete failed (${response.status})`);
    }
  }

  publicUrl(imageAssetId: string, variant?: string): string {
    const v = variant ?? this.config.images.publicVariant;
    return `${this.config.images.deliveryBase}/${imageAssetId}/${v}`;
  }
}

/**
 * Refuses every operation with a clear message when Images is not configured.
 *
 * Better than a null client: routes stay simple, and the failure is an explicit
 * 502 with a log line rather than a TypeError.
 */
class UnconfiguredImageClient implements ImageClient {
  private fail(): never {
    throw new Error('image pipeline is not configured (CF_IMAGES_* missing)');
  }
  createDirectUpload(): Promise<DirectUploadTicket> {
    return Promise.reject(new Error('image pipeline is not configured'));
  }
  fetchForValidation(): Promise<{ bytes: Uint8Array; totalBytes: number }> {
    return Promise.reject(new Error('image pipeline is not configured'));
  }
  publish(): Promise<void> {
    return Promise.reject(new Error('image pipeline is not configured'));
  }
  delete(): Promise<void> {
    return Promise.reject(new Error('image pipeline is not configured'));
  }
  publicUrl(): string {
    return this.fail();
  }
}

export function createImageClient(config: AppConfig, fetchImpl?: typeof fetch): ImageClient {
  if (!config.images.configured) return new UnconfiguredImageClient();
  return new CloudflareImagesClient(config, fetchImpl);
}

/**
 * Turn a stored provider path into an absolute URL.
 *
 * The database stores `<assetId>/<variant>`; the delivery hostname lives only in
 * configuration, so switching image providers is a config change rather than a
 * data migration.
 */
export function absoluteImageUrl(config: AppConfig, storedPath: string | null): string | null {
  if (storedPath === null || storedPath === '') return null;
  if (storedPath.startsWith('http://') || storedPath.startsWith('https://')) return storedPath;
  if (config.images.deliveryBase === '') return null;
  return `${config.images.deliveryBase}/${storedPath.replace(/^\/+/, '')}`;
}

/** Bounded, non-throwing size check used before we even ask for an upload URL. */
export function isPlausibleUploadSize(byteSize: number): boolean {
  return Number.isSafeInteger(byteSize) && byteSize > 0 && byteSize <= MAX_UPLOAD_BYTES;
}
