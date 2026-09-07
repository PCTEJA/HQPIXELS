/**
 * Small shared hooks.
 *
 * Each one exists because the naive version has a bug that matters:
 *   * useReducedMotion — must react to a change, not read once at mount.
 *   * useDocumentVisible — the wall must stop polling in a hidden tab.
 *   * useMediaQuery — SSR-safe and listener-cleaned.
 *   * useCountdown — must not tick when the tab is hidden or after expiry.
 *   * useAnnouncer — screen-reader announcements need a re-render to fire.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { secondsUntil } from './format';

/**
 * `prefers-reduced-motion`.
 *
 * Subscribes to changes: someone who turns the setting on mid-session should get
 * a still interface immediately, without reloading.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** True when the tab is visible. Gates all polling. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState<boolean>(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = (): void => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}

/**
 * Live countdown to an ISO timestamp.
 *
 * Ticks once a second while visible, pauses when hidden (a background tab
 * burning a timer for nothing is a real battery cost on mobile), and
 * recalculates from the wall clock on becoming visible again so it never drifts.
 */
export function useCountdown(expiresAt: string | null): {
  secondsRemaining: number;
  expired: boolean;
} {
  const visible = useDocumentVisible();
  const [countdown, setCountdown] = useState(() => ({
    expiresAt,
    secondsRemaining: expiresAt === null ? 0 : secondsUntil(expiresAt),
  }));
  // A newly fetched expiry must not inherit the previous (often zero) count
  // for one render: consumers may release the hold when `expired` is true.
  const secondsRemaining =
    countdown.expiresAt === expiresAt
      ? countdown.secondsRemaining
      : expiresAt === null
        ? 0
        : secondsUntil(expiresAt);

  useEffect(() => {
    if (expiresAt === null) {
      setCountdown({ expiresAt, secondsRemaining: 0 });
      return;
    }

    // Recompute from the clock rather than decrementing, so a paused tab or a
    // sleeping laptop does not leave the timer showing a stale value.
    const tick = (): void => setCountdown({ expiresAt, secondsRemaining: secondsUntil(expiresAt) });
    tick();

    if (!visible) return;

    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [expiresAt, visible]);

  return { secondsRemaining, expired: expiresAt !== null && secondsRemaining <= 0 };
}

/**
 * Screen-reader announcements.
 *
 * A live region only fires when its text CHANGES, so announcing the same message
 * twice needs a nonce. Without that, "3 units selected" announced twice in a row
 * is silent the second time, which is exactly when the user needs it.
 */
export function useAnnouncer(): {
  message: string;
  announce: (text: string) => void;
} {
  const [state, setState] = useState({ text: '', nonce: 0 });

  const announce = useCallback((text: string) => {
    setState((prev) => ({ text, nonce: prev.nonce + 1 }));
  }, []);

  // A zero-width space, appended in alternating count, turns two consecutive
  // identical announcements into distinct strings so the live region fires
  // again. Written as a codepoint constant rather than a literal character:
  // an invisible character in source is one stray formatter away from
  // silently breaking re-announcement.
  const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
  const message = state.text === '' ? '' : state.text + ZERO_WIDTH_SPACE.repeat(state.nonce % 2);

  return { message, announce };
}

/** Debounce a rapidly changing value (selection size, search input). */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/**
 * Element size, via ResizeObserver.
 *
 * The canvas needs its container's real pixel size, and reading offsetWidth on
 * every render would thrash layout.
 */
export function useElementSize<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  width: number;
  height: number;
} {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      // Round to whole pixels: a fractional canvas size causes blurry rendering.
      setSize({ width: Math.round(width), height: Math.round(height) });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width: size.width, height: size.height };
}

/**
 * Trap focus inside a container while it is active.
 *
 * Required for the purchase dialog: a keyboard user must not be able to tab out
 * of a modal into the page behind it.
 */
export function useFocusTrap(active: boolean): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active || ref.current === null) return;

    const container = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);

    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Return focus where it was, or the user loses their place entirely.
      previouslyFocused?.focus();
    };
  }, [active]);

  return ref;
}

/** Calls `onEscape` while active. Every dismissible surface uses it. */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onEscape();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, onEscape]);
}
