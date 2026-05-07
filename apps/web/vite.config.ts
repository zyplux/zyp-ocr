import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tanstackStart(), cloudflare({ viteEnvironment: { name: 'ssr' } })],
  server: {
    host: '0.0.0.0',
    port: 8787,
  },
});
