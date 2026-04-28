import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import Guacamole from "guacamole-common-js";
import {
  getMyConnections,
  getTags,
  getConnectionTags,
  getConnectionFolders,
  postCommandAudit,
  Connection,
  ConnectionFolder,
  UserTag,
  CommandMapping,
  BUILTIN_COMMANDS,
  MAX_OPEN_PATH_LEN,
} from "../api";
import { useUserPreferences } from "./UserPreferencesProvider";
import { useSessionManager } from "./SessionManager";
import { requestFullscreenWithLock, exitFullscreenWithUnlock } from "../utils/keyboardLock";

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
  const { sessions, activeSessionId, closeSession } = useSessionManager();
  const { preferences } = useUserPreferences();
  const [query, setQuery] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [folders, setFolders] = useState<ConnectionFolder[]>([]);
  const [tags, setTags] = useState<UserTag[]>([]);
  const [connectionTags, setConnectionTags] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  /** True while user has typed `:` to enter command mode. */
  const isCommandMode = query.startsWith(":");
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
      getConnectionFolders().catch(() => [] as ConnectionFolder[]),
    ])
      .then(([conns, allTags, ctags, fs]) => {
        setConnections(conns);
        setTags(allTags);
        setConnectionTags(ctags);
        setFolders(fs);
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

  // ── Command mode: built-in registry, mappings, validation ───────

  const userMappings: CommandMapping[] = useMemo(
    () => preferences.commandMappings ?? [],
    [preferences.commandMappings]
  );

  /** The current `:command` slug (lowercased, no leading colon). Empty when
   *  the user has only typed `:`. For arg-bearing built-ins (`:explorer cmd`)
   *  this still contains the entire post-colon string — use `commandHead`
   *  for trigger matching and `commandArgRaw` for the original-case argument. */
  const commandSlug = isCommandMode ? query.slice(1).toLowerCase() : "";

  /** Raw text after the leading `:` with case preserved. Needed because
   *  arg-bearing built-ins (e.g. `:explorer C:\\Users`) must keep upper-case
   *  characters in the argument we forward to the remote session. */
  const commandRaw = isCommandMode ? query.slice(1) : "";

  /** Index of the first space in `commandRaw`, or -1 when none. */
  const commandSpaceIdx = commandRaw.indexOf(" ");

  /** The `:command` head (lowercased, before the first space). Used for
   *  trigger matching and ghost-text autocomplete. */
  const commandHead = commandSpaceIdx === -1 ? commandSlug : commandSlug.slice(0, commandSpaceIdx);

  /** The free-form argument typed after the trigger, with original case
   *  preserved. Empty when the user hasn't typed a space yet. */
  const commandArgRaw = commandSpaceIdx === -1 ? "" : commandRaw.slice(commandSpaceIdx + 1);

  // ---------------------------------------------------------------
  // `:explorer <arg>` validation. Mirrors the `open-path` mapping
  // action so an operator can drive the remote Run dialog ad-hoc
  // without first defining a mapping. Same ≤ 1024-char cap and same
  // control-character rejection (newlines in the Run dialog could
  // chain follow-up commands).
  // ---------------------------------------------------------------
  const explorerArgRaw = commandHead === "explorer" ? commandArgRaw : "";
  const explorerArgTrimmed = explorerArgRaw.trim();
  const EXPLORER_MAX_LEN = MAX_OPEN_PATH_LEN;
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
  const explorerArgInvalidReason: string | undefined =
    explorerArgTrimmed.length === 0
      ? "Argument required"
      : explorerArgTrimmed.length > EXPLORER_MAX_LEN
        ? `Argument exceeds ${EXPLORER_MAX_LEN} chars`
        : CONTROL_CHAR_RE.test(explorerArgTrimmed)
          ? "Argument contains control characters"
          : undefined;
  const explorerArgValid = explorerArgInvalidReason === undefined;
  const explorerArgPreview =
    explorerArgTrimmed.length <= 40 ? explorerArgTrimmed : `${explorerArgTrimmed.slice(0, 37)}…`;

  /** Built-in commands matching the current prefix, plus their handlers. */
  type ExecutableCommand = {
    trigger: string;
    description: string;
    valid: boolean;
    invalidReason?: string;
    run: () => void | Promise<void>;
    /** For audit logging */
    audit: { action: string; args: unknown; targetId?: string | null };
    /** When true, this command consumes free-form text after `:trigger ` —
     *  e.g. `:explorer cmd`. Driven by `commandArgRaw` at execute-time. */
    takesArgs?: boolean;
  };

  const hasActiveSession = activeSessionId !== null;

  const builtinCommands: ExecutableCommand[] = useMemo(() => {
    const items: ExecutableCommand[] = [
      {
        trigger: "reload",
        description: "Reload the current session",
        valid: hasActiveSession,
        invalidReason: hasActiveSession ? undefined : "No active session",
        run: () => {
          if (!activeSessionId) return;
          const sess = sessions.find((s) => s.id === activeSessionId);
          if (!sess) return;
          onClose();
          // Same flow as the SessionBar reconnect button — navigate with a
          // `reconnect` state stamp so SessionClient tears down + recreates.
          navigate(`/session/${sess.connectionId}`, {
            state: { reconnect: Date.now() },
          });
        },
        audit: {
          action: "reload",
          args: {},
          targetId: activeSessionId,
        },
      },
      {
        trigger: "disconnect",
        description: "Close the current session",
        valid: hasActiveSession,
        invalidReason: hasActiveSession ? undefined : "No active session",
        run: () => {
          if (!activeSessionId) return;
          closeSession(activeSessionId);
          onClose();
        },
        audit: {
          action: "disconnect",
          args: {},
          targetId: activeSessionId,
        },
      },
      {
        // `:close` is a friendlier alias for `:disconnect` — operators
        // think of session tabs as "server pages", so closing the
        // current page mirrors the language they already use.
        trigger: "close",
        description: "Close the current server page",
        valid: hasActiveSession,
        invalidReason: hasActiveSession ? undefined : "No active session",
        run: () => {
          if (!activeSessionId) return;
          closeSession(activeSessionId);
          onClose();
        },
        audit: {
          action: "close",
          args: {},
          targetId: activeSessionId,
        },
      },
      {
        trigger: "fullscreen",
        description: "Toggle fullscreen",
        valid: true,
        run: () => {
          onClose();
          // Defer one frame so the palette unmounts before the
          // fullscreen request — Chrome requires user-gesture context
          // and the click already qualifies, but tearing down a modal
          // mid-request occasionally swallows it.
          requestAnimationFrame(() => {
            if (document.fullscreenElement) {
              exitFullscreenWithUnlock(document).catch(() => {});
            } else {
              requestFullscreenWithLock(document.documentElement).catch(() => {});
            }
          });
        },
        audit: { action: "fullscreen", args: {} },
      },
      {
        trigger: "commands",
        description: "List all available commands",
        valid: true,
        run: () => {
          // Reset the input to a bare `:` so the palette stays open and
          // the matching-commands list shows every available trigger.
          setQuery(":");
        },
        audit: { action: "commands", args: {} },
      },
      {
        // `:explorer <path-or-program>` drives the Windows Run dialog
        // on the active remote session: Win+R → paste arg → Enter.
        // Anything `start` accepts works — `cmd`, `notepad`,
        // `\\server\share`, `C:\Users\Public`, `shell:startup`, even
        // `https://example.com`. Argument validation matches the
        // `open-path` mapping action: ≤ 1024 chars and no control
        // characters (newline injection through Run could chain
        // commands).
        trigger: "explorer",
        takesArgs: true,
        description: explorerArgValid
          ? `Run "${explorerArgPreview}" on the active session via the Run dialog`
          : explorerArgRaw.length === 0
            ? "Type a path or program after :explorer (e.g. :explorer cmd)"
            : (explorerArgInvalidReason ?? "Invalid argument"),
        valid: hasActiveSession && explorerArgValid,
        invalidReason: !hasActiveSession
          ? "No active session"
          : explorerArgRaw.length === 0
            ? "Argument required"
            : explorerArgInvalidReason,
        run: async () => {
          if (!activeSessionId || !explorerArgValid) return;
          const sess = sessions.find((s) => s.id === activeSessionId);
          if (!sess) return;
          onClose();
          try {
            // 1. Win+R — keysyms 0xffeb (Super_L) + 0x72 ("r").
            sess.client.sendKeyEvent(1, 0xffeb);
            sess.client.sendKeyEvent(1, 0x72);
            sess.client.sendKeyEvent(0, 0x72);
            sess.client.sendKeyEvent(0, 0xffeb);
            await new Promise((r) => setTimeout(r, 250));

            // 2. Push the argument onto the remote clipboard.
            const stream = sess.client.createClipboardStream("text/plain");
            const writer = new Guacamole.StringWriter(stream);
            writer.sendText(explorerArgTrimmed);
            writer.sendEnd();
            sess.remoteClipboard = explorerArgTrimmed;
            await new Promise((r) => setTimeout(r, 80));

            // 3. Ctrl+V to paste.
            sess.client.sendKeyEvent(1, 0xffe3);
            sess.client.sendKeyEvent(1, 0x76);
            sess.client.sendKeyEvent(0, 0x76);
            sess.client.sendKeyEvent(0, 0xffe3);
            await new Promise((r) => setTimeout(r, 80));

            // 4. Enter to submit.
            sess.client.sendKeyEvent(1, 0xff0d);
            sess.client.sendKeyEvent(0, 0xff0d);
          } catch {
            /* swallow — non-Windows targets won't have Run */
          }
        },
        audit: {
          action: "explorer",
          // Mirror `open-path`: never log the literal argument, only
          // its length. A stored mapping cannot leak share names or
          // internal hosts through the chained-hash audit log.
          args: { arg_length: explorerArgTrimmed.length },
          targetId: activeSessionId,
        },
      },
    ];
    return items;
  }, [
    activeSessionId,
    closeSession,
    hasActiveSession,
    navigate,
    onClose,
    sessions,
    explorerArgRaw,
    explorerArgTrimmed,
    explorerArgValid,
    explorerArgPreview,
    explorerArgInvalidReason,
  ]);

  /** Resolve a user-defined mapping into something executable. Returns
   *  `null` if its target no longer exists (e.g. the connection was
   *  deleted) — the caller renders an error state. */
  const resolveMapping = useCallback(
    (m: CommandMapping): ExecutableCommand => {
      const baseAudit = { action: m.action, args: m.args };
      switch (m.action) {
        case "open-connection": {
          const conn = connections.find((c) => c.id === m.args.connection_id);
          return {
            trigger: m.trigger,
            description: conn ? `Open ${conn.name}` : "Open connection (not found)",
            valid: !!conn,
            invalidReason: conn ? undefined : "Connection no longer exists",
            run: () => {
              if (!conn) return;
              onClose();
              navigate(`/session/${conn.id}`);
            },
            audit: { ...baseAudit, targetId: m.args.connection_id },
          };
        }
        case "open-folder": {
          const folder = folders.find((f) => f.id === m.args.folder_id);
          return {
            trigger: m.trigger,
            description: folder ? `Open folder ${folder.name}` : "Open folder (not found)",
            valid: !!folder,
            invalidReason: folder ? undefined : "Folder no longer exists",
            run: () => {
              if (!folder) return;
              onClose();
              navigate(`/dashboard?folder=${folder.id}`);
            },
            audit: { ...baseAudit, targetId: m.args.folder_id },
          };
        }
        case "open-tag": {
          const tag = tags.find((t) => t.id === m.args.tag_id);
          return {
            trigger: m.trigger,
            description: tag ? `Filter by tag ${tag.name}` : "Open tag (not found)",
            valid: !!tag,
            invalidReason: tag ? undefined : "Tag no longer exists",
            run: () => {
              if (!tag) return;
              onClose();
              navigate(`/dashboard?tag=${tag.id}`);
            },
            audit: { ...baseAudit, targetId: m.args.tag_id },
          };
        }
        case "open-page":
          return {
            trigger: m.trigger,
            description: `Go to ${m.args.path}`,
            valid: true,
            run: () => {
              onClose();
              navigate(m.args.path);
            },
            audit: baseAudit,
          };
        case "paste-text": {
          // Resolve the active session (if any) at execute-time so the
          // mapping is valid as soon as a session opens after the
          // palette is created.
          const text = m.args.text;
          const preview = text.length <= 32 ? text : `${text.slice(0, 29)}…`;
          return {
            trigger: m.trigger,
            description: `Paste "${preview}" into the active session`,
            valid: hasActiveSession && text.length > 0,
            invalidReason: !hasActiveSession
              ? "No active session"
              : text.length === 0
                ? "Mapping has no text"
                : undefined,
            run: async () => {
              if (!activeSessionId) return;
              const sess = sessions.find((s) => s.id === activeSessionId);
              if (!sess) return;
              onClose();
              // Push the text into the remote clipboard, then fire a
              // Ctrl+V keystroke so the focused remote application
              // actually receives it. We deliberately do NOT log the
              // text in the audit details — only the trigger + length.
              try {
                const stream = sess.client.createClipboardStream("text/plain");
                const writer = new Guacamole.StringWriter(stream);
                const CHUNK = 4096;
                for (let i = 0; i < text.length; i += CHUNK) {
                  writer.sendText(text.substring(i, i + CHUNK));
                }
                writer.sendEnd();
                sess.remoteClipboard = text;
                // Give the clipboard transfer a moment to land before
                // the paste keystroke. 80 ms matches the empirical
                // delay used by SessionBar's Paste button.
                await new Promise((r) => setTimeout(r, 80));
                // Ctrl+V — keysyms 0xffe3 (Left Ctrl) and 0x76 ("v").
                sess.client.sendKeyEvent(1, 0xffe3);
                sess.client.sendKeyEvent(1, 0x76);
                sess.client.sendKeyEvent(0, 0x76);
                sess.client.sendKeyEvent(0, 0xffe3);
              } catch {
                /* swallow — clipboard may be denied on this protocol */
              }
            },
            audit: {
              action: "paste-text",
              args: { text_length: text.length },
              targetId: activeSessionId,
            },
          };
        }
        case "open-path": {
          // Open a path on the remote target by driving the Windows
          // Run dialog: Win+R → paste path via clipboard → Enter.
          // Works for UNC shares (`\\server\share`), local folders
          // (`C:\Users\…`), `shell:` URIs (`shell:startup`), and
          // anything else `start` would accept on the remote box.
          const path = m.args.path;
          const preview = path.length <= 40 ? path : `${path.slice(0, 37)}…`;
          return {
            trigger: m.trigger,
            description: `Open ${preview} on the active session`,
            valid: hasActiveSession && path.length > 0,
            invalidReason: !hasActiveSession
              ? "No active session"
              : path.length === 0
                ? "Mapping has no path"
                : undefined,
            run: async () => {
              if (!activeSessionId) return;
              const sess = sessions.find((s) => s.id === activeSessionId);
              if (!sess) return;
              onClose();
              try {
                // 1. Win+R to open the Run dialog.
                //    Keysym 0xffeb = Super_L (left Windows key);
                //    keysym 0x72  = "r".
                sess.client.sendKeyEvent(1, 0xffeb);
                sess.client.sendKeyEvent(1, 0x72);
                sess.client.sendKeyEvent(0, 0x72);
                sess.client.sendKeyEvent(0, 0xffeb);
                // Give the Run dialog a moment to focus and clear any
                // stale text. The dialog auto-selects existing content
                // so a subsequent paste replaces rather than appends.
                await new Promise((r) => setTimeout(r, 250));

                // 2. Push the path into the remote clipboard.
                const stream = sess.client.createClipboardStream("text/plain");
                const writer = new Guacamole.StringWriter(stream);
                writer.sendText(path);
                writer.sendEnd();
                sess.remoteClipboard = path;
                await new Promise((r) => setTimeout(r, 80));

                // 3. Ctrl+V to paste.
                sess.client.sendKeyEvent(1, 0xffe3);
                sess.client.sendKeyEvent(1, 0x76);
                sess.client.sendKeyEvent(0, 0x76);
                sess.client.sendKeyEvent(0, 0xffe3);
                await new Promise((r) => setTimeout(r, 80));

                // 4. Enter (keysym 0xff0d) to submit the dialog.
                sess.client.sendKeyEvent(1, 0xff0d);
                sess.client.sendKeyEvent(0, 0xff0d);
              } catch {
                /* swallow — non-Windows targets won't have Run */
              }
            },
            audit: {
              action: "open-path",
              args: { path_length: path.length },
              targetId: activeSessionId,
            },
          };
        }
      }
    },
    [connections, folders, tags, navigate, onClose, hasActiveSession, activeSessionId, sessions]
  );

  /** All executable commands, merged + sorted by trigger. */
  const allCommands: ExecutableCommand[] = useMemo(
    () => [...builtinCommands, ...userMappings.map(resolveMapping)],
    [builtinCommands, userMappings, resolveMapping]
  );

  /** Commands matching the current `:command` prefix (excludes mismatches). */
  const matchingCommands = useMemo(() => {
    if (!isCommandMode) return [] as ExecutableCommand[];
    if (!commandHead) return allCommands;
    return allCommands.filter((c) => c.trigger.startsWith(commandHead));
  }, [isCommandMode, commandHead, allCommands]);

  /** Exact command match (or `null`). Drives validation + Enter behaviour.
   *  Commands that don't accept arguments are excluded once the user has
   *  typed a space, so `:reload now` reports "Unknown command" instead of
   *  silently triggering `:reload`. */
  const exactCommand = useMemo(() => {
    const match = allCommands.find((c) => c.trigger === commandHead) ?? null;
    if (!match) return null;
    if (commandSpaceIdx !== -1 && !match.takesArgs) return null;
    return match;
  }, [allCommands, commandHead, commandSpaceIdx]);

  /** Ghost-text suffix to render after the user's input. Empty string when
   *  there is no unambiguous extension to suggest, or when the user has
   *  already typed past the trigger into argument territory. */
  const ghostSuffix = useMemo(() => {
    if (!isCommandMode || !commandHead) return "";
    // Once the user types a space the trigger is locked in; ghost-text
    // for arguments would just be misleading.
    if (commandSpaceIdx !== -1) return "";
    if (allCommands.some((c) => c.trigger === commandHead)) return "";
    const candidates = matchingCommands.filter((c) => c.trigger !== commandHead);
    if (candidates.length === 0) return "";
    // Longest common prefix among candidates' triggers.
    const triggers = candidates.map((c) => c.trigger);
    let lcp = triggers[0];
    for (const t of triggers.slice(1)) {
      let i = 0;
      while (i < lcp.length && i < t.length && lcp[i] === t[i]) i++;
      lcp = lcp.slice(0, i);
    }
    if (lcp.length <= commandHead.length) return "";
    return lcp.slice(commandHead.length);
  }, [isCommandMode, commandHead, commandSpaceIdx, matchingCommands, allCommands]);

  /** Whether the user typed a `:command` that doesn't resolve. Drives the
   *  red border + tooltip on the input. */
  const commandError = useMemo(() => {
    if (!isCommandMode) return null;
    if (!commandHead) return null; // just `:` — show the list, no error
    if (matchingCommands.length === 0) return `Unknown command: ':${commandHead}'`;
    if (exactCommand && !exactCommand.valid)
      return exactCommand.invalidReason ?? "Command unavailable";
    return null;
  }, [isCommandMode, commandHead, matchingCommands, exactCommand]);

  /** Execute a command, fire-and-forget audit, then close. */
  const executeCommand = useCallback((cmd: ExecutableCommand) => {
    if (!cmd.valid) return;
    // Audit first so the log captures intent even if the action throws.
    void postCommandAudit({
      trigger: `:${cmd.trigger}`,
      action: cmd.audit.action,
      args: cmd.audit.args,
      target_id: cmd.audit.targetId ?? null,
    }).catch(() => {
      // Audit failures must never block the command itself.
    });
    void cmd.run();
  }, []);

  // Scroll selected item into view (works for both normal + command mode).
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
      // Tab / Right Arrow accept ghost-text autocomplete (command mode only).
      if (
        isCommandMode &&
        ghostSuffix &&
        (e.key === "Tab" ||
          (e.key === "ArrowRight" && inputRef.current?.selectionStart === query.length))
      ) {
        e.preventDefault();
        setQuery(query + ghostSuffix);
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const max = isCommandMode ? matchingCommands.length : filtered.length;
        setSelectedIndex((i) => Math.min(i + 1, Math.max(0, max - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (isCommandMode) {
          // Prefer the highlighted suggestion if any; fall back to exact match.
          const cmd = matchingCommands[selectedIndex] ?? exactCommand;
          if (cmd) executeCommand(cmd);
        } else if (filtered[selectedIndex]) {
          launch(filtered[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [
      isCommandMode,
      ghostSuffix,
      query,
      filtered,
      matchingCommands,
      exactCommand,
      selectedIndex,
      executeCommand,
      launch,
      onClose,
    ]
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
          className="flex items-center gap-3 px-4 py-3 border-b relative"
          style={{
            borderColor: commandError ? "var(--color-danger, #ef4444)" : "var(--color-border)",
          }}
          title={commandError ?? ""}
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
          {/* Input + ghost-text overlay. The overlay sits behind the input
              and shows the longest unambiguous extension so the user can
              accept it with Tab or Right Arrow. */}
          <div className="relative flex-1 min-w-0">
            {ghostSuffix && (
              <div
                aria-hidden
                className="absolute inset-0 text-sm pointer-events-none whitespace-pre"
                style={{
                  color: "var(--color-txt-primary)",
                  opacity: 0.35,
                  fontFamily: "inherit",
                  fontSize: "inherit",
                  fontWeight: "inherit",
                  letterSpacing: "inherit",
                }}
              >
                <span style={{ visibility: "hidden" }}>{query}</span>
                <span>{ghostSuffix}</span>
              </div>
            )}
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search connections, or type : for commands…"
              className="relative w-full bg-transparent text-sm outline-none placeholder:opacity-40"
              style={{
                color: commandError ? "var(--color-danger, #ef4444)" : "var(--color-txt-primary)",
                // Inputs do not inherit font-family / size by default —
                // force them so the hidden-text spacer in the ghost-text
                // overlay above lines up character-for-character with the
                // user's typed query.
                fontFamily: "inherit",
                fontSize: "inherit",
                fontWeight: "inherit",
                letterSpacing: "inherit",
                padding: 0,
                margin: 0,
                border: 0,
              }}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!commandError}
              aria-describedby={commandError ? "cmd-palette-error" : undefined}
            />
          </div>
          {commandError && (
            <span
              id="cmd-palette-error"
              role="alert"
              className="text-[11px] shrink-0 hidden sm:inline"
              style={{ color: "var(--color-danger, #ef4444)" }}
            >
              {commandError}
            </span>
          )}
          <kbd
            className="text-[10px] opacity-30 border rounded px-1.5 py-0.5 font-mono shrink-0"
            style={{ borderColor: "var(--color-border)" }}
          >
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1" role="listbox">
          {isCommandMode && (
            <>
              {matchingCommands.length === 0 && (
                <div className="flex flex-col items-center justify-center py-10 gap-2">
                  <span className="text-sm opacity-30">
                    No commands match &ldquo;{query}&rdquo;
                  </span>
                </div>
              )}
              {matchingCommands.map((cmd, i) => {
                const isSelected = i === selectedIndex;
                const isBuiltin = (BUILTIN_COMMANDS as readonly string[]).includes(cmd.trigger);
                return (
                  <div
                    key={cmd.trigger}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={!cmd.valid}
                    className="flex items-center gap-3 px-4 py-2.5 mx-1 rounded-lg cursor-pointer transition-colors duration-100"
                    style={{
                      background: isSelected ? "var(--color-accent-dim)" : "transparent",
                      color: cmd.valid ? "var(--color-txt-primary)" : "var(--color-txt-tertiary)",
                      opacity: cmd.valid ? 1 : 0.6,
                    }}
                    onClick={() => executeCommand(cmd)}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 font-mono text-xs"
                      style={{
                        background: isSelected
                          ? "var(--color-accent-glow)"
                          : "rgba(255,255,255,0.05)",
                        color: isSelected
                          ? "var(--color-accent-light)"
                          : "var(--color-txt-secondary)",
                      }}
                    >
                      :
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium font-mono">:{cmd.trigger}</span>
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
                          style={{
                            background: isBuiltin
                              ? "rgba(59,130,246,0.15)"
                              : "rgba(168,85,247,0.15)",
                            color: isBuiltin ? "#60a5fa" : "#c084fc",
                          }}
                        >
                          {isBuiltin ? "built-in" : "custom"}
                        </span>
                        {!cmd.valid && cmd.invalidReason && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
                            style={{
                              background: "rgba(239,68,68,0.15)",
                              color: "#f87171",
                            }}
                          >
                            {cmd.invalidReason}
                          </span>
                        )}
                      </div>
                      <div className="text-xs truncate opacity-50">{cmd.description}</div>
                    </div>
                    {isSelected && cmd.valid && (
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
            </>
          )}

          {!isCommandMode && loading && (
            <div className="flex items-center justify-center py-10 opacity-40 text-sm">
              Loading...
            </div>
          )}
          {!isCommandMode && !loading && filtered.length === 0 && (
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
          {!isCommandMode &&
            !loading &&
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
