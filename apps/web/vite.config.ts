import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tanstackStart(), cloudflare({ viteEnvironment: { name: 'ssr' } })],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 8787,
  },
});
