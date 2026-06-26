import { describe, expect, it } from 'vitest'
import { AxiosError } from 'axios'
import { getApiErrorMessage, isApiErrorCode, parseApiError } from '../errors'

function createAxiosError(status: number, data: unknown): AxiosError {
  const error = new AxiosError('Request failed')
  ;(error as AxiosError & { response: unknown }).response = {
    status,
    data,
  }
  return error
}

describe('API error helpers', () => {
  it('parses status, code, and error from axios responses', () => {
    const err = createAxiosError(403, { code: 'VAULT_LOCKED', error: 'Vault is locked' })

    expect(parseApiError(err)).toEqual({
      status: 403,
      code: 'VAULT_LOCKED',
      error: 'Vault is locked',
    })
  })

  it('matches specific API error codes', () => {
    const err = createAxiosError(503, { code: 'NOT_CONFIGURED', error: 'AI provider not configured' })
    expect(isApiErrorCode(err, 'NOT_CONFIGURED')).toBe(true)
    expect(isApiErrorCode(err, 'VAULT_LOCKED')).toBe(false)
  })

  it('returns fallback when payload has no error field', () => {
    const err = createAxiosError(500, { message: 'internal' })
    expect(getApiErrorMessage(err, 'Fallback message')).toBe('Fallback message')
  })
})
