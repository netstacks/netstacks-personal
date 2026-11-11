import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, cleanup, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { User } from './types/auth'

// Enterprise: the app mounts per signed-in user — signing out unmounts it, so
// nothing one user had open is there when the next signs in. Standalone has
// no sign-in and the app renders at once.
const env = vi.hoisted(() => ({ enterprise: true }))

vi.mock('./api/client', () => {
  const http = {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: vi.fn(), eject: vi.fn() }, response: { use: vi.fn(), eject: vi.fn() } },
  }
  const client = () => ({
    http,
    mode: env.enterprise ? 'enterprise' : 'standalone',
    hasEnterpriseFeatures: env.enterprise,
    baseUrl: 'https://controller.test',
    wsUrl: (path: string) => `wss://controller.test${path}`,
    wsUrlWithAuth: (path: string) => `wss://controller.test${path}?token=test`,
  })
  return {
    initializeClient: vi.fn(),
    getClient: client,
    getCurrentMode: () => (env.enterprise ? 'enterprise' : 'standalone'),
    isClientInitialized: () => true,
    getRemoteAgentHost: () => null,
    _resetClientForTesting: vi.fn(),
  }
})
vi.mock('./hooks/useMode', () => ({
  useMode: () => ({
    mode: env.enterprise ? 'enterprise' : 'standalone',
    isEnterprise: env.enterprise,
    isStandalone: !env.enterprise,
    hasEnterpriseFeatures: env.enterprise,
    isInitialized: true,
    controllerUrl: env.enterprise ? 'https://controller.test' : null,
  }),
}))
// Nobody is signed in at start: the auth check finds no session.
vi.mock('./api/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api/auth')>(),
  getCurrentUser: vi.fn().mockRejectedValue(new Error('401')),
  logout: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>()
  return { ...actual, default: { ...actual.default, get: vi.fn().mockResolvedValue({ data: {} }) } }
})
// The user's preferences: only the scope matters here.
vi.mock('./lib/userPreferences', async () => {
  const { setUserScope, clearUserScope } = await import('./lib/userScope')
  return {
    loadUserPreferences: async (controllerUrl: string, userId: string) => setUserScope(controllerUrl, userId),
    releaseUserPreferences: () => clearUserScope(),
  }
})
vi.mock('./components/auth/LoginScreen', () => ({ LoginScreen: () => <div>Sign in</div> }))
vi.mock('./components/VaultUnlockGate', () => ({ default: ({ children }: { children: ReactElement }) => children }))
// Enterprise panels list Controller data this stub doesn't model.
vi.mock('./components/EnterpriseDevicePanel', () => ({ default: () => null }))
vi.mock('./components/HostKeyPromptModal', () => ({ default: () => null }))
vi.mock('./components/InteractionPanel', () => ({ default: () => null }))

import AppShell from './AppShell'
import { useAuthStore } from './stores/authStore'
import { useCapabilitiesStore } from './stores/capabilitiesStore'
import { useUserScopeStore } from './lib/userScope'
import { ASK_AI_HELP_EVENT, type AskAiHelpDetail } from './components/AskAiHelp'
import { confirmDialog } from './components/ConfirmDialog'
import { showToast } from './components/Toast'

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function user(id: string): User {
  return { id, email: `${id}@example.test`, display_name: id } as unknown as User
}

async function signIn(id: string) {
  await act(async () => {
    useAuthStore.setState({ isAuthenticated: true, user: user(id), accessToken: `token-${id}` })
  })
  // Their capabilities arrive (authStore fetches them at sign-in).
  await act(async () => { await useCapabilitiesStore.getState().fetchCapabilities() })
}

async function signOut() {
  await act(async () => { await useAuthStore.getState().logout() })
}

function askAi(prompt: string) {
  const detail: AskAiHelpDetail = { prompt, position: { x: 100, y: 100 } }
  act(() => { window.dispatchEvent(new CustomEvent(ASK_AI_HELP_EVENT, { detail })) })
}

describe('AppShell in enterprise', () => {
  beforeEach(() => {
    env.enterprise = true
    // jsdom has no layout; the pop-over scrolls its transcript as it renders.
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => {
    cleanup()
    useAuthStore.setState({ isAuthenticated: false, user: null, accessToken: null })
    useUserScopeStore.setState({ scope: null })
  })

  it('shows only the sign-in screen until a user signs in', async () => {
    render(<AppShell />)
    expect(await screen.findByText('Sign in')).toBeInTheDocument()
    expect(screen.queryByTestId('activity-bar')).toBeNull()
  })

  it("signing out unmounts the app: the next user never sees the previous user's AI pop-over or prompt", async () => {
    render(<AppShell />)
    await screen.findByText('Sign in')

    await signIn('alice')
    expect(await screen.findByTestId('activity-bar')).toBeInTheDocument()
    askAi('alice private question')
    expect(await screen.findByPlaceholderText('Ask AI...')).toBeInTheDocument()

    await signOut()
    expect(await screen.findByText('Sign in')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Ask AI...')).toBeNull()
    // Signing out drops the previous user's capabilities.
    expect(useCapabilitiesStore.getState().capabilities).toBeNull()

    await signIn('bob')
    expect(await screen.findByTestId('activity-bar')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Ask AI...')).toBeNull()
    expect(screen.queryByText(/alice private question/)).toBeNull()
  })

  it("signing out cancels the previous user's pending confirm and drops their toasts", async () => {
    render(<AppShell />)
    await screen.findByText('Sign in')
    await signIn('alice')
    await screen.findByTestId('activity-bar')

    let answer: boolean | undefined
    act(() => {
      void confirmDialog({ title: 'Delete alice-router?', body: <>Delete it?</> }).then((v) => { answer = v })
      showToast('alice-router saved', 'error')
    })
    expect(await screen.findByText('Delete alice-router?')).toBeInTheDocument()
    expect(screen.getByText('alice-router saved')).toBeInTheDocument()

    await signOut()
    await signIn('bob')
    await screen.findByTestId('activity-bar')
    expect(answer).toBe(false)
    expect(screen.queryByText('Delete alice-router?')).toBeNull()
    expect(screen.queryByText('alice-router saved')).toBeNull()
  })
})

describe('AppShell in standalone', () => {
  beforeEach(() => { env.enterprise = false })
  afterEach(() => cleanup())

  it('renders the app at once, with no sign-in', async () => {
    await act(async () => { await useCapabilitiesStore.getState().fetchCapabilities() })
    render(<AppShell />)
    expect(await screen.findByTestId('activity-bar')).toBeInTheDocument()
    expect(screen.queryByText('Sign in')).toBeNull()
  })
})
