import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Pact contract test configuration
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/api/__tests__/pact/**/*.pact.test.ts'],
    testTimeout: 30000,
  },
})
