// ConnectionDetailsOverlay - Floating overlay showing connection/link details on click
// Part of the immersive topology interaction system

import { useEffect } from 'react';
import type { Connection } from '../types/topology';
import './ConnectionDetailsOverlay.css';

interface ConnectionDetailsOverlayProps {
  /** Connection to display details for */
  connection: Connection | null;
  /** Source device name */
  sourceDeviceName?: string;
  /** Target device name */
  targetDeviceName?: string;
  /** Screen position to anchor the overlay */
  position: { x: number; y: number } | null;
  /** Close handler */
  onClose: () => void;
}

export default function ConnectionDetailsOverlay({
  connection,
  sourceDeviceName,
  targetDeviceName,
  position,
  onClose,
}: ConnectionDetailsOverlayProps) {
  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (connection && position) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [connection, position, onClose]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.connection-details-overlay')) {
        onClose();
      }
    };

    if (connection && position) {
      // Delay to prevent immediate close
      setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside);
      }, 0);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [connection, position, onClose]);

  if (!connection || !position) return null;

  // Adjust position to keep overlay in viewport
  const overlayWidth = 320;
  const overlayHeight = 300;
  const adjustedX = Math.min(position.x + 10, window.innerWidth - overlayWidth - 20);
  const adjustedY = Math.min(position.y - 20, window.innerHeight - overlayHeight - 20);

  const srcName = sourceDeviceName || connection.sourceDeviceId;
  const tgtName = targetDeviceName || connection.targetDeviceId;

  return (
    <div
      className="connection-details-overlay"
      style={{
        left: Math.max(20, adjustedX),
        top: Math.max(20, adjustedY),
      }}
    >
      {/* Header */}
      <div className="connection-details-header">
        <div className="connection-details-link-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </div>
        <div className="connection-details-title">
          <h3>{srcName} ↔ {tgtName}</h3>
          <span className="connection-details-label">{connection.label || 'Link'}</span>
        </div>
        {/* Audit P1-7/P1-8: Status dot, Protocol Sessions, and NetBox
            cable/circuit refs were all dead UI — Connection.status is
            hardcoded 'active' in the transform and protocols/cableId/
            circuitId are never populated. Removed until a backend
            pipeline exists; reintroduce alongside the data source. */}
        <button className="connection-details-close" onClick={onClose} title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Interface Info */}
      <div className="connection-details-interfaces">
        <div className="connection-details-interface">
          <span className="connection-details-interface-device">{srcName}</span>
          <span className="connection-details-interface-name">
            {connection.sourceInterface || 'N/A'}
          </span>
        </div>
        <div className="connection-details-arrow">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </div>
        <div className="connection-details-interface">
          <span className="connection-details-interface-device">{tgtName}</span>
          <span className="connection-details-interface-name">
            {connection.targetInterface || 'N/A'}
          </span>
        </div>
      </div>

      {/* Statistics Placeholder */}
      <div className="connection-details-stats">
        <div className="connection-details-section-title">Traffic Statistics</div>
        <div className="connection-details-placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M18 20V10M12 20V4M6 20v-6" />
          </svg>
          <span>Statistics will be available when connected to monitoring</span>
        </div>
      </div>
    </div>
  );
}
