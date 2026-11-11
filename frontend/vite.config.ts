import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Serves the MSW worker from node_modules in UI-mock dev runs only, so it is
// never copied into public/ and never ships in a production bundle.
function mswWorker(): Plugin {
  const workerPath = createRequire(import.meta.url).resolve('msw/mockServiceWorker.js')
  return {
    name: 'netstacks-msw-worker',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/mockServiceWorker.js', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript')
        res.end(readFileSync(workerPath))
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: process.env.VITE_UI_MOCK === '1' ? [react(), mswWorker()] : [react()],
  // Strip noisy debug logging from production bundles. Marking these
  // call expressions as side-effect-free lets esbuild's tree-shaker
  // drop them entirely. console.warn / console.error are preserved
  // because they carry real signal (failed fetches, TLS errors, etc.).
  esbuild: mode === 'production'
    ? { pure: ['console.log', 'console.debug', 'console.info', 'console.trace'] }
    : undefined,
  server: {
    // Pre-transform the app's module graph as soon as the dev server starts
    // instead of on the first browser request. The app is ~800 modules; without
    // this the first load in `terminal-dev.sh` waits on every transform (~12 s
    // cold on a fast box) while the Tauri window sits blank.
    warmup: {
      clientFiles: ['./src/main.tsx', './src/App.tsx'],
    },
    proxy: {
      // Proxy API requests to the Rust backend
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      // Proxy WebSocket connections
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
}))
