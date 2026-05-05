/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { useEffect, useRef, useState } from "react";
import { useUserPreferences } from "../components/UserPreferencesProvider";
import CommandMappingsSection from "../components/CommandMappingsSection";
import { getMe, MeResponse } from "../api";
import {
  bindingFromEvent,
  DEFAULT_COMMAND_PALETTE_BINDING,
  parseBinding,
} from "../utils/keybindings";

/**
 * Profile / per-user settings page.
 *
 * Today this exposes:
 *   • Read-only account summary
 *   • Customisable Command Palette keybinding (default Ctrl+K)
 *
 * Designed so additional preferences can be added as new <section> blocks.
 */
export default function Profile() {
  const { preferences, update, loading } = useUserPreferences();
  const [me, setMe] = useState<MeResponse | null>(null);

  // Local draft of the command-palette binding so the user can preview &
  // explicitly Save (rather than persisting on every keystroke).
  const [draftBinding, setDraftBinding] = useState<string>(
    preferences.commandPaletteBinding ?? DEFAULT_COMMAND_PALETTE_BINDING
  );
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const recorderRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setDraftBinding(preferences.commandPaletteBinding ?? DEFAULT_COMMAND_PALETTE_BINDING);
  }, [preferences.commandPaletteBinding]);

  useEffect(() => {
    void getMe()
      .then(setMe)
      .catch(() => {});
  }, []);

  // While recording, capture the next non-modifier key press and turn it
  // into a binding string. Modifier-only presses are ignored — we wait
  // for the user to press an actual letter / function key.
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape cancels recording without committing.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setRecording(false);
        setStatus("Recording cancelled.");
        return;
      }
      const binding = bindingFromEvent(e);
      if (!binding) return; // modifier-only — keep listening
      e.preventDefault();
      e.stopPropagation();
      setDraftBinding(binding);
      setRecording(false);
      setStatus(null);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [recording]);

  const dirty =
    draftBinding !== (preferences.commandPaletteBinding ?? DEFAULT_COMMAND_PALETTE_BINDING);

  const handleSave = async () => {
    setStatus(null);
    // Validate it actually parses to something usable (or is empty = disabled).
    if (draftBinding && !parseBinding(draftBinding)) {
      setStatus("That shortcut is not valid. Try again.");
      return;
    }
    try {
      await update({ commandPaletteBinding: draftBinding });
      setStatus("Saved.");
    } catch (e) {
      setStatus(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleResetDefault = () => {
    setDraftBinding(DEFAULT_COMMAND_PALETTE_BINDING);
    setStatus(null);
  };

  const handleDisable = () => {
    setDraftBinding("");
    setStatus(null);
  };

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Profile & Settings</h1>

      {/* ── Account ───────────────────────────────────────── */}
      <section
        className="rounded-lg p-5 mb-6"
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
        }}
      >
        <h2 className="text-lg font-semibold mb-3">Account</h2>
        <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
          <dt className="text-txt-tertiary">Username</dt>
          <dd>{me?.username ?? "…"}</dd>
          <dt className="text-txt-tertiary">Full name</dt>
          <dd>{me?.full_name || "—"}</dd>
          <dt className="text-txt-tertiary">Role</dt>
          <dd>{me?.role ?? "—"}</dd>
        </dl>
      </section>

      {/* ── Keyboard Shortcuts ────────────────────────────── */}
      <section
        className="rounded-lg p-5"
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
        }}
      >
        <h2 className="text-lg font-semibold mb-1">Keyboard Shortcuts</h2>
        <p className="text-sm text-txt-tertiary mb-4">
          Customise shortcuts that may conflict with other apps you use. <code>Ctrl</code> matches
          either <kbd>Ctrl</kbd> or <kbd>⌘</kbd> on macOS.
        </p>

        <div className="flex items-center gap-3 mb-2">
          <span className="text-sm font-medium w-48">Command Palette</span>
          <button
            ref={recorderRef}
            type="button"
            onClick={() => {
              setRecording((r) => !r);
              setStatus(recording ? null : "Press the new shortcut… (Esc to cancel)");
            }}
            className="px-3 py-2 text-sm rounded-md font-mono"
            style={{
              border: "1px solid var(--color-border)",
              background: recording ? "var(--color-accent)" : "var(--color-bg)",
              color: recording ? "white" : "inherit",
              minWidth: 180,
              textAlign: "left",
            }}
            aria-label="Record command palette shortcut"
          >
            {recording ? "Press a shortcut…" : draftBinding || "(disabled)"}
          </button>
          <button
            type="button"
            onClick={handleResetDefault}
            className="text-xs text-txt-tertiary underline hover:text-txt-primary"
          >
            Reset to {DEFAULT_COMMAND_PALETTE_BINDING}
          </button>
          <button
            type="button"
            onClick={handleDisable}
            className="text-xs text-txt-tertiary underline hover:text-txt-primary"
          >
            Disable
          </button>
        </div>

        <div className="flex items-center gap-3 mt-5">
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || loading}
            className="btn-primary px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Save
          </button>
          {status && <span className="text-xs text-txt-tertiary">{status}</span>}
        </div>
      </section>

      <CommandMappingsSection />
    </div>
  );
}
