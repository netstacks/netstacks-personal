import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores/authStore';

// Idle timeout: 30 minutes of inactivity
import { logger } from '../lib/logger'
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// Show warning 2 minutes before timeout
const WARNING_BEFORE_MS = 2 * 60 * 1000;

/**
 * Idle timeout hook with warning dialog.
 *
 * Tracks user activity (mousedown, keydown, scroll, touchstart) and shows
 * a warning 2 minutes before logging out due to inactivity.
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
  const [showWarning, setShowWarning] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  // Timer refs
  const idleTimerRef = useRef<number | null>(null);
  const warningTimerRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);

  // Reset idle timer and hide warning
  const resetTimer = useRef(() => {
    // Clear all existing timers
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
    }
    if (warningTimerRef.current !== null) {
      clearTimeout(warningTimerRef.current);
    }
    if (countdownIntervalRef.current !== null) {
      clearInterval(countdownIntervalRef.current);
    }

    // Hide warning
    setShowWarning(false);
    setSecondsRemaining(0);

    // Only set new timers if authenticated
    if (!isAuthenticated) {
      return;
    }

    // Schedule warning timer (fires 2 minutes before logout)
    warningTimerRef.current = window.setTimeout(() => {
      logger.log('[useIdleTimeout] Showing idle warning');
      setShowWarning(true);
      setSecondsRemaining(Math.floor(WARNING_BEFORE_MS / 1000));

      // Start countdown (1-second interval)
      countdownIntervalRef.current = window.setInterval(() => {
        setSecondsRemaining((prev) => {
          const next = prev - 1;
          if (next <= 0) {
            if (countdownIntervalRef.current !== null) {
              clearInterval(countdownIntervalRef.current);
            }
          }
          return Math.max(0, next);
        });
      }, 1000);
    }, IDLE_TIMEOUT_MS - WARNING_BEFORE_MS);

    // Schedule logout timer (fires after full idle timeout)
    idleTimerRef.current = window.setTimeout(() => {
      logger.log('[useIdleTimeout] Idle timeout reached, logging out');
      setShowWarning(false);
      logout();
    }, IDLE_TIMEOUT_MS);
  });

  // Track user activity events
  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    const activityHandler = () => {
      resetTimer.current();
    };

    // Track these events as genuine user activity
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];

    events.forEach((event) => {
      window.addEventListener(event, activityHandler);
    });

    // Start initial timer
    resetTimer.current();

    // Cleanup
    return () => {
      events.forEach((event) => {
        window.removeEventListener(event, activityHandler);
      });

      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current);
      }
      if (warningTimerRef.current !== null) {
        clearTimeout(warningTimerRef.current);
      }
      if (countdownIntervalRef.current !== null) {
        clearInterval(countdownIntervalRef.current);
      }
    };
  }, [isAuthenticated, logout]);

  return {
    showWarning,
    secondsRemaining,
    resetTimer: resetTimer.current,
  };
}
