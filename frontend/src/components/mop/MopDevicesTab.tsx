// MopDevicesTab — extracted from MopWorkspace.renderDevicesTab
// Renders the Devices sub-tab: search toolbar, device/session list with checkboxes,
// credential override selectors, step-device assignment matrix

import './MopWorkspace.css';
import type { MopStep } from '../../types/change';
import type { Session } from '../../api/sessions';
import type { DeviceSummary } from '../../api/enterpriseDevices';
import type { AccessibleCredential } from '../../types/enterpriseCredential';

// Shared checkbox SVG components (duplicated from MopWorkspace since they are module-private)
function CheckboxChecked() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="var(--accent-color, #0078d4)">
      <rect x="1" y="1" width="14" height="14" rx="2" />
      <path d="M4 8l3 3 5-6" stroke="#fff" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

function CheckboxUnchecked() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--text-secondary)" strokeWidth="1">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
    </svg>
  );
}

// ============================================================================
// Props Interface
// ============================================================================

export interface MopDevicesTabProps {
  // Enterprise context
  isEnterprise: boolean;

  // Search
  deviceSearch: string;
  setDeviceSearch: (v: string) => void;

  // Device selection
  selectedDeviceIds: Set<string>;
  toggleDeviceSelection: (id: string) => void;
  selectAllDevices: () => void;
  deselectAllDevices: () => void;

  // Filtered lists
  filteredEnterpriseDevices: DeviceSummary[];
  filteredSessions: Session[];

  // Raw lists (for matrix device lookup)
  enterpriseDevices: DeviceSummary[];
  sessions: Session[];

  // Loading
  devicesLoading: boolean;

  // Credential overrides (enterprise)
  accessibleCredentials: AccessibleCredential[];
  credentialOverrides: Map<string, string>;
  setCredentialOverrides: React.Dispatch<React.SetStateAction<Map<string, string>>>;

  // Steps (for assignment matrix)
  steps: MopStep[];
  updateStepField: (stepId: string, updates: Partial<MopStep>) => void;
  markDirty: () => void;
}

// ============================================================================
// Component
// ============================================================================

export default function MopDevicesTab(props: MopDevicesTabProps) {
  const {
    isEnterprise,
    deviceSearch,
    setDeviceSearch,
    selectedDeviceIds,
    toggleDeviceSelection,
    selectAllDevices,
    deselectAllDevices,
    filteredEnterpriseDevices,
    filteredSessions,
    enterpriseDevices,
    sessions,
    devicesLoading,
    accessibleCredentials,
    credentialOverrides,
    setCredentialOverrides,
    steps,
    updateStepField,
    markDirty,
  } = props;

  const totalCount = isEnterprise ? filteredEnterpriseDevices.length : filteredSessions.length;
  const allSelected = totalCount > 0 && selectedDeviceIds.size >= totalCount;

  return (
    <div className="mop-devices-tab">
      {/* Toolbar */}
      <div className="mop-devices-toolbar">
        <div className="mop-devices-search">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" opacity="0.5">
            <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85zm-5.242.156a5 5 0 110-10 5 5 0 010 10z" />
          </svg>
          <input
            value={deviceSearch}
            onChange={(e) => setDeviceSearch(e.target.value)}
            placeholder={isEnterprise ? 'Search devices by name, host, site...' : 'Search sessions by name or host...'}
          />
        </div>
        <div className="mop-devices-toolbar-actions">
          <span className="mop-devices-count">
            {selectedDeviceIds.size} of {totalCount} selected
          </span>
          <button
            className="mop-workspace-header-btn"
            onClick={allSelected ? deselectAllDevices : selectAllDevices}
          >
            {allSelected ? 'Deselect All' : 'Select All'}
          </button>
        </div>
      </div>

      {/* Device list */}
      <div className="mop-devices-list">
        {devicesLoading ? (
          <div className="mop-workspace-empty">
            <p>Loading {isEnterprise ? 'devices' : 'sessions'}...</p>
          </div>
        ) : totalCount === 0 ? (
          <div className="mop-workspace-empty">
            <h3>No {isEnterprise ? 'Devices' : 'Sessions'} Found</h3>
            <p>
              {deviceSearch
                ? 'No matches for your search. Try a different query.'
                : isEnterprise
                  ? 'No devices in controller inventory. Add devices in the admin panel.'
                  : 'No sessions configured. Create sessions in the sidebar.'}
            </p>
          </div>
        ) : isEnterprise ? (
          /* Enterprise: device inventory */
          filteredEnterpriseDevices.map(device => (
            <div
              key={device.id}
              className={`mop-device-item ${selectedDeviceIds.has(device.id) ? 'selected' : ''}`}
              onClick={() => toggleDeviceSelection(device.id)}
            >
              <div className="mop-device-checkbox">
                {selectedDeviceIds.has(device.id) ? <CheckboxChecked /> : <CheckboxUnchecked />}
              </div>
              <div className="mop-device-info">
                <span className="mop-device-name">{device.name}</span>
                <span className="mop-device-host">{device.host}:{device.port}</span>
              </div>
              <div className="mop-device-meta">
                {device.device_type && (
                  <span className="mop-device-tag">{device.device_type}</span>
                )}
                {device.site && (
                  <span className="mop-device-tag">{device.site}</span>
                )}
              </div>
              {/* Credential override selector (only for selected devices) */}
              {selectedDeviceIds.has(device.id) && accessibleCredentials.length > 0 && (
                <select
                  className="mop-device-credential-select"
                  value={credentialOverrides.get(device.id) || ''}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation();
                    setCredentialOverrides(prev => {
                      const next = new Map(prev);
                      if (e.target.value) {
                        next.set(device.id, e.target.value);
                      } else {
                        next.delete(device.id);
                      }
                      return next;
                    });
                  }}
                  title="Credential override for this device"
                >
                  <option value="">Default Credential</option>
                  {accessibleCredentials.map(cred => (
                    <option key={cred.id} value={cred.id}>
                      {cred.name} ({cred.credential_type === 'ssh_key' ? 'Key' : 'Password'})
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))
        ) : (
          /* Professional: session list */
          filteredSessions.map(session => (
            <div
              key={session.id}
              className={`mop-device-item ${selectedDeviceIds.has(session.id) ? 'selected' : ''}`}
              onClick={() => toggleDeviceSelection(session.id)}
            >
              <div className="mop-device-checkbox">
                {selectedDeviceIds.has(session.id) ? <CheckboxChecked /> : <CheckboxUnchecked />}
              </div>
              <div className="mop-device-info">
                <span className="mop-device-name">{session.name}</span>
                <span className="mop-device-host">{session.host}:{session.port}</span>
              </div>
              <div className="mop-device-meta">
                <span className="mop-device-tag">{session.protocol.toUpperCase()}</span>
                {session.cli_flavor !== 'auto' && (
                  <span className="mop-device-tag">{session.cli_flavor}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Step Assignment Matrix — only when devices and steps exist */}
      {selectedDeviceIds.size > 0 && steps.length > 0 && (
        <div className="mop-device-matrix">
          <div className="mop-device-matrix-header">
            <span>Step Assignment</span>
            <span className="mop-device-matrix-hint">Click cells to toggle which steps run on which devices</span>
          </div>
          <div className="mop-device-matrix-scroll">
            <table className="mop-device-matrix-table">
              <thead>
                <tr>
                  <th className="mop-matrix-device-col">Device</th>
                  {steps
                    .sort((a, b) => {
                      const typeOrder: Record<string, number> = { pre_check: 0, change: 1, post_check: 2, rollback: 3 };
                      const typeDiff = (typeOrder[a.step_type] ?? 99) - (typeOrder[b.step_type] ?? 99);
                      return typeDiff !== 0 ? typeDiff : a.order - b.order;
                    })
                    .map((step, idx) => (
                      <th
                        key={step.id}
                        className="mop-matrix-step-col"
                        title={step.description || step.command || `Step ${idx + 1}`}
                      >
                        <span className="mop-matrix-step-type" style={{
                          color: step.step_type === 'pre_check' ? '#4fc1ff'
                            : step.step_type === 'change' ? '#dcdcaa'
                            : step.step_type === 'post_check' ? '#4ec9b0'
                            : '#ce9178'
                        }}>
                          {step.step_type === 'pre_check' ? 'P' : step.step_type === 'change' ? 'C' : step.step_type === 'post_check' ? 'V' : 'R'}
                          {steps.filter(s => s.step_type === step.step_type).indexOf(step) + 1}
                        </span>
                      </th>
                    ))
                  }
                </tr>
              </thead>
              <tbody>
                {Array.from(selectedDeviceIds).map(deviceId => {
                  const device = isEnterprise
                    ? enterpriseDevices.find(d => d.id === deviceId)
                    : sessions.find(s => s.id === deviceId);
                  if (!device) return null;
                  // Both DeviceSummary and Session expose `name` directly.
                  const deviceName = device.name;
                  return (
                    <tr key={deviceId}>
                      <td className="mop-matrix-device-cell">
                        <span className="mop-matrix-device-name">{deviceName}</span>
                      </td>
                      {steps
                        .sort((a, b) => {
                          const typeOrder: Record<string, number> = { pre_check: 0, change: 1, post_check: 2, rollback: 3 };
                          const typeDiff = (typeOrder[a.step_type] ?? 99) - (typeOrder[b.step_type] ?? 99);
                          return typeDiff !== 0 ? typeDiff : a.order - b.order;
                        })
                        .map(step => {
                          const isActive = step.device_scope === 'all'
                            || (step.device_scope === 'specific' && step.device_ids?.includes(deviceId))
                            || (!step.device_scope); // default to all
                          const isAllScope = !step.device_scope || step.device_scope === 'all';

                          return (
                            <td
                              key={step.id}
                              className={`mop-matrix-cell ${isActive ? 'active' : ''} ${isAllScope ? 'all-scope' : ''}`}
                              onClick={() => {
                                if (isAllScope) {
                                  // Switching from 'all' to 'specific' — include all devices except this one
                                  const allDeviceIds = Array.from(selectedDeviceIds).filter(id => id !== deviceId);
                                  updateStepField(step.id, {
                                    device_scope: 'specific',
                                    device_ids: allDeviceIds,
                                  });
                                } else if (isActive) {
                                  // Remove this device from the list
                                  const newIds = (step.device_ids || []).filter(id => id !== deviceId);
                                  if (newIds.length === 0 || newIds.length === selectedDeviceIds.size) {
                                    // If empty or all selected, switch back to 'all'
                                    updateStepField(step.id, { device_scope: 'all', device_ids: undefined });
                                  } else {
                                    updateStepField(step.id, { device_ids: newIds });
                                  }
                                } else {
                                  // Add this device to the list
                                  const newIds = [...(step.device_ids || []), deviceId];
                                  if (newIds.length >= selectedDeviceIds.size) {
                                    // All devices selected, switch to 'all'
                                    updateStepField(step.id, { device_scope: 'all', device_ids: undefined });
                                  } else {
                                    updateStepField(step.id, { device_ids: newIds });
                                  }
                                }
                                markDirty();
                              }}
                              title={isAllScope ? 'All devices (click to exclude this device)' : isActive ? 'Click to exclude' : 'Click to include'}
                            >
                              {isActive ? (
                                <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                                  <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                                </svg>
                              ) : (
                                <span className="mop-matrix-empty" />
                              )}
                            </td>
                          );
                        })
                      }
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
