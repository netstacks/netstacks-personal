import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  post: vi.fn(),
}

vi.mock('../client', () => ({
  getClient: () => ({ http }),
}))

import { sftpUpload, SFTP_UPLOAD_TOO_LARGE_MESSAGE } from '../sftp'

describe('sftpUpload error mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps a bare HTTP 413 to the upload-limit message', async () => {
    http.post.mockRejectedValueOnce({ response: { status: 413, data: '' } })

    await expect(sftpUpload('sftp-1', '/remote/big.bin', new ArrayBuffer(8)))
      .rejects.toThrow(SFTP_UPLOAD_TOO_LARGE_MESSAGE)
  })

  it('prefers the agent error body for other failures', async () => {
    http.post.mockRejectedValueOnce({ response: { status: 500, data: { error: 'Permission denied' } } })

    await expect(sftpUpload('sftp-1', '/remote/x', new ArrayBuffer(8)))
      .rejects.toThrow('Permission denied')
  })

  it('falls back to the generic message when the body has no error', async () => {
    http.post.mockRejectedValueOnce({ response: { status: 500, data: {} } })

    await expect(sftpUpload('sftp-1', '/remote/x', new ArrayBuffer(8)))
      .rejects.toThrow('Failed to upload file')
  })
})
