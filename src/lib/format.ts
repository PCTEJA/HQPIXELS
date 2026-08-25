/**
 * Display formatting.
 *
 * Money formatting is re-exported from the shared pricing module rather than
 * reimplemented, so the client can never render a different total from the one
 * the server computed.
 */

import { formatCents } from '@shared/pricing';
import { CELL_LOGICAL_SIZE } from '@shared/constants';

export { formatCents };

/** `1234567` -> `"1,234,567"`. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Math.round(value).toLocaleString('en-US');
}

/**
 * Compact form for large counters: `1234567` -> `"1.23M"`.
 *
 * Only used where space genuinely demands it, and never for a price — an
 * abbreviated price is how people end up surprised by a charge.
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}K`;
  }
  const millions = value / 1_000_000;
  return `${millions < 10 ? millions.toFixed(2) : millions.toFixed(1)}M`;
}

/** Basis points to a percentage string. Integer input, so no float surprises. */
export function formatBasisPoints(bp: number, decimals = 2): string {
  if (!Number.isFinite(bp)) return '0%';
  return `${(bp / 100).toFixed(decimals)}%`;
}

/** A cell rectangle described in logical pixels, e.g. `"40 x 30 pixels"`. */
export function formatRectPixels(rect: { w: number; h: number }): string {
  return `${rect.w * CELL_LOGICAL_SIZE} x ${rect.h * CELL_LOGICAL_SIZE} pixels`;
}

export function formatUnits(cells: number): string {
  return cells === 1 ? '1 unit' : `${formatCount(cells)} units`;
}

/**
 * Relative time, capped at a week before falling back to an absolute date.
 *
 * "3 days ago" is friendlier than a timestamp; "just now" for anything under a
 * minute avoids a counter that ticks distractingly.
 */
export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'unknown';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';

  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (seconds < 604_800) {
    const days = Math.floor(seconds / 86_400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return formatDate(iso);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Countdown for a reservation hold: `"12:34"` or `"1:02:33"`.
 *
 * Returns `null` once it has lapsed, so the caller renders "expired" rather than
 * a negative number — a countdown that goes negative looks broken and makes
 * people distrust the hold.
 */
export function formatCountdown(expiresAt: string, now = Date.now()): string | null {
  const remaining = Math.floor((new Date(expiresAt).getTime() - now) / 1000);
  if (!Number.isFinite(remaining) || remaining <= 0) return null;

  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;

  const two = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

/** Seconds remaining, floored at zero. For aria-live announcements. */
export function secondsUntil(iso: string, now = Date.now()): number {
  const remaining = Math.floor((new Date(iso).getTime() - now) / 1000);
  return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
}

/**
 * Middle-truncate a hostname for display.
 *
 * Keeps the END, which is the part that identifies the real domain. Truncating
 * the tail would hide exactly the information a visitor needs before clicking
 * (`paypal.com.attacker.example` must not render as `paypal.com...`).
 */
export function formatHost(host: string, maxLength = 32): string {
  if (host.length <= maxLength) return host;
  const labels = host.split('.');
  const tail = labels.slice(-3).join('.');
  return tail.length >= maxLength ? `...${tail.slice(-(maxLength - 3))}` : `...${tail}`;
}

/** Plural helper that avoids "1 units" everywhere. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}
