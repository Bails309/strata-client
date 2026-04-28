/**
 * CommandPaletteProvider — global Ctrl+K (or user-configured) command palette.
 *
 * Renders a single `<CommandPalette>` at app scope so the shortcut works
 * everywhere: Dashboard, Credentials, Admin pages, Sessions, Approvals, etc.
 *
 * Inside an active session canvas, `SessionClient` owns the keyboard so it
 * can flush held modifier keys to the remote (`Guacamole.Keyboard.reset()`)
 * before the palette steals focus. While that canvas is focused, it calls
 * `setSuppressed(true)` so the global listener stays out of the way and
 * SessionClient itself calls `open()` after running its session-specific
 * cleanup.
 *
 * Popout / multi-monitor child windows already postMessage
 * `{ type: "strata:open-command-palette" }` to the opener — we listen for
 * that here too, so it works even when no session is mounted in the main
 * window (e.g. user popped out the only session and is on the Dashboard).
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import CommandPalette from "./CommandPalette";
import { useUserPreferences } from "./UserPreferencesProvider";
import {
  DEFAULT_COMMAND_PALETTE_BINDING,
  matchesBinding,
  parseBinding,
} from "../utils/keybindings";

interface CommandPaletteCtx {
  /** Open the palette (idempotent). */
  open: () => void;
  /** True while the palette is rendered. */
  isOpen: boolean;
  /**
   * Suppress / unsuppress the global Ctrl+K listener. Used by SessionClient
   * while its remote-canvas owns the keyboard.
   */
  setSuppressed: (suppressed: boolean) => void;
}

const Ctx = createContext<CommandPaletteCtx | null>(null);

export function useCommandPalette(): CommandPaletteCtx {
  const v = useContext(Ctx);
  if (!v) {
    // Components that aren't wrapped in the provider (tests, isolated
    // pages) get a no-op so they don't crash.
    return {
      open: () => {},
      isOpen: false,
      setSuppressed: () => {},
    };
  }
  return v;
}

export default function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { preferences } = useUserPreferences();
  const bindingRef = useRef(
    parseBinding(preferences.commandPaletteBinding ?? DEFAULT_COMMAND_PALETTE_BINDING)
  );
  const suppressedRef = useRef(false);

  useEffect(() => {
    bindingRef.current = parseBinding(
      preferences.commandPaletteBinding ?? DEFAULT_COMMAND_PALETTE_BINDING
    );
  }, [preferences.commandPaletteBinding]);

  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);
  const setSuppressed = useCallback((s: boolean) => {
    suppressedRef.current = s;
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (suppressedRef.current) return;
      if (!matchesBinding(e, bindingRef.current)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(true);
    };
    document.addEventListener("keydown", handleKeyDown, true);

    const handleMessage = (ev: MessageEvent) => {
      // Only accept relays from same-origin windows (popout / multi-monitor).
      if (ev.origin !== window.location.origin) return;
      if (ev.data?.type === "strata:open-command-palette") {
        setOpen(true);
      }
    };
    window.addEventListener("message", handleMessage);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  return (
    <Ctx.Provider value={{ open: openPalette, isOpen: open, setSuppressed }}>
      {children}
      <CommandPalette open={open} onClose={closePalette} />
    </Ctx.Provider>
  );
}
