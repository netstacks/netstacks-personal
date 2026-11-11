import { describe, it, expect, vi, beforeEach } from 'vitest'

const get = vi.fn()
vi.mock('../client', () => ({ getClient: () => ({ http: { get } }) }))

import { searchEntities } from '../search'

describe('searchEntities', () => {
  beforeEach(() => get.mockReset())

  it('returns [] for an empty query without calling the API', async () => {
    expect(await searchEntities('   ')).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })

  it('maps the response results', async () => {
    get.mockResolvedValue({ data: { results: [{ type: 'session', id: 's1', title: 'rtr', score: 100 }] } })
    const hits = await searchEntities('rtr')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ type: 'session', id: 's1', title: 'rtr' })
  })

  it('degrades to [] on 404', async () => {
    get.mockRejectedValueOnce({ response: { status: 404 } })
    expect(await searchEntities('rtr')).toEqual([])
  })

  it('degrades to [] on network error', async () => {
    get.mockRejectedValueOnce(new Error('boom'))
    expect(await searchEntities('rtr')).toEqual([])
  })
})
