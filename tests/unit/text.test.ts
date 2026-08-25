/**
 * Unit tests for shared/text.ts.
 *
 * Text handling is about preventing:
 * - Bidi spoofing (right-to-left override)
 * - Invisible character padding
 * - Log injection via newlines
 * - Unicode confusion attacks
 */

import { describe, expect, it } from 'vitest';
import {
  codepointLength,
  hasMeaningfulContent,
  normalizeHandle,
  normalizeSingleLine,
  RESERVED_HANDLES,
  sanitizeForLog,
  truncateForDisplay,
} from '@shared/text';

describe('normalizeSingleLine', () => {
  it('trims whitespace', () => {
    expect(normalizeSingleLine('  hello  ', 100)).toBe('hello');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeSingleLine('hello    world', 100)).toBe('hello world');
  });

  it('converts tabs to spaces', () => {
    expect(normalizeSingleLine('hello\tworld', 100)).toBe('hello world');
  });

  it('strips control characters', () => {
    expect(normalizeSingleLine('hello\x00world', 100)).toBe('helloworld');
    expect(normalizeSingleLine('hello\x1fworld', 100)).toBe('helloworld');
  });

  it('strips zero-width characters', () => {
    expect(normalizeSingleLine('hello' + String.fromCharCode(0x200b) + 'world', 100)).toBe(
      'helloworld',
    );
  });

  it('strips bidi override characters', () => {
    expect(normalizeSingleLine('hello' + String.fromCharCode(0x202e) + 'world', 100)).toBe(
      'helloworld',
    );
  });

  it('applies NFKC normalization', () => {
    // Fullwidth 'Ａ' becomes 'A'
    expect(normalizeSingleLine('\uff21\uff22\uff23', 100)).toBe('ABC');
  });

  it('truncates by codepoint, not UTF-16 units', () => {
    // Emoji is one codepoint but two UTF-16 units
    const emoji = '😀';
    expect(normalizeSingleLine(emoji.repeat(5), 3)).toBe('😀😀😀');
  });

  it('does not split surrogate pairs', () => {
    const text = '😀😀😀😀😀';
    const result = normalizeSingleLine(text, 3);
    // Should not have lone surrogates
    expect(result).toBe('😀😀😀');
    expect([...result].length).toBe(3);
  });

  it('handles empty input', () => {
    expect(normalizeSingleLine('', 100)).toBe('');
  });

  it('handles non-string input', () => {
    expect(normalizeSingleLine(null as unknown as string, 100)).toBe('');
    expect(normalizeSingleLine(undefined as unknown as string, 100)).toBe('');
  });

  it('preserves legitimate Unicode', () => {
    expect(normalizeSingleLine('日本語テキスト', 100)).toBe('日本語テキスト');
    expect(normalizeSingleLine('Привет мир', 100)).toBe('Привет мир');
  });

  it('converts Unicode whitespace to regular space', () => {
    // Non-breaking space
    expect(normalizeSingleLine('hello\u00a0world', 100)).toBe('hello world');
    // Ideographic space
    expect(normalizeSingleLine('hello\u3000world', 100)).toBe('hello world');
  });
});

describe('codepointLength', () => {
  it('returns correct length for ASCII', () => {
    expect(codepointLength('hello')).toBe(5);
  });

  it('counts emoji as one codepoint', () => {
    expect(codepointLength('😀')).toBe(1);
    expect(codepointLength('😀😀😀')).toBe(3);
  });

  it('counts combining characters separately', () => {
    // This depends on the actual combining behavior
    expect(codepointLength('é')).toBe(1); // precomposed
  });

  it('handles empty string', () => {
    expect(codepointLength('')).toBe(0);
  });

  it('handles mixed content', () => {
    expect(codepointLength('Hello 😀 World')).toBe(13);
  });
});

describe('hasMeaningfulContent', () => {
  it('returns true for normal text', () => {
    expect(hasMeaningfulContent('Hello World')).toBe(true);
  });

  it('returns true for text with numbers', () => {
    expect(hasMeaningfulContent('Item 123')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(hasMeaningfulContent('')).toBe(false);
  });

  it('returns false for whitespace only', () => {
    expect(hasMeaningfulContent('   ')).toBe(false);
  });

  it('returns false for punctuation only', () => {
    expect(hasMeaningfulContent('...')).toBe(false);
    expect(hasMeaningfulContent('!!!')).toBe(false);
    expect(hasMeaningfulContent('---')).toBe(false);
  });

  it('returns false for symbols only', () => {
    expect(hasMeaningfulContent('★★★')).toBe(false);
    expect(hasMeaningfulContent('→←↑↓')).toBe(false);
  });

  it('returns true for non-Latin scripts', () => {
    expect(hasMeaningfulContent('日本語')).toBe(true);
    expect(hasMeaningfulContent('العربية')).toBe(true);
    expect(hasMeaningfulContent('한국어')).toBe(true);
  });

  it('returns false for stripped invisible characters', () => {
    // Only zero-width characters
    expect(hasMeaningfulContent(String.fromCharCode(0x200b).repeat(10))).toBe(false);
  });
});

describe('sanitizeForLog', () => {
  it('returns empty string for null/undefined', () => {
    expect(sanitizeForLog(null)).toBe('');
    expect(sanitizeForLog(undefined)).toBe('');
  });

  it('passes through normal strings', () => {
    expect(sanitizeForLog('hello world')).toBe('hello world');
  });

  it('replaces control characters with space', () => {
    expect(sanitizeForLog('line1\nline2')).toBe('line1 line2');
    expect(sanitizeForLog('text\x00hidden')).toBe('text hidden');
  });

  it('truncates long strings', () => {
    const long = 'a'.repeat(300);
    const result = sanitizeForLog(long);
    expect(result.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(result.endsWith('...')).toBe(true);
  });

  it('respects custom maxLength', () => {
    const result = sanitizeForLog('hello world', 5);
    expect(result).toBe('hello...');
  });

  it('collapses multiple spaces', () => {
    expect(sanitizeForLog('hello    world')).toBe('hello world');
  });

  it('stringifies objects', () => {
    expect(sanitizeForLog({ key: 'value' })).toBe('{"key":"value"}');
  });

  it('applies NFKC normalization', () => {
    expect(sanitizeForLog('\uff21\uff22\uff23')).toBe('ABC');
  });

  it('prevents log injection', () => {
    // An attacker trying to inject a fake log line
    const malicious = 'normal log\n{"level":"error","message":"fake alert"}';
    const result = sanitizeForLog(malicious);
    expect(result).not.toContain('\n');
  });
});

describe('truncateForDisplay', () => {
  it('returns unchanged if within limit', () => {
    expect(truncateForDisplay('hello', 10)).toBe('hello');
  });

  it('truncates with ellipsis', () => {
    expect(truncateForDisplay('hello world', 8)).toBe('hello w…');
  });

  it('handles exact length', () => {
    expect(truncateForDisplay('hello', 5)).toBe('hello');
  });

  it('handles emoji safely', () => {
    const result = truncateForDisplay('😀😀😀😀😀', 3);
    expect(result).toBe('😀😀…');
  });

  it('handles very short limit', () => {
    // With maxLength=1, returns first char + ellipsis
    expect(truncateForDisplay('hello', 1)).toBe('h…');
  });
});

describe('normalizeHandle', () => {
  it('normalizes to lowercase', () => {
    expect(normalizeHandle('MyHandle')).toBe('myhandle');
  });

  it('rejects too-short handles', () => {
    expect(normalizeHandle('ab')).toBe(null);
  });

  it('rejects too-long handles', () => {
    expect(normalizeHandle('a'.repeat(32))).toBe(null);
  });

  it('accepts valid handles', () => {
    expect(normalizeHandle('valid-handle')).toBe('valid-handle');
    expect(normalizeHandle('user_123')).toBe('user_123');
    expect(normalizeHandle('abc')).toBe('abc');
  });

  it('rejects handles starting with number/symbol', () => {
    expect(normalizeHandle('_invalid')).toBe(null);
    expect(normalizeHandle('-invalid')).toBe(null);
  });

  it('rejects handles ending with symbol', () => {
    expect(normalizeHandle('invalid_')).toBe(null);
    expect(normalizeHandle('invalid-')).toBe(null);
  });

  it('rejects consecutive special characters', () => {
    expect(normalizeHandle('user--name')).toBe(null);
    expect(normalizeHandle('user__name')).toBe(null);
    expect(normalizeHandle('user-_name')).toBe(null);
  });

  it('rejects non-ASCII characters', () => {
    expect(normalizeHandle('üser')).toBe(null);
    expect(normalizeHandle('用户')).toBe(null);
  });

  it('trims whitespace before validation', () => {
    expect(normalizeHandle('  validhandle  ')).toBe('validhandle');
  });

  it('applies NFKC before validation', () => {
    // Fullwidth letters should normalize
    expect(normalizeHandle('\uff41\uff42\uff43')).toBe('abc');
  });
});

describe('RESERVED_HANDLES', () => {
  it('contains common reserved names', () => {
    expect(RESERVED_HANDLES.has('admin')).toBe(true);
    expect(RESERVED_HANDLES.has('support')).toBe(true);
    expect(RESERVED_HANDLES.has('help')).toBe(true);
    expect(RESERVED_HANDLES.has('security')).toBe(true);
    expect(RESERVED_HANDLES.has('root')).toBe(true);
  });

  it('contains product-specific reserved names', () => {
    expect(RESERVED_HANDLES.has('hqpixels')).toBe(true);
    expect(RESERVED_HANDLES.has('stripe')).toBe(true);
    expect(RESERVED_HANDLES.has('moderator')).toBe(true);
  });

  it('does not contain random strings', () => {
    expect(RESERVED_HANDLES.has('john')).toBe(false);
    expect(RESERVED_HANDLES.has('mycompany')).toBe(false);
  });
});
