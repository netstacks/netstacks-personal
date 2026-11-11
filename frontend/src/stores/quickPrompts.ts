/**
 * Shared, reactive Quick Prompts list — the single source of truth for the chat
 * quick actions and (optionally) the status-bar Prompts menu. The editor calls
 * `refresh()` after any change so every surface updates immediately, instead of
 * each consumer loading its own stale copy.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { listQuickPrompts, type QuickPrompt } from '../api/quickPrompts';
import { useUserScopeStore } from '../lib/userScope';

interface QuickPromptsState {
  prompts: QuickPrompt[];
  loaded: boolean;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const useQuickPromptsStore = create<QuickPromptsState>((set, get) => ({
  prompts: [],
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    await get().refresh();
  },
  refresh: async () => {
    try {
      const ps = await listQuickPrompts();
      // Favorites first (stable for the rest).
      set({
        prompts: [...ps].sort((a, b) => Number(b.is_favorite) - Number(a.is_favorite)),
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },
}));

// Enterprise: the prompts are the signed-in user's; a different user (or
// signing out) loads again through the hook below.
useUserScopeStore.subscribe((state, prev) => {
  if (state.scope !== prev.scope) useQuickPromptsStore.setState({ prompts: [], loaded: false });
});

/** The Quick Prompts (favorites first). Auto-loads once per user. */
export function useQuickPrompts(): QuickPrompt[] {
  const prompts = useQuickPromptsStore((s) => s.prompts);
  const loaded = useQuickPromptsStore((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void useQuickPromptsStore.getState().load();
  }, [loaded]);
  return prompts;
}
