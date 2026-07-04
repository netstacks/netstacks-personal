import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}

vi.mock('../client', () => ({
  getClient: () => ({ http }),
}))

import { revealMappedKey } from '../mappedKeys'

describe('mappedKeys API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reveals a secret command via the reveal endpoint', async () => {
    http.get.mockResolvedValueOnce({ data: { command: 'enable\nsupersecret' } })
    const cmd = await revealMappedKey('abc-123')
    expect(http.get).toHaveBeenCalledWith('/mapped-keys/abc-123/reveal')
    expect(cmd).toBe('enable\nsupersecret')
  })
})
