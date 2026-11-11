import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Controller answers an upstream provider failure with 502 and an
// exhausted token budget with 429 (each `{ error }`), and 503 NOT_CONFIGURED
// when no provider exists: each reads as what happened, not a generic failure.
const mode = vi.hoisted(() => ({ current: 'enterprise' }))
const post = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({
  getClient: () => ({ http: { post } }),
  getCurrentMode: () => mode.current,
}))

import { aiHttpErrorMessage, sendChatMessage, analyzeHighlights, AiNotConfiguredError, aiNotConfiguredReason, describeAiError } from '../ai'

const refusal = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data } })

beforeEach(() => {
  post.mockReset()
  mode.current = 'enterprise'
})

describe('AI request failures', () => {
  it('429: the token budget is used up', () => {
    expect(aiHttpErrorMessage(429, 'monthly budget of 1000000 tokens reached', 'x'))
      .toBe('Your AI token budget is used up: monthly budget of 1000000 tokens reached. Try again later, or ask your administrator to raise it.')
    mode.current = 'standalone'
    expect(aiHttpErrorMessage(429, undefined, 'x')).toBe('AI request limit reached. Try again later.')
  })

  it('502: the AI provider failed', () => {
    expect(aiHttpErrorMessage(502, 'anthropic: overloaded', 'x')).toBe('The AI provider returned an error: anthropic: overloaded. Try again in a moment.')
  })

  it("anything else: the backend's reason, else the fallback", () => {
    expect(aiHttpErrorMessage(400, 'bad request', 'x')).toBe('bad request')
    expect(aiHttpErrorMessage(500, undefined, 'Failed')).toBe('Failed')
  })

  it('chat maps 429 / 502 / 503 NOT_CONFIGURED', async () => {
    post.mockRejectedValueOnce(refusal(429, { error: 'budget reached' }))
    await expect(sendChatMessage([{ role: 'user', content: 'hi' }])).rejects.toThrow(/token budget is used up: budget reached/)
    post.mockRejectedValueOnce(refusal(502, { error: 'upstream timeout' }))
    await expect(sendChatMessage([{ role: 'user', content: 'hi' }])).rejects.toThrow(/AI provider returned an error: upstream timeout/)
    post.mockRejectedValueOnce(refusal(503, { code: 'NOT_CONFIGURED', error: 'No AI provider configured' }))
    await expect(sendChatMessage([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(AiNotConfiguredError)
  })

  // The Controller's 503 body speaks to whoever can open its Admin UI.
  const CONTROLLER_NOT_CONFIGURED = { code: 'NOT_CONFIGURED', error: 'AI is not configured. Configure LLM providers in the Admin UI.' }

  it('503 NOT_CONFIGURED in enterprise: the shared administrator wording, not the Controller text', async () => {
    expect(aiNotConfiguredReason(CONTROLLER_NOT_CONFIGURED.error)).toBe(
      'AI not configured. Ask your administrator to set up an AI provider on the Controller (Admin UI → AI → LLM Providers).',
    )
    post.mockRejectedValueOnce(refusal(503, CONTROLLER_NOT_CONFIGURED))
    const err = await sendChatMessage([{ role: 'user', content: 'hi' }]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AiNotConfiguredError)
    expect((err as Error).message).toMatch(/Ask your administrator to set up an AI provider on the Controller/)
    expect(describeAiError(err, 'x')).toMatch(/Ask your administrator/)
    post.mockRejectedValueOnce(refusal(503, CONTROLLER_NOT_CONFIGURED))
    await expect(analyzeHighlights('out', 'errors')).rejects.toThrow(/Ask your administrator to set up an AI provider/)
  })

  it("503 NOT_CONFIGURED in standalone: the sidecar's specific reason, else the standalone wording", async () => {
    mode.current = 'standalone'
    expect(aiNotConfiguredReason('No API key for anthropic')).toBe('No API key for anthropic')
    expect(aiNotConfiguredReason(undefined)).toBe('AI not configured. Add your API key in Settings > AI.')
    post.mockRejectedValueOnce(refusal(503, { code: 'NOT_CONFIGURED', error: 'No API key for anthropic' }))
    await expect(sendChatMessage([{ role: 'user', content: 'hi' }])).rejects.toThrow('No API key for anthropic')
  })
})
