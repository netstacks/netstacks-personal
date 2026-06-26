// DeviceDetailsOverlay - Floating overlay showing device details on single-click
// Part of the immersive topology interaction system

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import type { Device, DeviceType, DeviceStatus } from '../types/topology';
import './DeviceDetailsOverlay.css';

interface DeviceDetailsOverlayProps {
  /** Device to display details for */
  device: Device | null;
  /** Screen position to anchor the overlay */
  position: { x: number; y: number } | null;
  /** Close handler */
  onClose: () => void;
  /** Focus the terminal for this device */
  onFocusTerminal?: (device: Device) => void;
  /** Open AI chat with device context */
  onOpenAIChat?: (device: Device) => void;
  /** Trigger AI neighbor discovery */
  onDiscoverNeighbors?: (device: Device) => void;
  /** Open session for this device */
  onOpenSession?: (device: Device) => void;
  /** Open device in a dedicated tab (for saving to docs) */
  onOpenInTab?: (device: Device) => void;
}

/** Device type to icon mapping */
const DEVICE_ICONS: Record<DeviceType, ReactNode> = {
  router: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="6" cy="12" r="1.5" fill="currentColor" />
      <circle cx="10" cy="12" r="1.5" fill="currentColor" />
      <path d="M15 9v6M18 9v6" />
    </svg>
  ),
  switch: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="8" width="20" height="8" rx="1" />
      <circle cx="6" cy="12" r="1" fill="currentColor" />
      <circle cx="9" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="15" cy="12" r="1" fill="currentColor" />
      <circle cx="18" cy="12" r="1" fill="currentColor" />
    </svg>
  ),
  firewall: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </svg>
  ),
  server: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="2" width="16" height="6" rx="1" />
      <rect x="4" y="9" width="16" height="6" rx="1" />
      <rect x="4" y="16" width="16" height="6" rx="1" />
      <circle cx="7" cy="5" r="1" fill="currentColor" />
      <circle cx="7" cy="12" r="1" fill="currentColor" />
      <circle cx="7" cy="19" r="1" fill="currentColor" />
    </svg>
  ),
  cloud: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  ),
  'access-point': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" />
    </svg>
  ),
  'load-balancer': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <path d="M7 6v4M12 6v4M17 6v4M7 14v4M12 14v4M17 14v4" />
    </svg>
  ),
  'wan-optimizer': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
      <path d="M17 12h3M4 12h3" />
    </svg>
  ),
  'voice-gateway': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  ),
  'wireless-controller': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="14" width="16" height="6" rx="1" />
      <circle cx="8" cy="17" r="1" fill="currentColor" />
      <path d="M12 2v6M8 5l4 3 4-3M6 8l6 4 6-4" />
    </svg>
  ),
  storage: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  virtual: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="6" y="6" width="12" height="12" rx="1" />
      <rect x="3" y="3" width="12" height="12" rx="1" />
      <rect x="9" y="9" width="12" height="12" rx="1" />
    </svg>
  ),
  'sd-wan': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
      <path d="M8 16h8M10 13h4" />
    </svg>
  ),
  iot: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <circle cx="9" cy="9" r="1" fill="currentColor" />
      <circle cx="15" cy="9" r="1" fill="currentColor" />
      <circle cx="9" cy="15" r="1" fill="currentColor" />
      <circle cx="15" cy="15" r="1" fill="currentColor" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </svg>
  ),
  unknown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
    </svg>
  ),
};

/** Status to color mapping */
const STATUS_COLORS: Record<DeviceStatus, string> = {
  online: '#4caf50',
  offline: '#f44336',
  warning: '#ff9800',
  unknown: '#9e9e9e',
};

export default function DeviceDetailsOverlay({
  device,
  position,
  onClose,
  onFocusTerminal,
  onOpenAIChat,
  onDiscoverNeighbors,
  onOpenSession,
  onOpenInTab,
}: DeviceDetailsOverlayProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (device && position) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [device, position, onClose]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.device-details-overlay')) {
        onClose();
      }
    };

    if (device && position) {
      // Delay to prevent immediate close
      setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside);
      }, 0);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [device, position, onClose]);

  const toggleSection = useCallback((section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  if (!device || !position) return null;

  // Adjust position to keep overlay in viewport
  const overlayWidth = 320;
  const overlayHeight = 400;
  const adjustedX = Math.min(position.x + 10, window.innerWidth - overlayWidth - 20);
  const adjustedY = Math.min(position.y - 20, window.innerHeight - overlayHeight - 20);

  return (
    <div
      className="device-details-overlay"
      style={{
        left: Math.max(20, adjustedX),
        top: Math.max(20, adjustedY),
      }}
    >
      {/* Header */}
      <div className="device-details-header">
        <div className="device-details-icon" data-type={device.type}>
          {DEVICE_ICONS[device.type] || DEVICE_ICONS.unknown}
        </div>
        <div className="device-details-title">
          <h3>{device.name}</h3>
          <span className="device-details-type">{device.type}</span>
        </div>
        <div
          className="device-details-status"
          style={{ backgroundColor: STATUS_COLORS[device.status] }}
          title={device.status}
        />
        <button className="device-details-close" onClick={onClose} title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Quick Info */}
      <div className="device-details-info">
        {device.primaryIp && (
          <div className="device-details-info-row">
            <span className="device-details-info-label">IP Address</span>
            <span className="device-details-info-value">{device.primaryIp}</span>
          </div>
        )}
        {device.vendor && (
          <div className="device-details-info-row">
            <span className="device-details-info-label">Vendor</span>
            <span className="device-details-info-value">{device.vendor}</span>
          </div>
        )}
        {device.platform && (
          <div className="device-details-info-row">
            <span className="device-details-info-label">Platform</span>
            <span className="device-details-info-value">{device.platform}</span>
          </div>
        )}
        {device.model && (
          <div className="device-details-info-row">
            <span className="device-details-info-label">Model</span>
            <span className="device-details-info-value">{device.model}</span>
          </div>
        )}
        {device.version && (
          <div className="device-details-info-row">
            <span className="device-details-info-label">Version</span>
            <span className="device-details-info-value">{device.version}</span>
          </div>
        )}
        {device.serial && (
          <div className="device-details-info-row">
            <span className="device-details-info-label">Serial</span>
            <span className="device-details-info-value">{device.serial}</span>
          </div>
        )}
        {device.uptime && (
          <div className="device-details-info-row">
            <span className="device-details-info-label">Uptime</span>
            <span className="device-details-info-value">{device.uptime}</span>
          </div>
        )}
        {device.site && (
          <div className="device-details-info-row">
            <span className="device-details-info-label">Site</span>
            <span className="device-details-info-value">{device.site}</span>
          </div>
        )}
        {device.role && (
          <div className="device-details-info-row">
            <span className="device-details-info-label">Role</span>
            <span className="device-details-info-value">{device.role}</span>
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="device-details-actions">
        {device.sessionId && onFocusTerminal && (
          <button
            className="device-details-action"
            onClick={() => onFocusTerminal(device)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            Focus Terminal
          </button>
        )}
        {!device.sessionId && device.primaryIp && onOpenSession && (
          <button
            className="device-details-action device-details-action-primary"
            onClick={() => onOpenSession(device)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M13.8 12H3" />
            </svg>
            Connect
          </button>
        )}
        {onOpenAIChat && (
          <button
            className="device-details-action"
            onClick={() => onOpenAIChat(device)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
            AI Assistant
          </button>
        )}
        {onDiscoverNeighbors && (
          <button
            className="device-details-action"
            onClick={() => onDiscoverNeighbors(device)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="3" />
              <circle cx="19" cy="12" r="2" />
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="19" r="2" />
              <path d="M12 9v-2M12 17v2M15 12h2M7 12h2" />
            </svg>
            Discover Neighbors
          </button>
        )}
        {onOpenInTab && (
          <button
            className="device-details-action"
            onClick={() => onOpenInTab(device)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" />
            </svg>
            Open in Tab
          </button>
        )}
      </div>

      {/* Expandable Sections */}
      <div className="device-details-sections">
        {/* Interfaces Section - Placeholder */}
        <div className="device-details-section">
          <button
            className={`device-details-section-header ${expandedSections.has('interfaces') ? 'expanded' : ''}`}
            onClick={() => toggleSection('interfaces')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="chevron">
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span>Interfaces</span>
            <span className="device-details-section-badge">--</span>
          </button>
          {expandedSections.has('interfaces') && (
            <div className="device-details-section-content">
              <div className="device-details-placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
                </svg>
                <span>Interface data will be discovered via AI commands</span>
              </div>
            </div>
          )}
        </div>

        {/* Neighbors Section - Placeholder */}
        <div className="device-details-section">
          <button
            className={`device-details-section-header ${expandedSections.has('neighbors') ? 'expanded' : ''}`}
            onClick={() => toggleSection('neighbors')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="chevron">
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span>Neighbors</span>
            <span className="device-details-section-badge">--</span>
          </button>
          {expandedSections.has('neighbors') && (
            <div className="device-details-section-content">
              <div className="device-details-placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="3" />
                  <circle cx="19" cy="12" r="2" />
                  <circle cx="5" cy="12" r="2" />
                </svg>
                <span>Click "Discover Neighbors" to find connected devices</span>
              </div>
            </div>
          )}
        </div>

        {/* Statistics Section - Placeholder */}
        <div className="device-details-section">
          <button
            className={`device-details-section-header ${expandedSections.has('stats') ? 'expanded' : ''}`}
            onClick={() => toggleSection('stats')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="chevron">
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span>Statistics</span>
            <span className="device-details-section-badge">--</span>
          </button>
          {expandedSections.has('stats') && (
            <div className="device-details-section-content">
              <div className="device-details-placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M18 20V10M12 20V4M6 20v-6" />
                </svg>
                <span>Statistics will be available when connected to monitoring</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
