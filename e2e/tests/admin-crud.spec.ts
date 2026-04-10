import { test, expect } from '@playwright/test';

/**
 * Admin CRUD E2E tests — exercises connection, role, connection-group,
 * and settings lifecycle through the real API.
 */

let token: string;

test.beforeAll(async ({ request }) => {
  const res = await request.post('/api/auth/login', {
    data: { username: 'admin', password: 'admin' },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  token = body.access_token;
});

function headers() {
  return { Authorization: `Bearer ${token}` };
}

// ── Connections CRUD ─────────────────────────────────────────────────

test.describe('Connection CRUD', () => {
  let connectionId: string;

  test('create a connection', async ({ request }) => {
    const res = await request.post('/api/admin/connections', {
      headers: headers(),
      data: {
        name: 'E2E Test Server',
        protocol: 'rdp',
        hostname: '10.99.99.1',
        port: 3389,
        description: 'Created by E2E test',
      },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('E2E Test Server');
    expect(body.protocol).toBe('rdp');
    connectionId = body.id;
  });

  test('list connections includes the created one', async ({ request }) => {
    const res = await request.get('/api/admin/connections', { headers: headers() });
    expect(res.ok()).toBe(true);
    const list = await res.json();
    expect(list.some((c: any) => c.name === 'E2E Test Server')).toBe(true);
  });

  test('update the connection', async ({ request }) => {
    test.skip(!connectionId, 'No connection to update');
    const res = await request.put(`/api/admin/connections/${connectionId}`, {
      headers: headers(),
      data: {
        name: 'E2E Updated Server',
        protocol: 'rdp',
        hostname: '10.99.99.2',
        port: 3389,
        description: 'Updated by E2E test',
      },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.name).toBe('E2E Updated Server');
    expect(body.hostname).toBe('10.99.99.2');
  });

  test('delete the connection', async ({ request }) => {
    test.skip(!connectionId, 'No connection to delete');
    const res = await request.delete(`/api/admin/connections/${connectionId}`, {
      headers: headers(),
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('deleted');
  });

  test('deleted connection no longer in list', async ({ request }) => {
    test.skip(!connectionId, 'No connection to verify');
    const res = await request.get('/api/admin/connections', { headers: headers() });
    const list = await res.json();
    expect(list.some((c: any) => c.id === connectionId)).toBe(false);
  });
});

// ── Roles CRUD ───────────────────────────────────────────────────────

test.describe('Role CRUD', () => {
  let roleId: string;

  test('create a role', async ({ request }) => {
    const res = await request.post('/api/admin/roles', {
      headers: headers(),
      data: { name: `e2e-test-role-${Date.now()}` },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toContain('e2e-test-role');
    roleId = body.id;
  });

  test('list roles includes the created one', async ({ request }) => {
    const res = await request.get('/api/admin/roles', { headers: headers() });
    expect(res.ok()).toBe(true);
    const list = await res.json();
    expect(list.some((r: any) => r.id === roleId)).toBe(true);
  });
});

// ── Connection Folder CRUD ───────────────────────────────────────────

test.describe('Connection Folder CRUD', () => {
  let folderId: string;

  test('create a connection folder', async ({ request }) => {
    const res = await request.post('/api/admin/connection-folders', {
      headers: headers(),
      data: { name: `e2e-folder-${Date.now()}` },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    folderId = body.id;
  });

  test('list folders includes the created one', async ({ request }) => {
    const res = await request.get('/api/admin/connection-folders', { headers: headers() });
    expect(res.ok()).toBe(true);
    const list = await res.json();
    expect(list.some((g: any) => g.id === folderId)).toBe(true);
  });

  test('update the folder', async ({ request }) => {
    test.skip(!folderId, 'No folder to update');
    const res = await request.put(`/api/admin/connection-folders/${folderId}`, {
      headers: headers(),
      data: { name: 'e2e-folder-updated' },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.name).toBe('e2e-folder-updated');
  });

  test('delete the folder', async ({ request }) => {
    test.skip(!folderId, 'No folder to delete');
    const res = await request.delete(`/api/admin/connection-folders/${folderId}`, {
      headers: headers(),
    });
    expect(res.ok()).toBe(true);
  });
});

// ── Settings API ─────────────────────────────────────────────────────

test.describe('Settings', () => {
  test('GET settings returns an object', async ({ request }) => {
    const res = await request.get('/api/admin/settings', { headers: headers() });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('sensitive settings are redacted', async ({ request }) => {
    const res = await request.get('/api/admin/settings', { headers: headers() });
    const body = await res.json();
    // If sso_client_secret exists, it should be redacted
    if (body.sso_client_secret) {
      expect(body.sso_client_secret).toBe('********');
    }
    if (body.vault_token) {
      expect(body.vault_token).toBe('********');
    }
  });

  test('restricted settings cannot be updated via generic endpoint', async ({ request }) => {
    const res = await request.put('/api/admin/settings', {
      headers: headers(),
      data: { settings: [{ key: 'jwt_secret', value: 'hacked' }] },
    });
    // Should fail
    expect(res.ok()).toBe(false);
  });
});

// ── Metrics ──────────────────────────────────────────────────────────

test.describe('Metrics', () => {
  test('GET metrics returns summary', async ({ request }) => {
    const res = await request.get('/api/admin/metrics', { headers: headers() });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(typeof body.active_sessions).toBe('number');
    expect(typeof body.guacd_pool_size).toBe('number');
  });
});

// ── Service Health ───────────────────────────────────────────────────

test.describe('Admin Health', () => {
  test('GET admin health returns component status', async ({ request }) => {
    const res = await request.get('/api/admin/health', { headers: headers() });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.database).toBeTruthy();
    expect(typeof body.database.connected).toBe('boolean');
    expect(body.guacd).toBeTruthy();
    expect(body.vault).toBeTruthy();
  });
});

// ── Kerberos Realms ──────────────────────────────────────────────────

test.describe('Kerberos Realms CRUD', () => {
  let realmId: string;

  test('create a kerberos realm', async ({ request }) => {
    const res = await request.post('/api/admin/kerberos-realms', {
      headers: headers(),
      data: {
        realm: 'E2ETEST.LOCAL',
        kdc_servers: ['kdc1.e2etest.local'],
        admin_server: 'admin.e2etest.local',
      },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    realmId = body.id;
  });

  test('list realms includes the created one', async ({ request }) => {
    const res = await request.get('/api/admin/kerberos-realms', { headers: headers() });
    expect(res.ok()).toBe(true);
    const list = await res.json();
    expect(list.some((r: any) => r.realm === 'E2ETEST.LOCAL')).toBe(true);
  });

  test('delete the realm', async ({ request }) => {
    test.skip(!realmId, 'No realm to delete');
    const res = await request.delete(`/api/admin/kerberos-realms/${realmId}`, {
      headers: headers(),
    });
    expect(res.ok()).toBe(true);
  });
});
