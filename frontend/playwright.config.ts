import { defineConfig, devices } from '@playwright/test'

const BASE = 'http://localhost:5174'
const SHELL_SIZE = { viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 }
// WebKit stands in for WKWebView (macOS), Chromium for WebView2 (Windows).
const MAC = { ...devices['Desktop Safari'], ...SHELL_SIZE }
const WIN = { ...devices['Desktop Edge'], ...SHELL_SIZE }

export default defineConfig({
  testDir: './e2e',
  webServer: { command: 'npm run dev:mock', url: BASE, reuseExistingServer: true, timeout: 120_000 },
  use: { baseURL: BASE, colorScheme: 'dark' },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, threshold: 0.05, animations: 'disabled' } },
  projects: [
    { name: 'macos-dark', metadata: { query: '?platform=macos' }, use: MAC },
    { name: 'macos-light', metadata: { query: '?platform=macos&theme=system' }, use: { ...MAC, colorScheme: 'light' } },
    { name: 'windows-dark', metadata: { query: '?platform=windows' }, use: WIN },
    { name: 'windows-light', metadata: { query: '?platform=windows&theme=system' }, use: { ...WIN, colorScheme: 'light' } },
  ],
})
