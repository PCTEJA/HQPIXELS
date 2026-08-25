/**
 * Client identity for abuse control — deliberately coarse.
 *
 * We need to answer "is this the same source hammering us?" without building a
 * long-lived record of who visited. So:
 *
 *   * The full IP is used only in memory, for the current request, to derive a
 *     rate-limit bucket.
 *   * Anything PERSISTED is a truncated network prefix (IPv4 /24, IPv6 /48) —
 *     enough to spot one actor across a few addresses, not enough to identify a
 *     household. Retention windows are enforced by
 *     `public.purge_expired_privacy_data()`.
 *   * Rate-limit keys are HMACs of the IP, not the IP itself, so the KV/DO
 *     contents are not a list of visitor addresses.
 */

import { hmacSign } from './crypto';

/**
 * Cloudflare sets CF-Connecting-IP and it cannot be spoofed by the client on a
 * Cloudflare-fronted request — the edge overwrites it. X-Forwarded-For is
 * client-controllable and is therefore NOT trusted; it is read only as a
 * last-resort fallback for local development, where there is no edge.
 */
export function getClientIp(request: Request, isProduction: boolean): string | null {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf && cf.length <= 45) return cf;

  if (!isProduction) {
    const xff = request.headers.get('X-Forwarded-For');
    const first = xff?.split(',')[0]?.trim();
    if (first && first.length <= 45) return first;
    return '127.0.0.1';
  }
  return null;
}

function isIpv4(ip: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

/**
 * Truncate to a network prefix for storage.
 *
 * IPv4 -> /24  (e.g. "203.0.113.0/24")
 * IPv6 -> /48  (e.g. "2001:db8:1::/48")
 *
 * Anything unparseable becomes null rather than being stored raw.
 */
export function toNetworkPrefix(ip: string | null): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (trimmed.length === 0 || trimmed.length > 45) return null;

  if (isIpv4(trimmed)) {
    const parts = trimmed.split('.');
    const a = parts[0];
    const b = parts[1];
    const c = parts[2];
    if (a === undefined || b === undefined || c === undefined) return null;
    for (const octet of [a, b, c, parts[3] ?? '']) {
      const n = Number(octet);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    }
    return `${a}.${b}.${c}.0/24`;
  }

  if (trimmed.includes(':')) {
    // Expand only as far as needed to take the first three hextets.
    const withoutZone = trimmed.split('%')[0] ?? trimmed;
    const groups = withoutZone.split(':');
    const head: string[] = [];
    for (const group of groups) {
      if (head.length === 3) break;
      if (group === '') break; // hit the '::' compression
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      head.push(group.toLowerCase());
    }
    while (head.length < 3) head.push('0');
    return `${head.join(':')}::/48`;
  }

  return null;
}

/**
 * Stable, non-reversible bucket key for rate limiting.
 *
 * HMAC rather than a plain hash so the key cannot be brute-forced back to an IP
 * from a leaked KV dump (the IPv4 space is small enough that an unkeyed hash
 * would be trivially reversible).
 */
export async function ipBucketKey(
  ip: string | null,
  signingSecret: string,
  scope: string,
): Promise<string> {
  const material = ip ?? 'unknown-ip';
  const mac = await hmacSign(signingSecret, `ratelimit:${scope}:${material}`);
  return mac.slice(0, 32);
}

/**
 * Coarse user-agent family for the audit log. We store "Chrome" not the full UA
 * string: the full string is a fingerprinting surface and adds nothing to an
 * investigation that the family and the network prefix do not already give.
 */
export function userAgentFamily(request: Request): string | null {
  const ua = request.headers.get('User-Agent');
  if (!ua) return null;
  const lower = ua.toLowerCase();

  // Order matters: Edge and Brave both advertise Chrome, Chrome advertises Safari.
  if (lower.includes('edg/')) return 'Edge';
  if (lower.includes('opr/') || lower.includes('opera')) return 'Opera';
  if (lower.includes('firefox/')) return 'Firefox';
  if (lower.includes('chrome/')) return 'Chrome';
  if (lower.includes('safari/')) return 'Safari';
  if (lower.includes('bot') || lower.includes('crawler') || lower.includes('spider')) return 'Bot';
  if (lower.includes('curl') || lower.includes('wget') || lower.includes('python')) return 'Tool';
  return 'Other';
}

/**
 * Bot heuristic for the page-view counter.
 *
 * This is intentionally simple and errs towards EXCLUDING traffic. The public
 * number must never be inflated, so a false "this is a bot" is much cheaper than
 * a false "this is a person". Cloudflare's own bot score is the real signal in
 * production; this is the floor when that is unavailable.
 */
export function looksAutomated(request: Request): boolean {
  const ua = request.headers.get('User-Agent');
  if (!ua || ua.length < 10) return true;

  const lower = ua.toLowerCase();
  const markers = [
    'bot',
    'crawler',
    'spider',
    'scraper',
    'headless',
    'phantom',
    'slurp',
    'curl/',
    'wget/',
    'python-requests',
    'python-urllib',
    'go-http-client',
    'java/',
    'okhttp',
    'axios/',
    'node-fetch',
    'libwww',
    'httpclient',
    'lighthouse',
    'pagespeed',
    'gtmetrix',
    'pingdom',
    'uptime',
    'monitor',
    'preview',
    'facebookexternalhit',
    'whatsapp',
    'telegrambot',
    'slackbot',
    'discordbot',
    'twitterbot',
    'linkedinbot',
    'embedly',
  ];
  if (markers.some((m) => lower.includes(m))) return true;

  // A real browser navigation always sends these. Their absence means either an
  // automated client or a subresource request that is not a page view.
  const accept = request.headers.get('Accept') ?? '';
  if (!accept.includes('text/html')) return true;

  // Cloudflare's managed bot signal, when the plan provides it.
  const verifiedBot = request.headers.get('CF-Verified-Bot');
  if (verifiedBot === 'true') return true;

  return false;
}
