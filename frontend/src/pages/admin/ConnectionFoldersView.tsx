/* Connection folder manager: hierarchical tree with inline create/rename,
   guarded delete, search across folders and their connections, and full
   keyboard traversal (WAI-ARIA tree pattern). */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  createConnectionFolder,
  deleteConnectionFolder,
  updateConnectionFolder,
  type Connection,
  type ConnectionFolder,
} from "../../api";
import { buildFolderTree, type FolderNode } from "../../utils/folderTree";
import "./ConnectionFoldersView.css";

const INDENT = 20;

interface Row {
  node: FolderNode;
  depth: number;
  parentId: string | null;
  /** For each depth 1..depth: is that ancestor (or this node) the last sibling? */
  lastAt: boolean[];
  posInSet: number;
  setSize: number;
  matches: string[];
}

type Draft = { parentId: string | null; name: string };

const FolderGlyph = ({ open }: { open: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    {open && <line x1="2" y1="11" x2="22" y2="11" />}
  </svg>
);

const Icon = ({ children }: { children: ReactNode }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export default function ConnectionFoldersView({
  folders,
  connections,
  onFoldersChanged,
}: {
  folders: ConnectionFolder[];
  connections: Connection[];
  onFoldersChanged: (folders: ConnectionFolder[]) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FolderNode | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  // Blur fires after Enter/Escape too; this makes each rename commit at most once.
  const renameDone = useRef(false);
  const startRename = (id: string, name: string) => {
    renameDone.current = false;
    setDraft(null);
    setRenaming({ id, name });
  };

  const tree = useMemo(() => buildFolderTree(folders, connections), [folders, connections]);

  useEffect(() => {
    if (!deleteTarget) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setDeleteTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteTarget]);
  const byId = useMemo(() => {
    const m = new Map<string, FolderNode>();
    const walk = (list: FolderNode[]) =>
      list.forEach((n) => {
        m.set(n.folder.id, n);
        walk(n.children);
      });
    walk(tree);
    return m;
  }, [tree]);

  // Search: a folder is shown if its name or one of its connections matches,
  // or if it is an ancestor of such a folder. Matches force-expand the path.
  const query = search.trim().toLowerCase();
  const searchView = useMemo(() => {
    if (!query) return null;
    const connByFolder = new Map<string, string[]>();
    for (const c of connections) {
      if (c.folder_id && c.name.toLowerCase().includes(query)) {
        connByFolder.set(c.folder_id, [...(connByFolder.get(c.folder_id) ?? []), c.name]);
      }
    }
    const visible = new Set<string>();
    const matches = new Map<string, string[]>();
    const walk = (n: FolderNode, ancestors: string[]): void => {
      const connHits = connByFolder.get(n.folder.id) ?? [];
      if (n.folder.name.toLowerCase().includes(query) || connHits.length > 0) {
        matches.set(n.folder.id, connHits);
        [...ancestors, n.folder.id].forEach((id) => visible.add(id));
      }
      n.children.forEach((c) => walk(c, [...ancestors, n.folder.id]));
    };
    tree.forEach((n) => walk(n, []));
    return { visible, matches };
  }, [query, connections, tree]);

  const isOpen = (id: string) => (searchView ? searchView.visible.has(id) : expanded.has(id));

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (
      list: FolderNode[],
      depth: number,
      parentId: string | null,
      lastAt: boolean[]
    ) => {
      const shown = searchView ? list.filter((n) => searchView.visible.has(n.folder.id)) : list;
      shown.forEach((node, i) => {
        const last = i === shown.length - 1;
        const rowLast = depth === 0 ? [] : [...lastAt, last];
        out.push({
          node,
          depth,
          parentId,
          lastAt: rowLast,
          posInSet: i + 1,
          setSize: shown.length,
          matches: searchView?.matches.get(node.folder.id) ?? [],
        });
        const open = searchView
          ? searchView.visible.has(node.folder.id)
          : expanded.has(node.folder.id);
        if (open) walk(node.children, depth + 1, node.folder.id, rowLast);
      });
    };
    walk(tree, 0, null, []);
    return out;
  }, [tree, expanded, searchView]);

  const activeId =
    focusedId && rows.some((r) => r.node.folder.id === focusedId)
      ? focusedId
      : (rows[0]?.node.folder.id ?? null);

  const focusRow = (id: string | null) => {
    if (!id) return;
    setFocusedId(id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  };

  const toggle = (id: string, open?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const willOpen = open ?? !next.has(id);
      if (willOpen) next.add(id);
      else next.delete(id);
      return next;
    });

  const anyExpanded = expanded.size > 0;
  const toggleAll = () => setExpanded(anyExpanded ? new Set() : new Set(byId.keys()));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Folder update failed");
    } finally {
      setBusy(false);
    }
  };

  const submitDraft = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setDraft(null);
      return;
    }
    void run(async () => {
      const created = await createConnectionFolder({
        name,
        parent_id: draft.parentId ?? undefined,
      });
      onFoldersChanged([...folders, created]);
      if (draft.parentId) toggle(draft.parentId, true);
      setDraft(null);
      focusRow(created.id);
    });
  };

  const submitRename = () => {
    if (!renaming || renameDone.current) return;
    renameDone.current = true;
    const node = byId.get(renaming.id);
    const name = renaming.name.trim();
    setRenaming(null);
    if (!node || !name || name === node.folder.name) return;
    void run(async () => {
      // PUT replaces parent_id too, so send the current one to avoid a move.
      const updated = await updateConnectionFolder(node.folder.id, {
        name,
        parent_id: node.folder.parent_id,
      });
      onFoldersChanged(folders.map((f) => (f.id === updated.id ? updated : f)));
      focusRow(updated.id);
    });
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const id = deleteTarget.folder.id;
    void run(async () => {
      await deleteConnectionFolder(id);
      onFoldersChanged(folders.filter((f) => f.id !== id));
      setDeleteTarget(null);
    });
  };

  const startChild = (parentId: string | null) => {
    setRenaming(null);
    setDraft({ parentId, name: "" });
    if (parentId) toggle(parentId, true);
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: Row, index: number) => {
    if (e.target !== e.currentTarget) return;
    const id = row.node.folder.id;
    const hasChildren = row.node.children.length > 0;
    const open = isOpen(id);
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case "ArrowDown":
        handled();
        focusRow(rows[index + 1]?.node.folder.id ?? null);
        break;
      case "ArrowUp":
        handled();
        focusRow(rows[index - 1]?.node.folder.id ?? null);
        break;
      case "Home":
        handled();
        focusRow(rows[0]?.node.folder.id ?? null);
        break;
      case "End":
        handled();
        focusRow(rows[rows.length - 1]?.node.folder.id ?? null);
        break;
      case "ArrowRight":
        handled();
        if (hasChildren && !open && !searchView) toggle(id, true);
        else if (hasChildren && open) focusRow(rows[index + 1]?.node.folder.id ?? null);
        break;
      case "ArrowLeft":
        handled();
        if (hasChildren && open && !searchView) toggle(id, false);
        else focusRow(row.parentId);
        break;
      case "Enter":
      case " ":
        handled();
        if (hasChildren && !searchView) toggle(id);
        break;
      case "F2":
        handled();
        startRename(id, row.node.folder.name);
        break;
      case "Delete":
        handled();
        setDeleteTarget(row.node);
        break;
    }
  };

  const draftInput = (depth: number) =>
    draft && (
      <div className="cf-draft" style={{ paddingLeft: 8 + depth * INDENT + 22 }}>
        <span className="cf-folder-icon" aria-hidden="true">
          <FolderGlyph open={false} />
        </span>
        <input
          className="cf-input"
          aria-label={draft.parentId ? "New subfolder name" : "New root folder name"}
          placeholder={draft.parentId ? "Subfolder name…" : "Root folder name…"}
          value={draft.name}
          disabled={busy}
          autoFocus
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitDraft();
            if (e.key === "Escape") setDraft(null);
          }}
          onBlur={() => {
            if (!draft.name.trim()) setDraft(null);
          }}
        />
        <button
          type="button"
          className="cf-btn cf-btn-primary"
          onMouseDown={(e) => e.preventDefault()}
          onClick={submitDraft}
          disabled={busy || !draft.name.trim()}
        >
          {draft.parentId ? "Add" : "Create"}
        </button>
        <button
          type="button"
          className="cf-btn cf-btn-ghost"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setDraft(null)}
        >
          Cancel
        </button>
      </div>
    );

  const blocked =
    deleteTarget !== null && (deleteTarget.children.length > 0 || deleteTarget.directCount > 0);

  return (
    <div className="card cf-card">
      <div className="cf-header">
        <div>
          <h2 className="!mb-0">Connection Folders</h2>
          <p className="cf-subtitle">Organize gateway targets into hierarchical boundaries</p>
        </div>
        <div className="cf-toolbar">
          {folders.length > 0 && (
            <button type="button" className="cf-btn cf-btn-ghost" onClick={toggleAll}>
              {anyExpanded ? "Collapse All" : "Expand All"}
            </button>
          )}
          <button
            type="button"
            className="btn-primary cf-new-root"
            onClick={() => startChild(null)}
          >
            + New Root Folder
          </button>
        </div>
      </div>

      {folders.length > 0 && (
        <div className="cf-search">
          <Icon>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </Icon>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search folders or connections…"
            aria-label="Search folders or connections"
          />
        </div>
      )}

      {error && (
        <div className="cf-error" role="alert">
          {error}
        </div>
      )}

      {draft && draft.parentId === null && draftInput(0)}

      {folders.length === 0 ? (
        !draft && (
          <div className="cf-empty">
            No connection folders configured. Click “+ New Root Folder” to get started.
          </div>
        )
      ) : rows.length === 0 ? (
        <div className="cf-empty">No folders or connections match “{search.trim()}”.</div>
      ) : (
        <div className="cf-tree" role="tree" aria-label="Connection folders">
          {rows.map((row, index) => {
            const { node, depth } = row;
            const id = node.folder.id;
            const hasChildren = node.children.length > 0;
            const open = isOpen(id);
            const isRenaming = renaming?.id === id;
            return (
              <div key={id} role="none">
                <div
                  ref={(el) => {
                    if (el) rowRefs.current.set(id, el);
                    else rowRefs.current.delete(id);
                  }}
                  className={`cf-row ${id === focusedId ? "cf-row-active" : ""} ${
                    row.matches.length > 0 ||
                    (query && node.folder.name.toLowerCase().includes(query))
                      ? "cf-row-match"
                      : ""
                  }`}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-posinset={row.posInSet}
                  aria-setsize={row.setSize}
                  aria-expanded={hasChildren ? open : undefined}
                  aria-selected={id === activeId}
                  aria-label={node.folder.name}
                  tabIndex={id === activeId ? 0 : -1}
                  onFocus={(e) => {
                    if (e.target === e.currentTarget) setFocusedId(id);
                  }}
                  onKeyDown={(e) => onRowKeyDown(e, row, index)}
                  style={{ paddingLeft: 8 + depth * INDENT }}
                >
                  {row.lastAt.map((last, level) => {
                    const own = level === row.lastAt.length - 1;
                    const x = 8 + level * INDENT + 10;
                    if (!own && last) return null;
                    return (
                      <span
                        key={level}
                        aria-hidden="true"
                        className={own ? "cf-guide cf-guide-own" : "cf-guide"}
                        style={{ left: x, bottom: own && last ? "50%" : 0 }}
                      />
                    );
                  })}
                  {depth > 0 && (
                    <span
                      aria-hidden="true"
                      className="cf-elbow"
                      style={{ left: 8 + (depth - 1) * INDENT + 10 }}
                    />
                  )}

                  <button
                    type="button"
                    className={`cf-chevron ${open && hasChildren ? "cf-chevron-open" : ""}`}
                    tabIndex={-1}
                    aria-hidden="true"
                    disabled={!hasChildren || !!searchView}
                    onClick={() => toggle(id)}
                  >
                    <Icon>
                      <polyline points="9 18 15 12 9 6" />
                    </Icon>
                  </button>

                  <span className="cf-folder-icon" aria-hidden="true">
                    <FolderGlyph open={open && hasChildren} />
                  </span>

                  {isRenaming ? (
                    <input
                      className="cf-input"
                      aria-label={`New name for ${node.folder.name}`}
                      value={renaming.name}
                      autoFocus
                      onChange={(e) => setRenaming({ id, name: e.target.value })}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") submitRename();
                        if (e.key === "Escape") {
                          renameDone.current = true;
                          setRenaming(null);
                          focusRow(id);
                        }
                      }}
                      onBlur={submitRename}
                    />
                  ) : (
                    <span
                      className="cf-name"
                      onDoubleClick={() => startRename(id, node.folder.name)}
                    >
                      {node.folder.name}
                    </span>
                  )}

                  <span
                    className="cf-badge"
                    title={`${node.directCount} direct · ${node.totalCount} including subfolders`}
                  >
                    {node.totalCount} {node.totalCount === 1 ? "connection" : "connections"}
                  </span>

                  {row.matches.length > 0 && (
                    <span className="cf-matches" title={row.matches.join(", ")}>
                      ↳ {row.matches.join(", ")}
                    </span>
                  )}

                  <span className="cf-actions">
                    <button
                      type="button"
                      className="cf-action"
                      title="Add subfolder"
                      aria-label={`Add subfolder to ${node.folder.name}`}
                      tabIndex={-1}
                      onClick={() => startChild(id)}
                    >
                      <Icon>
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </Icon>
                    </button>
                    <button
                      type="button"
                      className="cf-action"
                      title="Rename (F2)"
                      aria-label={`Rename ${node.folder.name}`}
                      tabIndex={-1}
                      onClick={() => startRename(id, node.folder.name)}
                    >
                      <Icon>
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </Icon>
                    </button>
                    <button
                      type="button"
                      className="cf-action cf-action-danger"
                      title="Delete folder (Del)"
                      aria-label={`Delete ${node.folder.name}`}
                      tabIndex={-1}
                      onClick={() => setDeleteTarget(node)}
                    >
                      <Icon>
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </Icon>
                    </button>
                  </span>
                </div>
                {draft?.parentId === id && draftInput(depth + 1)}
              </div>
            );
          })}
        </div>
      )}

      {folders.length > 0 && (
        <p className="cf-hint">
          Double-click or press F2 to rename · arrow keys to navigate · Del to delete
        </p>
      )}

      {deleteTarget && (
        <div className="cf-modal-backdrop">
          <div
            className="cf-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cf-delete-title"
          >
            <h3 id="cf-delete-title">Delete folder “{deleteTarget.folder.name}”?</h3>
            <p>
              {blocked
                ? `This folder contains ${deleteTarget.children.length} ${
                    deleteTarget.children.length === 1 ? "subfolder" : "subfolders"
                  } and ${deleteTarget.directCount} ${
                    deleteTarget.directCount === 1 ? "connection" : "connections"
                  }. Move or reassign them before deleting it.`
                : "This removes the empty folder. This action cannot be undone."}
            </p>
            <div className="cf-modal-actions">
              <button
                type="button"
                className="cf-btn cf-btn-ghost"
                autoFocus
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cf-btn cf-btn-danger"
                disabled={blocked || busy}
                onClick={confirmDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
