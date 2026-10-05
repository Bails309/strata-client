/* In-memory stand-ins for the paged list endpoints, applying the same
   filters, ordering and paging as the backend. Tests keep mocking the full
   lists they always did and route the paged API through these. */
import type {
  AdminConnectionFilters,
  Connection,
  ConnectionFacets,
  ConnectionFolder,
  ConnectionRef,
  FleetSummary,
  MyConnectionFilters,
  Page,
  User,
  UserPageFilters,
} from "../api";

const contains = (haystack: (string | number | null | undefined)[], needle?: string) =>
  !needle ||
  haystack
    .filter((v) => v !== null && v !== undefined && v !== "")
    .join("\n")
    .toLowerCase()
    .includes(needle.toLowerCase());

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

function paginate<T>(rows: T[], page: number, perPage: number): Page<T> {
  const start = (Math.max(1, page) - 1) * perPage;
  return { items: rows.slice(start, start + perPage), total: rows.length };
}

function subtree(folders: ConnectionFolder[], root: string): Set<string> {
  const out = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

export function adminMatches(
  all: Connection[],
  folders: ConnectionFolder[],
  f: AdminConnectionFilters = {}
): Connection[] {
  const folderName = new Map(folders.map((x) => [x.id, x.name]));
  const inFolder = f.folder && f.folder !== "unfiled" ? subtree(folders, f.folder) : null;
  return all
    .filter((c) => {
      if (f.protocol && c.protocol !== f.protocol) return false;
      if (f.folder === "unfiled" && c.folder_id) return false;
      if (inFolder && !(c.folder_id && inFolder.has(c.folder_id))) return false;
      if (f.health) {
        const h =
          c.health_status === "online" || c.health_status === "offline"
            ? c.health_status
            : "unknown";
        if (h !== f.health) return false;
      }
      return contains(
        [
          c.name,
          c.hostname,
          c.port,
          c.description,
          c.folder_id ? folderName.get(c.folder_id) : null,
          c.protocol,
        ],
        f.search
      );
    })
    .sort(byName);
}

export const adminPage = (
  all: Connection[],
  folders: ConnectionFolder[],
  page: number,
  perPage: number,
  f: AdminConnectionFilters = {}
) => paginate(adminMatches(all, folders, f), page, perPage);

export const toRefs = (rows: Connection[]): ConnectionRef[] =>
  rows.map((c) => ({
    id: c.id,
    name: c.name,
    protocol: c.protocol,
    hostname: c.hostname,
    port: c.port,
    folder_id: c.folder_id ?? null,
    url: c.extra?.url ?? null,
  }));

export function fleetSummary(all: Connection[]): FleetSummary {
  const legacy = (c: Connection) =>
    (c.protocol === "rdp" || c.protocol === "vdi") && c.extra?.security === "rdp";
  const mode = (c: Connection) => (c.extra?.["host-key-policy"] ?? "").trim().toLowerCase();
  const unverified = (c: Connection) => c.protocol === "ssh" && mode(c) === "none";
  const unpinned = (c: Connection) =>
    c.protocol === "ssh" && !c.extra?.["host-key"] && mode(c) !== "none";
  const cert = (c: Connection) => c.extra?.["ignore-cert"] === "true";
  const protocols = new Map<string, number>();
  for (const c of all) protocols.set(c.protocol, (protocols.get(c.protocol) ?? 0) + 1);
  const sweeps = all.map((c) => c.health_checked_at).filter((t): t is string => !!t);
  return {
    total: all.length,
    online: all.filter((c) => c.health_status === "online").length,
    offline: all.filter((c) => c.health_status === "offline").length,
    alert_count: all.filter((c) => legacy(c) || unpinned(c) || unverified(c) || cert(c)).length,
    legacy_sec: all.filter(legacy).length,
    unpinned: all.filter(unpinned).length,
    host_key_unverified: all.filter(unverified).length,
    cert_ignored: all.filter(cert).length,
    last_sweep: sweeps.sort().pop() ?? null,
    protocols: [...protocols].map(([protocol, count]) => ({ protocol, count })),
  };
}

export function usersPage(
  all: User[],
  page: number,
  perPage: number,
  f: UserPageFilters = {}
): Page<User> {
  const rows = all.filter(
    (u) =>
      !!u.deleted_at === !!f.deleted &&
      contains([u.username, u.email, u.full_name, u.role_name, u.sub], f.search)
  );
  return paginate(rows, page, perPage);
}

export interface MyConnectionScope {
  favorites?: Iterable<string>;
  /** Tag ids by connection id, user and admin tags together. */
  tags?: Record<string, string[]>;
}

function myMatches(
  all: Connection[],
  f: MyConnectionFilters,
  scope: MyConnectionScope,
  withScope = true
): Connection[] {
  const favs = new Set(scope.favorites ?? []);
  return all
    .filter((c) => {
      if (!contains([c.name, c.hostname, c.description, c.folder_name, c.protocol], f.search))
        return false;
      if (!withScope) return true;
      if (f.protocol && c.protocol.toLowerCase() !== f.protocol.toLowerCase()) return false;
      if (f.favorites && !favs.has(c.id)) return false;
      if (f.tag && !(scope.tags?.[c.id] ?? []).includes(f.tag)) return false;
      return true;
    })
    .sort(byName);
}

export function myConnectionsPage(
  all: Connection[],
  page: number,
  perPage: number,
  f: MyConnectionFilters = {},
  scope: MyConnectionScope = {}
): Page<Connection> {
  let rows = myMatches(all, f, scope);
  if (f.folder === "none") rows = rows.filter((c) => !c.folder_id);
  else if (f.folder) rows = rows.filter((c) => c.folder_id === f.folder);
  if (f.ids) {
    const ids = new Set(f.ids.split(","));
    rows = rows.filter((c) => ids.has(c.id));
  }
  if (f.sort === "recent")
    rows = rows
      .filter((c) => c.last_accessed)
      .sort((a, b) => Date.parse(b.last_accessed!) - Date.parse(a.last_accessed!));
  if (f.after === undefined) {
    const p = paginate(rows, page, perPage);
    return p.items.length === perPage ? { ...p, next: p.items[perPage - 1].id } : p;
  }
  // The fake's cursor is the id of the last row sent.
  const items = rows.slice(rows.findIndex((c) => c.id === f.after) + 1).slice(0, perPage);
  return {
    items,
    total: rows.length,
    next: items.length === perPage ? items[perPage - 1].id : undefined,
  };
}

export function myConnectionFacets(
  all: Connection[],
  f: MyConnectionFilters = {},
  scope: MyConnectionScope = {}
): ConnectionFacets {
  const rows = myMatches(all, f, scope);
  const folders = new Map<string | null, number>();
  for (const c of rows)
    folders.set(c.folder_id ?? null, (folders.get(c.folder_id ?? null) ?? 0) + 1);
  return {
    total: rows.length,
    search_total: myMatches(all, { search: f.search }, scope, false).length,
    all_total: all.length,
    protocols: [...new Set(all.map((c) => c.protocol))],
    folders: [...folders].map(([folder_id, count]) => ({ folder_id, count })),
  };
}
