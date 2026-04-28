import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  // Run sequentially to avoid contention against the shared dev backend
  // (login rate-limit + a single nginx instance).
  workers: 1,
  use: {
    // Default to the HTTPS frontend so Secure cookies work end-to-end. The
    // dev cert is self-signed; ignoreHTTPSErrors lets Playwright accept it.
    baseURL: process.env.BASE_URL || 'https://localhost:8443',
    headless: true,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    // Disable the service worker in tests: with the dev self-signed cert,
    // chromium reports "SSL certificate error" for SW script fetches and the
    // partial registration leaves the page in a flaky load state. Tests do
    // not exercise offline behaviour, so registration can simply be skipped.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  reporter: [['html', { open: 'never' }]],
});
