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
