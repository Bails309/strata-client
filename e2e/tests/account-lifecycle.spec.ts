/**
 * Account lifecycle: every way a session is meant to end must actually end
 * it. Each case signs a user in, changes the account the way an
 * administrator or the user would, then replays the token it already holds.
 *
 * The middleware compares a token's `iat` (whole seconds) against the
 * account's `sessions_valid_after`, so a token issued in the same second as
 * the change is still accepted. Cases that revoke by timestamp wait out the
 * second first; without that they would pass or fail by chance.
 */

import { test, expect, APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test';

type Pw = PlaywrightWorkerArgs['playwright'];

let admin: APIRequestContext;
let roleId: string;

test.beforeAll(async ({ playwright }) => {
  const login = await playwright.request.newContext();
  const res = await login.post('/api/auth/login', {
    data: { username: 'admin', password: 'admin' },
  });
  expect(res.ok(), 'admin login').toBe(true);
  const token = (await res.json()).access_token;
  await login.dispose();

  admin = await playwright.request.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  const role = await admin.post('/api/admin/roles', {
    data: { name: `lifecycle-${Date.now().toString(36)}` },
  });
  expect(role.ok(), `create role (${role.status()})`).toBe(true);
  roleId = (await role.json()).id;
});

test.afterAll(async () => {
  if (admin) await admin.dispose();
});

async function createUser(label: string) {
  const username = `lifecycle_${label}_${Date.now().toString(36)}`;
  const res = await admin.post('/api/admin/users', {
    data: {
      username,
      email: `${username}@lifecycle.test`,
      full_name: 'Lifecycle Test',
      role_id: roleId,
      auth_type: 'local',
    },
  });
  expect(res.ok(), `create user (${res.status()})`).toBe(true);
  const body = await res.json();
  return { id: body.id as string, username, password: body.password as string };
}

/** Sign in from a fresh context so no cookie from another step rides along. */
async function signIn(playwright: Pw, username: string, password: string) {
  const ctx = await playwright.request.newContext();
  const res = await ctx.post('/api/auth/login', { data: { username, password } });
  const status = res.status();
  const token = res.ok() ? ((await res.json()).access_token as string) : undefined;
  await ctx.dispose();
  return { status, token };
}

async function meStatus(playwright: Pw, token: string) {
  const ctx = await playwright.request.newContext();
  const res = await ctx.get('/api/user/me', { headers: { Authorization: `Bearer ${token}` } });
  await ctx.dispose();
  return res.status();
}

const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

test.describe('Account lifecycle ends sessions', () => {
  test('signing out revokes the token that was used', async ({ playwright }) => {
    const user = await createUser('logout');
    const { token } = await signIn(playwright, user.username, user.password);
    expect(token).toBeTruthy();
    expect(await meStatus(playwright, token!)).toBe(200);

    const ctx = await playwright.request.newContext();
    const out = await ctx.post('/api/auth/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    await ctx.dispose();
    expect(out.ok(), `logout (${out.status()})`).toBe(true);

    expect(await meStatus(playwright, token!)).toBe(401);
  });

  test('an admin password reset signs out existing sessions', async ({ playwright }) => {
    const user = await createUser('reset');
    const { token } = await signIn(playwright, user.username, user.password);
    expect(token).toBeTruthy();
    await nextSecond();

    const reset = await admin.post(`/api/admin/users/${user.id}/reset-password`);
    expect(reset.ok(), `reset (${reset.status()})`).toBe(true);
    const { password } = await reset.json();
    expect(password).toBeTruthy();
    expect(password).not.toBe(user.password);

    expect(await meStatus(playwright, token!)).toBe(401);
    expect((await signIn(playwright, user.username, user.password)).status).toBe(401);
    const fresh = await signIn(playwright, user.username, password);
    expect(fresh.status).toBe(200);
    expect(await meStatus(playwright, fresh.token!)).toBe(200);
  });

  test('deleting a user ends their sessions, and restoring does not revive them', async ({
    playwright,
  }) => {
    const user = await createUser('delete');
    const { token } = await signIn(playwright, user.username, user.password);
    expect(token).toBeTruthy();
    await nextSecond();

    const del = await admin.delete(`/api/admin/users/${user.id}`);
    expect(del.ok(), `delete (${del.status()})`).toBe(true);
    expect(await meStatus(playwright, token!)).toBe(401);
    expect((await signIn(playwright, user.username, user.password)).status).toBe(401);

    const restore = await admin.post(`/api/admin/users/${user.id}`);
    expect(restore.ok(), `restore (${restore.status()})`).toBe(true);
    expect(await meStatus(playwright, token!)).toBe(401);
    expect((await signIn(playwright, user.username, user.password)).status).toBe(200);
  });
});

test.describe('Audit trail', () => {
  test('user administration is recorded in order, attributed to the admin', async () => {
    const user = await createUser('audit');
    expect((await admin.delete(`/api/admin/users/${user.id}`)).ok()).toBe(true);
    expect((await admin.post(`/api/admin/users/${user.id}`)).ok()).toBe(true);

    const res = await admin.get('/api/admin/audit-logs', {
      params: { action_prefix: 'user', search: user.id, per_page: 50 },
    });
    expect(res.ok(), `audit-logs (${res.status()})`).toBe(true);
    const rows: { id: number; action_type: string; username: string | null; current_hash: string }[] =
      await res.json();

    const actions = [...rows].sort((a, b) => a.id - b.id).map((r) => r.action_type);
    expect(actions).toEqual(['user.created', 'user.deleted', 'user.restored']);
    for (const row of rows) {
      expect(row.username).toBe('admin');
      expect(row.current_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('audit appends are not failing', async () => {
    const res = await admin.get('/api/admin/audit-status');
    expect(res.ok(), `audit-status (${res.status()})`).toBe(true);
    const { appends } = await res.json();
    expect(appends.appends).toBeGreaterThan(0);
    expect(appends.failures).toBe(0);
  });
});
