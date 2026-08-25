/**
 * Suspense fallback for lazy routes.
 *
 * `role="status"` with a text label rather than a bare spinner: a spinner with no
 * accessible name is silence for a screen-reader user waiting on a chunk to load.
 * The delay before it appears avoids a flash for fast connections.
 */
export function PageSpinner(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[50vh] flex-col items-center justify-center gap-3"
    >
      <div
        aria-hidden="true"
        className="grid h-10 w-10 grid-cols-3 grid-rows-3 gap-[3px] opacity-70"
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => (
          <span
            key={index}
            className="animate-pulse-ring rounded-[1px] bg-cyan"
            // A staggered delay reads as a loading lattice rather than nine
            // squares blinking in unison.
            style={{ animationDelay: `${index * 90}ms` }}
          />
        ))}
      </div>
      <p className="text-sm text-ink-subtle">Loading…</p>
    </div>
  );
}
