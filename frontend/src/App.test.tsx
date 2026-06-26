import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import App from './App'

// Mock the API client module so render() doesn't blow up at mount time.
//
// The real `getClient()` throws if `initializeClient()` hasn't been called,
// and the app's render path eventually reaches it (via capabilitiesStore →
// isStandalone(), tunnelStore, useAgentTasks, etc.). We return a stub that
// satisfies the NetStacksClient interface and answers HTTP calls with empty
// arrays / null. That's enough for the smoke tests below to verify "render
// didn't crash".
vi.mock('./api/client', () => {
  const stubHttp = {
    // Return `data: []` so consumers that immediately `.filter()` / `.map()`
    // the response don't crash on null. Anything that needs a specific shape
    // can be addressed when broader component tests are added.
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
    defaults: { headers: { common: {} } },
    interceptors: {
      request: { use: vi.fn(), eject: vi.fn() },
      response: { use: vi.fn(), eject: vi.fn() },
    },
  }
  const stubClient = {
    http: stubHttp,
    mode: 'standalone' as const,
    hasEnterpriseFeatures: false,
    baseUrl: 'http://localhost:8080',
    wsUrl: (path: string) => `ws://localhost:8080${path}`,
    wsUrlWithAuth: (path: string) => `ws://localhost:8080${path}?token=test`,
  }
  return {
    initializeClient: vi.fn().mockResolvedValue({
      client: stubClient,
      mode: 'standalone',
      requiresAuth: false,
    }),
    getClient: () => stubClient,
    getCurrentMode: () => 'standalone',
    isClientInitialized: () => true,
    // StatusBar reads this on mount; null = "no remote-agent banner".
    getRemoteAgentHost: () => null,
    _resetClientForTesting: vi.fn(),
  }
})

describe('App', () => {
  it('renders without crashing', () => {
    // This is a smoke test to verify the test infrastructure works
    // More comprehensive tests can be added later
    const { container } = render(<App />)
    expect(container).toBeInTheDocument()
  })

  it('renders a non-empty component', () => {
    const { container } = render(<App />)
    // Verify the component renders something (not empty)
    expect(container.firstChild).toBeTruthy()
  })
})
