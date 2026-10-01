import { useEffect, useId, useRef, useState } from "react";
import type { UserRef } from "../api";
import { useUserSearch } from "../hooks/useLookups";

interface Props {
  onSelect: (user: UserRef) => void;
  /** Shown while the picker is closed. */
  value?: UserRef | null;
  /** Ids to leave out of the results, e.g. ones already chosen. */
  exclude?: readonly string[];
  placeholder?: string;
  ariaLabel: string;
}

/** Searches users on the server as you type, rather than loading them all. */
export default function UserPicker({
  onSelect,
  value,
  exclude = [],
  placeholder = "Search users…",
  ariaLabel,
}: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const { items, loading } = useUserSearch(query, open);
  const shown = items.filter((u) => !exclude.includes(u.id));

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        className="input input-sm w-full"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        placeholder={placeholder}
        value={open ? query : (value?.username ?? "")}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => {
          setOpen(true);
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 w-full rounded-md shadow-lg max-h-64 overflow-y-auto p-1"
          style={{
            background: "var(--color-surface-elevated)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          {shown.map((u) => (
            <button
              key={u.id}
              type="button"
              role="option"
              aria-selected={value?.id === u.id}
              className="cs-option w-full text-left flex items-center justify-between gap-2"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelect(u);
                setQuery("");
                setOpen(false);
              }}
            >
              <span style={{ color: "var(--color-txt-primary)" }}>{u.username}</span>
              {u.email !== u.username && (
                <span className="text-xs truncate" style={{ color: "var(--color-txt-tertiary)" }}>
                  {u.email}
                </span>
              )}
            </button>
          ))}
          {shown.length === 0 && (
            <div
              className="px-3 py-2 text-sm italic"
              style={{ color: "var(--color-txt-tertiary)" }}
            >
              {loading ? "Searching…" : "No matching users"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
