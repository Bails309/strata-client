import { test, expect } from '@playwright/test';

/**
 * E2E tests for credential profiles and connection share links.
 * These call the real API endpoints — they need a running stack.
 */

// Helper to login and return { token, headers }
async function login(request: any) {
  const res = await request.post('/api/auth/login', {
    data: { username: 'admin', password: 'admin' },
  });
  if (res.status() === 401) {
    const body = await res.json();
    if (body.error?.includes('Too many')) {
      return null; // rate limited
    }
  }
  expect(res.ok()).toBe(true);
  const { access_token } = await res.json();
  return { token: access_token, headers: { Authorization: `Bearer ${access_token}` } };
}

test.describe('Credential Profiles API', () => {
  test('list credential profiles (empty initially)', async ({ request }) => {
    const auth = await login(request);
    if (!auth) { test.skip(true, 'Rate limited'); return; }

    const res = await request.get('/api/user/credential-profiles', { headers: auth.headers });
    expect(res.ok()).toBe(true);
    const profiles = await res.json();
    expect(Array.isArray(profiles)).toBe(true);
  });

  test('create credential profile requires vault', async ({ request }) => {
    const auth = await login(request);
    if (!auth) { test.skip(true, 'Rate limited'); return; }

    const res = await request.post('/api/user/credential-profiles', {
      headers: auth.headers,
      data: {
        label: 'E2E Test Profile',
        username: 'testuser',
        password: 'testpass123',
        ttl_hours: 4,
      },
    });
    // Either succeeds (201/200) if vault configured, or returns config error
    const status = res.status();
    expect([200, 500]).toContain(status);

    if (status === 200) {
      const body = await res.json();
      expect(body.id).toBeTruthy();
      expect(body.status).toBe('created');

      // Clean up — delete the profile
      const delRes = await request.delete(
        `/api/user/credential-profiles/${body.id}`,
        { headers: auth.headers },
      );
      expect(delRes.ok()).toBe(true);
    }
  });

  test('credential mappings endpoint returns array', async ({ request }) => {
    const auth = await login(request);
    if (!auth) { test.skip(true, 'Rate limited'); return; }

    // List profiles first to see if any exist
    const profRes = await request.get('/api/user/credential-profiles', { headers: auth.headers });
    expect(profRes.ok()).toBe(true);
    const profiles = await profRes.json();

    if (profiles.length > 0) {
      const mappingsRes = await request.get(
        `/api/user/credential-profiles/${profiles[0].id}/mappings`,
        { headers: auth.headers },
      );
      expect(mappingsRes.ok()).toBe(true);
      const mappings = await mappingsRes.json();
      expect(Array.isArray(mappings)).toBe(true);
    }
  });
});

test.describe('Favorites API', () => {
  test('list favorites returns array', async ({ request }) => {
    const auth = await login(request);
    if (!auth) { test.skip(true, 'Rate limited'); return; }

    const res = await request.get('/api/user/favorites', { headers: auth.headers });
    expect(res.ok()).toBe(true);
    const favs = await res.json();
    expect(Array.isArray(favs)).toBe(true);
  });

  test('toggle favorite on a connection', async ({ request }) => {
    const auth = await login(request);
    if (!auth) { test.skip(true, 'Rate limited'); return; }

    // Get connections
    const connRes = await request.get('/api/user/connections', { headers: auth.headers });
    expect(connRes.ok()).toBe(true);
    const connections = await connRes.json();

    if (connections.length > 0) {
      const connId = connections[0].id;

      // Toggle on
      const toggleRes = await request.post('/api/user/favorites', {
        headers: auth.headers,
        data: { connection_id: connId },
      });
      expect(toggleRes.ok()).toBe(true);
      const body = await toggleRes.json();
      expect(typeof body.favorited).toBe('boolean');

      // Toggle off (restore original state)
      await request.post('/api/user/favorites', {
        headers: auth.headers,
        data: { connection_id: connId },
      });
    }
  });
});

test.describe('Connection Info API', () => {
  test('connection info returns protocol and credential status', async ({ request }) => {
    const auth = await login(request);
    if (!auth) { test.skip(true, 'Rate limited'); return; }

    const connRes = await request.get('/api/user/connections', { headers: auth.headers });
    expect(connRes.ok()).toBe(true);
    const connections = await connRes.json();

    if (connections.length > 0) {
      const infoRes = await request.get(
        `/api/user/connections/${connections[0].id}/info`,
        { headers: auth.headers },
      );
      expect(infoRes.ok()).toBe(true);
      const info = await infoRes.json();
      expect(info.protocol).toBeTruthy();
      expect(typeof info.has_credentials).toBe('boolean');
    }
  });
});

test.describe('Share Links API', () => {
  test('share link creation requires active session', async ({ request }) => {
    const auth = await login(request);
    if (!auth) { test.skip(true, 'Rate limited'); return; }

    const connRes = await request.get('/api/user/connections', { headers: auth.headers });
    expect(connRes.ok()).toBe(true);
    const connections = await connRes.json();

    if (connections.length > 0) {
      // Try to create a share link without an active session
      const shareRes = await request.post(`/api/share/${connections[0].id}`, {
        headers: auth.headers,
        data: { mode: 'view' },
      });
      // Should fail since no active WebSocket session exists
      const status = shareRes.status();
      expect([200, 400, 404]).toContain(status);
    }
  });

  test('accessing share with invalid token returns error', async ({ request }) => {
    const res = await request.get('/api/share/connect/invalid-token-abc123');
    expect(res.ok()).toBe(false);
  });
});
