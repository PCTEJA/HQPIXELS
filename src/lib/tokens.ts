/**
 * Design tokens, mirrored in TypeScript.
 *
 * `src/index.css` is the runtime source of truth (CSS custom properties). This
 * file exists so that:
 *
 *   1. the canvas renderer, which cannot read CSS variables efficiently per
 *      frame, has the same colours as numbers, and
 *   2. `tests/unit/design-tokens.test.ts` can assert that every text pairing
 *      meets WCAG AA — a contrast regression fails CI instead of shipping.
 *
 * If you change a colour, change it in BOTH places and run the test.
 */

export const TOKENS = {
  obsidian: '#070A0F',
  surface: '#101720',
  surfaceRaised: '#17202C',
  surfaceSunken: '#0A0F16',

  ink: '#EAF7FF',
  inkMuted: '#9FB3C8',
  inkSubtle: '#7D93A8',

  cyan: '#28D7F4',
  cyanDim: '#1AA8C0',
  cta: '#FFC857',
  ctaHover: '#FFD47A',
  success: '#77E6C5',
  danger: '#FF6B6B',
  warning: '#FFB454',

  /** Decorative dividers. No contrast requirement — these separate, they do not inform. */
  hairline: '#1E2936',
  hairlineBright: '#2C3D4F',
  /**
   * The visible boundary of an interactive control (text input, checkbox).
   *
   * WCAG 1.4.11 requires 3:1 against the adjacent background for this, and the
   * decorative `hairlineBright` only manages 1.73:1 on the sunken input ground —
   * which in practice means a form field whose edges you cannot find. This token
   * exists specifically to clear that bar, and the test below pins it.
   */
  controlBorder: '#566A7C',
  grid: '#131C26',
} as const;

export type TokenName = keyof typeof TOKENS;

/** 0xRRGGBB integers, which is what PixiJS wants. */
export const CANVAS_COLORS = {
  background: 0x070a0f,
  /** An unclaimed cell. Barely there — the wall should look mostly empty at the start. */
  cellEmpty: 0x0d141d,
  /** A claimed cell before its artwork loads at this zoom level. */
  cellClaimed: 0x1e2936,
  gridLine: 0x131c26,
  gridLineMajor: 0x1e2936,
  /** Live selection while dragging. */
  selectionValid: 0x28d7f4,
  /** Selection overlapping something already claimed. */
  selectionInvalid: 0xff6b6b,
  /** Hover/focus highlight on an existing placement. */
  highlight: 0xffc857,
  focusRing: 0x28d7f4,
} as const;

// -----------------------------------------------------------------------------
// Contrast maths (WCAG 2.1)
// -----------------------------------------------------------------------------

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : clean;

  if (full.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex colour: ${hex}`);
  }

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** WCAG relative luminance. The sRGB companding step is the part people skip. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);

  const channel = (value: number): number => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio, 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

export const WCAG_AA_NORMAL = 4.5;
export const WCAG_AA_LARGE = 3;
export const WCAG_AA_NON_TEXT = 3;

/**
 * The pairings the interface actually uses.
 *
 * Enumerated explicitly rather than generated, because the test needs to know
 * which combinations are real. A pairing that is not in this list is not allowed
 * in the UI.
 */
export const TEXT_PAIRINGS: ReadonlyArray<{
  readonly label: string;
  readonly fg: string;
  readonly bg: string;
  readonly minRatio: number;
}> = [
  // Body text
  { label: 'ink on obsidian', fg: TOKENS.ink, bg: TOKENS.obsidian, minRatio: WCAG_AA_NORMAL },
  { label: 'ink on surface', fg: TOKENS.ink, bg: TOKENS.surface, minRatio: WCAG_AA_NORMAL },
  {
    label: 'ink on surfaceRaised',
    fg: TOKENS.ink,
    bg: TOKENS.surfaceRaised,
    minRatio: WCAG_AA_NORMAL,
  },

  // Secondary text
  {
    label: 'inkMuted on obsidian',
    fg: TOKENS.inkMuted,
    bg: TOKENS.obsidian,
    minRatio: WCAG_AA_NORMAL,
  },
  {
    label: 'inkMuted on surface',
    fg: TOKENS.inkMuted,
    bg: TOKENS.surface,
    minRatio: WCAG_AA_NORMAL,
  },
  {
    label: 'inkSubtle on obsidian',
    fg: TOKENS.inkSubtle,
    bg: TOKENS.obsidian,
    minRatio: WCAG_AA_NORMAL,
  },
  {
    label: 'inkSubtle on surface',
    fg: TOKENS.inkSubtle,
    bg: TOKENS.surface,
    minRatio: WCAG_AA_NORMAL,
  },
  {
    label: 'inkSubtle on surfaceSunken',
    fg: TOKENS.inkSubtle,
    bg: TOKENS.surfaceSunken,
    minRatio: WCAG_AA_NORMAL,
  },

  // Links and interactive text
  { label: 'cyan on obsidian', fg: TOKENS.cyan, bg: TOKENS.obsidian, minRatio: WCAG_AA_NORMAL },
  { label: 'cyan on surface', fg: TOKENS.cyan, bg: TOKENS.surface, minRatio: WCAG_AA_NORMAL },
  {
    label: 'cyan on surfaceRaised',
    fg: TOKENS.cyan,
    bg: TOKENS.surfaceRaised,
    minRatio: WCAG_AA_NORMAL,
  },

  // The purchase button: dark text on amber.
  { label: 'obsidian on cta', fg: TOKENS.obsidian, bg: TOKENS.cta, minRatio: WCAG_AA_NORMAL },
  {
    label: 'obsidian on ctaHover',
    fg: TOKENS.obsidian,
    bg: TOKENS.ctaHover,
    minRatio: WCAG_AA_NORMAL,
  },

  // Status text
  {
    label: 'success on obsidian',
    fg: TOKENS.success,
    bg: TOKENS.obsidian,
    minRatio: WCAG_AA_NORMAL,
  },
  { label: 'success on surface', fg: TOKENS.success, bg: TOKENS.surface, minRatio: WCAG_AA_NORMAL },
  { label: 'danger on obsidian', fg: TOKENS.danger, bg: TOKENS.obsidian, minRatio: WCAG_AA_NORMAL },
  { label: 'danger on surface', fg: TOKENS.danger, bg: TOKENS.surface, minRatio: WCAG_AA_NORMAL },
  {
    label: 'warning on obsidian',
    fg: TOKENS.warning,
    bg: TOKENS.obsidian,
    minRatio: WCAG_AA_NORMAL,
  },
  { label: 'warning on surface', fg: TOKENS.warning, bg: TOKENS.surface, minRatio: WCAG_AA_NORMAL },

  // Amber as text (badges, price emphasis) on dark grounds.
  { label: 'cta on obsidian', fg: TOKENS.cta, bg: TOKENS.obsidian, minRatio: WCAG_AA_NORMAL },
  { label: 'cta on surface', fg: TOKENS.cta, bg: TOKENS.surface, minRatio: WCAG_AA_NORMAL },
];

/**
 * Non-text pairings: focus rings and control borders. WCAG requires 3:1 for
 * these, and they are the difference between a usable and an unusable keyboard
 * experience.
 */
export const NON_TEXT_PAIRINGS: ReadonlyArray<{
  readonly label: string;
  readonly fg: string;
  readonly bg: string;
}> = [
  { label: 'focus ring on obsidian', fg: TOKENS.cyan, bg: TOKENS.obsidian },
  { label: 'focus ring on surface', fg: TOKENS.cyan, bg: TOKENS.surface },
  { label: 'focus ring on surfaceRaised', fg: TOKENS.cyan, bg: TOKENS.surfaceRaised },
  { label: 'control border on surfaceSunken', fg: TOKENS.controlBorder, bg: TOKENS.surfaceSunken },
  { label: 'control border on surface', fg: TOKENS.controlBorder, bg: TOKENS.surface },
  { label: 'control border on obsidian', fg: TOKENS.controlBorder, bg: TOKENS.obsidian },
  { label: 'selection outline on obsidian', fg: TOKENS.cyan, bg: TOKENS.obsidian },
  { label: 'invalid selection on obsidian', fg: TOKENS.danger, bg: TOKENS.obsidian },
];
