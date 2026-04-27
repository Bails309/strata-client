/**
 * Keybinding parsing & matching for user-configurable shortcuts.
 *
 * Strings are stored in a portable normalised form like:
 *   "Ctrl+K"          (Ctrl-or-Cmd + K — recommended for cross-platform)
 *   "Ctrl+Shift+P"
 *   "Alt+Space"
 *
 * Matching rules:
 *   - "Ctrl" matches both Control and Command (⌘) so the same binding
 *     works on Windows/Linux and macOS without per-OS configuration.
 *   - Modifiers may be listed in any order; comparison is case-insensitive.
 *   - The non-modifier key is matched against `event.key`
 *     (case-insensitive). Single letters are normalised to lowercase.
 *
 * The empty string disables the shortcut entirely.
 */

export type KeyBinding = string;

export const DEFAULT_COMMAND_PALETTE_BINDING: KeyBinding = "Ctrl+K";

export interface ParsedBinding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Lower-case non-modifier key. */
  key: string;
}

const MODIFIER_NAMES = new Set([
  "ctrl",
  "control",
  "alt",
  "option",
  "shift",
  "meta",
  "cmd",
  "command",
  "win",
  "super",
]);

/**
 * Parse a binding string into modifier flags + key.
 * Returns null for empty/whitespace strings ("disabled").
 */
export function parseBinding(binding: KeyBinding): ParsedBinding | null {
  const trimmed = binding.trim();
  if (!trimmed) return null;
  const parts = trimmed
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const result: ParsedBinding = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key: "",
  };

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") result.ctrl = true;
    else if (lower === "alt" || lower === "option") result.alt = true;
    else if (lower === "shift") result.shift = true;
    else if (
      lower === "meta" ||
      lower === "cmd" ||
      lower === "command" ||
      lower === "win" ||
      lower === "super"
    )
      result.meta = true;
    else if (!MODIFIER_NAMES.has(lower)) {
      // Last non-modifier wins (operators won't normally combine two,
      // but defend against e.g. "Ctrl+K+L" by taking the final segment).
      result.key = lower;
    }
  }
  if (!result.key) return null;
  return result;
}

/**
 * Build a normalised binding string from a KeyboardEvent. Used by the
 * Profile page key-recorder to translate a press into storage form.
 * Returns null for events that contain no non-modifier key (e.g. the
 * user only pressed Shift).
 */
export function bindingFromEvent(e: KeyboardEvent): KeyBinding | null {
  const key = e.key;
  if (
    key === "Control" ||
    key === "Alt" ||
    key === "Shift" ||
    key === "Meta" ||
    key === "OS" ||
    !key
  ) {
    return null;
  }

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  // Display the printable key in upper-case for readability ("K" not "k").
  // Special keys like "Enter", "Space", "Escape", "F1" stay as-is.
  const display = key.length === 1 ? key.toUpperCase() : key;
  parts.push(display);

  return parts.join("+");
}

/**
 * Returns true when the given KeyboardEvent matches the parsed binding.
 * `Ctrl` in a binding matches `event.ctrlKey || event.metaKey`.
 */
export function matchesBinding(e: KeyboardEvent, parsed: ParsedBinding | null): boolean {
  if (!parsed) return false;

  const ctrlOrMeta = e.ctrlKey || e.metaKey;
  if (parsed.ctrl !== ctrlOrMeta) return false;
  if (parsed.alt !== e.altKey) return false;
  if (parsed.shift !== e.shiftKey) return false;
  // We deliberately don't check meta separately — Ctrl already covers it.

  const eventKey = (e.key || "").toLowerCase();
  // Allow "space" as alias for " ".
  const normalisedKey = eventKey === " " ? "space" : eventKey;
  const normalisedTarget = parsed.key === " " ? "space" : parsed.key;
  return normalisedKey === normalisedTarget;
}
