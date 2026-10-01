import type { Role } from "../../../api";

export type RoleFlag =
  | "can_manage_system"
  | "can_manage_users"
  | "can_manage_connections"
  | "can_view_audit_logs"
  | "can_create_users"
  | "can_create_user_groups"
  | "can_create_connections"
  | "can_use_quick_share"
  | "can_use_quick_share_outbound"
  | "can_create_sharing_profiles"
  | "can_view_sessions";

export type RiskTier = "critical" | "elevated" | "standard";

export interface PermissionDefinition {
  flag: RoleFlag;
  name: string;
  description: string;
  risk: RiskTier;
}

export interface PermissionCategory {
  id: string;
  title: string;
  permissions: PermissionDefinition[];
}

export const PERMISSION_CATEGORIES: PermissionCategory[] = [
  {
    id: "platform",
    title: "Platform & system administration",
    permissions: [
      {
        flag: "can_manage_system",
        name: "Administer system",
        description:
          "Full platform control: settings, authentication providers, Vault, roles and infrastructure. Passes every other admin check.",
        risk: "critical",
      },
      {
        flag: "can_manage_connections",
        name: "Manage all connections",
        description:
          "Edit and delete every connection, and open all of them regardless of folder or connection assignments.",
        risk: "critical",
      },
      {
        flag: "can_manage_users",
        name: "Manage users",
        description:
          "Create, edit, delete and restore users and reset their passwords. Without Full system access, a holder can only assign roles and manage users whose permissions they already hold, and cannot act on their own account.",
        risk: "critical",
      },
      {
        flag: "can_create_users",
        name: "Create new users",
        description:
          "Opens the user admin area. Creating or editing a user also needs Manage users — the server does not act on this permission alone.",
        risk: "elevated",
      },
      {
        flag: "can_create_user_groups",
        name: "Create new roles",
        description:
          "Opens the roles admin area. Creating, editing or deleting a role needs Administer system — the server does not act on this permission alone.",
        risk: "elevated",
      },
      {
        flag: "can_create_connections",
        name: "Create new connections",
        description:
          "Opens the connections admin area. Adding or changing connections and folders needs Manage all connections — the server does not act on this permission alone.",
        risk: "elevated",
      },
    ],
  },
  {
    id: "audit",
    title: "Audit & observability",
    permissions: [
      {
        flag: "can_view_audit_logs",
        name: "Audit system",
        description: "Read the hash-chained audit log and monitor administrative activity.",
        risk: "elevated",
      },
      {
        flag: "can_view_sessions",
        name: "Monitor sessions",
        description:
          "See every active session, watch any of them live, terminate them, and open session recordings.",
        risk: "elevated",
      },
    ],
  },
  {
    id: "transfer",
    title: "Data loss prevention & file transfer",
    permissions: [
      {
        flag: "can_use_quick_share",
        name: "Use Inbound Quick Share",
        description: "Upload files into an active session.",
        risk: "standard",
      },
      {
        flag: "can_use_quick_share_outbound",
        name: "Use Outbound Quick Share",
        description:
          "Export files out of a session. Every submission needs approval unless the user is opted out in the Users table.",
        risk: "elevated",
      },
    ],
  },
  {
    id: "collaboration",
    title: "Session collaboration",
    permissions: [
      {
        flag: "can_create_sharing_profiles",
        name: "Sharing connections",
        description: "Share active RDP / SSH sessions with other people.",
        risk: "elevated",
      },
    ],
  },
];

export const ROLE_FLAGS: RoleFlag[] = PERMISSION_CATEGORIES.flatMap((c) =>
  c.permissions.map((p) => p.flag)
);

export type RoleDraft = { name: string; description: string } & Record<RoleFlag, boolean>;

/** The built-in roles; the backend refuses to delete them. */
export const isSystemRole = (role: Pick<Role, "name"> | null) =>
  role?.name === "admin" || role?.name === "user";

/**
 * Whether Administer system already covers this flag. Outbound uploads
 * re-check the role's own flag at consume time, so it is not covered.
 */
export const impliedBySystem = (flag: RoleFlag) =>
  flag !== "can_manage_system" && flag !== "can_use_quick_share_outbound";

export function draftFromRole(role: Role | null): RoleDraft {
  const draft = { name: role?.name ?? "", description: role?.description ?? "" } as RoleDraft;
  for (const flag of ROLE_FLAGS) draft[flag] = role ? !!role[flag] : false;
  return draft;
}

/** Holders of these flags already open every connection, whatever is assigned. */
export const grantsAllConnections = (draft: RoleDraft) =>
  draft.can_manage_system || draft.can_manage_connections;

/**
 * Connections a role reaches through its folder grants.
 *
 * Mirrors the backend check (`role_folders.folder_id = connections.folder_id`):
 * a folder grant covers only connections filed directly in it, not ones in
 * its subfolders.
 */
export function inheritedConnectionIds(
  folderIds: ReadonlySet<string>,
  connections: { id: string; folder_id?: string | null }[]
): Set<string> {
  const out = new Set<string>();
  for (const c of connections) {
    if (c.folder_id && folderIds.has(c.folder_id)) out.add(c.id);
  }
  return out;
}

/** Number of members in exactly one of the two sets. */
export function symmetricDifferenceSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const x of a) if (!b.has(x)) n++;
  for (const x of b) if (!a.has(x)) n++;
  return n;
}
