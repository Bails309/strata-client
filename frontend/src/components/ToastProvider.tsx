/* Reusable toast notification provider with theme-aware variants. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

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
}

interface ToastEntry extends Required<Omit<ToastOptions, "description" | "action" | "duration">> {
  id: string;
  description?: string;
  action?: ToastAction;
  duration: number | null;
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
 *  be rendered in isolation (e.g. SessionManager unit tests that don't
 *  also mount ToastProvider). Production paths always have a provider
 *  in scope. */
export function useOptionalToast(): ToastApi | null {
  return useContext(ToastContext);
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

let toastCounter = 0;
function nextId(): string {
  toastCounter += 1;
  return `t${Date.now().toString(36)}${toastCounter.toString(36)}`;
}

export default function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const armAutoDismiss = useCallback(
    (id: string, duration: number | null) => {
      if (duration === null || duration <= 0) return;
      const timer = setTimeout(() => dismiss(id), duration);
      timersRef.current.set(id, timer);
    },
    [dismiss]
  );

  const show = useCallback(
    (opts: ToastOptions): string => {
      const variant: ToastVariant = opts.variant ?? "info";
      const duration = opts.duration === undefined ? DEFAULT_DURATIONS[variant] : opts.duration;
      const id = opts.key ?? nextId();

      // Replace-by-key semantics: cancel any existing timer for the same id
      // and overwrite the entry in place so the watcher can update a single
      // "expires in 1h" toast without spawning duplicates.
      const existingTimer = timersRef.current.get(id);
      if (existingTimer !== undefined) {
        clearTimeout(existingTimer);
        timersRef.current.delete(id);
      }

      const entry: ToastEntry = {
        id,
        title: opts.title,
        description: opts.description,
        variant,
        duration,
        action: opts.action,
        key: opts.key ?? id,
        createdAt: Date.now(),
      };

      setToasts((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = entry;
          return next;
        }
        return [...prev, entry];
      });

      armAutoDismiss(id, duration);
      return id;
    },
    [armAutoDismiss]
  );

  // Cancel every outstanding timer when the provider unmounts so tests
  // (and real logouts) don't leak setTimeout handles.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
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
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Viewport (portal-mounted)                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

interface ViewportProps {
  toasts: ToastEntry[];
  onDismiss: (id: string) => void;
}

function ToastViewport({ toasts, onDismiss }: ViewportProps) {
  // Render into document.body so the stack escapes any transformed /
  // overflow-hidden ancestors. SSR-safe guard for vitest jsdom + Vite SSR.
  if (typeof document === "undefined") return null;
  if (toasts.length === 0) return null;

  return createPortal(
    <div
      // Top-right corner. Below the SessionTimeoutWarning which lives at
      // bottom-right (z-9999) so the two never overlap visually.
      className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      style={{ maxWidth: "min(380px, calc(100vw - 2rem))" }}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>,
    document.body
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Card                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

const VARIANT_STYLES: Record<ToastVariant, { color: string; dim: string; iconPath: ReactNode }> = {
  info: {
    color: "var(--color-accent, #8b5cf6)",
    dim: "var(--color-accent-dim, rgba(139, 92, 246, 0.12))",
    iconPath: (
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </>
    ),
  },
  success: {
    color: "var(--color-success, #22c55e)",
    dim: "var(--color-success-dim, rgba(34, 197, 94, 0.12))",
    iconPath: (
      <>
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </>
    ),
  },
  warning: {
    color: "var(--color-warning, #eab308)",
    dim: "var(--color-warning-dim, rgba(234, 179, 8, 0.12))",
    iconPath: (
      <>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </>
    ),
  },
  error: {
    color: "var(--color-danger, #ef4444)",
    dim: "var(--color-danger-dim, rgba(239, 68, 68, 0.12))",
    iconPath: (
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </>
    ),
  },
};

function ToastCard({ toast, onDismiss }: { toast: ToastEntry; onDismiss: () => void }) {
  const { color, dim, iconPath } = VARIANT_STYLES[toast.variant];
  const [busy, setBusy] = useState(false);

  const handleAction = useCallback(async () => {
    if (!toast.action || busy) return;
    setBusy(true);
    try {
      const keep = await toast.action.onClick();
      if (keep !== false) onDismiss();
    } finally {
      setBusy(false);
    }
  }, [toast.action, busy, onDismiss]);

  return (
    <div
      className="card flex items-start gap-3 shadow-2xl pointer-events-auto animate-fade-in"
      role={toast.variant === "error" || toast.variant === "warning" ? "alert" : "status"}
      style={{
        border: `1px solid ${color}`,
        borderLeftWidth: "3px",
        background: "var(--color-surface)",
        backdropFilter: "blur(8px)",
      }}
    >
      <div
        className="flex items-center justify-center w-8 h-8 rounded-full shrink-0"
        style={{ background: dim }}
        aria-hidden="true"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color }}
        >
          {iconPath}
        </svg>
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-txt-primary mb-0.5">{toast.title}</p>
        {toast.description && (
          <p className="text-xs text-txt-secondary leading-relaxed mb-2">{toast.description}</p>
        )}

        {toast.action && (
          <div className="flex gap-2 mt-1">
            <button
              type="button"
              onClick={handleAction}
              disabled={busy}
              className="btn btn-sm"
              style={{
                background: color,
                color: "#fff",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? "Working…" : toast.action.label}
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="btn btn-sm"
              style={{ background: "var(--color-surface-secondary, var(--color-surface))" }}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {/* Always-visible close affordance in the corner. Doubles as the only
          dismiss path for actionless toasts. */}
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 -mr-1 -mt-1 p-1 rounded text-txt-secondary hover:text-txt-primary"
        aria-label="Dismiss notification"
        style={{ background: "transparent" }}
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
  );
}
