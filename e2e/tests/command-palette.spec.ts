import { test, expect, type Page } from "@playwright/test";

/**
 * Smoke test: Ctrl+K opens the command palette on non-session screens.
 * Item-level: "make Ctrl+K available everywhere".
 */

test.describe("Command palette is global", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.getByPlaceholder("admin").fill("admin");
    await page.getByPlaceholder("••••••••").fill("admin");
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await expect(page).toHaveURL(/\/$|\/dashboard/i, { timeout: 10_000 });

    // Dismiss the Session Recording Disclaimer modal if it's blocking the
    // app. On a fresh CI database the seeded admin has not accepted the
    // current TERMS_VERSION, so CommandPaletteProvider is not mounted until
    // the modal is accepted. Scroll the disclaimer body to the bottom to
    // enable the "I Accept" button, then click it.
    const acceptBtn = page.getByRole("button", { name: /i accept/i });
    if (await acceptBtn.isVisible().catch(() => false)) {
      await page
        .getByRole("region", { name: /disclaimer content/i })
        .evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await expect(acceptBtn).toBeEnabled({ timeout: 5_000 });
      await acceptBtn.click();
      await expect(acceptBtn).toBeHidden({ timeout: 5_000 });
    }
  });

  test("Ctrl+K opens the palette on Dashboard (Connections)", async ({ page }) => {
    await openPaletteWithShortcut(page);
    await page.keyboard.press("Escape");
  });

  test("Ctrl+K opens the palette after navigating away from Dashboard", async ({ page }) => {
    // Profile is always reachable by any logged-in user.
    await page.goto("/profile");
    await openPaletteWithShortcut(page);
  });
});

// Background polling means `networkidle` never settles, so wait for the shell
// to render, then retry the shortcut until the palette's listener has mounted.
async function openPaletteWithShortcut(page: Page) {
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({ timeout: 10_000 });
  await expect(async () => {
    // Keep focus off autofocused inputs so the global listener sees the key.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Control+K");
    await expect(page.getByPlaceholder(/Search connections/i)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}
