import { describe, it, expect, vi, beforeEach } from 'vitest'

const getAiProfile = vi.hoisted(() => vi.fn())
vi.mock('../api/aiEngineerProfile', () => ({ getAiProfile }))
vi.mock('../api/client', () => ({ getCurrentMode: () => 'enterprise' }))

import { useAssistantNameStore } from './assistantName'
import { setUserScope, clearUserScope } from '../lib/userScope'

beforeEach(() => {
  clearUserScope()
  getAiProfile.mockReset()
  useAssistantNameStore.setState({ name: 'AI Assistant', loaded: false })
})

describe('assistant name in enterprise', () => {
  it('waits for a signed-in user before reading the profile', async () => {
    await useAssistantNameStore.getState().load()
    expect(getAiProfile).not.toHaveBeenCalled()
    expect(useAssistantNameStore.getState().loaded).toBe(false)
  })

  it('loads the profile name per user and resets on a change of user', async () => {
    getAiProfile.mockResolvedValue({ name: 'NetBot' })
    setUserScope('https://controller.test', 'alice')
    await useAssistantNameStore.getState().load()
    expect(useAssistantNameStore.getState().name).toBe('NetBot')

    setUserScope('https://controller.test', 'bob')
    expect(useAssistantNameStore.getState()).toMatchObject({ name: 'AI Assistant', loaded: false })
  })
})
