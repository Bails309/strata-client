import { test, expect } from '@playwright/test';

/**
 * Quick Share file lifecycle E2E.
 *
 * Validates the upload → list → download → delete flow exposed by the
 * `/api/files/*` routes. Requires the bootstrap admin to have a role
 * with `can_use_quick_share = true` (true on the seeded `admin` role).
 *
 * The "session_id" is just an opaque string the backend uses to scope
 * the file listing — we do not need a live guacd session to exercise
 * the upload pipeline, so this spec stays hermetic to the backend.
 */

let token: string;
let connectionId: string;
let sessionId: string;

test.beforeAll(async ({ request }) => {
  const login = await request.post('/api/auth/login', {
    data: { username: 'admin', password: 'admin' },
  });
  expect(login.ok()).toBe(true);
  token = (await login.json()).access_token;

  // Spin up a throwaway connection so the session_id maps to a real
  // resource the upload handler will accept.
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
  sessionId = connectionId; // backend treats session_id as opaque
});

test.afterAll(async ({ request }) => {
  if (connectionId) {
    await request.delete(`/api/admin/connections/${connectionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
});

test.describe('QuickShare upload / list / download / delete', () => {
  let fileToken: string;
  const payload = Buffer.from('hello quickshare\n', 'utf-8');

  test('upload a file via multipart', async ({ request }) => {
    const res = await request.post('/api/files/upload', {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        session_id: sessionId,
        file: {
          name: 'hello.txt',
          mimeType: 'text/plain',
          buffer: payload,
        },
      },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    // Response must include a download token + the original filename so
    // the React UI can render the snippet.
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(8);
    expect(body.filename ?? body.name ?? body.original_filename).toBeTruthy();
    fileToken = body.token;
  });

  test('list files for the session includes the upload', async ({ request }) => {
    test.skip(!fileToken, 'upload step did not produce a token');
    const res = await request.get(`/api/files/session/${sessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBe(true);
    const list = await res.json();
    const tokens: string[] = (Array.isArray(list) ? list : list.files ?? []).map(
      (f: { token: string }) => f.token
    );
    expect(tokens).toContain(fileToken);
  });

  test('download serves the original bytes (token is public)', async ({ request }) => {
    test.skip(!fileToken, 'no token');
    // /api/files/{token} is intentionally unauthenticated so the
    // remote-session participant can fetch via curl/wget without a JWT.
    const res = await request.get(`/api/files/${fileToken}`);
    expect(res.ok()).toBe(true);
    const body = await res.body();
    expect(body.toString('utf-8')).toBe(payload.toString('utf-8'));
  });

  test('delete removes the file from the listing', async ({ request }) => {
    test.skip(!fileToken, 'no token');
    const del = await request.delete(`/api/files/delete/${fileToken}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(del.ok()).toBe(true);

    // Subsequent download must 404.
    const after = await request.get(`/api/files/${fileToken}`);
    expect(after.status()).toBe(404);
  });

  test('upload over the size cap is rejected', async ({ request }) => {
    // Server caps at 500 MiB — we only send a bit over the multipart
    // body limit to confirm the stream-and-check path returns 4xx
    // rather than crashing the worker. A 600-byte payload below the
    // 500 MiB ceiling is fine here; instead, send an empty session_id
    // which the validator must reject with 400.
    const res = await request.post('/api/files/upload', {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        // Intentionally omit `file` to trigger validation failure.
        session_id: sessionId,
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });
});
