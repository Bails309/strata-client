// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('access_token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || res.statusText);
  }

  return res.json();
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ── Setup / Initialize ──────────────────────────────────────────────

export interface InitRequest {
  vault_mode?: 'local' | 'external';
  vault_address?: string;
  vault_token?: string;
  vault_transit_key?: string;
}

export const initialize = (data: InitRequest) =>
  request<{ status: string }>('/setup/initialize', { method: 'POST', body: JSON.stringify(data) });

// ── Health / Status ─────────────────────────────────────────────────

export interface StatusResponse {
  phase: 'setup' | 'running';
  database_connected: boolean;
  vault_configured: boolean;
}

export const getStatus = () => request<StatusResponse>('/status');

// ── Auth ────────────────────────────────────────────────────────────

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user: {
    id: string;
    username: string;
    role: string;
  };
}

export const login = (data: LoginRequest) =>
  request<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify(data) });

export function logout() {
  localStorage.removeItem('access_token');
}

// ── Settings ────────────────────────────────────────────────────────

export const getSettings = () => request<Record<string, string>>('/admin/settings');

export const updateSettings = (settings: { key: string; value: string }[]) =>
  request('/admin/settings', { method: 'PUT', body: JSON.stringify({ settings }) });

export const updateSso = (data: { issuer_url: string; client_id: string; client_secret: string }) =>
  request('/admin/settings/sso', { method: 'PUT', body: JSON.stringify(data) });

export const updateKerberos = (data: { realm: string; kdc: string[]; admin_server: string; ticket_lifetime: string; renew_lifetime: string }) =>
  request('/admin/settings/kerberos', { method: 'PUT', body: JSON.stringify(data) });

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
}

export const getKerberosRealms = () =>
  request<KerberosRealm[]>('/admin/kerberos-realms');

export const createKerberosRealm = (data: {
  realm: string;
  kdc_servers: string[];
  admin_server: string;
  ticket_lifetime?: string;
  renew_lifetime?: string;
  is_default?: boolean;
}) =>
  request<{ id: string; status: string }>('/admin/kerberos-realms', {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const updateKerberosRealm = (id: string, data: {
  realm?: string;
  kdc_servers?: string[];
  admin_server?: string;
  ticket_lifetime?: string;
  renew_lifetime?: string;
  is_default?: boolean;
}) =>
  request<{ status: string }>(`/admin/kerberos-realms/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

export const deleteKerberosRealm = (id: string) =>
  request<{ status: string }>(`/admin/kerberos-realms/${id}`, { method: 'DELETE' });

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
  group_id?: string;
  tls_skip_verify: boolean;
  sync_interval_minutes: number;
  enabled: boolean;
  auth_method: string;
  keytab_path?: string;
  krb5_principal?: string;
  ca_cert_pem?: string;
  created_at: string;
  updated_at: string;
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

export const getAdSyncConfigs = () => request<AdSyncConfig[]>('/admin/ad-sync-configs');

export const createAdSyncConfig = (data: Partial<AdSyncConfig>) =>
  request<{ id: string; status: string }>('/admin/ad-sync-configs', { method: 'POST', body: JSON.stringify(data) });

export const updateAdSyncConfig = (id: string, data: Partial<AdSyncConfig>) =>
  request<{ status: string }>(`/admin/ad-sync-configs/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const deleteAdSyncConfig = (id: string) =>
  request<{ status: string }>(`/admin/ad-sync-configs/${id}`, { method: 'DELETE' });

export const triggerAdSync = (id: string) =>
  request<{ run_id: string; status: string }>(`/admin/ad-sync-configs/${id}/sync`, { method: 'POST' });

export const testAdSyncConnection = (data: Partial<AdSyncConfig>) =>
  request<{ status: string; message: string; count?: number; sample?: string[] }>('/admin/ad-sync-configs/test', { method: 'POST', body: JSON.stringify(data) });

export const getAdSyncRuns = (configId: string) =>
  request<AdSyncRun[]>(`/admin/ad-sync-configs/${configId}/runs`);

export const updateVault = (data: { mode: string; address?: string; token?: string; transit_key?: string }) =>
  request('/admin/settings/vault', { method: 'PUT', body: JSON.stringify(data) });

export const updateRecordings = (data: {
  enabled: boolean;
  retention_days?: number;
  storage_type?: string;
  azure_account_name?: string;
  azure_container_name?: string;
  azure_access_key?: string;
}) =>
  request('/admin/settings/recordings', { method: 'PUT', body: JSON.stringify(data) });

// ── Service Health ──────────────────────────────────────────────────

export interface DatabaseHealth {
  connected: boolean;
  mode: string;
  host: string;
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

export interface ServiceHealth {
  database: DatabaseHealth;
  guacd: GuacdHealth;
  vault: VaultHealth;
}

export const getServiceHealth = () => request<ServiceHealth>('/admin/health');

// ── Roles ───────────────────────────────────────────────────────────

export interface Role {
  id: string;
  name: string;
}

export const getRoles = () => request<Role[]>('/admin/roles');
export const createRole = (name: string) =>
  request<Role>('/admin/roles', { method: 'POST', body: JSON.stringify({ name }) });

// ── Connections ─────────────────────────────────────────────────────

export interface Connection {
  id: string;
  name: string;
  protocol: string;
  hostname: string;
  port: number;
  domain?: string;
  description?: string;
  group_id?: string;
  group_name?: string;
  extra?: Record<string, string>;
  last_accessed?: string;
}

export const getConnections = () => request<Connection[]>('/admin/connections');

export const getMyConnections = () => request<Connection[]>('/user/connections');

export const createConnection = (data: Omit<Connection, 'id'>) =>
  request<Connection>('/admin/connections', { method: 'POST', body: JSON.stringify(data) });

export const updateConnection = (id: string, data: Omit<Connection, 'id'>) =>
  request<Connection>(`/admin/connections/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const deleteConnection = (id: string) =>
  request<{ status: string }>(`/admin/connections/${id}`, { method: 'DELETE' });

// ── Connection Groups ───────────────────────────────────────────────

export interface ConnectionGroup {
  id: string;
  name: string;
  parent_id?: string;
}

export const getConnectionGroups = () => request<ConnectionGroup[]>('/admin/connection-groups');

export const createConnectionGroup = (data: { name: string; parent_id?: string }) =>
  request<ConnectionGroup>('/admin/connection-groups', { method: 'POST', body: JSON.stringify(data) });

export const updateConnectionGroup = (id: string, data: { name: string; parent_id?: string }) =>
  request<ConnectionGroup>(`/admin/connection-groups/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const deleteConnectionGroup = (id: string) =>
  request<{ status: string }>(`/admin/connection-groups/${id}`, { method: 'DELETE' });

export const updateRoleConnections = (role_id: string, connection_ids: string[]) =>
  request('/admin/role-connections', {
    method: 'PUT',
    body: JSON.stringify({ role_id, connection_ids }),
  });

// ── Users ───────────────────────────────────────────────────────────

export interface User {
  id: string;
  username: string;
  sub?: string;
  role_name: string;
}

export const getUsers = () => request<User[]>('/admin/users');

// ── Credentials ─────────────────────────────────────────────────────

export const updateCredential = (connection_id: string, password: string) =>
  request('/user/credentials', {
    method: 'PUT',
    body: JSON.stringify({ connection_id, password }),
  });

// ── Credential Profiles ─────────────────────────────────────────────

export interface CredentialProfile {
  id: string;
  label: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  expired: boolean;
  ttl_hours: number;
}

export interface CredentialMapping {
  connection_id: string;
  connection_name: string;
  protocol: string;
}

export const getCredentialProfiles = () =>
  request<CredentialProfile[]>('/user/credential-profiles');

export const createCredentialProfile = (label: string, username: string, password: string, ttl_hours?: number) =>
  request<{ id: string; status: string }>('/user/credential-profiles', {
    method: 'POST',
    body: JSON.stringify({ label, username, password, ttl_hours }),
  });

export const updateCredentialProfile = (profileId: string, data: { label?: string; username?: string; password?: string; ttl_hours?: number }) =>
  request<{ status: string }>(`/user/credential-profiles/${profileId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

export const deleteCredentialProfile = (profileId: string) =>
  request<{ status: string }>(`/user/credential-profiles/${profileId}`, { method: 'DELETE' });

export const getProfileMappings = (profileId: string) =>
  request<CredentialMapping[]>(`/user/credential-profiles/${profileId}/mappings`);

export const setCredentialMapping = (profile_id: string, connection_id: string) =>
  request<{ status: string }>('/user/credential-mappings', {
    method: 'PUT',
    body: JSON.stringify({ profile_id, connection_id }),
  });

export const removeCredentialMapping = (connectionId: string) =>
  request<{ status: string }>(`/user/credential-mappings/${connectionId}`, { method: 'DELETE' });

// ── Connection info (pre-connect credential check) ──────────────────

export interface ConnectionInfo {
  protocol: string;
  has_credentials: boolean;
}

export const getConnectionInfo = (connectionId: string) =>
  request<ConnectionInfo>(`/user/connections/${connectionId}/info`);

// ── Audit Logs ──────────────────────────────────────────────────────

export interface AuditLog {
  id: number;
  created_at: string;
  user_id?: string;
  action_type: string;
  details: Record<string, unknown>;
  current_hash: string;
}

export const getAuditLogs = (page = 1, per_page = 50) =>
  request<AuditLog[]>(`/admin/audit-logs?page=${page}&per_page=${per_page}`);

// ── Tunnel WebSocket ────────────────────────────────────────────────

export function createTunnelWebSocket(connectionId: string): WebSocket {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = localStorage.getItem('access_token');
  const url = `${proto}//${window.location.host}/api/tunnel/${connectionId}${token ? `?token=${token}` : ''}`;
  return new WebSocket(url);
}

// ── Connection Sharing ──────────────────────────────────────────────

export interface ShareLinkResponse {
  share_token: string;
  share_url: string;
  mode: 'view' | 'control';
}

export const createShareLink = (connectionId: string, mode: 'view' | 'control' = 'view') =>
  request<ShareLinkResponse>(`/user/connections/${connectionId}/share`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });

export const revokeShareLink = (shareId: string) =>
  request<{ status: string }>(`/user/shares/${shareId}`, { method: 'DELETE' });

// ── Favorites ───────────────────────────────────────────────────────

export const getFavorites = () => request<string[]>('/user/favorites');

export const toggleFavorite = (connectionId: string) =>
  request<{ favorited: boolean }>('/user/favorites', {
    method: 'POST',
    body: JSON.stringify({ connection_id: connectionId }),
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
}

export const getActiveSessions = () => request<ActiveSession[]>('/admin/sessions');

/**
 * Build a WebSocket URL for the NVR observe endpoint.
 * @param sessionId  The active session to observe
 * @param offsetSecs How many seconds of buffer to replay (0 = live only)
 */
export function buildNvrObserveUrl(sessionId: string, offsetSecs = 300): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = localStorage.getItem('access_token');
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  params.set('offset', String(offsetSecs));
  return `${proto}//${window.location.host}/api/admin/sessions/${encodeURIComponent(sessionId)}/observe?${params}`;
}

// ── Metrics ─────────────────────────────────────────────────────────

export interface MetricsSummary {
  active_sessions: number;
  total_bytes_from_guacd: number;
  total_bytes_to_guacd: number;
  sessions_by_protocol: Record<string, number>;
  guacd_pool_size: number;
}

export const getMetrics = () => request<MetricsSummary>('/admin/metrics');
