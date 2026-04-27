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
      thresholds: {
        statements: 76,
        branches: 67,
        functions: 64,
        lines: 77,
      },
    },
  },
});
