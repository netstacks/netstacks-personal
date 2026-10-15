import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const get = vi.hoisted(() => vi.fn())
vi.mock('axios', () => ({ default: { get } }))
const desktop = vi.hoisted(() => ({ value: false }))
vi.mock('../../lib/nativeWindow', () => ({ isTauri: () => desktop.value }))

import { fetchCaCertificateInfo } from '../tlsTrust'

const INFO = { tls_enabled: true, fingerprint: 'AB:CD', ca_certificate_pem: 'PEM' }
const urls = () => get.mock.calls.map(([url]) => url)

beforeEach(() => {
  get.mockReset()
  desktop.value = false
})
afterEach(() => vi.unstubAllGlobals())

describe('fetchCaCertificateInfo', () => {
  it('asks over HTTPS first', async () => {
    get.mockResolvedValue({ data: INFO })
    expect(await fetchCaCertificateInfo('http://controller.test:3000')).toEqual(INFO)
    expect(urls()).toEqual(['https://controller.test:3000/api/tls/ca-certificate/info'])
  })

  it('desktop app: falls back to plain HTTP when HTTPS fails', async () => {
    desktop.value = true
    get.mockRejectedValueOnce(new Error('self-signed certificate')).mockResolvedValueOnce({ data: INFO })
    expect(await fetchCaCertificateInfo('https://controller.test')).toEqual(INFO)
    expect(urls()).toEqual([
      'https://controller.test/api/tls/ca-certificate/info',
      'http://controller.test/api/tls/ca-certificate/info',
    ])
  })

  it('browser: never tries plain HTTP to another origin (always blocked there)', async () => {
    vi.stubGlobal('location', { ...window.location, origin: 'https://controller.test' })
    get.mockRejectedValue(new Error('Network Error'))
    expect(await fetchCaCertificateInfo('https://controller.test')).toBeNull()
    expect(urls()).toEqual(['https://controller.test/api/tls/ca-certificate/info'])
  })

  it("browser served over plain HTTP: the page's own origin is still tried", async () => {
    vi.stubGlobal('location', { ...window.location, origin: 'http://controller.test' })
    get.mockRejectedValueOnce(new Error('Network Error')).mockResolvedValueOnce({ data: INFO })
    expect(await fetchCaCertificateInfo('http://controller.test')).toEqual(INFO)
    expect(urls()).toEqual([
      'https://controller.test/api/tls/ca-certificate/info',
      'http://controller.test/api/tls/ca-certificate/info',
    ])
  })
})
