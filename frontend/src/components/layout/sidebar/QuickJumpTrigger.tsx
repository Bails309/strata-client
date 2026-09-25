import { useCommandPalette } from "../../CommandPaletteProvider";
import { useUserPreferences } from "../../UserPreferencesProvider";
import { DEFAULT_COMMAND_PALETTE_BINDING } from "../../../utils/keybindings";
import NavTooltip from "./NavTooltip";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** "Ctrl+K" as the user would press it here: "⌘K" on macOS, "Ctrl K" elsewhere. */
function displayBinding(binding: string): string {
  return binding
    .split("+")
    .map((p) => p.trim())
    .map((p) => (isMac && /^(ctrl|control|cmd|command|meta)$/i.test(p) ? "⌘" : p))
    .join(isMac ? "" : " ");
}

/**
 * Opens the existing command palette. It owns the keyboard shortcut (which
 * each user can rebind), so this component deliberately adds no listener.
 */
export default function QuickJumpTrigger({ isCollapsed }: { isCollapsed: boolean }) {
  const palette = useCommandPalette();
  const { preferences } = useUserPreferences();
  const binding = preferences.commandPaletteBinding ?? DEFAULT_COMMAND_PALETTE_BINDING;
  const shortcut = binding ? displayBinding(binding) : "";
  const label = shortcut ? `Quick jump (${shortcut})` : "Quick jump";

  if (isCollapsed) {
    return (
      <NavTooltip label={label} enabled>
        <button
          type="button"
          className="sb-tile sb-quickjump-icon"
          onClick={palette.open}
          aria-label={label}
        >
          <svg
            className="sb-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
      </NavTooltip>
    );
  }

  return (
    <button type="button" className="sb-quickjump" onClick={palette.open} aria-label={label}>
      <span className="sb-quickjump-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        Quick jump…
      </span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}
