import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync } from 'fs';

const appVersion = readFileSync('../VERSION', 'utf-8').trim();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@docs': path.resolve(__dirname, '../docs'),
      // Redirect all `import Guacamole from "guacamole-common-js"` imports
      // to our vendored 1.6.0 client. The npm package only publishes up to
      // 1.5.0, which mismatches the 1.6.x guacd we patch and ship,
      // producing ghost tiles on RDP. See lib/guacamole-adapter.ts.
      'guacamole-common-js': path.resolve(__dirname, './src/lib/guacamole-adapter.ts'),
    },
  },
  server: {
    fs: {
      allow: ['..'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
