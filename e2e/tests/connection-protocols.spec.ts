import { test, expect } from '@playwright/test';

/**
 * Connection-protocol negotiation E2E.
 *
 * The full RDP/SSH/VNC pixel pipeline requires a live guacd + reachable
 * target host, which is out of scope for the GitHub-Actions runner.
 * Instead this spec exercises the *negotiation* surface that every
 * protocol shares:
 *
 *  1. Admin can persist connections for each protocol with the right
 *     default port and protocol-specific `extra` fields (e.g.
 *     `security`/`ignore-cert` for RDP).
 *  2. The `/api/tunnel/ticket` endpoint mints a single-use ticket for a
 *     stored connection so the WS upgrade can bind credentials without
 *     leaking them in the URL.
 *  3. RBAC blocks ticket creation when the caller lacks role-based
 *     access to the connection.
 *
 * If those three contracts hold, the only thing left between the
 * frontend and a live session is the guacd handshake itself — which is
 * verified by manual smoke tests against staging.
 */

let adminToken: string;

test.beforeAll(async ({ request }) => {
  const res = await request.post('/api/auth/login', {
    data: { username: 'admin', password: 'admin' },
  });
  expect(res.ok()).toBe(true);
  adminToken = (await res.json()).access_token;
});

function adminHeaders() {
  return { Authorization: `Bearer ${adminToken}` };
}

interface ConnFixture {
  id: string;
  protocol: string;
  port: number;
  extra: Record<string, unknown>;
}

const FIXTURES: Array<Omit<ConnFixture, 'id'>> = [
  { protocol: 'rdp', port: 3389, extra: { security: 'nla', 'ignore-cert': true } },
  { protocol: 'ssh', port: 22, extra: { 'enable-sftp': true } },
  { protocol: 'vnc', port: 5900, extra: { 'cursor': 'remote' } },
];

const created: ConnFixture[] = [];

test.beforeAll(async ({ request }) => {
  for (const f of FIXTURES) {
    const res = await request.post('/api/admin/connections', {
      headers: adminHeaders(),
      data: {
        name: `E2E ${f.protocol.toUpperCase()} target`,
        protocol: f.protocol,
        hostname: '10.99.99.50',
        port: f.port,
        description: `Created by connection-protocols.spec.ts (${f.protocol})`,
        extra: f.extra,
      },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    created.push({ id: body.id, ...f });
  }
});

test.afterAll(async ({ request }) => {
  for (const c of created) {
    await request.delete(`/api/admin/connections/${c.id}`, { headers: adminHeaders() });
  }
});

test.describe('Connection persistence per protocol', () => {
  for (const f of FIXTURES) {
    test(`${f.protocol.toUpperCase()} round-trips through GET`, async ({ request }) => {
      const conn = created.find((c) => c.protocol === f.protocol);
      test.skip(!conn, `${f.protocol} fixture missing`);
      const res = await request.get('/api/admin/connections', { headers: adminHeaders() });
      expect(res.ok()).toBe(true);
      const list = await res.json();
      const found = list.find((c: { id: string }) => c.id === conn!.id);
      expect(found).toBeTruthy();
      expect(found.protocol).toBe(f.protocol);
      expect(found.port).toBe(f.port);
      // Protocol-specific extras must round-trip verbatim — the admin
      // form depends on this for editing existing rows.
      for (const [k, v] of Object.entries(f.extra)) {
        expect(found.extra[k]).toBe(v);
      }
    });
  }
});

test.describe('Tunnel ticket negotiation', () => {
  for (const f of FIXTURES) {
    test(`${f.protocol.toUpperCase()} mints a ticket for the admin`, async ({ request }) => {
      const conn = created.find((c) => c.protocol === f.protocol);
      test.skip(!conn, `${f.protocol} fixture missing`);
      const res = await request.post('/api/tunnel/ticket', {
        headers: adminHeaders(),
        data: {
          connection_id: conn!.id,
          width: 1920,
          height: 1080,
          dpi: 96,
        },
      });
      expect(res.ok()).toBe(true);
      const body = await res.json();
      expect(typeof body.ticket).toBe('string');
      // Tickets are single-use opaque ids; lengths vary by impl but
      // must be substantial enough to resist guessing.
      expect(body.ticket.length).toBeGreaterThanOrEqual(16);
    });
  }

  test('rejects ticket creation for unknown connection id', async ({ request }) => {
    const res = await request.post('/api/tunnel/ticket', {
      headers: adminHeaders(),
      data: {
        connection_id: '00000000-0000-0000-0000-000000000000',
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });
});

test.describe('RBAC: limited user cannot ticket a connection it cannot see', () => {
  let limitedToken: string | null = null;
  let limitedUserId: string | null = null;
  let limitedRoleId: string | null = null;

  test.beforeAll(async ({ request }) => {
    // Create a role with no connection management + no role mappings,
    // then a user assigned to it, then log in as that user.
    const stamp = Date.now();
    const username = `e2e-limited-${stamp}`;
    const email = `${username}@example.invalid`;

    const role = await request.post('/api/admin/roles', {
      headers: adminHeaders(),
      data: {
        name: `e2e-limited-role-${stamp}`,
        can_manage_system: false,
        can_manage_users: false,
        can_manage_connections: false,
        can_view_audit_logs: false,
        can_create_users: false,
        can_create_user_groups: false,
        can_create_connections: false,
        can_create_sharing_profiles: false,
        can_view_sessions: false,
        can_use_quick_share: false,
      },
    });
    if (!role.ok()) return;
    limitedRoleId = (await role.json()).id;

    const user = await request.post('/api/admin/users', {
      headers: adminHeaders(),
      data: {
        username,
        email,
        role_id: limitedRoleId,
        auth_type: 'local',
        password: 'CorrectHorse123!',
      },
    });
    if (!user.ok()) return;
    limitedUserId = (await user.json()).id;

    const login = await request.post('/api/auth/login', {
      data: { username, password: 'CorrectHorse123!' },
    });
    if (login.ok()) {
      limitedToken = (await login.json()).access_token;
    }
  });

  test.afterAll(async ({ request }) => {
    if (limitedUserId) {
      await request.delete(`/api/admin/users/${limitedUserId}`, { headers: adminHeaders() });
    }
    if (limitedRoleId) {
      await request.delete(`/api/admin/roles/${limitedRoleId}`, { headers: adminHeaders() });
    }
  });

  test('limited user gets 403 when ticketing an admin-owned connection', async ({ request }) => {
    test.skip(!limitedToken, 'limited user setup did not complete');
    const conn = created[0];
    const res = await request.post('/api/tunnel/ticket', {
      headers: { Authorization: `Bearer ${limitedToken}` },
      data: { connection_id: conn.id },
    });
    expect(res.status()).toBe(403);
  });
});
