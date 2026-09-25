/* Unified toast notification provider: every in-app notification (approval
   requests, credential expiry, uploads, version updates, …) renders through
   the same card so they share one stack, one look and one timing model. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./Toast.css";

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public API                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastAction {
  /** Visible label for the action button. */
  label: string;
  /** Click handler. The toast auto-dismisses after the handler runs unless
   *  it returns `false` (allowing the action to keep the toast visible
   *  while a long-running operation completes, for example). */
  onClick: () => boolean | void | Promise<boolean | void>;
}

/** One row of the monospace details box: `LABEL  value — meta`. */
export interface ToastDetail {
  label: string;
  value: string;
  meta?: string;
}

export interface ToastOptions {
  /** Short headline (bold). */
  title: string;
  /** Optional secondary body line. */
  description?: string;
  /** Visual variant. Defaults to `"info"`. */
  variant?: ToastVariant;
  /** Auto-dismiss after this many milliseconds. `0` or `null` keeps the
   *  toast visible until manually dismissed. Defaults to 6000 ms for info /
   *  success, 8000 ms for warning, and 0 (sticky) for error. */
  duration?: number | null;
  /** Optional primary action button. */
  action?: ToastAction;
  /** Stable identifier. When provided, a second toast with the same key
   *  replaces the existing one in-place (used by the credential-expiry
   *  watcher to update the same toast as the deadline approaches). */
  key?: string;
  /** Optional progress indicator rendered as a thin bar below the
   *  description. A number in `[0, 1]` shows determinate progress; the
   *  string `"indeterminate"` renders an animated sweep. */
  progress?: number | "indeterminate";
  /** Key/value rows rendered in the monospace details box. */
  details?: ToastDetail[];
  /** Replaces the variant's default icon glyph (SVG children, 24×24 box). */
  icon?: ReactNode;
  /** Interactive body rendered under the details (e.g. approve/deny
   *  controls). Toasts with content are announced as an alertdialog. */
  content?: ReactNode;
  /** Called once when the toast leaves the stack (any dismissal path). */
  onDismiss?: () => void;
}

interface ToastEntry {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  duration: number | null;
  action?: ToastAction;
  progress?: number | "indeterminate";
  details?: ToastDetail[];
  icon?: ReactNode;
  content?: ReactNode;
  onDismiss?: () => void;
  createdAt: number;
}

interface ToastApi {
  /** Show a toast. Returns a stable id you can pass to `dismiss()`. */
  show: (opts: ToastOptions) => string;
  /** Remove a toast by id (or no-op if it has already disappeared). */
  dismiss: (id: string) => void;
  /** Convenience wrappers — equivalent to `show({ variant, ...opts })`. */
  info: (opts: Omit<ToastOptions, "variant">) => string;
  success: (opts: Omit<ToastOptions, "variant">) => string;
  warning: (opts: Omit<ToastOptions, "variant">) => string;
  error: (opts: Omit<ToastOptions, "variant">) => string;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Hook used by any component to publish a toast. Throws when used outside
 *  the provider so missing wiring is caught early in tests. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}

/** Same as `useToast`, but returns `null` when no provider is mounted
 *  instead of throwing. Use this from providers/hooks that may legitimately
 *  be rendered in isolation. */
export function useOptionalToast(): ToastApi | null {
  return useContext(ToastContext);
}

const HoldContext = createContext<(key: string, held: boolean) => void>(() => {});

/** Pauses the enclosing toast's countdown while `held` is true — e.g. while
 *  the user is typing a deny reason inside `content`. */
export function useToastHold(held: boolean): void {
  const setHold = useContext(HoldContext);
  const key = useId();
  useEffect(() => {
    setHold(key, held);
    return () => setHold(key, false);
  }, [setHold, key, held]);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Provider                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const DEFAULT_DURATIONS: Record<ToastVariant, number | null> = {
  info: 6000,
  success: 6000,
  warning: 8000,
  error: null, // sticky — user must dismiss
};

/** Must match the `.toast-leaving` animation in Toast.css. */
const EXIT_MS = 150;

let toastCounter = 0;
function nextId(): string {
  toastCounter += 1;
  return `t${Date.now().toString(36)}${toastCounter.toString(36)}`;
}

export default function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const toastsRef = useRef<ToastEntry[]>([]);
  useEffect(() => {
    toastsRef.current = toasts;
  }, [toasts]);

  const dismiss = useCallback((id: string) => {
    const entry = toastsRef.current.find((t) => t.id === id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
    entry?.onDismiss?.();
  }, []);

  const show = useCallback((opts: ToastOptions): string => {
    const variant: ToastVariant = opts.variant ?? "info";
    const duration = opts.duration === undefined ? DEFAULT_DURATIONS[variant] : opts.duration;
    const id = opts.key ?? nextId();

    const entry: ToastEntry = {
      id,
      title: opts.title,
      description: opts.description,
      variant,
      duration,
      action: opts.action,
      progress: opts.progress,
      details: opts.details,
      icon: opts.icon,
      content: opts.content,
      onDismiss: opts.onDismiss,
      createdAt: Date.now(),
    };

    // Replace-by-key: overwrite in place so a watcher can update a single
    // "expires in 1h" toast without spawning duplicates.
    setToasts((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = entry;
        return next;
      }
      return [...prev, entry];
    });
    return id;
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      info: (opts) => show({ ...opts, variant: "info" }),
      success: (opts) => show({ ...opts, variant: "success" }),
      warning: (opts) => show({ ...opts, variant: "warning" }),
      error: (opts) => show({ ...opts, variant: "error" }),
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onRemove={dismiss} />
    </ToastContext.Provider>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Viewport (portal-mounted)                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

function ToastViewport({
  toasts,
  onRemove,
}: {
  toasts: ToastEntry[];
  onRemove: (id: string) => void;
}) {
  if (typeof document === "undefined") return null;
  if (toasts.length === 0) return null;

  return createPortal(
    <div
      // Top-right; the session-timeout warning owns bottom-right.
      className="toast-viewport"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onRemove={() => onRemove(t.id)} />
      ))}
    </div>,
    document.body
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Card                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

const VARIANT_ICONS: Record<ToastVariant, ReactNode> = {
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>
  ),
  success: (
    <>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </>
  ),
  warning: (
    <>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>
  ),
  error: (
    <>
      <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </>
  ),
};

function ToastCard({ toast, onRemove }: { toast: ToastEntry; onRemove: () => void }) {
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [holds, setHolds] = useState<Set<string>>(() => new Set());
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRemoveRef = useRef(onRemove);

  const setHold = useCallback((key: string, held: boolean) => {
    setHolds((prev) => {
      if (prev.has(key) === held) return prev;
      const next = new Set(prev);
      if (held) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const close = useCallback(() => {
    if (exitTimerRef.current !== null) return;
    setLeaving(true);
    exitTimerRef.current = setTimeout(() => onRemoveRef.current(), EXIT_MS);
  }, []);

  useEffect(() => {
    onRemoveRef.current = onRemove;
  }, [onRemove]);

  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) clearTimeout(exitTimerRef.current);
    },
    []
  );

  // Auto-dismiss that pauses on hover / focus / hold and resumes with the
  // remaining time. A replace-by-key update (new createdAt) restarts it.
  const timed = toast.duration !== null && toast.duration > 0;
  const paused = hovered || focused || busy || holds.size > 0;
  const remainingRef = useRef(toast.duration ?? 0);
  const cycleRef = useRef(toast.createdAt);
  // Layout effect so the timer is armed at commit, not whenever passive
  // effects happen to flush.
  useLayoutEffect(() => {
    if (!timed || paused || leaving) return;
    if (cycleRef.current !== toast.createdAt) {
      cycleRef.current = toast.createdAt;
      remainingRef.current = toast.duration ?? 0;
    }
    const startedAt = Date.now();
    const t = setTimeout(close, Math.max(0, remainingRef.current));
    return () => {
      clearTimeout(t);
      remainingRef.current -= Date.now() - startedAt;
    };
  }, [timed, paused, leaving, toast.createdAt, toast.duration, close]);

  const handleAction = useCallback(async () => {
    if (!toast.action || busy) return;
    setBusy(true);
    try {
      const keep = await toast.action.onClick();
      if (keep !== false) close();
    } finally {
      setBusy(false);
    }
  }, [toast.action, busy, close]);

  const isDialog = toast.content !== undefined;
  const role = isDialog
    ? "alertdialog"
    : toast.variant === "error" || toast.variant === "warning"
      ? "alert"
      : "status";

  return (
    <HoldContext.Provider value={setHold}>
      {/* Hover/focus handlers only pause the countdown; they add no interaction. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className={`toast-card toast-${toast.variant} ${leaving ? "toast-leaving" : ""}`}
        role={role}
        aria-label={isDialog ? toast.title : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
        }}
      >
        <div className="toast-strip" aria-hidden="true" />

        <div className="toast-body">
          <div className="toast-badge" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {toast.icon ?? VARIANT_ICONS[toast.variant]}
            </svg>
          </div>

          <div className="toast-content">
            <p className="toast-title">{toast.title}</p>
            {toast.description && <p className="toast-summary">{toast.description}</p>}

            {toast.details && toast.details.length > 0 && (
              <div className="toast-details">
                {toast.details.map((d) => (
                  <div key={`${d.label}:${d.value}`} className="toast-detail-row">
                    <span className="toast-detail-label">{d.label}</span>
                    <span className="toast-detail-text">
                      <span className="toast-detail-value">{d.value}</span>
                      {d.meta && <span className="toast-detail-meta"> — {d.meta}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {toast.progress !== undefined && <ToastProgressBar value={toast.progress} />}

            {toast.content}

            {toast.action && (
              <div className="toast-actions">
                <button
                  type="button"
                  onClick={handleAction}
                  disabled={busy}
                  className="toast-btn toast-btn-primary"
                >
                  {busy ? "Working…" : toast.action.label}
                </button>
                <button type="button" onClick={close} className="toast-btn">
                  Dismiss
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={close}
            className="toast-close"
            aria-label="Dismiss notification"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {timed && (
          <div className="toast-countdown" aria-hidden="true">
            <div
              key={toast.createdAt}
              className="toast-countdown-bar"
              style={
                {
                  "--toast-duration": `${toast.duration}ms`,
                  animationPlayState: paused || leaving ? "paused" : "running",
                } as CSSProperties
              }
            />
          </div>
        )}
      </div>
    </HoldContext.Provider>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Progress bar                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/** Determinate (clamped `[0, 1]`) or indeterminate sweep, in the toast's
 *  accent colour. */
function ToastProgressBar({ value }: { value: number | "indeterminate" }) {
  const isIndeterminate = value === "indeterminate";
  const pct = isIndeterminate ? 0 : Math.min(1, Math.max(0, value));
  const rounded = Math.round(pct * 100);

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={isIndeterminate ? undefined : rounded}
      aria-label={isIndeterminate ? "In progress" : `${rounded}% complete`}
      className="toast-progress"
    >
      {isIndeterminate ? (
        <div className="toast-progress-fill toast-progress-indeterminate" />
      ) : (
        <div className="toast-progress-fill" style={{ width: `${rounded}%` }} />
      )}
    </div>
  );
}
