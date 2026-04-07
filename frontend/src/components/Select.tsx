import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface Option {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
}

export default function Select({ value, onChange, options, placeholder }: SelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const selected = options.find((o) => o.value === value);

  const positionMenu = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const menuHeight = (options.length * 36) + 8;
    const placeAbove = spaceBelow < menuHeight && rect.top > menuHeight;

    setMenuStyle({
      position: 'fixed',
      left: rect.left,
      width: rect.width,
      ...(placeAbove
        ? { bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 }),
    });
  }, [options.length]);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    positionMenu();
    const handleScroll = () => positionMenu();
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [open, positionMenu]);

  return (
    <div className="relative w-full" ref={ref}>
      <button
        type="button"
        className={`cs-trigger ${open ? 'cs-trigger-open' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          {selected ? selected.label : placeholder || 'Select…'}
        </span>
        <svg
          className={`shrink-0 text-txt-tertiary transition-transform duration-250 ${open ? 'rotate-180 text-accent' : ''}`}
          style={{ transitionTimingFunction: 'var(--ease-spring)' }}
          width="16" height="16" viewBox="0 0 16 16" fill="none"
        >
          <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && createPortal(
        <ul className="cs-menu" role="listbox" ref={menuRef} style={menuStyle}>
          {options.map((opt) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              className={`cs-option ${opt.value === value ? 'cs-option-selected' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              {opt.label}
              {opt.value === value && (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M3 7L6 10L11 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </li>
          ))}
        </ul>,
        document.body
      )}
    </div>
  );
}
