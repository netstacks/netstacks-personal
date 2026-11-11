import { describe, it, expect, vi, beforeEach } from 'vitest'

// Enterprise: the Controller takes an entry's author from the signed-in user
// and ignores any sent, so none is sent; the local agent still stores it.
const mode = vi.hoisted(() => ({ current: 'enterprise' }))
const post = vi.hoisted(() => vi.fn(async (_url: string, body: unknown) => ({ data: body })))
vi.mock('../client', () => ({
  getClient: () => ({ http: { post } }),
  getCurrentMode: () => mode.current,
}))

import { createSessionContext, createSessionContextForDevice } from '../sessionContext'

const entry = { issue: 'BGP flaps', author: 'alice' }

beforeEach(() => post.mockClear())

describe('creating Team Knowledge entries', () => {
  it('enterprise: sends no author', async () => {
    mode.current = 'enterprise'
    await createSessionContext('def-1', entry)
    await createSessionContextForDevice('dev-1', entry)
    expect(post.mock.calls).toEqual([
      ['/sessions/def-1/context', { issue: 'BGP flaps', session_id: 'def-1' }],
      ['/devices/dev-1/context', { issue: 'BGP flaps', session_id: 'device-dev-1' }],
    ])
  })

  it('standalone: sends the author to the local agent', async () => {
    mode.current = 'standalone'
    await createSessionContext('s1', entry)
    expect(post).toHaveBeenCalledWith('/sessions/s1/context', { issue: 'BGP flaps', author: 'alice', session_id: 's1' })
  })
})
