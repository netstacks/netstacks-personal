import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  post: vi.fn(),
}

let mode: 'standalone' | 'enterprise' = 'standalone'

vi.mock('../client', () => ({
  getClient: () => ({ http }),
  getCurrentMode: () => mode,
}))

import {
  getApiKey,
  storeApiKey,
  deleteApiKey,
  hasVaultApiKey,
  getVaultApiKey,
  storeVaultApiKey,
  deleteVaultApiKey,
} from '../vault'

describe('vault API contract mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mode = 'standalone'
  })

  it('stores API keys using api_key field', async () => {
    http.put.mockResolvedValueOnce({})

    await storeApiKey('anthropic', 'secret-key')

    expect(http.put).toHaveBeenCalledWith('/vault/api-keys/anthropic', { api_key: 'secret-key' })
  })

  it('maps getApiKey response from api_key', async () => {
    http.get.mockResolvedValueOnce({ data: { api_key: 'stored-value' } })

    const result = await getApiKey('openai')

    expect(result).toBe('stored-value')
    expect(http.get).toHaveBeenCalledWith('/vault/api-keys/openai')
  })

  it('returns null for missing key', async () => {
    http.get.mockRejectedValueOnce({ response: { status: 404 } })

    const result = await getApiKey('smtp')

    expect(result).toBeNull()
  })

  it('checks key existence via /exists endpoint', async () => {
    http.get.mockResolvedValueOnce({ data: { exists: true } })

    const exists = await hasVaultApiKey('ai.anthropic')

    expect(exists).toBe(true)
    expect(http.get).toHaveBeenCalledWith('/vault/api-keys/ai.anthropic/exists')
  })

  it('supports generic vault key helpers for ai namespace', async () => {
    http.put.mockResolvedValueOnce({})
    http.get.mockResolvedValueOnce({ data: { api_key: 'ai-secret' } })
    http.delete.mockResolvedValueOnce({})

    await storeVaultApiKey('ai.anthropic', 'ai-secret')
    expect(http.put).toHaveBeenCalledWith('/vault/api-keys/ai.anthropic', { api_key: 'ai-secret' })

    const key = await getVaultApiKey('ai.anthropic')
    expect(key).toBe('ai-secret')

    await deleteVaultApiKey('ai.anthropic')
    expect(http.delete).toHaveBeenCalledWith('/vault/api-keys/ai.anthropic')
  })

  it('blocks local vault operations in enterprise mode', async () => {
    mode = 'enterprise'

    await expect(storeApiKey('anthropic', 'k')).rejects.toThrow('Local vault is not available in enterprise mode')
    await expect(deleteApiKey('anthropic')).rejects.toThrow('Local vault is not available in enterprise mode')
    await expect(getApiKey('anthropic')).rejects.toThrow('Local vault is not available in enterprise mode')
  })
})
