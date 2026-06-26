import { logger } from '../lib/logger'
/**
 * Session state save/restore utilities.
 *
 * When refresh token expires, we save the app state (tab IDs and titles)
 * before redirecting to login. After re-authentication, we restore this
 * state to give the user a seamless experience.
 *
 * Per CONTEXT.md: Save tab IDs and titles. Skip SSH session state for security.
 * State has a 1-hour TTL - anything older is discarded.
 */

const STORAGE_KEY = 'netstacks_session_state';
const TTL_MS = 60 * 60 * 1000; // 1 hour

export interface SessionState {
  tabs: {
    id: string;
    title: string;
    active: boolean;
  }[];
  timestamp: number;
}

/**
 * Save session state to localStorage.
 * Includes timestamp for TTL checking.
 */
export function saveSessionState(state: Partial<SessionState>): void {
  try {
    const fullState: SessionState = {
      tabs: state.tabs || [],
      timestamp: Date.now(),
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(fullState));
    logger.log('[sessionState] Saved session state:', fullState);
  } catch (error) {
    console.warn('[sessionState] Failed to save session state:', error);
  }
}

/**
 * Restore session state from localStorage.
 * Returns null if state is missing or older than 1 hour.
 * Automatically removes stale state.
 */
export function restoreSessionState(): SessionState | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return null;
    }

    const state: SessionState = JSON.parse(stored);

    // Check TTL
    const age = Date.now() - state.timestamp;
    if (age > TTL_MS) {
      logger.log(`[sessionState] Stored state is stale (age: ${age}ms), discarding`);
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    logger.log('[sessionState] Restored session state:', state);
    return state;
  } catch (error) {
    console.warn('[sessionState] Failed to restore session state:', error);
    // Remove corrupted state
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

/**
 * Clear session state from localStorage.
 * Called after successful restoration to avoid re-restoring stale state.
 */
export function clearSessionState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    logger.log('[sessionState] Cleared session state');
  } catch (error) {
    console.warn('[sessionState] Failed to clear session state:', error);
  }
}
