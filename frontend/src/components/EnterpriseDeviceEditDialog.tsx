import { useState } from 'react';
import './EnterpriseDevicePanel.css';
import { updateEnterpriseDevice, type DeviceSummary } from '../api/enterpriseDevices';
import DeviceMemoryEditor from './DeviceMemoryEditor';
import SessionContextEditor from './SessionContextEditor';
import { useAuthStore } from '../stores/authStore';
import DialogFooter from './DialogFooter';
import ModalFrame from './ModalFrame';

export type EnterpriseDeviceEditTab = 'properties' | 'memory' | 'context';

interface EnterpriseDeviceEditDialogProps {
  device: DeviceSummary;
  initialTab?: EnterpriseDeviceEditTab;
  /** Context entry to show expanded when the dialog opens on the Context tab. */
  initialContextId?: string;
  onClose: () => void;
  /** The device's properties were saved. */
  onSaved?: () => void;
}

/**
 * Enterprise "Edit Device": properties, Device Memory and Context (Team
 * Knowledge) for a Controller device — the enterprise counterpart of the
 * standalone Edit Session dialog.
 */
export default function EnterpriseDeviceEditDialog({ device, initialTab = 'properties', initialContextId, onClose, onSaved }: EnterpriseDeviceEditDialogProps) {
  const [editForm, setEditForm] = useState({
    name: device.name,
    host: device.host,
    port: device.port,
    device_type: device.device_type,
    description: '',
    site: device.site || '',
    manufacturer: device.manufacturer || '',
    model: device.model || '',
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editTab, setEditTab] = useState<EnterpriseDeviceEditTab>(initialTab);

  // Current user — author for device-memory and context entries created here.
  const currentUser = useAuthStore((s) => s.user)?.username ?? 'Unknown';

  const handleSaveEdit = async () => {
    setEditSaving(true);
    try {
      await updateEnterpriseDevice(device.id, editForm);
      onClose();
      onSaved?.();
    } catch (err) {
      console.error('Failed to update device:', err);
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <ModalFrame id="enterprise-device-edit" className="device-edit-dialog" label="Edit Device">
      <div className="device-edit-header">
        <h3>Edit Device</h3>
        <button className="ns-btn ns-btn--ghost ns-icon-btn" onClick={onClose}>&times;</button>
      </div>
      <div className="ns-segmented">
        <button
          className={`ns-segment ${editTab === 'properties' ? 'active' : ''}`}
          onClick={() => setEditTab('properties')}
        >
          Properties
        </button>
        <button
          className={`ns-segment ${editTab === 'memory' ? 'active' : ''}`}
          onClick={() => setEditTab('memory')}
        >
          Device Memory
        </button>
        <button
          className={`ns-segment ${editTab === 'context' ? 'active' : ''}`}
          onClick={() => setEditTab('context')}
        >
          Context
        </button>
      </div>
      {editTab === 'properties' && (
        <>
      <div className="device-edit-form">
        <div className="device-edit-field">
          <label>Name</label>
          <input data-ai-fill="off" aria-label="Name" className="ns-input" value={editForm.name} onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))} />
        </div>
        <div className="device-edit-row">
          <div className="device-edit-field">
            <label>Host</label>
            <input data-ai-fill="off" aria-label="Host" className="ns-input" value={editForm.host} onChange={(e) => setEditForm(prev => ({ ...prev, host: e.target.value }))} />
          </div>
          <div className="device-edit-field" style={{ maxWidth: 80 }}>
            <label>Port</label>
            <input aria-label="Port" className="ns-input"
              type="number"
              min={1}
              max={65535}
              step={1}
              value={editForm.port}
              onChange={(e) => setEditForm(prev => ({ ...prev, port: parseInt(e.target.value) || 22 }))}
            />
          </div>
        </div>
        <div className="device-edit-field">
          <label>Device Type</label>
          <input data-ai-fill="off" aria-label="Device Type" className="ns-input" value={editForm.device_type} onChange={(e) => setEditForm(prev => ({ ...prev, device_type: e.target.value }))} />
        </div>
        <div className="device-edit-row">
          <div className="device-edit-field">
            <label>Site</label>
            <input data-ai-fill="off" aria-label="Site" className="ns-input" value={editForm.site} onChange={(e) => setEditForm(prev => ({ ...prev, site: e.target.value }))} />
          </div>
        </div>
        <div className="device-edit-row">
          <div className="device-edit-field">
            <label>Manufacturer</label>
            <input data-ai-fill="off" aria-label="Manufacturer" className="ns-input" value={editForm.manufacturer} onChange={(e) => setEditForm(prev => ({ ...prev, manufacturer: e.target.value }))} />
          </div>
          <div className="device-edit-field">
            <label>Model</label>
            <input data-ai-fill="off" aria-label="Model" className="ns-input" value={editForm.model} onChange={(e) => setEditForm(prev => ({ ...prev, model: e.target.value }))} />
          </div>
        </div>
      </div>
      <DialogFooter
        primary={{ label: editSaving ? 'Saving...' : 'Save', onClick: handleSaveEdit, disabled: editSaving }}
        onCancel={onClose}
        cancelDisabled={editSaving}
      />
        </>
      )}
      {editTab === 'memory' && (
        <div className="device-edit-memory">
          <DeviceMemoryEditor deviceId={device.id} currentUser={currentUser} />
        </div>
      )}
      {editTab === 'context' && (
        <div className="device-edit-memory">
          <SessionContextEditor deviceId={device.id} currentUser={currentUser} initialExpandedId={initialContextId} />
        </div>
      )}
    </ModalFrame>
  );
}
