import { test, expect, type Page, type TestInfo } from '@playwright/test'

function isMacProject(info: TestInfo): boolean {
  return info.project.name.startsWith('macos')
}

function mod(info: TestInfo): 'Meta' | 'Control' {
  return isMacProject(info) ? 'Meta' : 'Control'
}

async function openShell(page: Page, info: TestInfo): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('netstacks-settings', JSON.stringify({ 'app.setupComplete': true }))
  })
  await page.goto(`/${info.project.metadata.query as string}`)
  await expect(page.getByTestId('session-panel')).toBeVisible({ timeout: 60_000 })
  await page.keyboard.press(`${mod(info)}+t`)
  await expect(page.locator('.tab-bar .tab-type-terminal.tab-status-connected')).toHaveCount(1)
  await page.keyboard.press(`${mod(info)}+Shift+n`)
  await expect(page.locator('.tab-bar .tab-type-document')).toHaveCount(1)
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2)
}

const consoleErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }, info) => {
  const errors: string[] = []
  consoleErrors.set(page, errors)
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  await openShell(page, info)
})

test.afterEach(async ({ page }) => {
  expect(consoleErrors.get(page)).toEqual([])
})

test('shell-default', async ({ page }, info) => {
  const expectedTheme = info.project.use.colorScheme === 'light' ? 'light' : 'dark'
  await expect(page.locator('html')).toHaveAttribute('data-theme', expectedTheme)
  await expect(page).toHaveScreenshot('shell-default.png')
})

test('shell-sidebar-collapsed', async ({ page }, info) => {
  await page.keyboard.press(`${mod(info)}+b`)
  await expect(page).toHaveScreenshot('shell-sidebar-collapsed.png')
})

test('settings-panel', async ({ page }, info) => {
  await page.keyboard.press(`${mod(info)}+Comma`)
  await expect(page).toHaveScreenshot('settings-panel.png')
})

test('command-palette', async ({ page }, info) => {
  await page.keyboard.press(`${mod(info)}+Shift+p`)
  await expect(page).toHaveScreenshot('command-palette.png')
})

test('confirm-dialog', async ({ page }) => {
  await page.evaluate(() => { void window.__ns?.confirm() })
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await expect(page).toHaveScreenshot('confirm-dialog.png')
})

test('context-menu-tab', async ({ page }) => {
  await page.locator('.tab-bar .tab').first().click({ button: 'right' })
  await expect(page).toHaveScreenshot('context-menu-tab.png')
})

test('context-menu-sidebar', async ({ page }) => {
  await page.getByTestId('session-item').filter({ hasText: 'edge-sw-01' }).click({ button: 'right' })
  await expect(page).toHaveScreenshot('context-menu-sidebar.png')
})

test('focus-ring', async ({ page }, info) => {
  // macOS (WebKit) only tabs to every control with Option+Tab, as in Safari/WKWebView.
  const tabKey = isMacProject(info) ? 'Alt+Tab' : 'Tab'
  await page.locator('body').click({ position: { x: 700, y: 600 } })
  const firstRow = page.getByTestId('session-item').first()
  const rowHasFocus = () => firstRow.evaluate(el => el.contains(document.activeElement))
  for (let i = 0; i < 60 && !(await rowHasFocus()); i++) {
    await page.keyboard.press(tabKey)
  }
  expect(await rowHasFocus()).toBe(true)
  await expect(page).toHaveScreenshot('focus-ring.png')
})
