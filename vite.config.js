import { defineConfig } from 'vite';

// GitHub Pages serves the repo from /cross-over-war/, so use that as the
// production base. Dev uses './' so the site works from any local URL.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/cross-over-war/' : './',
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
}));
