import { useEffect, useState } from 'react';
import './NetworkStatusBanner.css';

import { logger } from '../lib/logger'
/**
 * Network status banner component.
 *
 * Shows a persistent banner when connection to Controller is lost,
 * and briefly shows a success message when reconnected.
 *
 * Banner auto-dismisses 3 seconds after connection restores.
 */
export function NetworkStatusBanner() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    const handleOnline = () => {
      logger.log('[NetworkStatusBanner] Connection restored');
      setIsOnline(true);
      setWasOffline(true);

      // Auto-dismiss after 3 seconds
      setTimeout(() => {
        setWasOffline(false);
      }, 3000);
    };

    const handleOffline = () => {
      logger.log('[NetworkStatusBanner] Connection lost');
      setIsOnline(false);
      setWasOffline(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Hide banner if online and not in reconnected state
  if (isOnline && !wasOffline) {
    return null;
  }

  return (
    <div className={`network-banner ${isOnline ? 'reconnected' : 'disconnected'}`}>
      {isOnline ? (
        <>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M13.5 4.5L6 12L2.5 8.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Connection restored</span>
        </>
      ) : (
        <>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle
              cx="8"
              cy="8"
              r="7"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
            />
            <path
              d="M8 4V8M8 11V11.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <span>Connection to Controller lost — retrying...</span>
        </>
      )}
    </div>
  );
}
