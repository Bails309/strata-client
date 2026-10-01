import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createRole,
  getConnectionRefs,
  getRoleMappings,
  getUsersPage,
  updateRole,
  updateRoleMappings,
  type ConnectionFolder,
  type ConnectionRef,
  type Role,
  type User,
} from "../../../api";
import { useOptionalToast } from "../../../components/ToastProvider";
import RoleAssignmentsTab from "./RoleAssignmentsTab";
import RoleMembersTab from "./RoleMembersTab";
import RolePermissionsTab from "./RolePermissionsTab";
import {
  ROLE_FLAGS,
  draftFromRole,
  grantsAllConnections,
  isSystemRole,
  type RoleDraft,
} from "./roleModel";
import { useRoleEditor, type RoleEditorInitial } from "./useRoleEditor";
import "./Roles.css";

const MAX_DESCRIPTION = 500;

interface Props {
  /** `null` creates a new role. */
  role: Role | null;
  roles: Role[];
  folders: ConnectionFolder[];
  onClose: () => void;
  onSaved: (role: Role, created: boolean) => void;
}

/** Members listed in the editor; the Users table pages through the rest. */
const MEMBER_LIMIT = 200;

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export default function EditRoleModal(props: Props) {
  const { role } = props;
  const [initial, setInitial] = useState<RoleEditorInitial | null>(() =>
    role ? null : { draft: draftFromRole(null), folderIds: [], connectionIds: [] }
  );
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!role) return;
    let cancelled = false;
    getRoleMappings(role.id)
      .then((m) => {
        if (!cancelled)
          setInitial({
            draft: draftFromRole(role),
            folderIds: m.folder_ids,
            connectionIds: m.connection_ids,
          });
      })
      .catch((e) => {
        if (!cancelled) setLoadError(errorText(e, "Failed to load role assignments"));
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  if (initial) return <RoleEditor {...props} initial={initial} />;

  return createPortal(
    <div className="role-backdrop">
      <div
        className="role-dialog role-dialog-small"
        role="dialog"
        aria-modal="true"
        aria-label="Edit role"
      >
        <div className="role-body">
          {loadError ? (
            <>
              <p className="role-error" role="alert">
                {loadError}. The role was not opened, so its assignments cannot be overwritten by
                mistake.
              </p>
              <button type="button" className="btn" onClick={props.onClose}>
                Close
              </button>
            </>
          ) : (
            <p className="role-empty">Loading role…</p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

type Tab = "permissions" | "assignments" | "members";

function RoleEditor({
  role,
  roles,
  folders,
  onClose,
  onSaved,
  initial,
}: Props & { initial: RoleEditorInitial }) {
  const toast = useOptionalToast();
  const ids = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  // Set once a create succeeds, so a retry after a failed mapping save updates it.
  const [created, setCreated] = useState<Role | null>(null);
  const [connections, setConnections] = useState<ConnectionRef[]>([]);
  const [members, setMembers] = useState<User[]>([]);
  const [memberTotal, setMemberTotal] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getConnectionRefs()
      .then((refs) => !cancelled && setConnections(refs))
      .catch(() => {});
    if (role)
      getUsersPage(1, MEMBER_LIMIT, { role_id: role.id })
        .then((page) => {
          if (cancelled) return;
          setMembers(page.items);
          setMemberTotal(page.total);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [role]);
  const editor = useRoleEditor(initial, connections);
  const { draft, changeCount } = editor;

  const [tab, setTab] = useState<Tab>("permissions");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const system = isSystemRole(role);
  const trimmedName = draft.name.trim();
  const existing = role ?? created;
  const duplicate = roles.some(
    (r) => r.id !== existing?.id && r.name.toLowerCase() === trimmedName.toLowerCase()
  );
  const isNew = !existing;
  const canSave = !saving && trimmedName !== "" && !duplicate && (isNew || changeCount > 0);

  const requestClose = useCallback(() => {
    if (changeCount > 0 && !confirmDiscard) setConfirmDiscard(true);
    else onClose();
  }, [changeCount, confirmDiscard, onClose]);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const save = async () => {
    setSaving(true);
    setError("");
    const payload: Omit<Role, "id"> = {
      ...(Object.fromEntries(ROLE_FLAGS.map((f) => [f, draft[f]])) as Omit<
        RoleDraft,
        "name" | "description" | "sessionLimit"
      >),
      name: trimmedName,
      description: draft.description.trim(),
      max_concurrent_sessions: draft.sessionLimit,
    };
    let saved: Role;
    try {
      saved = existing ? await updateRole(existing.id, payload) : await createRole(payload);
    } catch (e) {
      setError(errorText(e, "Failed to save role"));
      setSaving(false);
      return;
    }
    if (!existing) setCreated(saved);
    onSaved(saved, !existing);

    if (editor.mappingsChanged) {
      try {
        await updateRoleMappings(saved.id, [...editor.connectionIds], [...editor.folderIds]);
      } catch (e) {
        setError(
          `Role saved, but its assignments were not: ${errorText(e, "request failed")}. Save again to retry.`
        );
        setSaving(false);
        return;
      }
    }
    toast?.success({ title: existing ? `Saved role ${saved.name}` : `Created role ${saved.name}` });
    onClose();
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "permissions", label: "Permissions" },
    { id: "assignments", label: "Asset assignments" },
    ...(role ? [{ id: "members" as const, label: `Members (${members.length})` }] : []),
  ];

  return createPortal(
    <div className="role-backdrop">
      <div className="role-dialog" role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`}>
        <header className="role-header">
          <div>
            <div className="role-title-row">
              <h3 id={`${ids}-title`} className="role-title">
                {role ? `Edit role: ${role.name}` : "Create role"}
              </h3>
              {system && <span className="role-system-pill">System role</span>}
            </div>
            <p className="role-subtitle">
              Permissions and connection scope
              {role && ` · Assigned to ${members.length} user${members.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <button type="button" className="role-close" onClick={requestClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="role-tabs" role="tablist" aria-label="Role sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${ids}-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${ids}-panel`}
              className={`role-tab${tab === t.id ? " role-tab-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="role-body">
          <div className="role-meta">
            <div className="role-field">
              <label htmlFor={`${ids}-name`}>Role name</label>
              <input
                ref={nameRef}
                id={`${ids}-name`}
                className="input"
                value={draft.name}
                onChange={(e) => editor.setField("name", e.target.value)}
                placeholder="e.g. Helpdesk"
                disabled={system}
                aria-invalid={duplicate || undefined}
                aria-describedby={duplicate ? `${ids}-name-err` : undefined}
              />
              {duplicate && (
                <span id={`${ids}-name-err`} className="role-field-error">
                  A role with this name already exists.
                </span>
              )}
            </div>
            <div className="role-field">
              <label htmlFor={`${ids}-desc`}>Description</label>
              <input
                id={`${ids}-desc`}
                className="input"
                value={draft.description}
                maxLength={MAX_DESCRIPTION}
                onChange={(e) => editor.setField("description", e.target.value)}
                placeholder="Operational purpose of this role…"
              />
            </div>
            <div className="role-field">
              <label htmlFor={`${ids}-sessions`}>Concurrent sessions per member</label>
              <input
                id={`${ids}-sessions`}
                className="input"
                type="number"
                min={0}
                max={10000}
                value={draft.sessionLimit || ""}
                onChange={(e) =>
                  editor.setSessionLimit(
                    Math.min(10000, Math.max(0, Math.trunc(Number(e.target.value) || 0)))
                  )
                }
                placeholder="No limit"
              />
            </div>
          </div>

          <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${tab}`}>
            {tab === "permissions" && (
              <RolePermissionsTab draft={draft} onToggle={editor.toggleFlag} />
            )}
            {tab === "assignments" && (
              <RoleAssignmentsTab
                folders={folders}
                connections={connections}
                folderIds={editor.folderIds}
                connectionIds={editor.connectionIds}
                inherited={editor.inherited}
                grantsAll={grantsAllConnections(draft)}
                onToggleFolder={editor.toggleFolder}
                onToggleConnection={editor.toggleConnection}
              />
            )}
            {tab === "members" && <RoleMembersTab members={members} total={memberTotal} />}
          </div>
        </div>

        <footer className="role-footer">
          <div className="role-footer-status">
            {error ? (
              <span className="role-error" role="alert">
                {error}
              </span>
            ) : confirmDiscard ? (
              <span role="alert">
                Discard {changeCount} unsaved change{changeCount === 1 ? "" : "s"}?
              </span>
            ) : changeCount > 0 ? (
              <span className="role-dirty">
                {changeCount} unsaved change{changeCount === 1 ? "" : "s"}
              </span>
            ) : (
              <span>No unsaved changes</span>
            )}
          </div>
          <div className="role-footer-actions">
            {confirmDiscard ? (
              <>
                <button type="button" className="btn" onClick={() => setConfirmDiscard(false)}>
                  Keep editing
                </button>
                <button type="button" className="btn-danger" onClick={onClose}>
                  Discard
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn" onClick={requestClose}>
                  Cancel
                </button>
                <button type="button" className="btn-primary" disabled={!canSave} onClick={save}>
                  {saving ? "Saving…" : isNew ? "Create Role" : "Save Changes"}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>,
    document.body
  );
}
