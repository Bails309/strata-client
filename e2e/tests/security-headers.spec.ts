import { test, expect } from '@playwright/test';

// Static checks against the running stack that don't need an authenticated
// session — these guard the security-header & rate-limit posture exposed
// to anyone who can reach the public listener. Kept separate from
// api.spec.ts so that adding/removing one doesn't reshuffle the mainline
// auth flow tests.
test.describe('Security headers & rate-limits', () => {
  test('public /api/status sets the standard security headers', async ({ request }) => {
    const res = await request.get('/api/status');
    expect(res.ok()).toBe(true);
    const h = res.headers();

    // Security headers must always be present on public responses.
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBeTruthy();
    expect(h['referrer-policy']).toBeTruthy();
  });

  test('OPTIONS preflight to /api/auth/login does not echo arbitrary origin', async ({ request }) => {
    const res = await request.fetch('/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://attacker.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const allowed = res.headers()['access-control-allow-origin'];
    // Either the header is absent (CORS denied) or it must NOT echo the
    // attacker origin verbatim. A wildcard '*' is acceptable for the
    // public surface but is a weaker posture; either is safe here.
    if (allowed) {
      expect(allowed).not.toBe('https://attacker.example');
    }
  });

  test('repeated bad-password attempts eventually return 429', async ({ request }) => {
    // Keep the username unique so we don't pollute the real admin account's
    // counter and cause flakes in the auth.spec.ts tests that share state.
    const username = `ratelimit_probe_${Date.now()}`;
    let saw429 = false;
    for (let i = 0; i < 20; i++) {
      const res = await request.post('/api/auth/login', {
        data: { username, password: 'definitely-wrong' },
        failOnStatusCode: false,
      });
      if (res.status() === 429) {
        saw429 = true;
        break;
      }
      // 401 is the expected per-attempt response; anything else is suspicious.
      expect([401, 429]).toContain(res.status());
    }
    expect(saw429, 'expected the brute-force probe to be rate-limited within 20 attempts').toBe(true);
  });

  test('GET /api/health stays unauthenticated and lightweight', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBe(true);
    // Auth-protected probes bleed JWT introspection cost into uptime
    // monitoring; keep /api/health open and cheap.
    const h = res.headers();
    expect(h['www-authenticate']).toBeUndefined();
  });

  test('an obviously-malformed Authorization header is rejected, not crashed', async ({ request }) => {
    const res = await request.get('/api/user/me', {
      headers: { Authorization: 'Bearer ' + 'A'.repeat(8192) },
    });
    expect(res.status()).toBe(401);
    const body = await res.text();
    // Must not leak stack traces / panic messages.
    expect(body).not.toMatch(/panic|backtrace|thread .* panicked/i);
  });
});
