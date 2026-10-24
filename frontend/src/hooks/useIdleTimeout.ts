import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { logger } from '../lib/logger';

// Idle timeout: 30 minutes of inactivity
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// Show warning 2 minutes before timeout
export const WARNING_BEFORE_MS = 2 * 60 * 1000;

/**
 * Idle timeout hook with warning dialog.
 *
 * Tracks user activity (mousedown, keydown, scroll, touchstart) and shows
 * a warning 2 minutes before logging out due to inactivity.
 *
 * Timers start on the logged-out -> logged-in transition, are reset by
 * activity, and are cleared on logout and unmount. The reset callback is
 * rebuilt whenever auth state or `logout` changes, so it never acts on a
 * stale closure (audit 1.2: the previous useRef initializer captured the
 * first render's `isAuthenticated=false`, so timers never started).
 *
 * IMPORTANT: Token refresh does NOT reset the idle timer. Only genuine
 * user interaction resets it (per RESEARCH.md Pitfall 4).
 *
 * Returns:
 * - showWarning: Whether to show the idle warning dialog
 * - secondsRemaining: Countdown seconds until logout
 * - resetTimer: Function to reset the idle timer (called by "Stay Signed In" button)
 */
export function useIdleTimeout(): {
  showWarning: boolean;
  secondsRemaining: number;
  resetTimer: () => void;
} {
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const logout = useAuthStore(state => state.logout);
  const [warningVisible, setWarningVisible] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  // Timer refs
  const idleTimerRef = useRef<number | null>(null);
  const warningTimerRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (warningTimerRef.current !== null) {
      clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
    if (countdownIntervalRef.current !== null) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);

  // (Re)schedule the warning + logout timers. Does not touch React state
  // synchronously, so it is safe to call from an effect body.
  const scheduleTimers = useCallback(() => {
    clearTimers();

    // Only set new timers if authenticated
    if (!isAuthenticated) {
      return;
    }

    // Schedule warning timer (fires 2 minutes before logout)
    warningTimerRef.current = window.setTimeout(() => {
      logger.log('[useIdleTimeout] Showing idle warning');
      setWarningVisible(true);
      setSecondsRemaining(Math.floor(WARNING_BEFORE_MS / 1000));

      // Start countdown (1-second interval)
      countdownIntervalRef.current = window.setInterval(() => {
        setSecondsRemaining((prev) => {
          const next = prev - 1;
          if (next <= 0 && countdownIntervalRef.current !== null) {
            clearInterval(countdownIntervalRef.current);
            countdownIntervalRef.current = null;
          }
          return Math.max(0, next);
        });
      }, 1000);
    }, IDLE_TIMEOUT_MS - WARNING_BEFORE_MS);

    // Schedule logout timer (fires after full idle timeout)
    idleTimerRef.current = window.setTimeout(() => {
      logger.log('[useIdleTimeout] Idle timeout reached, logging out');
      clearTimers();
      setWarningVisible(false);
      logout();
    }, IDLE_TIMEOUT_MS);
  }, [isAuthenticated, logout, clearTimers]);

  // Reset idle timer and hide warning (activity / "Stay Signed In").
  const resetTimer = useCallback(() => {
    setWarningVisible(false);
    setSecondsRemaining(0);
    scheduleTimers();
  }, [scheduleTimers]);

  // Start timers on login and track user activity; clear on logout/unmount.
  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    // Track these events as genuine user activity
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach((event) => {
      window.addEventListener(event, resetTimer);
    });

    // Start initial timers on the logged-out -> logged-in transition.
    scheduleTimers();

    return () => {
      events.forEach((event) => {
        window.removeEventListener(event, resetTimer);
      });
      clearTimers();
      // Drop any countdown left over from an external logout so the next
      // login starts clean instead of re-showing a stale warning.
      setWarningVisible(false);
      setSecondsRemaining(0);
    };
  }, [isAuthenticated, resetTimer, scheduleTimers, clearTimers]);

  return {
    // A warning can never be visible while logged out, even if the logout
    // came from elsewhere (manual sign-out, token failure) mid-countdown.
    showWarning: isAuthenticated && warningVisible,
    secondsRemaining: isAuthenticated ? secondsRemaining : 0,
    resetTimer,
  };
}
