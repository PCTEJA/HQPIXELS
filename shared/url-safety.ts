/**
 * Destination URL validation.
 *
 * A buyer-supplied outbound link is one of the highest-risk inputs in the whole
 * product: it is the vector for open redirects, `javascript:` payloads, SSRF
 * against our own infrastructure, and phishing. This module is pure (no network,
 * no DNS) and is the ONLY place a destination string becomes trusted.
 *
 * The Worker runs `normalizeDestinationUrl` before storing anything, and
 * `/go/:placementId` serves the *stored, normalized* value. The final redirect
 * target never comes from a query string.
 *
 * What this module cannot do: it cannot tell you the host is not malicious. That
 * is what moderation, reputation re-checks (see worker/jobs/link-health.ts) and
 * the disable switch are for.
 */

export type UrlRejectReason =
  | 'empty'
  | 'too_long'
  | 'unparseable'
  | 'bad_scheme'
  | 'has_credentials'
  | 'control_characters'
  | 'no_hostname'
  | 'ip_literal_blocked'
  | 'private_or_loopback'
  | 'blocked_tld'
  | 'blocked_host'
  | 'mixed_script_hostname'
  | 'punycode_lookalike'
  | 'port_not_allowed'
  | 'self_referential';

export interface UrlValidationSuccess {
  readonly ok: true;
  /** Canonical form to store and to redirect to. */
  readonly url: string;
  /** Lowercased hostname, shown to visitors before they leave. */
  readonly host: string;
  /** Registrable-ish suffix for grouping/abuse stats. Best-effort, not a PSL lookup. */
  readonly apexHost: string;
  readonly isHttps: boolean;
}

export interface UrlValidationFailure {
  readonly ok: false;
  readonly reason: UrlRejectReason;
  /** Safe to show a buyer. Never echoes the raw input. */
  readonly message: string;
}

export type UrlValidationResult = UrlValidationSuccess | UrlValidationFailure;

const MAX_URL_LENGTH = 512;

/** Only real web schemes. Everything else (javascript:, data:, file:, intent:) is rejected. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Non-default ports invite scanning of internal services. Allow only the web ports. */
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/**
 * Hostnames that must never be a destination. Two categories:
 *   - our own infrastructure (SSRF / trust-laundering / redirect loops)
 *   - metadata and localhost endpoints
 */
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.private',
  '.test',
  '.example',
  '.invalid',
  '.onion',
  '.i2p',
  // Our own origins: a placement must not point back at us.
  '.hqpixels.com',
];

const BLOCKED_EXACT_SELF = new Set(['hqpixels.com', 'www.hqpixels.com', 'staging.hqpixels.com']);

/** TLDs with no legitimate advertiser use for this product and heavy abuse history. */
const BLOCKED_TLDS = new Set([
  'zip',
  'mov',
  'onion',
  'i2p',
  'test',
  'example',
  'invalid',
  'localhost',
]);

/**
 * C0/C1 controls, plus the Unicode characters used to visually spoof a URL:
 * bidi overrides, zero-width joiners, soft hyphen, and the "invisible" spaces.
 */
const DANGEROUS_CODEPOINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], // C0 controls (includes NUL, CR, LF, TAB)
  [0x7f, 0x9f], // DEL and the C1 control block
  [0x00ad, 0x00ad], // soft hyphen — invisible, splits a label visually
  [0x200b, 0x200f], // zero-width space/non-joiner/joiner, LRM, RLM
  [0x202a, 0x202e], // bidi embedding and override (RLO domain spoofing)
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xfff9, 0xfffb], // interlinear annotation marks
];

function hasDangerousCodepoint(value: string): boolean {
  // Iterating the string yields whole codepoints, so astral characters are
  // compared correctly rather than as surrogate halves.
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    for (const range of DANGEROUS_CODEPOINT_RANGES) {
      if (cp >= range[0] && cp <= range[1]) return true;
    }
  }
  return false;
}

function fail(reason: UrlRejectReason, message: string): UrlValidationFailure {
  return { ok: false, reason, message };
}

// -----------------------------------------------------------------------------
// IP literal detection
// -----------------------------------------------------------------------------

/**
 * True for a decimal-dotted IPv4. Deliberately strict: no octal (`0177.0.0.1`),
 * no hex (`0x7f.1`), no integer form (`2130706433`), no fewer than four octets.
 * Those alternate encodings are exactly how SSRF filters get bypassed, so
 * anything that merely *looks* numeric is rejected outright below.
 */
function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // Reject leading zeros: "010" would be octal in some resolvers.
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 docs
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // documentation
  if (a === 203 && b === 0) return true; // documentation
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * Any bracketed host is an IPv6 literal. We reject *all* IPv6 literals rather
 * than trying to classify them: legitimate advertisers use hostnames, and
 * IPv6 has too many equivalent encodings (`::ffff:127.0.0.1`, `::1`, zone ids)
 * to filter confidently.
 */
function isIpv6Literal(hostname: string): boolean {
  return hostname.startsWith('[') || hostname.includes(':');
}

// -----------------------------------------------------------------------------
// Homograph / confusable detection
// -----------------------------------------------------------------------------

const SCRIPT_RANGES: ReadonlyArray<{ name: string; test: RegExp }> = [
  { name: 'latin', test: /[a-z]/ },
  { name: 'cyrillic', test: /[Ѐ-ӿ]/ },
  { name: 'greek', test: /[Ͱ-Ͽ]/ },
  { name: 'armenian', test: /[԰-֏]/ },
  { name: 'hebrew', test: /[֐-׿]/ },
  { name: 'arabic', test: /[؀-ۿ]/ }, // eslint-disable-next-line no-irregular-whitespace -- U+3000 ideographic space intentionally included in CJK range  { name: 'cjk', test: /[　-鿿豈-﫿]/ },
  { name: 'hangul', test: /[가-힯ᄀ-ᇿ]/ },
  { name: 'devanagari', test: /[ऀ-ॿ]/ },
  { name: 'thai', test: /[฀-๿]/ },
];

/**
 * Mixing Latin with another script inside one label is the classic homograph
 * attack (`аpple.com` with a Cyrillic а). Single-script non-Latin labels are
 * legitimate internationalised domains and are allowed.
 */
function hasMixedScriptLabel(unicodeHost: string): boolean {
  for (const label of unicodeHost.split('.')) {
    const lower = label.toLowerCase();
    const scripts = SCRIPT_RANGES.filter((r) => r.test.test(lower)).map((r) => r.name);
    if (scripts.length > 1) return true;
  }
  return false;
}

/**
 * A punycode label that decodes to something containing Latin letters *and*
 * non-Latin letters. `URL` gives us the punycode form; we detect the risky
 * shape without needing a full IDNA decoder by checking for `xn--` labels
 * alongside ASCII-looking siblings that spell a well-known brand-ish string.
 *
 * We take the conservative route: any `xn--` label makes the URL require
 * manual moderation rather than auto-approval. It is not rejected outright,
 * because legitimate IDNs exist — see `requiresManualReview`.
 */
function hasPunycodeLabel(asciiHost: string): boolean {
  return asciiHost.split('.').some((l) => l.startsWith('xn--'));
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface NormalizeOptions {
  /** Origins belonging to this deployment, additionally blocked as destinations. */
  readonly selfHosts?: readonly string[];
  /** Reject plain http:// entirely. Default: allowed but flagged. */
  readonly requireHttps?: boolean;
}

/**
 * Validate and canonicalise a buyer-supplied destination URL.
 *
 * Canonicalisation performed:
 *   - Unicode NFKC normalisation of the input string (defeats fullwidth and
 *     compatibility-character tricks before parsing).
 *   - lowercase scheme and host (via `URL`)
 *   - default port removed
 *   - fragment removed (never useful for an ad destination, and a place to hide
 *     text from moderators)
 *   - trailing dot stripped from the hostname
 */
export function normalizeDestinationUrl(
  raw: string,
  options: NormalizeOptions = {},
): UrlValidationResult {
  if (typeof raw !== 'string') return fail('unparseable', 'Enter a valid web address.');

  // NFKC first: fullwidth "ｈｔｔｐ" and compatibility forms collapse to ASCII
  // here, so the checks below cannot be bypassed with lookalike codepoints.
  const normalized = raw.normalize('NFKC').trim();

  if (normalized.length === 0) return fail('empty', 'Enter a destination web address.');
  if (normalized.length > MAX_URL_LENGTH) {
    return fail('too_long', `Web address must be ${MAX_URL_LENGTH} characters or fewer.`);
  }
  if (hasDangerousCodepoint(normalized)) {
    return fail('control_characters', 'That web address contains characters we cannot accept.');
  }
  // Reject anything with whitespace inside — `URL` would happily strip some of it.
  if (/\s/.test(normalized)) {
    return fail('unparseable', 'Web addresses cannot contain spaces.');
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return fail(
      'unparseable',
      'That does not look like a complete web address (include https://).',
    );
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return fail('bad_scheme', 'Only http:// and https:// addresses are allowed.');
  }
  if (options.requireHttps === true && parsed.protocol !== 'https:') {
    return fail('bad_scheme', 'Only https:// addresses are allowed.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return fail('has_credentials', 'Web addresses cannot contain a username or password.');
  }
  if (!ALLOWED_PORTS.has(parsed.port)) {
    return fail('port_not_allowed', 'Only standard web ports are allowed.');
  }

  // `URL` stores the IDNA/punycode form here.
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (hostname === '') return fail('no_hostname', 'Web address is missing a hostname.');

  if (isIpv6Literal(hostname)) {
    return fail('ip_literal_blocked', 'Point your link at a domain name, not an IP address.');
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    // Even a public IPv4 literal is rejected: advertisers use domains, and
    // allowing literals means maintaining a perfect private-range filter forever.
    if (isPrivateIpv4(ipv4)) {
      return fail('private_or_loopback', 'That address points to a private or local network.');
    }
    return fail('ip_literal_blocked', 'Point your link at a domain name, not an IP address.');
  }

  // A hostname that is entirely digits/dots but did not parse as clean IPv4 is
  // an alternate IP encoding attempt (octal, hex, 32-bit integer).
  if (/^[0-9a-fx.]+$/i.test(hostname) && /^[0-9]/.test(hostname) && !hostname.includes('-')) {
    return fail('ip_literal_blocked', 'Point your link at a domain name, not an IP address.');
  }

  if (!hostname.includes('.')) {
    return fail('no_hostname', 'Use a full domain name, for example example.com.');
  }
  if (BLOCKED_HOSTS.has(hostname)) {
    return fail('blocked_host', 'That destination is not allowed.');
  }
  if (BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
    return fail('blocked_host', 'That destination is not allowed.');
  }
  if (BLOCKED_EXACT_SELF.has(hostname)) {
    return fail('self_referential', 'A placement cannot link back to HQPixels.');
  }
  for (const self of options.selfHosts ?? []) {
    const s = self.toLowerCase();
    if (hostname === s || hostname.endsWith(`.${s}`)) {
      return fail('self_referential', 'A placement cannot link back to HQPixels.');
    }
  }

  const tld = hostname.slice(hostname.lastIndexOf('.') + 1);
  if (BLOCKED_TLDS.has(tld)) {
    return fail('blocked_tld', 'That top-level domain is not accepted.');
  }
  // Labels must be syntactically valid: no empty labels, no leading/trailing
  // hyphen, nothing over 63 octets.
  for (const label of hostname.split('.')) {
    if (label.length === 0 || label.length > 63) {
      return fail('unparseable', 'That hostname is not valid.');
    }
    if (label.startsWith('-') || label.endsWith('-')) {
      return fail('unparseable', 'That hostname is not valid.');
    }
  }
  if (hasMixedScriptLabel(normalized)) {
    return fail(
      'mixed_script_hostname',
      'That hostname mixes character sets in a way we cannot verify.',
    );
  }

  // Rebuild rather than trusting `parsed.href`, so nothing unexpected survives.
  const out = new URL(`${parsed.protocol}//${hostname}`);
  out.port =
    ALLOWED_PORTS.has(parsed.port) &&
    parsed.port !== '' &&
    parsed.port !== '80' &&
    parsed.port !== '443'
      ? parsed.port
      : '';
  out.pathname = parsed.pathname;
  out.search = parsed.search;
  out.hash = ''; // dropped deliberately

  const url = out.toString();
  if (url.length > MAX_URL_LENGTH) {
    return fail('too_long', `Web address must be ${MAX_URL_LENGTH} characters or fewer.`);
  }

  const labels = hostname.split('.');
  const apexHost = labels.length >= 2 ? labels.slice(-2).join('.') : hostname;

  return {
    ok: true,
    url,
    host: hostname,
    apexHost,
    isHttps: parsed.protocol === 'https:',
  };
}

/**
 * Signals that should route a placement to a human moderator even though the URL
 * is structurally acceptable. Returned reasons are stored on the moderation
 * record so the admin sees *why* it was queued.
 */
export function urlManualReviewReasons(result: UrlValidationSuccess): string[] {
  const reasons: string[] = [];
  if (!result.isHttps) reasons.push('plain_http');
  if (hasPunycodeLabel(result.host)) reasons.push('internationalised_domain');
  if (result.host.split('.').length > 4) reasons.push('deep_subdomain');
  if (/[0-9]{4,}/.test(result.host)) reasons.push('numeric_host_pattern');
  if (result.url.length > 200) reasons.push('long_url');
  return reasons;
}

/**
 * Hostname shown in the UI before a visitor leaves the site. Truncated in the
 * middle so a long prefix cannot push the real domain out of view — a common
 * trick (`paypal.com.security-check.attacker.example`).
 */
export function displayHost(host: string, maxLength = 40): string {
  if (host.length <= maxLength) return host;
  const labels = host.split('.');
  const tail = labels.slice(-3).join('.');
  if (tail.length >= maxLength) return `…${tail.slice(-(maxLength - 1))}`;
  return `…${tail}`;
}
