import App from './App';
import VaultUnlockGate from './components/VaultUnlockGate';
import { AuthProvider } from './components/auth/AuthProvider';
import HostKeyPromptModal from './components/HostKeyPromptModal';
import InteractionPanel from './components/InteractionPanel';
import { TokenUsageProvider } from './contexts/TokenUsageContext';

/**
 * The full application behind its gates. Enterprise: everything inside
 * AuthProvider mounts for the signed-in user and unmounts when they sign out,
 * so nothing one user had open (tabs, the AI pop-over, a prompt in flight,
 * token usage, pending approvals) carries over to whoever signs in next.
 * Standalone: AuthProvider passes straight through.
 */
export default function AppShell() {
  return (
    <VaultUnlockGate>
      <AuthProvider>
        <TokenUsageProvider>
          <App />
          {/* AUDIT FIX (REMOTE-001): always-mounted modal that surfaces
              pending SSH host-key fingerprint prompts. */}
          <HostKeyPromptModal />
          {/* Feature B: queued, kind-switched human-in-the-loop panel for
              background ReAct tasks (approval + ask_user question). */}
          <InteractionPanel />
        </TokenUsageProvider>
      </AuthProvider>
    </VaultUnlockGate>
  );
}
