/**
 * Design-token accessibility gate.
 *
 * The brief specifies a starting palette and says to "test and adjust all pairs
 * to meet WCAG AA". This is that test. Every foreground/background combination
 * the interface uses is enumerated in src/lib/tokens.ts and checked here, so a
 * colour change that breaks contrast fails CI rather than shipping.
 */

import { describe, expect, it } from 'vitest';
import {
  CANVAS_COLORS,
  NON_TEXT_PAIRINGS,
  TEXT_PAIRINGS,
  TOKENS,
  WCAG_AA_NON_TEXT,
  contrastRatio,
  hexToRgb,
  relativeLuminance,
} from '../../src/lib/tokens';

describe('contrast maths', () => {
  it('matches the WCAG reference values', () => {
    // Known-good anchors: black on white is exactly 21:1, and identical colours
    // are exactly 1:1. If these drift, the implementation is wrong.
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 1);
  });

  it('is symmetric', () => {
    expect(contrastRatio(TOKENS.ink, TOKENS.obsidian)).toBeCloseTo(
      contrastRatio(TOKENS.obsidian, TOKENS.ink),
      10,
    );
  });

  it('parses three- and six-digit hex', () => {
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('#070A0F')).toEqual({ r: 7, g: 10, b: 15 });
  });

  it('rejects a malformed colour instead of silently returning black', () => {
    expect(() => hexToRgb('not-a-colour')).toThrow();
    expect(() => hexToRgb('#12345')).toThrow();
  });

  it('treats the obsidian ground as near-black but not pure black', () => {
    // The brief asks for "deep obsidian/graphite, not flat pure black".
    const luminance = relativeLuminance(TOKENS.obsidian);
    expect(luminance).toBeGreaterThan(0);
    expect(luminance).toBeLessThan(0.01);
    expect(TOKENS.obsidian.toUpperCase()).not.toBe('#000000');
  });
});

describe('WCAG AA text contrast', () => {
  for (const pairing of TEXT_PAIRINGS) {
    it(`${pairing.label} meets ${pairing.minRatio}:1`, () => {
      const ratio = contrastRatio(pairing.fg, pairing.bg);
      expect(
        ratio,
        `${pairing.label} is ${ratio.toFixed(2)}:1, needs ${pairing.minRatio}:1`,
      ).toBeGreaterThanOrEqual(pairing.minRatio);
    });
  }
});

describe('WCAG AA non-text contrast', () => {
  for (const pairing of NON_TEXT_PAIRINGS) {
    it(`${pairing.label} meets ${WCAG_AA_NON_TEXT}:1`, () => {
      const ratio = contrastRatio(pairing.fg, pairing.bg);
      expect(
        ratio,
        `${pairing.label} is ${ratio.toFixed(2)}:1, needs ${WCAG_AA_NON_TEXT}:1`,
      ).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
    });
  }
});

describe('brand constraints', () => {
  it('does not use purple as an accent', () => {
    // The brief is explicit: the logo has a cool cast, but the interface must not
    // inherit a purple tint. Purple here means blue and red both dominating green
    // at real saturation.
    const accents = [TOKENS.cyan, TOKENS.cta, TOKENS.success, TOKENS.danger, TOKENS.warning];

    for (const accent of accents) {
      const { r, g, b } = hexToRgb(accent);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;

      if (saturation < 0.2) continue;

      const isPurple = b > g + 30 && r > g + 30;
      expect(isPurple, `${accent} reads as purple/magenta`).toBe(false);
    }
  });

  it('keeps the purchase accent and the interaction accent distinguishable', () => {
    // Amber (buy) and cyan (interact) carry different meanings, so they must be
    // told apart at a glance.
    //
    // NOT by contrast ratio: they sit at deliberately similar luminance so
    // neither dominates the page, and comparing two accents to each other is the
    // wrong test anyway — they are never placed on top of one another. What
    // matters is that they are opposed in HUE.
    expect(TOKENS.cta).not.toBe(TOKENS.cyan);

    const amber = hexToRgb(TOKENS.cta);
    const cyan = hexToRgb(TOKENS.cyan);

    // Amber is red-dominant and blue-poor; cyan is the reverse. That opposition
    // survives the common forms of colour vision deficiency far better than a
    // lightness difference would.
    expect(amber.r).toBeGreaterThan(amber.b);
    expect(cyan.b).toBeGreaterThan(cyan.r);
    expect(amber.r - amber.b).toBeGreaterThan(80);
    expect(cyan.b - cyan.r).toBeGreaterThan(80);
  });

  it('gives interactive control borders more contrast than decorative rules', () => {
    // The distinction that the failing test above surfaced: a divider may be
    // subtle, the edge of a form field may not.
    const controlOnInput = contrastRatio(TOKENS.controlBorder, TOKENS.surfaceSunken);
    const dividerOnInput = contrastRatio(TOKENS.hairlineBright, TOKENS.surfaceSunken);

    expect(controlOnInput).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
    expect(controlOnInput).toBeGreaterThan(dividerOnInput);
  });

  it('keeps the canvas grid line subtle enough to read as texture', () => {
    // Grid lines are decoration, not data. Much above 2:1 against the ground and
    // they start to look like a table and fight the artwork.
    const ratio = contrastRatio(TOKENS.grid, TOKENS.obsidian);
    expect(ratio).toBeGreaterThan(1.05);
    expect(ratio).toBeLessThan(2.2);
  });

  it('keeps the canvas palette in step with the CSS tokens', () => {
    const toInt = (hex: string): number => Number.parseInt(hex.replace('#', ''), 16);
    expect(CANVAS_COLORS.background).toBe(toInt(TOKENS.obsidian));
    expect(CANVAS_COLORS.gridLine).toBe(toInt(TOKENS.grid));
    expect(CANVAS_COLORS.selectionValid).toBe(toInt(TOKENS.cyan));
    expect(CANVAS_COLORS.selectionInvalid).toBe(toInt(TOKENS.danger));
    expect(CANVAS_COLORS.highlight).toBe(toInt(TOKENS.cta));
  });
});
