/**
 * Resolved display name for the AI assistant — the user's AI Engineer profile
 * name (e.g. "NetBot") instead of the generic "AI Assistant". Used in tab text,
 * the side panel title, and the various chat surface headers.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { getAiProfile } from '../api/aiEngineerProfile';
import { getCurrentMode } from '../api/client';
import { useUserScopeStore } from '../lib/userScope';

const FALLBACK = 'AI Assistant';

interface AssistantNameState {
  name: string;
  loaded: boolean;
  load: () => Promise<void>;
  /** Update after the profile is edited so every surface reflects it. */
  setName: (name: string | null | undefined) => void;
}

export const useAssistantNameStore = create<AssistantNameState>((set, get) => ({
  name: FALLBACK,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    // Enterprise: the profile is the signed-in user's — wait for one.
    if (getCurrentMode() === 'enterprise' && !useUserScopeStore.getState().scope) return;
    try {
      const profile = await getAiProfile();
      const n = profile?.name?.trim();
      set({ name: n || FALLBACK, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  setName: (name) => set({ name: (name ?? '').trim() || FALLBACK }),
}));

// Enterprise: a different user (or signing out) gets their own name, loaded
// again by the hook below.
useUserScopeStore.subscribe((state, prev) => {
  if (state.scope !== prev.scope) useAssistantNameStore.setState({ name: FALLBACK, loaded: false });
});

/** The AI Engineer profile name (falls back to "AI Assistant"). Auto-loads once per user. */
export function useAssistantName(): string {
  const name = useAssistantNameStore((s) => s.name);
  const loaded = useAssistantNameStore((s) => s.loaded);
  const scope = useUserScopeStore((s) => s.scope);
  useEffect(() => {
    if (!loaded) void useAssistantNameStore.getState().load();
  }, [loaded, scope]);
  return name;
}
