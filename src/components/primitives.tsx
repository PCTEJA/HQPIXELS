/**
 * Accessible primitives.
 *
 * Hand-built rather than pulled from a component library, because the
 * requirement is "do not ship inaccessible component defaults" and the only way
 * to be sure is to own the markup. Each one carries the specific accessibility
 * detail it exists to get right.
 */

import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { useEscapeKey, useFocusTrap } from '../lib/hooks';

// -----------------------------------------------------------------------------
// Button
// -----------------------------------------------------------------------------

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'cta' | 'primary' | 'ghost' | 'danger';
  readonly loading?: boolean;
  readonly loadingLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', loading = false, loadingLabel = 'Working', children, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      // `aria-busy` tells assistive tech the control is working; `disabled`
      // during load prevents the double-submit that creates duplicate charges.
      aria-busy={loading || undefined}
      disabled={rest.disabled === true || loading}
      className={['btn', `btn-${variant}`, className].filter(Boolean).join(' ')}
      {...rest}
    >
      {loading && <Spinner />}
      {loading ? loadingLabel : children}
    </button>
  );
});

function Spinner(): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// Text field
// -----------------------------------------------------------------------------

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly counter?: { current: number; max: number };
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, counter, className, ...rest },
  ref,
) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // Both hint and error are referenced when both exist, so a screen reader hears
  // the requirement and the failure rather than only one of them.
  const describedBy = [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <label htmlFor={id} className="field-label">
        {label}
        {rest.required === true && (
          <>
            {' '}
            <span className="text-danger" aria-hidden="true">
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        )}
      </label>

      <input
        ref={ref}
        id={id}
        className="field-input"
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        {...rest}
      />

      <div className="flex items-baseline justify-between gap-3">
        <div>
          {hint !== undefined && error === undefined && (
            <span id={hintId} className="field-hint">
              {hint}
            </span>
          )}
          {error !== undefined && (
            // role=alert so the failure is announced when it appears, not only
            // when focus reaches the field.
            <span id={errorId} role="alert" className="field-error">
              {error}
            </span>
          )}
        </div>
        {counter !== undefined && (
          <span
            className={[
              'mt-1.5 shrink-0 text-xs tabular',
              counter.current > counter.max ? 'text-danger' : 'text-ink-subtle',
            ].join(' ')}
          >
            {counter.current}/{counter.max}
          </span>
        )}
      </div>
    </div>
  );
});

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly counter?: { current: number; max: number };
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, counter, className, ...rest },
  ref,
) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <textarea
        ref={ref}
        id={id}
        className="field-input min-h-24 resize-y"
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        {...rest}
      />
      <div className="flex items-baseline justify-between gap-3">
        <div>
          {hint !== undefined && error === undefined && (
            <span id={hintId} className="field-hint">
              {hint}
            </span>
          )}
          {error !== undefined && (
            <span id={errorId} role="alert" className="field-error">
              {error}
            </span>
          )}
        </div>
        {counter !== undefined && (
          <span
            className={[
              'mt-1.5 shrink-0 text-xs tabular',
              counter.current > counter.max ? 'text-danger' : 'text-ink-subtle',
            ].join(' ')}
          >
            {counter.current}/{counter.max}
          </span>
        )}
      </div>
    </div>
  );
});

// -----------------------------------------------------------------------------
// Checkbox
// -----------------------------------------------------------------------------

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  readonly label: ReactNode;
  readonly error?: string | undefined;
}

/**
 * Checkbox.
 *
 * Note there is no `defaultChecked` support and no default value: consent
 * controls must start unchecked, and the server independently requires a literal
 * `true`, so a pre-checked box could not produce a valid request anyway.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, error, className, ...rest },
  ref,
) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className={className}>
      <div className="flex items-start gap-3">
        <input
          ref={ref}
          id={id}
          type="checkbox"
          className="checkbox"
          aria-invalid={error !== undefined || undefined}
          aria-describedby={error !== undefined ? errorId : undefined}
          {...rest}
        />
        <label htmlFor={id} className="cursor-pointer text-sm leading-relaxed text-ink-muted">
          {label}
        </label>
      </div>
      {error !== undefined && (
        <span id={errorId} role="alert" className="field-error ml-8">
          {error}
        </span>
      )}
    </div>
  );
});

// -----------------------------------------------------------------------------
// Dialog
// -----------------------------------------------------------------------------

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly maxWidth?: 'sm' | 'md' | 'lg';
}

/**
 * Modal dialog.
 *
 * Gets the four things a hand-rolled modal usually misses: focus is trapped
 * inside, focus returns to the trigger on close, Escape closes it, and the
 * backdrop click target does not swallow keyboard events.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  maxWidth = 'md',
}: DialogProps): React.JSX.Element | null {
  const trapRef = useFocusTrap(open);
  const titleId = useId();
  const descriptionId = useId();

  useEscapeKey(open, onClose);

  if (!open) return null;

  const widthClass = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' }[maxWidth];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      {/* Backdrop. A div, not a button: a full-screen button is announced as an
          enormous interactive element. Escape and the explicit close button are
          the keyboard paths. */}
      <div
        className="absolute inset-0 bg-obsidian/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description !== undefined ? descriptionId : undefined}
        className={`glass-raised relative z-10 w-full ${widthClass} max-h-[90dvh] overflow-y-auto rounded-t-2xl p-6 sm:rounded-card`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
            {description !== undefined && (
              <p id={descriptionId} className="mt-1 text-sm text-ink-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 -mt-2 rounded-control p-2 text-ink-muted hover:bg-surface hover:text-ink"
          >
            <span className="sr-only">Close</span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3 3l10 10M13 3L3 13"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Feedback
// -----------------------------------------------------------------------------

export interface AlertProps {
  readonly tone: 'info' | 'success' | 'warning' | 'danger';
  readonly title?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Alert({ tone, title, children, className }: AlertProps): React.JSX.Element {
  const styles = {
    info: 'border-cyan/35 bg-cyan/8 text-ink',
    success: 'border-success/35 bg-success/8 text-ink',
    warning: 'border-warning/35 bg-warning/8 text-ink',
    danger: 'border-danger/40 bg-danger/8 text-ink',
  }[tone];

  return (
    <div
      // An error is announced immediately; informational content is not, so it
      // does not interrupt whatever the user is doing.
      role={tone === 'danger' ? 'alert' : 'status'}
      className={['rounded-card border px-4 py-3 text-sm', styles, className]
        .filter(Boolean)
        .join(' ')}
    >
      {title !== undefined && <p className="font-semibold">{title}</p>}
      <div className={title !== undefined ? 'mt-1 text-ink-muted' : 'text-ink-muted'}>
        {children}
      </div>
    </div>
  );
}

/** Visually hidden live region. Mount once per surface that announces changes. */
export function LiveRegion({
  message,
  assertive = false,
}: {
  message: string;
  assertive?: boolean;
}): React.JSX.Element {
  return (
    <div
      className="live-region"
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      {message}
    </div>
  );
}

/**
 * Honest empty state.
 *
 * Exists as a component so that "no data yet" is always rendered as an explicit
 * statement rather than being filled with demo content.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="glass flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p className="text-[0.9375rem] font-semibold text-ink">{title}</p>
      {children !== undefined && <p className="max-w-md text-sm text-ink-muted">{children}</p>}
      {action}
    </div>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: 'verified' | 'founding' | 'sponsored' | 'pending';
  children: ReactNode;
}): React.JSX.Element {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
