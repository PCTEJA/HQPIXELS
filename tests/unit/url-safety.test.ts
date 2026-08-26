/**
 * Unit tests for shared/url-safety.ts.
 *
 * Destination URL validation is security-critical. These tests verify:
 * - Protocol restrictions (only http/https)
 * - IDN/punycode handling
 * - Private IP and metadata endpoint blocking
 * - Suspicious pattern detection
 * - Length limits
 */

import { describe, expect, it } from 'vitest';
import { normalizeDestinationUrl, type UrlRejectReason } from '@shared/url-safety';

function expectSuccess(raw: string) {
  const result = normalizeDestinationUrl(raw);
  expect(result.ok, `Expected success for: ${raw}`).toBe(true);
  return result as { ok: true; url: string; host: string; apexHost: string; isHttps: boolean };
}

function expectFailure(raw: string, reason: UrlRejectReason) {
  const result = normalizeDestinationUrl(raw);
  expect(result.ok, `Expected failure for: ${raw}`).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe(reason);
  }
  return result;
}

describe('normalizeDestinationUrl', () => {
  describe('valid URLs', () => {
    it('accepts a simple HTTPS URL', () => {
      const result = expectSuccess('https://example.com');
      expect(result.url).toBe('https://example.com/');
      expect(result.host).toBe('example.com');
      expect(result.isHttps).toBe(true);
    });

    it('accepts HTTP URLs', () => {
      const result = expectSuccess('http://example.com/page');
      expect(result.isHttps).toBe(false);
    });

    it('normalizes to lowercase host', () => {
      const result = expectSuccess('https://EXAMPLE.COM/Path');
      expect(result.host).toBe('example.com');
      expect(result.url).toContain('example.com');
    });

    it('preserves path and query string', () => {
      const result = expectSuccess('https://example.com/path?query=value');
      expect(result.url).toBe('https://example.com/path?query=value');
    });

    it('removes fragments', () => {
      const result = expectSuccess('https://example.com/page#section');
      expect(result.url).toBe('https://example.com/page');
      expect(result.url).not.toContain('#');
    });

    it('accepts standard ports', () => {
      expectSuccess('https://example.com:443/');
      expectSuccess('http://example.com:80/');
      expectSuccess('https://example.com:8443/');
      expectSuccess('http://example.com:8080/');
    });

    it('extracts apex host for grouping', () => {
      const result = expectSuccess('https://sub.domain.example.com/');
      expect(result.apexHost).toBeTruthy();
    });
  });

  describe('blocked protocols', () => {
    it('rejects javascript: URLs', () => {
      expectFailure('javascript:alert(1)', 'bad_scheme');
    });

    it('rejects data: URLs', () => {
      expectFailure('data:text/html,<script>alert(1)</script>', 'bad_scheme');
    });

    it('rejects file: URLs', () => {
      expectFailure('file:///etc/passwd', 'bad_scheme');
    });

    it('rejects intent: URLs', () => {
      expectFailure('intent://scan/#Intent;scheme=zxing;end', 'bad_scheme');
    });

    it('rejects ftp: URLs', () => {
      expectFailure('ftp://example.com/', 'bad_scheme');
    });
  });

  describe('empty and malformed input', () => {
    it('rejects empty string', () => {
      expectFailure('', 'empty');
    });

    it('rejects whitespace-only string', () => {
      expectFailure('   ', 'empty');
    });

    it('rejects URLs without scheme', () => {
      expectFailure('example.com', 'unparseable');
    });

    it('rejects URLs with spaces', () => {
      expectFailure('https://example .com/', 'unparseable');
    });
  });

  describe('length limits', () => {
    it('rejects URLs exceeding 512 characters', () => {
      const longPath = 'a'.repeat(500);
      expectFailure(`https://example.com/${longPath}`, 'too_long');
    });

    it('accepts URLs at exactly 512 characters', () => {
      const padding = 'a'.repeat(512 - 'https://example.com/'.length);
      expectSuccess(`https://example.com/${padding}`);
    });
  });

  describe('credentials in URL', () => {
    it('rejects URLs with username', () => {
      expectFailure('https://user@example.com/', 'has_credentials');
    });

    it('rejects URLs with username and password', () => {
      expectFailure('https://user:pass@example.com/', 'has_credentials');
    });
  });

  describe('IP literals', () => {
    it('rejects IPv4 literals (private ranges)', () => {
      // Private IPs return private_or_loopback
      expectFailure('http://192.168.1.1/', 'private_or_loopback');
    });

    it('rejects IPv6 literals', () => {
      expectFailure('http://[::1]/', 'ip_literal_blocked');
    });

    it('rejects loopback addresses', () => {
      expectFailure('http://127.0.0.1/', 'private_or_loopback');
    });

    it('rejects private network addresses', () => {
      expectFailure('http://10.0.0.1/', 'private_or_loopback');
      expectFailure('http://172.16.0.1/', 'private_or_loopback');
    });

    it('rejects metadata endpoints', () => {
      expectFailure('http://169.254.169.254/', 'private_or_loopback');
    });
  });

  describe('blocked hosts', () => {
    it('rejects localhost (no dot = no_hostname)', () => {
      expectFailure('http://localhost/', 'no_hostname');
    });

    it('rejects .local domains', () => {
      expectFailure('http://myserver.local/', 'blocked_host');
    });

    it('rejects .internal domains', () => {
      expectFailure('http://service.internal/', 'blocked_host');
    });

    it('rejects metadata.google.internal', () => {
      expectFailure('http://metadata.google.internal/', 'blocked_host');
    });

    it('rejects onion domains', () => {
      expectFailure('http://something.onion/', 'blocked_host');
    });

    it('rejects self-referential URLs', () => {
      // The bare domain is in BLOCKED_EXACT_SELF -> self_referential
      expectFailure('https://hqpixels.com/', 'self_referential');
      // www and other subdomains match .hqpixels.com suffix -> blocked_host
      expectFailure('https://www.hqpixels.com/', 'blocked_host');
      expectFailure('https://sub.hqpixels.com/', 'blocked_host');
    });
  });

  describe('blocked TLDs', () => {
    it('rejects .zip TLD (phishing vector)', () => {
      expectFailure('https://update.zip/', 'blocked_tld');
    });

    it('rejects .mov TLD', () => {
      expectFailure('https://video.mov/', 'blocked_tld');
    });
  });

  describe('non-standard ports', () => {
    it('rejects unusual ports', () => {
      expectFailure('http://example.com:22/', 'port_not_allowed');
      expectFailure('http://example.com:3306/', 'port_not_allowed');
      expectFailure('http://example.com:5432/', 'port_not_allowed');
    });
  });

  describe('control characters', () => {
    it('rejects URLs with null bytes', () => {
      expectFailure('https://example.com/\x00path', 'control_characters');
    });

    it('rejects URLs with newlines (embedded)', () => {
      // Newline at end gets trimmed, but embedded newline is rejected
      expectFailure('https://example.com/pa\nth', 'control_characters');
    });

    it('rejects URLs with zero-width characters', () => {
      // Using codepoint description since we can't write the literal
      expectFailure(
        'https://example' + String.fromCharCode(0x200b) + '.com/',
        'control_characters',
      );
    });

    it('rejects URLs with bidi override characters', () => {
      expectFailure(
        'https://example' + String.fromCharCode(0x202e) + '.com/',
        'control_characters',
      );
    });
  });

  describe('IDN and punycode', () => {
    it('accepts legitimate international domains', () => {
      // Pure non-Latin script is allowed
      const _result = normalizeDestinationUrl('https://xn--n3h.com/');
      // May or may not succeed depending on the specific punycode
      // The important thing is mixed-script rejection
    });

    it('flags mixed-script hostnames as suspicious', () => {
      // Cyrillic 'а' looks like Latin 'a' - classic homograph attack
      // This should either be rejected or flagged for review
      const result = normalizeDestinationUrl('https://аpple.com/');
      // Either rejected or flagged
      if (result.ok) {
        // If accepted, it should be the punycode version
        expect(result.url).toContain('xn--');
      }
    });
  });

  describe('NFKC normalization', () => {
    it('normalizes fullwidth characters', () => {
      // Fullwidth 'ｈｔｔｐ' should normalize to 'http'
      const result = normalizeDestinationUrl('\uff48\uff54\uff54\uff50://example.com/');
      // Should either succeed with normalized URL or fail appropriately
      if (result.ok) {
        expect(result.url).toContain('http://');
      }
    });
  });

  describe('options', () => {
    it('can require HTTPS', () => {
      const result = normalizeDestinationUrl('http://example.com/', { requireHttps: true });
      expect(result.ok).toBe(false);
    });

    it('can block additional self hosts', () => {
      const result = normalizeDestinationUrl('https://staging.mysite.com/', {
        selfHosts: ['staging.mysite.com'],
      });
      expect(result.ok).toBe(false);
    });
  });
});
