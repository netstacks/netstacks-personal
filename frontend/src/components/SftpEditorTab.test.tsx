import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import SftpEditorTab from './SftpEditorTab'

// NS-APP-11: File → Save / Cmd+S reach the SFTP editor only through the
// `netstacks:save-document` event App dispatches for the active tab — there
// is no raw keydown listener in the component any more.
vi.mock('../api/sftp', () => ({
  sftpDownload: vi.fn().mockResolvedValue({ text: () => Promise.resolve('hello') }),
  sftpUpload: vi.fn().mockResolvedValue(undefined),
}))

import { sftpUpload } from '../api/sftp'

function dispatchSave(tabId: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent('netstacks:save-document', { detail: { tabId } }))
  })
}

afterEach(() => {
  cleanup()
  vi.mocked(sftpUpload).mockClear()
})

describe('SftpEditorTab save path', () => {
  it('saves on netstacks:save-document for its own tab id only', async () => {
    render(
      <SftpEditorTab
        tabId="tab-1"
        connectionId="conn"
        filePath="/etc/motd"
        fileName="motd"
        deviceName="r1"
        onDirtyChange={() => {}}
      />
    )
    const textarea = await screen.findByRole('textbox')
    await waitFor(() => expect(textarea).toHaveValue('hello'))
    fireEvent.change(textarea, { target: { value: 'hello world' } })

    dispatchSave('some-other-tab')
    expect(sftpUpload).not.toHaveBeenCalled()

    dispatchSave('tab-1')
    await waitFor(() => expect(sftpUpload).toHaveBeenCalledTimes(1))
    expect(vi.mocked(sftpUpload).mock.calls[0][0]).toBe('conn')
    expect(vi.mocked(sftpUpload).mock.calls[0][1]).toBe('/etc/motd')
  })

  it('does not react to a raw Cmd+S keydown', async () => {
    render(
      <SftpEditorTab
        tabId="tab-1"
        connectionId="conn"
        filePath="/etc/motd"
        fileName="motd"
        deviceName="r1"
        onDirtyChange={() => {}}
      />
    )
    const textarea = await screen.findByRole('textbox')
    await waitFor(() => expect(textarea).toHaveValue('hello'))
    fireEvent.change(textarea, { target: { value: 'changed' } })
    fireEvent.keyDown(textarea, { key: 's', metaKey: true, bubbles: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(sftpUpload).not.toHaveBeenCalled()
  })
})
