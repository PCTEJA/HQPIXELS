/**
 * Buyer-supplied text handling.
 *
 * Rendering safety is structural: React escapes text nodes, and
 * `dangerouslySetInnerHTML` is banned by lint. This module is about the *other*
 * half — normalising input so that stored text cannot be used to spoof the UI
 * (bidi tricks, invisible padding, newline injection into log lines) and so that
 * length limits mean what they say.
 */

/**
 * Codepoints stripped from all buyer text. Same list as the URL validator, plus
 * line separators — a placement title is a single line by definition.
 */
const STRIPPED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0a, 0x1f], // keep 0x09 TAB out too; it is normalised to a space below
  [0x7f, 0x9f],
  [0x00ad, 0x00ad],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
];

function isStripped(cp: number): boolean {
  for (const r of STRIPPED_RANGES) {
    if (cp >= r[0] && cp <= r[1]) return true;
  }
  return false;
}

/**
 * Normalise a single-line field (title, alt text, display name).
 *
 * Steps, in order:
 *   1. NFKC — collapses fullwidth/compatibility lookalikes so "ＡＤＭＩＮ"
 *      cannot masquerade as different text from "ADMIN".
 *   2. tabs and Unicode whitespace to plain spaces
 *   3. strip control/invisible/bidi codepoints
 *   4. collapse runs of spaces
 *   5. trim
 *   6. truncate by *codepoint*, not UTF-16 unit, so an emoji is never split into
 *      a lone surrogate
 */
export function normalizeSingleLine(input: string, maxLength: number): string {
  if (typeof input !== 'string') return '';

  const nfkc = input.normalize('NFKC');

  let out = '';
  for (const ch of nfkc) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isStripped(cp)) continue;
    // Any Unicode whitespace (incl. NBSP, ideographic space) becomes a space.
    out += /\s/u.test(ch) ? ' ' : ch;
  }

  out = out.replace(/ {2,}/g, ' ').trim();

  const chars = [...out];
  if (chars.length > maxLength) return chars.slice(0, maxLength).join('').trimEnd();
  return out;
}

/** Codepoint length. `"ab".length` lies about astral characters; this does not. */
export function codepointLength(value: string): number {
  return [...value].length;
}

/**
 * Reject text that is *technically* within limits but is not a usable title:
 * empty after normalisation, or made only of punctuation/symbols. Prevents
 * "placements" whose title is a single zero-width character.
 */
export function hasMeaningfulContent(value: string): boolean {
  const normalized = normalizeSingleLine(value, 1000);
  if (normalized.length === 0) return false;
  // At least one letter or digit in any script.
  return /[\p{L}\p{N}]/u.test(normalized);
}

/**
 * Text safe to put in a log line or an HTTP header value. Log injection is a
 * real problem when an attacker controls a field that lands in a log
 * aggregator: a newline lets them forge a second log record.
 */
export function sanitizeForLog(value: unknown, maxLength = 200): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str === undefined) return '';
  let out = '';
  for (const ch of str.normalize('NFKC')) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
      out += ' ';
      continue;
    }
    out += ch;
  }
  const trimmed = out.replace(/ {2,}/g, ' ').trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}

/**
 * Shorten for display without breaking a grapheme mid-way. Used for titles in
 * the leaderboard and hover card.
 */
export function truncateForDisplay(value: string, maxLength: number): string {
  const chars = [...value];
  if (chars.length <= maxLength) return value;
  return `${chars.slice(0, Math.max(1, maxLength - 1)).join('')}…`;
}

/**
 * A handle is a public identifier, so it is deliberately restrictive: lowercase
 * ASCII only. Confusable handles are an impersonation vector.
 */
export function normalizeHandle(input: string): string | null {
  const candidate = input.normalize('NFKC').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_-]{1,28}[a-z0-9])$/.test(candidate)) return null;
  if (/[-_]{2,}/.test(candidate)) return null;
  return candidate;
}

/** Reserved handles that must not be claimable by buyers. */
export const RESERVED_HANDLES = new Set([
  'admin',
  'administrator',
  'root',
  'support',
  'help',
  'security',
  'billing',
  'payments',
  'stripe',
  'hqpixels',
  'hq',
  'official',
  'staff',
  'moderator',
  'mod',
  'system',
  'api',
  'www',
  'mail',
  'noreply',
  'no-reply',
  'abuse',
  'legal',
  'privacy',
  'terms',
  'dashboard',
  'wall',
  'claim',
  'go',
]);
