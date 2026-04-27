// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BUILTIN_COMMANDS,
  COMMAND_MAPPING_PAGES,
  COMMAND_TRIGGER_RE,
  CommandMapping,
  CommandMappingPage,
  Connection,
  ConnectionFolder,
  MAX_COMMAND_MAPPINGS,
  MAX_OPEN_PATH_LEN,
  MAX_PASTE_TEXT_LEN,
  UserTag,
  getConnectionFolders,
  getMyConnections,
  getTags,
} from "../api";
import { useUserPreferences } from "./UserPreferencesProvider";

type ActionKind = CommandMapping["action"];

/* ── StyledSelect ──────────────────────────────────────────────────
 * Custom themed dropdown used everywhere we'd previously use a native
 * <select>.  Keeps the closed-state visuals identical to global input
 * styling, but the open-state list uses surface-elevated +
 * accent-tinted selection so the dropdown matches the rest of the app
 * (instead of falling back to the OS chrome). */
interface StyledSelectOption<V extends string> {
  value: V;
  label: string;
  description?: string;
}
interface StyledSelectProps<V extends string> {
  value: V;
  onChange: (next: V) => void;
  options: StyledSelectOption<V>[];
  ariaLabel: string;
  width?: number | string;
  className?: string;
}
function StyledSelect<V extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  width,
  className,
}: StyledSelectProps<V>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className={`relative ${className ?? ""}`}
      style={width ? { width } : undefined}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left text-[0.8125rem] rounded-sm transition-all duration-200"
        style={{
          background: "var(--color-input-bg)",
          color: "var(--color-txt-primary)",
          border: "1px solid var(--color-border)",
          padding: "0.6rem 0.85rem",
          height: "2.4rem",
        }}
      >
        <span className="truncate">{current?.label ?? ""}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ml-2 shrink-0"
          style={{
            color: "var(--color-txt-tertiary)",
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 0.15s",
          }}
        >
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute z-30 mt-1 left-0 right-0 max-h-64 overflow-y-auto rounded-sm border shadow-lg py-1"
          style={{
            background: "var(--color-surface-elevated)",
            borderColor: "var(--color-border)",
          }}
        >
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <li
                key={o.value}
                role="option"
                aria-selected={selected}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(o.value);
                  setOpen(false);
                }}
                className="px-3 py-1.5 text-[0.8125rem] cursor-pointer hover:bg-white/5"
                style={
                  selected
                    ? {
                        background: "var(--color-accent-dim)",
                        color: "var(--color-accent-light)",
                      }
                    : undefined
                }
              >
                <div className="truncate">{o.label}</div>
                {o.description && (
                  <div
                    className="text-[11px] truncate"
                    style={{ color: "var(--color-txt-tertiary)" }}
                  >
                    {o.description}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface PickerProps<T> {
  items: T[];
  selectedId: string;
  onSelect: (id: string) => void;
  getId: (it: T) => string;
  getLabel: (it: T) => string;
  placeholder: string;
  invalid?: boolean;
}

/** Searchable typeahead picker — used for connection / folder / tag args.
 *  Inherits the global `input` element styles for the trigger control so
 *  it visually matches every other text field in the app. */
function TypeaheadPicker<T>({
  items,
  selectedId,
  onSelect,
  getId,
  getLabel,
  placeholder,
  invalid,
}: PickerProps<T>) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const selected = items.find((it) => getId(it) === selectedId);

  // Close on outside click — onBlur alone fights with the dropdown click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 50);
    return items.filter((it) => getLabel(it).toLowerCase().includes(q)).slice(0, 50);
  }, [items, query, getLabel]);

  return (
    <div ref={wrapRef} className="relative flex-1 min-w-0">
      <input
        type="text"
        value={open ? query : selected ? getLabel(selected) : ""}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => setQuery(e.target.value)}
        aria-invalid={!!invalid}
        style={invalid ? { borderColor: "var(--color-danger)" } : undefined}
      />
      {open && filtered.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 left-0 right-0 max-h-56 overflow-y-auto rounded-sm border shadow-lg py-1"
          style={{
            background: "var(--color-surface-elevated)",
            borderColor: "var(--color-border)",
          }}
        >
          {filtered.map((it) => (
            <li
              key={getId(it)}
              role="option"
              aria-selected={getId(it) === selectedId}
              className="px-3 py-1.5 text-[0.8125rem] cursor-pointer hover:bg-white/5"
              style={
                getId(it) === selectedId
                  ? { background: "var(--color-accent-dim)", color: "var(--color-accent-light)" }
                  : undefined
              }
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(getId(it));
                setOpen(false);
                setQuery("");
              }}
            >
              {getLabel(it)}
            </li>
          ))}
        </ul>
      )}
      {open && filtered.length === 0 && (
        <div
          className="absolute z-20 mt-1 left-0 right-0 px-3 py-2 text-[0.8125rem] rounded-sm border italic"
          style={{
            background: "var(--color-surface-elevated)",
            borderColor: "var(--color-border)",
            color: "var(--color-txt-tertiary)",
          }}
        >
          No matches
        </div>
      )}
    </div>
  );
}

interface RowProps {
  mapping: CommandMapping;
  connections: Connection[];
  folders: ConnectionFolder[];
  tags: UserTag[];
  otherTriggers: string[];
  onChange: (next: CommandMapping) => void;
  onDelete: () => void;
}

function emptyArgsFor(action: ActionKind): CommandMapping {
  switch (action) {
    case "open-connection":
      return { trigger: "", action: "open-connection", args: { connection_id: "" } };
    case "open-folder":
      return { trigger: "", action: "open-folder", args: { folder_id: "" } };
    case "open-tag":
      return { trigger: "", action: "open-tag", args: { tag_id: "" } };
    case "open-page":
      return { trigger: "", action: "open-page", args: { path: "/dashboard" } };
    case "paste-text":
      return { trigger: "", action: "paste-text", args: { text: "" } };
    case "open-path":
      return { trigger: "", action: "open-path", args: { path: "" } };
  }
}

/** Validate a single mapping in isolation. Returns a structured result so
 *  the row UI can highlight the offending field independently. */
export interface MappingValidation {
  triggerError: string | null;
  argError: string | null;
}

export function validateMapping(
  mapping: CommandMapping,
  otherTriggers: string[]
): MappingValidation {
  const t = mapping.trigger.trim();
  let triggerError: string | null = null;
  if (!t) triggerError = "Trigger required";
  else if (!COMMAND_TRIGGER_RE.test(t))
    triggerError = "Lowercase letters, digits, - and _ only (max 32)";
  else if ((BUILTIN_COMMANDS as readonly string[]).includes(t))
    triggerError = `'${t}' is a built-in command`;
  else if (otherTriggers.includes(t)) triggerError = "Duplicate trigger";

  let argError: string | null = null;
  switch (mapping.action) {
    case "open-connection":
      if (!mapping.args.connection_id) argError = "Choose a connection";
      break;
    case "open-folder":
      if (!mapping.args.folder_id) argError = "Choose a folder";
      break;
    case "open-tag":
      if (!mapping.args.tag_id) argError = "Choose a tag";
      break;
    case "open-page":
      if (!mapping.args.path) argError = "Choose a page";
      break;
    case "paste-text":
      if (!mapping.args.text) argError = "Enter text to paste";
      else if (mapping.args.text.length > MAX_PASTE_TEXT_LEN)
        argError = `Text too long (max ${MAX_PASTE_TEXT_LEN} chars)`;
      break;
    case "open-path":
      if (!mapping.args.path) argError = "Enter a path";
      else if (mapping.args.path.length > MAX_OPEN_PATH_LEN)
        argError = `Path too long (max ${MAX_OPEN_PATH_LEN} chars)`;
      else if (/[\r\n\t]/.test(mapping.args.path))
        argError = "Path must not contain control characters";
      break;
  }
  return { triggerError, argError };
}

function MappingRow({
  mapping,
  connections,
  folders,
  tags,
  otherTriggers,
  onChange,
  onDelete,
}: RowProps) {
  const { triggerError, argError } = validateMapping(mapping, otherTriggers);

  const handleActionChange = (action: ActionKind) => {
    if (action === mapping.action) return;
    onChange({ ...emptyArgsFor(action), trigger: mapping.trigger });
  };

  return (
    <div
      className="rounded-sm p-3"
      style={{
        background: "var(--color-glass-highlight)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex flex-wrap items-start gap-2">
        {/* Trigger — colon prefix + monospaced input grouped as one control */}
        <div className="flex items-stretch shrink-0" style={{ width: 180 }}>
          <span
            className="flex items-center px-2 text-sm font-mono rounded-l-sm"
            style={{
              background: "var(--color-surface-tertiary)",
              borderTop: "1px solid var(--color-border)",
              borderLeft: "1px solid var(--color-border)",
              borderBottom: "1px solid var(--color-border)",
              color: "var(--color-txt-tertiary)",
            }}
          >
            :
          </span>
          <input
            type="text"
            value={mapping.trigger}
            onChange={(e) => onChange({ ...mapping, trigger: e.target.value.toLowerCase() })}
            placeholder="trigger"
            aria-label="Command trigger"
            aria-invalid={!!triggerError}
            className="font-mono"
            style={{
              borderRadius: "0 2px 2px 0",
              ...(triggerError ? { borderColor: "var(--color-danger)" } : {}),
            }}
          />
        </div>

        {/* Action selector */}
        <StyledSelect<ActionKind>
          ariaLabel="Mapping action"
          value={mapping.action}
          onChange={(v) => handleActionChange(v)}
          width={180}
          className="shrink-0"
          options={[
            { value: "open-connection", label: "Open connection" },
            {
              value: "open-folder",
              label: "Open folder",
              description: "Filter dashboard by folder",
            },
            { value: "open-tag", label: "Open tag", description: "Filter dashboard by tag" },
            { value: "open-page", label: "Open page" },
            {
              value: "open-path",
              label: "Open path on session",
              description: "Win+R → path → Enter (UNC, folder, shell:…)",
            },
            {
              value: "paste-text",
              label: "Paste text",
              description: "Send text to the active session",
            },
          ]}
        />

        {/* Action-specific argument picker */}
        {mapping.action === "open-connection" && (
          <TypeaheadPicker
            items={connections}
            selectedId={mapping.args.connection_id}
            onSelect={(id) => onChange({ ...mapping, args: { connection_id: id } })}
            getId={(c) => c.id}
            getLabel={(c) => `${c.name} (${c.protocol.toUpperCase()})`}
            placeholder="Search connections…"
            invalid={!!argError}
          />
        )}
        {mapping.action === "open-folder" && (
          <TypeaheadPicker
            items={folders}
            selectedId={mapping.args.folder_id}
            onSelect={(id) => onChange({ ...mapping, args: { folder_id: id } })}
            getId={(f) => f.id}
            getLabel={(f) => f.name}
            placeholder="Search folders…"
            invalid={!!argError}
          />
        )}
        {mapping.action === "open-tag" && (
          <TypeaheadPicker
            items={tags}
            selectedId={mapping.args.tag_id}
            onSelect={(id) => onChange({ ...mapping, args: { tag_id: id } })}
            getId={(t) => t.id}
            getLabel={(t) => t.name}
            placeholder="Search tags…"
            invalid={!!argError}
          />
        )}
        {mapping.action === "open-page" && (
          <StyledSelect<CommandMappingPage>
            ariaLabel="Page path"
            value={mapping.args.path}
            onChange={(p) => onChange({ ...mapping, args: { path: p } })}
            className="flex-1 min-w-0"
            options={COMMAND_MAPPING_PAGES.map((p) => ({ value: p, label: p }))}
          />
        )}
        {mapping.action === "paste-text" && (
          <input
            type="text"
            value={mapping.args.text}
            maxLength={MAX_PASTE_TEXT_LEN}
            onChange={(e) => onChange({ ...mapping, args: { text: e.target.value } })}
            placeholder="\\\\server\\share, command, snippet…"
            aria-label="Text to paste into the active session"
            aria-invalid={!!argError}
            className="flex-1 min-w-0 font-mono"
            style={argError ? { borderColor: "var(--color-danger)" } : undefined}
          />
        )}
        {mapping.action === "open-path" && (
          <input
            type="text"
            value={mapping.args.path}
            maxLength={MAX_OPEN_PATH_LEN}
            onChange={(e) => onChange({ ...mapping, args: { path: e.target.value } })}
            placeholder="\\\\server\\share or C:\\Users\\… or shell:startup"
            aria-label="Path to open on the active session via Win+R"
            aria-invalid={!!argError}
            className="flex-1 min-w-0 font-mono"
            style={argError ? { borderColor: "var(--color-danger)" } : undefined}
          />
        )}

        {/* Delete */}
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete mapping"
          className="btn-danger-outline shrink-0 px-3 text-[0.8125rem]"
          style={{ height: "2.4rem" }}
        >
          Delete
        </button>
      </div>

      {(triggerError || argError) && (
        <div
          role="alert"
          className="mt-2 text-[11px] flex flex-wrap gap-x-4"
          style={{ color: "var(--color-danger)" }}
        >
          {triggerError && <span>Trigger: {triggerError}</span>}
          {argError && <span>{argError}</span>}
        </div>
      )}
    </div>
  );
}

/** Profile section: manage user-defined `:command` mappings. */
export default function CommandMappingsSection() {
  const { preferences, update, loading } = useUserPreferences();
  const [draft, setDraft] = useState<CommandMapping[]>(preferences.commandMappings ?? []);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [folders, setFolders] = useState<ConnectionFolder[]>([]);
  const [tags, setTags] = useState<UserTag[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Hydrate draft when prefs arrive (or change externally).
  useEffect(() => {
    setDraft(preferences.commandMappings ?? []);
  }, [preferences.commandMappings]);

  // Load reference data for the typeahead pickers. Failures are
  // non-fatal — the user simply gets an empty dropdown.
  useEffect(() => {
    void Promise.allSettled([getMyConnections(), getConnectionFolders(), getTags()]).then(
      ([cs, fs, ts]) => {
        if (cs.status === "fulfilled") setConnections(cs.value);
        if (fs.status === "fulfilled") setFolders(fs.value);
        if (ts.status === "fulfilled") setTags(ts.value);
      }
    );
  }, []);

  const triggers = useMemo(() => draft.map((m) => m.trigger.trim()), [draft]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(preferences.commandMappings ?? []);
  const validations = draft.map((m, i) =>
    validateMapping(m, triggers.filter((_, j) => j !== i).filter(Boolean))
  );
  const hasErrors = validations.some((v) => v.triggerError || v.argError);

  const handleAdd = () => {
    if (draft.length >= MAX_COMMAND_MAPPINGS) {
      setStatus(`Maximum of ${MAX_COMMAND_MAPPINGS} mappings reached`);
      return;
    }
    setDraft([...draft, { ...emptyArgsFor("open-page"), trigger: "" }]);
    setStatus(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await update({ ...preferences, commandMappings: draft });
      setStatus("Saved");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="rounded-lg p-5 mt-6"
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
      }}
    >
      <h2 className="text-lg font-semibold mb-1">Command Palette Mappings</h2>
      <p className="text-sm text-txt-tertiary mb-4">
        Define your own <code>:commands</code>. Open the palette and type <code>:</code> to use
        them. <strong>Open path on session</strong> drives the Windows Run dialog (Win+R) on the
        active session to open a UNC share, local folder, or <code>shell:</code> URI in Explorer.{" "}
        <strong>Paste text</strong> sends free-form text into the active session via clipboard +
        Ctrl+V (no Enter). Built-in commands (<code>:reload</code>, <code>:disconnect</code>,{" "}
        <code>:fullscreen</code>, <code>:commands</code>) cannot be overridden.
      </p>

      {draft.length === 0 && (
        <div className="text-sm text-txt-tertiary italic mb-4">
          No mappings yet — click <strong>Add mapping</strong> to create one.
        </div>
      )}

      <div className="flex flex-col gap-2 mb-4">
        {draft.map((m, i) => (
          <MappingRow
            key={i}
            mapping={m}
            connections={connections}
            folders={folders}
            tags={tags}
            otherTriggers={triggers.filter((_, j) => j !== i).filter(Boolean)}
            onChange={(next) => {
              const copy = [...draft];
              copy[i] = next;
              setDraft(copy);
            }}
            onDelete={() => {
              const copy = [...draft];
              copy.splice(i, 1);
              setDraft(copy);
            }}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleAdd}
          disabled={draft.length >= MAX_COMMAND_MAPPINGS}
          className="btn-ghost"
        >
          Add mapping
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || hasErrors || saving || loading}
          className="btn-primary"
        >
          Save mappings
        </button>
        <span className="text-xs text-txt-tertiary">
          {draft.length} / {MAX_COMMAND_MAPPINGS}
        </span>
        {status && <span className="text-xs text-txt-tertiary">{status}</span>}
        {hasErrors && (
          <span className="text-xs" style={{ color: "var(--color-danger)" }}>
            Fix errors before saving
          </span>
        )}
      </div>
    </section>
  );
}
