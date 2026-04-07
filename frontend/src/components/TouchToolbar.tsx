import { useState, useCallback } from 'react';
import Guacamole from 'guacamole-common-js';

interface Props {
  client: Guacamole.Client;
}

/**
 * Floating touch toolbar for tablet/mobile users.
 * Sends special key combinations (Ctrl+Alt+Del, Windows key, etc.)
 * that are impossible to produce on touchscreen keyboards.
 *
 * Renders as a collapsed "⌨" button that expands into a horizontal strip.
 */

interface KeyCombo {
  label: string;
  title: string;
  keys: number[]; // keysyms to press simultaneously
}

// X11 keysyms
const KEY = {
  CTRL_L: 0xFFE3,
  ALT_L: 0xFFE9,
  DELETE: 0xFFFF,
  SUPER_L: 0xFFEB,   // Windows / Super key
  TAB: 0xFF09,
  ESCAPE: 0xFF1B,
  F11: 0xFFC8,
} as const;

const COMBOS: KeyCombo[] = [
  { label: 'C+A+Del', title: 'Ctrl+Alt+Delete', keys: [KEY.CTRL_L, KEY.ALT_L, KEY.DELETE] },
  { label: '⊞ Win', title: 'Windows key', keys: [KEY.SUPER_L] },
  { label: 'Alt+Tab', title: 'Switch windows', keys: [KEY.ALT_L, KEY.TAB] },
  { label: 'Esc', title: 'Escape', keys: [KEY.ESCAPE] },
  { label: 'F11', title: 'F11 (Fullscreen)', keys: [KEY.F11] },
  { label: 'C+A+T', title: 'Ctrl+Alt+T (Terminal)', keys: [KEY.CTRL_L, KEY.ALT_L, 0x0074] }, // 't'
];

export default function TouchToolbar({ client }: Props) {
  const [expanded, setExpanded] = useState(false);

  const sendCombo = useCallback((keys: number[]) => {
    // Press all keys
    for (const k of keys) client.sendKeyEvent(1, k);
    // Release in reverse order
    for (const k of [...keys].reverse()) client.sendKeyEvent(0, k);
  }, [client]);

  const btnStyle: React.CSSProperties = {
    padding: '6px 10px',
    fontSize: '0.7rem',
    fontWeight: 600,
    borderRadius: 4,
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(0,0,0,0.7)',
    color: '#fff',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    backdropFilter: 'blur(8px)',
  };

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 25,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {expanded && COMBOS.map((c) => (
        <button
          key={c.label}
          onClick={() => sendCombo(c.keys)}
          title={c.title}
          style={btnStyle}
        >
          {c.label}
        </button>
      ))}

      <button
        onClick={() => setExpanded(!expanded)}
        title={expanded ? 'Hide keyboard shortcuts' : 'Show keyboard shortcuts'}
        style={{
          ...btnStyle,
          width: 36,
          height: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderColor: expanded ? 'var(--color-accent)' : 'rgba(255,255,255,0.15)',
        }}
      >
        ⌨
      </button>
    </div>
  );
}
