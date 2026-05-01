/**
 * RBAC negative-test pack — Item 3 (Comprehensive).
 *
 * Verifies that protected routes correctly enforce:
 *   A. Authentication (no token → 401)
 *   B. Authorization / role (non-admin Bearer token → 403 on admin routes)
 *   C. CSRF (cookie-auth mutating requests without X-CSRF-Token → 403)
 *   D. Bearer auth is CSRF-exempt (mutating Bearer requests succeed)
 *   E. Public routes remain reachable without auth.
 *
 * The harness covers a representative sample from every protected router
 * (admin/users, admin/connections, admin/folders, admin/credential-profiles,
 * admin/recordings, admin/audit-logs, admin/settings/*, admin/sso,
 * admin/kerberos-realms, admin/ad-sync-configs, admin/health, admin/sessions,
 * admin/role-connections, admin/roadmap, user/me, user/connections,
 * user/preferences, user/recordings, …).
 *
 * Scope is HTTP-level (Playwright `request` fixture) so failures are isolated
 * from UI flake.
 */

import { test, expect, APIRequestContext } from '@playwright/test';

// ── Shared state ─────────────────────────────────────────────────────

let adminToken: string;
let userToken: string;
let userPassword: string;
let userUsername: string;
const userTag = `rbac_user_${Date.now().toString(36)}`;

// Cookie-auth context for the regular user (carries access_token + csrf_token cookies).
let userCookieCtx: APIRequestContext;
let userCsrfCookie: string;

// Admin Bearer context (used to provision the test user and clean up).
async function adminPost(request: APIRequestContext, url: string, data: unknown) {
  return request.post(url, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data,
  });
}

// ── Setup: admin login + create regular user + login as user ────────

test.beforeAll(async ({ playwright }) => {
  // 1) Admin login (Bearer)
  const ctx = await playwright.request.newContext();
  const adminRes = await ctx.post('/api/auth/login', {
    data: { username: 'admin', password: 'admin' },
  });
  expect(adminRes.ok(), 'admin login').toBe(true);
  adminToken = (await adminRes.json()).access_token;

  // 2) Create a bare role with NO admin permissions for this test run.
  //    The seeded "user" role has `can_create_sharing_profiles=true` and
  //    therefore counts as admin per `has_any_admin_permission()`. We need
  //    a role that returns false from every admin-permission predicate so
  //    that the regular user we create cannot pass `require_admin`.
  const roleName = `rbac-no-perms-${Date.now().toString(36)}`;
  const newRoleRes = await adminPost(ctx, '/api/admin/roles', { name: roleName });
  expect(newRoleRes.ok(), `create bare role (${newRoleRes.status()})`).toBe(true);
  const bareRole = await newRoleRes.json();
  const bareRoleId = bareRole.id as string;
  expect(bareRoleId).toBeTruthy();

  // 3) Create a fresh non-admin user with the bare role
  userUsername = userTag;
  const createRes = await adminPost(ctx, '/api/admin/users', {
    username: userUsername,
    email: `${userTag}@rbac.test`,
    full_name: 'RBAC Test User',
    role_id: bareRoleId,
    auth_type: 'local',
  });
  expect(createRes.ok(), `create_user (${createRes.status()})`).toBe(true);
  const created = await createRes.json();
  userPassword = created.password;
  expect(userPassword, 'plaintext password returned once').toBeTruthy();

  // 4) Login as that user — Bearer token (for wrong-role tests)
  const userBearerLoginCtx = await playwright.request.newContext();
  const userLoginRes = await userBearerLoginCtx.post('/api/auth/login', {
    data: { username: userUsername, password: userPassword },
  });
  expect(userLoginRes.ok(), `user login (${userLoginRes.status()})`).toBe(true);
  userToken = (await userLoginRes.json()).access_token;
  await userBearerLoginCtx.dispose();

  // 5) Build a cookie-auth context for that same user (for CSRF tests).
  //    Playwright's APIRequestContext maintains cookies across requests,
  //    so a fresh context that calls /api/auth/login will carry the
  //    session cookies (access_token, refresh_token, csrf_token).
  userCookieCtx = await playwright.request.newContext();
  const cookieLogin = await userCookieCtx.post('/api/auth/login', {
    data: { username: userUsername, password: userPassword },
  });
  expect(cookieLogin.ok()).toBe(true);
  const state = await userCookieCtx.storageState();
  const csrf = state.cookies.find((c) => c.name === 'csrf_token');
  expect(csrf, 'csrf_token cookie set on login').toBeTruthy();
  userCsrfCookie = csrf!.value;

  await ctx.dispose();
});

test.afterAll(async () => {
  if (userCookieCtx) await userCookieCtx.dispose();
});

// ── A. No-auth → 401 ─────────────────────────────────────────────────

const NOAUTH_GET_ROUTES = [
  '/api/user/me',
  '/api/user/preferences',
  '/api/user/connections',
  '/api/user/credential-profiles',
  '/api/user/favorites',
  '/api/user/tags',
  '/api/user/recordings',
  '/api/user/sessions',
  '/api/user/managed-accounts',
  '/api/user/checkouts',
  '/api/user/pending-approvals',
  '/api/admin/users',
  '/api/admin/roles',
  '/api/admin/connections',
  '/api/admin/connection-folders',
  '/api/admin/audit-logs',
  '/api/admin/sessions',
  '/api/admin/recordings',
  '/api/admin/session-stats',
  '/api/admin/health',
  '/api/admin/settings',
  '/api/admin/kerberos-realms',
  '/api/admin/ad-sync-configs',
  '/api/admin/tags',
  '/api/admin/connection-tags',
  '/api/admin/approval-roles',
  '/api/admin/account-mappings',
  '/api/admin/checkout-requests',
  '/api/admin/metrics',
  '/api/roadmap',
];

const NOAUTH_POST_ROUTES: Array<{ url: string; body: unknown }> = [
  { url: '/api/admin/connections', body: { name: 'x', protocol: 'rdp', hostname: 'h', port: 1 } },
  { url: '/api/admin/users', body: {} },
  { url: '/api/admin/connection-folders', body: { name: 'x' } },
  { url: '/api/admin/kerberos-realms', body: {} },
  { url: '/api/admin/ad-sync-configs', body: {} },
  { url: '/api/admin/tags', body: {} },
  { url: '/api/admin/sessions/kill', body: {} },
  { url: '/api/user/favorites', body: {} },
  { url: '/api/user/tags', body: {} },
  { url: '/api/user/checkouts', body: {} },
  // v1.4.0 — Kubernetes pod console kubeconfig importer.
  { url: '/api/admin/kubernetes/parse-kubeconfig', body: { kubeconfig: '' } },
];

test.describe('RBAC — no auth (401)', () => {
  for (const url of NOAUTH_GET_ROUTES) {
    test(`GET ${url} requires auth`, async ({ request }) => {
      const res = await request.get(url);
      expect(res.status(), `status of ${url}`).toBe(401);
    });
  }
  for (const { url, body } of NOAUTH_POST_ROUTES) {
    test(`POST ${url} requires auth`, async ({ request }) => {
      const res = await request.post(url, { data: body });
      // CSRF middleware runs *before* auth and rejects unauth'd cookie-less
      // POSTs with 403; auth-only POSTs (Bearer path) return 401. Either is
      // acceptable — the contract is that the request is rejected without
      // touching the handler.
      expect([401, 403], `status of POST ${url} (got ${res.status()})`).toContain(res.status());
    });
  }
});

// ── B. Wrong role: regular user hitting admin routes → 403 ──────────

const ADMIN_ONLY_GET = [
  '/api/admin/users',
  '/api/admin/roles',
  '/api/admin/connections',
  '/api/admin/connection-folders',
  '/api/admin/audit-logs',
  '/api/admin/sessions',
  '/api/admin/recordings',
  '/api/admin/health',
  '/api/admin/settings',
  '/api/admin/kerberos-realms',
  '/api/admin/ad-sync-configs',
  '/api/admin/tags',
  '/api/admin/approval-roles',
  '/api/admin/account-mappings',
  '/api/admin/checkout-requests',
  '/api/admin/metrics',
  '/api/admin/session-stats',
];

const ADMIN_ONLY_POST: Array<{ url: string; body: unknown }> = [
  { url: '/api/admin/connections', body: { name: 'x', protocol: 'rdp', hostname: 'h', port: 1 } },
  { url: '/api/admin/users', body: { username: 'x', email: 'x@x.x', role_id: '00000000-0000-0000-0000-000000000000', auth_type: 'local' } },
  { url: '/api/admin/connection-folders', body: { name: 'x' } },
  { url: '/api/admin/kerberos-realms', body: {} },
  { url: '/api/admin/sessions/kill', body: { ids: [] } },
  { url: '/api/admin/notifications/test-send', body: { to: 'x@x.x' } },
  { url: '/api/admin/pm/test-rotation', body: {} },
  // v1.4.0 — Kubernetes pod console kubeconfig importer.
  { url: '/api/admin/kubernetes/parse-kubeconfig', body: { kubeconfig: 'apiVersion: v1\nkind: Config\n' } },
];

test.describe('RBAC — wrong role (403) for non-admin Bearer', () => {
  for (const url of ADMIN_ONLY_GET) {
    test(`GET ${url} forbidden for user role`, async ({ request }) => {
      const res = await request.get(url, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(res.status(), `status of ${url}`).toBe(403);
    });
  }
  for (const { url, body } of ADMIN_ONLY_POST) {
    test(`POST ${url} forbidden for user role`, async ({ request }) => {
      const res = await request.post(url, {
        headers: { Authorization: `Bearer ${userToken}` },
        data: body,
      });
      expect(res.status(), `status of POST ${url}`).toBe(403);
    });
  }
});

// ── C. CSRF: cookie-auth mutating requests without/with bad header → 403 ─

test.describe('RBAC — CSRF on cookie-authenticated mutating routes', () => {
  test('POST /api/user/favorites without X-CSRF-Token → 403', async () => {
    const res = await userCookieCtx.post('/api/user/favorites', {
      data: { connection_id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.status()).toBe(403);
  });

  test('POST /api/user/favorites with WRONG X-CSRF-Token → 403', async () => {
    const res = await userCookieCtx.post('/api/user/favorites', {
      headers: { 'X-CSRF-Token': 'tampered-value' },
      data: { connection_id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.status()).toBe(403);
  });

  test('PUT /api/user/preferences without X-CSRF-Token → 403', async () => {
    const res = await userCookieCtx.put('/api/user/preferences', {
      data: { theme: 'dark' },
    });
    expect(res.status()).toBe(403);
  });

  test('POST /api/user/tags without X-CSRF-Token → 403', async () => {
    const res = await userCookieCtx.post('/api/user/tags', {
      data: { name: 'x', color: '#000' },
    });
    expect(res.status()).toBe(403);
  });

  test('GET requests do NOT require X-CSRF-Token (cookie auth)', async () => {
    const res = await userCookieCtx.get('/api/user/me');
    expect(res.ok(), `status ${res.status()}`).toBe(true);
  });

  test('POST with matching X-CSRF-Token succeeds (non-403)', async () => {
    // We don't care about the route's business success — only that the
    // request gets *past* the CSRF gate (i.e. status is not 403).
    const res = await userCookieCtx.post('/api/user/favorites', {
      headers: { 'X-CSRF-Token': userCsrfCookie },
      data: { connection_id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.status(), `status ${res.status()}`).not.toBe(403);
  });
});

// ── D. Bearer auth is CSRF-exempt ───────────────────────────────────

test.describe('RBAC — Bearer auth is CSRF-exempt', () => {
  test('POST with Bearer and no CSRF header passes the CSRF gate', async ({ request }) => {
    const res = await request.post('/api/user/favorites', {
      headers: { Authorization: `Bearer ${userToken}` },
      data: { connection_id: '00000000-0000-0000-0000-000000000000' },
    });
    // Should not be blocked by CSRF (403). Could be 400/404/422 if the
    // connection id is invalid for this user — that's fine, only 403
    // would indicate CSRF leakage onto Bearer requests.
    expect(res.status(), `status ${res.status()}`).not.toBe(403);
    expect(res.status()).not.toBe(401);
  });
});

// ── E. Public routes remain reachable ───────────────────────────────

test.describe('RBAC — public routes are not gated', () => {
  test('GET /api/health is public', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBe(true);
  });

  test('GET /api/status is public', async ({ request }) => {
    const res = await request.get('/api/status');
    expect(res.ok()).toBe(true);
  });

  test('GET /api/auth/check is public (returns 200 with auth:false on no creds)', async ({ request }) => {
    const res = await request.get('/api/auth/check');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
  });
});
