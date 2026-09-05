import { describe, it, expect } from 'vitest'
import { shareInFlight } from '../inflight'

describe('shareInFlight', () => {
  it('reuses the pending promise and refetches once settled', async () => {
    let calls = 0
    const fn = () => new Promise<number>((r) => setTimeout(() => r(++calls), 5))
    const [a, b] = await Promise.all([shareInFlight('k', fn), shareInFlight('k', fn)])
    expect(a).toBe(1)
    expect(b).toBe(1)
    expect(calls).toBe(1)
    expect(await shareInFlight('k', fn)).toBe(2)
  })

  it('does not cache rejections', async () => {
    let n = 0
    const fn = () => (n++ === 0 ? Promise.reject(new Error('boom')) : Promise.resolve('ok'))
    await expect(shareInFlight('r', fn)).rejects.toThrow('boom')
    expect(await shareInFlight('r', fn)).toBe('ok')
  })

  it('keys are independent', async () => {
    const [x, y] = await Promise.all([shareInFlight('x', async () => 'x'), shareInFlight('y', async () => 'y')])
    expect([x, y]).toEqual(['x', 'y'])
  })
})
