import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { ASK_AI_HELP_EVENT, type AskAiHelpDetail } from './components/AskAiHelp'
import { __resetPlatformForTests } from './utils/platform'

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>)
}

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
    const { container } = renderApp()
    expect(container).toBeInTheDocument()
  })

  it('renders a non-empty component', () => {
    const { container } = renderApp()
    // Verify the component renders something (not empty)
    expect(container.firstChild).toBeTruthy()
  })
})

describe('App sidebar navigation per platform', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    __resetPlatformForTests()
  })

  function renderOn(platform: 'macos' | 'windows') {
    vi.stubGlobal('location', { ...window.location, search: `?platform=${platform}` })
    __resetPlatformForTests()
    return renderApp()
  }

  it('Windows keeps the icon activity bar', () => {
    renderOn('windows')
    expect(screen.getByTestId('activity-bar')).toBeInTheDocument()
    expect(screen.queryByRole('listbox', { name: 'Navigate' })).toBeNull()
  })

  it('macOS shows the source list instead of the activity bar', () => {
    renderOn('macos')
    expect(screen.queryByTestId('activity-bar')).toBeNull()
    expect(screen.getByRole('listbox', { name: 'Navigate' })).toBeInTheDocument()
    expect(screen.getByTestId('nav-sessions')).toHaveAttribute('aria-selected', 'true')
  })
})

describe('App contextual Ask AI', () => {
  afterEach(() => cleanup())

  it('opens the floating AI pop-over when an Ask AI button fires', async () => {
    // jsdom has no layout; the pop-over scrolls its transcript as it renders.
    Element.prototype.scrollIntoView = vi.fn()
    renderApp()
    expect(screen.queryByPlaceholderText('Ask AI...')).toBeNull()
    const detail: AskAiHelpDetail = { prompt: 'Explain token matchers', position: { x: 100, y: 100 } }
    act(() => { window.dispatchEvent(new CustomEvent(ASK_AI_HELP_EVENT, { detail })) })
    expect(await screen.findByPlaceholderText('Ask AI...')).toBeInTheDocument()
  })
})
