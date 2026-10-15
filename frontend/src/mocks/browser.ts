import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'
import { installTestHooks } from './testHooks'

const worker = setupWorker(...handlers)

// Agent traffic without a fixture fails loudly; static assets (Vite, app-config.json) pass through.
export async function startMockBackend(): Promise<void> {
  await worker.start({
    quiet: true,
    onUnhandledRequest(request, print) {
      const { protocol, pathname } = new URL(request.url)
      if (pathname.startsWith('/api/') || pathname.startsWith('/lsp/') || protocol.startsWith('ws')) print.error()
    },
  })
  installTestHooks()
}
