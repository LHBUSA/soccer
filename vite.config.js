import { defineConfig } from 'vite';

// Frontend only: index.html + src/. Nothing under workers/, supabase/, scripts/,
// data/ or docs/ is ever copied into dist/ (Vercel serves dist/ only).
// Local dev/preview only: same-origin proxy to the public read-only API, mirroring api/soccer.js.
// SOCCER_API_TARGET (local QA only) points the proxy at a dark API version; production never reads it.
const devProxy = { '/api/soccer': { target: process.env.SOCCER_API_TARGET || 'https://soccer-api.sales-fd3.workers.dev', changeOrigin: true, rewrite: p => p.replace(/^\/api\/soccer/, '/v1') } };

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2020' },
  server: { proxy: devProxy },
  preview: { proxy: devProxy },
});
