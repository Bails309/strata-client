/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface Option {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  searchable?: boolean;
  id?: string;
}

export default function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  searchable,
  id,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const selected = options.find((o) => o.value === value);

  // Filter options based on search query
  const filteredOptions =
    searchable && query.trim()
      ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
      : options;

  const positionMenu = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;

    // Account for search input height (~44px) if searchable
    const searchHeight = searchable ? 44 : 0;
    const menuHeight = Math.min(filteredOptions.length * 36 + 8 + searchHeight, 320);
    const placeAbove = spaceBelow < menuHeight && rect.top > menuHeight;

    setMenuStyle({
      position: "fixed",
      left: rect.left,
      width: rect.width,
      ...(placeAbove ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    });
  }, [filteredOptions.length, searchable]);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery(""); // Reset search query on close
      return;
    }
    positionMenu();

    // Focus search input on open
    if (searchable) {
      setTimeout(() => searchInputRef.current?.focus(), 10);
    }

    const handleScroll = () => positionMenu();
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [open, positionMenu, searchable]);

  return (
    <div className={`relative ${className || "w-full"}`} ref={ref}>
      <button
        type="button"
        id={id}
        className={`cs-trigger ${open ? "cs-trigger-open" : ""} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected ? selected.label : placeholder || "Select…"}
      >
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          {selected ? selected.label : placeholder || "Select…"}
        </span>
        <svg
          className={`shrink-0 text-txt-tertiary transition-transform duration-250 ${open ? "rotate-180 text-accent" : ""}`}
          style={{ transitionTimingFunction: "var(--ease-spring)" }}
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M4 6L8 10L12 6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open &&
        createPortal(
          <ul className="cs-menu" role="listbox" ref={menuRef} style={menuStyle}>
            {searchable && (
              <li className="p-2 border-b border-white/5 sticky top-0 bg-surface-secondary/95 backdrop-blur-md z-10">
                <div className="relative">
                  <input
                    ref={searchInputRef}
                    type="text"
                    className="input input-sm w-full pl-8"
                    placeholder="Filter options..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()} // Prevent closing menu on Enter
                  />
                  <svg
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 opacity-40"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  {query && (
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded-full hover:bg-white/10"
                      onClick={() => setQuery("")}
                    >
                      <span className="text-xs">✕</span>
                    </button>
                  )}
                </div>
              </li>
            )}
            {filteredOptions.length === 0 ? (
              <li className="px-3 py-4 text-xs italic text-center opacity-40">
                No matching options
              </li>
            ) : (
              filteredOptions.map((opt) => (
                <li
                  key={opt.value}
                  role="option"
                  tabIndex={-1}
                  aria-selected={opt.value === value}
                  className={`cs-option ${opt.value === value ? "cs-option-selected" : ""}`}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onChange(opt.value);
                      setOpen(false);
                    }
                  }}
                >
                  {opt.label}
                  {opt.value === value && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M3 7L6 10L11 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </li>
              ))
            )}
          </ul>,
          document.body
        )}
    </div>
  );
}
