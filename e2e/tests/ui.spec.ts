import { test, expect } from '@playwright/test';

test.describe('Login UI', () => {
  test('shows login page with form', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByPlaceholder('admin')).toBeVisible();
    await expect(page.getByPlaceholder('••••••••')).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });

  test('sign in button is disabled when fields empty', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: /sign in/i })).toBeDisabled();
  });

  test('shows error on invalid credentials', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('admin').fill('admin');
    await page.getByPlaceholder('••••••••').fill('wrong-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.locator('.bg-danger-dim, [class*="danger"]')).toBeVisible({ timeout: 5000 });
  });

  test('successful login redirects to dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('admin').fill('admin');
    await page.getByPlaceholder('••••••••').fill('admin');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Should navigate away from /login
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
  });

  test('unauthenticated user is redirected to login', async ({ page, context }) => {
    // Clear any stored auth state.
    await context.clearCookies();
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.goto('/');

    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('Authenticated navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Same-origin login via the actual UI form. The browser stores the
    // HttpOnly access/refresh cookies + the JS-readable csrf_token and
    // session_expires cookies automatically; subsequent navigations are
    // authenticated.
    await page.goto('/login');
    await page.getByPlaceholder('admin').fill('admin');
    await page.getByPlaceholder('••••••••').fill('admin');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
  });

  test('dashboard loads after login', async ({ page }) => {
    await page.goto('/');
    // Should not redirect to login
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
  });

  test('shared viewer route is accessible', async ({ page }) => {
    await page.goto('/shared/test-token-123');
    // Should load the shared viewer (may show an error for invalid token, but should not 404)
    await expect(page.locator('body')).toContainText(/.+/);
  });
});

test.describe('Security headers', () => {
  test('CSP header is present on HTML pages', async ({ page }) => {
    const response = await page.goto('/login');
    const csp = response?.headers()['content-security-policy'];
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test('X-Content-Type-Options is nosniff', async ({ page }) => {
    const response = await page.goto('/login');
    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('X-Frame-Options is DENY', async ({ page }) => {
    const response = await page.goto('/login');
    expect(response?.headers()['x-frame-options']).toBe('DENY');
  });

  test('no Server version exposed', async ({ page }) => {
    const response = await page.goto('/login');
    const server = response?.headers()['server'] || '';
    // server_tokens off hides the version; ensure no version number is leaked
    expect(server).not.toMatch(/\d/);
  });

  test('CSP does not allow unsafe-eval scripts', async ({ page }) => {
    const response = await page.goto('/login');
    const csp = response?.headers()['content-security-policy'] || '';
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] || '';
    expect(scriptSrc).not.toContain('unsafe-eval');
  });
});
