import { defineConfig } from 'vite';

// base: '/DubNotes/' — GitHub Pages serves this project at
// https://<user>.github.io/DubNotes/, so every built asset URL must carry that
// sub-path prefix. Vite bakes `base` into the JS/CSS bundle references in
// dist/index.html and exposes it at runtime as import.meta.env.BASE_URL (used
// by sw-register.ts to register the worker at the right scope); everything
// else (manifest.webmanifest, sw.js, the app's own relative "./" references)
// resolves against the page's own URL, so it follows this automatically.
// Deploying to a different host? Set this back to './' (works at a domain
// root or under any sub-path without rebuilding per-target) or that host's
// own sub-path.
export default defineConfig({
  base: '/DubNotes/',
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: { target: 'es2020', outDir: 'dist' },
});
