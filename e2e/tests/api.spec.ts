import { test, expect } from '@playwright/test';

test.describe('Health & Status', () => {
  test('GET /api/status returns running phase', async ({ request }) => {
    const res = await request.get('/api/status');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.phase).toBe('running');
  });

  test('GET /api/health returns ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBe(true);
  });
});

test.describe('Authentication', () => {
  test('login with valid credentials returns JWT', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { username: 'admin', password: 'admin' },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.access_token).toMatch(/^eyJ/); // JWT starts with eyJ (base64 header)
  });

  test('login with wrong password returns 401', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { username: 'ratelimit_test_user', password: 'wrong' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    // Must not leak database details
    expect(body.error).not.toMatch(/sql|postgres|query|column/i);
  });

  test('login with nonexistent user returns 401', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { username: 'nonexistent_user_xyz', password: 'anything' },
    });
    expect(res.status()).toBe(401);
  });

  test('accessing protected route without token returns 401', async ({ request }) => {
    const res = await request.get('/api/user/me');
    expect(res.status()).toBe(401);
  });

  test('logout invalidates token', async ({ request }) => {
    // Login
    const loginRes = await request.post('/api/auth/login', {
      data: { username: 'admin', password: 'admin' },
    });
    const { access_token } = await loginRes.json();

    // Verify token works
    const meRes = await request.get('/api/user/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(meRes.ok()).toBe(true);

    // Logout
    const logoutRes = await request.post('/api/auth/logout', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(logoutRes.ok()).toBe(true);

    // Verify token is revoked
    const meRes2 = await request.get('/api/user/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(meRes2.status()).toBe(401);
  });
});

test.describe('User API', () => {
  test('GET /api/user/me returns user info', async ({ request }) => {
    const loginRes = await request.post('/api/auth/login', {
      data: { username: 'admin', password: 'admin' },
    });
    expect(loginRes.ok()).toBe(true);
    const loginBody = await loginRes.json();
    const token = loginBody.access_token;
    expect(token).toBeTruthy();

    const res = await request.get('/api/user/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.username).toBe('admin');
    expect(body.role).toBeTruthy();
    expect(body.id).toBeTruthy();

    // Reuse the token for connections
    const connRes = await request.get('/api/user/connections', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(connRes.ok()).toBe(true);
    const connections = await connRes.json();
    expect(Array.isArray(connections)).toBe(true);
  });
});

test.describe('Admin API', () => {
  test('admin endpoints return correct data', async ({ request }) => {
    const loginRes = await request.post('/api/auth/login', {
      data: { username: 'admin', password: 'admin' },
    });
    if (loginRes.status() === 401) {
      const body = await loginRes.json();
      if (body.error?.includes('Too many')) {
        test.skip(true, 'Rate limited — skipping');
      }
    }
    expect(loginRes.ok()).toBe(true);
    const { access_token: token } = await loginRes.json();
    const headers = { Authorization: `Bearer ${token}` };

    // Settings
    const settingsRes = await request.get('/api/admin/settings', { headers });
    expect(settingsRes.ok()).toBe(true);

    // Audit logs
    const logsRes = await request.get('/api/admin/audit-logs?page=1&per_page=5', { headers });
    expect(logsRes.ok()).toBe(true);
    const logs = await logsRes.json();
    expect(Array.isArray(logs)).toBe(true);

    // Active sessions
    const sessRes = await request.get('/api/admin/sessions', { headers });
    expect(sessRes.ok()).toBe(true);
    const sessions = await sessRes.json();
    expect(Array.isArray(sessions)).toBe(true);

    // AD sync configs
    const adRes = await request.get('/api/admin/ad-sync-configs', { headers });
    expect(adRes.ok()).toBe(true);
    const configs = await adRes.json();
    expect(Array.isArray(configs)).toBe(true);
  });
});
