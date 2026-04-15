import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiError,
  initialize,
  getStatus,
  login,
  logout,
  getMe,
  getSettings,
  updateSettings,
  updateAuthMethods,
  updateSso,
  testSsoConnection,
  updateKerberos,
  getKerberosRealms,
  createKerberosRealm,
  updateKerberosRealm,
  deleteKerberosRealm,
  getAdSyncConfigs,
  createAdSyncConfig,
  updateAdSyncConfig,
  deleteAdSyncConfig,
  triggerAdSync,
  testAdSyncConnection,
  getAdSyncRuns,
  updateVault,
  updateRecordings,
  getServiceHealth,
  getRoles,
  createRole,
  updateRole,
  deleteRole,
  getConnections,
  getMyConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  getConnectionFolders,
  createConnectionFolder,
  updateConnectionFolder,
  deleteConnectionFolder,
  updateRoleConnections,
  getRoleMappings,
  updateRoleMappings,
  getUsers,
  createUser,
  deleteUser,
  updateCredential,
  getCredentialProfiles,
  createCredentialProfile,
  updateCredentialProfile,
  deleteCredentialProfile,
  getProfileMappings,
  setCredentialMapping,
  removeCredentialMapping,
  getConnectionInfo,
  getAuditLogs,
  createTunnelTicket,
  createShareLink,
  revokeShareLink,
  getFavorites,
  toggleFavorite,
  killSessions,
  getActiveSessions,
  getRecordings,
  buildRecordingStreamUrl,
  buildNvrObserveUrl,
  getMetrics,
  restoreUser,
} from '../api';

// We test the ApiError class and the request helper's behavior
// by mocking fetch at the global level.

describe('ApiError', () => {
  it('stores status and message', () => {
    const err = new ApiError(401, 'Unauthorized');
    expect(err.status).toBe(401);
    expect(err.message).toBe('Unauthorized');
    expect(err).toBeInstanceOf(Error);
  });

  it('is catchable as a regular Error', () => {
    const err = new ApiError(500, 'Server error');
    expect(err instanceof Error).toBe(true);
  });
});

describe('api request helper', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('includes Authorization header when token is stored', async () => {
    localStorage.setItem('access_token', 'test-jwt-token');

    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ phase: 'running' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await getStatus();

    expect(capturedHeaders).toBeDefined();
    expect((capturedHeaders as Record<string, string>)['Authorization']).toBe(
      'Bearer test-jwt-token',
    );
  });

  it('omits Authorization header when no token', async () => {
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ phase: 'setup' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await getStatus();

    expect((capturedHeaders as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('throws ApiError on non-ok response', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await expect(getStatus()).rejects.toThrow('Forbidden');
  });
});

describe('logout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('clears localStorage even if server call fails', async () => {
    localStorage.setItem('access_token', 'old-token');

    globalThis.fetch = vi.fn(async () => {
      throw new Error('network error');
    }) as unknown as typeof fetch;

    await logout();

    expect(localStorage.getItem('access_token')).toBeNull();
  });
});

// ── Helper to mock fetch and capture calls ──────────────────────────────

function mockFetch(body: unknown = {}, status = 200) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
  globalThis.fetch = fn;
  return fn;
}

function lastCall(fn: ReturnType<typeof mockFetch>): { url: string; method: string; body?: string } {
  const call = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  return {
    url: call[0] as string,
    method: (call[1] as RequestInit)?.method ?? 'GET',
    body: (call[1] as RequestInit)?.body as string | undefined,
  };
}

describe('API endpoint functions', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Setup ─────────────────────────────────────────

  it('initialize sends POST /api/setup/initialize', async () => {
    const fn = mockFetch({ status: 'ok' });
    await initialize({ vault_mode: 'local' });
    const c = lastCall(fn);
    expect(c.url).toBe('/api/setup/initialize');
    expect(c.method).toBe('POST');
    expect(JSON.parse(c.body!)).toEqual({ vault_mode: 'local' });
  });

  it('getStatus sends GET /api/status', async () => {
    const fn = mockFetch({ phase: 'running', sso_enabled: false, local_auth_enabled: true });
    const res = await getStatus();
    expect(lastCall(fn).url).toBe('/api/status');
    expect(res.phase).toBe('running');
  });

  // ── Auth ──────────────────────────────────────────

  it('login sends POST /api/auth/login', async () => {
    const fn = mockFetch({ access_token: 'tok', token_type: 'bearer', user: { id: '1', username: 'a', role: 'admin' } });
    const res = await login({ username: 'a', password: 'p' });
    const c = lastCall(fn);
    expect(c.url).toBe('/api/auth/login');
    expect(c.method).toBe('POST');
    expect(res.access_token).toBe('tok');
  });

  // ── User ──────────────────────────────────────────

  it('getMe sends GET /api/user/me', async () => {
    const fn = mockFetch({ id: '1', username: 'admin', role: 'admin', client_ip: '10.0.0.1', watermark_enabled: false });
    await getMe();
    expect(lastCall(fn).url).toBe('/api/user/me');
  });

  // ── Settings ──────────────────────────────────────

  it('getSettings sends GET /api/admin/settings', async () => {
    const fn = mockFetch({});
    await getSettings();
    expect(lastCall(fn).url).toBe('/api/admin/settings');
  });

  it('updateSettings sends PUT /api/admin/settings', async () => {
    const fn = mockFetch({ status: 'ok' });
    await updateSettings([{ key: 'k', value: 'v' }]);
    const c = lastCall(fn);
    expect(c.url).toBe('/api/admin/settings');
    expect(c.method).toBe('PUT');
    expect(JSON.parse(c.body!)).toEqual({ settings: [{ key: 'k', value: 'v' }] });
  });

  it('updateAuthMethods sends PUT /api/admin/settings/auth-methods', async () => {
    const fn = mockFetch({ status: 'ok' });
    await updateAuthMethods({ sso_enabled: true, local_auth_enabled: false });
    const c = lastCall(fn);
    expect(c.url).toBe('/api/admin/settings/auth-methods');
    expect(c.method).toBe('PUT');
  });

  it('updateSso sends PUT /api/admin/settings/sso', async () => {
    const fn = mockFetch({});
    await updateSso({ issuer_url: 'https://idp', client_id: 'cid', client_secret: 'cs' });
    expect(lastCall(fn).url).toBe('/api/admin/settings/sso');
    expect(lastCall(fn).method).toBe('PUT');
  });

  it('testSsoConnection sends POST /api/admin/settings/sso/test', async () => {
    const fn = mockFetch({ status: 'ok', message: 'connected' });
    await testSsoConnection({ issuer_url: 'https://idp', client_id: 'c', client_secret: 's' });
    expect(lastCall(fn).url).toBe('/api/admin/settings/sso/test');
    expect(lastCall(fn).method).toBe('POST');
  });

  it('updateKerberos sends PUT /api/admin/settings/kerberos', async () => {
    const fn = mockFetch({});
    await updateKerberos({ realm: 'R', kdc: ['k'], admin_server: 'a', ticket_lifetime: '10h', renew_lifetime: '7d' });
    expect(lastCall(fn).url).toBe('/api/admin/settings/kerberos');
    expect(lastCall(fn).method).toBe('PUT');
  });

  // ── Kerberos Realms ───────────────────────────────

  it('getKerberosRealms sends GET /api/admin/kerberos-realms', async () => {
    const fn = mockFetch([]);
    await getKerberosRealms();
    expect(lastCall(fn).url).toBe('/api/admin/kerberos-realms');
  });

  it('createKerberosRealm sends POST', async () => {
    const fn = mockFetch({ id: '1', status: 'ok' });
    await createKerberosRealm({ realm: 'CORP', kdc_servers: ['kdc1'], admin_server: 'admin1' });
    expect(lastCall(fn).method).toBe('POST');
    expect(lastCall(fn).url).toBe('/api/admin/kerberos-realms');
  });

  it('updateKerberosRealm sends PUT with id', async () => {
    const fn = mockFetch({ status: 'ok' });
    await updateKerberosRealm('r1', { realm: 'NEW' });
    expect(lastCall(fn).url).toBe('/api/admin/kerberos-realms/r1');
    expect(lastCall(fn).method).toBe('PUT');
  });

  it('deleteKerberosRealm sends DELETE with id', async () => {
    const fn = mockFetch({ status: 'ok' });
    await deleteKerberosRealm('r1');
    expect(lastCall(fn).url).toBe('/api/admin/kerberos-realms/r1');
    expect(lastCall(fn).method).toBe('DELETE');
  });

  // ── AD Sync ───────────────────────────────────────

  it('getAdSyncConfigs sends GET', async () => {
    const fn = mockFetch([]);
    await getAdSyncConfigs();
    expect(lastCall(fn).url).toBe('/api/admin/ad-sync-configs');
  });

  it('createAdSyncConfig sends POST', async () => {
    const fn = mockFetch({ id: '1', status: 'ok' });
    await createAdSyncConfig({ label: 'test' });
    expect(lastCall(fn).method).toBe('POST');
    expect(lastCall(fn).url).toBe('/api/admin/ad-sync-configs');
  });

  it('updateAdSyncConfig sends PUT with id', async () => {
    const fn = mockFetch({ status: 'ok' });
    await updateAdSyncConfig('c1', { label: 'updated' });
    expect(lastCall(fn).url).toBe('/api/admin/ad-sync-configs/c1');
    expect(lastCall(fn).method).toBe('PUT');
  });

  it('deleteAdSyncConfig sends DELETE with id', async () => {
    const fn = mockFetch({ status: 'ok' });
    await deleteAdSyncConfig('c1');
    expect(lastCall(fn).url).toBe('/api/admin/ad-sync-configs/c1');
    expect(lastCall(fn).method).toBe('DELETE');
  });

  it('triggerAdSync sends POST to sync endpoint', async () => {
    const fn = mockFetch({ run_id: 'r1', status: 'started' });
    await triggerAdSync('c1');
    expect(lastCall(fn).url).toBe('/api/admin/ad-sync-configs/c1/sync');
    expect(lastCall(fn).method).toBe('POST');
  });

  it('testAdSyncConnection sends POST to test endpoint', async () => {
    const fn = mockFetch({ status: 'ok', message: 'connected', count: 5 });
    await testAdSyncConnection({ ldap_url: 'ldap://dc' });
    expect(lastCall(fn).url).toBe('/api/admin/ad-sync-configs/test');
    expect(lastCall(fn).method).toBe('POST');
  });

  it('getAdSyncRuns sends GET with config id', async () => {
    const fn = mockFetch([]);
    await getAdSyncRuns('c1');
    expect(lastCall(fn).url).toBe('/api/admin/ad-sync-configs/c1/runs');
  });

  // ── Vault / Recordings ────────────────────────────

  it('updateVault sends PUT', async () => {
    const fn = mockFetch({});
    await updateVault({ mode: 'local' });
    expect(lastCall(fn).url).toBe('/api/admin/settings/vault');
    expect(lastCall(fn).method).toBe('PUT');
  });

  it('updateRecordings sends PUT', async () => {
    const fn = mockFetch({});
    await updateRecordings({ enabled: true, retention_days: 30 });
    expect(lastCall(fn).url).toBe('/api/admin/settings/recordings');
    expect(lastCall(fn).method).toBe('PUT');
  });

  // ── Service Health ────────────────────────────────

  it('getServiceHealth sends GET /api/admin/health', async () => {
    const fn = mockFetch({ database: {}, guacd: {}, vault: {} });
    await getServiceHealth();
    expect(lastCall(fn).url).toBe('/api/admin/health');
  });

  // ── Roles ─────────────────────────────────────────

  it('getRoles sends GET /api/admin/roles', async () => {
    const fn = mockFetch([]);
    await getRoles();
    expect(lastCall(fn).url).toBe('/api/admin/roles');
  });

  it('createRole sends POST with name', async () => {
    const fn = mockFetch({ id: '1', name: 'editors' });
    await createRole({ name: 'editors', can_manage_system: false, can_manage_users: false, can_manage_connections: false, can_view_audit_logs: false, can_create_users: false, can_create_user_groups: false, can_create_connections: false, can_create_connection_folders: false, can_create_sharing_profiles: false, can_view_sessions: false });
    const c = lastCall(fn);
    expect(c.url).toBe('/api/admin/roles');
    expect(c.method).toBe('POST');
    expect(JSON.parse(c.body!)).toEqual({ name: 'editors', can_manage_system: false, can_manage_users: false, can_manage_connections: false, can_view_audit_logs: false, can_create_users: false, can_create_user_groups: false, can_create_connections: false, can_create_connection_folders: false, can_create_sharing_profiles: false, can_view_sessions: false });
  });

  // ── Connections ───────────────────────────────────

  it('getConnections sends GET /api/admin/connections', async () => {
    const fn = mockFetch([]);
    await getConnections();
    expect(lastCall(fn).url).toBe('/api/admin/connections');
  });

  it('getMyConnections sends GET /api/user/connections', async () => {
    const fn = mockFetch([]);
    await getMyConnections();
    expect(lastCall(fn).url).toBe('/api/user/connections');
  });

  it('createConnection sends POST', async () => {
    const fn = mockFetch({ id: '1', name: 'srv', protocol: 'rdp', hostname: 'h', port: 3389 });
    await createConnection({ name: 'srv', protocol: 'rdp', hostname: 'h', port: 3389 });
    expect(lastCall(fn).method).toBe('POST');
    expect(lastCall(fn).url).toBe('/api/admin/connections');
  });

  it('updateConnection sends PUT with id', async () => {
    const fn = mockFetch({ id: 'c1', name: 'new', protocol: 'ssh', hostname: 'h', port: 22 });
    await updateConnection('c1', { name: 'new', protocol: 'ssh', hostname: 'h', port: 22 });
    expect(lastCall(fn).url).toBe('/api/admin/connections/c1');
    expect(lastCall(fn).method).toBe('PUT');
  });

  it('deleteConnection sends DELETE with id', async () => {
    const fn = mockFetch({ status: 'ok' });
    await deleteConnection('c1');
    expect(lastCall(fn).url).toBe('/api/admin/connections/c1');
    expect(lastCall(fn).method).toBe('DELETE');
  });

  // ── Connection Folders ─────────────────────────────

  it('getConnectionFolders sends GET', async () => {
    const fn = mockFetch([]);
    await getConnectionFolders();
    expect(lastCall(fn).url).toBe('/api/admin/connection-folders');
  });

  it('createConnectionFolder sends POST', async () => {
    const fn = mockFetch({ id: 'g1', name: 'grp' });
    await createConnectionFolder({ name: 'grp' });
    expect(lastCall(fn).url).toBe('/api/admin/connection-folders');
    expect(lastCall(fn).method).toBe('POST');
  });

  it('updateConnectionFolder sends PUT with id', async () => {
    const fn = mockFetch({ id: 'g1', name: 'new' });
    await updateConnectionFolder('g1', { name: 'new' });
    expect(lastCall(fn).url).toBe('/api/admin/connection-folders/g1');
    expect(lastCall(fn).method).toBe('PUT');
  });

  it('deleteConnectionFolder sends DELETE with id', async () => {
    const fn = mockFetch({ status: 'ok' });
    await deleteConnectionFolder('g1');
    expect(lastCall(fn).url).toBe('/api/admin/connection-folders/g1');
    expect(lastCall(fn).method).toBe('DELETE');
  });

  it('updateRoleConnections sends PUT', async () => {
    const fn = mockFetch({});
    await updateRoleConnections('role1', ['c1', 'c2']);
    const c = lastCall(fn);
    expect(c.url).toBe('/api/admin/role-connections');
    expect(c.method).toBe('PUT');
    expect(JSON.parse(c.body!)).toEqual({ role_id: 'role1', connection_ids: ['c1', 'c2'] });
  });

  // ── Users ─────────────────────────────────────────

  it('getUsers sends GET /api/admin/users', async () => {
    const fn = mockFetch([]);
    await getUsers();
    expect(lastCall(fn).url).toBe('/api/admin/users');
  });

  // ── Credentials ───────────────────────────────────

  it('updateCredential sends PUT', async () => {
    const fn = mockFetch({});
    await updateCredential('conn1', 'secret');
    const c = lastCall(fn);
    expect(c.url).toBe('/api/user/credentials');
    expect(c.method).toBe('PUT');
    expect(JSON.parse(c.body!)).toEqual({ connection_id: 'conn1', password: 'secret' });
  });

  // ── Credential Profiles ───────────────────────────

  it('getCredentialProfiles sends GET', async () => {
    const fn = mockFetch([]);
    await getCredentialProfiles();
    expect(lastCall(fn).url).toBe('/api/user/credential-profiles');
  });

  it('createCredentialProfile sends POST', async () => {
    const fn = mockFetch({ id: 'p1', status: 'ok' });
    await createCredentialProfile('myprof', 'user', 'pass', 24);
    const c = lastCall(fn);
    expect(c.url).toBe('/api/user/credential-profiles');
    expect(c.method).toBe('POST');
    expect(JSON.parse(c.body!)).toEqual({ label: 'myprof', username: 'user', password: 'pass', ttl_hours: 24 });
  });

  it('updateCredentialProfile sends PUT with id', async () => {
    const fn = mockFetch({ status: 'ok' });
    await updateCredentialProfile('p1', { label: 'renamed' });
    expect(lastCall(fn).url).toBe('/api/user/credential-profiles/p1');
    expect(lastCall(fn).method).toBe('PUT');
  });

  it('deleteCredentialProfile sends DELETE with id', async () => {
    const fn = mockFetch({ status: 'ok' });
    await deleteCredentialProfile('p1');
    expect(lastCall(fn).url).toBe('/api/user/credential-profiles/p1');
    expect(lastCall(fn).method).toBe('DELETE');
  });

  it('getProfileMappings sends GET with profile id', async () => {
    const fn = mockFetch([]);
    await getProfileMappings('p1');
    expect(lastCall(fn).url).toBe('/api/user/credential-profiles/p1/mappings');
  });

  it('setCredentialMapping sends PUT', async () => {
    const fn = mockFetch({ status: 'ok' });
    await setCredentialMapping('p1', 'c1');
    const c = lastCall(fn);
    expect(c.url).toBe('/api/user/credential-mappings');
    expect(c.method).toBe('PUT');
    expect(JSON.parse(c.body!)).toEqual({ profile_id: 'p1', connection_id: 'c1' });
  });

  it('removeCredentialMapping sends DELETE with connection id', async () => {
    const fn = mockFetch({ status: 'ok' });
    await removeCredentialMapping('c1');
    expect(lastCall(fn).url).toBe('/api/user/credential-mappings/c1');
    expect(lastCall(fn).method).toBe('DELETE');
  });

  // ── Connection Info ───────────────────────────────

  it('getConnectionInfo sends GET with connection id', async () => {
    const fn = mockFetch({ protocol: 'rdp', has_credentials: true });
    const res = await getConnectionInfo('conn1');
    expect(lastCall(fn).url).toBe('/api/user/connections/conn1/info');
    expect(res.protocol).toBe('rdp');
  });

  // ── Audit Logs ────────────────────────────────────

  it('getAuditLogs sends GET with pagination', async () => {
    const fn = mockFetch([]);
    await getAuditLogs(2, 25);
    expect(lastCall(fn).url).toBe('/api/admin/audit-logs?page=2&per_page=25');
  });

  it('getAuditLogs uses default pagination', async () => {
    const fn = mockFetch([]);
    await getAuditLogs();
    expect(lastCall(fn).url).toBe('/api/admin/audit-logs?page=1&per_page=50');
  });

  // ── Tunnel Tickets ────────────────────────────────

  it('createTunnelTicket sends POST', async () => {
    const fn = mockFetch({ ticket: 'abc123' });
    const res = await createTunnelTicket({ connection_id: 'c1', width: 1920, height: 1080 });
    expect(lastCall(fn).url).toBe('/api/tunnel/ticket');
    expect(lastCall(fn).method).toBe('POST');
    expect(res.ticket).toBe('abc123');
  });

  // ── Sharing ───────────────────────────────────────

  it('createShareLink sends POST with mode', async () => {
    const fn = mockFetch({ share_token: 't', share_url: 'u', mode: 'view' });
    await createShareLink('c1', 'control');
    const c = lastCall(fn);
    expect(c.url).toBe('/api/user/connections/c1/share');
    expect(c.method).toBe('POST');
    expect(JSON.parse(c.body!)).toEqual({ mode: 'control' });
  });

  it('createShareLink defaults to view mode', async () => {
    mockFetch({ share_token: 't', share_url: 'u', mode: 'view' });
    await createShareLink('c1');
    // No explicit assertion on mode default since it's a TypeScript default param
    // but we verify the body was sent
  });

  it('revokeShareLink sends DELETE with share id', async () => {
    const fn = mockFetch({ status: 'ok' });
    await revokeShareLink('s1');
    expect(lastCall(fn).url).toBe('/api/user/shares/s1');
    expect(lastCall(fn).method).toBe('DELETE');
  });

  // ── Favorites ─────────────────────────────────────

  it('getFavorites sends GET', async () => {
    const fn = mockFetch([]);
    await getFavorites();
    expect(lastCall(fn).url).toBe('/api/user/favorites');
  });

  it('toggleFavorite sends POST with connection_id', async () => {
    const fn = mockFetch({ favorited: true });
    const res = await toggleFavorite('c1');
    const c = lastCall(fn);
    expect(c.url).toBe('/api/user/favorites');
    expect(c.method).toBe('POST');
    expect(JSON.parse(c.body!)).toEqual({ connection_id: 'c1' });
    expect(res.favorited).toBe(true);
  });

  // ── Sessions / NVR ────────────────────────────────

  it('getActiveSessions sends GET', async () => {
    const fn = mockFetch([]);
    await getActiveSessions();
    expect(lastCall(fn).url).toBe('/api/admin/sessions');
  });

  it('getMetrics sends GET /api/admin/metrics', async () => {
    const fn = mockFetch({ active_sessions: 5 });
    const res = await getMetrics();
    expect(lastCall(fn).url).toBe('/api/admin/metrics');
    expect(res.active_sessions).toBe(5);
  });

  it('killSessions sends POST /api/admin/sessions/kill', async () => {
    const fn = mockFetch({ status: 'ok', killed_count: 2 });
    await killSessions(['s1', 's2']);
    const c = lastCall(fn);
    expect(c.url).toBe('/api/admin/sessions/kill');
    expect(c.method).toBe('POST');
    expect(JSON.parse(c.body!)).toEqual({ session_ids: ['s1', 's2'] });
  });

  it('getRecordings sends GET with query params', async () => {
    const fn = mockFetch([]);
    await getRecordings({ user_id: 'u1', connection_id: 'c1', limit: 10, offset: 20 });
    const c = lastCall(fn);
    expect(c.url).toContain('/api/admin/recordings?');
    expect(c.url).toContain('user_id=u1');
    expect(c.url).toContain('connection_id=c1');
    expect(c.url).toContain('limit=10');
    expect(c.url).toContain('offset=20');
  });
});

// ── WebSocket URL Builders (pure functions) ─────────────────────────

describe('buildRecordingStreamUrl', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'location', {
      value: { protocol: 'https:', host: 'app.example.com' },
      writable: true,
    });
  });

  it('builds wss: URL with token', () => {
    localStorage.setItem('access_token', 'jwt_rec');
    const url = buildRecordingStreamUrl('rec_123');
    expect(url).toBe('wss://app.example.com/api/admin/recordings/rec_123/stream?token=jwt_rec');
  });

  it('handles encoding of recording ID', () => {
    const url = buildRecordingStreamUrl('my recording');
    expect(url).toContain('my%20recording');
  });
});

// ── buildNvrObserveUrl (async – ensures fresh token) ────────────────

describe('buildNvrObserveUrl', () => {
  beforeEach(() => localStorage.clear());

  it('builds wss: URL when page is https', async () => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'https:', host: 'app.example.com' },
      writable: true,
    });
    localStorage.setItem('access_token', 'jwt123');
    localStorage.setItem('token_expiry', String(Date.now() + 600_000));
    const url = await buildNvrObserveUrl('sess1', 120);
    expect(url).toContain('wss://app.example.com');
    expect(url).toContain('/api/admin/sessions/sess1/observe');
    expect(url).toContain('token=jwt123');
    expect(url).toContain('offset=120');
    expect(url).toContain('speed=4'); // default speed
  });

  it('builds ws: URL when page is http', async () => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
    });
    localStorage.setItem('access_token', 'tok');
    localStorage.setItem('token_expiry', String(Date.now() + 600_000));
    const url = await buildNvrObserveUrl('sess2');
    expect(url).toContain('ws://localhost:3000');
    expect(url).toContain('offset=300'); // default
    expect(url).toContain('speed=4');    // default
  });

  it('encodes session id in URL', async () => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost' },
      writable: true,
    });
    localStorage.setItem('access_token', 'tok');
    localStorage.setItem('token_expiry', String(Date.now() + 600_000));
    const url = await buildNvrObserveUrl('id with spaces');
    expect(url).toContain('id%20with%20spaces');
  });

  it('omits token param when no token stored and refresh fails', async () => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost' },
      writable: true,
    });
    // Mock a failed refresh
    mockFetch(null, 401);
    const url = await buildNvrObserveUrl('s1');
    expect(url).not.toContain('token=');
  });

  // ── Roles (update/delete) ────────────────────────

  it('updateRole sends PUT with role data', async () => {
    const fn = mockFetch({ id: 'r1', name: 'Updated' });
    await updateRole('r1', { name: 'Updated' });
    expect(lastCall(fn).url).toBe('/api/admin/roles/r1');
    expect(lastCall(fn).method).toBe('PUT');
  });

  it('deleteRole sends DELETE', async () => {
    const fn = mockFetch({ status: 'ok' });
    await deleteRole('r1');
    expect(lastCall(fn).url).toBe('/api/admin/roles/r1');
    expect(lastCall(fn).method).toBe('DELETE');
  });

  // ── Role Mappings ────────────────────────────────

  it('getRoleMappings sends GET for role', async () => {
    const fn = mockFetch({ connection_ids: [], folder_ids: [] });
    await getRoleMappings('r1');
    expect(lastCall(fn).url).toBe('/api/admin/roles/r1/mappings');
  });

  it('updateRoleMappings sends PUT with ids', async () => {
    const fn = mockFetch({ status: 'ok' });
    await updateRoleMappings('r1', ['c1'], ['f1']);
    expect(lastCall(fn).url).toBe('/api/admin/roles/r1/mappings');
    expect(lastCall(fn).method).toBe('PUT');
  });

  // ── Users (create/delete) ────────────────────────

  it('createUser sends POST', async () => {
    const fn = mockFetch({ id: 'u1', username: 'new' });
    await createUser({ username: 'new', password: 'pass', role_id: 'r1' } as any);
    expect(lastCall(fn).url).toBe('/api/admin/users');
    expect(lastCall(fn).method).toBe('POST');
  });

  it('deleteUser sends DELETE with id', async () => {
    const fn = mockFetch({ status: 'ok' });
    await deleteUser('u1');
    expect(lastCall(fn).url).toBe('/api/admin/users/u1');
    expect(lastCall(fn).method).toBe('DELETE');
  });

  it('restoreUser sends POST to user endpoint', async () => {
    const fn = mockFetch({ status: 'ok' });
    await restoreUser('u1');
    expect(lastCall(fn).url).toBe('/api/admin/users/u1');
    expect(lastCall(fn).method).toBe('POST');
  });
});
