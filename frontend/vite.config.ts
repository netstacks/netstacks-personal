import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Strip noisy debug logging from production bundles. Marking these
  // call expressions as side-effect-free lets esbuild's tree-shaker
  // drop them entirely. console.warn / console.error are preserved
  // because they carry real signal (failed fetches, TLS errors, etc.).
  esbuild: mode === 'production'
    ? { pure: ['console.log', 'console.debug', 'console.info', 'console.trace'] }
    : undefined,
  server: {
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
