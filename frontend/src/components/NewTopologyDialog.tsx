import { useState, useEffect } from 'react';
import { listSessions, type Session } from '../api/sessions';
import { listEnterpriseDevices, type DeviceSummary } from '../api/enterpriseDevices';
import { getCurrentMode } from '../api/client';
import { useSubmitting } from '../hooks/useSubmitting';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import './NewTopologyDialog.css';
import AITabInput from './AITabInput';

interface NewTopologyDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Sync or async — the dialog tracks pending state if it returns a Promise. */
  onStartDiscovery: (name: string, sessions: { id: string; name: string; host?: string; profileId?: string; cliFlavor?: string; credentialId?: string; snmpCredentialId?: string }[]) => void | Promise<void>;
  connectedSessionIds: string[];
}

export default function NewTopologyDialog({
  isOpen,
  onClose,
  onStartDiscovery,
  connectedSessionIds,
}: NewTopologyDialogProps) {
  const [name, setName] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [enterpriseDevices, setEnterpriseDevices] = useState<DeviceSummary[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const isEnterprise = getCurrentMode() === 'enterprise';

  useEffect(() => {
    if (!isOpen) return;

    async function load() {
      try {
        if (isEnterprise) {
          const response = await listEnterpriseDevices({ limit: 1000 });
          setEnterpriseDevices(response.items);
          // Pre-select all devices
          setSelectedIds(response.items.map(d => d.id));
        } else {
          const data = await listSessions();
          const activeSessions = data.filter(s => connectedSessionIds.includes(s.id));
          setSessions(activeSessions);
          setSelectedIds(connectedSessionIds);
        }
      } catch (err) {
        console.error('Failed to load devices:', err);
      }
    }
    load();

    setName('');
    setError(null);
    setSearchQuery('');
  }, [isOpen, connectedSessionIds, isEnterprise]);

  const { submitting, run } = useSubmitting();

  const handleStartDiscovery = () => {
    if (!name.trim()) {
      setError('Please enter a name');
      return;
    }
    if (selectedIds.length === 0) {
      setError('Please select at least one device');
      return;
    }

    run(async () => {
      await runStartDiscovery();
    });
  };

  const runStartDiscovery = async () => {
    if (isEnterprise) {
      const selected = enterpriseDevices
        .filter(d => selectedIds.includes(d.id))
        .map(d => ({
          id: d.id,
          name: d.name,
          host: d.host,
          credentialId: d.default_credential_id || undefined,
          snmpCredentialId: d.snmp_credential_id || undefined,
        }));
      await Promise.resolve(onStartDiscovery(name.trim(), selected));
    } else {
      const selected = sessions
        .filter(s => selectedIds.includes(s.id))
        .map(s => ({
          id: s.id,
          name: s.name,
          host: s.host,
          profileId: s.profile_id,
          cliFlavor: s.cli_flavor,
        }));
      await Promise.resolve(onStartDiscovery(name.trim(), selected));
    }
    onClose();
  };

  const toggleItem = (id: string) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleAll = () => {
    const allIds = isEnterprise
      ? filteredEnterpriseDevices.map(d => d.id)
      : sessions.map(s => s.id);
    const allSelected = allIds.every(id => selectedIds.includes(id));
    if (allSelected) {
      setSelectedIds(prev => prev.filter(id => !allIds.includes(id)));
    } else {
      setSelectedIds(prev => [...new Set([...prev, ...allIds])]);
    }
  };

  const filteredEnterpriseDevices = searchQuery
    ? enterpriseDevices.filter(d =>
        d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        d.host.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (d.site && d.site.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : enterpriseDevices;

  const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: onClose, enabled: !submitting });

  if (!isOpen) return null;

  const totalCount = isEnterprise ? enterpriseDevices.length : sessions.length;

  return (
    <div className="dialog-overlay" {...backdropProps}>
      <div className="dialog new-topology-dialog" {...contentProps}>
        <div className="dialog-header">
          <h3>New Topology</h3>
          <button className="dialog-close" onClick={onClose} disabled={submitting}>x</button>
        </div>

        <div className="dialog-body">
          <div className="form-field">
            <label>Name</label>
            <AITabInput
              value={name}
              onChange={e => setName(e.target.value)}
              onInvalid={e => e.preventDefault()}
              placeholder="e.g., WAN Issue, DC Troubleshooting"
              autoFocus
              aiField="topology_name"
              aiPlaceholder="Name for this topology map"
              aiContext={{ deviceCount: selectedIds.length }}
              onAIValue={(v) => setName(v)}
            />
          </div>

          <div className="form-field">
            <label>
              {isEnterprise ? 'Devices to discover' : 'Active sessions to discover'}
              {totalCount > 0 && (
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  {selectedIds.length}/{totalCount} selected
                  <button
                    style={{ marginLeft: 6, background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-family)' }}
                    onClick={toggleAll}
                  >
                    {selectedIds.length === totalCount ? 'Deselect All' : 'Select All'}
                  </button>
                </span>
              )}
            </label>

            {isEnterprise && enterpriseDevices.length > 5 && (
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search devices..."
                className="topology-device-search"
                style={{ marginBottom: 6, padding: '4px 8px', fontSize: 12, background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)', borderRadius: 4, color: 'var(--color-text-primary)', fontFamily: 'var(--font-family)', outline: 'none', width: '100%', boxSizing: 'border-box' }}
              />
            )}

            <div className="session-checklist">
              {isEnterprise ? (
                <>
                  {filteredEnterpriseDevices.map(device => (
                    <label key={device.id} className="session-checkbox">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(device.id)}
                        onChange={() => toggleItem(device.id)}
                      />
                      <span className="status-dot connected" />
                      <span className="session-name">{device.name}</span>
                      <span className="session-host">{device.host}</span>
                      {device.device_type && (
                        <span style={{ fontSize: 9, padding: '1px 5px', background: 'var(--color-accent)', color: 'white', borderRadius: 8, marginLeft: 'auto', textTransform: 'uppercase' }}>
                          {device.device_type}
                        </span>
                      )}
                    </label>
                  ))}
                  {filteredEnterpriseDevices.length === 0 && enterpriseDevices.length > 0 && (
                    <div className="empty-state">No devices match "{searchQuery}"</div>
                  )}
                  {enterpriseDevices.length === 0 && (
                    <div className="empty-state">No devices in controller inventory.</div>
                  )}
                </>
              ) : (
                <>
                  {sessions.map(session => (
                    <label key={session.id} className="session-checkbox">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(session.id)}
                        onChange={() => toggleItem(session.id)}
                      />
                      <span className="status-dot connected" />
                      <span className="session-name">{session.name}</span>
                      <span className="session-host">{session.host}</span>
                    </label>
                  ))}
                  {sessions.length === 0 && (
                    <div className="empty-state">No active sessions. Open terminal tabs first.</div>
                  )}
                </>
              )}
            </div>
          </div>

          {error && <div className="error-message">{error}</div>}
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            className="btn-primary"
            onClick={handleStartDiscovery}
            disabled={submitting || !name.trim() || selectedIds.length === 0}
          >
            {submitting ? 'Starting…' : 'Discover Topology'}
          </button>
        </div>
      </div>
    </div>
  );
}
