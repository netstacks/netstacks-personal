import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { loader } from '@monaco-editor/react';
// Slim Monaco: the core editor API only — NOT the full `monaco-editor` entry,
// which pulls in ~80 languages plus the TypeScript/CSS/HTML language services
// and their multi-MB workers (none of which NetStacks uses). We then add back
// just the languages we need below.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
// Highlighting-only basic languages NetStacks actually edits (Monarch
// tokenizers, main-thread, tiny). YANG is registered separately (custom).
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
// JSON language service (schema validation + format, via json.worker).
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import { registerNetstacksLanguages } from './languages';
import { registerIconifyCollections } from './lib/iconifyInit';
import './index.css';
import './components/dialog.css';
import './components/primitives.css';
import './components/popoverCard.css';
import AppShell from './AppShell';
import { startClient, usesLocalAgent } from './lib/clientBootstrap';
import { useCapabilitiesStore } from './stores/capabilitiesStore';
import { startAiSettingsMirror } from './lib/aiSettingsMirror';
import PopoutTerminal from './components/PopoutTerminal';
import PopoutAIChat from './components/PopoutAIChat';
import SharedTerminal from './components/SharedTerminal';

// Use locally bundled Monaco instead of CDN (required for Tauri CSP)
import { logger } from './lib/logger'
import { applyAppTheme, getAppTheme, isAppTheme, setAppTheme } from './lib/appTheme';
import { applyWindowMaterial, followNativeTheme, followWindowFocus, isTauri, revealMainWindow, syncNativeWindow } from './lib/nativeWindow';
import { getPlatform } from './utils/platform';
import RevealMainWindow from './components/RevealMainWindow';
loader.config({ monaco });

document.documentElement.dataset.platform = getPlatform();

// ── App theme ──────────────────────────────────────────────────────────────
// Applied before first paint so there is no flash, for every entry path
// (full app, popout terminal/chat, shared view). A ?theme= URL param
// overrides (and persists) for popouts and quick switching.
{
  const urlTheme = new URLSearchParams(window.location.search).get('theme');
  if (isAppTheme(urlTheme)) {
    setAppTheme(urlTheme);
  } else {
    applyAppTheme(getAppTheme());
  }
}

void followWindowFocus();
if (isTauri()) {
  void followNativeTheme();
  void applyWindowMaterial();
  syncNativeWindow();
}

// Configure Monaco web workers for Vite
self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
        { type: 'module' }
      );
    }
    if (label === 'xml') {
      return new Worker(
        new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
        { type: 'module' }
      );
    }
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' }
    );
  },
};

// Register NetStacks-specific language features (YANG, XML format).
// JSON is left to Monaco's built-in json.worker.
registerNetstacksLanguages(monaco);

// Register iconify icon collections (vscode-icons for file-type icons).
registerIconifyCollections();

// Create TanStack Query client with sensible defaults
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Bootstrap a popout terminal window (minimal startup — no full app init)
async function bootstrapPopout(params: URLSearchParams) {
  await startClient();

  // NOTE: StrictMode intentionally double-invokes effects in dev to surface
  // non-idempotent side effects, but every SSH connect / SNMP poll / WS
  // subscribe in this app fires from useEffect — so dev runs were doubling
  // every real network call (and Peter's sshd was getting hammered). Prod
  // builds don't double-invoke regardless, so removing StrictMode here is
  // a dev-mode-only behavior change.
  createRoot(document.getElementById('root')!).render(
    <PopoutTerminal params={params} />
  );
}

// Bootstrap a popped-out AI chat window (the floating chat).
async function bootstrapPopoutChat() {
  await startClient();
  createRoot(document.getElementById('root')!).render(
    <PopoutAIChat />
  );
}

// Bootstrap the full application
async function bootstrap() {
  const result = await startClient();
  logger.log(`[main] App mode: ${result.mode}, requires auth: ${result.requiresAuth}`);

  // On the local agent, wait for its TLS cert to be installed into the OS trust
  // store before making any API calls. Tauri emits 'sidecar-tls-ready' once done.
  // Enterprise and remote-agent windows skip this — no local agent, no cert.
  if (usesLocalAgent(result.mode)) {
    // Skip outside Tauri (dev/test): @tauri-apps/api throws synchronously
    // if window.__TAURI_INTERNALS__ is undefined, and the rejection from
    // listen() inside the Promise executor below is unhandled — it would
    // surface as a pageerror. The cert wait is irrelevant in dev anyway.
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (inTauri) {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        await Promise.race([
          new Promise<void>(resolve => {
            // Catch the listen() rejection so it doesn't escape as an unhandled rejection.
            listen('sidecar-tls-ready', () => resolve()).catch(() => resolve());
          }),
          new Promise<void>(resolve => setTimeout(resolve, 3000)),
        ]);
      } catch {
        // Not in Tauri (dev/test) — proceed immediately
      }
    }
  }

  // Populate capabilities before the app renders so all sidebar tabs are visible.
  // In standalone mode this resolves synchronously with STANDALONE_CAPABILITIES;
  // in enterprise mode it fetches from the Controller after login instead.
  if (result.mode !== 'enterprise') {
    await useCapabilitiesStore.getState().fetchCapabilities();
    // The sidecar enforces some AI permission settings itself (background
    // tasks, bash deny list); keep its copy in step with localStorage.
    startAiSettingsMirror();
  }

  // See note in bootstrapPopout: StrictMode removed to stop dev double-fire
  // of network-bearing effects (SSH/SNMP/WebSockets).
  createRoot(document.getElementById('root')!).render(
    <>
    <RevealMainWindow />
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AppShell />
      </QueryClientProvider>
    </ErrorBoundary>
    </>
  );
}

// Bootstrap a shared terminal view (no auth, minimal UI)
function bootstrapShared(shareToken: string) {
  // Derive controller URL from current page URL
  // The share URL format is: {controller_url}/#share={token} or {controller_url}/terminal#share={token}
  const controllerUrl = window.location.origin;

  // See note in bootstrapPopout: StrictMode removed to stop dev double-fire.
  createRoot(document.getElementById('root')!).render(
    <SharedTerminal token={shareToken} controllerUrl={controllerUrl} />
  );
}

// Detect shared mode from URL fragment, popout window, or start full app
const params = new URLSearchParams(window.location.search);

// Check for #share={token} in URL fragment
const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
const shareToken = hashParams.get('share');

const popoutKind = params.get('popout');
const startFn = shareToken
  ? () => { bootstrapShared(shareToken); return Promise.resolve(); }
  : popoutKind === 'true'
    ? () => bootstrapPopout(params)
    : popoutKind === 'chat'
      ? () => bootstrapPopoutChat()
      : bootstrap;

async function startMockWorker() {
  if (import.meta.env.VITE_UI_MOCK !== '1') return;
  const { startMockBackend } = await import('./mocks/browser');
  await startMockBackend();
}

startMockWorker().then(startFn).catch((error) => {
  console.error('[main] Failed to initialize app:', error);
  // Build the failure screen with safe DOM APIs instead of innerHTML —
  // error.message can be anything (Tauri, the agent, third-party libs) and
  // interpolating it into innerHTML is an XSS sink.
  const root = document.getElementById('root')!;
  root.replaceChildren();
  const container = document.createElement('div');
  container.style.cssText =
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    "height:100vh;background:#1e1e1e;color:#cccccc;" +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";
  const title = document.createElement('h1');
  title.textContent = 'Failed to Start';
  const errorLine = document.createElement('p');
  errorLine.style.color = '#f44336';
  errorLine.textContent = `Error: ${(error && error.message) || String(error)}`;
  const hint = document.createElement('p');
  hint.textContent = 'Please restart the application.';
  container.append(title, errorLine, hint);
  root.appendChild(container);
  if (isTauri()) void revealMainWindow();
});
