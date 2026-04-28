import { test, expect } from '@playwright/test';

/**
 * Smoke test: Ctrl+K opens the command palette on non-session screens.
 * Item-level: "make Ctrl+K available everywhere".
 */

test.describe('Command palette is global', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('admin').fill('admin');
    await page.getByPlaceholder('••••••••').fill('admin');
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await expect(page).toHaveURL(/\/$|\/dashboard/i, { timeout: 10_000 });
  });

  test('Ctrl+K opens the palette on Dashboard (Connections)', async ({ page }) => {
    await page.keyboard.press('Control+K');
    await expect(page.getByPlaceholder(/Search connections/i)).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
  });

  test('Ctrl+K opens the palette after navigating away from Dashboard', async ({ page }) => {
    // Profile is always reachable by any logged-in user.
    await page.goto('/profile');
    await page.waitForLoadState('networkidle');
    // Ensure focus is on the document so keyboard events reach the global
    // capture-phase listener rather than being swallowed by an autofocused
    // input on the Profile page.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+K');
    await expect(page.getByPlaceholder(/Search connections/i)).toBeVisible({ timeout: 5_000 });
  });
});
