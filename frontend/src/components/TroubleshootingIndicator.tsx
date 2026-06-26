/**
 * TroubleshootingIndicator - Status bar indicator for active troubleshooting sessions
 * Shows recording status, duration, entry count, and provides session controls
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { TroubleshootingSession } from '../types/troubleshooting';
import { formatElapsed } from '../lib/formatters';
import './TroubleshootingIndicator.css';

interface TroubleshootingIndicatorProps {
  session: TroubleshootingSession;
  onEndSession: () => void;
  onAttachTopology: () => void;
}

/**
 * Truncate text to a maximum length with ellipsis
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 1) + '\u2026';
}

export default function TroubleshootingIndicator({
  session,
  onEndSession,
  onAttachTopology,
}: TroubleshootingIndicatorProps) {
  const [duration, setDuration] = useState(() => formatElapsed(session.startTime));
  const [showPopover, setShowPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLButtonElement>(null);

  // Update duration every second
  useEffect(() => {
    const interval = setInterval(() => {
      setDuration(formatElapsed(session.startTime));
    }, 1000);

    return () => clearInterval(interval);
  }, [session.startTime]);

  // Close popover when clicking outside
  useEffect(() => {
    if (!showPopover) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        indicatorRef.current &&
        !indicatorRef.current.contains(e.target as Node)
      ) {
        setShowPopover(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPopover]);

  // Handle Escape key to close popover
  useEffect(() => {
    if (!showPopover) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowPopover(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showPopover]);

  const handleTogglePopover = useCallback(() => {
    setShowPopover(prev => !prev);
  }, []);

  const handleEndSession = useCallback(() => {
    setShowPopover(false);
    onEndSession();
  }, [onEndSession]);

  const handleAttachTopology = useCallback(() => {
    setShowPopover(false);
    onAttachTopology();
  }, [onAttachTopology]);

  const entryCount = session.entries.length;
  const commandCount = session.entries.filter(e => e.type === 'command').length;
  const aiCount = session.entries.filter(e => e.type === 'ai-chat').length;

  return (
    <div className="troubleshooting-indicator-container">
      <button
        ref={indicatorRef}
        className="troubleshooting-indicator"
        onClick={handleTogglePopover}
        title="Troubleshooting session in progress - Click for options"
      >
        <span className="troubleshooting-indicator-dot" />
        <span className="troubleshooting-indicator-name">
          {truncate(session.name, 20)}
        </span>
        <span className="troubleshooting-indicator-duration">{duration}</span>
        <span className="troubleshooting-indicator-count" title={`${entryCount} entries recorded`}>
          {entryCount}
        </span>
      </button>

      {showPopover && (
        <div ref={popoverRef} className="troubleshooting-indicator-popover">
          <div className="troubleshooting-popover-header">
            <span className="troubleshooting-popover-dot" />
            <span className="troubleshooting-popover-title">Recording Session</span>
          </div>

          <div className="troubleshooting-popover-info">
            <div className="troubleshooting-popover-name">{session.name}</div>
            <div className="troubleshooting-popover-stats">
              <div className="troubleshooting-popover-stat">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span>{duration}</span>
              </div>
              <div className="troubleshooting-popover-stat">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                <span>{commandCount} commands</span>
              </div>
              {aiCount > 0 && (
                <div className="troubleshooting-popover-stat">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                    <path d="M12 2a10 10 0 0110 10c0 5.52-4.48 10-10 10S2 17.52 2 12 6.48 2 12 2z" />
                    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                    <circle cx="9" cy="10" r="1" fill="currentColor" />
                    <circle cx="15" cy="10" r="1" fill="currentColor" />
                  </svg>
                  <span>{aiCount} AI messages</span>
                </div>
              )}
              <div className="troubleshooting-popover-stat">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="3" y1="9" x2="21" y2="9" />
                  <line x1="9" y1="21" x2="9" y2="9" />
                </svg>
                <span>{session.terminalIds.length} terminals</span>
              </div>
            </div>
          </div>

          <div className="troubleshooting-popover-actions">
            {!session.topologyId && (
              <button
                className="troubleshooting-popover-btn secondary"
                onClick={handleAttachTopology}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <circle cx="12" cy="5" r="3" />
                  <circle cx="5" cy="19" r="3" />
                  <circle cx="19" cy="19" r="3" />
                  <line x1="12" y1="8" x2="5" y2="16" />
                  <line x1="12" y1="8" x2="19" y2="16" />
                </svg>
                Attach Topology
              </button>
            )}
            {session.topologyId && (
              <div className="troubleshooting-popover-attached">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Topology attached
              </div>
            )}
            <button
              className="troubleshooting-popover-btn primary"
              onClick={handleEndSession}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              </svg>
              End &amp; Generate Report
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
