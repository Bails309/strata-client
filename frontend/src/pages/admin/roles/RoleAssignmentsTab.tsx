import { Fragment, useMemo, useState } from "react";
import type { ConnectionFolder, ConnectionRef } from "../../../api";
import EnterpriseCheckbox from "../../../components/EnterpriseCheckbox";
import { buildFolderTree, type FolderNode } from "../../../utils/folderTree";

interface Props {
  folders: ConnectionFolder[];
  connections: ConnectionRef[];
  folderIds: ReadonlySet<string>;
  connectionIds: ReadonlySet<string>;
  inherited: ReadonlySet<string>;
  grantsAll: boolean;
  onToggleFolder: (id: string) => void;
  onToggleConnection: (id: string) => void;
}

const INDENT = 20;
const UNFILED = "__unfiled__";

const targetOf = (c: ConnectionRef) =>
  (c.protocol === "web" ? c.url : undefined) || c.hostname || "—";

export default function RoleAssignmentsTab({
  folders,
  connections,
  folderIds,
  connectionIds,
  inherited,
  grantsAll,
  onToggleFolder,
  onToggleConnection,
}: Props) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildFolderTree(folders, connections), [folders, connections]);
  const byFolder = useMemo(() => {
    const map = new Map<string, ConnectionRef[]>();
    for (const c of [...connections].sort((a, b) => a.name.localeCompare(b.name))) {
      const key = c.folder_id && folders.some((f) => f.id === c.folder_id) ? c.folder_id : UNFILED;
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    return map;
  }, [connections, folders]);

  const q = search.trim().toLowerCase();
  const connMatches = (c: ConnectionRef) =>
    !q || c.name.toLowerCase().includes(q) || targetOf(c).toLowerCase().includes(q);

  // Folders to show while searching: a match, or an ancestor of one.
  const visible = useMemo(() => {
    if (!q) return null;
    const keep = new Set<string>();
    const visit = (node: FolderNode): boolean => {
      const self = node.folder.name.toLowerCase().includes(q);
      const conns = (byFolder.get(node.folder.id) ?? []).some(
        (c) => c.name.toLowerCase().includes(q) || targetOf(c).toLowerCase().includes(q)
      );
      let child = false;
      for (const n of node.children) child = visit(n) || child;
      const show = self || conns || child;
      if (show) keep.add(node.folder.id);
      return show;
    };
    tree.forEach(visit);
    return keep;
  }, [q, tree, byFolder]);

  const allFolderIds = useMemo(() => folders.map((f) => f.id).concat(UNFILED), [folders]);
  const isOpen = (id: string) => q !== "" || !collapsed.has(id);
  const toggleOpen = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const reachable = new Set([...inherited, ...connectionIds]);
  const directOnly = [...connectionIds].filter((id) => !inherited.has(id)).length;

  const renderConnection = (c: ConnectionRef, depth: number) => {
    const isInherited = inherited.has(c.id);
    const isDirect = connectionIds.has(c.id);
    return (
      <li
        key={c.id}
        className="role-tree-row role-tree-conn"
        style={{ paddingLeft: depth * INDENT + 30 }}
      >
        <label className="role-tree-main">
          <EnterpriseCheckbox
            as="span"
            checked={isInherited || isDirect}
            disabled={isInherited}
            onCheckedChange={() => onToggleConnection(c.id)}
            aria-label={`Grant connection ${c.name}`}
          />
          <span className={`role-proto role-proto-${c.protocol}`}>{c.protocol.toUpperCase()}</span>
          <span className="role-tree-name">{c.name}</span>
          <span className="role-tree-target">{targetOf(c)}</span>
        </label>
        <span className="role-tree-status">
          {isInherited && isDirect ? (
            <>
              <span className="role-status-inherited">Inherited · also granted directly</span>
              <button
                type="button"
                className="role-link"
                onClick={() => onToggleConnection(c.id)}
                aria-label={`Remove direct grant for ${c.name}`}
              >
                Remove direct
              </button>
            </>
          ) : isInherited ? (
            <span className="role-status-inherited">Inherited from folder</span>
          ) : isDirect ? (
            <span className="role-status-direct">Direct grant</span>
          ) : (
            <span className="role-status-none">Not assigned</span>
          )}
        </span>
      </li>
    );
  };

  const renderFolder = (node: FolderNode, depth: number, parentGranted: boolean) => {
    const { folder } = node;
    if (visible && !visible.has(folder.id)) return null;
    const granted = folderIds.has(folder.id);
    const open = isOpen(folder.id);
    const conns = (byFolder.get(folder.id) ?? []).filter(
      (c) => !q || folder.name.toLowerCase().includes(q) || connMatches(c)
    );
    const expandable = node.children.length > 0 || conns.length > 0;
    return (
      <Fragment key={folder.id}>
        <li
          className={`role-tree-row role-tree-folder${granted ? " role-tree-granted" : ""}`}
          style={{ paddingLeft: depth * INDENT + 8 }}
        >
          <span className="role-tree-main">
            {expandable ? (
              <button
                type="button"
                className="role-chevron-btn"
                aria-expanded={open}
                aria-label={`${open ? "Collapse" : "Expand"} ${folder.name}`}
                onClick={() => toggleOpen(folder.id)}
              >
                <svg
                  className={`role-chevron${open ? " role-chevron-open" : ""}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  aria-hidden
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            ) : (
              <span className="role-chevron-spacer" />
            )}
            <label className="role-tree-label">
              <EnterpriseCheckbox
                as="span"
                checked={granted}
                onCheckedChange={() => onToggleFolder(folder.id)}
                aria-label={`Grant folder ${folder.name}`}
              />
              <svg
                className="role-folder-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span className="role-tree-name role-tree-folder-name">{folder.name}</span>
            </label>
          </span>
          <span className="role-tree-status">
            {granted ? (
              <span className="role-status-direct">
                Folder grant · {node.directCount} connection{node.directCount === 1 ? "" : "s"}
              </span>
            ) : parentGranted ? (
              <span className="role-status-warn" title="Folder grants do not include subfolders">
                Not covered by parent folder
              </span>
            ) : (
              <span className="role-status-none">
                {node.directCount} connection{node.directCount === 1 ? "" : "s"}
              </span>
            )}
          </span>
        </li>
        {open && expandable && (
          <li className="role-tree-group">
            <ul style={{ ["--guide-left" as string]: `${depth * INDENT + 16}px` }}>
              {node.children.map((child) => renderFolder(child, depth + 1, granted))}
              {conns.map((c) => renderConnection(c, depth))}
            </ul>
          </li>
        )}
      </Fragment>
    );
  };

  const unfiled = (byFolder.get(UNFILED) ?? []).filter(connMatches);
  const unfiledOpen = isOpen(UNFILED);
  const nothing = connections.length === 0 && folders.length === 0;
  const noMatches = q !== "" && (visible?.size ?? 0) === 0 && unfiled.length === 0;

  return (
    <div className="role-tab-body">
      {grantsAll && (
        <p className="role-banner" role="note">
          This role already opens every connection through <strong>Administer system</strong> or{" "}
          <strong>Manage all connections</strong>. Assignments below add nothing until those are
          removed.
        </p>
      )}

      <div className="role-toolbar">
        <label className="role-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter folders and connections…"
            aria-label="Filter folders and connections"
          />
        </label>
        <div className="role-toolbar-actions">
          <button type="button" className="role-link" onClick={() => setCollapsed(new Set())}>
            Expand all
          </button>
          <button
            type="button"
            className="role-link"
            onClick={() => setCollapsed(new Set(allFolderIds))}
          >
            Collapse all
          </button>
        </div>
      </div>

      <p className="role-summary" aria-live="polite">
        {reachable.size} connection{reachable.size === 1 ? "" : "s"} reachable · {inherited.size}{" "}
        via {folderIds.size} folder{folderIds.size === 1 ? "" : "s"} · {directOnly} direct
      </p>

      <div className="role-tree-card">
        <div className="role-tree-caption">
          Target hierarchy &amp; asset scope
          <span>A folder grant covers the connections filed in it, not its subfolders.</span>
        </div>
        {nothing ? (
          <p className="role-empty">No folders or connections exist yet.</p>
        ) : noMatches ? (
          <p className="role-empty">Nothing matches &quot;{search}&quot;.</p>
        ) : (
          <ul className="role-tree" aria-label="Folders and connections">
            {tree.map((node) => renderFolder(node, 0, false))}
            {unfiled.length > 0 && (
              <>
                <li className="role-tree-row role-tree-folder" style={{ paddingLeft: 8 }}>
                  <span className="role-tree-main">
                    <button
                      type="button"
                      className="role-chevron-btn"
                      aria-expanded={unfiledOpen}
                      aria-label={`${unfiledOpen ? "Collapse" : "Expand"} connections not in a folder`}
                      onClick={() => toggleOpen(UNFILED)}
                    >
                      <svg
                        className={`role-chevron${unfiledOpen ? " role-chevron-open" : ""}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        aria-hidden
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </button>
                    <span className="role-tree-name role-tree-unfiled">Not in a folder</span>
                  </span>
                  <span className="role-tree-status">
                    <span className="role-status-none">Assign individually</span>
                  </span>
                </li>
                {unfiledOpen && (
                  <li className="role-tree-group">
                    <ul style={{ ["--guide-left" as string]: "16px" }}>
                      {unfiled.map((c) => renderConnection(c, 0))}
                    </ul>
                  </li>
                )}
              </>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
