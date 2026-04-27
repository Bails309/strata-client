import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { getMyConnections, getTags, getConnectionTags, Connection, UserTag } from "../api";
import { useSessionManager } from "./SessionManager";

/* ── Protocol icon (inline SVG, matching Dashboard) ──────────────── */
function ProtocolIcon({ protocol }: { protocol: string }) {
  const p = protocol.toLowerCase();
  if (p === "rdp") {
    return (
      <svg width="16" height="16" viewBox="0 0 88 88" fill="currentColor" className="shrink-0">
        <path d="M0 12.4l35.687-4.86.016 34.423-35.67.143L0 12.4zm35.67 33.529l.028 34.453L0 75.39V45.71h35.67V45.93zM40.336 6.326L87.971 0v41.527H40.33l.006-35.2zM87.971 46.26l-.011 41.74-47.624-6.661V46.26h47.635z" />
      </svg>
    );
  }
  if (p === "ssh") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
      >
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </svg>
    );
  }
  if (p === "vnc") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    );
  }
  if (p === "web") {
    // Globe — Web Browser session (rustguac parity Phase 2).
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    );
  }
  if (p === "vdi") {
    // Stacked container blocks — VDI desktop container (rustguac parity Phase 3).
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
      >
        <rect x="3" y="4" width="18" height="5" rx="1" />
        <rect x="3" y="11" width="18" height="5" rx="1" />
        <line x1="7" y1="6.5" x2="7" y2="6.5" />
        <line x1="7" y1="13.5" x2="7" y2="13.5" />
        <path d="M3 18h18" />
      </svg>
    );
  }
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

/* ── Main component ──────────────────────────────────────────────── */

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { sessions } = useSessionManager();
  const [query, setQuery] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [tags, setTags] = useState<UserTag[]>([]);
  const [connectionTags, setConnectionTags] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch connections + tags + per-connection tag map when opened.
  // Tags and the assignment map are best-effort: if they fail we still show
  // connections, just without tag pills / tag-based filtering.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    setLoading(true);
    Promise.all([
      getMyConnections().catch(() => [] as Connection[]),
      getTags().catch(() => [] as UserTag[]),
      getConnectionTags().catch(() => ({}) as Record<string, string[]>),
    ])
      .then(([conns, allTags, ctags]) => {
        setConnections(conns);
        setTags(allTags);
        setConnectionTags(ctags);
      })
      .finally(() => setLoading(false));
  }, [open]);

  // Auto-focus input
  useEffect(() => {
    if (open) {
      // Small delay to let the animation start
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Filter connections.
  // Query matches against name / protocol / hostname / description / folder /
  // any tag name assigned to the connection. Pure-tag-name queries find
  // every connection wearing that tag, so users can type "prod" to see all
  // tagged connections regardless of their actual hostname.
  const lowerQuery = query.toLowerCase();
  const activeConnectionIds = new Set(sessions.map((s) => s.connectionId));

  // Pre-resolve tag id → tag for O(1) lookup during the per-row render.
  const tagById = new Map(tags.map((t) => [t.id, t]));

  const filtered = connections.filter((c) => {
    if (!query) return true;
    const tagIds = connectionTags[c.id] || [];
    const tagNamesMatch = tagIds.some((id) =>
      tagById.get(id)?.name.toLowerCase().includes(lowerQuery)
    );
    return (
      c.name.toLowerCase().includes(lowerQuery) ||
      c.protocol.toLowerCase().includes(lowerQuery) ||
      (c.hostname || "").toLowerCase().includes(lowerQuery) ||
      (c.description || "").toLowerCase().includes(lowerQuery) ||
      (c.folder_name || "").toLowerCase().includes(lowerQuery) ||
      tagNamesMatch
    );
  });

  // Clamp selected index when filtered list changes
  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const launch = useCallback(
    (conn: Connection) => {
      onClose();
      navigate(`/session/${conn.id}`);
    },
    [navigate, onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[selectedIndex]) launch(filtered[selectedIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, selectedIndex, launch, onClose]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh]"
      onClick={onClose}
      style={{ background: "rgba(0, 0, 0, 0.6)", backdropFilter: "blur(8px)" }}
    >
      {/* Palette container */}
      <div
        className="w-full max-w-[560px] rounded-2xl border overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--color-surface-secondary)",
          borderColor: "var(--color-border)",
          animation: "cmdPaletteIn 0.15s ease-out",
        }}
      >
        {/* Search input */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderColor: "var(--color-border)" }}
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
            className="shrink-0 opacity-40"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search connections..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:opacity-40"
            style={{ color: "var(--color-txt-primary)" }}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd
            className="text-[10px] opacity-30 border rounded px-1.5 py-0.5 font-mono"
            style={{ borderColor: "var(--color-border)" }}
          >
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1" role="listbox">
          {loading && (
            <div className="flex items-center justify-center py-10 opacity-40 text-sm">
              Loading...
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="opacity-20"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
              <span className="text-sm opacity-30">
                No connections found for &ldquo;{query}&rdquo;
              </span>
            </div>
          )}
          {!loading &&
            filtered.map((conn, i) => {
              const isActive = activeConnectionIds.has(conn.id);
              const isSelected = i === selectedIndex;
              const rowTags = (connectionTags[conn.id] || [])
                .map((id) => tagById.get(id))
                .filter((t): t is UserTag => Boolean(t));
              return (
                <div
                  key={conn.id}
                  role="option"
                  aria-selected={isSelected}
                  className="flex items-center gap-3 px-4 py-2.5 mx-1 rounded-lg cursor-pointer transition-colors duration-100"
                  style={{
                    background: isSelected ? "var(--color-accent-dim)" : "transparent",
                    color: "var(--color-txt-primary)",
                  }}
                  onClick={() => launch(conn)}
                  onMouseEnter={() => setSelectedIndex(i)}
                >
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                    style={{
                      background: isSelected
                        ? "var(--color-accent-glow)"
                        : "rgba(255,255,255,0.05)",
                      color: isSelected
                        ? "var(--color-accent-light)"
                        : "var(--color-txt-secondary)",
                    }}
                  >
                    <ProtocolIcon protocol={conn.protocol} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{conn.name}</span>
                      {isActive && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
                          style={{ background: "rgba(34,197,94,0.15)", color: "#4ade80" }}
                        >
                          Active
                        </span>
                      )}
                      {rowTags.map((tag) => (
                        <span
                          key={tag.id}
                          className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 border"
                          style={{
                            background: `${tag.color}26`,
                            color: tag.color,
                            borderColor: `${tag.color}40`,
                          }}
                          title={`Tag: ${tag.name}`}
                        >
                          {tag.name}
                        </span>
                      ))}
                    </div>
                    <div className="text-xs truncate opacity-40">
                      {conn.protocol.toUpperCase()}
                      {conn.folder_name ? ` · ${conn.folder_name}` : ""}
                      {conn.hostname ? ` · ${conn.hostname}` : ""}
                    </div>
                  </div>
                  {isSelected && (
                    <kbd
                      className="text-[10px] opacity-30 border rounded px-1.5 py-0.5 font-mono shrink-0"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      ↵
                    </kbd>
                  )}
                </div>
              );
            })}
        </div>

        {/* Footer */}
        <div
          className="flex items-center gap-4 px-4 py-2 border-t text-[11px] opacity-30"
          style={{ borderColor: "var(--color-border)" }}
        >
          <span className="flex items-center gap-1">
            <kbd className="font-mono">↑↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono">↵</kbd> launch
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono">esc</kbd> close
          </span>
        </div>
      </div>

      {/* Animation keyframes */}
      <style>{`
        @keyframes cmdPaletteIn {
          from { opacity: 0; transform: scale(0.97) translateY(-8px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
}
