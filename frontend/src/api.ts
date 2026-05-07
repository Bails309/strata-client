// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

const API_BASE = "/api";

/** Flag to prevent concurrent refresh attempts. */
let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

/**
 * Read a non-HttpOnly cookie value by name.
 *
 * Used to fish out the CSRF token cookie (which is intentionally readable
 * by JS). The HttpOnly access/refresh cookies are NOT readable here; they
 * travel automatically because every fetch in this module passes
 * `credentials: "include"`.
 */
export function readCookie(name: string): string | null {
  const target = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) return trimmed.slice(target.length);
  }
  return null;
}

/** Mutating HTTP methods that require an X-CSRF-Token header. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Build a headers object with the CSRF token attached when the request is
 * a state-changing method. Idempotent reads (GET/HEAD/OPTIONS) skip the
 * header — the backend exempts them too.
 */
function buildHeaders(
  method: string | undefined,
  base: Record<string, string> = {}
): Record<string, string> {
  const upper = (method ?? "GET").toUpperCase();
  if (!MUTATING_METHODS.has(upper)) return base;
  const csrf = readCookie("csrf_token");
  return csrf ? { ...base, "X-CSRF-Token": csrf } : base;
}

/**
 * Attempt to refresh the access token using the HttpOnly refresh cookie.
 *
 * Both access_token and csrf_token cookies are rotated server-side; we
 * just need to surface success/failure. No token value is ever stored in
 * JS-accessible storage.
 */
export async function refreshAccessToken(): Promise<boolean> {
  if (isRefreshing && refreshPromise) return refreshPromise;
  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = buildHeaders(options?.method, {
    "Content-Type": "application/json",
  });

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: "include" });

  // 401 → try refreshing once. Unlike the bearer flow, we can't tell from
  // JS whether a session cookie was actually sent, so always attempt
  // refresh on 401 (except on the refresh endpoint itself to avoid loops).
  if (res.status === 401 && path !== "/auth/refresh") {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      const retryHeaders = buildHeaders(options?.method, {
        "Content-Type": "application/json",
      });
      const retryRes = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: retryHeaders,
        credentials: "include",
      });
      if (!retryRes.ok) {
        const body = await retryRes.json().catch(() => ({}));
        throw new ApiError(retryRes.status, body.error || retryRes.statusText);
      }
      const retryText = await retryRes.text();
      return (retryText ? JSON.parse(retryText) : undefined) as T;
    }
    // Refresh failed — server-side cookies are already cleared by the
    // failure path. Bounce to login, unless we're already on a public
    // route (login / shared viewer) where forcing a navigation would
    // abort other in-flight requests (e.g. /api/status during page
    // bootstrap) and leave the page stuck on a loading spinner.
    if (typeof window !== "undefined") {
      const path = window.location.pathname;
      const isPublicRoute = path === "/login" || path.startsWith("/shared/");
      if (!isPublicRoute) {
        window.location.href = "/login";
      }
    }
    throw new ApiError(401, "Session expired");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || res.statusText);
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

// ── Setup / Initialize ──────────────────────────────────────────────

export interface InitRequest {
  vault_mode?: "local" | "external";
  vault_address?: string;
  vault_token?: string;
  vault_transit_key?: string;
}

export const initialize = (data: InitRequest) =>
  request<{ status: string }>("/setup/initialize", { method: "POST", body: JSON.stringify(data) });

// ── Health / Status ─────────────────────────────────────────────────

export interface StatusResponse {
  phase: "setup" | "running";
  sso_enabled: boolean;
  local_auth_enabled: boolean;
  vault_configured: boolean;
}

export const getStatus = () => request<StatusResponse>("/status");

// ── Auth ────────────────────────────────────────────────────────────

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  /** Echo of the access JWT. Cookie-mode logins ignore this — kept in the
   *  type for back-compat with non-browser API clients that still use the
   *  bearer-header path (e.g. integration scripts). */
  access_token: string;
  token_type: string;
  expires_in?: number;
  /** CSRF token mirrored into the response body for clients that can't
   *  read cookies (rare). The browser SPA reads it from the cookie. */
  csrf_token?: string;
  user: {
    id: string;
    username: string;
    role: string;
    can_manage_system: boolean;
    can_manage_users: boolean;
    can_manage_connections: boolean;
    can_view_audit_logs: boolean;
    can_create_users: boolean;
    can_create_user_groups: boolean;
    can_create_connections: boolean;
    can_use_quick_share: boolean;
    can_create_sharing_profiles: boolean;
    can_view_sessions: boolean;
  };
}

export const login = async (data: LoginRequest): Promise<LoginResponse> => {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || res.statusText);
  }
  return res.json();
};

export async function logout() {
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      headers: buildHeaders("POST"),
      credentials: "include",
    });
  } catch {
    // Best-effort — server-side cookies might not get cleared if this
    // throws, but the cookies are short-lived and SameSite=Strict so the
    // failure mode is acceptable.
  }
}

// ── Password Change ─────────────────────────────────────────────────

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export const changePassword = (data: ChangePasswordRequest) =>
  request<{ status: string }>("/auth/password", { method: "PUT", body: JSON.stringify(data) });

// ── Admin Password Reset ────────────────────────────────────────────

export const resetUserPassword = (userId: string) =>
  request<{ password: string }>(`/admin/users/${userId}/reset-password`, { method: "POST" });

// ── Current User ────────────────────────────────────────────────────

export interface MeResponse {
  id: string;
  username: string;
  full_name?: string;
  role: string;
  sub?: string;
  client_ip: string;
  watermark_enabled: boolean;
  vault_configured: boolean;
  terms_accepted_at?: string | null;
  terms_accepted_version?: number | null;
  can_manage_system: boolean;
  can_manage_users: boolean;
  can_manage_connections: boolean;
  can_view_audit_logs: boolean;
  can_create_users: boolean;
  can_create_user_groups: boolean;
  can_create_connections: boolean;
  can_use_quick_share: boolean;
  can_create_sharing_profiles: boolean;
  can_view_sessions: boolean;
  is_approver: boolean;
}

export const getMe = () => request<MeResponse>("/user/me");
export const acceptTerms = (version: number) =>
  request<{ ok: boolean }>("/user/accept-terms", {
    method: "POST",
    body: JSON.stringify({ version }),
  });

// ── User preferences (per-user UI settings) ─────────────────────────

/**
 * Free-form JSON object stored per-user. Frontend owns the schema; the
 * backend stores opaque JSON. Known keys today:
 *   - `commandPaletteBinding`: keybinding string, e.g. "Ctrl+K", "" to disable.
 */
export interface UserPreferences {
  commandPaletteBinding?: string;
  commandMappings?: CommandMapping[];
  [key: string]: unknown;
}

// ── Command palette mappings ────────────────────────────────────────

/** Allowed `path` values for a `open-page` command mapping. Mirror of the
 *  backend allow-list in `services/user_preferences.rs`. */
export const COMMAND_MAPPING_PAGES = [
  "/dashboard",
  "/profile",
  "/credentials",
  "/settings",
  "/admin",
  "/audit",
  "/recordings",
] as const;
export type CommandMappingPage = (typeof COMMAND_MAPPING_PAGES)[number];

export type CommandMappingAction =
  | { action: "open-connection"; args: { connection_id: string } }
  | { action: "open-folder"; args: { folder_id: string } }
  | { action: "open-tag"; args: { tag_id: string } }
  | { action: "open-page"; args: { path: CommandMappingPage } }
  | { action: "paste-text"; args: { text: string } }
  | { action: "open-path"; args: { path: string } };

/** Maximum number of characters in a `paste-text` mapping. Mirror of the
 *  backend `MAX_PASTE_TEXT_LEN` constant. */
export const MAX_PASTE_TEXT_LEN = 4096;

/** Maximum number of characters in an `open-path` mapping. Mirror of the
 *  backend `MAX_OPEN_PATH_LEN` constant. */
export const MAX_OPEN_PATH_LEN = 1024;

/** A single user-defined command-palette mapping (`:trigger` → action). */
export type CommandMapping = { trigger: string } & CommandMappingAction;

/** Built-in command names. User triggers may not collide with these.
 *  Keep this list in sync with `BUILTIN_COMMANDS` in
 *  `backend/src/services/user_preferences.rs` and `ALLOWED_AUDIT_ACTIONS`
 *  in `backend/src/routes/user.rs`. */
export const BUILTIN_COMMANDS = [
  "reload",
  "disconnect",
  "fullscreen",
  "commands",
  "close",
  "explorer",
] as const;
export type BuiltinCommand = (typeof BUILTIN_COMMANDS)[number];

/** Maximum number of mappings per user — kept in sync with the backend. */
export const MAX_COMMAND_MAPPINGS = 50;

/** Trigger validation regex shared by Profile UI and palette. */
export const COMMAND_TRIGGER_RE = /^[a-z0-9_-]{1,32}$/;

export const getUserPreferences = () => request<UserPreferences>("/user/preferences");

export const updateUserPreferences = (prefs: UserPreferences) =>
  request<UserPreferences>("/user/preferences", {
    method: "PUT",
    body: JSON.stringify(prefs),
  });

export interface CommandAuditPayload {
  trigger: string;
  action: string;
  args?: unknown;
  target_id?: string | null;
}

/** Fire-and-forget audit log of an executed `:command`. Errors are
 *  swallowed by the caller — auditing must never block the action. */
export const postCommandAudit = (payload: CommandAuditPayload) =>
  request<{ ok: boolean }>("/user/command-audit", {
    method: "POST",
    body: JSON.stringify(payload),
  });

// ── Roadmap status overrides ────────────────────────────────────────

export type RoadmapStatus = "Proposed" | "Researching" | "In Progress" | "Shipped";

export const getRoadmapStatuses = () =>
  request<{ statuses: Record<string, RoadmapStatus> }>("/roadmap");

export const setRoadmapStatus = (itemId: string, status: RoadmapStatus) =>
  request<{ ok: boolean; item_id: string; status: RoadmapStatus }>(
    `/admin/roadmap/${encodeURIComponent(itemId)}`,
    { method: "PUT", body: JSON.stringify({ status }) }
  );

/** Auth probe that always returns 200 (never 401) — used for initial page-load
 *  auth checks so the browser console stays clean. Returns the full user
 *  profile when authenticated. */
export interface AuthCheckResponse {
  authenticated: boolean;
  user?: MeResponse;
}
export async function checkAuthStatus(): Promise<AuthCheckResponse> {
  try {
    const res = await fetch(`${API_BASE}/auth/check`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
    if (res.ok) return res.json();
    return { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}

// ── Settings ────────────────────────────────────────────────────────

export const getSettings = () => request<Record<string, string>>("/admin/settings");

export const getDisplaySettings = () => request<Record<string, string>>("/user/display-settings");

export const updateSettings = (settings: Array<{ key: string; value: string }>) =>
  request<{ status: string }>("/admin/settings", {
    method: "PUT",
    body: JSON.stringify({ settings }),
  });

export interface AuthMethodsRequest {
  sso_enabled: boolean;
  local_auth_enabled: boolean;
}

export const updateAuthMethods = (data: AuthMethodsRequest) =>
  request<{ status: string }>("/admin/settings/auth-methods", {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const updateSso = (data: { issuer_url: string; client_id: string; client_secret: string }) =>
  request("/admin/settings/sso", { method: "PUT", body: JSON.stringify(data) });

export const testSsoConnection = (data: {
  issuer_url: string;
  client_id: string;
  client_secret: string;
}) =>
  request<{ status: string; message: string }>("/admin/settings/sso/test", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateKerberos = (data: {
  realm: string;
  kdc: string[];
  admin_server: string;
  ticket_lifetime: string;
  renew_lifetime: string;
}) => request("/admin/settings/kerberos", { method: "PUT", body: JSON.stringify(data) });

// ── Kerberos Realms (multi-domain) ──────────────────────────────────

export interface KerberosRealm {
  id: string;
  realm: string;
  kdc_servers: string;
  admin_server: string;
  ticket_lifetime: string;
  renew_lifetime: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  clone_from?: string;
}

export const getKerberosRealms = () => request<KerberosRealm[]>("/admin/kerberos-realms");

export const createKerberosRealm = (data: {
  realm: string;
  kdc_servers: string[];
  admin_server: string;
  ticket_lifetime?: string;
  renew_lifetime?: string;
  is_default?: boolean;
}) =>
  request<{ id: string; status: string }>("/admin/kerberos-realms", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateKerberosRealm = (
  id: string,
  data: {
    realm?: string;
    kdc_servers?: string[];
    admin_server?: string;
    ticket_lifetime?: string;
    renew_lifetime?: string;
    is_default?: boolean;
  }
) =>
  request<{ status: string }>(`/admin/kerberos-realms/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const deleteKerberosRealm = (id: string) =>
  request<{ status: string }>(`/admin/kerberos-realms/${id}`, { method: "DELETE" });

// ── AD Sync ─────────────────────────────────────────────────────────

export interface AdSyncConfig {
  id: string;
  label: string;
  ldap_url: string;
  bind_dn: string;
  bind_password: string;
  search_bases: string[];
  search_filter: string;
  search_scope: string;
  protocol: string;
  default_port: number;
  domain_override?: string;
  folder_id?: string;
  tls_skip_verify: boolean;
  sync_interval_minutes: number;
  enabled: boolean;
  auth_method: string;
  keytab_path?: string;
  krb5_principal?: string;
  ca_cert_pem?: string;
  connection_defaults?: Record<string, string>;
  // Password management fields
  pm_enabled?: boolean;
  pm_bind_user?: string;
  pm_bind_password?: string;
  pm_target_filter?: string;
  pm_pwd_min_length?: number;
  pm_pwd_require_uppercase?: boolean;
  pm_pwd_require_lowercase?: boolean;
  pm_pwd_require_numbers?: boolean;
  pm_pwd_require_symbols?: boolean;
  pm_auto_rotate_enabled?: boolean;
  pm_auto_rotate_interval_days?: number;
  pm_last_rotated_at?: string;
  pm_search_bases?: string[];
  pm_allow_emergency_bypass?: boolean;
  created_at: string;
  updated_at: string;
  clone_from?: string;
}

export interface AdSyncRun {
  id: string;
  config_id: string;
  started_at: string;
  finished_at?: string;
  status: string;
  created: number;
  updated: number;
  soft_deleted: number;
  hard_deleted: number;
  error_message?: string;
}

export const getAdSyncConfigs = () => request<AdSyncConfig[]>("/admin/ad-sync-configs");

export const createAdSyncConfig = (data: Partial<AdSyncConfig>) =>
  request<{ id: string; status: string }>("/admin/ad-sync-configs", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateAdSyncConfig = (id: string, data: Partial<AdSyncConfig>) =>
  request<{ status: string }>(`/admin/ad-sync-configs/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const deleteAdSyncConfig = (id: string) =>
  request<{ status: string }>(`/admin/ad-sync-configs/${id}`, { method: "DELETE" });

export const triggerAdSync = (id: string) =>
  request<{ run_id: string; status: string }>(`/admin/ad-sync-configs/${id}/sync`, {
    method: "POST",
  });

export const testAdSyncConnection = (data: Partial<AdSyncConfig>) =>
  request<{ status: string; message: string; count?: number; sample?: string[] }>(
    "/admin/ad-sync-configs/test",
    { method: "POST", body: JSON.stringify(data) }
  );

export const testPmTargetFilter = (data: Partial<AdSyncConfig>) =>
  request<{
    status: string;
    message: string;
    hint?: string;
    count?: number;
    sample?: { dn: string; name: string; description?: string }[];
  }>("/admin/ad-sync-configs/test-filter", { method: "POST", body: JSON.stringify(data) });

// ── Kubernetes (v1.4.0) ────────────────────────────────────────────
//
// The backend extracts cluster server, namespace, CA cert, client
// cert and client key from a pasted kubeconfig YAML. The private
// key is returned exactly once — the caller must immediately stash
// it in a credential profile (we never persist it on this path).
export interface ParsedKubeconfig {
  server?: string;
  namespace?: string;
  ca_cert_pem?: string;
  client_cert_pem?: string;
  client_key_pem?: string;
  current_context?: string;
  warnings: string[];
}

export const parseKubeconfig = (kubeconfig: string, context?: string) =>
  request<ParsedKubeconfig>("/admin/kubernetes/parse-kubeconfig", {
    method: "POST",
    body: JSON.stringify({ kubeconfig, context }),
  });

export const getAdSyncRuns = (configId: string) =>
  request<AdSyncRun[]>(`/admin/ad-sync-configs/${configId}/runs`);

// ── Password Management ─────────────────────────────────────────────

export interface ApprovalRole {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface UserAccountMapping {
  id: string;
  user_id: string;
  managed_ad_dn: string;
  friendly_name?: string;
  can_self_approve: boolean;
  ad_sync_config_id?: string;
  created_at: string;
  /** Set by /user/managed-accounts — indicates the parent AD sync config allows emergency bypass. */
  pm_allow_emergency_bypass?: boolean;
}

export interface CheckoutRequest {
  id: string;
  requester_user_id: string;
  managed_ad_dn: string;
  friendly_name?: string;
  ad_sync_config_id?: string;
  status: "Pending" | "Approved" | "Scheduled" | "Active" | "Expired" | "Denied" | "CheckedIn";
  requested_duration_mins: number;
  approved_by_user_id?: string;
  justification_comment?: string;
  expires_at?: string;
  scheduled_start_at?: string;
  vault_credential_id?: string;
  created_at: string;
  updated_at: string;
  requester_username?: string;
  emergency_bypass?: boolean;
}

export interface DiscoveredAccount {
  dn: string;
  name: string;
  friendly_name: string;
  description?: string;
}

// Admin: Approval Roles
export const getApprovalRoles = () => request<ApprovalRole[]>("/admin/approval-roles");
export const createApprovalRole = (data: { name: string; description?: string }) =>
  request<{ id: string; status: string }>("/admin/approval-roles", {
    method: "POST",
    body: JSON.stringify(data),
  });
export const updateApprovalRole = (id: string, data: { name?: string; description?: string }) =>
  request<{ status: string }>(`/admin/approval-roles/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
export const deleteApprovalRole = (id: string) =>
  request<{ status: string }>(`/admin/approval-roles/${id}`, { method: "DELETE" });

// Admin: Role assignments
export const getRoleAssignments = (roleId: string) =>
  request<{ id: string; username: string }[]>(`/admin/approval-roles/${roleId}/assignments`);
export const setRoleAssignments = (roleId: string, user_ids: string[]) =>
  request<{ status: string }>(`/admin/approval-roles/${roleId}/assignments`, {
    method: "PUT",
    body: JSON.stringify({ user_ids }),
  });

// Admin: Role account scope
export const getRoleAccounts = (roleId: string) =>
  request<string[]>(`/admin/approval-roles/${roleId}/accounts`);
export const setRoleAccounts = (
  roleId: string,
  managed_accounts: { dn: string; friendly_name?: string }[]
) =>
  request<{ status: string }>(`/admin/approval-roles/${roleId}/accounts`, {
    method: "PUT",
    body: JSON.stringify({ managed_accounts }),
  });

// Admin: Account mappings
export const getAccountMappings = () => request<UserAccountMapping[]>("/admin/account-mappings");
export const createAccountMapping = (data: {
  user_id: string;
  managed_ad_dn: string;
  friendly_name?: string;
  can_self_approve?: boolean;
  ad_sync_config_id?: string;
}) =>
  request<{ id: string; status: string }>("/admin/account-mappings", {
    method: "POST",
    body: JSON.stringify(data),
  });
export const deleteAccountMapping = (id: string) =>
  request<{ status: string }>(`/admin/account-mappings/${id}`, { method: "DELETE" });
export const updateAccountMapping = (
  id: string,
  data: { can_self_approve?: boolean; friendly_name?: string }
) =>
  request<{ status: string }>(`/admin/account-mappings/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

// Admin: Unmapped accounts
export const getUnmappedAccounts = (configId: string) =>
  request<DiscoveredAccount[]>(`/admin/ad-sync-configs/${configId}/unmapped-accounts`);

// Admin: Test rotation
export const testRotation = (config_id: string) =>
  request<{ success: boolean; message: string }>("/admin/pm/test-rotation", {
    method: "POST",
    body: JSON.stringify({ config_id }),
  });

// Admin: All checkout requests
export const getCheckoutRequests = () => request<CheckoutRequest[]>("/admin/checkout-requests");

// User: Managed accounts & checkouts
export const getMyManagedAccounts = () => request<UserAccountMapping[]>("/user/managed-accounts");
export const getMyCheckouts = () => request<CheckoutRequest[]>("/user/checkouts");
export const requestCheckout = (data: {
  managed_ad_dn: string;
  ad_sync_config_id?: string;
  requested_duration_mins?: number;
  justification_comment?: string;
  emergency_bypass?: boolean;
  scheduled_start_at?: string;
}) =>
  request<{ id: string; status: string; scheduled_start_at?: string }>("/user/checkouts", {
    method: "POST",
    body: JSON.stringify(data),
  });
export const decideCheckout = (id: string, approved: boolean) =>
  request<{ status: string }>(`/user/checkouts/${id}/decide`, {
    method: "POST",
    body: JSON.stringify({ approved }),
  });
export const revealCheckoutPassword = (id: string) =>
  request<{ password: string; expires_at?: string }>(`/user/checkouts/${id}/reveal`);
export const retryCheckoutActivation = (id: string) =>
  request<{ status: string }>(`/user/checkouts/${id}/retry`, { method: "POST" });
export const checkinCheckout = (id: string) =>
  request<{ status: string }>(`/user/checkouts/${id}/checkin`, { method: "POST" });
export const getPendingApprovals = () => request<CheckoutRequest[]>("/user/pending-approvals");

export const updateVault = (data: {
  mode: string;
  address?: string;
  token?: string;
  transit_key?: string;
}) => request("/admin/settings/vault", { method: "PUT", body: JSON.stringify(data) });

export const updateDns = (data: {
  dns_enabled: boolean;
  dns_servers: string;
  dns_search_domains: string;
}) =>
  request<{ status: string; restart_required: boolean; message: string }>("/admin/settings/dns", {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const updateRecordings = (data: {
  enabled: boolean;
  retention_days?: number;
  storage_type?: string;
  azure_account_name?: string;
  azure_container_name?: string;
  azure_access_key?: string;
}) => request("/admin/settings/recordings", { method: "PUT", body: JSON.stringify(data) });

// ── Service Health ──────────────────────────────────────────────────

export interface DatabaseHealth {
  connected: boolean;
  mode: string;
  host: string;
  latency_ms: number | null;
}

export interface GuacdHealth {
  reachable: boolean;
  host: string;
  port: number;
}

export interface VaultHealth {
  configured: boolean;
  mode: string;
  address: string;
}

export interface SchemaHealth {
  status: string;
  applied_migrations: number;
  expected_migrations: number;
}

export interface ServiceHealth {
  version?: string;
  database: DatabaseHealth;
  guacd: GuacdHealth;
  vault: VaultHealth;
  schema: SchemaHealth;
  uptime_secs: number;
  environment: string;
}

export const getServiceHealth = () => request<ServiceHealth>("/admin/health");

// ── Certificates ────────────────────────────────────────────────────

export interface CertificateEntry {
  source: string;
  category: string;
  subject: string;
  issuer: string;
  san: string[];
  not_before: string;
  not_after: string;
  days_remaining: number;
  fingerprint: string;
  expired: boolean;
  is_ca: boolean;
}

export interface CertificateError {
  source: string;
  error: string;
}

export interface CertificatesResponse {
  certificates: CertificateEntry[];
  errors: CertificateError[];
}

export const getCertificates = () => request<CertificatesResponse>("/admin/certs");

// ── Roles ───────────────────────────────────────────────────────────

export interface Role {
  id: string;
  name: string;
  can_manage_system: boolean;
  can_manage_users: boolean;
  can_manage_connections: boolean;
  can_view_audit_logs: boolean;
  can_create_users: boolean;
  can_create_user_groups: boolean;
  can_create_connections: boolean;
  can_use_quick_share: boolean;
  can_create_sharing_profiles: boolean;
  can_view_sessions: boolean;
}

export const getRoles = () => request<Role[]>("/admin/roles");

export const createRole = (data: Omit<Role, "id">) =>
  request<Role>("/admin/roles", { method: "POST", body: JSON.stringify(data) });

export const updateRole = (id: string, data: Partial<Omit<Role, "id">>) =>
  request<Role>(`/admin/roles/${id}`, { method: "PUT", body: JSON.stringify(data) });

export const deleteRole = (id: string) =>
  request<{ status: string }>(`/admin/roles/${id}`, { method: "DELETE" });

// ── Connections ─────────────────────────────────────────────────────

export interface Connection {
  id: string;
  name: string;
  protocol: string;
  hostname: string;
  port: number;
  domain?: string;
  description?: string;
  folder_id?: string;
  folder_name?: string;
  extra?: Record<string, string>;
  last_accessed?: string;
  watermark?: string;
  health_status?: "online" | "offline" | "unknown";
  health_checked_at?: string;
}

export const getConnections = () => request<Connection[]>("/admin/connections");

export const getMyConnections = () => request<Connection[]>("/user/connections");

export const createConnection = (data: Omit<Connection, "id">) =>
  request<Connection>("/admin/connections", { method: "POST", body: JSON.stringify(data) });

export const updateConnection = (id: string, data: Omit<Connection, "id">) =>
  request<Connection>(`/admin/connections/${id}`, { method: "PUT", body: JSON.stringify(data) });

export const deleteConnection = (id: string) =>
  request<{ status: string }>(`/admin/connections/${id}`, { method: "DELETE" });

// ── Connection Folders ───────────────────────────────────────────────

export interface ConnectionFolder {
  id: string;
  name: string;
  parent_id?: string;
}

export const getConnectionFolders = () => request<ConnectionFolder[]>("/admin/connection-folders");

export const createConnectionFolder = (data: { name: string; parent_id?: string }) =>
  request<ConnectionFolder>("/admin/connection-folders", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateConnectionFolder = (id: string, data: { name: string; parent_id?: string }) =>
  request<ConnectionFolder>(`/admin/connection-folders/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const deleteConnectionFolder = (id: string) =>
  request<{ status: string }>(`/admin/connection-folders/${id}`, { method: "DELETE" });

export const updateRoleConnections = (role_id: string, connection_ids: string[]) =>
  request("/admin/role-connections", {
    method: "PUT",
    body: JSON.stringify({ role_id, connection_ids }),
  });

// ── Users ───────────────────────────────────────────────────────────

export interface RoleMappings {
  connection_ids: string[];
  folder_ids: string[];
}

export const getRoleMappings = (roleId: string) =>
  request<RoleMappings>(`/admin/roles/${roleId}/mappings`);

// ── VDI image whitelist (rustguac parity Phase 3) ───────────────────

export interface VdiImageList {
  images: string[];
  count: number;
}

export const getVdiImages = () => request<VdiImageList>("/admin/vdi/images");

export const updateRoleMappings = (
  roleId: string,
  connection_ids: string[],
  folder_ids: string[]
) =>
  request<{ status: string }>(`/admin/roles/${roleId}/mappings`, {
    method: "PUT",
    body: JSON.stringify({ connection_ids, folder_ids }),
  });

export interface User {
  id: string;
  username: string;
  email: string;
  full_name?: string;
  auth_type: "local" | "sso";
  sub?: string;
  role_name: string;
  deleted_at?: string;
}

export interface CreateUserRequest {
  username: string;
  email: string;
  full_name?: string;
  role_id: string;
  auth_type: "local" | "sso";
}

export interface CreateUserResponse {
  id: string;
  username: string;
  password?: string; // Only for local users
}

export const getUsers = (includeDeleted = false) =>
  request<User[]>(`/admin/users${includeDeleted ? "?include_deleted=true" : ""}`);

export const createUser = (data: CreateUserRequest) =>
  request<CreateUserResponse>("/admin/users", { method: "POST", body: JSON.stringify(data) });

export const deleteUser = (id: string) =>
  request<{ status: string }>(`/admin/users/${id}`, { method: "DELETE" });

export const updateUser = (id: string, data: { role_id: string }) =>
  request<{ status: string }>(`/admin/users/${id}`, { method: "PUT", body: JSON.stringify(data) });

export const restoreUser = (id: string) =>
  request<{ status: string }>(`/admin/users/${id}`, { method: "POST" });

// ── Credentials ─────────────────────────────────────────────────────

export const updateCredential = (connection_id: string, password: string) =>
  request("/user/credentials", {
    method: "PUT",
    body: JSON.stringify({ connection_id, password }),
  });

// ── Credential Profiles ─────────────────────────────────────────────

export interface CredentialProfile {
  id: string;
  label: string;
  created_at: string;
  updated_at: string;
  clone_from?: string;
  expires_at: string;
  expired: boolean;
  ttl_hours: number;
  checkout_id?: string;
}

export interface CredentialMapping {
  connection_id: string;
  connection_name: string;
  protocol: string;
}

export const getCredentialProfiles = () =>
  request<CredentialProfile[]>("/user/credential-profiles");

export const createCredentialProfile = (
  label: string,
  username: string,
  password: string,
  ttl_hours?: number
) =>
  request<{ id: string; status: string }>("/user/credential-profiles", {
    method: "POST",
    body: JSON.stringify({ label, username, password, ttl_hours }),
  });

export const updateCredentialProfile = (
  profileId: string,
  data: { label?: string; username?: string; password?: string; ttl_hours?: number }
) =>
  request<{ status: string }>(`/user/credential-profiles/${profileId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const deleteCredentialProfile = (profileId: string) =>
  request<{ status: string }>(`/user/credential-profiles/${profileId}`, { method: "DELETE" });

export const getProfileMappings = (profileId: string) =>
  request<CredentialMapping[]>(`/user/credential-profiles/${profileId}/mappings`);

export const setCredentialMapping = (profile_id: string, connection_id: string) =>
  request<{ status: string }>("/user/credential-mappings", {
    method: "PUT",
    body: JSON.stringify({ profile_id, connection_id }),
  });

export const removeCredentialMapping = (connectionId: string) =>
  request<{ status: string }>(`/user/credential-mappings/${connectionId}`, { method: "DELETE" });

export const linkCheckoutToProfile = (profileId: string, checkoutId: string | null) =>
  request<{ status: string; checkout_id?: string; managed_ad_dn?: string; expires_at?: string }>(
    `/user/credential-profiles/${profileId}/link-checkout`,
    { method: "POST", body: JSON.stringify({ checkout_id: checkoutId }) }
  );

// ── Connection info (pre-connect credential check) ──────────────────

export interface ConnectionInfo {
  protocol: string;
  has_credentials: boolean;
  ignore_cert?: boolean;
  watermark?: string;
  file_transfer_enabled?: boolean;
  expired_profile?: {
    id: string;
    label: string;
    ttl_hours: number;
    managed_ad_dn?: string;
    ad_sync_config_id?: string;
    can_self_approve: boolean;
  };
}

export const getConnectionInfo = (connectionId: string) =>
  request<ConnectionInfo>(`/user/connections/${connectionId}/info`);

// ── Audit Logs ──────────────────────────────────────────────────────

export interface AuditLog {
  id: number;
  created_at: string;
  user_id?: string;
  username?: string;
  action_type: string;
  details: Record<string, unknown>;
  current_hash: string;
  connection_name?: string;
}

export const getAuditLogs = (page = 1, per_page = 50) =>
  request<AuditLog[]>(`/admin/audit-logs?page=${page}&per_page=${per_page}`);

// ── Tunnel Tickets ──────────────────────────────────────────────────

export interface CreateTunnelTicketRequest {
  connection_id: string;
  username?: string;
  password?: string;
  credential_profile_id?: string;
  width?: number;
  height?: number;
  dpi?: number;
  ignore_cert?: boolean;
}

export const createTunnelTicket = (body: CreateTunnelTicketRequest) =>
  request<{ ticket: string }>("/tunnel/ticket", {
    method: "POST",
    body: JSON.stringify(body),
  });

// ── Connection Sharing ──────────────────────────────────────────────

export interface ShareLinkResponse {
  share_token: string;
  share_url: string;
  mode: "view" | "control";
}

export const createShareLink = (connectionId: string, mode: "view" | "control" = "view") =>
  request<ShareLinkResponse>(`/user/connections/${connectionId}/share`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });

export const revokeShareLink = (shareId: string) =>
  request<{ status: string }>(`/user/shares/${shareId}`, { method: "DELETE" });

// ── Favorites ───────────────────────────────────────────────────────

export const getFavorites = () => request<string[]>("/user/favorites");

export const toggleFavorite = (connectionId: string) =>
  request<{ favorited: boolean }>("/user/favorites", {
    method: "POST",
    body: JSON.stringify({ connection_id: connectionId }),
  });

// ── User Tags ───────────────────────────────────────────────────────

export interface UserTag {
  id: string;
  name: string;
  color: string;
}

export const getTags = () => request<UserTag[]>("/user/tags");

export const createTag = (name: string, color?: string) =>
  request<UserTag>("/user/tags", {
    method: "POST",
    body: JSON.stringify({ name, color }),
  });

export const updateTag = (tagId: string, data: { name?: string; color?: string }) =>
  request<UserTag>(`/user/tags/${tagId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const deleteTag = (tagId: string) =>
  request<{ ok: boolean }>(`/user/tags/${tagId}`, { method: "DELETE" });

/** Returns { [connection_id]: tag_id[] } */
export const getConnectionTags = () => request<Record<string, string[]>>("/user/connection-tags");

export const setConnectionTags = (connectionId: string, tagIds: string[]) =>
  request<{ ok: boolean }>("/user/connection-tags", {
    method: "POST",
    body: JSON.stringify({ connection_id: connectionId, tag_ids: tagIds }),
  });

// ── Display Tags (pinned tag per connection for session sidebar) ────

/** Returns { connection_id: { id, name, color } } */
export const getDisplayTags = () => request<Record<string, UserTag>>("/user/display-tags");

export const setDisplayTag = (connectionId: string, tagId: string) =>
  request<{ ok: boolean }>("/user/display-tags", {
    method: "POST",
    body: JSON.stringify({ connection_id: connectionId, tag_id: tagId }),
  });

export const removeDisplayTag = (connectionId: string) =>
  request<{ ok: boolean }>(`/user/display-tags/${connectionId}`, {
    method: "DELETE",
  });

/** Read-only access to admin-managed global tags (for dashboard display). */
export const getAdminTags = () => request<UserTag[]>("/user/admin-tags");

/** Read-only admin connection-tag mappings: { connection_id: tag_id[] }. */
export const getAdminConnectionTags = () =>
  request<Record<string, string[]>>("/user/admin-connection-tags");

// ── Admin Tag Management ────────────────────────────────────────────

export const getAdminTagsAdmin = () => request<UserTag[]>("/admin/tags");

export const createAdminTag = (name: string, color?: string) =>
  request<UserTag>("/admin/tags", {
    method: "POST",
    body: JSON.stringify({ name, color }),
  });

export const updateAdminTag = (tagId: string, data: { name?: string; color?: string }) =>
  request<UserTag>(`/admin/tags/${tagId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const deleteAdminTag = (tagId: string) =>
  request<{ ok: boolean }>(`/admin/tags/${tagId}`, { method: "DELETE" });

export const getAdminConnectionTagsAdmin = () =>
  request<Record<string, string[]>>("/admin/connection-tags");

export const setAdminConnectionTags = (connectionId: string, tagIds: string[]) =>
  request<{ ok: boolean }>("/admin/connection-tags", {
    method: "POST",
    body: JSON.stringify({ connection_id: connectionId, tag_ids: tagIds }),
  });

// ── Active Sessions / NVR ───────────────────────────────────────────

export interface ActiveSession {
  session_id: string;
  connection_id: string;
  connection_name: string;
  protocol: string;
  user_id: string;
  username: string;
  started_at: string;
  buffer_depth_secs: number;
  bytes_from_guacd: number;
  bytes_to_guacd: number;
  remote_host: string;
  client_ip: string;
}

export const getActiveSessions = () => request<ActiveSession[]>("/admin/sessions");

export const getMyActiveSessions = () => request<ActiveSession[]>("/user/sessions");

export const killSessions = (session_ids: string[]) =>
  request<{ status: string; killed_count: number }>("/admin/sessions/kill", {
    method: "POST",
    body: JSON.stringify({ session_ids }),
  });

// ── Historical Recordings ───────────────────────────────────────────

export interface HistoricalRecording {
  id: string;
  session_id: string;
  connection_id: string;
  connection_name: string;
  user_id: string;
  username: string;
  started_at: string;
  duration_secs: number | null;
  storage_path: string;
  storage_type: "local" | "azure";
}

export const getRecordings = (
  params: { user_id?: string; connection_id?: string; limit?: number; offset?: number } = {}
) => {
  const q = new URLSearchParams();
  if (params.user_id) q.set("user_id", params.user_id);
  if (params.connection_id) q.set("connection_id", params.connection_id);
  if (params.limit) q.set("limit", String(params.limit));
  if (params.offset) q.set("offset", String(params.offset));
  return request<HistoricalRecording[]>(`/admin/recordings?${q.toString()}`);
};

/**
 * Build a WebSocket URL for historical recording playback.
 *
 * Authentication travels via the HttpOnly `access_token` cookie that the
 * browser attaches automatically to the WebSocket upgrade request — we
 * no longer embed the JWT in the query string.
 */
export function buildRecordingStreamUrl(recordingId: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/admin/recordings/${encodeURIComponent(recordingId)}/stream`;
}

// ── My Recordings (user-scoped) ─────────────────────────────────────

export const getMyRecordings = (
  params: { connection_id?: string; limit?: number; offset?: number } = {}
) => {
  const q = new URLSearchParams();
  if (params.connection_id) q.set("connection_id", params.connection_id);
  if (params.limit) q.set("limit", String(params.limit));
  if (params.offset) q.set("offset", String(params.offset));
  return request<HistoricalRecording[]>(`/user/recordings?${q.toString()}`);
};

export function buildMyRecordingStreamUrl(recordingId: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/user/recordings/${encodeURIComponent(recordingId)}/stream`;
}

/**
 * Ensure the access token cookie is fresh by proactively calling refresh.
 *
 * WebSocket connections can't use the request<>retry interceptor (the
 * upgrade is one-shot), so callers proactively call this before opening
 * the socket to avoid a stale-cookie 401 mid-stream. Returns true if a
 * usable session is in place; false if the user must reauthenticate.
 */
export async function ensureFreshToken(): Promise<boolean> {
  return refreshAccessToken();
}

/**
 * Build a WebSocket URL for the NVR observe endpoint.
 * Refreshes the access cookie first to avoid stale-session disconnects.
 */
export async function buildNvrObserveUrl(
  sessionId: string,
  offsetSecs = 300,
  speed = 4
): Promise<string> {
  await ensureFreshToken();
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  params.set("offset", String(offsetSecs));
  params.set("speed", String(speed));
  return `${proto}//${window.location.host}/api/admin/sessions/${encodeURIComponent(sessionId)}/observe?${params}`;
}

/**
 * Build a WebSocket URL for the user-scoped NVR observe endpoint.
 * Only allows observing the authenticated user's own sessions.
 */
export async function buildUserNvrObserveUrl(
  sessionId: string,
  offsetSecs = 300,
  speed = 4
): Promise<string> {
  await ensureFreshToken();
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  params.set("offset", String(offsetSecs));
  params.set("speed", String(speed));
  return `${proto}//${window.location.host}/api/user/sessions/${encodeURIComponent(sessionId)}/observe?${params}`;
}

// ── Metrics ─────────────────────────────────────────────────────────

export interface MetricsSummary {
  active_sessions: number;
  total_bytes_from_guacd: number;
  total_bytes_to_guacd: number;
  sessions_by_protocol: Record<string, number>;
  guacd_pool_size: number;
  recommended_per_instance: number;
  system_total_memory: number;
  system_cpu_cores: number;
}

export const getMetrics = () => request<MetricsSummary>("/admin/metrics");

// ── DMZ links ───────────────────────────────────────────────────────

export interface DmzLinkRow {
  endpoint: string;
  state: string;
  ready: boolean;
  last_error: string | null;
  since_unix_secs: number;
  connects: number;
  failures: number;
}

export interface DmzLinksResponse {
  configured: boolean;
  links: DmzLinkRow[];
}

export const getDmzLinks = () => request<DmzLinksResponse>("/admin/dmz-links");

export const reconnectDmzLinks = () =>
  request<{ nudged: number }>("/admin/dmz-links/reconnect", { method: "POST" });

// ── Session Statistics ──────────────────────────────────────────────

export interface TopConnection {
  name: string;
  protocol: string;
  sessions: number;
  total_hours: number;
}

export interface TopUser {
  username: string;
  sessions: number;
  total_hours: number;
  last_session: string | null;
}

export interface DailyTrend {
  date: string;
  sessions: number;
  hours: number;
  unique_users: number;
}

export interface ProtocolDistribution {
  protocol: string;
  sessions: number;
  total_hours: number;
}

export interface PeakHour {
  hour: number;
  sessions: number;
}

export interface SessionStats {
  total_sessions: number;
  total_hours: number;
  unique_users: number;
  active_now: number;
  avg_duration_mins: number;
  median_duration_mins: number;
  total_bandwidth_bytes: number;
  top_connections: TopConnection[];
  top_users: TopUser[];
  daily_trend: DailyTrend[];
  protocol_distribution: ProtocolDistribution[];
  peak_hours: PeakHour[];
}

export const getSessionStats = () => request<SessionStats>("/admin/session-stats");

// ── Quick Share (temporary file CDN) ────────────────────────────────

export interface QuickShareFile {
  token: string;
  filename: string;
  size: number;
  content_type: string;
  download_url: string;
  created_at?: string;
}

export async function uploadQuickShareFile(sessionId: string, file: File): Promise<QuickShareFile> {
  const form = new FormData();
  form.append("session_id", sessionId);
  form.append("file", file);

  // multipart upload — don't set Content-Type; let the browser pick the
  // boundary. We DO need the CSRF header though (mutating method).
  const res = await fetch(`${API_BASE}/files/upload`, {
    method: "POST",
    headers: buildHeaders("POST"),
    credentials: "include",
    body: form,
  });

  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      // Re-read CSRF header in case the cookie rotated on refresh.
      const retry = await fetch(`${API_BASE}/files/upload`, {
        method: "POST",
        headers: buildHeaders("POST"),
        credentials: "include",
        body: form,
      });
      if (!retry.ok) {
        const body = await retry.json().catch(() => ({}));
        throw new ApiError(retry.status, body.error || retry.statusText);
      }
      return retry.json();
    }
    throw new ApiError(401, "Session expired");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || res.statusText);
  }
  return res.json();
}

export const listQuickShareFiles = (sessionId: string) =>
  request<QuickShareFile[]>(`/files/session/${sessionId}`);

export const deleteQuickShareFile = (token: string) =>
  request<void>(`/files/delete/${token}`, { method: "DELETE" });

// ── Notifications / SMTP (v0.25.0+) ─────────────────────────────────

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  tls_mode: string; // "starttls" | "implicit" | "none"
  from_address: string;
  from_name: string;
  password_set: boolean;
  branding_accent_color: string;
}

export interface EmailDelivery {
  id: string;
  template_key: string;
  recipient_email: string;
  subject: string;
  status: string; // queued | sent | failed | bounced | suppressed
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export const getSmtpConfig = () => request<SmtpConfig>("/admin/notifications/smtp");

/**
 * Explicit three-state action for the SMTP password on update. The wire
 * format remains a simple optional string (`undefined` = keep, `""` = clear,
 * non-empty = replace) but callers interact with a discriminated union so
 * intent is unambiguous — no more "did I mean empty-string-to-clear or
 * forget-to-send-to-keep?" bugs.
 */
export type SmtpPasswordUpdate =
  | { action: "keep" }
  | { action: "clear" }
  | { action: "set"; value: string };

export interface SmtpConfigUpdate {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: SmtpPasswordUpdate;
  tls_mode: string;
  from_address: string;
  from_name: string;
  branding_accent_color: string;
}

function serializeSmtpPassword(p: SmtpPasswordUpdate): string | undefined {
  switch (p.action) {
    case "keep":
      return undefined;
    case "clear":
      return "";
    case "set":
      return p.value;
  }
}

export const updateSmtpConfig = (body: SmtpConfigUpdate) =>
  request<{ status: string }>("/admin/notifications/smtp", {
    method: "PUT",
    body: JSON.stringify({
      enabled: body.enabled,
      host: body.host,
      port: body.port,
      username: body.username,
      password: serializeSmtpPassword(body.password),
      tls_mode: body.tls_mode,
      from_address: body.from_address,
      from_name: body.from_name,
      branding_accent_color: body.branding_accent_color,
    }),
  });

export const testSmtpSend = (recipient: string, templateKey?: string) =>
  request<{ status: string }>("/admin/notifications/test-send", {
    method: "POST",
    body: JSON.stringify(templateKey ? { recipient, template_key: templateKey } : { recipient }),
  });

export const listEmailDeliveries = (status?: string, limit = 50) => {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  params.set("limit", String(limit));
  return request<EmailDelivery[]>(`/admin/notifications/deliveries?${params.toString()}`);
};

// -- Trusted CA bundles ----------------------------------------------
export interface TrustedCaSummary {
  id: string;
  name: string;
  description: string;
  subject: string | null;
  not_after: string | null;
  fingerprint: string | null;
  created_at: string;
  updated_at: string;
}
export interface TrustedCaPickerEntry {
  id: string;
  name: string;
  subject: string | null;
}
export const getTrustedCas = () => request<TrustedCaSummary[]>("/admin/trusted-cas");
export const createTrustedCa = (body: { name: string; description: string; pem: string }) =>
  request<TrustedCaSummary>("/admin/trusted-cas", { method: "POST", body: JSON.stringify(body) });
export const updateTrustedCa = (
  id: string,
  body: { name?: string; description?: string; pem?: string }
) =>
  request<TrustedCaSummary>(`/admin/trusted-cas/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
export const deleteTrustedCa = (id: string) =>
  request<{ status: string }>(`/admin/trusted-cas/${id}`, { method: "DELETE" });
export const getTrustedCasForPicker = () => request<TrustedCaPickerEntry[]>("/user/trusted-cas");
