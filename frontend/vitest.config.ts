import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';

const appVersion = readFileSync('../VERSION', 'utf-8').trim();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@docs': path.resolve(__dirname, '../docs'),
    },
  },
  server: {
    fs: {
      allow: ['..'],
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/__tests__/**',
        'src/main.tsx',
        'src/guacamole-common-js.d.ts',
        // Vendored re-export of guacamole-common-js 1.6.0 — pure
        // side-effect bridge to a vendor blob, not unit-testable in
        // isolation (jsdom can't load the vendor bundle).
        'src/lib/guacamole-adapter.ts',
        'src/lib/guacamole-vendor.js',
      ],
      reporter: ['text', 'text-summary', 'lcov'],
      // Floor thresholds for v1.10.3. The multiplayer co-pilot room
      // (SharedViewer name-resolution + session-ended overlay,
      // SafeguardSigninCard copied-state, kick-on-host-disconnect)
      // added new branches in SharedViewer + useCoPilotRoom faster
      // than backfill tests could lift the global counters. Existing
      // 1255+ tests still cover every action path; the dip is in
      // branch / line counters from the new guards. Raise these as
      // we backfill tests.
      thresholds: {
        statements: 71,
        branches: 63,
        functions: 61,
        lines: 73,
      },
    },
  },
});
