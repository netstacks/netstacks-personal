import { getErrorMessage } from '../api/errors'
/**
 * DeviceDetailTab - Full-page device detail view for tab display
 *
 * Shows comprehensive device information including system info, resources,
 * interfaces in a scrollable tab layout. Used when opening device details
 * in a dedicated tab rather than a floating card.
 */

import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from 'react';
import type { Device, DeviceType } from '../types/topology';
import type { DeviceEnrichment, InterfaceEnrichment } from '../types/enrichment';
import { listHistory, listSessions, type ConnectionHistory, type Session } from '../api/sessions';
import { listProfiles, type CredentialProfile } from '../api/profiles';
import { listChanges } from '../api/changes';
import type { Change, ChangeStatus } from '../types/change';
import { changeStatusLabels } from '../types/change';
import {
  formatUptime,
  formatBytes,
  formatPackets,
  getResourceLevel,
  getResourceLevelColor,
  getStatusColor,
  formatRelativeTime,
} from '../lib/enrichmentHelpers';
import { snmpTryInterfaceStats, snmpTryCommunities, snmpGet, snmpWalk, type SnmpInterfaceStatsResponse } from '../api/snmp';
import { parseSysDescr } from '../lib/sysDescrParser';
import { useEnrichment } from '../hooks/useEnrichment';
import { getCurrentMode } from '../api/client';
import { formatRate } from '../utils/formatRate';
import { saveEnrichmentToDoc } from '../lib/enrichmentExport';
import { formatDuration } from '../lib/formatters';
import { sendChatMessage, AiNotConfiguredError, type ChatMessage } from '../api/ai';
import { resolveProvider } from '../lib/aiProviderResolver';
import { listNetBoxSources, getNetBoxSourceConnection } from '../api/netboxSources';
import { fetchDeviceByName, type NetBoxDevice } from '../api/netbox';
import './DeviceDetailTab.css';

/** SNMP-polled resource data */
interface SnmpResources {
  cpuPercent?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  memoryPercent?: number;
  temperatureCelsius?: number;
}

interface DeviceDetailTabProps {
  /** Device name to display */
  deviceName: string;
  /** Device data (if available) */
  device?: Device;
  /** Device enrichment data */
  enrichment?: DeviceEnrichment;
  /** Interface enrichment data */
  interfaces?: InterfaceEnrichment[];
  /** Session ID for history/change filtering */
  sessionId?: string;
  /** Device management IP for SNMP polling */
  host?: string;
  /** Profile ID for SNMP community resolution */
  profileId?: string;
  /** Optional jump for SNMP queries — set when the device sits behind a
   *  bastion. Mutually exclusive (one or neither). The agent runs net-snmp
   *  CLI tools on the jump instead of going direct over UDP. */
  jumpHostId?: string | null;
  jumpSessionId?: string | null;
  /** Enterprise mode device UUID */
  deviceId?: string;
  /** Open terminal handler */
  onOpenTerminal?: () => void;
}

// Icons
const Icons = {
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  ),
  save: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  ),
  terminal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  chevronDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  chevronRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  server: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  ),
  cpu: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  ),
  network: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="5" y="2" width="14" height="6" rx="2" />
      <rect x="5" y="16" width="14" height="6" rx="2" />
      <path d="M12 8v8" />
      <path d="M8 22v-3" />
      <path d="M16 22v-3" />
    </svg>
  ),
  code: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  filter: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  ),
  clock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  thermometer: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 14.76V3.5a2.5 2.5 0 00-5 0v11.26a4.5 4.5 0 105 0z" />
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  fileEdit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  ),
};

/** Device type icons for the stencil visualization */
const DEVICE_TYPE_ICONS: Record<DeviceType, ReactNode> = {
  router: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="6" cy="12" r="1.5" fill="currentColor" />
      <circle cx="10" cy="12" r="1.5" fill="currentColor" />
      <path d="M15 9v6M18 9v6" />
    </svg>
  ),
  switch: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="8" width="20" height="8" rx="1" />
      <circle cx="6" cy="12" r="1" fill="currentColor" />
      <circle cx="9" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="15" cy="12" r="1" fill="currentColor" />
      <circle cx="18" cy="12" r="1" fill="currentColor" />
    </svg>
  ),
  firewall: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </svg>
  ),
  server: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="2" width="16" height="6" rx="1" />
      <rect x="4" y="9" width="16" height="6" rx="1" />
      <rect x="4" y="16" width="16" height="6" rx="1" />
      <circle cx="7" cy="5" r="1" fill="currentColor" />
      <circle cx="7" cy="12" r="1" fill="currentColor" />
      <circle cx="7" cy="19" r="1" fill="currentColor" />
    </svg>
  ),
  cloud: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  ),
  'access-point': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" />
    </svg>
  ),
  'load-balancer': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <path d="M7 6v4M12 6v4M17 6v4M7 14v4M12 14v4M17 14v4" />
    </svg>
  ),
  'wan-optimizer': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
      <path d="M17 12h3M4 12h3" />
    </svg>
  ),
  'voice-gateway': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  ),
  'wireless-controller': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="14" width="16" height="6" rx="1" />
      <circle cx="8" cy="17" r="1" fill="currentColor" />
      <path d="M12 2v6M8 5l4 3 4-3M6 8l6 4 6-4" />
    </svg>
  ),
  storage: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  virtual: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="6" y="6" width="12" height="12" rx="1" />
      <rect x="3" y="3" width="12" height="12" rx="1" />
      <rect x="9" y="9" width="12" height="12" rx="1" />
    </svg>
  ),
  'sd-wan': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
      <path d="M8 16h8M10 13h4" />
    </svg>
  ),
  iot: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <circle cx="9" cy="9" r="1" fill="currentColor" />
      <circle cx="15" cy="9" r="1" fill="currentColor" />
      <circle cx="9" cy="15" r="1" fill="currentColor" />
      <circle cx="15" cy="15" r="1" fill="currentColor" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </svg>
  ),
  unknown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
    </svg>
  ),
};

/** Device type color mapping */
const DEVICE_TYPE_COLORS: Record<string, string> = {
  router: '#2196f3',
  switch: '#4caf50',
  firewall: '#f44336',
  server: '#9e9e9e',
  cloud: '#ffffff',
  'access-point': '#00bcd4',
  'load-balancer': '#00bcd4',
  'wan-optimizer': '#9c27b0',
  'voice-gateway': '#607d8b',
  'wireless-controller': '#3f51b5',
  storage: '#795548',
  virtual: '#009688',
  'sd-wan': '#8bc34a',
  iot: '#ff5722',
  unknown: '#607d8b',
};

// SNMP polling state machine
type PollState = 'idle' | 'sample1' | 'waiting' | 'sample2' | 'complete' | 'error';

// Counter wrap threshold for 32-bit counters
const COUNTER_32_MAX = 2 ** 32;

/** Calculate the delta between two counter values, handling 32-bit counter wrap. */
function counterDelta(current: number, previous: number, hcCounters: boolean): number {
  const delta = current - previous;
  if (delta >= 0) return delta;
  if (!hcCounters) return delta + COUNTER_32_MAX;
  return 0;
}

/** Per-interface live rate data */
interface LiveRate {
  inBps: number;
  outBps: number;
}

type SortField = 'name' | 'status' | 'speed' | 'mtu' | 'rxPackets' | 'txPackets' | 'errors';
type SortDirection = 'asc' | 'desc';


/** Get temperature severity level */
function getTemperatureLevel(temp: number): 'low' | 'medium' | 'high' | 'critical' {
  if (temp <= 45) return 'low';
  if (temp <= 65) return 'medium';
  if (temp <= 80) return 'high';
  return 'critical';
}

/** Get human-readable temperature label */
function getTemperatureLabel(temp: number): string {
  if (temp <= 45) return 'Normal';
  if (temp <= 65) return 'Warm';
  if (temp <= 80) return 'Hot';
  return 'Critical';
}

export default function DeviceDetailTab({
  deviceName,
  device,
  enrichment,
  interfaces,
  sessionId,
  host,
  profileId,
  jumpHostId,
  jumpSessionId,
  deviceId,
  onOpenTerminal,
}: DeviceDetailTabProps) {
  const isEnterprise = getCurrentMode() === 'enterprise';
  // Interface table state
  const [interfaceFilter, setInterfaceFilter] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [expandedInterface, setExpandedInterface] = useState<string | null>(null);
  const [deviceViewExpanded, setDeviceViewExpanded] = useState(false);
  const [deviceViewSearch, setDeviceViewSearch] = useState('');
  const [rawOutputExpanded, setRawOutputExpanded] = useState(false);
  const [sessionHistoryExpanded, setSessionHistoryExpanded] = useState(false);
  const [sessionHistory, setSessionHistory] = useState<ConnectionHistory[]>([]);
  const [changeHistoryExpanded, setChangeHistoryExpanded] = useState(false);
  const [changeHistory, setChangeHistory] = useState<Change[]>([]);
  const [hostSessionIds, setHostSessionIds] = useState<string[]>([]);

  // Discover all sessions matching this device's host and fetch connection history
  useEffect(() => {
    if (!host && !sessionId) return;

    // Fetch saved sessions, connection history, and credential profiles in
    // parallel. Profiles are joined to synthetic history rows so the
    // "Username" column shows the SSH user, not the session display name.
    const sessionsPromise = listSessions().catch(() => [] as Session[]);
    const historyPromise = listHistory().catch(() => [] as ConnectionHistory[]);
    const profilesPromise = listProfiles().catch(() => [] as CredentialProfile[]);

    Promise.all([sessionsPromise, historyPromise, profilesPromise]).then(([sessions, historyEntries, profiles]) => {
      const profileById = new Map(profiles.map((p) => [p.id, p]));
      // Find sessions matching this host
      const matching = sessions.filter(
        (s) => (host && s.host === host) || (sessionId && s.id === sessionId)
      );
      const matchingIds = matching.map((s) => s.id);
      if (sessionId && !matchingIds.includes(sessionId)) {
        matchingIds.push(sessionId);
      }

      setHostSessionIds(matchingIds);

      // Build unified session history from both sources
      const sidSet = new Set(matchingIds);

      // Connection history entries that match
      const connEntries: ConnectionHistory[] = historyEntries.filter(
        (entry) =>
          (host && entry.host === host) ||
          (entry.session_id && sidSet.has(entry.session_id))
      );

      // Also create synthetic history entries from saved sessions that have last_connected_at
      // (these represent sessions the user has connected to that may not have connection_history records)
      const connIds = new Set(connEntries.map((e) => e.session_id).filter(Boolean));
      for (const sess of matching) {
        if (sess.last_connected_at && !connIds.has(sess.id)) {
          const profile = profileById.get(sess.profile_id);
          connEntries.push({
            id: `session-${sess.id}`,
            session_id: sess.id,
            host: sess.host,
            port: sess.port,
            username: profile?.username ?? sess.name,
            connected_at: sess.last_connected_at,
            disconnected_at: null,
            duration_seconds: null,
          });
        }
      }

      connEntries.sort(
        (a, b) => new Date(b.connected_at).getTime() - new Date(a.connected_at).getTime()
      );
      setSessionHistory(connEntries.slice(0, 10));
    });
  }, [host, sessionId]);

  // Fetch change history - aggregate from all discovered session IDs
  useEffect(() => {
    if (hostSessionIds.length === 0) return;
    Promise.allSettled(hostSessionIds.map((sid) => listChanges(sid)))
      .then((results) => {
        const allChanges: Change[] = [];
        const seenIds = new Set<string>();
        for (const result of results) {
          if (result.status === 'fulfilled') {
            for (const change of result.value) {
              if (!seenIds.has(change.id)) {
                seenIds.add(change.id);
                allChanges.push(change);
              }
            }
          }
        }
        allChanges.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        setChangeHistory(allChanges.slice(0, 20));
      })
      .catch((err) => {
        console.error('Failed to load change history:', err);
      });
  }, [hostSessionIds]);

  // SNMP polling state
  const [pollState, setPollState] = useState<PollState>('idle');
  const [pollError, setPollError] = useState<string | null>(null);
  const [liveRates, setLiveRates] = useState<Map<string, LiveRate>>(new Map());
  const [countdown, setCountdown] = useState(0);
  const cancelledRef = useRef(false);
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [discoveredInterfaces, setDiscoveredInterfaces] = useState<string[]>([]);
  const [cachedCommunity, setCachedCommunity] = useState<string | null>(null);
  const [snmpSystemInfo, setSnmpSystemInfo] = useState<Record<string, string>>({});
  // Pull setDeviceEnrichment so a successful SNMP poll can hot-fill the
  // EnrichmentContext cache. The runtime SNMP-host resolver in App.tsx
  // depends on this to override stale CDP loopback IPs without requiring
  // the user to re-run discovery.
  const { setDeviceEnrichment } = useEnrichment();
  const [snmpInterfaceData, setSnmpInterfaceData] = useState<Map<string, SnmpInterfaceStatsResponse>>(new Map());
  const [lastPollTime, setLastPollTime] = useState<Date | null>(null);
  const [snmpSortField, setSnmpSortField] = useState<'name' | 'status' | 'speed' | 'inRate' | 'outRate' | 'errors' | 'discards'>('name');
  const [snmpSortDir, setSnmpSortDir] = useState<'asc' | 'desc'>('asc');
  const [snmpResources, setSnmpResources] = useState<SnmpResources>({});

  // NetBox link state
  const [netboxUrl, setNetboxUrl] = useState<string | null>(null);
  const [netboxDevice, setNetboxDevice] = useState<NetBoxDevice | null>(null);

  // Save-to-docs dialog state
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'ai-generating'>('idle');
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const saveDialogRef = useRef<HTMLDivElement>(null);

  // Fetch NetBox device data by hostname (uses deviceName prop)
  useEffect(() => {
    if (!deviceName) return;
    let cancelled = false;
    listNetBoxSources()
      .then(async (sources) => {
        if (cancelled || sources.length === 0) return;
        const source = sources[0];
        const conn = await getNetBoxSourceConnection(source.id);
        if (cancelled || !conn) return;
        const url = conn.base_url.replace(/\/+$/, '');
        setNetboxUrl(url);
        const nbDevice = await fetchDeviceByName({ url: conn.base_url, token: conn.token }, deviceName);
        if (cancelled) return;
        if (nbDevice) setNetboxDevice(nbDevice);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [deviceName]);

  // SNMP can poll if we have host and profile (or deviceId in enterprise mode) — interfaces can be discovered on demand
  const canPoll = isEnterprise ? Boolean(deviceId) : Boolean(host && profileId);

  // Handle SNMP refresh with two-sample rate calculation
  const handleRefresh = useCallback(async () => {
    if (isEnterprise ? !deviceId : (!host || !profileId)) return;

    // Cancel any previous polling
    cancelledRef.current = true;
    if (staleTimerRef.current) { clearTimeout(staleTimerRef.current); staleTimerRef.current = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }

    // Small delay to allow cancellation to propagate, then start fresh
    await new Promise(r => setTimeout(r, 50));
    cancelledRef.current = false;
    setPollError(null);
    setLiveRates(new Map());

    try {
      // Resolve community string (use cached or discover)
      setPollState('sample1');
      let community = cachedCommunity;
      if (!community) {
        const tryResult = await snmpTryCommunities(isEnterprise ? { deviceId } : { host, profileId, jump_host_id: jumpHostId, jump_session_id: jumpSessionId });
        if (cancelledRef.current) return;
        community = tryResult.community;
        setCachedCommunity(community);
      }

      // Fetch System MIB data
      const systemOids = [
        '1.3.6.1.2.1.1.1.0',  // sysDescr
        '1.3.6.1.2.1.1.2.0',  // sysObjectID
        '1.3.6.1.2.1.1.3.0',  // sysUpTime
        '1.3.6.1.2.1.1.4.0',  // sysContact
        '1.3.6.1.2.1.1.5.0',  // sysName — needed to seed EnrichmentContext
        '1.3.6.1.2.1.1.6.0',  // sysLocation
      ];
      try {
        const sysResult = await snmpGet(isEnterprise ? { deviceId, oids: systemOids } : { host, community, oids: systemOids, profileId, jump_host_id: jumpHostId, jump_session_id: jumpSessionId });
        if (cancelledRef.current) return;
        const sysInfo: Record<string, string> = {};
        const oidLabels: Record<string, string> = {
          '1.3.6.1.2.1.1.1.0': 'Description',
          '1.3.6.1.2.1.1.2.0': 'System OID',
          '1.3.6.1.2.1.1.3.0': 'SNMP Uptime',
          '1.3.6.1.2.1.1.4.0': 'Contact',
          '1.3.6.1.2.1.1.5.0': 'Hostname',
          '1.3.6.1.2.1.1.6.0': 'Location',
        };
        for (const entry of sysResult.values) {
          const label = oidLabels[entry.oid];
          if (!label) continue;
          const v = entry.value as { type?: string; value?: unknown } | string | number;
          let strVal: string;
          if (typeof v === 'object' && v !== null && 'value' in v) {
            strVal = String(v.value);
          } else {
            strVal = String(v);
          }
          // Format sysUpTime (hundredths of seconds) to human-readable
          if (entry.oid === '1.3.6.1.2.1.1.3.0') {
            const ticks = parseInt(strVal, 10);
            if (!isNaN(ticks)) {
              strVal = formatUptime(Math.floor(ticks / 100));
            }
          }
          if (strVal && strVal !== '' && strVal !== '0') {
            sysInfo[label] = strVal;
          }
        }
        setSnmpSystemInfo(sysInfo);

        // Seed EnrichmentContext so the session-IP-authoritative resolver
        // in App.tsx can match this device's hostname against neighbor
        // CDP refs from any other tab. Keyed by the database session UUID
        // (sessionId prop) so chipSessionsById.get() in the resolver works.
        if (sessionId) {
          const parsed = parseSysDescr(sysInfo['Description']);
          setDeviceEnrichment(sessionId, {
            sessionId,
            collectedAt: new Date().toISOString(),
            hostname: sysInfo['Hostname'] || undefined,
            vendor: parsed.vendor,
            model: parsed.model,
            osVersion: parsed.osVersion,
          });
        }
      } catch {
        // System MIB fetch is best-effort; don't block interface polling
      }

      // Poll resource OIDs (best-effort, multi-vendor)
      // Supports: Cisco IOS/IOS-XR, Juniper JunOS, Arista EOS
      // Falls through vendor-specific MIBs then tries standard HOST-RESOURCES-MIB
      if (cancelledRef.current) return;
      try {
        const resources: SnmpResources = {};
        const snmpReq = (rootOid: string) =>
          snmpWalk(isEnterprise ? { deviceId, rootOid } : { host, community, rootOid, profileId, jump_host_id: jumpHostId, jump_session_id: jumpSessionId });
        const extractNum = (v: unknown): number => {
          if (typeof v === 'object' && v !== null && 'value' in v) return Number((v as { value: unknown }).value);
          return Number(v);
        };

        // --- CPU ---
        // Try Cisco PROCESS-MIB (cpmCPUTotal5minRev) - works on IOS, IOS-XR, NX-OS
        try {
          const cpuWalk = await snmpReq('1.3.6.1.4.1.9.9.109.1.1.1.1.8');
          if (cpuWalk.entries.length > 0) {
            const cpuVal = extractNum(cpuWalk.entries[0].value);
            if (!isNaN(cpuVal) && cpuVal >= 0 && cpuVal <= 100) resources.cpuPercent = cpuVal;
          }
        } catch { /* OID not supported by this device — try next vendor probe */ }
        // Try Juniper JunOS (jnxOperatingCPU - 5min avg)
        if (resources.cpuPercent === undefined) {
          try {
            const cpuWalk = await snmpReq('1.3.6.1.4.1.2636.3.1.13.1.8');
            if (cpuWalk.entries.length > 0) {
              // Use the Routing Engine entry (highest-level component)
              const cpuVal = extractNum(cpuWalk.entries[0].value);
              if (!isNaN(cpuVal) && cpuVal >= 0 && cpuVal <= 100) resources.cpuPercent = cpuVal;
            }
          } catch { /* OID not supported by this device — try next vendor probe */ }
        }
        // Try Arista EOS (uses HOST-RESOURCES-MIB hrProcessorLoad)
        if (resources.cpuPercent === undefined) {
          try {
            const cpuWalk = await snmpReq('1.3.6.1.2.1.25.3.3.1.2');
            if (cpuWalk.entries.length > 0) {
              let total = 0, count = 0;
              for (const e of cpuWalk.entries) {
                const v = extractNum(e.value);
                if (!isNaN(v) && v >= 0 && v <= 100) { total += v; count++; }
              }
              if (count > 0) resources.cpuPercent = total / count;
            }
          } catch { /* OID not supported by this device — try next vendor probe */ }
        }

        // --- Memory ---
        // Try Cisco MEMORY-POOL-MIB (used + free) - works on IOS, NX-OS
        try {
          const [usedWalk, freeWalk] = await Promise.all([
            snmpReq('1.3.6.1.4.1.9.9.48.1.1.1.5'),
            snmpReq('1.3.6.1.4.1.9.9.48.1.1.1.6'),
          ]);
          if (usedWalk.entries.length > 0 && freeWalk.entries.length > 0) {
            let totalUsed = 0, totalFree = 0;
            for (const e of usedWalk.entries) { const v = extractNum(e.value); if (!isNaN(v)) totalUsed += v; }
            for (const e of freeWalk.entries) { const v = extractNum(e.value); if (!isNaN(v)) totalFree += v; }
            const totalMem = totalUsed + totalFree;
            if (totalMem > 0) {
              resources.memoryUsedBytes = totalUsed;
              resources.memoryTotalBytes = totalMem;
              resources.memoryPercent = (totalUsed / totalMem) * 100;
            }
          }
        } catch { /* OID not supported by this device — try next vendor probe */ }
        // Try Cisco IOS-XR MEMORY-POOL (cempMemPoolHCUsed/cempMemPoolHCFree)
        if (resources.memoryPercent === undefined) {
          try {
            const [usedWalk, freeWalk] = await Promise.all([
              snmpReq('1.3.6.1.4.1.9.9.221.1.1.1.1.18'),
              snmpReq('1.3.6.1.4.1.9.9.221.1.1.1.1.20'),
            ]);
            if (usedWalk.entries.length > 0 && freeWalk.entries.length > 0) {
              let totalUsed = 0, totalFree = 0;
              for (const e of usedWalk.entries) { const v = extractNum(e.value); if (!isNaN(v)) totalUsed += v; }
              for (const e of freeWalk.entries) { const v = extractNum(e.value); if (!isNaN(v)) totalFree += v; }
              const totalMem = totalUsed + totalFree;
              if (totalMem > 0) {
                resources.memoryUsedBytes = totalUsed;
                resources.memoryTotalBytes = totalMem;
                resources.memoryPercent = (totalUsed / totalMem) * 100;
              }
            }
          } catch { /* OID not supported by this device — try next vendor probe */ }
        }
        // Try Juniper JunOS (jnxOperatingBuffer - memory utilization %)
        if (resources.memoryPercent === undefined) {
          try {
            const memWalk = await snmpReq('1.3.6.1.4.1.2636.3.1.13.1.11');
            if (memWalk.entries.length > 0) {
              const memVal = extractNum(memWalk.entries[0].value);
              if (!isNaN(memVal) && memVal >= 0 && memVal <= 100) resources.memoryPercent = memVal;
            }
          } catch { /* OID not supported by this device — try next vendor probe */ }
        }
        // Try HOST-RESOURCES-MIB hrStorageTable (Arista, Linux, generic)
        if (resources.memoryPercent === undefined) {
          try {
            const [descrWalk, sizeWalk, usedWalk, unitWalk] = await Promise.all([
              snmpReq('1.3.6.1.2.1.25.2.3.1.3'), // hrStorageDescr
              snmpReq('1.3.6.1.2.1.25.2.3.1.5'), // hrStorageSize
              snmpReq('1.3.6.1.2.1.25.2.3.1.6'), // hrStorageUsed
              snmpReq('1.3.6.1.2.1.25.2.3.1.4'), // hrStorageAllocationUnits
            ]);
            // Find RAM entry by description
            for (let i = 0; i < descrWalk.entries.length; i++) {
              const descr = String(typeof descrWalk.entries[i].value === 'object' && descrWalk.entries[i].value !== null && 'value' in (descrWalk.entries[i].value as Record<string, unknown>) ? (descrWalk.entries[i].value as { value: unknown }).value : descrWalk.entries[i].value).toLowerCase();
              if (descr.includes('ram') || descr.includes('memory') || descr.includes('physical')) {
                const units = i < unitWalk.entries.length ? extractNum(unitWalk.entries[i].value) : 1;
                const totalSize = i < sizeWalk.entries.length ? extractNum(sizeWalk.entries[i].value) * units : 0;
                const usedSize = i < usedWalk.entries.length ? extractNum(usedWalk.entries[i].value) * units : 0;
                if (totalSize > 0) {
                  resources.memoryUsedBytes = usedSize;
                  resources.memoryTotalBytes = totalSize;
                  resources.memoryPercent = (usedSize / totalSize) * 100;
                  break;
                }
              }
            }
          } catch { /* OID not supported by this device — try next vendor probe */ }
        }

        // --- Temperature ---
        // Try Cisco ENVMON-MIB (ciscoEnvMonTemperatureStatusValue) - IOS, IOS-XR
        try {
          const tempWalk = await snmpReq('1.3.6.1.4.1.9.9.13.1.3.1.3');
          if (tempWalk.entries.length > 0) {
            let maxTemp = -Infinity;
            for (const e of tempWalk.entries) {
              const v = extractNum(e.value);
              if (!isNaN(v) && v > 0 && v < 200 && v > maxTemp) maxTemp = v;
            }
            if (maxTemp > -Infinity) resources.temperatureCelsius = maxTemp;
          }
        } catch { /* OID not supported by this device — try next vendor probe */ }
        // Try Cisco ENTITY-SENSOR-MIB (entSensorValue where type=celsius) - IOS-XR
        if (resources.temperatureCelsius === undefined) {
          try {
            const tempWalk = await snmpReq('1.3.6.1.4.1.9.9.91.1.1.1.1.4');
            const typeWalk = await snmpReq('1.3.6.1.4.1.9.9.91.1.1.1.1.1');
            if (tempWalk.entries.length > 0) {
              let maxTemp = -Infinity;
              for (let i = 0; i < tempWalk.entries.length; i++) {
                // type 8 = celsius
                const sensorType = i < typeWalk.entries.length ? extractNum(typeWalk.entries[i].value) : 0;
                if (sensorType === 8) {
                  const v = extractNum(tempWalk.entries[i].value);
                  if (!isNaN(v) && v > 0 && v < 200 && v > maxTemp) maxTemp = v;
                }
              }
              if (maxTemp > -Infinity) resources.temperatureCelsius = maxTemp;
            }
          } catch { /* OID not supported by this device — try next vendor probe */ }
        }
        // Try Juniper JunOS (jnxOperatingTemp)
        if (resources.temperatureCelsius === undefined) {
          try {
            const tempWalk = await snmpReq('1.3.6.1.4.1.2636.3.1.13.1.7');
            if (tempWalk.entries.length > 0) {
              let maxTemp = -Infinity;
              for (const e of tempWalk.entries) {
                const v = extractNum(e.value);
                if (!isNaN(v) && v > 0 && v < 200 && v > maxTemp) maxTemp = v;
              }
              if (maxTemp > -Infinity) resources.temperatureCelsius = maxTemp;
            }
          } catch { /* OID not supported by this device — try next vendor probe */ }
        }
        // Try ENTITY-MIB + ENTITY-SENSOR-MIB (Arista EOS, standard)
        if (resources.temperatureCelsius === undefined) {
          try {
            const tempWalk = await snmpReq('1.3.6.1.2.1.99.1.1.1.4');
            const typeWalk = await snmpReq('1.3.6.1.2.1.99.1.1.1.1');
            if (tempWalk.entries.length > 0) {
              let maxTemp = -Infinity;
              for (let i = 0; i < tempWalk.entries.length; i++) {
                // type 8 = celsius in ENTITY-SENSOR-MIB
                const sensorType = i < typeWalk.entries.length ? extractNum(typeWalk.entries[i].value) : 0;
                if (sensorType === 8) {
                  const v = extractNum(tempWalk.entries[i].value);
                  if (!isNaN(v) && v > 0 && v < 200 && v > maxTemp) maxTemp = v;
                }
              }
              if (maxTemp > -Infinity) resources.temperatureCelsius = maxTemp;
            }
          } catch { /* OID not supported by this device — try next vendor probe */ }
        }

        if (cancelledRef.current) return;
        setSnmpResources(resources);
      } catch {
        // Resource polling is best-effort
      }

      // Determine interface names to poll
      let ifaceNames: string[];
      if (interfaces && interfaces.length > 0) {
        ifaceNames = interfaces.map(iface => iface.name);
      } else if (discoveredInterfaces.length > 0) {
        ifaceNames = discoveredInterfaces;
      } else {
        // Discover interfaces via SNMP walk
        if (cancelledRef.current) return;
        const walkResult = await snmpWalk(isEnterprise ? { deviceId, rootOid: '1.3.6.1.2.1.2.2.1.2' } : { host, community, rootOid: '1.3.6.1.2.1.2.2.1.2', profileId, jump_host_id: jumpHostId, jump_session_id: jumpSessionId });
        if (cancelledRef.current) return;
        ifaceNames = walkResult.entries
          .map(e => {
            const v = e.value as { type?: string; value?: unknown } | string;
            if (typeof v === 'object' && v !== null && 'value' in v) return String(v.value);
            return String(v);
          })
          .filter(name => name && name !== '');
        if (ifaceNames.length === 0) {
          setPollError('No interfaces discovered via SNMP');
          setPollState('error');
          return;
        }
        setDiscoveredInterfaces(ifaceNames);
      }

      // Sample 1
      setPollState('sample1');
      const sample1Results = await Promise.allSettled(
        ifaceNames.map(name =>
          snmpTryInterfaceStats(isEnterprise ? { deviceId, interfaceName: name } : { host, profileId, interfaceName: name, jump_host_id: jumpHostId, jump_session_id: jumpSessionId })
        )
      );
      if (cancelledRef.current) return;

      const sample1Map = new Map<string, { stats: SnmpInterfaceStatsResponse; timestamp: number }>();
      const timestamp1 = Date.now();
      ifaceNames.forEach((name, i) => {
        const result = sample1Results[i];
        if (result.status === 'fulfilled') {
          sample1Map.set(name, { stats: result.value, timestamp: timestamp1 });
        }
      });

      if (sample1Map.size === 0) {
        setPollError('No interfaces responded to SNMP polling');
        setPollState('error');
        return;
      }

      // Wait 5 seconds
      setPollState('waiting');
      setCountdown(5);
      await new Promise<void>((resolve) => {
        let remaining = 5;
        countdownRef.current = setInterval(() => {
          remaining--;
          setCountdown(remaining);
          if (remaining <= 0) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            countdownRef.current = null;
            resolve();
          }
        }, 1000);
      });
      if (cancelledRef.current) return;

      // Sample 2
      setPollState('sample2');
      const namesToPoll = ifaceNames.filter(name => sample1Map.has(name));
      const sample2Results = await Promise.allSettled(
        namesToPoll.map(name =>
          snmpTryInterfaceStats(isEnterprise ? { deviceId, interfaceName: name } : { host, profileId, interfaceName: name, jump_host_id: jumpHostId, jump_session_id: jumpSessionId })
        )
      );
      if (cancelledRef.current) return;

      // Calculate rates
      const rates = new Map<string, LiveRate>();
      const timestamp2 = Date.now();
      namesToPoll.forEach((name, i) => {
        const result = sample2Results[i];
        const s1 = sample1Map.get(name);
        if (result.status === 'fulfilled' && s1) {
          const s2 = result.value;
          const durationSec = (timestamp2 - s1.timestamp) / 1000;
          if (durationSec > 0) {
            const inOctetsDelta = counterDelta(s2.inOctets, s1.stats.inOctets, s2.hcCounters);
            const outOctetsDelta = counterDelta(s2.outOctets, s1.stats.outOctets, s2.hcCounters);
            rates.set(name, {
              inBps: (inOctetsDelta / durationSec) * 8,
              outBps: (outOctetsDelta / durationSec) * 8,
            });
          }
        }
      });

      // Store full SNMP interface data from sample2
      const ifaceDataMap = new Map<string, SnmpInterfaceStatsResponse>();
      namesToPoll.forEach((name, i) => {
        const result = sample2Results[i];
        if (result.status === 'fulfilled') {
          ifaceDataMap.set(name, result.value);
        }
      });
      setSnmpInterfaceData(ifaceDataMap);

      setLiveRates(rates);
      setLastPollTime(new Date());
      setPollState('complete');

      // After 30 seconds, mark data as stale
      staleTimerRef.current = setTimeout(() => {
        setPollState('idle');
        staleTimerRef.current = null;
      }, 30000);
    } catch (err) {
      if (cancelledRef.current) return;
      setPollError(getErrorMessage(err, 'SNMP poll failed'));
      setPollState('error');
    }
  }, [host, profileId, deviceId, isEnterprise, interfaces, discoveredInterfaces, cachedCommunity]);

  // Auto-trigger SNMP poll on mount when we can poll but have no enrichment data
  useEffect(() => {
    if (canPoll && !enrichment && pollState === 'idle') {
      handleRefresh();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPoll]);

  // Last-resort fallbacks parsed from the locally-polled SNMP system info.
  // Only kicks in when neither the enrichment cache nor the persisted device
  // record has the field — i.e. when DeviceDetailTab is opened directly from
  // a session tab (no topology context, EnrichmentContext empty for this
  // session). The data is fetched live in the SNMP-poll effect above.
  const parsedDescr = useMemo(
    () => parseSysDescr(snmpSystemInfo?.['Description']),
    [snmpSystemInfo]
  );

  // Get display values
  const vendor = enrichment?.vendor || device?.vendor || parsedDescr.vendor || 'Unknown';
  const model = enrichment?.model || device?.model || device?.platform || parsedDescr.model || 'Unknown';
  const osVersion = enrichment?.osVersion || device?.version || parsedDescr.osVersion || 'Unknown';
  const serial = enrichment?.serialNumber || device?.serial || 'N/A';
  const hostname = enrichment?.hostname || device?.name || deviceName;
  const deviceType = device?.type || 'unknown';

  // Uptime — fall back to the SNMP sysUpTime string the poll already
  // formatted into snmpSystemInfo['SNMP Uptime'] (e.g. "7h 35m") so we don't
  // show "N/A" right next to a populated SNMP Uptime row.
  const getUptimeDisplay = (): string => {
    if (enrichment?.uptimeSeconds !== undefined) {
      return formatUptime(enrichment.uptimeSeconds);
    }
    if (enrichment?.uptimeFormatted) {
      return enrichment.uptimeFormatted;
    }
    if (device?.uptime) {
      return device.uptime;
    }
    if (snmpSystemInfo?.['SNMP Uptime']) {
      return snmpSystemInfo['SNMP Uptime'];
    }
    return 'N/A';
  };

  // Collection timestamp
  const collectedAt = enrichment?.collectedAt
    ? formatRelativeTime(new Date(enrichment.collectedAt))
    : 'Never';

  // Filtered and sorted interfaces
  const filteredInterfaces = useMemo(() => {
    if (!interfaces) return [];

    let filtered = interfaces;

    // Apply filter
    if (interfaceFilter) {
      const search = interfaceFilter.toLowerCase();
      filtered = filtered.filter(
        (iface) =>
          iface.name.toLowerCase().includes(search) ||
          iface.description?.toLowerCase().includes(search) ||
          iface.ipAddress?.toLowerCase().includes(search) ||
          iface.macAddress?.toLowerCase().includes(search)
      );
    }

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      let aVal: string | number = '';
      let bVal: string | number = '';

      switch (sortField) {
        case 'name':
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
          break;
        case 'status':
          aVal = a.status;
          bVal = b.status;
          break;
        case 'speed':
          aVal = a.speed || '';
          bVal = b.speed || '';
          break;
        case 'mtu':
          aVal = a.mtu || 0;
          bVal = b.mtu || 0;
          break;
        case 'rxPackets':
          aVal = a.rxPackets || 0;
          bVal = b.rxPackets || 0;
          break;
        case 'txPackets':
          aVal = a.txPackets || 0;
          bVal = b.txPackets || 0;
          break;
        case 'errors':
          aVal = (a.rxErrors || 0) + (a.txErrors || 0);
          bVal = (b.rxErrors || 0) + (b.txErrors || 0);
          break;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDirection === 'asc' ? Number(aVal) - Number(bVal) : Number(bVal) - Number(aVal);
    });

    return sorted;
  }, [interfaces, interfaceFilter, sortField, sortDirection]);

  // Handle sort click
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Render sort indicator
  const renderSortIndicator = (field: SortField) => {
    if (sortField !== field) return null;
    return (
      <span className="device-detail-tab-sort-indicator">
        {sortDirection === 'asc' ? '\u2191' : '\u2193'}
      </span>
    );
  };

  // Render utilization bar
  const renderUtilBar = (rateBps: number, speedMbps: number, label: string, className: string) => {
    if (speedMbps <= 0) return null;
    const pct = Math.min(100, (rateBps / (speedMbps * 1_000_000)) * 100);
    return (
      <div className="device-detail-tab-interface-detail">
        <span className="label">{label} Utilization</span>
        <div className="device-detail-tab-util-bar-container">
          <div className={`device-detail-tab-util-bar ${className}`} style={{ width: `${pct}%` }} />
          <span className="device-detail-tab-util-pct">{pct.toFixed(1)}%</span>
        </div>
      </div>
    );
  };

  // Render SVG ring gauge for resource dashboard
  const renderGauge = (percent: number, color: string, size: number = 72) => {
    const strokeWidth = 5;
    const radius = (size - strokeWidth * 2) / 2;
    const circumference = 2 * Math.PI * radius;
    const p = Math.min(100, Math.max(0, percent));
    const offset = circumference - (p / 100) * circumference;
    return (
      <svg width={size} height={size} className="device-detail-tab-gauge">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--bg-primary, #1a1a1a)" strokeWidth={strokeWidth} />
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color} strokeWidth={strokeWidth}
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
      </svg>
    );
  };

  // Render interface row (enrichment interfaces)
  const renderInterfaceRow = (iface: InterfaceEnrichment) => {
    const isExpanded = expandedInterface === iface.name;
    const hasErrors = (iface.rxErrors && iface.rxErrors > 0) || (iface.txErrors && iface.txErrors > 0);
    const snmpData = snmpInterfaceData.get(iface.name);
    const rate = liveRates.get(iface.name);

    return (
      <div key={iface.name} className="device-detail-tab-interface-item">
        <div
          className={`device-detail-tab-interface-row ${isExpanded ? 'expanded' : ''} ${liveRates.size > 0 ? 'has-live-rates' : ''}`}
          onClick={() => setExpandedInterface(isExpanded ? null : iface.name)}
        >
          <span className="device-detail-tab-interface-expand">
            {isExpanded ? Icons.chevronDown : Icons.chevronRight}
          </span>
          <span className="device-detail-tab-interface-name">{iface.name}</span>
          <span
            className="device-detail-tab-interface-status"
            style={{ backgroundColor: getStatusColor(iface.status) }}
          >
            {iface.status}
          </span>
          <span className="device-detail-tab-interface-speed">{iface.speed || '-'}</span>
          <span className="device-detail-tab-interface-mtu">{iface.mtu || '-'}</span>
          <span className="device-detail-tab-interface-ip">{iface.ipAddress || '-'}</span>
          <span className="device-detail-tab-interface-mac">{iface.macAddress || '-'}</span>
          <span className="device-detail-tab-interface-rx">{formatPackets(iface.rxPackets || 0)}</span>
          <span className="device-detail-tab-interface-tx">{formatPackets(iface.txPackets || 0)}</span>
          <span className={`device-detail-tab-interface-errors ${hasErrors ? 'has-errors' : ''}`}>
            {(iface.rxErrors || 0) + (iface.txErrors || 0)}
          </span>
          {liveRates.size > 0 && (
            <>
              <span className="device-detail-tab-interface-in-rate">
                {rate ? formatRate(rate.inBps) : '-'}
              </span>
              <span className="device-detail-tab-interface-out-rate">
                {rate ? formatRate(rate.outBps) : '-'}
              </span>
            </>
          )}
        </div>
        {isExpanded && (
          <div className="device-detail-tab-interface-details">
            <div className="device-detail-tab-interface-detail-grid">
              {iface.description && (
                <div className="device-detail-tab-interface-detail">
                  <span className="label">Description</span>
                  <span className="value">{iface.description}</span>
                </div>
              )}
              {snmpData && snmpData.ifAlias && (
                <div className="device-detail-tab-interface-detail">
                  <span className="label">SNMP Alias</span>
                  <span className="value">{snmpData.ifAlias}</span>
                </div>
              )}
              {iface.duplex && (
                <div className="device-detail-tab-interface-detail">
                  <span className="label">Duplex</span>
                  <span className="value">{iface.duplex}</span>
                </div>
              )}
              {iface.rxBytes !== undefined && (
                <div className="device-detail-tab-interface-detail">
                  <span className="label">RX Bytes</span>
                  <span className="value">{formatBytes(iface.rxBytes)}</span>
                </div>
              )}
              {iface.txBytes !== undefined && (
                <div className="device-detail-tab-interface-detail">
                  <span className="label">TX Bytes</span>
                  <span className="value">{formatBytes(iface.txBytes)}</span>
                </div>
              )}
              {iface.rxErrors !== undefined && (
                <div className="device-detail-tab-interface-detail">
                  <span className="label">RX Errors</span>
                  <span className={`value ${iface.rxErrors > 0 ? 'error' : ''}`}>{iface.rxErrors}</span>
                </div>
              )}
              {iface.txErrors !== undefined && (
                <div className="device-detail-tab-interface-detail">
                  <span className="label">TX Errors</span>
                  <span className={`value ${iface.txErrors > 0 ? 'error' : ''}`}>{iface.txErrors}</span>
                </div>
              )}
              {snmpData && (snmpData.inDiscards > 0 || snmpData.outDiscards > 0) && (
                <div className="device-detail-tab-interface-detail">
                  <span className="label">Discards (In/Out)</span>
                  <span className="value device-detail-tab-warning-text">
                    {snmpData.inDiscards} / {snmpData.outDiscards}
                  </span>
                </div>
              )}
              {rate && snmpData && snmpData.speedMbps > 0 && (
                <>
                  {renderUtilBar(rate.inBps, snmpData.speedMbps, 'In', 'util-in')}
                  {renderUtilBar(rate.outBps, snmpData.speedMbps, 'Out', 'util-out')}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  // Sorted SNMP-only interfaces
  const sortedSnmpInterfaces = useMemo(() => {
    if (!snmpInterfaceData.size) return [];
    const entries = Array.from(snmpInterfaceData.entries()).map(([name, data]) => ({
      name,
      data,
      rate: liveRates.get(name),
    }));

    entries.sort((a, b) => {
      let cmp = 0;
      switch (snmpSortField) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'status':
          cmp = a.data.operStatus - b.data.operStatus;
          break;
        case 'speed':
          cmp = a.data.speedMbps - b.data.speedMbps;
          break;
        case 'inRate':
          cmp = (a.rate?.inBps || 0) - (b.rate?.inBps || 0);
          break;
        case 'outRate':
          cmp = (a.rate?.outBps || 0) - (b.rate?.outBps || 0);
          break;
        case 'errors':
          cmp = (a.data.inErrors + a.data.outErrors) - (b.data.inErrors + b.data.outErrors);
          break;
        case 'discards':
          cmp = (a.data.inDiscards + a.data.outDiscards) - (b.data.inDiscards + b.data.outDiscards);
          break;
      }
      return snmpSortDir === 'asc' ? cmp : -cmp;
    });

    return entries;
  }, [snmpInterfaceData, liveRates, snmpSortField, snmpSortDir]);

  // SNMP interface summary counts
  const snmpIfaceSummary = useMemo(() => {
    let up = 0, down = 0;
    for (const data of snmpInterfaceData.values()) {
      if (data.operStatus === 1) up++;
      else down++;
    }
    return { up, down, total: snmpInterfaceData.size };
  }, [snmpInterfaceData]);

  // Interface health summary for dashboard
  const interfaceHealth = useMemo(() => {
    let up = 0, down = 0, total = 0;
    if (interfaces && interfaces.length > 0) {
      for (const iface of interfaces) {
        total++;
        if (iface.status === 'up') up++;
        else down++;
      }
    } else if (snmpInterfaceData.size > 0) {
      for (const data of snmpInterfaceData.values()) {
        total++;
        if (data.operStatus === 1) up++;
        else down++;
      }
    }
    return { up, down, total };
  }, [interfaces, snmpInterfaceData]);

  const handleSnmpSort = (field: typeof snmpSortField) => {
    if (snmpSortField === field) {
      setSnmpSortDir(snmpSortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSnmpSortField(field);
      setSnmpSortDir('asc');
    }
  };

  const renderSnmpSortIndicator = (field: typeof snmpSortField) => {
    if (snmpSortField !== field) return null;
    return <span className="device-detail-tab-sort-indicator">{snmpSortDir === 'asc' ? '\u2191' : '\u2193'}</span>;
  };

  // Close save dialog when clicking outside
  useEffect(() => {
    if (!saveDialogOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (saveDialogRef.current && !saveDialogRef.current.contains(e.target as Node)) {
        setSaveDialogOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [saveDialogOpen]);

  // Clear save message after a delay
  useEffect(() => {
    if (!saveMessage) return;
    const timer = setTimeout(() => setSaveMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [saveMessage]);

  /** Generate comprehensive markdown from all component state */
  const generateTabMarkdown = useCallback((): string => {
    const timestamp = new Date().toLocaleString();
    let md = `# Device: ${hostname}\n\n**Generated:** ${timestamp}\n\n`;

    // System Information
    md += `## System Information\n\n`;
    md += `| Field | Value |\n|-------|-------|\n`;
    md += `| Vendor | ${vendor} |\n`;
    md += `| Model | ${model} |\n`;
    md += `| OS Version | ${osVersion} |\n`;
    md += `| Serial Number | ${serial} |\n`;
    md += `| Hostname | ${hostname} |\n`;
    md += `| Uptime | ${getUptimeDisplay()} |\n`;
    if (enrichment?.cliFlavor) md += `| CLI Flavor | ${enrichment.cliFlavor} |\n`;
    if (device?.primaryIp) md += `| Management IP | ${device.primaryIp} |\n`;
    if (device?.site) md += `| Site | ${device.site} |\n`;
    if (device?.role) md += `| Role | ${device.role} |\n`;
    if (device?.platform) md += `| Platform | ${device.platform} |\n`;

    // SNMP System MIB
    if (Object.keys(snmpSystemInfo).length > 0) {
      md += `\n## SNMP System MIB\n\n`;
      md += `| Field | Value |\n|-------|-------|\n`;
      for (const [key, val] of Object.entries(snmpSystemInfo)) {
        md += `| ${key} | ${val} |\n`;
      }
    }

    // Resources
    if (enrichment?.cpuPercent !== undefined || enrichment?.memoryPercent !== undefined) {
      md += `\n## Resources\n\n`;
      if (enrichment.cpuPercent !== undefined) {
        md += `- **CPU:** ${enrichment.cpuPercent.toFixed(1)}%\n`;
      }
      if (enrichment.memoryPercent !== undefined) {
        let memLine = `- **Memory:** ${enrichment.memoryPercent.toFixed(1)}%`;
        if (enrichment.memoryUsedMB !== undefined && enrichment.memoryTotalMB !== undefined) {
          memLine += ` (${formatBytes(enrichment.memoryUsedMB * 1024 * 1024)} / ${formatBytes(enrichment.memoryTotalMB * 1024 * 1024)})`;
        }
        md += memLine + '\n';
      }
    }

    // Enrichment interfaces
    if (interfaces && interfaces.length > 0) {
      md += `\n## Interfaces (${interfaces.length})\n\n`;
      md += `| Name | Status | Speed | MTU | IP | MAC |\n`;
      md += `|------|--------|-------|-----|-----|-----|\n`;
      for (const iface of interfaces) {
        md += `| ${iface.name} | ${iface.status} | ${iface.speed || '-'} | ${iface.mtu || '-'} | ${iface.ipAddress || '-'} | ${iface.macAddress || '-'} |\n`;
      }

      // Stats sub-table
      const withStats = interfaces.filter(i => i.rxPackets !== undefined || i.txPackets !== undefined);
      if (withStats.length > 0) {
        md += `\n### Interface Statistics\n\n`;
        md += `| Name | RX Pkts | TX Pkts | RX Bytes | TX Bytes | RX Errors | TX Errors |\n`;
        md += `|------|---------|---------|----------|----------|-----------|----------|\n`;
        for (const iface of withStats) {
          md += `| ${iface.name} | ${iface.rxPackets?.toLocaleString() || '0'} | ${iface.txPackets?.toLocaleString() || '0'} | ${iface.rxBytes !== undefined ? formatBytes(iface.rxBytes) : '-'} | ${iface.txBytes !== undefined ? formatBytes(iface.txBytes) : '-'} | ${iface.rxErrors || 0} | ${iface.txErrors || 0} |\n`;
        }
      }
    }

    // SNMP interface data (when no enrichment interfaces)
    if ((!interfaces || interfaces.length === 0) && snmpInterfaceData.size > 0) {
      md += `\n## SNMP Interfaces (${snmpInterfaceData.size})\n\n`;
      md += `| Name | Alias | Status | Speed | In Rate | Out Rate | Errors | Discards |\n`;
      md += `|------|-------|--------|-------|---------|----------|--------|----------|\n`;
      for (const [name, data] of snmpInterfaceData.entries()) {
        const rate = liveRates.get(name);
        const speedLabel = data.speedMbps >= 1000 ? `${(data.speedMbps / 1000).toFixed(data.speedMbps % 1000 === 0 ? 0 : 1)} Gbps` : `${data.speedMbps} Mbps`;
        md += `| ${name} | ${data.ifAlias || '-'} | ${data.operStatusText} | ${data.speedMbps > 0 ? speedLabel : '-'} | ${rate ? formatRate(rate.inBps) : '-'} | ${rate ? formatRate(rate.outBps) : '-'} | ${data.inErrors + data.outErrors} | ${data.inDiscards + data.outDiscards} |\n`;
      }
    }

    // Live rates on enrichment interfaces
    if (interfaces && interfaces.length > 0 && liveRates.size > 0) {
      md += `\n### Live Traffic Rates\n\n`;
      md += `| Interface | In Rate | Out Rate |\n`;
      md += `|-----------|---------|----------|\n`;
      for (const [name, rate] of liveRates.entries()) {
        md += `| ${name} | ${formatRate(rate.inBps)} | ${formatRate(rate.outBps)} |\n`;
      }
    }

    // Session history
    if (sessionHistory.length > 0) {
      md += `\n## Session History\n\n`;
      md += `| Connected At | Duration | Username |\n`;
      md += `|-------------|----------|----------|\n`;
      for (const entry of sessionHistory) {
        md += `| ${new Date(entry.connected_at).toLocaleString()} | ${entry.duration_seconds != null ? formatDuration(entry.duration_seconds) : '-'} | ${entry.username} |\n`;
      }
    }

    // Change history
    if (changeHistory.length > 0) {
      md += `\n## Change History\n\n`;
      md += `| Name | Status | Created At |\n`;
      md += `|------|--------|------------|\n`;
      for (const change of changeHistory) {
        md += `| ${change.name} | ${changeStatusLabels[change.status as ChangeStatus] || change.status} | ${new Date(change.created_at).toLocaleString()} |\n`;
      }
    }

    // Raw outputs
    if (enrichment?.rawOutputs && Object.keys(enrichment.rawOutputs).length > 0) {
      md += `\n## Raw Command Outputs\n\n`;
      for (const [command, output] of Object.entries(enrichment.rawOutputs)) {
        md += `### \`${command}\`\n\n\`\`\`\n${output}\n\`\`\`\n\n`;
      }
    }

    return md;
  }, [hostname, vendor, model, osVersion, serial, enrichment, device, interfaces, snmpSystemInfo, snmpInterfaceData, liveRates, sessionHistory, changeHistory]);

  /** Save basic markdown doc from current state */
  const handleBasicSave = useCallback(async () => {
    setSavingState('saving');
    setSaveMessage(null);
    setSaveDialogOpen(false);
    try {
      const markdown = generateTabMarkdown();
      const result = await saveEnrichmentToDoc(markdown, `device_${hostname}`);
      if (result.success) {
        setSaveMessage({ type: 'success', text: 'Saved to Docs' });
      } else {
        setSaveMessage({ type: 'error', text: result.error || 'Failed to save' });
      }
    } catch (err) {
      setSaveMessage({ type: 'error', text: getErrorMessage(err, 'Save failed') });
    } finally {
      setSavingState('idle');
    }
  }, [generateTabMarkdown, hostname]);

  /** Send to AI for enriched documentation, then save */
  const handleAiEnhancedSave = useCallback(async () => {
    setSavingState('ai-generating');
    setSaveMessage(null);
    setSaveDialogOpen(false);
    try {
      const currentData = generateTabMarkdown();
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: `You are a network documentation specialist. Generate comprehensive, well-structured markdown documentation for a network device. Include:
- Executive summary / device overview
- Health assessment based on resource utilization and interface errors
- Interface analysis highlighting any concerns (errors, discards, high utilization)
- Recommendations based on current state
- Keep all factual data accurate — do not invent data not present in the input
- Output ONLY the markdown document, no preamble or explanation`,
        },
        {
          role: 'user',
          content: `Generate enhanced documentation for this device. Here is the current device data:\n\n${currentData}`,
        },
      ];

      const { provider, model } = resolveProvider();
      const aiResponse = await sendChatMessage(messages, {
        context: {
          device: device ? {
            name: device.name,
            type: device.type,
            platform: device.platform,
            vendor: device.vendor,
            primaryIp: device.primaryIp,
            site: device.site,
            role: device.role,
            status: device.status,
          } : undefined,
        },
        provider,
        model,
      });

      const result = await saveEnrichmentToDoc(aiResponse, `device_${hostname}_ai_enhanced`);
      if (result.success) {
        setSaveMessage({ type: 'success', text: 'AI-enhanced doc saved' });
      } else {
        setSaveMessage({ type: 'error', text: result.error || 'Failed to save AI doc' });
      }
    } catch (err) {
      if (err instanceof AiNotConfiguredError) {
        setSaveMessage({ type: 'error', text: 'AI not configured — add API key in Settings > AI' });
      } else {
        setSaveMessage({ type: 'error', text: getErrorMessage(err, 'AI generation failed') });
      }
    } finally {
      setSavingState('idle');
    }
  }, [generateTabMarkdown, hostname, device]);

  return (
    <div className="device-detail-tab">
      {/* Header */}
      <div className="device-detail-tab-header">
        <div className="device-detail-tab-header-info">
          <h1 className="device-detail-tab-title">
            {hostname}
            {lastPollTime && pollState === 'complete' && (
              <span className="device-detail-tab-snmp-status">
                <span className="device-detail-tab-snmp-dot" />
                SNMP polled {formatRelativeTime(lastPollTime)}
              </span>
            )}
          </h1>
          <div className="device-detail-tab-meta">
            {deviceType !== 'unknown' && (
              <span className="device-detail-tab-type">{deviceType}</span>
            )}
            <span className="device-detail-tab-collected">Last collected: {collectedAt}</span>
          </div>
        </div>
        <div className="device-detail-tab-header-actions">
          <button
            className={`device-detail-tab-action-btn ${pollState !== 'idle' && pollState !== 'complete' && pollState !== 'error' ? 'polling' : ''}`}
            title={canPoll ? 'Refresh SNMP interface stats' : 'SNMP not available (no host or profile)'}
            disabled={!canPoll || (pollState !== 'idle' && pollState !== 'complete' && pollState !== 'error')}
            onClick={handleRefresh}
          >
            {(pollState === 'sample1' || pollState === 'sample2') ? (
              <span className="device-detail-tab-spinner" />
            ) : pollState === 'waiting' ? (
              <span className="device-detail-tab-countdown">{countdown}</span>
            ) : (
              Icons.refresh
            )}
            <span>
              {pollState === 'sample1' ? 'Polling...' :
               pollState === 'waiting' ? 'Waiting...' :
               pollState === 'sample2' ? 'Sampling...' :
               'Refresh'}
            </span>
          </button>
          <div className="device-detail-tab-save-wrapper" ref={saveDialogRef}>
            <button
              className={`device-detail-tab-action-btn ${savingState !== 'idle' ? 'polling' : ''}`}
              onClick={() => {
                if (savingState === 'idle') setSaveDialogOpen(!saveDialogOpen);
              }}
              disabled={savingState !== 'idle'}
              title="Save to Docs"
            >
              {savingState !== 'idle' ? (
                <span className="device-detail-tab-spinner" />
              ) : (
                Icons.save
              )}
              <span>
                {savingState === 'saving' ? 'Saving...' :
                 savingState === 'ai-generating' ? 'AI Generating...' :
                 'Save to Docs'}
              </span>
            </button>
            {saveDialogOpen && (
              <div className="device-detail-tab-save-dialog">
                <button className="device-detail-tab-save-option" onClick={handleBasicSave}>
                  {Icons.save}
                  <div className="device-detail-tab-save-option-text">
                    <span className="device-detail-tab-save-option-title">Save to Docs</span>
                    <span className="device-detail-tab-save-option-desc">Markdown from current tab state</span>
                  </div>
                </button>
                <button className="device-detail-tab-save-option" onClick={handleAiEnhancedSave}>
                  {Icons.cpu}
                  <div className="device-detail-tab-save-option-text">
                    <span className="device-detail-tab-save-option-title">AI Enhanced Doc</span>
                    <span className="device-detail-tab-save-option-desc">AI-generated analysis and recommendations</span>
                  </div>
                </button>
              </div>
            )}
            {saveMessage && (
              <div className={`device-detail-tab-save-message ${saveMessage.type}`}>
                {saveMessage.text}
              </div>
            )}
          </div>
          {onOpenTerminal && (
            <button className="device-detail-tab-action-btn primary" onClick={onOpenTerminal} title="Open Terminal">
              {Icons.terminal}
              <span>Open Terminal</span>
            </button>
          )}
        </div>
      </div>

      {/* Poll error banner */}
      {pollState === 'error' && pollError && (
        <div className="device-detail-tab-poll-error">
          SNMP Error: {pollError}
        </div>
      )}

      {/* Content */}
      <div className="device-detail-tab-content">
        {/* System Information Card */}
        <div className="device-detail-tab-card">
          <div className="device-detail-tab-card-header">
            {Icons.server}
            <span>System Information</span>
          </div>
          <div className="device-detail-tab-card-body">
            <table className="device-detail-tab-info-table">
              <tbody>
                <tr>
                  <td className="label">Vendor</td>
                  <td className="value">{vendor}</td>
                </tr>
                <tr>
                  <td className="label">Model</td>
                  <td className="value">{model}</td>
                </tr>
                <tr>
                  <td className="label">OS Version</td>
                  <td className="value">{osVersion}</td>
                </tr>
                <tr>
                  <td className="label">Serial Number</td>
                  <td className="value">{serial}</td>
                </tr>
                <tr>
                  <td className="label">Hostname</td>
                  <td className="value">{hostname}</td>
                </tr>
                <tr>
                  <td className="label">Uptime</td>
                  <td className="value">{getUptimeDisplay()}</td>
                </tr>
                {enrichment?.cliFlavor && (
                  <tr>
                    <td className="label">CLI Flavor</td>
                    <td className="value">{enrichment.cliFlavor}</td>
                  </tr>
                )}
                {snmpSystemInfo.Location && (
                  <tr>
                    <td className="label">Location</td>
                    <td className="value">{snmpSystemInfo.Location}</td>
                  </tr>
                )}
                {snmpSystemInfo.Contact && (
                  <tr>
                    <td className="label">Contact</td>
                    <td className="value">{snmpSystemInfo.Contact}</td>
                  </tr>
                )}
                {snmpSystemInfo.Description && (
                  <tr>
                    <td className="label">Description</td>
                    <td className="value device-detail-tab-description-value">{snmpSystemInfo.Description}</td>
                  </tr>
                )}
                {snmpSystemInfo['System OID'] && (
                  <tr>
                    <td className="label">System OID</td>
                    <td className="value">{snmpSystemInfo['System OID']}</td>
                  </tr>
                )}
                {snmpSystemInfo['SNMP Uptime'] && (
                  <tr>
                    <td className="label">SNMP Uptime</td>
                    <td className="value">{snmpSystemInfo['SNMP Uptime']}</td>
                  </tr>
                )}
                {device?.primaryIp && (
                  <tr>
                    <td className="label">Management IP</td>
                    <td className="value">{device.primaryIp}</td>
                  </tr>
                )}
                {device?.site && (
                  <tr>
                    <td className="label">Site</td>
                    <td className="value">{device.site}</td>
                  </tr>
                )}
                {device?.role && (
                  <tr>
                    <td className="label">Role</td>
                    <td className="value">{device.role}</td>
                  </tr>
                )}
                {device?.platform && (
                  <tr>
                    <td className="label">Platform</td>
                    <td className="value">{device.platform}</td>
                  </tr>
                )}
                {device?.metadata && Object.keys(device.metadata).length > 0 && (
                  Object.entries(device.metadata).map(([key, val]) => (
                    <tr key={key}>
                      <td className="label">{key}</td>
                      <td className="value">{val}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {/* NetBox Data Section */}
            {netboxDevice && (
              <div className="device-detail-tab-netbox-section">
                <div className="device-detail-tab-netbox-header">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  <span>NetBox</span>
                </div>
                <table className="device-detail-tab-info-table">
                  <tbody>
                    {netboxUrl && (
                      <tr>
                        <td className="label">NetBox Link</td>
                        <td className="value">
                          <a
                            href={`${netboxUrl}/dcim/devices/${netboxDevice.id}/`}
                            onClick={async (e) => {
                              e.preventDefault();
                              const url = `${netboxUrl}/dcim/devices/${netboxDevice.id}/`;
                              try {
                                const { open } = await import('@tauri-apps/plugin-shell');
                                await open(url);
                              } catch {
                                window.open(url, '_blank', 'noopener,noreferrer');
                              }
                            }}
                            className="device-detail-tab-netbox-link"
                          >
                            Open in NetBox
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                              <polyline points="15 3 21 3 21 9" />
                              <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                          </a>
                        </td>
                      </tr>
                    )}
                    {netboxDevice.site && (
                      <tr>
                        <td className="label">Site</td>
                        <td className="value">{netboxDevice.site.name}</td>
                      </tr>
                    )}
                    {netboxDevice.device_role && (
                      <tr>
                        <td className="label">Role</td>
                        <td className="value">{netboxDevice.device_role.name}</td>
                      </tr>
                    )}
                    {netboxDevice.device_type?.manufacturer && (
                      <tr>
                        <td className="label">Manufacturer</td>
                        <td className="value">{netboxDevice.device_type.manufacturer.name}</td>
                      </tr>
                    )}
                    {netboxDevice.device_type && (
                      <tr>
                        <td className="label">Device Type</td>
                        <td className="value">{netboxDevice.device_type.model}</td>
                      </tr>
                    )}
                    {netboxDevice.platform && (
                      <tr>
                        <td className="label">Platform</td>
                        <td className="value">{netboxDevice.platform.name}</td>
                      </tr>
                    )}
                    {netboxDevice.status && (
                      <tr>
                        <td className="label">Status</td>
                        <td className="value">{netboxDevice.status.label}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Device Stencil Card - sits in right column next to System Info */}
        {(() => {
          // Build interface data with full enrichment info
          const ifaceData = interfaces && interfaces.length > 0
            ? interfaces.map((i) => ({
                name: i.name,
                status: i.status,
                alias: i.description,
                speed: i.speed,
                ipAddress: i.ipAddress,
                macAddress: i.macAddress,
                mtu: i.mtu,
              }))
            : snmpInterfaceData.size > 0
              ? Array.from(snmpInterfaceData.entries()).map(([name, data]) => ({
                  name,
                  status: (data.operStatus === 1 ? 'up' : 'down') as string,
                  alias: data.ifAlias,
                  speed: data.speedMbps ? `${data.speedMbps} Mbps` : undefined,
                  ipAddress: undefined as string | undefined,
                  macAddress: undefined as string | undefined,
                  mtu: undefined as number | undefined,
                }))
              : discoveredInterfaces.map((name) => ({
                  name,
                  status: 'unknown' as string,
                  alias: '',
                  speed: undefined as string | undefined,
                  ipAddress: undefined as string | undefined,
                  macAddress: undefined as string | undefined,
                  mtu: undefined as number | undefined,
                }));
          const typeColor = DEVICE_TYPE_COLORS[deviceType] || DEVICE_TYPE_COLORS.unknown;
          const icon = DEVICE_TYPE_ICONS[deviceType as DeviceType] || DEVICE_TYPE_ICONS.unknown;
          const upInterfaces = ifaceData.filter((i) => i.status === 'up');
          const restCount = ifaceData.length - upInterfaces.length;

          // Filter interfaces by search term
          const searchLower = deviceViewSearch.toLowerCase();
          const filteredBySearch = searchLower
            ? ifaceData.filter((i) =>
                i.name.toLowerCase().includes(searchLower) ||
                (i.alias && i.alias.toLowerCase().includes(searchLower)) ||
                (i.ipAddress && i.ipAddress.toLowerCase().includes(searchLower)) ||
                (i.macAddress && i.macAddress.toLowerCase().includes(searchLower)) ||
                (i.speed && i.speed.toLowerCase().includes(searchLower))
              )
            : null;

          // When searching, show all matches; otherwise show up interfaces (or all if expanded)
          const displayInterfaces = filteredBySearch
            ? filteredBySearch
            : deviceViewExpanded
              ? ifaceData
              : upInterfaces;

          return (
            <div className={`device-detail-tab-card device-detail-tab-device-view ${deviceViewExpanded ? 'expanded' : ''}`}>
              <div className="device-detail-tab-card-header">
                {Icons.network}
                <span>Device View</span>
                <div className="device-detail-tab-device-view-search">
                  <input
                    type="text"
                    placeholder="Search interfaces..."
                    value={deviceViewSearch}
                    onChange={(e) => setDeviceViewSearch(e.target.value)}
                    className="device-detail-tab-device-view-search-input"
                  />
                  {deviceViewSearch && (
                    <button
                      className="device-detail-tab-device-view-search-clear"
                      onClick={() => setDeviceViewSearch('')}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
              <div className="device-detail-tab-card-body">
                <div className="device-detail-tab-stencil-vertical">
                  {/* Device icon */}
                  <div className="device-detail-tab-stencil-device" style={{ borderColor: typeColor }}>
                    <div className="device-detail-tab-stencil-icon" style={{ color: typeColor }}>
                      {icon}
                    </div>
                    <div className="device-detail-tab-stencil-label">{hostname}</div>
                    <div className="device-detail-tab-stencil-type">{deviceType}</div>
                  </div>

                  {/* Interface summary */}
                  {ifaceData.length > 0 && (
                    <div className="device-detail-tab-stencil-summary">
                      {filteredBySearch ? (
                        <span>{filteredBySearch.length} match{filteredBySearch.length !== 1 ? 'es' : ''}</span>
                      ) : (
                        <>
                          <span className="device-detail-tab-iface-up">{upInterfaces.length} up</span>
                          {' / '}
                          <span className="device-detail-tab-iface-down">{restCount} down</span>
                          {' / '}
                          <span>{ifaceData.length} total</span>
                        </>
                      )}
                    </div>
                  )}

                  {/* Interface list with expanded data */}
                  {displayInterfaces.length > 0 && (
                    <div className="device-detail-tab-stencil-iface-list">
                      {displayInterfaces.map((iface) => (
                        <div key={iface.name} className="device-detail-tab-stencil-iface-row">
                          <span className={`device-detail-tab-stencil-port ${iface.status === 'up' ? 'up' : iface.status === 'down' ? 'down' : ''}`} />
                          <span className="device-detail-tab-stencil-line" />
                          <div className="device-detail-tab-stencil-iface-info">
                            <span className={`device-detail-tab-stencil-iface-name ${iface.status === 'down' ? 'down' : ''}`}>
                              {iface.name}
                            </span>
                            {iface.speed && (
                              <span className="device-detail-tab-stencil-iface-speed">{iface.speed}</span>
                            )}
                            {iface.alias && (
                              <span className="device-detail-tab-stencil-alias">{iface.alias}</span>
                            )}
                            {iface.ipAddress && (
                              <span className="device-detail-tab-stencil-iface-ip">{iface.ipAddress}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Expand toggle for inactive interfaces - hide when searching */}
                  {restCount > 0 && !filteredBySearch && (
                    <button
                      className="device-detail-tab-stencil-toggle"
                      onClick={() => setDeviceViewExpanded(!deviceViewExpanded)}
                    >
                      {deviceViewExpanded
                        ? 'Show active only'
                        : `${restCount} more interface${restCount !== 1 ? 's' : ''}`}
                      <span className="device-detail-tab-stencil-toggle-chevron">
                        {deviceViewExpanded ? Icons.chevronDown : Icons.chevronRight}
                      </span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Hardware Resources Dashboard */}
        {(enrichment || device) && (
          <div className="device-detail-tab-card full-width">
            <div className="device-detail-tab-card-header">
              {Icons.activity}
              <span>Hardware Resources</span>
            </div>
            <div className="device-detail-tab-card-body">
              <div className="device-detail-tab-health-dashboard">
                {/* CPU Tile */}
                {(() => {
                  const cpu = enrichment?.cpuPercent ?? snmpResources.cpuPercent;
                  return (
                    <div className={`device-detail-tab-health-tile ${cpu !== undefined ? getResourceLevel(cpu) : ''}`}>
                      <div className="device-detail-tab-health-tile-gauge">
                        {renderGauge(
                          cpu ?? 0,
                          cpu !== undefined
                            ? getResourceLevelColor(getResourceLevel(cpu))
                            : 'var(--border-color, #333)'
                        )}
                        <div className="device-detail-tab-health-tile-gauge-value">
                          {cpu !== undefined ? `${cpu.toFixed(0)}%` : '--'}
                        </div>
                      </div>
                      <div className="device-detail-tab-health-tile-info">
                        <div className="device-detail-tab-health-tile-label">CPU</div>
                        <div className="device-detail-tab-health-tile-sublabel">
                          {cpu !== undefined
                            ? getResourceLevel(cpu).charAt(0).toUpperCase() + getResourceLevel(cpu).slice(1)
                            : 'No data'}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Memory Tile */}
                {(() => {
                  const memPct = enrichment?.memoryPercent ?? snmpResources.memoryPercent;
                  const memUsedBytes = enrichment?.memoryUsedMB !== undefined ? enrichment.memoryUsedMB * 1024 * 1024 : snmpResources.memoryUsedBytes;
                  const memTotalBytes = enrichment?.memoryTotalMB !== undefined ? enrichment.memoryTotalMB * 1024 * 1024 : snmpResources.memoryTotalBytes;
                  return (
                    <div className={`device-detail-tab-health-tile ${memPct !== undefined ? getResourceLevel(memPct) : ''}`}>
                      <div className="device-detail-tab-health-tile-gauge">
                        {renderGauge(
                          memPct ?? 0,
                          memPct !== undefined
                            ? getResourceLevelColor(getResourceLevel(memPct))
                            : 'var(--border-color, #333)'
                        )}
                        <div className="device-detail-tab-health-tile-gauge-value">
                          {memPct !== undefined ? `${memPct.toFixed(0)}%` : '--'}
                        </div>
                      </div>
                      <div className="device-detail-tab-health-tile-info">
                        <div className="device-detail-tab-health-tile-label">Memory</div>
                        <div className="device-detail-tab-health-tile-sublabel">
                          {memUsedBytes !== undefined && memTotalBytes !== undefined
                            ? `${formatBytes(memUsedBytes)} / ${formatBytes(memTotalBytes)}`
                            : memPct !== undefined
                              ? getResourceLevel(memPct).charAt(0).toUpperCase() + getResourceLevel(memPct).slice(1)
                              : 'No data'}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Temperature Tile */}
                {(() => {
                  const temp = enrichment?.temperatureCelsius ?? snmpResources.temperatureCelsius;
                  return (
                    <div className={`device-detail-tab-health-tile ${temp !== undefined ? getTemperatureLevel(temp) : ''}`}>
                      <div className="device-detail-tab-health-tile-icon-large">
                        {Icons.thermometer}
                      </div>
                      <div className="device-detail-tab-health-tile-info">
                        <div className="device-detail-tab-health-tile-label">Temperature</div>
                        <div className="device-detail-tab-health-tile-value-large">
                          {temp !== undefined ? `${temp}°C` : 'N/A'}
                        </div>
                        <div className="device-detail-tab-health-tile-sublabel">
                          {temp !== undefined
                            ? getTemperatureLabel(temp)
                            : 'No sensor data'}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* System Health Tile */}
                <div className="device-detail-tab-health-tile">
                  <div className="device-detail-tab-health-tile-icon-large">
                    {Icons.clock}
                  </div>
                  <div className="device-detail-tab-health-tile-info">
                    <div className="device-detail-tab-health-tile-label">System Health</div>
                    <div className="device-detail-tab-health-tile-value-large">{getUptimeDisplay()}</div>
                    {interfaceHealth.total > 0 && (
                      <div className="device-detail-tab-health-iface-stats">
                        <div className="device-detail-tab-health-stat">
                          <span className="device-detail-tab-health-stat-value up">{interfaceHealth.up}</span>
                          <span className="device-detail-tab-health-stat-label">Up</span>
                        </div>
                        <div className="device-detail-tab-health-stat">
                          <span className="device-detail-tab-health-stat-value down">{interfaceHealth.down}</span>
                          <span className="device-detail-tab-health-stat-label">Down</span>
                        </div>
                        <div className="device-detail-tab-health-stat">
                          <span className="device-detail-tab-health-stat-value">{interfaceHealth.total}</span>
                          <span className="device-detail-tab-health-stat-label">Total</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Session History Card - only show if there's history */}
        {sessionHistory.length > 0 && (
          <div className="device-detail-tab-card full-width">
            <button
              className={`device-detail-tab-card-header clickable ${sessionHistoryExpanded ? 'expanded' : ''}`}
              onClick={() => setSessionHistoryExpanded(!sessionHistoryExpanded)}
            >
              {Icons.clock}
              <span>Session History ({sessionHistory.length})</span>
              <span className="device-detail-tab-card-expand">
                {sessionHistoryExpanded ? Icons.chevronDown : Icons.chevronRight}
              </span>
            </button>
            {sessionHistoryExpanded && (
              <div className="device-detail-tab-card-body no-padding">
                <table className="device-detail-tab-history-table">
                  <thead>
                    <tr>
                      <th>Connected At</th>
                      <th>Duration</th>
                      <th>Username</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionHistory.map((entry) => (
                      <tr key={entry.id}>
                        <td>{formatRelativeTime(new Date(entry.connected_at))}</td>
                        <td>{entry.duration_seconds != null ? formatDuration(entry.duration_seconds) : '-'}</td>
                        <td>{entry.username}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Change History Card - only show if there's history */}
        {changeHistory.length > 0 && (
          <div className="device-detail-tab-card full-width">
            <button
              className={`device-detail-tab-card-header clickable ${changeHistoryExpanded ? 'expanded' : ''}`}
              onClick={() => setChangeHistoryExpanded(!changeHistoryExpanded)}
            >
              {Icons.fileEdit}
              <span>Change History ({changeHistory.length})</span>
              <span className="device-detail-tab-card-expand">
                {changeHistoryExpanded ? Icons.chevronDown : Icons.chevronRight}
              </span>
            </button>
            {changeHistoryExpanded && (
              <div className="device-detail-tab-card-body no-padding">
                <table className="device-detail-tab-history-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Created At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changeHistory.map((change) => (
                      <tr key={change.id}>
                        <td>{change.name}</td>
                        <td>
                          <span className={`device-detail-tab-change-status device-detail-tab-change-status--${change.status}`}>
                            {changeStatusLabels[change.status as ChangeStatus] || change.status}
                          </span>
                        </td>
                        <td>{formatRelativeTime(new Date(change.created_at))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Interfaces Card (enrichment) */}
        {interfaces && interfaces.length > 0 && (
          <div className="device-detail-tab-card full-width">
            <div className="device-detail-tab-card-header">
              {Icons.network}
              <span>Interfaces ({interfaces.length})</span>
              <div className="device-detail-tab-filter">
                <span className="device-detail-tab-filter-icon">{Icons.filter}</span>
                <input
                  type="search"
                  placeholder="Filter interfaces..."
                  value={interfaceFilter}
                  onChange={(e) => setInterfaceFilter(e.target.value)}
                />
              </div>
            </div>
            <div className="device-detail-tab-card-body no-padding">
              <div className={`device-detail-tab-interface-table ${liveRates.size > 0 ? 'has-live-rates' : ''}`}>
                <div className="device-detail-tab-interface-header">
                  <span className="expand" />
                  <span className="name" onClick={() => handleSort('name')}>
                    Name {renderSortIndicator('name')}
                  </span>
                  <span className="status" onClick={() => handleSort('status')}>
                    Status {renderSortIndicator('status')}
                  </span>
                  <span className="speed" onClick={() => handleSort('speed')}>
                    Speed {renderSortIndicator('speed')}
                  </span>
                  <span className="mtu" onClick={() => handleSort('mtu')}>
                    MTU {renderSortIndicator('mtu')}
                  </span>
                  <span className="ip">IP Address</span>
                  <span className="mac">MAC Address</span>
                  <span className="rx" onClick={() => handleSort('rxPackets')}>
                    RX Pkts {renderSortIndicator('rxPackets')}
                  </span>
                  <span className="tx" onClick={() => handleSort('txPackets')}>
                    TX Pkts {renderSortIndicator('txPackets')}
                  </span>
                  <span className="errors" onClick={() => handleSort('errors')}>
                    Errors {renderSortIndicator('errors')}
                  </span>
                  {liveRates.size > 0 && (
                    <>
                      <span className="in-rate">In Rate</span>
                      <span className="out-rate">Out Rate</span>
                    </>
                  )}
                </div>
                <div className="device-detail-tab-interface-list">
                  {filteredInterfaces.map(renderInterfaceRow)}
                  {filteredInterfaces.length === 0 && (
                    <div className="device-detail-tab-interface-empty">
                      {interfaceFilter ? 'No interfaces match filter' : 'No interface data available'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Rich SNMP Interface Table (when no enrichment interfaces but SNMP data available) */}
        {(!interfaces || interfaces.length === 0) && snmpInterfaceData.size > 0 && (
          <div className="device-detail-tab-card full-width">
            <div className="device-detail-tab-card-header">
              {Icons.network}
              <span>SNMP Interfaces</span>
              <span className="device-detail-tab-iface-summary">
                <span className="device-detail-tab-iface-up">{snmpIfaceSummary.up} up</span>
                {' / '}
                <span className="device-detail-tab-iface-down">{snmpIfaceSummary.down} down</span>
                {' / '}
                <span>{snmpIfaceSummary.total} total</span>
              </span>
            </div>
            <div className="device-detail-tab-card-body no-padding">
              <div className="device-detail-tab-interface-table device-detail-tab-snmp-table">
                <div className="device-detail-tab-snmp-header">
                  <span onClick={() => handleSnmpSort('name')}>Name {renderSnmpSortIndicator('name')}</span>
                  <span>Alias</span>
                  <span onClick={() => handleSnmpSort('status')}>Status {renderSnmpSortIndicator('status')}</span>
                  <span onClick={() => handleSnmpSort('speed')}>Speed {renderSnmpSortIndicator('speed')}</span>
                  <span onClick={() => handleSnmpSort('inRate')}>In Rate {renderSnmpSortIndicator('inRate')}</span>
                  <span onClick={() => handleSnmpSort('outRate')}>Out Rate {renderSnmpSortIndicator('outRate')}</span>
                  <span onClick={() => handleSnmpSort('errors')}>Errors {renderSnmpSortIndicator('errors')}</span>
                  <span onClick={() => handleSnmpSort('discards')}>Discards {renderSnmpSortIndicator('discards')}</span>
                </div>
                <div className="device-detail-tab-interface-list">
                  {sortedSnmpInterfaces.map(({ name, data, rate }) => {
                    const totalErrors = data.inErrors + data.outErrors;
                    const totalDiscards = data.inDiscards + data.outDiscards;
                    const isUp = data.operStatus === 1;
                    const speedLabel = data.speedMbps >= 1000 ? `${(data.speedMbps / 1000).toFixed(data.speedMbps % 1000 === 0 ? 0 : 1)} Gbps` : `${data.speedMbps} Mbps`;
                    const inPct = data.speedMbps > 0 && rate ? Math.min(100, (rate.inBps / (data.speedMbps * 1_000_000)) * 100) : 0;
                    const outPct = data.speedMbps > 0 && rate ? Math.min(100, (rate.outBps / (data.speedMbps * 1_000_000)) * 100) : 0;

                    return (
                      <div key={name} className="device-detail-tab-snmp-row">
                        <span className="device-detail-tab-interface-name">{name}</span>
                        <span className="device-detail-tab-snmp-alias">{data.ifAlias || '-'}</span>
                        <span className="device-detail-tab-snmp-status-cell">
                          <span className={`device-detail-tab-status-dot ${isUp ? 'up' : 'down'}`} />
                          {data.operStatusText}
                        </span>
                        <span className="device-detail-tab-interface-speed">{data.speedMbps > 0 ? speedLabel : '-'}</span>
                        <span className="device-detail-tab-snmp-rate-cell">
                          <span className="device-detail-tab-interface-in-rate">{rate ? formatRate(rate.inBps) : '-'}</span>
                          {inPct > 0 && (
                            <div className="device-detail-tab-util-bar-container small">
                              <div className="device-detail-tab-util-bar util-in" style={{ width: `${inPct}%` }} />
                            </div>
                          )}
                        </span>
                        <span className="device-detail-tab-snmp-rate-cell">
                          <span className="device-detail-tab-interface-out-rate">{rate ? formatRate(rate.outBps) : '-'}</span>
                          {outPct > 0 && (
                            <div className="device-detail-tab-util-bar-container small">
                              <div className="device-detail-tab-util-bar util-out" style={{ width: `${outPct}%` }} />
                            </div>
                          )}
                        </span>
                        <span className={`device-detail-tab-interface-errors ${totalErrors > 0 ? 'has-errors' : ''}`}>
                          {totalErrors}
                        </span>
                        <span className={`device-detail-tab-interface-errors ${totalDiscards > 0 ? 'has-errors' : ''}`}>
                          {totalDiscards}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Raw Output Section */}
        {enrichment?.rawOutputs && Object.keys(enrichment.rawOutputs).length > 0 && (
          <div className="device-detail-tab-card full-width">
            <button
              className={`device-detail-tab-card-header clickable ${rawOutputExpanded ? 'expanded' : ''}`}
              onClick={() => setRawOutputExpanded(!rawOutputExpanded)}
            >
              {Icons.code}
              <span>Raw Output ({Object.keys(enrichment.rawOutputs).length} commands)</span>
              <span className="device-detail-tab-card-expand">
                {rawOutputExpanded ? Icons.chevronDown : Icons.chevronRight}
              </span>
            </button>
            {rawOutputExpanded && (
              <div className="device-detail-tab-card-body no-padding">
                <div className="device-detail-tab-raw-outputs">
                  {Object.entries(enrichment.rawOutputs).map(([command, output]) => (
                    <div key={command} className="device-detail-tab-raw-output">
                      <div className="device-detail-tab-raw-output-command">{command}</div>
                      <pre className="device-detail-tab-raw-output-content">{output}</pre>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* No Data State - only show if no enrichment AND no device data AND no SNMP data */}
        {!enrichment && !device && snmpInterfaceData.size === 0 && pollState !== 'sample1' && pollState !== 'waiting' && pollState !== 'sample2' && (
          <div className="device-detail-tab-no-data">
            <div className="device-detail-tab-no-data-icon">{Icons.server}</div>
            <h2>{pollState === 'error' ? 'SNMP Poll Failed' : canPoll ? 'Loading Device Data...' : 'No Enrichment Data'}</h2>
            <p>
              {pollState === 'error'
                ? `Failed to collect SNMP data: ${pollError || 'Unknown error'}. You can retry or open a terminal to run Discover.`
                : canPoll
                  ? 'SNMP polling is starting automatically. Click Refresh if data does not appear.'
                  : 'Device information has not been collected yet. Open a terminal to this device and run Discover to collect system information, resource metrics, and interface details.'}
            </p>
            {canPoll ? (
              <button className="device-detail-tab-action-btn primary" onClick={handleRefresh} disabled={pollState !== 'idle' && pollState !== 'complete' && pollState !== 'error'}>
                {Icons.refresh}
                <span>Refresh</span>
              </button>
            ) : onOpenTerminal ? (
              <button className="device-detail-tab-action-btn primary" onClick={onOpenTerminal}>
                {Icons.terminal}
                <span>Open Terminal</span>
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
