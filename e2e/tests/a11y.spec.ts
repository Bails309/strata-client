// W4-3 Accessibility assertions on critical journeys.
// Runs axe-core via @axe-core/playwright against anonymous + authenticated
// surfaces. Fails only on serious/critical violations; moderate/minor findings
// are logged so they surface in CI output without gating the build.
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const SERIOUS_IMPACTS = new Set(["serious", "critical"]);

async function runAxe(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    // Disable colour-contrast — Tailwind default palette generates several
    // warnings that need a design-team pass rather than an engineering fix.
    .disableRules(["color-contrast"])
    .analyze();

  const serious = results.violations.filter((v) => SERIOUS_IMPACTS.has(v.impact ?? ""));
  if (results.violations.length > 0) {
    // Always log the full list so CI output is actionable.
    // eslint-disable-next-line no-console
    console.log(
      `[axe:${label}] ${results.violations.length} total violations ` +
        `(${serious.length} serious/critical):\n` +
        results.violations
          .map((v) => `  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes)`)
          .join("\n")
    );
  }

  // Gate: serious/critical only. Moderate/minor are visible but non-blocking.
  expect(serious, `Serious/critical a11y violations on ${label}`).toEqual([]);
}

test.describe("Accessibility (anonymous)", () => {
  test("login page has no serious a11y violations", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /sign in/i }).waitFor();
    await runAxe(page, "login");
  });
});

test.describe("Accessibility (authenticated)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.evaluate(async () => {
      // Same-origin login: server returns Set-Cookie headers (access_token,
      // refresh_token, csrf_token, session_expires) which the browser stores
      // automatically. No localStorage write needed under cookie auth.
      await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "admin" }),
      });
    });
  });

  test("dashboard has no serious a11y violations", async ({ page }) => {
    await page.goto("/");
    // Let React settle before scanning.
    await page.waitForLoadState("networkidle");
    await runAxe(page, "dashboard");
  });

  test("credentials page has no serious a11y violations", async ({ page }) => {
    await page.goto("/credentials");
    await page.waitForLoadState("networkidle");
    await runAxe(page, "credentials");
  });
});
