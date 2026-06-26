// SessionQuickLook - Floating overlay for quick session preview on device double-click
// Part of the immersive topology interaction system

import { useEffect, useRef, useCallback } from 'react';
import type { Device } from '../types/topology';
import './SessionQuickLook.css';

interface SessionQuickLookProps {
  /** Device to show session preview for */
  device: Device | null;
  /** Screen position to anchor the overlay */
  position: { x: number; y: number } | null;
  /** Close handler */
  onClose: () => void;
  /** Handler to open session in terminal area */
  onOpenInTerminal: (device: Device) => void;
  /** Handler to focus AI chat with context */
  onOpenAIChat?: (device: Device) => void;
}

/** Icons */
const Icons = {
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  terminal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  expand: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  ),
  ai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  ),
};

export default function SessionQuickLook({
  device,
  position,
  onClose,
  onOpenInTerminal,
  onOpenAIChat,
}: SessionQuickLookProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (device) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [device, onClose]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    if (device) {
      // Delay to avoid closing from the double-click event
      const timer = setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside);
      }, 100);
      return () => {
        clearTimeout(timer);
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [device, onClose]);

  // Handle open in terminal
  const handleOpenInTerminal = useCallback(() => {
    if (device) {
      onOpenInTerminal(device);
      onClose();
    }
  }, [device, onOpenInTerminal, onClose]);

  // Handle open AI chat
  const handleOpenAIChat = useCallback(() => {
    if (device && onOpenAIChat) {
      onOpenAIChat(device);
      onClose();
    }
  }, [device, onOpenAIChat, onClose]);

  // Don't render if no device or position
  if (!device || !position) return null;

  // Calculate overlay position - try to keep on screen
  const overlayWidth = 420;
  const overlayHeight = 340;
  const padding = 20;

  let left = position.x - overlayWidth / 2;
  let top = position.y + 20;

  // Adjust to keep on screen
  if (left < padding) left = padding;
  if (left + overlayWidth > window.innerWidth - padding) {
    left = window.innerWidth - overlayWidth - padding;
  }
  if (top + overlayHeight > window.innerHeight - padding) {
    top = position.y - overlayHeight - 20;
  }

  return (
    <div
      ref={overlayRef}
      className="session-quicklook"
      style={{ left, top }}
    >
      {/* Header */}
      <div className="session-quicklook-header">
        <div className="session-quicklook-header-left">
          <span className="session-quicklook-icon">{Icons.terminal}</span>
          <div className="session-quicklook-title-group">
            <span className="session-quicklook-title">{device.name}</span>
            {device.primaryIp && (
              <span className="session-quicklook-ip">{device.primaryIp}</span>
            )}
          </div>
        </div>
        <button
          className="session-quicklook-close"
          onClick={onClose}
          title="Close (Escape)"
        >
          {Icons.close}
        </button>
      </div>

      {/* Terminal Preview Area */}
      <div className="session-quicklook-preview">
        {/* Simulated terminal output - would be real terminal in full implementation */}
        <div className="session-quicklook-terminal">
          <div className="session-quicklook-terminal-line prompt">
            <span className="user">admin@{device.name}</span>
            <span className="separator">:</span>
            <span className="path">~</span>
            <span className="prompt-char">$</span>
          </div>
          <div className="session-quicklook-terminal-line output">
            Last login: {new Date().toLocaleString()} from {device.primaryIp || 'console'}
          </div>
          <div className="session-quicklook-terminal-line prompt">
            <span className="user">admin@{device.name}</span>
            <span className="separator">:</span>
            <span className="path">~</span>
            <span className="prompt-char">$</span>
            <span className="cursor">_</span>
          </div>
        </div>
        <div className="session-quicklook-preview-hint">
          Double-click opened session preview
        </div>
      </div>

      {/* Quick Info */}
      <div className="session-quicklook-info">
        <div className="session-quicklook-info-item">
          <span className="label">Type</span>
          <span className="value">{device.type}</span>
        </div>
        {device.platform && (
          <div className="session-quicklook-info-item">
            <span className="label">Platform</span>
            <span className="value">{device.platform}</span>
          </div>
        )}
        {device.role && (
          <div className="session-quicklook-info-item">
            <span className="label">Role</span>
            <span className="value">{device.role}</span>
          </div>
        )}
        <div className="session-quicklook-info-item">
          <span className="label">Status</span>
          <span className={`value status-${device.status}`}>{device.status}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="session-quicklook-actions">
        <button
          className="session-quicklook-action primary"
          onClick={handleOpenInTerminal}
        >
          {Icons.expand}
          <span>Open in Terminal Area</span>
        </button>
        {onOpenAIChat && (
          <button
            className="session-quicklook-action"
            onClick={handleOpenAIChat}
          >
            {Icons.ai}
            <span>Ask AI</span>
          </button>
        )}
      </div>

      {/* Footer hint */}
      <div className="session-quicklook-footer">
        <kbd>Esc</kbd> to close &bull; <kbd>Enter</kbd> to open in terminal
      </div>
    </div>
  );
}
