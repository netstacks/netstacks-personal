import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const calls: string[] = []
const update = {
  version: '9.9.9',
  body: 'notes',
  date: '2026-10-29',
  download: vi.fn(async () => { calls.push('download') }),
  install: vi.fn(async () => { calls.push('install') }),
  downloadAndInstall: vi.fn(async () => { calls.push('downloadAndInstall') }),
}
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => update) }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(async () => { calls.push('plugin-process relaunch') }) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async (cmd: string) => { calls.push(cmd) }) }))

import UpdateChecker from '../UpdateChecker'

async function openBannerAndInstall() {
  vi.useFakeTimers()
  render(<UpdateChecker />)
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  vi.useRealTimers()
  fireEvent.click(await screen.findByRole('button', { name: 'Install Now' }))
}

describe('UpdateChecker install flow', () => {
  beforeEach(() => {
    calls.length = 0
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    update.install.mockImplementation(async () => { calls.push('install') })
  })
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('downloads, stops the agent, installs, then relaunches via the shell command', async () => {
    await openBannerAndInstall()
    await waitFor(() => expect(calls).toContain('relaunch_app'))
    // Agent stopped only after the download (app stays usable meanwhile) and
    // before the installer runs; never plugin-process relaunch (macOS LAN bug).
    expect(calls).toEqual(['download', 'stop_sidecar', 'install', 'relaunch_app'])
  })

  it('relaunches on the current version when install fails after the agent was stopped', async () => {
    update.install.mockImplementation(async () => { calls.push('install'); throw new Error('boom') })
    await openBannerAndInstall()
    await waitFor(() => expect(calls).toContain('relaunch_app'))
    expect(calls).toEqual(['download', 'stop_sidecar', 'install', 'relaunch_app'])
  })
})
