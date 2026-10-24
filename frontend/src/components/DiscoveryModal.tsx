import { useState, useEffect, useRef } from 'react';
import './DiscoveryModal.css';
import AskAiHelp from './AskAiHelp';
import { runBatchDiscovery, getDiscoveryCapabilities } from '../api/discovery';
import type { DiscoveredNeighbor, NmapResult, BatchDiscoveryRequest, DiscoveryCapabilities } from '../types/discovery';

import { getErrorMessage } from '../api/errors'
import DialogFooter from './DialogFooter';
import ModalFrame from './ModalFrame';
export interface DiscoveryLogEntry {
  timestamp: Date;
  level: 'info' | 'success' | 'warning' | 'error';
  device?: string;
  message: string;
}

export interface DiscoveryResult {
  device: string;
  ip: string;
  tabId: string;
  profileId?: string;
  snmpProfileId?: string;
  sysName: string | null;
  sysDescr: string | null;
  neighbors: DiscoveredNeighbor[];
  discoveryMethod: string;
  nmap: NmapResult | null;
  error: string | null;
}

interface DiscoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupName: string;
  devices: {
    name: string;
    tabId: string;
    /** Database session UUID — what the agent's session lookup (jump host,
     *  creds, port) keys on. `tabId` is only for mapping results back. */
    sessionId?: string;
    ip?: string;
    profileId?: string;
    snmpProfileId?: string;
    cliFlavor?: string;
    credentialId?: string;
    snmpCredentialId?: string;
  }[];
  onDiscoveryComplete: (results: DiscoveryResult[]) => void;
}

export default function DiscoveryModal({ isOpen, ...rest }: DiscoveryModalProps) {
  // The body mounts only while open, so every opening starts from a fresh,
  // idle run, and closing (unmounting) abandons whatever run was in flight.
  if (!isOpen) return null;
  return <DiscoveryModalBody {...rest} />;
}

function DiscoveryModalBody({
  onClose,
  groupName,
  devices,
  onDiscoveryComplete,
}: Omit<DiscoveryModalProps, 'isOpen'>) {
  const [logs, setLogs] = useState<DiscoveryLogEntry[]>([]);
  const [phase, setPhase] = useState<'idle' | 'discovering' | 'analyzing' | 'complete' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  const [capabilities, setCapabilities] = useState<DiscoveryCapabilities | null>(null);
  // Wall-clock seconds since the discovery run started — gives the user a
  // visible heartbeat while the agent is busy. Without this the modal looks
  // hung whenever batch discovery takes more than a few seconds.
  const [elapsedSec, setElapsedSec] = useState(0);
  const logsEndRef = useRef<HTMLDivElement>(null);
  // Run generation. Bumped when a run starts and whenever the modal is
  // dismissed or unmounted, so a batch request that completes after the user
  // walked away (or started over) is ignored instead of logging into — and
  // publishing results from — a run nobody is watching anymore.
  const runGenerationRef = useRef(0);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Tick elapsed-time counter while the modal is actively working.
  useEffect(() => {
    if (phase !== 'discovering' && phase !== 'analyzing') return;
    const id = setInterval(() => setElapsedSec(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Fetch discovery capabilities (informational — failures are silent).
  useEffect(() => {
    let cancelled = false;
    getDiscoveryCapabilities()
      .then(caps => { if (!cancelled) setCapabilities(caps); })
      .catch(() => { if (!cancelled) setCapabilities(null); });
    return () => { cancelled = true; };
  }, []);

  // Unmounting (the parent closed the modal) abandons any run in flight.
  useEffect(() => {
    const generation = runGenerationRef;
    return () => { generation.current += 1; };
  }, []);

  // Closing abandons any run in flight: its completion is discarded and
  // onDiscoveryComplete never fires for it. (The batch API takes no abort
  // signal, so the agent may finish querying devices it already contacted.)
  const handleClose = () => {
    runGenerationRef.current += 1;
    onClose();
  };

  const startDiscovery = async () => {
    const generation = ++runGenerationRef.current;
    const isCurrent = () => runGenerationRef.current === generation;
    const addLog = (entry: Omit<DiscoveryLogEntry, 'timestamp'>) => {
      if (!isCurrent()) return;
      setLogs(prev => [...prev, { ...entry, timestamp: new Date() }]);
    };

    setPhase('discovering');
    setProgress(0);
    setElapsedSec(0);
    addLog({ level: 'info', message: `Starting batch discovery for "${groupName}"` });
    addLog({ level: 'info', message: `Sending ${devices.length} target(s) to discovery API (timeout: 5 min)` });

    try {
      // Build batch request from devices
      // Send both standalone (snmpProfileId) and enterprise (snmpCredentialId) field names.
      // Agent ignores unknown fields; controller accepts both via serde aliases.
      const request: BatchDiscoveryRequest = {
        targets: devices.map(d => ({
          ip: d.ip || '',
          sessionId: d.sessionId,
          // Standalone mode: profile IDs for local agent credential resolution
          snmpProfileId: d.snmpProfileId,
          credentialProfileId: d.profileId,
          // Enterprise mode: separate SNMP + SSH credential UUIDs for controller vault
          snmpCredentialId: d.snmpCredentialId || d.snmpProfileId,
          sshCredentialId: d.credentialId || d.profileId,
          cliFlavor: d.cliFlavor,
        })),
      };

      setProgress(30);

      // Call the batch discovery API
      const apiResults = await runBatchDiscovery(request);
      // Dismissed or restarted while the request was in flight.
      if (!isCurrent()) return;

      setProgress(70);

      // Map API results back to DiscoveryResult by matching IPs to devices
      const discoveryResults: DiscoveryResult[] = apiResults.map(r => {
        const device = devices.find(d => d.ip === r.ip);
        return {
          device: device?.name || r.sysName || r.ip,
          ip: r.ip,
          tabId: device?.tabId || '',
          profileId: device?.profileId,
          snmpProfileId: device?.snmpProfileId,
          sysName: r.sysName,
          sysDescr: r.sysDescr,
          neighbors: r.neighbors,
          discoveryMethod: r.discoveryMethod,
          nmap: r.nmap,
          error: r.error,
        };
      });

      // Log per-target results
      for (const result of discoveryResults) {
        if (result.error) {
          addLog({
            level: 'error',
            device: result.device,
            message: `Error: ${result.error}`
          });
        } else if (result.neighbors.length > 0) {
          addLog({
            level: 'success',
            device: result.device,
            message: `Found ${result.neighbors.length} neighbor(s) via ${result.discoveryMethod}`
          });
        } else {
          addLog({
            level: 'warning',
            device: result.device,
            message: `No neighbors found (method: ${result.discoveryMethod})`
          });
        }
      }

      setPhase('analyzing');
      setProgress(85);
      addLog({ level: 'info', message: 'Analyzing discovered connections...' });

      // Find connections between devices in the group
      const deviceNames = new Set(devices.map(d => d.name.toLowerCase()));
      const connections: { source: string; target: string; sourceInterface: string; targetInterface?: string }[] = [];

      for (const result of discoveryResults) {
        for (const neighbor of result.neighbors) {
          // Check if this neighbor is also in our device list
          if (deviceNames.has(neighbor.neighborName.toLowerCase())) {
            // Check if we already have this connection (in either direction)
            const exists = connections.some(c =>
              (c.source.toLowerCase() === result.device.toLowerCase() && c.target.toLowerCase() === neighbor.neighborName.toLowerCase()) ||
              (c.source.toLowerCase() === neighbor.neighborName.toLowerCase() && c.target.toLowerCase() === result.device.toLowerCase())
            );

            if (!exists) {
              connections.push({
                source: result.device,
                target: neighbor.neighborName,
                sourceInterface: neighbor.localInterface,
                targetInterface: neighbor.neighborInterface || undefined,
              });
              addLog({
                level: 'success',
                message: `Connection: ${result.device} (${neighbor.localInterface}) <-> ${neighbor.neighborName}${neighbor.neighborInterface ? ` (${neighbor.neighborInterface})` : ''}`
              });
            }
          }
        }
      }

      if (connections.length === 0) {
        addLog({ level: 'warning', message: 'No connections found between devices in this group' });

        // List neighbors that are NOT in the group
        const externalNeighbors = new Set<string>();
        for (const result of discoveryResults) {
          for (const neighbor of result.neighbors) {
            if (!deviceNames.has(neighbor.neighborName.toLowerCase())) {
              externalNeighbors.add(neighbor.neighborName);
            }
          }
        }
        if (externalNeighbors.size > 0) {
          addLog({
            level: 'info',
            message: `Neighbors outside group: ${[...externalNeighbors].join(', ')}`
          });
        }
      } else {
        addLog({ level: 'success', message: `Found ${connections.length} connection(s) between group devices` });
      }

      setProgress(100);
      setPhase('complete');
      addLog({ level: 'info', message: 'Discovery complete!' });

      // Notify parent with results
      onDiscoveryComplete(discoveryResults);

    } catch (err) {
      if (!isCurrent()) return;
      setPhase('error');
      addLog({
        level: 'error',
        message: `Batch discovery failed: ${getErrorMessage(err)}`
      });
    }
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const isRunning = phase === 'discovering' || phase === 'analyzing';

  return (
    <ModalFrame id="discovery" onDismiss={handleClose} className="discovery-modal" testId="discovery-modal" label="Topology Discovery">
      <div className="discovery-modal-header">
        <h2>Topology Discovery</h2>
        <span className="discovery-modal-group">{groupName}</span>
        {capabilities && (
          <span
            className="discovery-modal-capabilities"
            style={{
              fontSize: '11px',
              marginLeft: '12px',
              color: capabilities.nmapAvailable ? '#4caf50' : '#888',
            }}
          >
            nmap: {capabilities.nmapAvailable
              ? capabilities.nmapSudo
                ? 'available (with OS detection)'
                : 'available'
              : 'not available'}
          </span>
        )}
        <span className="discovery-modal-header-actions">
          <AskAiHelp
            topic="topology discovery"
            prompt={`Explain how NetStacks topology discovery works and help me get a good result for group "${groupName}" (${devices.length} device(s): ${devices.map(d => d.name).join(', ')}). nmap is ${capabilities ? (capabilities.nmapAvailable ? (capabilities.nmapSudo ? 'available with OS detection' : 'available') : 'not available') : 'unknown'}. Cover what is collected (LLDP/CDP neighbors over SSH, SNMP, nmap), which credentials and SNMP profiles are used, and what to check when a device returns no neighbors.`}
          />
          <button className="ns-btn ns-btn--ghost ns-icon-btn" onClick={handleClose} aria-label={isRunning ? 'Cancel discovery and close' : 'Close'}>x</button>
        </span>
      </div>

      <div className="discovery-modal-content">
        {/* Progress bar */}
        {phase !== 'idle' && (
          <div className="discovery-progress">
            <div className="discovery-progress-bar">
              <div
                className={`discovery-progress-fill ${phase === 'complete' ? 'complete' : ''}`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="discovery-progress-text">
              {phase === 'discovering' && `Running batch discovery... ${progress}% (${elapsedSec}s elapsed${elapsedSec >= 30 ? ' — large groups can take several minutes' : ''})`}
              {phase === 'analyzing' && `Analyzing connections... (${elapsedSec}s elapsed)`}
              {phase === 'complete' && `Complete (${elapsedSec}s)`}
              {phase === 'error' && `Error (${elapsedSec}s)`}
            </span>
          </div>
        )}

        {/* Logs */}
        <div className="discovery-logs">
          {logs.map((log, i) => (
            <div key={i} className={`discovery-log-entry ${log.level}`}>
              <span className="discovery-log-time">{formatTime(log.timestamp)}</span>
              <span className={`discovery-log-level ${log.level}`}>
                {log.level === 'info' && 'INFO'}
                {log.level === 'success' && 'OK'}
                {log.level === 'warning' && 'WARN'}
                {log.level === 'error' && 'ERR'}
              </span>
              {log.device && <span className="discovery-log-device">[{log.device}]</span>}
              <span className="discovery-log-message">{log.message}</span>
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>

      <div className="discovery-modal-footer">
        {phase === 'idle' && (
          <>
            <div className="discovery-device-list">
              <strong>Devices to scan:</strong> {devices.map(d => d.name).join(', ')}
            </div>
            <DialogFooter primary={{ label: 'Start Discovery', onClick: startDiscovery }} onCancel={handleClose} inline />
          </>
        )}

        {isRunning && (
          <div className="discovery-modal-actions">
            <span className="form-hint">Closing cancels this run; its results are discarded.</span>
            <button className="ns-btn" onClick={handleClose}>Cancel Discovery</button>
          </div>
        )}

        {phase === 'complete' && (
          <DialogFooter primary={{ label: 'View Topology', onClick: handleClose }} onCancel={handleClose} cancelLabel="Close" inline />
        )}

        {phase === 'error' && (
          <DialogFooter primary={{ label: 'Retry', onClick: startDiscovery }} onCancel={handleClose} cancelLabel="Close" inline />
        )}
      </div>
    </ModalFrame>
  );
}
