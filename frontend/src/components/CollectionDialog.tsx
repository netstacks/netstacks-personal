import { getErrorMessage } from '../api/errors'
/**
 * CollectionDialog - Data collection dialog for topology building
 *
 * Provides three collection methods:
 * 1. Existing Integrations (NetBox, LibreNMS, NetStacksCrawler)
 * 2. MCP Server (query MCP servers for topology tools)
 * 3. CLI Script (execute commands on connected sessions)
 */

import { useState, useEffect, useCallback } from 'react';
import { NeighborParser } from '../lib/neighborParser';
import type { DeviceType } from '../types/topology';
import { getClient } from '../api/client';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import './CollectionDialog.css';

/** Props for CollectionDialog */
export interface CollectionDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Close callback */
  onClose: () => void;
  /** Topology ID to add collected data to */
  topologyId: string;
  /** Callback when collection completes */
  onCollectionComplete: (result: CollectionResult) => void;
  /** Connected sessions available for CLI scripts */
  connectedSessions: ConnectedSession[];
  /** Function to run a command on a session and get output */
  runCommand?: (sessionId: string, command: string) => Promise<string>;
}

/** Connected session info */
export interface ConnectedSession {
  id: string;
  name: string;
  host: string;
}

/** Collection result summary */
export interface CollectionResult {
  devicesAdded: number;
  connectionsAdded: number;
  errors: string[];
}

/** Discovered device preview */
interface DiscoveredDevice {
  name: string;
  ip?: string;
  type: DeviceType;
  platform?: string;
  sourceSession?: string;
  selected: boolean;
}

/** Discovered connection preview */
interface DiscoveredConnection {
  sourceName: string;
  targetName: string;
  sourceInterface?: string;
  targetInterface?: string;
  selected: boolean;
}

/** Tab types */
type CollectionTab = 'integrations' | 'mcp' | 'cli';

/** Parse method for CLI output */
type ParseMethod = 'ai' | 'cdp' | 'lldp' | 'regex';

/** Common command templates */
const COMMAND_TEMPLATES = [
  { name: 'CDP Neighbors (Cisco)', command: 'show cdp neighbors detail' },
  { name: 'LLDP Neighbors (Multi-vendor)', command: 'show lldp neighbors detail' },
  { name: 'IP Route Table', command: 'show ip route' },
  { name: 'Interface Status', command: 'show interfaces status' },
  { name: 'ARP Table', command: 'show ip arp' },
  { name: 'MAC Address Table', command: 'show mac address-table' },
];

/** Integration source info */
interface IntegrationSource {
  id: string;
  name: string;
  type: 'netbox' | 'librenms' | 'netstacksCrawler';
  status: 'connected' | 'disconnected' | 'unknown';
}

export default function CollectionDialog({
  isOpen,
  onClose,
  topologyId,
  onCollectionComplete,
  connectedSessions,
  runCommand,
}: CollectionDialogProps) {
  // Active tab
  const [activeTab, setActiveTab] = useState<CollectionTab>('cli');

  // CLI Script state
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [command, setCommand] = useState('show cdp neighbors detail');
  const [parseMethod, setParseMethod] = useState<ParseMethod>('cdp');
  const [regexPattern, setRegexPattern] = useState('');
  const [cliRunning, setCLIRunning] = useState(false);
  const [cliProgress, setCLIProgress] = useState<{ current: number; total: number } | null>(null);
  const [cliOutputs, setCLIOutputs] = useState<{ sessionId: string; sessionName: string; output: string }[]>([]);

  // Discovered data preview
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredDevice[]>([]);
  const [discoveredConnections, setDiscoveredConnections] = useState<DiscoveredConnection[]>([]);

  // Importing state
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState<string[]>([]);

  // Integration sources (loaded on mount)
  const [integrationSources, setIntegrationSources] = useState<IntegrationSource[]>([]);
  const [loadingIntegrations, setLoadingIntegrations] = useState(false);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setDiscoveredDevices([]);
      setDiscoveredConnections([]);
      setCLIOutputs([]);
      setImportErrors([]);
      setCLIProgress(null);
      // Load integration sources
      loadIntegrationSources();
    }
  }, [isOpen]);

  // Load integration sources
  const loadIntegrationSources = async () => {
    setLoadingIntegrations(true);
    try {
      const sources: IntegrationSource[] = [];

      // Try to load NetBox sources
      try {
        const { data: netboxSources } = await getClient().http.get('/netbox-sources');
        sources.push(...netboxSources.map((s: { id: string; name: string }) => ({
          id: s.id,
          name: s.name,
          type: 'netbox' as const,
          status: 'connected' as const,
        })));
      } catch {
        // NetBox not configured
      }

      // Try to load LibreNMS sources
      try {
        const { data: librenms } = await getClient().http.get('/librenms-sources');
        sources.push(...librenms.map((s: { id: string; name: string }) => ({
          id: s.id,
          name: s.name,
          type: 'librenms' as const,
          status: 'connected' as const,
        })));
      } catch {
        // LibreNMS not configured
      }

      // Try to load NetStacksCrawler sources
      try {
        const { data: netstacksCrawler } = await getClient().http.get('/netstacks-crawler-sources');
        sources.push(...netstacksCrawler.map((s: { id: string; name: string }) => ({
          id: s.id,
          name: s.name,
          type: 'netstacksCrawler' as const,
          status: 'connected' as const,
        })));
      } catch {
        // NetStacksCrawler not configured
      }

      setIntegrationSources(sources);
    } catch (err) {
      console.error('Failed to load integration sources:', err);
    } finally {
      setLoadingIntegrations(false);
    }
  };

  // Toggle session selection
  const toggleSessionSelection = (sessionId: string) => {
    setSelectedSessionIds(prev =>
      prev.includes(sessionId)
        ? prev.filter(id => id !== sessionId)
        : [...prev, sessionId]
    );
  };

  // Select/deselect all sessions
  const selectAllSessions = () => {
    if (selectedSessionIds.length === connectedSessions.length) {
      setSelectedSessionIds([]);
    } else {
      setSelectedSessionIds(connectedSessions.map(s => s.id));
    }
  };

  // Apply command template
  const applyTemplate = (templateCommand: string) => {
    setCommand(templateCommand);
    // Auto-detect parse method from command
    if (templateCommand.toLowerCase().includes('cdp')) {
      setParseMethod('cdp');
    } else if (templateCommand.toLowerCase().includes('lldp')) {
      setParseMethod('lldp');
    } else {
      setParseMethod('ai');
    }
  };

  // Execute CLI script
  const executeCLIScript = useCallback(async () => {
    if (!runCommand || selectedSessionIds.length === 0) return;

    setCLIRunning(true);
    setCLIProgress({ current: 0, total: selectedSessionIds.length });
    setCLIOutputs([]);
    setDiscoveredDevices([]);
    setDiscoveredConnections([]);

    const outputs: typeof cliOutputs = [];
    const allDevices: DiscoveredDevice[] = [];
    const allConnections: DiscoveredConnection[] = [];

    for (let i = 0; i < selectedSessionIds.length; i++) {
      const sessionId = selectedSessionIds[i];
      const session = connectedSessions.find(s => s.id === sessionId);
      if (!session) continue;

      setCLIProgress({ current: i + 1, total: selectedSessionIds.length });

      try {
        // Execute command
        const output = await runCommand(sessionId, command);
        outputs.push({
          sessionId,
          sessionName: session.name,
          output,
        });

        // Parse output based on method
        if (parseMethod === 'cdp' || parseMethod === 'lldp') {
          const result = NeighborParser.parse(output);

          // Add source device (the device we ran the command on)
          const sourceDevice: DiscoveredDevice = {
            name: result.deviceName || session.name,
            ip: session.host,
            type: 'switch', // Default, could be detected
            sourceSession: session.name,
            selected: true,
          };

          // Check if source device already exists
          if (!allDevices.some(d => d.name === sourceDevice.name)) {
            allDevices.push(sourceDevice);
          }

          // Add discovered neighbors
          for (const neighbor of result.neighbors) {
            const neighborDevice: DiscoveredDevice = {
              name: neighbor.neighborName,
              ip: neighbor.neighborIp,
              type: NeighborParser.inferDeviceType(neighbor.neighborPlatform),
              platform: neighbor.neighborPlatform,
              sourceSession: session.name,
              selected: true,
            };

            // Check for duplicates by name
            if (!allDevices.some(d => d.name === neighborDevice.name)) {
              allDevices.push(neighborDevice);
            }

            // Add connection
            allConnections.push({
              sourceName: sourceDevice.name,
              targetName: neighbor.neighborName,
              sourceInterface: neighbor.localInterface,
              targetInterface: neighbor.neighborInterface,
              selected: true,
            });
          }
        } else if (parseMethod === 'regex' && regexPattern) {
          // Custom regex parsing
          try {
            const regex = new RegExp(regexPattern, 'gm');
            let match;
            while ((match = regex.exec(output)) !== null) {
              if (match.groups?.name || match[1]) {
                const device: DiscoveredDevice = {
                  name: match.groups?.name || match[1],
                  ip: match.groups?.ip || match[2],
                  type: 'unknown',
                  sourceSession: session.name,
                  selected: true,
                };
                if (!allDevices.some(d => d.name === device.name)) {
                  allDevices.push(device);
                }
              }
            }
          } catch (err) {
            console.error('Invalid regex pattern:', err);
          }
        } else if (parseMethod === 'ai') {
          // AI parsing would send to backend AI endpoint
          // For now, fall back to CDP/LLDP detection
          const result = NeighborParser.parse(output);
          if (result.neighbors.length > 0) {
            for (const neighbor of result.neighbors) {
              const device: DiscoveredDevice = {
                name: neighbor.neighborName,
                ip: neighbor.neighborIp,
                type: NeighborParser.inferDeviceType(neighbor.neighborPlatform),
                platform: neighbor.neighborPlatform,
                sourceSession: session.name,
                selected: true,
              };
              if (!allDevices.some(d => d.name === device.name)) {
                allDevices.push(device);
              }
            }
          }
        }
      } catch (err) {
        console.error(`Failed to run command on ${session.name}:`, err);
        outputs.push({
          sessionId,
          sessionName: session.name,
          output: `Error: ${getErrorMessage(err, 'Failed to execute command')}`,
        });
      }
    }

    setCLIOutputs(outputs);
    setDiscoveredDevices(allDevices);
    setDiscoveredConnections(allConnections);
    setCLIRunning(false);
    setCLIProgress(null);
  }, [runCommand, selectedSessionIds, connectedSessions, command, parseMethod, regexPattern]);

  // Toggle device selection
  const toggleDeviceSelection = (index: number) => {
    setDiscoveredDevices(prev =>
      prev.map((d, i) => i === index ? { ...d, selected: !d.selected } : d)
    );
  };

  // Toggle connection selection
  const toggleConnectionSelection = (index: number) => {
    setDiscoveredConnections(prev =>
      prev.map((c, i) => i === index ? { ...c, selected: !c.selected } : c)
    );
  };

  // Select/deselect all devices
  const toggleAllDevices = () => {
    const allSelected = discoveredDevices.every(d => d.selected);
    setDiscoveredDevices(prev => prev.map(d => ({ ...d, selected: !allSelected })));
  };

  // Select/deselect all connections
  const toggleAllConnections = () => {
    const allSelected = discoveredConnections.every(c => c.selected);
    setDiscoveredConnections(prev => prev.map(c => ({ ...c, selected: !allSelected })));
  };

  // Import selected devices and connections
  const importSelected = async () => {
    setImporting(true);
    setImportErrors([]);

    const errors: string[] = [];
    let devicesAdded = 0;
    let connectionsAdded = 0;

    // Device ID mapping (name -> new ID)
    const deviceIdMap = new Map<string, string>();

    // Import selected devices
    const selectedDevices = discoveredDevices.filter(d => d.selected);
    for (const device of selectedDevices) {
      try {
        const { data: result } = await getClient().http.post(`/topologies/${topologyId}/devices`, {
          name: device.name,
          host: device.ip || '',
          device_type: device.type,
          // Position will be auto-arranged by backend or set to default
        });
        deviceIdMap.set(device.name, result.id);
        devicesAdded++;
      } catch (err) {
        const axiosErr = err as { response?: { data?: string } };
        errors.push(`Failed to add ${device.name}: ${axiosErr.response?.data || (getErrorMessage(err))}`);
      }
    }

    // Import selected connections
    const selectedConnections = discoveredConnections.filter(c => c.selected);
    for (const conn of selectedConnections) {
      const sourceId = deviceIdMap.get(conn.sourceName);
      const targetId = deviceIdMap.get(conn.targetName);

      if (!sourceId || !targetId) {
        // Try to find existing devices in topology by name
        // This would require fetching topology data first
        errors.push(`Cannot create connection: ${conn.sourceName} -> ${conn.targetName} (device not found)`);
        continue;
      }

      try {
        await getClient().http.post(`/topologies/${topologyId}/connections`, {
          source_device_id: sourceId,
          target_device_id: targetId,
          source_interface: conn.sourceInterface,
          target_interface: conn.targetInterface,
        });
        connectionsAdded++;
      } catch (err) {
        const axiosErr = err as { response?: { data?: string } };
        errors.push(`Failed to add connection ${conn.sourceName} -> ${conn.targetName}: ${axiosErr.response?.data || (getErrorMessage(err))}`);
      }
    }

    setImporting(false);
    setImportErrors(errors);

    // Call completion callback
    onCollectionComplete({
      devicesAdded,
      connectionsAdded,
      errors,
    });

    // Close dialog if successful
    if (errors.length === 0 && (devicesAdded > 0 || connectionsAdded > 0)) {
      onClose();
    }
  };

  // Import from integration source
  const importFromIntegration = async (source: IntegrationSource) => {
    setImporting(true);
    setImportErrors([]);

    try {
      let devices: DiscoveredDevice[] = [];

      if (source.type === 'librenms') {
        const { data } = await getClient().http.get(`/librenms-sources/${source.id}/devices`);
        devices = data.map((d: { hostname: string; ip: string; sysDescr?: string }) => ({
          name: d.hostname,
          ip: d.ip,
          type: 'unknown' as DeviceType,
          platform: d.sysDescr,
          selected: true,
        }));
      } else if (source.type === 'netstacksCrawler') {
        const { data } = await getClient().http.get(`/netstacks-crawler-sources/${source.id}/devices`);
        devices = data.map((d: { name: string; ip: string; model?: string }) => ({
          name: d.name,
          ip: d.ip,
          type: 'unknown' as DeviceType,
          platform: d.model,
          selected: true,
        }));
      } else if (source.type === 'netbox') {
        const { data } = await getClient().http.get(`/netbox-sources/${source.id}/devices`);
        devices = data.results?.map((d: { name: string; primary_ip?: { address: string }; device_role?: { slug: string } }) => ({
          name: d.name,
          ip: d.primary_ip?.address?.split('/')[0],
          type: d.device_role?.slug || 'unknown' as DeviceType,
          selected: true,
        })) || [];
      }

      setDiscoveredDevices(devices);
      setActiveTab('cli'); // Switch to show results
    } catch (err) {
      setImportErrors([`Failed to import from ${source.name}: ${getErrorMessage(err)}`]);
    } finally {
      setImporting(false);
    }
  };

  if (!isOpen) return null;

  const hasDiscoveredData = discoveredDevices.length > 0 || discoveredConnections.length > 0;
  const selectedDeviceCount = discoveredDevices.filter(d => d.selected).length;
  const selectedConnectionCount = discoveredConnections.filter(c => c.selected).length;

  const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: onClose });

  return (
    <div className="collection-dialog-overlay" {...backdropProps}>
      <div className="collection-dialog" {...contentProps}>
        {/* Header */}
        <div className="collection-dialog-header">
          <h2>Collect Topology Data</h2>
          <button className="close-btn" onClick={onClose} title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="collection-tabs">
          <button
            className={`collection-tab ${activeTab === 'integrations' ? 'active' : ''}`}
            onClick={() => setActiveTab('integrations')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
            Integrations
          </button>
          <button
            className={`collection-tab ${activeTab === 'mcp' ? 'active' : ''}`}
            onClick={() => setActiveTab('mcp')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8" />
              <path d="M12 17v4" />
            </svg>
            MCP Server
          </button>
          <button
            className={`collection-tab ${activeTab === 'cli' ? 'active' : ''}`}
            onClick={() => setActiveTab('cli')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            CLI Script
          </button>
        </div>

        {/* Tab Content */}
        <div className="collection-content">
          {/* Integrations Tab */}
          {activeTab === 'integrations' && (
            <div className="integrations-tab">
              <p className="tab-description">
                Import topology data from configured integration sources.
              </p>
              {loadingIntegrations ? (
                <div className="loading-state">Loading integrations...</div>
              ) : integrationSources.length === 0 ? (
                <div className="empty-state">
                  <p>No integrations configured.</p>
                  <p className="hint">Configure NetBox, LibreNMS, or NetStacks-Crawler in Settings &gt; Integrations.</p>
                </div>
              ) : (
                <div className="source-list">
                  {integrationSources.map(source => (
                    <div key={source.id} className="source-card">
                      <div className="source-info">
                        <span className={`source-type-badge ${source.type}`}>
                          {source.type}
                        </span>
                        <span className="source-name">{source.name}</span>
                        <span className={`source-status ${source.status}`}>
                          {source.status}
                        </span>
                      </div>
                      <button
                        className="import-btn"
                        onClick={() => importFromIntegration(source)}
                        disabled={importing || source.status !== 'connected'}
                      >
                        {importing ? 'Importing...' : 'Import Devices'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MCP Server Tab — discovery wiring not yet implemented. The
              discoverFromMcp handler was a placeholder that surfaced a
              misleading "requires MCP server configuration" error even
              when servers WERE configured. Surface the real status until
              real discovery lands. */}
          {activeTab === 'mcp' && (
            <div className="mcp-tab">
              <p className="tab-description">
                Discover topology from MCP servers with topology tools.
              </p>
              <div className="empty-state">
                <p><strong>Coming soon.</strong></p>
                <p className="hint">
                  MCP-driven topology discovery isn't wired up yet. Use the
                  Integrations tab (NetBox / LibreNMS / NetStacks-Crawler) for now.
                </p>
              </div>
            </div>
          )}

          {/* CLI Script Tab */}
          {activeTab === 'cli' && (
            <div className="cli-tab">
              <p className="tab-description">
                Run commands on connected sessions to discover network topology.
              </p>

              {/* Session Selection */}
              <div className="form-section">
                <div className="section-header">
                  <h3>Sessions</h3>
                  <button className="select-all-btn" onClick={selectAllSessions}>
                    {selectedSessionIds.length === connectedSessions.length ? 'Deselect All' : 'Select All'}
                  </button>
                </div>
                {connectedSessions.length === 0 ? (
                  <div className="empty-state small">
                    <p>No connected sessions.</p>
                    <p className="hint">Connect to devices first, then run collection scripts.</p>
                  </div>
                ) : (
                  <div className="session-list">
                    {connectedSessions.map(session => (
                      <label key={session.id} className="session-item">
                        <input
                          type="checkbox"
                          checked={selectedSessionIds.includes(session.id)}
                          onChange={() => toggleSessionSelection(session.id)}
                        />
                        <span className="session-name">{session.name}</span>
                        <span className="session-host">{session.host}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Command Input */}
              <div className="form-section">
                <div className="section-header">
                  <h3>Command</h3>
                  <select
                    className="template-select"
                    value=""
                    onChange={e => {
                      if (e.target.value) applyTemplate(e.target.value);
                    }}
                  >
                    <option value="">Templates...</option>
                    {COMMAND_TEMPLATES.map(t => (
                      <option key={t.command} value={t.command}>{t.name}</option>
                    ))}
                  </select>
                </div>
                <input
                  type="text"
                  className="command-input"
                  value={command}
                  onChange={e => setCommand(e.target.value)}
                  placeholder="Enter command..."
                />
              </div>

              {/* Parse Method */}
              <div className="form-section">
                <h3>Parse Method</h3>
                <div className="parse-options">
                  <label className="parse-option">
                    <input
                      type="radio"
                      name="parseMethod"
                      value="cdp"
                      checked={parseMethod === 'cdp'}
                      onChange={() => setParseMethod('cdp')}
                    />
                    <span>CDP Parser</span>
                  </label>
                  <label className="parse-option">
                    <input
                      type="radio"
                      name="parseMethod"
                      value="lldp"
                      checked={parseMethod === 'lldp'}
                      onChange={() => setParseMethod('lldp')}
                    />
                    <span>LLDP Parser</span>
                  </label>
                  <label className="parse-option">
                    <input
                      type="radio"
                      name="parseMethod"
                      value="ai"
                      checked={parseMethod === 'ai'}
                      onChange={() => setParseMethod('ai')}
                    />
                    <span>AI Powered</span>
                  </label>
                  <label className="parse-option">
                    <input
                      type="radio"
                      name="parseMethod"
                      value="regex"
                      checked={parseMethod === 'regex'}
                      onChange={() => setParseMethod('regex')}
                    />
                    <span>Custom Regex</span>
                  </label>
                </div>
                {parseMethod === 'regex' && (
                  <input
                    type="text"
                    className="regex-input"
                    value={regexPattern}
                    onChange={e => setRegexPattern(e.target.value)}
                    placeholder="e.g., (?<name>\S+)\s+(?<ip>\d+\.\d+\.\d+\.\d+)"
                  />
                )}
              </div>

              {/* Run Button */}
              <button
                className="run-script-btn"
                onClick={executeCLIScript}
                disabled={cliRunning || selectedSessionIds.length === 0 || !command}
              >
                {cliRunning ? (
                  <>
                    <span className="spinner" />
                    Running... {cliProgress && `(${cliProgress.current}/${cliProgress.total})`}
                  </>
                ) : (
                  'Run Script'
                )}
              </button>
            </div>
          )}

          {/* Results Preview */}
          {hasDiscoveredData && (
            <div className="results-section">
              <h3>Discovered Data</h3>

              {/* Devices */}
              {discoveredDevices.length > 0 && (
                <div className="results-group">
                  <div className="results-header">
                    <span>Devices ({selectedDeviceCount}/{discoveredDevices.length} selected)</span>
                    <button className="toggle-all-btn" onClick={toggleAllDevices}>
                      {discoveredDevices.every(d => d.selected) ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                  <div className="results-list">
                    {discoveredDevices.map((device, i) => (
                      <label key={`${device.name}-${i}`} className="result-item">
                        <input
                          type="checkbox"
                          checked={device.selected}
                          onChange={() => toggleDeviceSelection(i)}
                        />
                        <span className="result-name">{device.name}</span>
                        {device.ip && <span className="result-ip">{device.ip}</span>}
                        <span className={`result-type ${device.type}`}>{device.type}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Connections */}
              {discoveredConnections.length > 0 && (
                <div className="results-group">
                  <div className="results-header">
                    <span>Connections ({selectedConnectionCount}/{discoveredConnections.length} selected)</span>
                    <button className="toggle-all-btn" onClick={toggleAllConnections}>
                      {discoveredConnections.every(c => c.selected) ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                  <div className="results-list connections">
                    {discoveredConnections.map((conn, i) => (
                      <label key={`${conn.sourceName}-${conn.targetName}-${i}`} className="result-item connection">
                        <input
                          type="checkbox"
                          checked={conn.selected}
                          onChange={() => toggleConnectionSelection(i)}
                        />
                        <span className="conn-source">{conn.sourceName}</span>
                        {conn.sourceInterface && <span className="conn-intf">({conn.sourceInterface})</span>}
                        <span className="conn-arrow">→</span>
                        <span className="conn-target">{conn.targetName}</span>
                        {conn.targetInterface && <span className="conn-intf">({conn.targetInterface})</span>}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Errors */}
          {importErrors.length > 0 && (
            <div className="errors-section">
              <h4>Errors</h4>
              <ul>
                {importErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="collection-dialog-footer">
          <button className="cancel-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="import-btn primary"
            onClick={importSelected}
            disabled={importing || (selectedDeviceCount === 0 && selectedConnectionCount === 0)}
          >
            {importing ? 'Importing...' : `Import ${selectedDeviceCount} Devices, ${selectedConnectionCount} Connections`}
          </button>
        </div>
      </div>
    </div>
  );
}
