/**
 * Unit tests for worker/lib/cookies.ts.
 *
 * Cookie handling is security-critical: parsing must be deterministic (first
 * wins) to prevent session fixation, and serialization must enforce secure
 * defaults.
 */

import { describe, expect, it } from 'vitest';
import { clearCookie, parseCookies, serializeCookie } from '../../worker/lib/cookies';

describe('serializeCookie', () => {
  it('creates a basic cookie', () => {
    const cookie = serializeCookie('name', 'value');
    expect(cookie).toContain('name=value');
  });

  it('includes Path=/ by default', () => {
    const cookie = serializeCookie('name', 'value');
    expect(cookie).toContain('Path=/');
  });

  it('includes HttpOnly by default', () => {
    const cookie = serializeCookie('name', 'value');
    expect(cookie).toContain('HttpOnly');
  });

  it('includes Secure by default', () => {
    const cookie = serializeCookie('name', 'value');
    expect(cookie).toContain('Secure');
  });

  it('includes SameSite=Lax by default', () => {
    const cookie = serializeCookie('name', 'value');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('can disable HttpOnly', () => {
    const cookie = serializeCookie('name', 'value', { httpOnly: false });
    expect(cookie).not.toContain('HttpOnly');
  });

  it('can set SameSite=Strict', () => {
    const cookie = serializeCookie('name', 'value', { sameSite: 'Strict' });
    expect(cookie).toContain('SameSite=Strict');
  });

  it('can set SameSite=None', () => {
    const cookie = serializeCookie('name', 'value', { sameSite: 'None' });
    expect(cookie).toContain('SameSite=None');
  });

  it('includes Max-Age and Expires when maxAgeSeconds is set', () => {
    const cookie = serializeCookie('name', 'value', { maxAgeSeconds: 3600 });
    expect(cookie).toContain('Max-Age=3600');
    expect(cookie).toContain('Expires=');
  });

  it('handles zero Max-Age (for deletion)', () => {
    const cookie = serializeCookie('name', 'value', { maxAgeSeconds: 0 });
    expect(cookie).toContain('Max-Age=0');
  });

  it('includes Domain when specified', () => {
    const cookie = serializeCookie('name', 'value', { domain: 'example.com' });
    expect(cookie).toContain('Domain=example.com');
  });

  it('uses custom path', () => {
    const cookie = serializeCookie('name', 'value', { path: '/api' });
    expect(cookie).toContain('Path=/api');
  });

  it('can disable Secure', () => {
    const cookie = serializeCookie('name', 'value', { secure: false });
    expect(cookie).not.toContain('Secure');
  });

  it('throws on invalid cookie name', () => {
    expect(() => serializeCookie('invalid name', 'value')).toThrow();
    expect(() => serializeCookie('invalid;name', 'value')).toThrow();
    expect(() => serializeCookie('invalid=name', 'value')).toThrow();
    expect(() => serializeCookie('', 'value')).toThrow();
  });

  it('throws on invalid cookie value', () => {
    expect(() => serializeCookie('name', 'invalid;value')).toThrow();
    expect(() => serializeCookie('name', 'invalid"value')).toThrow();
    expect(() => serializeCookie('name', 'invalid,value')).toThrow();
    expect(() => serializeCookie('name', 'invalid\x00value')).toThrow();
  });

  it('accepts valid complex name', () => {
    const cookie = serializeCookie('hq-auth.0', 'token123');
    expect(cookie).toContain('hq-auth.0=token123');
  });

  it('accepts empty value', () => {
    // This is allowed but unusual
    const cookie = serializeCookie('name', '');
    expect(cookie).toContain('name=');
  });
});

describe('clearCookie', () => {
  it('sets Max-Age=0', () => {
    const cookie = clearCookie('name');
    expect(cookie).toContain('Max-Age=0');
  });

  it('preserves path option', () => {
    const cookie = clearCookie('name', { path: '/api' });
    expect(cookie).toContain('Path=/api');
  });

  it('preserves domain option', () => {
    const cookie = clearCookie('name', { domain: 'example.com' });
    expect(cookie).toContain('Domain=example.com');
  });
});

describe('parseCookies', () => {
  it('parses single cookie', () => {
    const cookies = parseCookies('name=value');
    expect(cookies.get('name')).toBe('value');
  });

  it('parses multiple cookies', () => {
    const cookies = parseCookies('a=1; b=2; c=3');
    expect(cookies.get('a')).toBe('1');
    expect(cookies.get('b')).toBe('2');
    expect(cookies.get('c')).toBe('3');
  });

  it('handles cookies with extra spaces', () => {
    const cookies = parseCookies('  name  =  value  ;  other  =  stuff  ');
    expect(cookies.get('name')).toBe('value');
    expect(cookies.get('other')).toBe('stuff');
  });

  it('handles cookies with = in value', () => {
    const cookies = parseCookies('token=abc=def=ghi');
    expect(cookies.get('token')).toBe('abc=def=ghi');
  });

  it('first occurrence wins (security: prevents session fixation)', () => {
    const cookies = parseCookies('session=real; session=fake');
    expect(cookies.get('session')).toBe('real');
    expect(cookies.size).toBe(1);
  });

  it('returns empty map for null input', () => {
    const cookies = parseCookies(null);
    expect(cookies.size).toBe(0);
  });

  it('returns empty map for empty string', () => {
    const cookies = parseCookies('');
    expect(cookies.size).toBe(0);
  });

  it('skips invalid cookie names', () => {
    const cookies = parseCookies('valid=yes; =noname; also=valid');
    expect(cookies.has('')).toBe(false);
    expect(cookies.get('valid')).toBe('yes');
    expect(cookies.get('also')).toBe('valid');
  });

  it('skips segments without =', () => {
    const cookies = parseCookies('name=value; garbage; other=stuff');
    expect(cookies.get('name')).toBe('value');
    expect(cookies.get('other')).toBe('stuff');
    expect(cookies.has('garbage')).toBe(false);
  });

  it('rejects very long header (DoS protection)', () => {
    const longHeader = 'name=' + 'a'.repeat(10000);
    const cookies = parseCookies(longHeader);
    expect(cookies.size).toBe(0);
  });

  it('handles base64url-style values', () => {
    const cookies = parseCookies('token=eyJhbGciOiJIUzI1NiJ9.payload.signature');
    expect(cookies.get('token')).toBe('eyJhbGciOiJIUzI1NiJ9.payload.signature');
  });

  it('handles chunked session cookies', () => {
    const cookies = parseCookies('hq-auth.0=chunk0; hq-auth.1=chunk1; hq-auth.2=chunk2');
    expect(cookies.get('hq-auth.0')).toBe('chunk0');
    expect(cookies.get('hq-auth.1')).toBe('chunk1');
    expect(cookies.get('hq-auth.2')).toBe('chunk2');
  });
});
