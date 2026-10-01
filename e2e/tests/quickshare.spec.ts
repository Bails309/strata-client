import { test, expect } from '@playwright/test';

/**
 * Quick Share upload gate E2E.
 *
 * Since SEC-11, `POST /api/files/upload` takes a `session_id` that must be
 * the connection id of one of the caller's live sessions, and checks it
 * before reading any file bytes. CI has no reachable target to open a
 * session against, so this spec covers the gate rather than the full
 * upload → list → download → delete lifecycle.
 */

let token: string;
let connectionId: string;

test.beforeAll(async ({ request }) => {
  const login = await request.post('/api/auth/login', {
    data: { username: 'admin', password: 'admin' },
  });
  expect(login.ok()).toBe(true);
  token = (await login.json()).access_token;

  const c = await request.post('/api/admin/connections', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: 'E2E QuickShare Conn',
      protocol: 'rdp',
      hostname: '10.99.99.10',
      port: 3389,
      description: 'Owned by quickshare.spec.ts',
    },
  });
  expect(c.ok()).toBe(true);
  connectionId = (await c.json()).id;
});

test.afterAll(async ({ request }) => {
  if (connectionId) {
    await request.delete(`/api/admin/connections/${connectionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
});

test.describe('QuickShare upload gate', () => {
  const file = {
    name: 'hello.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello quickshare\n', 'utf-8'),
  };

  test('upload to a connection with no live session is refused', async ({ request }) => {
    const res = await request.post('/api/files/upload', {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { session_id: connectionId, file },
    });
    expect(res.status()).toBe(403);
  });

  test('upload with a session_id that is not a connection id is rejected', async ({
    request,
  }) => {
    const res = await request.post('/api/files/upload', {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { session_id: 'not-a-uuid', file },
    });
    expect(res.status()).toBe(400);
  });

  test('upload without a session_id is rejected', async ({ request }) => {
    const res = await request.post('/api/files/upload', {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { file },
    });
    expect(res.status()).toBe(400);
  });

  test('upload without credentials is refused', async ({ request }) => {
    const res = await request.post('/api/files/upload', {
      multipart: { session_id: connectionId, file },
    });
    // CSRF runs before auth, so a cookie-less request may stop at either.
    expect([401, 403]).toContain(res.status());
  });

  test('download of an unknown token is 404', async ({ request }) => {
    const res = await request.get('/api/files/not-a-real-token');
    expect(res.status()).toBe(404);
  });
});
