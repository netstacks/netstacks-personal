/**
 * LinkDetailCard - Draggable detail card showing full link/connection info
 *
 * Displays comprehensive interface data from both connected devices in a
 * side-by-side comparison layout. Supports dragging by header.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Connection, Device } from '../types/topology';
import type { LinkEnrichment, InterfaceEnrichment } from '../types/enrichment';
import { formatBytes, getStatusColor } from '../lib/enrichmentHelpers';
import './LinkDetailCard.css';

interface LinkDetailCardProps {
  /** The connection to display details for */
  connection: Connection;
  /** Source device of the connection */
  sourceDevice: Device;
  /** Target device of the connection */
  targetDevice: Device;
  /** Link enrichment data (interface details from both ends) */
  linkEnrichment?: LinkEnrichment;
  /** Initial screen position for card placement */
  initialPosition: { x: number; y: number };
  /** Close handler */
  onClose: () => void;
  /** Open in new tab handler (optional) */
  onOpenInTab?: () => void;
  /** Save to docs handler (optional) */
  onSaveToDocs?: () => void;
}

/**
 * Render a single interface section with all its details
 */
function InterfaceSection({
  title,
  deviceName,
  intf,
}: {
  title: string;
  deviceName: string;
  intf: InterfaceEnrichment;
}) {
  const hasErrors = (intf.rxErrors && intf.rxErrors > 0) || (intf.txErrors && intf.txErrors > 0);

  return (
    <div className="link-detail-interface">
      <div className="link-detail-interface-header">
        <span className="link-detail-interface-title">{title}</span>
        <span className="link-detail-interface-device">{deviceName}</span>
      </div>

      <div className="link-detail-interface-content">
        {/* Interface name */}
        <div className="link-detail-row">
          <span className="link-detail-label">Interface</span>
          <span className="link-detail-value link-detail-mono">{intf.name}</span>
        </div>

        {/* Description */}
        {intf.description && (
          <div className="link-detail-row">
            <span className="link-detail-label">Description</span>
            <span className="link-detail-value">{intf.description}</span>
          </div>
        )}

        {/* Status with colored badge */}
        <div className="link-detail-row">
          <span className="link-detail-label">Status</span>
          <span
            className="link-detail-status-badge"
            style={{ backgroundColor: getStatusColor(intf.status) }}
          >
            {intf.status}
          </span>
        </div>

        {/* Speed and Duplex */}
        {(intf.speed || intf.duplex) && (
          <div className="link-detail-row">
            <span className="link-detail-label">Speed/Duplex</span>
            <span className="link-detail-value">
              {intf.speed || '-'} / {intf.duplex || '-'}
            </span>
          </div>
        )}

        {/* MTU */}
        {intf.mtu && (
          <div className="link-detail-row">
            <span className="link-detail-label">MTU</span>
            <span className="link-detail-value">{intf.mtu}</span>
          </div>
        )}

        {/* Traffic stats */}
        {(intf.rxBytes !== undefined || intf.txBytes !== undefined) && (
          <div className="link-detail-row">
            <span className="link-detail-label">Traffic</span>
            <span className="link-detail-value">
              RX {formatBytes(intf.rxBytes || 0)} / TX {formatBytes(intf.txBytes || 0)}
            </span>
          </div>
        )}

        {/* Error counts */}
        {(intf.rxErrors !== undefined || intf.txErrors !== undefined) && (
          <div className="link-detail-row">
            <span className="link-detail-label">Errors</span>
            <span className={`link-detail-value ${hasErrors ? 'link-detail-error' : ''}`}>
              RX {intf.rxErrors || 0} / TX {intf.txErrors || 0}
            </span>
          </div>
        )}

        {/* MAC Address */}
        {intf.macAddress && (
          <div className="link-detail-row">
            <span className="link-detail-label">MAC</span>
            <span className="link-detail-value link-detail-mono">{intf.macAddress}</span>
          </div>
        )}

        {/* IP Address */}
        {intf.ipAddress && (
          <div className="link-detail-row">
            <span className="link-detail-label">IP</span>
            <span className="link-detail-value link-detail-mono">{intf.ipAddress}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LinkDetailCard({
  connection: _connection,
  sourceDevice,
  targetDevice,
  linkEnrichment,
  initialPosition,
  onClose,
  onOpenInTab,
  onSaveToDocs,
}: LinkDetailCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 });

  // Calculate initial position (keep card in viewport)
  useEffect(() => {
    const cardWidth = 520;
    const cardHeight = 450;
    const adjustedX = Math.min(
      Math.max(20, initialPosition.x - cardWidth / 2),
      window.innerWidth - cardWidth - 20
    );
    const adjustedY = Math.min(
      Math.max(20, initialPosition.y - 20),
      window.innerHeight - cardHeight - 20
    );
    setPosition({ x: adjustedX, y: adjustedY });
  }, [initialPosition]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Handle drag start
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only drag from header
    if (!(e.target as HTMLElement).closest('.link-detail-header')) {
      return;
    }
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: position.x,
      posY: position.y,
    };
  }, [position]);

  // Handle drag move
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;
      setPosition({
        x: Math.max(0, Math.min(window.innerWidth - 100, dragStartRef.current.posX + deltaX)),
        y: Math.max(0, Math.min(window.innerHeight - 50, dragStartRef.current.posY + deltaY)),
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  return (
    <div
      ref={cardRef}
      className={`link-detail-card ${isDragging ? 'dragging' : ''}`}
      style={{ left: position.x, top: position.y }}
      onMouseDown={handleMouseDown}
    >
      {/* Header - draggable area */}
      <div className="link-detail-header">
        <div className="link-detail-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="link-detail-icon">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <span>{sourceDevice.name}</span>
          <span className="link-detail-title-arrow">&#8596;</span>
          <span>{targetDevice.name}</span>
        </div>
        <button className="link-detail-close" onClick={onClose} title="Close (Esc)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="link-detail-content">
        {linkEnrichment ? (
          <div className="link-detail-interfaces">
            <InterfaceSection
              title="Source"
              deviceName={sourceDevice.name}
              intf={linkEnrichment.sourceInterface}
            />
            <div className="link-detail-divider" />
            <InterfaceSection
              title="Destination"
              deviceName={targetDevice.name}
              intf={linkEnrichment.destInterface}
            />
          </div>
        ) : (
          <div className="link-detail-no-data">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
            <p>No interface data available.</p>
            <p className="link-detail-no-data-hint">
              Run Discover to collect interface information from connected devices.
            </p>
          </div>
        )}
      </div>

      {/* Footer with action buttons */}
      <div className="link-detail-footer">
        {onOpenInTab && (
          <button className="link-detail-action" onClick={onOpenInTab}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            Open in Tab
          </button>
        )}
        {onSaveToDocs && (
          <button className="link-detail-action" onClick={onSaveToDocs}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            Save to Docs
          </button>
        )}
      </div>
    </div>
  );
}
