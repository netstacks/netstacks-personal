import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface WindowConfig {
  label?: string
  visible?: boolean
  backgroundColor?: string
  decorations?: boolean
  hiddenTitle?: boolean
  trafficLightPosition?: { x: number; y: number }
  additionalBrowserArgs?: string
}

const TAURI_DIR = join(__dirname, '..', '..', 'src-tauri')

function windowsOf(file: string): WindowConfig[] {
  const config = JSON.parse(readFileSync(join(TAURI_DIR, file), 'utf8')) as { app: { windows: WindowConfig[] } }
  return config.app.windows
}

const linux = windowsOf('tauri.conf.json')
const macos = windowsOf('tauri.macos.conf.json')
const windows = windowsOf('tauri.windows.conf.json')

describe('tauri window config', () => {
  it.each([['linux (base)', linux], ['macos', macos], ['windows', windows]])(
    '%s: single hidden "main" window with a background color',
    (_name, wins) => {
      expect(wins).toHaveLength(1)
      expect(wins[0].label).toBe('main')
      expect(wins[0].visible).toBe(false)
      expect(wins[0].backgroundColor).toMatch(/^#[0-9a-f]{6}$/i)
    },
  )

  it('macOS hides the title and positions the traffic lights', () => {
    expect(macos[0].hiddenTitle).toBe(true)
    expect(macos[0].trafficLightPosition).toEqual({ x: 16, y: 16 })
  })

  it('Windows keeps the native frame (native caption buttons and Snap Layouts)', () => {
    expect(windows[0].decorations).toBe(true)
  })

  // WebView2 refuses to create popout-*/window-* windows on the shared data
  // directory if the main window was started with different browser args.
  it.each([['linux (base)', linux], ['macos', macos], ['windows', windows]])(
    '%s: does not override WebView2 browser args',
    (_name, wins) => {
      expect(wins[0].additionalBrowserArgs).toBeUndefined()
    },
  )

  it('Linux keeps the native frame', () => {
    expect(linux[0].decorations).toBe(true)
  })
})
