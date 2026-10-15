import { useEffect, useRef, useState } from 'react';
import './EnterpriseDevicePanel.css';
import { getEnterpriseDevice, type DeviceSummary } from '../api/enterpriseDevices';
import { getErrorMessage } from '../api/errors';
import { useAuthStore } from '../stores/authStore';
import type { SessionContext } from '../types/sessionContext';
import EnterpriseDeviceEditDialog from './EnterpriseDeviceEditDialog';
import SessionContextEditor from './SessionContextEditor';
import ModalFrame from './ModalFrame';

/** The device a Controller context key (`device-<uuid>`) names, or null for a session-definition UUID. */
function keyDeviceId(key: string): string | null {
  return key.startsWith('device-') ? key.slice('device-'.length) : null;
}

interface EnterpriseContextDialogProps {
  /** The Team Knowledge entry to open. */
  context: SessionContext;
  /** The key the entry was listed under (api/sessionContext sessionContextKey). */
  sessionKey: string;
  /** Name of the terminal the entry was opened from (title for unlinked sessions). */
  sessionName: string;
  onClose: () => void;
  onError: (message: string) => void;
}

/**
 * Enterprise counterpart of Edit Session → Context. The Controller keys Team
 * Knowledge on the device a session definition targets, so a device's entries
 * open its Edit Device dialog on the Context tab. A session definition with
 * no device keeps its own entries; it gets the Context editor on its own.
 *
 * A device's list can hold entries whose session_id is a linked definition's
 * UUID as well as `device-<uuid>` ones, so the device comes from the list's
 * key or any device-keyed entry, and the plain editor lists by the key.
 */
export default function EnterpriseContextDialog({ context, sessionKey, sessionName, onClose, onError }: EnterpriseContextDialogProps) {
  const deviceId = keyDeviceId(sessionKey) ?? keyDeviceId(context.session_id);
  const [device, setDevice] = useState<DeviceSummary | null>(null);
  const currentUser = useAuthStore((s) => s.user)?.username ?? 'Unknown';
  // The load runs once per device; the callbacks may change identity every render.
  const callbacksRef = useRef({ onClose, onError });
  useEffect(() => {
    callbacksRef.current = { onClose, onError };
  });

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    getEnterpriseDevice(deviceId).then(
      (loaded) => { if (!cancelled) setDevice(loaded); },
      (err) => {
        if (cancelled) return;
        callbacksRef.current.onError(getErrorMessage(err, 'Failed to load device'));
        callbacksRef.current.onClose();
      },
    );
    return () => { cancelled = true; };
  }, [deviceId]);

  if (deviceId) {
    return device
      ? <EnterpriseDeviceEditDialog device={device} initialTab="context" initialContextId={context.id} onClose={onClose} />
      : null;
  }

  return (
    <ModalFrame id="enterprise-session-context" className="device-edit-dialog" label="Session Context" onDismiss={onClose}>
      <div className="device-edit-header">
        <h3>Context — {sessionName}</h3>
        <button className="ns-btn ns-btn--ghost ns-icon-btn" aria-label="Close" onClick={onClose}>&times;</button>
      </div>
      <div className="device-edit-memory">
        <SessionContextEditor sessionId={sessionKey} currentUser={currentUser} initialExpandedId={context.id} />
      </div>
    </ModalFrame>
  );
}
