/**
 * Helpers for rendering a flat connection-folder list as a hierarchy.
 *
 * The backend returns folders as a flat array with `parent_id`. UI surfaces
 * (folder dropdowns, parent pickers, role-folder checklists) need them
 * displayed in hierarchical order with the parent immediately followed by
 * its children, indented by depth — otherwise nested folders appear scattered
 * across the alphabetical list and admins can't tell where a sub-folder
 * actually lives.
 */

import type { ConnectionFolder } from "../api";

export interface OrderedFolder {
  folder: ConnectionFolder;
  /** 0 = root, 1 = child, 2 = grandchild, etc. */
  depth: number;
}

/**
 * Return folders in depth-first preorder (parent → its children → next parent),
 * with siblings sorted alphabetically by name. Folders whose `parent_id` does
 * not resolve to a known folder are treated as roots so they remain visible
 * even with stale data.
 */
export function orderFoldersByHierarchy(folders: ConnectionFolder[]): OrderedFolder[] {
  const byParent = new Map<string | null, ConnectionFolder[]>();
  const known = new Set(folders.map((f) => f.id));
  for (const f of folders) {
    const key = f.parent_id && known.has(f.parent_id) ? f.parent_id : null;
    const bucket = byParent.get(key) ?? [];
    bucket.push(f);
    byParent.set(key, bucket);
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name));
  }

  const out: OrderedFolder[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const children = byParent.get(parentId) ?? [];
    for (const f of children) {
      out.push({ folder: f, depth });
      visit(f.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

/** Indented label for use in `<Select>` options. Uses `└ ` for non-root rows. */
export function indentedFolderLabel(name: string, depth: number): string {
  if (depth === 0) return name;
  return `${"\u00A0\u00A0".repeat(depth - 1)}└ ${name}`;
}

export interface FolderNode {
  folder: ConnectionFolder;
  children: FolderNode[];
  /** Connections filed directly in this folder. */
  directCount: number;
  /** Connections in this folder and every descendant. */
  totalCount: number;
}

/**
 * Nest a flat folder list into a tree (siblings sorted by name) and attach
 * direct/total connection counts. Unknown parents are treated as roots, and a
 * `parent_id` cycle cannot recurse forever because each folder is placed once.
 */
export function buildFolderTree(
  folders: ConnectionFolder[],
  connections: { folder_id?: string | null }[] = []
): FolderNode[] {
  const direct = new Map<string, number>();
  for (const c of connections) {
    if (c.folder_id) direct.set(c.folder_id, (direct.get(c.folder_id) ?? 0) + 1);
  }
  const nodes = new Map<string, FolderNode>(
    folders.map((f) => [
      f.id,
      { folder: f, children: [], directCount: direct.get(f.id) ?? 0, totalCount: 0 },
    ])
  );
  const roots: FolderNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.folder.parent_id ? nodes.get(node.folder.parent_id) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  const visited = new Set<string>();
  const finish = (list: FolderNode[]): number => {
    list.sort((a, b) => a.folder.name.localeCompare(b.folder.name));
    let sum = 0;
    for (const n of list) {
      if (visited.has(n.folder.id)) continue;
      visited.add(n.folder.id);
      n.totalCount = n.directCount + finish(n.children);
      sum += n.totalCount;
    }
    return sum;
  };
  finish(roots);
  return roots;
}
