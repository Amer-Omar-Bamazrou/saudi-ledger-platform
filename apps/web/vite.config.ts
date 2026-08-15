import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

/**
 * 🔴 The config must load `.env` ITSELF.
 *
 * These values are read while the config module is evaluated, and Vite loads
 * `.env` files AFTER that — and then only exposes `VITE_`-prefixed vars to the
 * client, never to `process.env` for this file. So reading `process.env.PORT`
 * directly meant `.env` was never consulted, and the setup `.env.example`
 * documents ("copy to .env and adjust") could not work: a fresh clone failed
 * with "PORT environment variable is required" no matter what the file said.
 * On Windows that was the second of two blockers between `pnpm install` and a
 * running dev server.
 *
 * `loadEnv(mode, dir, '')` — empty prefix — reads every key from `.env`,
 * `.env.local` and the mode-specific files. A real environment variable still
 * wins, so CI and container deployments that set PORT directly are unaffected.
 *
 * The fail-fast throws are kept deliberately: a silently-defaulted port is
 * worse than a refusal, because it starts a server nobody is looking at.
 */
// `async` because the Replit plugins below are conditionally `await import`ed.
export default defineConfig(async ({ mode }) => {
  const fileEnv = loadEnv(mode, import.meta.dirname, '');
  const env = { ...fileEnv, ...process.env };

  const rawPort = env.PORT;
  if (!rawPort) {
    throw new Error(
      'PORT environment variable is required but was not provided. ' +
        'Copy apps/web/.env.example to apps/web/.env.',
    );
  }

  const port = Number(rawPort);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const basePath = env.BASE_PATH;
  if (!basePath) {
    throw new Error(
      'BASE_PATH environment variable is required but was not provided. ' +
        'Copy apps/web/.env.example to apps/web/.env.',
    );
  }

  return {
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(env.NODE_ENV !== 'production' &&
    env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    // DEV-ONLY: the frontend calls the API same-origin at `/api` (see
    // src/lib/api.ts). In production a single origin serves both, so this just
    // works. Locally the web dev server (this port) and the API (:3000) are
    // separate origins, so we proxy `/api` to the API here. Vite's proxy runs
    // only under `vite dev` — it has NO effect on the production build. Override
    // the target with API_PROXY_TARGET if the API runs elsewhere.
    proxy: {
      '/api': {
        target: env.API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
  };
});
