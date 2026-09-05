// MopDevicesTab — extracted from MopWorkspace.renderDevicesTab
// Renders the Devices sub-tab: search toolbar, device/session list with checkboxes,
// credential override selectors, step-device assignment matrix

import { Fragment, useMemo, useState } from 'react';
import './MopWorkspace.css';
import type { MopStep, MopVariable, MopDeviceVariables } from '../../types/change';
import type { Session } from '../../api/sessions';
import type { DeviceSummary } from '../../api/enterpriseDevices';
import type { AccessibleProfile } from '../../types/enterpriseProfile';
import { STEP_TYPE_COLORS, STEP_TYPE_LETTERS } from './constants';
import { sortPlanSteps, stepAppliesToDevice } from './mopHelpers';

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

  // Device selection. Select/Deselect All act on the filtered rows only.
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

  // Profile overrides (enterprise)
  accessibleCredentials: AccessibleProfile[];
  credentialOverrides: Map<string, string>;
  setCredentialOverrides: React.Dispatch<React.SetStateAction<Map<string, string>>>;

  // Steps (for assignment matrix)
  steps: MopStep[];
  updateStepField: (stepId: string, updates: Partial<MopStep>) => void;
  markDirty: () => void;

  // Plan variables — per-device overrides live in the row expansion
  variables: MopDevicesVariablesProps;
}

export interface MopDevicesVariablesProps {
  variables: MopVariable[];
  deviceVariables: MopDeviceVariables;
  /** "" removes the override (inherit the plan default). */
  setDeviceVariable: (sessionId: string, name: string, value: string) => void;
}

// ============================================================================
// Per-device variable overrides (row expansion)
// ============================================================================

interface DeviceVariablesPanelProps {
  deviceId: string;
  deviceName: string;
  variables: MopVariable[];
  overrides: Record<string, string>;
  setDeviceVariable: (sessionId: string, name: string, value: string) => void;
}

function DeviceVariablesPanel({ deviceId, deviceName, variables, overrides, setDeviceVariable }: DeviceVariablesPanelProps) {
  return (
    <div className="mop-device-vars-panel" data-testid={`mop-device-vars-${deviceId}`} onClick={(e) => e.stopPropagation()}>
      <span className="mop-device-vars-panel-title">Variable overrides for {deviceName} — blank inherits the plan default</span>
      {variables.map(v => {
        const override = overrides[v.name] ?? '';
        const effective = override !== '' ? override : v.value;
        return (
          <Fragment key={v.name}>
              <label className="mop-device-vars-name" htmlFor={`mop-dv-${deviceId}-${v.name}`}>
                {`{{${v.name}}}`}
                {v.required && <span className="required" title="Required">*</span>}
              </label>
              <input
                id={`mop-dv-${deviceId}-${v.name}`}
                className={`mop-variables-input mono ${v.required && !effective ? 'invalid' : ''}`}
                value={override}
                onChange={(e) => setDeviceVariable(deviceId, v.name, e.target.value)}
                placeholder={v.value ? `${v.value} (plan default)` : v.required ? '(required — no default)' : '(empty)'}
                title={v.description || undefined}
                aria-label={`${v.name} for ${deviceName}`}
                spellCheck={false}
              />
          </Fragment>
        );
      })}
    </div>
  );
}

interface DeviceVariablesToggleProps {
  deviceId: string;
  overrides: Record<string, string>;
  expanded: boolean;
  onToggle: () => void;
}

function DeviceVariablesToggle({ deviceId, overrides, expanded, onToggle }: DeviceVariablesToggleProps) {
  const n = Object.values(overrides).filter(v => v !== '').length;
  return (
    <button
      type="button"
      className={`mop-device-vars-toggle ${expanded ? 'active' : ''} ${n > 0 ? 'overridden' : ''}`}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      aria-expanded={expanded}
      aria-controls={`mop-device-vars-${deviceId}`}
      title="Per-device variable values"
    >
      Variables{n > 0 ? ` (${n} overridden)` : ''}
    </button>
  );
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
    variables: variablesState,
  } = props;
  const { variables, deviceVariables, setDeviceVariable } = variablesState;
  const hasVariables = variables.length > 0;
  const [expandedVarDevices, setExpandedVarDevices] = useState<Set<string>>(new Set());
  const toggleVarDevice = (id: string) => setExpandedVarDevices(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const totalCount = isEnterprise ? filteredEnterpriseDevices.length : filteredSessions.length;
  // "All" means every *visible* row — a search filter scopes both buttons
  const visibleIds = isEnterprise ? filteredEnterpriseDevices.map(d => d.id) : filteredSessions.map(s => s.id);
  const visibleSelected = visibleIds.filter(id => selectedDeviceIds.has(id)).length;
  const allSelected = totalCount > 0 && visibleSelected === totalCount;
  const isFiltered = deviceSearch.trim().length > 0;

  // Matrix columns: sorted copy (never sort plan state in render)
  const sortedSteps = useMemo(() => sortPlanSteps(steps), [steps]);
  const sectionIndex = useMemo(() => {
    const counters: Record<string, number> = {};
    const index = new Map<string, number>();
    for (const step of sortedSteps) {
      counters[step.step_type] = (counters[step.step_type] ?? 0) + 1;
      index.set(step.id, counters[step.step_type]);
    }
    return index;
  }, [sortedSteps]);

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
            {isFiltered
              ? `${visibleSelected} of ${totalCount} shown selected (${selectedDeviceIds.size} total)`
              : `${selectedDeviceIds.size} of ${totalCount} selected`}
          </span>
          <button
            className="mop-workspace-header-btn"
            onClick={allSelected ? deselectAllDevices : selectAllDevices}
            title={isFiltered ? 'Applies to the rows matching the search' : undefined}
          >
            {allSelected ? (isFiltered ? 'Deselect Shown' : 'Deselect All') : (isFiltered ? 'Select Shown' : 'Select All')}
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
            <Fragment key={device.id}>
              <div
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
                    <option value="">Default Profile</option>
                    {accessibleCredentials.map(profile => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name} ({profile.auth_mode === 'ssh_key' ? 'Key' : profile.auth_mode === 'certificate' ? 'Cert' : profile.auth_mode === 'password' ? 'Password' : 'No auth'})
                      </option>
                    ))}
                  </select>
                )}
                {selectedDeviceIds.has(device.id) && hasVariables && (
                  <DeviceVariablesToggle
                    deviceId={device.id}
                    overrides={deviceVariables[device.id] || {}}
                    expanded={expandedVarDevices.has(device.id)}
                    onToggle={() => toggleVarDevice(device.id)}
                  />
                )}
              </div>
              {selectedDeviceIds.has(device.id) && hasVariables && expandedVarDevices.has(device.id) && (
                <DeviceVariablesPanel
                  deviceId={device.id}
                  deviceName={device.name}
                  variables={variables}
                  overrides={deviceVariables[device.id] || {}}
                  setDeviceVariable={setDeviceVariable}
                />
              )}
            </Fragment>
          ))
        ) : (
          /* Professional: session list */
          filteredSessions.map(session => (
            <Fragment key={session.id}>
              <div
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
                {selectedDeviceIds.has(session.id) && hasVariables && (
                  <DeviceVariablesToggle
                    deviceId={session.id}
                    overrides={deviceVariables[session.id] || {}}
                    expanded={expandedVarDevices.has(session.id)}
                    onToggle={() => toggleVarDevice(session.id)}
                  />
                )}
              </div>
              {selectedDeviceIds.has(session.id) && hasVariables && expandedVarDevices.has(session.id) && (
                <DeviceVariablesPanel
                  deviceId={session.id}
                  deviceName={session.name}
                  variables={variables}
                  overrides={deviceVariables[session.id] || {}}
                  setDeviceVariable={setDeviceVariable}
                />
              )}
            </Fragment>
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
                  {sortedSteps.map((step, idx) => (
                    <th
                      key={step.id}
                      className="mop-matrix-step-col"
                      title={step.description || step.command || `Step ${idx + 1}`}
                    >
                      <span className="mop-matrix-step-type" style={{ color: STEP_TYPE_COLORS[step.step_type] || '#ce9178' }}>
                        {STEP_TYPE_LETTERS[step.step_type] || '?'}
                        {sectionIndex.get(step.id)}
                      </span>
                    </th>
                  ))}
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
                      {sortedSteps
                        .map(step => {
                          const isActive = stepAppliesToDevice(step, deviceId);
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
