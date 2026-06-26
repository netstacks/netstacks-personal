import { useState, useEffect } from 'react';
import './DiscoveryToast.css';

interface DiscoveryToastProps {
  /** Whether the toast is visible */
  isVisible: boolean;
  /** Device name that just joined */
  deviceName: string;
  /** Group name the device joined */
  groupName: string;
  /** Callback to run discovery on the new device */
  onRunDiscovery: () => void;
  /** Callback to dismiss the toast */
  onDismiss: () => void;
  /** Auto-dismiss timeout in ms (default: 15000) */
  autoHideMs?: number;
}

export default function DiscoveryToast({
  isVisible,
  deviceName,
  groupName,
  onRunDiscovery,
  onDismiss,
  autoHideMs = 15000,
}: DiscoveryToastProps) {
  const [isExiting, setIsExiting] = useState(false);

  // Auto-dismiss after timeout
  useEffect(() => {
    if (!isVisible) return;
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(onDismiss, 300); // Wait for exit animation
    }, autoHideMs);
    return () => clearTimeout(timer);
  }, [isVisible, autoHideMs, onDismiss]);

  // Reset exit state when toast appears
  useEffect(() => {
    if (isVisible) setIsExiting(false);
  }, [isVisible]);

  if (!isVisible) return null;

  return (
    <div className={`discovery-toast ${isExiting ? 'exiting' : ''}`}>
      <div className="discovery-toast-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="20" height="20">
          <circle cx="12" cy="12" r="3" />
          <circle cx="12" cy="12" r="7" opacity="0.5" />
          <circle cx="12" cy="12" r="11" opacity="0.25" />
        </svg>
      </div>
      <div className="discovery-toast-content">
        <div className="discovery-toast-title">New device in topology group</div>
        <div className="discovery-toast-message">
          <strong>{deviceName}</strong> joined <strong>{groupName}</strong>.
          Run discovery to find its neighbors?
        </div>
      </div>
      <div className="discovery-toast-actions">
        <button className="discovery-toast-btn primary" onClick={onRunDiscovery}>
          Discover
        </button>
        <button className="discovery-toast-btn dismiss" onClick={() => {
          setIsExiting(true);
          setTimeout(onDismiss, 300);
        }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
