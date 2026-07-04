import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import TopologyCanvas from './TopologyCanvas';
import TopologyCanvas3D from './TopologyCanvas3D';
import DeviceTooltip from './DeviceTooltip';
import DeviceDetailCard from './DeviceDetailCard';
import LinkTooltip from './LinkTooltip';
import LinkDetailCard from './LinkDetailCard';
import TopologyToolbar from './TopologyToolbar';
import type { ViewMode, EnrichmentSources } from './TopologyToolbar';
import CollectionDialog from './CollectionDialog';
import ContextMenu, { getAnnotationMenuItems } from './ContextMenu';
import type { CollectionResult, ConnectedSession } from './CollectionDialog';
import type { ToolMode, DevicePlacement, LayerVisibility, ExportFormat } from './TopologyToolbar';
import { useEnrichment } from '../hooks/useEnrichment';
import { useTopologyLive } from '../hooks/useTopologyLive';
import type { TopologyLiveTarget } from '../hooks/useTopologyLive';
import { useTopologyLiveHttp, type TopologyLiveHttpTarget } from '../hooks/useTopologyLiveHttp';
import { useTopologyHistory, createActionDescription } from '../hooks/useTopologyHistory';
import { useActiveTopologyStore } from '../stores/activeTopologyStore';
import type { TopologyAction, ActionSource } from '../types/topologyHistory';
import type { LinkEnrichment, InterfaceEnrichment } from '../types/enrichment';
import { getTopology, updateDevicePosition, createConnection, deleteConnection, saveTemporaryTopology, createDevice, saveTopologyToDocs, addNeighborDevice, updateDevice } from '../api/topology';
import { runBatchDiscovery } from '../api/discovery';
import { resolveTracerouteHops } from '../api/discovery';
import type { TracerouteHop } from '../types/discovery';
import { getCurrentMode } from '../api/client';
import { listProfiles } from '../api/profiles';
import type { CredentialProfile } from '../api/profiles';
import { executeHistoryAction } from '../lib/topologyHistoryActions';
import { computeLayout } from '../lib/topologyLayout';
import type { LayoutType } from '../lib/topologyLayout';
import { filterTopology } from '../lib/topologyFilters';
import { getAnnotations, createAnnotation, updateAnnotation, deleteAnnotation } from '../api/annotations';
import type { Topology, Device, Connection } from '../types/topology';
import { DEFAULT_DEVICE_FILTERS } from '../types/topology';
import type { DeviceFilterState } from '../types/topology';
import type { Annotation, ShapeType, TextAnnotation, ShapeAnnotation, LineAnnotation } from '../types/annotations';
import type { TopologyEnrichmentState, TopologyEnrichmentOptions, LinkPortStats } from '../types/tracerouteEnrichment';
import { enrichTopology, applyEnrichmentToTopology } from '../lib/tracerouteEnrichment';
import { listNetBoxSources, getNetBoxSourceConnection } from '../api/netboxSources';
import { listNetStacksCrawlerSources } from '../api/netstacksCrawler';
import { listLibreNmsSources } from '../api/librenms';
import { listMcpServers } from '../api/mcp';
import { save as showSaveDialog } from '@tauri-apps/plugin-dialog';
import { writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import AnnotationPropertiesPanel from './topology/AnnotationPropertiesPanel';
import { showToast } from './Toast';
import './TopologyTabEditor.css';

import { getErrorMessage } from '../api/errors'
import { logger } from '../lib/logger'
/**
 * Build LinkEnrichment from device interfaces when not pre-built in store.
 *
 * This is a fallback mechanism that attempts to construct link enrichment
 * from connection interface names. Currently returns undefined as interface
 * data is not stored with device enrichment, but structure is prepared for
 * future integration when interface parsing is available.
 *
 * @param connection - The connection to build enrichment for
 * @param _sourceDevice - Source device (unused currently, for future use)
 * @param _targetDevice - Target device (unused currently, for future use)
 * @param _getDeviceEnrichment - Function to get device enrichment (unused currently)
 * @returns LinkEnrichment if interfaces can be found, undefined otherwise
 */
function buildLinkEnrichmentFromDevices(
  connection: Connection,
  _sourceDevice: Device,
  _targetDevice: Device,
  _getDeviceEnrichment: (sessionId: string) => unknown | undefined
): LinkEnrichment | undefined {
  // If connection has interface names, create minimal interface enrichment
  // This provides basic info even without full device interface data
  if (connection.sourceInterface && connection.targetInterface) {
    const now = new Date().toISOString();

    // Create minimal interface enrichment from connection interface names
    const sourceInterface: InterfaceEnrichment = {
      name: connection.sourceInterface,
      status: connection.status === 'active' ? 'up' : connection.status === 'inactive' ? 'down' : 'up',
    };

    const destInterface: InterfaceEnrichment = {
      name: connection.targetInterface,
      status: connection.status === 'active' ? 'up' : connection.status === 'inactive' ? 'down' : 'up',
    };

    return {
      connectionId: connection.id,
      collectedAt: now,
      sourceInterface,
      destInterface,
    };
  }

  // Future: When device enrichment includes interface data, match by interface name:
  // 1. Get source device's enrichment
  // 2. Get target device's enrichment
  // 3. Find matching interface in source (by connection.sourceInterface)
  // 4. Find matching interface in target (by connection.targetInterface)
  // 5. Return LinkEnrichment with sourceInterface and destInterface

  return undefined;
}

interface TopologyTabEditorProps {
  /** Topology ID to load from backend */
  topologyId?: string;
  /** Initial topology data (for in-memory/unsaved topologies like traceroute) */
  initialTopology?: Topology;
  /** Whether this is a temporary/unsaved topology */
  isTemporary?: boolean;
  onDeviceSelect?: (device: Device | null) => void;
  onDeviceDoubleClick?: (device: Device, position: { x: number; y: number }) => void;
  onConnectionSelect?: (connection: Connection | null) => void;
  onDeviceContextMenu?: (device: Device, position: { x: number; y: number }, topologyId?: string) => void;
  /** Open the AI panel to discuss the whole topology (free-space right-click) */
  onDiscussTopologyWithAI?: () => void;
  /** Open the AI panel seeded to discuss a specific device or link */
  onAskAIAboutElement?: (kind: 'device' | 'link', id: string) => void;
  /** Callback when AI Discover button is clicked - uses AI to enrich topology data */
  onAIDiscover?: (topology: Topology) => void;
  /** Whether AI discovery/enrichment is currently running */
  aiDiscoverRunning?: boolean;
  /** Callback when topology is saved (converts temporary to persistent) */
  onSaveTopology?: (savedTopology: Topology) => void;
  /** Callback when topology name is changed (to update tab title) */
  onNameChange?: (newName: string) => void;
  /** Open device details in a dedicated tab */
  onOpenDeviceDetailTab?: (device: Device) => void;
  /** Open link details in a dedicated tab */
  onOpenLinkDetailTab?: (connection: Connection, sourceDevice: Device, targetDevice: Device) => void;
  /** Save device enrichment to docs */
  onSaveDeviceToDocs?: (device: Device) => void;
  /** Save link enrichment to docs */
  onSaveLinkToDocs?: (connection: Connection, sourceDevice: Device, targetDevice: Device) => void;
  /** Change this value to force a refresh of the topology data */
  refreshKey?: number;
  /** Connected sessions for CLI data collection */
  connectedSessions?: ConnectedSession[];
  /** Function to run a command on a session */
  runCommand?: (sessionId: string, command: string) => Promise<string>;
}

export default function TopologyTabEditor({
  topologyId,
  initialTopology,
  isTemporary = false,
  onDeviceSelect,
  onDeviceDoubleClick,
  onConnectionSelect,
  onDeviceContextMenu,
  onDiscussTopologyWithAI,
  onAskAIAboutElement,
  onSaveTopology,
  onOpenDeviceDetailTab,
  onOpenLinkDetailTab,
  onSaveDeviceToDocs,
  onSaveLinkToDocs,
  refreshKey,
  connectedSessions = [],
  runCommand,
}: TopologyTabEditorProps) {
  const [topology, setTopology] = useState<Topology | null>(initialTopology || null);
  const [loading, setLoading] = useState(!initialTopology && !!topologyId);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('2d');
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  // Connection drawing mode state
  const [drawingConnection, setDrawingConnection] = useState(false);
  const [connectionSource, setConnectionSource] = useState<Device | null>(null);

  // Save topology state
  const [saving, setSaving] = useState(false);
  const [savingToDocs, setSavingToDocs] = useState(false);

  // Discover Network state (traceroute topology hop resolution)
  const [isDiscoveringNetwork, setIsDiscoveringNetwork] = useState(false);

  // Collection dialog state
  const [collectionDialogOpen, setCollectionDialogOpen] = useState(false);

  // Tool mode state for new toolbar
  const [currentTool, setCurrentTool] = useState<ToolMode>('select');
  const [deviceTypeToPlace, setDeviceTypeToPlace] = useState<DevicePlacement>('router');
  const [shapeTypeToPlace, setShapeTypeToPlace] = useState<ShapeType>('rectangle');
  const [visibleLayers, setVisibleLayers] = useState<LayerVisibility>({
    devices: true,
    connections: true,
    annotations: true,
    grid: true,
  });
  const [deviceFilters, setDeviceFilters] = useState<DeviceFilterState>(DEFAULT_DEVICE_FILTERS);

  // Undo/Redo history hook with AI action tracking
  const {
    canUndo,
    canRedo,
    undo,
    redo,
    pushAction,
    hasUndoableAIActions,
    getRecentAIActions,
  } = useTopologyHistory({
    topologyId: topologyId || topology?.id || 'temp',
    maxHistory: 100,
    persistToStorage: !isTemporary, // Only persist for saved topologies
  });

  // AI action toast state
  const [aiActionToast, setAIActionToast] = useState<TopologyAction | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Line drawing state for freeform lines (used for hint text)
  const [linePoints, setLinePoints] = useState<{ x: number; y: number }[]>([]);

  // Annotations state for text labels, shapes, and lines
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);

  // Editing state for inline text annotation editing
  const [editingAnnotation, setEditingAnnotation] = useState<{
    annotation: TextAnnotation;
    screenPosition: { x: number; y: number };
  } | null>(null);
  const [editingText, setEditingText] = useState('');

  // Annotation context menu state
  const [annotationContextMenu, setAnnotationContextMenu] = useState<{
    annotation: Annotation;
    position: { x: number; y: number };
  } | null>(null);

  // Free-space (empty canvas) context menu → "Discuss this topology with AI"
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number } | null>(null);
  // Link (connection) context menu → Ask AI / Delete
  const [linkMenu, setLinkMenu] = useState<{ connection: Connection; position: { x: number; y: number } } | null>(null);

  // Device hover state for tooltip
  const [hoveredDevice, setHoveredDevice] = useState<{
    device: Device;
    position: { x: number; y: number };
  } | null>(null);

  // Detail card state (shown on single click)
  const [detailCard, setDetailCard] = useState<{
    device: Device;
    position: { x: number; y: number };
  } | null>(null);

  // Connection hover state for tooltip
  const [hoveredConnection, setHoveredConnection] = useState<{
    connection: Connection;
    position: { x: number; y: number };
  } | null>(null);

  // Link detail card state (shown on connection click)
  const [linkDetailCard, setLinkDetailCard] = useState<{
    connection: Connection;
    position: { x: number; y: number };
  } | null>(null);

  // Enrichment data hook
  const { getDeviceEnrichment, getLinkEnrichment, getAllDeviceEnrichments } = useEnrichment();

  // Topology enrichment state
  const [traceEnrichment, setTraceEnrichment] = useState<TopologyEnrichmentState | null>(null);
  // Mirrors the "Show port stats (LibreNMS)" toggle from the toolbar. Set
  // by handleStartEnrichment so the canvas knows to colorize edges using
  // traceEnrichment.linkStats. False when no LibreNMS source is selected.
  const [showPortStats, setShowPortStats] = useState(false);

  // Enrichment sources (loaded once)
  const [enrichmentSources, setEnrichmentSources] = useState<EnrichmentSources | undefined>(undefined);
  // MCP server full objects (needed to build enrichment options)
  const [mcpServerObjects, setMcpServerObjects] = useState<Array<{ id: string; tools: Array<{ id: string; name: string; enabled: boolean; input_schema: Record<string, unknown> }> }>>([]);

  // Live SNMP polling hook (WebSocket for personal mode)
  const topologyLive = useTopologyLive();

  // HTTP polling hook for enterprise mode
  const topologyLiveHttp = useTopologyLiveHttp();

  // Cached SNMP profile (first profile with snmp_communities)
  const [snmpProfileId, setSnmpProfileId] = useState<string | null>(null);
  const [snmpProfileLoaded, setSnmpProfileLoaded] = useState(false);
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);

  // Load SNMP-capable profile once
  useEffect(() => {
    let cancelled = false;
    async function loadSnmpProfile() {
      try {
        const profiles: CredentialProfile[] = await listProfiles();
        // We cannot check vault credentials from frontend list API
        // Use the first profile as SNMP profile (backend will resolve communities from vault)
        if (!cancelled) {
          setProfiles(profiles);
          if (profiles.length > 0) {
            setSnmpProfileId(profiles[0].id);
          }
        }
      } catch (err) {
        console.warn('[TopologyTabEditor] Failed to load profiles for SNMP:', err);
      } finally {
        if (!cancelled) {
          setSnmpProfileLoaded(true);
        }
      }
    }
    loadSnmpProfile();
    return () => { cancelled = true; };
  }, []);

  // Load enrichment sources once on mount
  useEffect(() => {
    let cancelled = false;
    async function loadEnrichmentSources() {
      const [nb, nd, lnms, mcp] = await Promise.allSettled([
        listNetBoxSources(),
        listNetStacksCrawlerSources(),
        listLibreNmsSources(),
        listMcpServers(),
      ]);

      if (cancelled) return;

      const nbResult = nb.status === 'fulfilled' ? nb.value : [];
      const ndResult = nd.status === 'fulfilled' ? nd.value : [];
      const lnmsResult = lnms.status === 'fulfilled' ? lnms.value : [];
      const mcpResult = mcp.status === 'fulfilled' ? mcp.value : [];

      setEnrichmentSources({
        netbox: nbResult.map(s => ({ id: s.id, name: s.name })),
        netstacksCrawler: ndResult.map(s => ({ id: s.id, name: s.name })),
        librenms: lnmsResult.map(s => ({ id: s.id, name: s.name })),
        mcp: mcpResult
          .filter(s => s.connected && s.tools.length > 0)
          .map(s => ({ id: s.id, name: s.name, toolCount: s.tools.filter(t => t.enabled).length })),
      });

      // Store full MCP server objects for building enrichment options
      setMcpServerObjects(
        mcpResult
          .filter(s => s.connected && s.tools.length > 0)
          .map(s => ({ id: s.id, tools: s.tools }))
      );
    }
    loadEnrichmentSources();
    return () => { cancelled = true; };
  }, []);

  /**
   * Handle starting enrichment from the toolbar dropdown.
   * Resolves NetBox tokens and MCP servers, then runs enrichment.
   */
  const handleStartEnrichment = useCallback(async (options: TopologyEnrichmentOptions) => {
    if (!topology) return;

    const topoSnapshot = topology;
    logger.log('[TopologyTabEditor] Starting enrichment for', topoSnapshot.devices.filter(d => d.primaryIp).length, 'devices');

    // Resolve NetBox configs (need to fetch tokens)
    const extOptions = options as TopologyEnrichmentOptions & { _selectedNetboxIds?: string[]; _selectedMcpIds?: string[] };
    const netboxIds = extOptions._selectedNetboxIds || [];
    const mcpIds = extOptions._selectedMcpIds || [];

    const netboxConfigs: Array<{ url: string; token: string; sourceId?: string }> = [];
    if (netboxIds.length > 0 && enrichmentSources) {
      // Load full NetBox source info
      try {
        const allSources = await listNetBoxSources();
        for (const src of allSources) {
          if (!netboxIds.includes(src.id)) continue;
          try {
            const conn = await getNetBoxSourceConnection(src.id);
            if (conn) {
              netboxConfigs.push({ url: conn.base_url, token: conn.token, sourceId: src.id });
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    // Resolve MCP servers
    const selectedMcpServers = mcpServerObjects.filter(s => mcpIds.includes(s.id));

    // Remember whether to draw port-stat colors after enrichment finishes;
    // disabled toggle = clear so the canvas falls back to its old behavior.
    setShowPortStats(Boolean(options.enableLinkStats));

    try {
      await enrichTopology(topoSnapshot, {
        ...options,
        netboxConfigs: netboxConfigs.length > 0 ? netboxConfigs : undefined,
        mcpServers: selectedMcpServers.length > 0 ? selectedMcpServers : undefined,
        onProgress: (state) => {
          setTraceEnrichment(state);
          // Apply enrichment to topology for live visual updates
          const enriched = applyEnrichmentToTopology(topoSnapshot, state);
          setTopology(enriched);
        },
      });

      // 1-hop neighbor discovery as part of enrichment. Runs SNMP LLDP/CDP
      // on every topology device that has a profile + IP, then either links
      // each discovered neighbor to an existing node (alias dedup) or adds
      // it as a new node. Reuses runBatchDiscovery — the same path used by
      // the Discovery modal — so jump-host routing & all SNMP plumbing
      // are inherited automatically.
      if (options.discoverNeighbors) {
        await runNeighborDiscoveryPhase(topoSnapshot);
        // Pull fresh topology with the new nodes/connections persisted.
        const refreshed = await getTopology(topoSnapshot.id);
        setTopology(refreshed);
      }
    } catch (err) {
      console.error('[TopologyTabEditor] Enrichment failed:', err);
    }
  }, [topology, enrichmentSources, mcpServerObjects]);

  /**
   * Phase 2 of enrichment (opt-in): SNMP LLDP/CDP neighbor discovery on every
   * device with a usable profile. Each discovered neighbor either matches an
   * existing topology node (by name or IP, case-insensitive) and gets a
   * connection, or it's added as a new node. Currently 1-hop only.
   */
  const runNeighborDiscoveryPhase = useCallback(async (topoSnapshot: Topology) => {
    const targets = topoSnapshot.devices
      .filter(d => (d.snmpProfileId || d.profileId) && d.primaryIp)
      .map(d => ({
        ip: d.primaryIp!,
        sessionId: d.sessionId,
        snmpProfileId: d.snmpProfileId || d.profileId,
        credentialProfileId: d.profileId,
      }));

    if (targets.length === 0) {
      logger.log('[TopologyTabEditor] Neighbor discovery skipped — no devices with profile+IP');
      return;
    }

    logger.log(`[TopologyTabEditor] Neighbor discovery: ${targets.length} target(s)`);

    let results;
    try {
      results = await runBatchDiscovery({ targets, methods: ['snmp', 'cli'] });
    } catch (err) {
      console.error('[TopologyTabEditor] Neighbor discovery batch failed:', err);
      return;
    }

    // Build alias index from CURRENT topology so we can dedup discovered
    // neighbors against existing nodes (by name OR primary IP).
    const aliasToDeviceId = new Map<string, string>();
    const registerAlias = (alias: string | undefined | null, deviceId: string) => {
      if (!alias) return;
      const key = alias.toLowerCase().trim();
      if (key && !aliasToDeviceId.has(key)) aliasToDeviceId.set(key, deviceId);
    };
    for (const d of topoSnapshot.devices) {
      registerAlias(d.name, d.id);
      registerAlias(d.primaryIp, d.id);
    }

    // Map result.ip back to the topology device that originated this result —
    // so we can draw connections from "this device → its neighbor".
    const sourceIdByIp = new Map<string, string>();
    for (const d of topoSnapshot.devices) {
      if (d.primaryIp) sourceIdByIp.set(d.primaryIp, d.id);
    }

    // Existing connection set (deduped pairs) so we don't re-create links.
    const existingConnections = new Set<string>();
    for (const c of topoSnapshot.connections) {
      existingConnections.add([c.sourceDeviceId, c.targetDeviceId].sort().join('-'));
    }

    let neighborIndex = 0;

    for (const r of results) {
      const sourceId = sourceIdByIp.get(r.ip);
      if (!sourceId) continue;

      const sourceDevice = topoSnapshot.devices.find(d => d.id === sourceId);
      const sourceX = sourceDevice?.x ?? 300;
      const sourceY = sourceDevice?.y ?? 200;

      for (const neighbor of r.neighbors) {
        const nameKey = neighbor.neighborName?.toLowerCase().trim() ?? '';
        const ipKey = neighbor.neighborIp?.toLowerCase().trim() ?? '';
        const existingId =
          (nameKey && aliasToDeviceId.get(nameKey)) ||
          (ipKey && aliasToDeviceId.get(ipKey));

        const tryConnect = async (targetId: string) => {
          if (targetId === sourceId) return;
          const connKey = [sourceId, targetId].sort().join('-');
          if (existingConnections.has(connKey)) return;
          existingConnections.add(connKey);
          try {
            await createConnection(topoSnapshot.id, {
              source_device_id: sourceId,
              target_device_id: targetId,
              source_interface: neighbor.localInterface,
              target_interface: neighbor.neighborInterface || undefined,
            });
          } catch (err) {
            console.error('[TopologyTabEditor] Neighbor link failed:', err);
          }
        };

        if (existingId) {
          await tryConnect(existingId);
          continue;
        }

        // New neighbor — add as a node. Position in a fan around its source.
        const angle = (neighborIndex * 45) * (Math.PI / 180);
        const radius = 130;
        try {
          const added = await addNeighborDevice(topoSnapshot.id, {
            name: neighbor.neighborName,
            host: neighbor.neighborIp || '',
            device_type: 'unknown',
            x: sourceX + Math.cos(angle) * radius,
            y: sourceY + Math.sin(angle) * radius,
            profile_id: sourceDevice?.profileId,
            snmp_profile_id: sourceDevice?.snmpProfileId,
          });
          neighborIndex++;
          registerAlias(neighbor.neighborName, added.id);
          registerAlias(neighbor.neighborIp, added.id);
          await updateDevice(topoSnapshot.id, added.id, {
            notes: 'discovery:neighbor',
            ...(neighbor.neighborPlatform ? { platform: neighbor.neighborPlatform } : {}),
            ...(neighbor.neighborIp ? { primary_ip: neighbor.neighborIp } : {}),
          });
          await tryConnect(added.id);
        } catch (err) {
          console.error('[TopologyTabEditor] Add neighbor failed:', err);
        }
      }
    }

    logger.log(`[TopologyTabEditor] Neighbor discovery added ${neighborIndex} new node(s)`);
  }, []);

  /**
   * Build live SNMP targets from topology data.
   * Includes all devices with primaryIp — connection interface names are
   * added when available but not required (backend polls all interfaces
   * when the list is empty).
   */
  const liveTargets = useMemo((): TopologyLiveTarget[] => {
    if (!topology || !snmpProfileId) return [];

    // Seed every device that has a primary IP (uses device-specific profile
    // when available so jump-host config is honoured, falls back to global).
    const hostMap = new Map<string, { profileId: string; interfaces: Set<string> }>();
    for (const d of topology.devices) {
      if (d.primaryIp) {
        hostMap.set(d.primaryIp, {
          profileId: d.snmpProfileId || d.profileId || snmpProfileId,
          interfaces: new Set<string>(),
        });
      }
    }

    // Enrich with specific interface names from connections when available
    for (const conn of topology.connections) {
      const sourceDevice = topology.devices.find(d => d.id === conn.sourceDeviceId);
      const targetDevice = topology.devices.find(d => d.id === conn.targetDeviceId);

      if (sourceDevice?.primaryIp && conn.sourceInterface) {
        hostMap.get(sourceDevice.primaryIp)?.interfaces.add(conn.sourceInterface);
      }
      if (targetDevice?.primaryIp && conn.targetInterface) {
        hostMap.get(targetDevice.primaryIp)?.interfaces.add(conn.targetInterface);
      }
    }

    return Array.from(hostMap.entries()).map(([host, entry]) => ({
      host,
      profileId: entry.profileId,
      interfaces: Array.from(entry.interfaces),
    }));
  }, [topology, snmpProfileId]);

  const isEnterprise = getCurrentMode() === 'enterprise';

  /** Enterprise mode targets - need deviceId for each device */
  const enterpriseLiveTargets = useMemo((): TopologyLiveHttpTarget[] => {
    if (!topology?.devices || !isEnterprise) return [];

    // Build targets from devices with netboxId (which can be used as deviceId)
    // and connections with interface names
    const hostMap = new Map<string, { deviceId: string; host: string; interfaces: Set<string> }>();

    for (const conn of topology.connections) {
      const sourceDevice = topology.devices.find(d => d.id === conn.sourceDeviceId);
      const targetDevice = topology.devices.find(d => d.id === conn.targetDeviceId);

      // Process source device
      if (sourceDevice?.primaryIp && sourceDevice.netboxId && conn.sourceInterface) {
        const key = sourceDevice.primaryIp;
        if (!hostMap.has(key)) {
          hostMap.set(key, {
            deviceId: String(sourceDevice.netboxId),
            host: key,
            interfaces: new Set(),
          });
        }
        hostMap.get(key)!.interfaces.add(conn.sourceInterface);
      }

      // Process target device
      if (targetDevice?.primaryIp && targetDevice.netboxId && conn.targetInterface) {
        const key = targetDevice.primaryIp;
        if (!hostMap.has(key)) {
          hostMap.set(key, {
            deviceId: String(targetDevice.netboxId),
            host: key,
            interfaces: new Set(),
          });
        }
        hostMap.get(key)!.interfaces.add(conn.targetInterface);
      }
    }

    return Array.from(hostMap.values()).map(({ deviceId, host, interfaces }) => ({
      deviceId,
      host,
      interfaces: Array.from(interfaces),
    }));
  }, [topology, isEnterprise]);

  /** Whether live mode is available */
  const liveAvailable = isEnterprise
    ? enterpriseLiveTargets.length > 0
    : snmpProfileLoaded && liveTargets.length > 0;

  /** Toggle live SNMP polling */
  const handleToggleLive = useCallback(() => {
    if (isEnterprise) {
      // Enterprise mode: use HTTP polling
      if (topologyLiveHttp.isLive) {
        topologyLiveHttp.stop();
      } else {
        topologyLiveHttp.start(enterpriseLiveTargets, 30);
      }
    } else {
      // Personal mode: use WebSocket
      if (topologyLive.isLive) {
        topologyLive.stop();
      } else {
        topologyLive.start(liveTargets, 30);
      }
    }
  }, [topologyLive, topologyLiveHttp, liveTargets, enterpriseLiveTargets, isEnterprise]);

  // Stable serialization of targets — only changes when IPs/profiles/interfaces
  // actually differ, NOT on position-only topology updates (drag-and-drop).
  const liveTargetsKey = useMemo(() =>
    JSON.stringify(liveTargets.map(t => ({ h: t.host, p: t.profileId, i: t.interfaces.sort() }))),
    [liveTargets]
  );
  const enterpriseTargetsKey = useMemo(() =>
    JSON.stringify(enterpriseLiveTargets.map(t => ({ d: t.deviceId, h: t.host, i: t.interfaces.sort() }))),
    [enterpriseLiveTargets]
  );

  // Re-subscribe when targets change (for active live polling)
  useEffect(() => {
    if (isEnterprise) {
      if (topologyLiveHttp.isLive) {
        topologyLiveHttp.start(enterpriseLiveTargets, 30);
      }
    } else {
      if (topologyLive.isLive) {
        topologyLive.start(liveTargets, 30);
      }
    }
    // Only re-run when the serialized target content changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEnterprise ? enterpriseTargetsKey : liveTargetsKey]);

  // Select the appropriate live state based on mode
  const activeLiveStats = isEnterprise ? topologyLiveHttp.liveStats : topologyLive.liveStats;
  const activeDeviceStats = isEnterprise ? topologyLiveHttp.deviceStats : topologyLive.deviceStats;
  const isLiveActive = isEnterprise ? topologyLiveHttp.isLive : topologyLive.isLive;

  /**
   * Get session ID for a device, supporting multiple lookup strategies:
   * 1. Use device.sessionId if available (direct link)
   * 2. Try matching device name to enrichment hostnames
   * 3. Return null if no match found
   */
  const getDeviceSessionId = useCallback((device: Device): string | null => {
    // Strategy 1: Direct sessionId
    if (device.sessionId) {
      return device.sessionId;
    }

    // Strategy 2: Match device name to enrichment hostnames
    const allEnrichments = getAllDeviceEnrichments();
    for (const enrichment of allEnrichments) {
      // Check if device name matches hostname (case-insensitive)
      if (enrichment.hostname && enrichment.hostname.toLowerCase() === device.name.toLowerCase()) {
        return enrichment.sessionId;
      }
    }

    return null;
  }, [getAllDeviceEnrichments]);

  /**
   * Get enrichment data for a device using flexible session lookup
   */
  const getDeviceEnrichmentForDevice = useCallback((device: Device) => {
    const sessionId = getDeviceSessionId(device);
    return sessionId ? getDeviceEnrichment(sessionId) : undefined;
  }, [getDeviceSessionId, getDeviceEnrichment]);

  /**
   * Get link enrichment with fallback to building from device interfaces.
   * First checks the store, then attempts to build from connection interface names.
   */
  const getLinkEnrichmentWithFallback = useCallback((
    connection: Connection,
    sourceDevice: Device,
    targetDevice: Device
  ): LinkEnrichment | undefined => {
    // First try to get from store
    const stored = getLinkEnrichment(connection.id);
    if (stored) {
      return stored;
    }

    // Fallback: build from connection interface names or device enrichment
    return buildLinkEnrichmentFromDevices(
      connection,
      sourceDevice,
      targetDevice,
      getDeviceEnrichment
    );
  }, [getLinkEnrichment, getDeviceEnrichment]);

  /**
   * Build Map of connectionId -> LinkEnrichment for all connections.
   * Used by TopologyCanvas to render interface labels on connection lines.
   */
  const linkEnrichmentMap = useMemo(() => {
    if (!topology) return new Map<string, LinkEnrichment>();

    const map = new Map<string, LinkEnrichment>();
    for (const connection of topology.connections) {
      const sourceDevice = topology.devices.find(d => d.id === connection.sourceDeviceId);
      const targetDevice = topology.devices.find(d => d.id === connection.targetDeviceId);

      if (sourceDevice && targetDevice) {
        const enrichment = getLinkEnrichmentWithFallback(connection, sourceDevice, targetDevice);
        if (enrichment) {
          map.set(connection.id, enrichment);
        }
      }
    }
    return map;
  }, [topology, getLinkEnrichmentWithFallback]);

  // Load topology data from backend (only if topologyId provided)
  // If initialTopology was provided but refreshKey changes, reload from backend
  useEffect(() => {
    logger.log('[TopologyTabEditor] useEffect triggered', { topologyId, hasInitialTopology: !!initialTopology, refreshKey });
    if (!topologyId) {
      logger.log('[TopologyTabEditor] Skipping load - no topologyId');
      setLoading(false);
      return;
    }
    // Skip initial load if we have initialTopology, but allow refresh when refreshKey changes
    if (initialTopology && refreshKey === undefined) {
      logger.log('[TopologyTabEditor] Using initialTopology, skipping load');
      setLoading(false);
      return;
    }

    const idToLoad = topologyId; // Capture for closure

    async function load() {
      logger.log('[TopologyTabEditor] Loading topology:', idToLoad);
      try {
        setLoading(true);
        const data = await getTopology(idToLoad);
        logger.log('[TopologyTabEditor] Topology loaded, devices:', data.devices.length, 'first device enrichment:', data.devices[0] ? { vendor: data.devices[0].vendor, model: data.devices[0].model, version: data.devices[0].version } : 'none');
        setTopology(data);
        setError(null);

        // Load annotations for this topology
        try {
          const annotationData = await getAnnotations(idToLoad);
          setAnnotations(annotationData);
          logger.log('[TopologyTabEditor] Annotations loaded:', annotationData.length);
        } catch (annotationErr) {
          console.warn('[TopologyTabEditor] Failed to load annotations:', annotationErr);
          // Don't fail topology load if annotations fail
          setAnnotations([]);
        }
      } catch (err) {
        console.error('[TopologyTabEditor] Load error:', err);
        setError(getErrorMessage(err, 'Failed to load topology'));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [topologyId, initialTopology, refreshKey]);

  /**
   * Show AI action toast notification
   */
  const showAIActionToast = useCallback((action: TopologyAction) => {
    // Clear any existing timeout
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    setAIActionToast(action);
    // Auto-dismiss after 5 seconds
    toastTimeoutRef.current = setTimeout(() => {
      setAIActionToast(null);
    }, 5000);
  }, []);

  /**
   * Dismiss AI action toast
   */
  const dismissToast = useCallback(() => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    setAIActionToast(null);
  }, []);

  // Publish the active topology + live telemetry + mutation callbacks to the
  // shared store so the global AI side panel can see and act on this map.
  // Cleared on unmount so the AI's topology tools disappear when no topology
  // tab is focused.
  const publishActiveTopology = useActiveTopologyStore(s => s.publish);
  const clearActiveTopology = useActiveTopologyStore(s => s.clear);
  useEffect(() => {
    publishActiveTopology({
      topology,
      topologyId: topologyId || topology?.id,
      isTemporary,
      deviceStats: activeDeviceStats,
      linkEnrichment: linkEnrichmentMap,
      liveStats: activeLiveStats,
      setTopology,
      pushAction,
      showAIActionToast,
    });
    return () => clearActiveTopology();
  }, [
    topology, topologyId, isTemporary, activeDeviceStats, linkEnrichmentMap,
    activeLiveStats, setTopology, pushAction, showAIActionToast,
    publishActiveTopology, clearActiveTopology,
  ]);

  // Handle device position change (drag-drop) with history tracking
  const handleDevicePositionChange = useCallback(async (
    deviceId: string,
    x: number,
    y: number,
    source: ActionSource = 'user'
  ) => {
    // Get device before update for history
    const device = topology?.devices.find(d => d.id === deviceId);
    const beforePosition = device ? { x: device.x, y: device.y } : null;

    // Update local topology state first
    setTopology(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        devices: prev.devices.map(d =>
          d.id === deviceId ? { ...d, x, y } : d
        ),
      };
    });

    // Record in history
    if (device) {
      const action = pushAction({
        type: 'move_device',
        source,
        description: createActionDescription('move_device', device.name),
        data: {
          before: beforePosition,
          after: { x, y },
          context: { topologyId: topologyId || topology?.id, deviceId },
        },
      });

      // Show toast for AI actions
      if (source === 'ai') {
        showAIActionToast(action);
      }
    }

    // Only persist to backend if this is a saved topology
    if (!isTemporary && topologyId) {
      try {
        await updateDevicePosition(topologyId, deviceId, x, y);
      } catch (err) {
        console.error('Failed to save device position:', err);
      }
    }
  }, [topologyId, isTemporary, topology, pushAction, showAIActionToast]);

  // Handle device hover (from TopologyCanvas with 200ms delay)
  const handleDeviceHover = useCallback((device: Device | null, position?: { x: number; y: number }) => {
    if (device && position) {
      setHoveredDevice({ device, position });
    } else {
      setHoveredDevice(null);
    }
  }, []);

  // Handle connection hover (from TopologyCanvas with 200ms delay)
  const handleConnectionHover = useCallback((connection: Connection | null, position?: { x: number; y: number }) => {
    if (connection && position) {
      setHoveredConnection({ connection, position });
    } else {
      setHoveredConnection(null);
    }
  }, []);

  // Handle device context menu (right-click) - wraps callback to include topologyId
  const handleDeviceContextMenuWrapper = useCallback((device: Device, screenPosition: { x: number; y: number }) => {
    onDeviceContextMenu?.(device, screenPosition, topologyId || undefined)
  }, [onDeviceContextMenu, topologyId])

  // Handle device click (selection and detail card)
  const handleDeviceClick = useCallback((device: Device, screenPosition: { x: number; y: number }) => {
    // If detail card already showing for same device, close it
    if (detailCard?.device.id === device.id) {
      setDetailCard(null);
    } else {
      // Show detail card, hide tooltip and close link card
      setDetailCard({ device, position: screenPosition });
      setHoveredDevice(null);
      setLinkDetailCard(null);
    }
    setSelectedDeviceId(device.id);
    onDeviceSelect?.(device);
  }, [onDeviceSelect, detailCard]);

  // Handle connection click (show link detail card)
  const handleConnectionClick = useCallback((connection: Connection, screenPosition: { x: number; y: number }) => {
    // If link detail card already showing for same connection, close it
    if (linkDetailCard?.connection.id === connection.id) {
      setLinkDetailCard(null);
    } else {
      // Show link detail card, hide tooltip and close device card
      setLinkDetailCard({ connection, position: screenPosition });
      setHoveredConnection(null);
      setDetailCard(null);
    }
    onConnectionSelect?.(connection);
  }, [onConnectionSelect, linkDetailCard]);

  // Handle device click for connection drawing
  const handleDeviceClickForConnection = useCallback((device: Device): boolean => {
    if (!drawingConnection) return false; // Let normal selection happen

    if (!connectionSource) {
      // First click - set source
      setConnectionSource(device);
      return true; // Handled
    } else if (device.id !== connectionSource.id) {
      // Second click - create connection
      createConnectionBetween(connectionSource, device);
      return true; // Handled
    }
    return false;
  }, [drawingConnection, connectionSource]);

  // Create connection between two devices with history tracking
  const createConnectionBetween = useCallback(async (
    source: Device,
    target: Device,
    actionSource: ActionSource = 'user'
  ) => {
    // For temporary topologies, just add connection locally
    if (isTemporary || !topologyId) {
      const newConnection: Connection = {
        id: `conn-${crypto.randomUUID()}`,
        sourceDeviceId: source.id,
        targetDeviceId: target.id,
        status: 'active',
      };
      setTopology(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          connections: [...prev.connections, newConnection],
        };
      });

      // Record in history
      const connectionLabel = `${source.name} - ${target.name}`;
      const action = pushAction({
        type: 'add_connection',
        source: actionSource,
        description: createActionDescription('add_connection', connectionLabel),
        data: {
          before: null,
          after: newConnection,
          context: { topologyId: topology?.id, connectionId: newConnection.id },
        },
      });

      if (actionSource === 'ai') {
        showAIActionToast(action);
      }

      setDrawingConnection(false);
      setConnectionSource(null);
      return;
    }

    try {
      const result = await createConnection(topologyId, {
        source_device_id: source.id,
        target_device_id: target.id,
      });

      // Refresh topology to get new connection
      const updated = await getTopology(topologyId);
      setTopology(updated);

      // Find the new connection in the updated topology
      const newConnection = updated.connections.find(c => c.id === result.id);

      // Record in history
      const connectionLabel = `${source.name} - ${target.name}`;
      const action = pushAction({
        type: 'add_connection',
        source: actionSource,
        description: createActionDescription('add_connection', connectionLabel),
        data: {
          before: null,
          after: newConnection,
          context: { topologyId, connectionId: result.id },
        },
      });

      if (actionSource === 'ai') {
        showAIActionToast(action);
      }

      // Exit drawing mode
      setDrawingConnection(false);
      setConnectionSource(null);
    } catch (err) {
      console.error('Failed to create connection:', err);
    }
  }, [topologyId, isTemporary, topology, pushAction, showAIActionToast]);

  // Delete a connection with history tracking (invoked from the link menu)
  const handleDeleteConnection = useCallback(async (
    connection: Connection,
    actionSource: ActionSource = 'user'
  ) => {
    // Get source and target device names for description
    const sourceDevice = topology?.devices.find(d => d.id === connection.sourceDeviceId);
    const targetDevice = topology?.devices.find(d => d.id === connection.targetDeviceId);
    const connectionLabel = sourceDevice && targetDevice
      ? `${sourceDevice.name} - ${targetDevice.name}`
      : connection.id;

    // For temporary topologies, just remove locally
    if (isTemporary || !topologyId) {
      setTopology(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          connections: prev.connections.filter(c => c.id !== connection.id),
        };
      });

      // Record in history
      const action = pushAction({
        type: 'remove_connection',
        source: actionSource,
        description: createActionDescription('remove_connection', connectionLabel),
        data: {
          before: connection,
          after: null,
          context: { topologyId: topology?.id, connectionId: connection.id },
        },
      });

      if (actionSource === 'ai') {
        showAIActionToast(action);
      }
      return;
    }

    try {
      await deleteConnection(topologyId, connection.id);
      // Refresh topology
      const updated = await getTopology(topologyId);
      setTopology(updated);

      // Record in history
      const action = pushAction({
        type: 'remove_connection',
        source: actionSource,
        description: createActionDescription('remove_connection', connectionLabel),
        data: {
          before: connection,
          after: null,
          context: { topologyId, connectionId: connection.id },
        },
      });

      if (actionSource === 'ai') {
        showAIActionToast(action);
      }
    } catch (err) {
      console.error('Failed to delete connection:', err);
    }
  }, [topologyId, isTemporary, topology, pushAction, showAIActionToast]);

  // Handle saving temporary topology to database
  const handleSaveTopology = useCallback(async () => {
    if (!topology || !isTemporary || saving) return;

    setSaving(true);
    try {
      const savedTopology = await saveTemporaryTopology(topology);
      onSaveTopology?.(savedTopology);
    } catch (err) {
      console.error('Failed to save topology:', err);
      showToast(`Failed to save topology: ${getErrorMessage(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [topology, isTemporary, saving, onSaveTopology]);

  // Handle saving topology snapshot to Docs for documentation/archival
  const handleSaveToDocs = useCallback(async () => {
    if (!topology || !topologyId || isTemporary || savingToDocs) return;

    setSavingToDocs(true);
    try {
      await saveTopologyToDocs(topologyId, annotations);
      showToast(`Topology "${topology.name}" exported to Docs (Backups)`, 'success');
    } catch (err) {
      console.error('Failed to save topology to Docs:', err);
      showToast(`Failed to save to Docs: ${getErrorMessage(err)}`, 'error');
    } finally {
      setSavingToDocs(false);
    }
  }, [topology, topologyId, isTemporary, savingToDocs, annotations]);

  // Handle Discover Network for traceroute topologies
  const handleDiscoverNetwork = useCallback(async () => {
    if (!topology) return;

    setIsDiscoveringNetwork(true);

    try {
      // Extract hop IPs from the topology devices
      // Traceroute topology devices have metadata.hopNumber and primaryIp
      const hops: TracerouteHop[] = topology.devices
        .filter(d => d.primaryIp && d.primaryIp !== '*')
        .map((d, i) => ({
          hopNumber: parseInt(d.metadata?.hopNumber || String(i + 1)),
          ip: d.primaryIp!,
        }));

      if (hops.length === 0) return;

      // Collect credential IDs for hop probing
      const snmpIds = snmpProfileId ? [snmpProfileId] : [];
      const credentialIds = [...new Set(
        topology.devices
          .map(d => d.metadata?.profileId || d.metadata?.credentialProfileId)
          .filter((id): id is string => Boolean(id))
      )];

      // Call the traceroute resolve API
      // Send both standalone and enterprise field names so both agent and controller can parse
      const results = await resolveTracerouteHops({
        hops,
        snmpProfileIds: snmpIds,
        credentialProfileIds: credentialIds,
        snmpCredentialIds: snmpIds,
        sshCredentialIds: credentialIds,
      });

      // Clone the topology for immutable update via setTopology
      const newDevices = [...topology.devices];
      const newConnections = [...topology.connections];

      for (const hopResult of results) {
        // Find the existing hop device in the topology
        const hopDevice = newDevices.find(d => d.primaryIp === hopResult.ip);
        if (!hopDevice) continue;

        // Update hop device with resolved parent info
        if (hopResult.parentDevice) {
          hopDevice.name = hopResult.parentDevice.hostname;
          hopDevice.platform = hopResult.parentDevice.platform || undefined;
          hopDevice.type = (hopResult.parentDevice.deviceType as Device['type']) || hopDevice.type;
        }

        // Add neighbor devices branching off the hop
        for (const neighbor of hopResult.neighbors) {
          const neighborId = `neighbor-${hopResult.hopNumber}-${neighbor.neighborName}`;

          // Skip if this neighbor already exists (by name or IP)
          if (newDevices.some(d =>
            d.id === neighborId ||
            d.name.toLowerCase() === neighbor.neighborName.toLowerCase()
          )) continue;

          // Position neighbors perpendicular to the traceroute path
          const neighborIndex = hopResult.neighbors.indexOf(neighbor);
          const sideOffset = (neighborIndex % 2 === 0 ? 1 : -1) * (80 + Math.floor(neighborIndex / 2) * 60);

          const neighborDevice: Device = {
            id: neighborId,
            name: neighbor.neighborName,
            type: 'unknown',
            status: 'unknown',
            x: hopDevice.x + sideOffset,
            y: hopDevice.y + (neighborIndex * 20),
            primaryIp: neighbor.neighborIp || undefined,
            platform: neighbor.neighborPlatform || undefined,
            isNeighbor: true,
          };

          newDevices.push(neighborDevice);

          // Add connection from hop to neighbor
          newConnections.push({
            id: `conn-${hopDevice.id}-${neighborId}`,
            sourceDeviceId: hopDevice.id,
            targetDeviceId: neighborId,
            sourceInterface: neighbor.localInterface,
            targetInterface: neighbor.neighborInterface || undefined,
            status: 'active',
            lineStyle: 'dashed',
          });
        }
      }

      // Update topology state — this triggers re-render of the canvas
      setTopology(prev => prev ? {
        ...prev,
        devices: newDevices,
        connections: newConnections,
      } : prev);

    } catch (err) {
      console.error('[TopologyTabEditor] DiscoverNetwork error:', err);
    } finally {
      setIsDiscoveringNetwork(false);
    }
  }, [topology]);

  /**
   * Execute undo action - reverses the last action
   */
  const handleUndo = useCallback(async () => {
    const action = undo();
    if (!action || !topology) return;

    logger.log('[TopologyTabEditor] Undoing action:', action.type, action.description);

    try {
      await executeHistoryAction(action, 'undo', {
        topologyId,
        isTemporary,
        setTopology,
      });
    } catch (err) {
      console.error('[TopologyTabEditor] Failed to undo:', err);
    }
  }, [undo, topology, topologyId, isTemporary]);

  /**
   * Execute redo action - re-applies the last undone action
   */
  const handleRedo = useCallback(async () => {
    const action = redo();
    if (!action || !topology) return;

    logger.log('[TopologyTabEditor] Redoing action:', action.type, action.description);

    try {
      await executeHistoryAction(action, 'redo', {
        topologyId,
        isTemporary,
        setTopology,
      });
    } catch (err) {
      console.error('[TopologyTabEditor] Failed to redo:', err);
    }
  }, [redo, topology, topologyId, isTemporary]);

  /**
   * Undo all recent AI actions
   */
  const handleUndoAllAIActions = useCallback(async () => {
    const aiActions = getRecentAIActions();
    if (aiActions.length === 0) return;

    logger.log('[TopologyTabEditor] Undoing', aiActions.length, 'AI actions');

    // Undo each AI action in reverse order
    for (let i = 0; i < aiActions.length; i++) {
      await handleUndo();
    }
  }, [getRecentAIActions, handleUndo]);

  // Tool change handler
  const handleToolChange = useCallback((tool: ToolMode) => {
    setCurrentTool(tool);
    // Reset states when switching tools
    setLinePoints([]);
    if (tool === 'connect') {
      setDrawingConnection(true);
    } else if (drawingConnection) {
      setDrawingConnection(false);
      setConnectionSource(null);
    }
  }, [drawingConnection]);

  // Device type change handler
  const handleDeviceTypeChange = useCallback((type: DevicePlacement) => {
    setDeviceTypeToPlace(type);
    if (type) {
      setCurrentTool('device');
    }
  }, []);

  // Shape type change handler
  const handleShapeTypeChange = useCallback((type: ShapeType) => {
    setShapeTypeToPlace(type);
    setCurrentTool('shape');
  }, []);

  // Layer toggle handler
  const handleLayerToggle = useCallback((layer: keyof LayerVisibility) => {
    setVisibleLayers(prev => ({
      ...prev,
      [layer]: !prev[layer],
    }));
  }, []);

  // Toggle a device visibility filter (discovery or status axis).
  const handleDeviceFilterToggle = useCallback((axis: 'discovery' | 'status', key: string) => {
    setDeviceFilters(prev => ({
      ...prev,
      [axis]: {
        ...prev[axis],
        [key]: !(prev[axis] as Record<string, boolean>)[key],
      },
    }));
  }, []);

  // Apply an auto-layout: reposition all devices in one undoable action.
  const handleApplyLayout = useCallback(async (type: LayoutType) => {
    if (!topology) return;
    const positions = computeLayout(type, topology.devices, topology.connections);
    if (positions.size === 0) return;

    // Capture before/after for a single bulk history entry.
    const before = topology.devices.map(d => ({ deviceId: d.id, x: d.x, y: d.y }));
    const after = topology.devices.map(d => {
      const np = positions.get(d.id);
      return { deviceId: d.id, x: np ? np.x : d.x, y: np ? np.y : d.y };
    });

    // Update local state immutably.
    setTopology(prev => prev ? {
      ...prev,
      devices: prev.devices.map(d => {
        const np = positions.get(d.id);
        return np ? { ...d, x: np.x, y: np.y } : d;
      }),
    } : prev);

    const layoutLabels: Record<LayoutType, string> = {
      grid: 'Grid', circular: 'Circular', hierarchical: 'Hierarchical', forceDirected: 'Force-Directed',
    };
    pushAction({
      type: 'bulk',
      source: 'user',
      description: `Auto-layout: ${layoutLabels[type]}`,
      data: { before, after, context: { topologyId: topologyId || topology.id } },
    });

    // Persist positions for saved topologies.
    if (!isTemporary && topologyId) {
      for (const pos of after) {
        try {
          await updateDevicePosition(topologyId, pos.deviceId, pos.x, pos.y);
        } catch (err) {
          console.error('Failed to persist layout position:', err);
        }
      }
    }
  }, [topology, topologyId, isTemporary, pushAction]);

  /**
   * Handle click on empty canvas space - for placing devices, shapes, etc.
   */
  const handleEmptySpaceClick = useCallback(async (
    worldPosition: { x: number; y: number },
    _screenPosition: { x: number; y: number }
  ) => {
    // Only handle device placement in device mode
    if (currentTool === 'device' && deviceTypeToPlace && topology) {
      // For temporary topologies without an ID, update local state only
      if (isTemporary || !topology.id) {
        const deviceCount = topology.devices.filter(d => d.type === deviceTypeToPlace).length + 1;
        const newDevice: Device = {
          id: `temp-${Date.now()}`,
          name: `${deviceTypeToPlace.charAt(0).toUpperCase() + deviceTypeToPlace.slice(1)}-${deviceCount}`,
          type: deviceTypeToPlace,
          status: 'unknown',
          x: worldPosition.x,
          y: worldPosition.y,
        };

        // Add to local topology
        setTopology(prev => prev ? {
          ...prev,
          devices: [...prev.devices, newDevice],
        } : null);

        // Record in history
        pushAction({
          type: 'add_device',
          source: 'user',
          description: createActionDescription('add_device', newDevice.name),
          data: {
            before: null,
            after: newDevice,
            context: { deviceId: newDevice.id },
          },
        });

        // Switch back to select tool after placing
        setCurrentTool('select');
        return;
      }

      // For saved topologies, call the API
      try {
        const deviceCount = topology.devices.filter(d => d.type === deviceTypeToPlace).length + 1;
        const deviceName = `${deviceTypeToPlace.charAt(0).toUpperCase() + deviceTypeToPlace.slice(1)}-${deviceCount}`;

        const result = await createDevice(topology.id, {
          name: deviceName,
          type: deviceTypeToPlace,
          x: worldPosition.x,
          y: worldPosition.y,
          status: 'unknown',
        });

        // Add to local topology
        const newDevice: Device = {
          id: result.id,
          name: deviceName,
          type: deviceTypeToPlace,
          status: 'unknown',
          x: worldPosition.x,
          y: worldPosition.y,
        };

        setTopology(prev => prev ? {
          ...prev,
          devices: [...prev.devices, newDevice],
        } : null);

        // Record in history
        pushAction({
          type: 'add_device',
          source: 'user',
          description: createActionDescription('add_device', deviceName),
          data: {
            before: null,
            after: newDevice,
            context: { deviceId: newDevice.id, topologyId: topology.id },
          },
        });

        // Switch back to select tool after placing
        setCurrentTool('select');
      } catch (err) {
        console.error('[TopologyTabEditor] Failed to create device:', err);
        setError(getErrorMessage(err, 'Failed to create device'));
      }
    }

    // Handle text annotation placement
    if (currentTool === 'text' && topology) {
      const textData: Omit<TextAnnotation, 'id' | 'topologyId' | 'createdAt' | 'updatedAt' | 'zIndex' | 'type'> = {
        position: { x: worldPosition.x, y: worldPosition.y },
        content: 'New Text',
        fontSize: 14,
        fontWeight: 'normal',
        color: '#ffffff',
      };

      if (isTemporary || !topology.id) {
        // For temporary topologies, add locally
        const newAnnotation: TextAnnotation = {
          id: `temp-text-${Date.now()}`,
          topologyId: topology.id || 'temp',
          type: 'text',
          zIndex: annotations.length,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...textData,
        };
        setAnnotations(prev => [...prev, newAnnotation]);
        setSelectedAnnotationId(newAnnotation.id);
      } else {
        // For saved topologies, call the API
        try {
          const created = await createAnnotation(topology.id, 'text', textData, annotations.length);
          setAnnotations(prev => [...prev, created]);
          setSelectedAnnotationId(created.id);
        } catch (err) {
          console.error('[TopologyTabEditor] Failed to create text annotation:', err);
          setError(getErrorMessage(err, 'Failed to create text'));
        }
      }
      setCurrentTool('select');
      return;
    }

    // Handle shape annotation placement
    if (currentTool === 'shape' && topology) {
      const shapeData: Omit<ShapeAnnotation, 'id' | 'topologyId' | 'createdAt' | 'updatedAt' | 'zIndex' | 'type'> = {
        shapeType: shapeTypeToPlace,
        position: { x: worldPosition.x - 50, y: worldPosition.y - 30 }, // Center on click
        size: { width: 100, height: 60 },
        strokeColor: '#4a9eff',
        strokeStyle: 'solid',
        strokeWidth: 2,
        fillColor: '#4a9eff',
        fillOpacity: 0.1,
      };

      if (isTemporary || !topology.id) {
        // For temporary topologies, add locally
        const newAnnotation: ShapeAnnotation = {
          id: `temp-shape-${Date.now()}`,
          topologyId: topology.id || 'temp',
          type: 'shape',
          zIndex: annotations.length,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...shapeData,
        };
        setAnnotations(prev => [...prev, newAnnotation]);
        setSelectedAnnotationId(newAnnotation.id);
      } else {
        // For saved topologies, call the API
        try {
          const created = await createAnnotation(topology.id, 'shape', shapeData, annotations.length);
          setAnnotations(prev => [...prev, created]);
          setSelectedAnnotationId(created.id);
        } catch (err) {
          console.error('[TopologyTabEditor] Failed to create shape annotation:', err);
          setError(getErrorMessage(err, 'Failed to create shape'));
        }
      }
      setCurrentTool('select');
      return;
    }

    // Handle line drawing - add points on click
    if (currentTool === 'line' && topology) {
      // Add point to line being drawn
      setLinePoints(prev => [...prev, { x: worldPosition.x, y: worldPosition.y }]);
    }
  }, [currentTool, deviceTypeToPlace, shapeTypeToPlace, topology, isTemporary, pushAction, annotations.length]);

  /**
   * Handle double-click on empty canvas space - for finishing line drawing
   */
  const handleEmptySpaceDoubleClick = useCallback(async (
    worldPosition: { x: number; y: number },
    _screenPosition: { x: number; y: number }
  ) => {
    // Finish line drawing on double-click
    if (currentTool === 'line' && topology && linePoints.length >= 1) {
      // Add the final point
      const allPoints = [...linePoints, { x: worldPosition.x, y: worldPosition.y }];

      const lineData: Omit<LineAnnotation, 'id' | 'topologyId' | 'createdAt' | 'updatedAt' | 'zIndex' | 'type'> = {
        points: allPoints,
        curveStyle: 'straight',
        color: '#4a9eff',
        lineStyle: 'solid',
        lineWidth: 2,
        arrowEnd: false,
      };

      if (isTemporary || !topology.id) {
        // For temporary topologies, add locally
        const newAnnotation: LineAnnotation = {
          id: `temp-line-${Date.now()}`,
          topologyId: topology.id || 'temp',
          type: 'line',
          zIndex: annotations.length,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...lineData,
        };
        setAnnotations(prev => [...prev, newAnnotation]);
        setSelectedAnnotationId(newAnnotation.id);
      } else {
        // For saved topologies, call the API
        try {
          const created = await createAnnotation(topology.id, 'line', lineData, annotations.length);
          setAnnotations(prev => [...prev, created]);
          setSelectedAnnotationId(created.id);
        } catch (err) {
          console.error('[TopologyTabEditor] Failed to create line annotation:', err);
          setError(getErrorMessage(err, 'Failed to create line'));
        }
      }

      // Reset line points and switch to select tool
      setLinePoints([]);
      setCurrentTool('select');
    }
  }, [currentTool, linePoints, topology, isTemporary, annotations.length]);

  /**
   * Handle annotation selection
   */
  const handleAnnotationSelect = useCallback((annotationId: string | null) => {
    setSelectedAnnotationId(annotationId);
    // Deselect device when selecting annotation
    if (annotationId) {
      setSelectedDeviceId(null);
    }
  }, []);

  /**
   * Handle annotation position change (drag to reposition)
   */
  const handleAnnotationPositionChange = useCallback((annotationId: string, x: number, y: number) => {
    // Update local annotations state
    setAnnotations(prev => prev.map(a => {
      if (a.id !== annotationId) return a;
      if ('position' in a) {
        return { ...a, position: { x, y } };
      }
      // For line annotations, shift all points by the delta
      if ('points' in a && a.points.length > 0) {
        const deltaX = x - a.points[0].x;
        const deltaY = y - a.points[0].y;
        return {
          ...a,
          points: a.points.map(p => ({ x: p.x + deltaX, y: p.y + deltaY })),
        };
      }
      return a;
    }));

    // Persist to backend
    if (topology) {
      updateAnnotation(topology.id, annotationId, {
        elementData: { position: { x, y } },
      }).catch(err => console.error('[TopologyTabEditor] Failed to update annotation position:', err));
    }
  }, [topology]);

  /**
   * Handle annotation size change (resize)
   */
  const handleAnnotationSizeChange = useCallback((annotationId: string, width: number, height: number, x?: number, y?: number) => {
    // Update local annotations state
    setAnnotations(prev => prev.map(a => {
      if (a.id !== annotationId) return a;
      if ('size' in a) {
        const updated = { ...a, size: { width, height } };
        // Also update position if provided
        if (x !== undefined && y !== undefined && 'position' in a) {
          return { ...updated, position: { x, y } };
        }
        return updated;
      }
      return a;
    }));

    // Persist to backend
    if (topology) {
      const updateData: { elementData: { size: { width: number; height: number }; position?: { x: number; y: number } } } = {
        elementData: { size: { width, height } },
      };
      if (x !== undefined && y !== undefined) {
        updateData.elementData.position = { x, y };
      }
      updateAnnotation(topology.id, annotationId, updateData)
        .catch(err => console.error('[TopologyTabEditor] Failed to update annotation size:', err));
    }
  }, [topology]);

  /**
   * Handle annotation property update from properties panel
   */
  const handleAnnotationPropertyUpdate = useCallback(async (updates: Partial<Annotation>) => {
    if (!selectedAnnotationId || !topology) return;

    // Update local state
    setAnnotations(prev => prev.map(a => {
      if (a.id !== selectedAnnotationId) return a;
      return { ...a, ...updates } as Annotation;
    }));

    // Persist to backend
    try {
      await updateAnnotation(topology.id, selectedAnnotationId, {
        elementData: updates,
      });
    } catch (err) {
      console.error('[TopologyTabEditor] Failed to update annotation properties:', err);
    }
  }, [selectedAnnotationId, topology]);

  /**
   * Handle deleting the selected annotation
   */
  const handleDeleteSelectedAnnotation = useCallback(async () => {
    if (!selectedAnnotationId || !topology) return;

    const annotationToDelete = annotations.find(a => a.id === selectedAnnotationId);
    if (!annotationToDelete) return;

    // Remove from local state
    setAnnotations(prev => prev.filter(a => a.id !== selectedAnnotationId));
    setSelectedAnnotationId(null);

    // Delete from backend
    try {
      await deleteAnnotation(topology.id, selectedAnnotationId);
    } catch (err) {
      console.error('[TopologyTabEditor] Failed to delete annotation:', err);
      // Restore on error
      setAnnotations(prev => [...prev, annotationToDelete]);
    }
  }, [selectedAnnotationId, topology, annotations]);

  /**
   * Handle annotation double-click to start editing
   */
  const handleAnnotationDoubleClick = useCallback((annotation: Annotation, screenPosition: { x: number; y: number }) => {
    // Only allow editing text annotations for now
    if (annotation.type === 'text') {
      const textAnnotation = annotation as TextAnnotation;
      setEditingAnnotation({ annotation: textAnnotation, screenPosition });
      setEditingText(textAnnotation.content);
      setSelectedAnnotationId(annotation.id);
    }
  }, []);

  /**
   * Handle text edit completion (blur or Enter key)
   */
  const handleTextEditComplete = useCallback(async () => {
    if (!editingAnnotation || !topology) return;

    const newText = editingText.trim();
    if (newText && newText !== editingAnnotation.annotation.content) {
      // Update local state
      setAnnotations(prev => prev.map(a => {
        if (a.id !== editingAnnotation.annotation.id) return a;
        if (a.type === 'text') {
          return { ...a, content: newText } as TextAnnotation;
        }
        return a;
      }));

      // Persist to backend
      try {
        await updateAnnotation(topology.id, editingAnnotation.annotation.id, {
          elementData: { content: newText },
        });
      } catch (err) {
        console.error('[TopologyTabEditor] Failed to update annotation:', err);
      }
    }

    setEditingAnnotation(null);
    setEditingText('');
  }, [editingAnnotation, editingText, topology]);

  /**
   * Handle text edit cancel (Escape key)
   */
  const handleTextEditCancel = useCallback(() => {
    setEditingAnnotation(null);
    setEditingText('');
  }, []);

  /**
   * Handle annotation context menu (right-click)
   */
  const handleAnnotationContextMenu = useCallback((annotation: Annotation, screenPosition: { x: number; y: number }) => {
    setSelectedAnnotationId(annotation.id);
    setAnnotationContextMenu({ annotation, position: screenPosition });
  }, []);

  /**
   * Close annotation context menu
   */
  const handleAnnotationContextMenuClose = useCallback(() => {
    setAnnotationContextMenu(null);
  }, []);

  /**
   * Handle free-space (empty canvas) right-click — offer to discuss the whole
   * topology with the AI.
   */
  const handleCanvasContextMenu = useCallback((position: { x: number; y: number }) => {
    setCanvasMenu(position);
  }, []);

  /**
   * Handle link (connection) right-click — open a menu offering AI actions and
   * delete (replaces the old delete-on-right-click behavior).
   */
  const handleConnectionContextMenu = useCallback((connection: Connection, position: { x: number; y: number }) => {
    setLinkMenu({ connection, position });
  }, []);

  /**
   * Handle annotation layer ordering - Bring to Front
   */
  const handleBringToFront = useCallback(async () => {
    if (!annotationContextMenu || !topology) return;
    const { annotation } = annotationContextMenu;

    // Find max zIndex and set this annotation higher
    const maxZIndex = Math.max(...annotations.map(a => a.zIndex), 0);
    const newZIndex = maxZIndex + 1;

    // Update local state
    setAnnotations(prev => prev.map(a =>
      a.id === annotation.id ? { ...a, zIndex: newZIndex } : a
    ));

    // Persist to backend
    try {
      await updateAnnotation(topology.id, annotation.id, { zIndex: newZIndex });
    } catch (err) {
      console.error('[TopologyTabEditor] Failed to update annotation zIndex:', err);
    }

    setAnnotationContextMenu(null);
  }, [annotationContextMenu, topology, annotations]);

  /**
   * Handle annotation layer ordering - Send to Back
   */
  const handleSendToBack = useCallback(async () => {
    if (!annotationContextMenu || !topology) return;
    const { annotation } = annotationContextMenu;

    // Find min zIndex and set this annotation lower
    const minZIndex = Math.min(...annotations.map(a => a.zIndex), 0);
    const newZIndex = minZIndex - 1;

    // Update local state
    setAnnotations(prev => prev.map(a =>
      a.id === annotation.id ? { ...a, zIndex: newZIndex } : a
    ));

    // Persist to backend
    try {
      await updateAnnotation(topology.id, annotation.id, { zIndex: newZIndex });
    } catch (err) {
      console.error('[TopologyTabEditor] Failed to update annotation zIndex:', err);
    }

    setAnnotationContextMenu(null);
  }, [annotationContextMenu, topology, annotations]);

  /**
   * Handle annotation layer ordering - Bring Forward (one step)
   */
  const handleBringForward = useCallback(async () => {
    if (!annotationContextMenu || !topology) return;
    const { annotation } = annotationContextMenu;

    // Find annotations with zIndex greater than current
    const currentZIndex = annotation.zIndex;
    const higher = annotations.filter(a => a.zIndex > currentZIndex);

    if (higher.length === 0) return; // Already at front

    // Find the next higher zIndex
    const nextHigher = Math.min(...higher.map(a => a.zIndex));
    const newZIndex = nextHigher + 1;

    // Update local state
    setAnnotations(prev => prev.map(a =>
      a.id === annotation.id ? { ...a, zIndex: newZIndex } : a
    ));

    // Persist to backend
    try {
      await updateAnnotation(topology.id, annotation.id, { zIndex: newZIndex });
    } catch (err) {
      console.error('[TopologyTabEditor] Failed to update annotation zIndex:', err);
    }

    setAnnotationContextMenu(null);
  }, [annotationContextMenu, topology, annotations]);

  /**
   * Handle annotation layer ordering - Send Backward (one step)
   */
  const handleSendBackward = useCallback(async () => {
    if (!annotationContextMenu || !topology) return;
    const { annotation } = annotationContextMenu;

    // Find annotations with zIndex less than current
    const currentZIndex = annotation.zIndex;
    const lower = annotations.filter(a => a.zIndex < currentZIndex);

    if (lower.length === 0) return; // Already at back

    // Find the next lower zIndex
    const nextLower = Math.max(...lower.map(a => a.zIndex));
    const newZIndex = nextLower - 1;

    // Update local state
    setAnnotations(prev => prev.map(a =>
      a.id === annotation.id ? { ...a, zIndex: newZIndex } : a
    ));

    // Persist to backend
    try {
      await updateAnnotation(topology.id, annotation.id, { zIndex: newZIndex });
    } catch (err) {
      console.error('[TopologyTabEditor] Failed to update annotation zIndex:', err);
    }

    setAnnotationContextMenu(null);
  }, [annotationContextMenu, topology, annotations]);

  /**
   * Handle deleting annotation from context menu
   */
  const handleDeleteAnnotationFromMenu = useCallback(async () => {
    if (!annotationContextMenu || !topology) return;
    const { annotation } = annotationContextMenu;

    // Close menu first
    setAnnotationContextMenu(null);

    // Remove from local state
    setAnnotations(prev => prev.filter(a => a.id !== annotation.id));
    setSelectedAnnotationId(null);

    // Delete from backend
    try {
      await deleteAnnotation(topology.id, annotation.id);
    } catch (err) {
      console.error('[TopologyTabEditor] Failed to delete annotation:', err);
      // Restore on error
      setAnnotations(prev => [...prev, annotation]);
    }
  }, [annotationContextMenu, topology]);

  /**
   * Handle editing annotation from context menu (text only)
   */
  const handleEditAnnotationFromMenu = useCallback(() => {
    if (!annotationContextMenu) return;
    const { annotation, position } = annotationContextMenu;

    if (annotation.type === 'text') {
      const textAnnotation = annotation as TextAnnotation;
      setEditingAnnotation({ annotation: textAnnotation, screenPosition: position });
      setEditingText(textAnnotation.content);
    }

    setAnnotationContextMenu(null);
  }, [annotationContextMenu]);

  /**
   * Escape XML special characters for SVG export
   */
  const escapeXml = (text: string): string => {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  };

  /**
   * Export topology to PNG format via native save dialog
   */
  const exportToPng = useCallback(async () => {
    const canvas = document.querySelector('.topology-tab-editor .topology-canvas') as HTMLCanvasElement;
    if (!canvas) {
      console.error('Canvas not found for export');
      return;
    }

    const defaultName = `${topology?.name || 'topology'}-${new Date().toISOString().slice(0, 10)}.png`;
    const filePath = await showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (!filePath) return;

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ctx = exportCanvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(canvas, 0, 0);

    const dataUrl = exportCanvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    await writeFile(filePath, bytes);
  }, [topology?.name]);

  /**
   * Export topology to SVG format
   * Creates SVG representation of the topology
   */
  const exportToSvg = useCallback(async () => {
    if (!topology) return;
    const view = filterTopology(topology, deviceFilters);

    const width = 1000;
    const height = 1000;
    const deviceSize = 40;

    // Build SVG content
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <style>
    .device-label { font: 11px sans-serif; fill: white; }
    .connection-line { stroke-width: 2; fill: none; }
    .connection-label { font: 10px sans-serif; fill: #4caf50; }
  </style>
  <rect width="100%" height="100%" fill="#1e1e1e"/>
`;

    // Draw grid
    svg += '  <g class="grid" stroke="#2a2a2a" stroke-width="1">\n';
    for (let i = 0; i <= 1000; i += 50) {
      svg += `    <line x1="${i}" y1="0" x2="${i}" y2="1000"/>\n`;
      svg += `    <line x1="0" y1="${i}" x2="1000" y2="${i}"/>\n`;
    }
    svg += '  </g>\n';

    // Draw connections
    svg += '  <g class="connections">\n';
    for (const conn of view.connections) {
      const source = view.devices.find(d => d.id === conn.sourceDeviceId);
      const target = view.devices.find(d => d.id === conn.targetDeviceId);
      if (!source || !target) continue;

      const color = conn.color || (conn.status === 'active' ? '#4caf50' : conn.status === 'degraded' ? '#ff9800' : '#666666');
      const dashArray = conn.lineStyle === 'dashed' ? 'stroke-dasharray="8,4"' : conn.lineStyle === 'dotted' ? 'stroke-dasharray="2,4"' : '';

      svg += `    <line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke="${color}" ${dashArray} class="connection-line"/>\n`;

      if (conn.label) {
        const midX = (source.x + target.x) / 2;
        const midY = (source.y + target.y) / 2;
        svg += `    <text x="${midX}" y="${midY}" text-anchor="middle" class="connection-label">${escapeXml(conn.label)}</text>\n`;
      }
    }
    svg += '  </g>\n';

    // Draw devices
    svg += '  <g class="devices">\n';
    for (const device of view.devices) {
      const statusColor = device.status === 'online' ? '#4caf50' : device.status === 'warning' ? '#ff9800' : device.status === 'offline' ? '#f44336' : '#888888';

      // Device icon (simplified rectangle with status indicator)
      svg += `    <g transform="translate(${device.x}, ${device.y})">\n`;
      svg += `      <rect x="${-deviceSize/2}" y="${-deviceSize/2}" width="${deviceSize}" height="${deviceSize}" fill="#2d2d2d" stroke="${statusColor}" stroke-width="2" rx="4"/>\n`;

      // Device type initial
      const typeInitial = device.type.charAt(0).toUpperCase();
      svg += `      <text x="0" y="4" text-anchor="middle" fill="${statusColor}" font-size="14" font-weight="bold">${typeInitial}</text>\n`;

      // Device label
      svg += `      <text x="0" y="${deviceSize/2 + 14}" text-anchor="middle" class="device-label">${escapeXml(device.name)}</text>\n`;
      svg += '    </g>\n';
    }
    svg += '  </g>\n';

    svg += '</svg>';

    const defaultName = `${topology.name || 'topology'}-${new Date().toISOString().slice(0, 10)}.svg`;
    const filePath = await showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'SVG Image', extensions: ['svg'] }],
    });
    if (!filePath) return;
    await writeTextFile(filePath, svg);
  }, [topology, deviceFilters]);

  /**
   * Export topology to JSON format via native save dialog
   */
  const exportToJson = useCallback(async () => {
    if (!topology) return;

    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      topology: {
        id: topology.id,
        name: topology.name,
        source: topology.source,
        createdAt: topology.createdAt,
        updatedAt: topology.updatedAt,
        devices: topology.devices.map(d => ({
          id: d.id,
          name: d.name,
          type: d.type,
          status: d.status,
          x: d.x,
          y: d.y,
          sessionId: d.sessionId,
          primaryIp: d.primaryIp,
          platform: d.platform,
          vendor: d.vendor,
          version: d.version,
          model: d.model,
          serial: d.serial,
          uptime: d.uptime,
          site: d.site,
          role: d.role,
        })),
        connections: topology.connections.map(c => ({
          id: c.id,
          sourceDeviceId: c.sourceDeviceId,
          targetDeviceId: c.targetDeviceId,
          sourceInterface: c.sourceInterface,
          targetInterface: c.targetInterface,
          status: c.status,
          label: c.label,
          waypoints: c.waypoints,
          curveStyle: c.curveStyle,
          bundleId: c.bundleId,
          bundleIndex: c.bundleIndex,
          color: c.color,
          lineStyle: c.lineStyle,
          lineWidth: c.lineWidth,
          notes: c.notes,
        })),
      },
    };

    const json = JSON.stringify(exportData, null, 2);
    const defaultName = `${topology.name || 'topology'}-${new Date().toISOString().slice(0, 10)}.json`;
    const filePath = await showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!filePath) return;
    await writeTextFile(filePath, json);
  }, [topology]);

  /**
   * Handle export request based on format
   */
  const handleExport = useCallback((format: ExportFormat) => {
    switch (format) {
      case 'png':
        exportToPng();
        break;
      case 'svg':
        exportToSvg();
        break;
      case 'json':
        exportToJson();
        break;
    }
  }, [exportToPng, exportToSvg, exportToJson]);

  // Get toolbar hint text based on current tool
  const getToolbarHint = useCallback((): string | undefined => {
    if (drawingConnection) {
      return connectionSource
        ? 'Click target device (ESC to cancel)'
        : 'Click source device (ESC to cancel)';
    }
    switch (currentTool) {
      case 'device':
        return `Click canvas to place ${deviceTypeToPlace || 'device'} (ESC to cancel)`;
      case 'text':
        return 'Click canvas to add text annotation';
      case 'shape':
        return `Click canvas to add ${shapeTypeToPlace} shape`;
      case 'line':
        return linePoints.length > 0
          ? 'Click to add points, double-click to finish'
          : 'Click to start drawing line';
      default:
        return undefined;
    }
  }, [currentTool, deviceTypeToPlace, shapeTypeToPlace, linePoints, drawingConnection, connectionSource]);

  // Keyboard shortcuts for tools
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // ESC to cancel current operation
      if (e.key === 'Escape') {
        if (drawingConnection) {
          setDrawingConnection(false);
          setConnectionSource(null);
        }
        if (linePoints.length > 0) {
          setLinePoints([]);
        }
        if (currentTool !== 'select') {
          setCurrentTool('select');
        }
        return;
      }

      // Undo: Cmd+Z / Ctrl+Z
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Redo: Cmd+Shift+Z / Ctrl+Shift+Z or Cmd+Y / Ctrl+Y
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Z' || e.key === 'y')) {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Delete/Backspace to delete selected annotation
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedAnnotationId) {
          e.preventDefault();
          handleDeleteSelectedAnnotation();
          return;
        }
      }

      // Tool shortcuts (only when no modifiers)
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        switch (e.key.toLowerCase()) {
          case 'v':
            setCurrentTool('select');
            break;
          case 'h':
            setCurrentTool('pan');
            break;
          case 'd':
            setCurrentTool('device');
            break;
          case 'c':
            handleToolChange('connect');
            break;
          case 't':
            setCurrentTool('text');
            break;
          case 's':
            setCurrentTool('shape');
            break;
          case 'l':
            setCurrentTool('line');
            break;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawingConnection, linePoints, currentTool, handleUndo, handleRedo, handleToolChange, selectedAnnotationId, handleDeleteSelectedAnnotation]);

  const filteredTopology = useMemo(
    () => topology ? filterTopology(topology, deviceFilters) : topology,
    [topology, deviceFilters],
  );

  if (loading) {
    return (
      <div className="topology-tab-editor loading">
        <div className="loading-spinner">Loading topology...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="topology-tab-editor error">
        <div className="error-message">{error}</div>
      </div>
    );
  }

  if (!topology) {
    return (
      <div className="topology-tab-editor empty">
        <div className="empty-message">Topology not found</div>
      </div>
    );
  }

  return (
    <div className="topology-tab-editor" data-testid="topology-editor">
      {/* Main editing toolbar */}
      <TopologyToolbar
        currentTool={currentTool}
        onToolChange={handleToolChange}
        deviceType={deviceTypeToPlace}
        onDeviceTypeChange={handleDeviceTypeChange}
        shapeType={shapeTypeToPlace}
        onShapeTypeChange={handleShapeTypeChange}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        visibleLayers={visibleLayers}
        onLayerToggle={handleLayerToggle}
        onExport={handleExport}
        hint={getToolbarHint()}
        onEnrichStart={handleStartEnrichment}
        enrichmentRunning={traceEnrichment?.status === 'running'}
        enrichmentSources={enrichmentSources}
        enrichableDeviceCount={topology.devices.filter(d => d.primaryIp).length}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onApplyLayout={handleApplyLayout}
        onSaveToDocs={!isTemporary && topologyId ? handleSaveToDocs : undefined}
        savingToDocs={savingToDocs}
        onSaveTopology={isTemporary && topology && topology.devices.length > 0 ? handleSaveTopology : undefined}
        savingTopology={saving}
        isLive={isLiveActive}
        onToggleLive={handleToggleLive}
        liveAvailable={liveAvailable}
        enrichmentProgress={traceEnrichment ? {
          enrichedCount: traceEnrichment.enrichedCount,
          totalCount: traceEnrichment.totalCount,
          status: traceEnrichment.status,
        } : undefined}
        isTracerouteTopology={isTemporary}
        onDiscoverNetwork={handleDiscoverNetwork}
        isDiscovering={isDiscoveringNetwork}
        deviceFilters={deviceFilters}
        onDeviceFilterToggle={handleDeviceFilterToggle}
      />

      {/* Canvas */}
      <div className="topology-canvas-container">
        {viewMode === '2d' ? (
          <TopologyCanvas
            topology={filteredTopology!}
            selectedDeviceId={selectedDeviceId}
            onDeviceClick={handleDeviceClick}
            onDeviceDoubleClick={onDeviceDoubleClick}
            onDeviceContextMenu={handleDeviceContextMenuWrapper}
            onConnectionClick={handleConnectionClick}
            onConnectionHover={handleConnectionHover}
            onDevicePositionChange={handleDevicePositionChange}
            onDeviceHover={handleDeviceHover}
            drawingConnection={drawingConnection}
            connectionSource={connectionSource}
            onDeviceClickForConnection={handleDeviceClickForConnection}
            onConnectionContextMenu={handleConnectionContextMenu}
            onCanvasContextMenu={handleCanvasContextMenu}
            linkEnrichment={linkEnrichmentMap}
            liveStats={isLiveActive ? activeLiveStats : undefined}
            deviceStats={isLiveActive ? activeDeviceStats : undefined}
            tracerouteEnrichment={traceEnrichment || undefined}
            showPortStats={showPortStats}
            visibleLayers={visibleLayers}
            onCanvasMouseDown={() => {
              // Close overlays when starting canvas interaction (enables drag even when cards are open)
              setDetailCard(null);
              setLinkDetailCard(null);
            }}
            onEmptySpaceClick={['device', 'text', 'shape', 'line'].includes(currentTool) ? handleEmptySpaceClick : undefined}
            onEmptySpaceDoubleClick={currentTool === 'line' ? handleEmptySpaceDoubleClick : undefined}
            annotations={visibleLayers.annotations ? annotations : []}
            selectedAnnotationId={selectedAnnotationId ?? undefined}
            onAnnotationSelect={handleAnnotationSelect}
            onAnnotationPositionChange={handleAnnotationPositionChange}
            onAnnotationSizeChange={handleAnnotationSizeChange}
            onAnnotationDoubleClick={handleAnnotationDoubleClick}
            onAnnotationContextMenu={handleAnnotationContextMenu}
          />
        ) : (
          <TopologyCanvas3D
            topology={filteredTopology!}
            visibleLayers={visibleLayers}
            selectedDeviceId={selectedDeviceId}
            onDeviceClick={handleDeviceClick}
            onDeviceDoubleClick={onDeviceDoubleClick}
            onDeviceContextMenu={handleDeviceContextMenuWrapper}
            onConnectionClick={handleConnectionClick}
            onDevicePositionChange={handleDevicePositionChange}
            drawingConnection={drawingConnection}
            connectionSource={connectionSource}
            onDeviceClickForConnection={handleDeviceClickForConnection}
            onCanvasContextMenu={handleCanvasContextMenu}
            liveStats={isLiveActive ? activeLiveStats : undefined}
            deviceStats={isLiveActive ? activeDeviceStats : undefined}
          />
        )}

        {/* Inline text editing overlay */}
        {editingAnnotation && (
          <div
            className="annotation-text-edit-overlay"
            style={{
              position: 'absolute',
              left: editingAnnotation.screenPosition.x,
              top: editingAnnotation.screenPosition.y,
              transform: 'translate(-50%, -50%)',
              zIndex: 1000,
            }}
          >
            <input
              type="text"
              className="annotation-text-edit-input"
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              onBlur={handleTextEditComplete}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleTextEditComplete();
                } else if (e.key === 'Escape') {
                  handleTextEditCancel();
                }
              }}
              autoFocus
              style={{
                fontSize: editingAnnotation.annotation.fontSize,
                fontWeight: editingAnnotation.annotation.fontWeight === 'bold' ? 'bold' : 'normal',
                color: editingAnnotation.annotation.color || '#ffffff',
                backgroundColor: editingAnnotation.annotation.backgroundColor || 'rgba(30, 30, 30, 0.9)',
                border: '2px solid #4a9eff',
                borderRadius: '4px',
                padding: '4px 8px',
                outline: 'none',
                minWidth: '100px',
              }}
            />
          </div>
        )}
      </div>

      {/* Annotation Properties Panel - shown when annotation is selected */}
      {selectedAnnotationId && annotations.find(a => a.id === selectedAnnotationId) && (
        <AnnotationPropertiesPanel
          annotation={annotations.find(a => a.id === selectedAnnotationId)!}
          onUpdate={handleAnnotationPropertyUpdate}
          onClose={() => setSelectedAnnotationId(null)}
        />
      )}

      {/* Device tooltip - shown on hover when detail card not open */}
      {hoveredDevice && !detailCard && (
        <DeviceTooltip
          device={hoveredDevice.device}
          enrichment={getDeviceEnrichmentForDevice(hoveredDevice.device)}
          position={hoveredDevice.position}
          visible={true}
          tracerouteEnrichment={traceEnrichment || undefined}
          deviceLiveStats={isLiveActive ? activeDeviceStats.get(hoveredDevice.device.primaryIp || '') : undefined}
        />
      )}

      {/* Device detail card - shown on click */}
      {detailCard && (
        <DeviceDetailCard
          device={detailCard.device}
          enrichment={getDeviceEnrichmentForDevice(detailCard.device)}
          interfaces={undefined}
          initialPosition={detailCard.position}
          onClose={() => setDetailCard(null)}
          onOpenTerminal={() => {
            if (onDeviceDoubleClick) {
              onDeviceDoubleClick(detailCard.device, detailCard.position);
            }
            setDetailCard(null);
          }}
          onOpenInTab={onOpenDeviceDetailTab ? () => {
            onOpenDeviceDetailTab(detailCard.device);
            setDetailCard(null);
          } : undefined}
          onSaveToDocs={onSaveDeviceToDocs ? () => {
            onSaveDeviceToDocs(detailCard.device);
          } : undefined}
          deviceLiveStats={isLiveActive ? activeDeviceStats.get(detailCard.device.primaryIp || '') : undefined}
          liveInterfaceStats={isLiveActive ? activeLiveStats : undefined}
          profile={profiles.find(p => p.id === detailCard.device.profileId) ?? null}
          connected={connectedSessions.some(s => s.host === detailCard.device.primaryIp || s.id === detailCard.device.sessionId)}
        />
      )}

      {/* Link tooltip - shown on connection hover when link detail card not open */}
      {hoveredConnection && !linkDetailCard && topology && (() => {
        const sourceDevice = topology.devices.find(d => d.id === hoveredConnection.connection.sourceDeviceId);
        const targetDevice = topology.devices.find(d => d.id === hoveredConnection.connection.targetDeviceId);
        if (!sourceDevice || !targetDevice) return null;
        // Look up LibreNMS port stats keyed by hostname::port (lowercased).
        // Try source side first — that's where the LibreNMS link record sits.
        let portStats: LinkPortStats | undefined;
        if (showPortStats && traceEnrichment?.linkStats) {
          const ls = traceEnrichment.linkStats;
          const srcKey = sourceDevice.name && hoveredConnection.connection.sourceInterface
            ? `${sourceDevice.name.toLowerCase()}::${hoveredConnection.connection.sourceInterface.toLowerCase()}`
            : undefined;
          const tgtKey = targetDevice.name && hoveredConnection.connection.targetInterface
            ? `${targetDevice.name.toLowerCase()}::${hoveredConnection.connection.targetInterface.toLowerCase()}`
            : undefined;
          portStats = (srcKey && ls.get(srcKey)) || (tgtKey && ls.get(tgtKey)) || undefined;
        }
        return (
          <LinkTooltip
            connection={hoveredConnection.connection}
            sourceDevice={sourceDevice}
            targetDevice={targetDevice}
            linkEnrichment={getLinkEnrichmentWithFallback(hoveredConnection.connection, sourceDevice, targetDevice)}
            portStats={portStats}
            portStatsRequested={showPortStats}
            position={hoveredConnection.position}
            visible={true}
          />
        );
      })()}

      {/* Link detail card - shown on connection click */}
      {linkDetailCard && topology && (() => {
        const sourceDevice = topology.devices.find(d => d.id === linkDetailCard.connection.sourceDeviceId);
        const targetDevice = topology.devices.find(d => d.id === linkDetailCard.connection.targetDeviceId);
        if (!sourceDevice || !targetDevice) return null;
        return (
          <LinkDetailCard
            connection={linkDetailCard.connection}
            sourceDevice={sourceDevice}
            targetDevice={targetDevice}
            linkEnrichment={getLinkEnrichmentWithFallback(linkDetailCard.connection, sourceDevice, targetDevice)}
            initialPosition={linkDetailCard.position}
            onClose={() => setLinkDetailCard(null)}
            onOpenInTab={onOpenLinkDetailTab ? () => {
              onOpenLinkDetailTab(linkDetailCard.connection, sourceDevice, targetDevice);
              setLinkDetailCard(null);
            } : undefined}
            onSaveToDocs={onSaveLinkToDocs ? () => {
              onSaveLinkToDocs(linkDetailCard.connection, sourceDevice, targetDevice);
            } : undefined}
          />
        );
      })()}

      {/* Collection Dialog for data import */}
      {topologyId && (
        <CollectionDialog
          isOpen={collectionDialogOpen}
          onClose={() => setCollectionDialogOpen(false)}
          topologyId={topologyId}
          connectedSessions={connectedSessions}
          runCommand={runCommand}
          onCollectionComplete={async (result: CollectionResult) => {
            logger.log('[TopologyTabEditor] Collection complete:', result);
            // Refresh topology to show imported devices/connections
            if (result.devicesAdded > 0 || result.connectionsAdded > 0) {
              try {
                const updated = await getTopology(topologyId);
                setTopology(updated);
              } catch (err) {
                console.error('Failed to refresh topology after collection:', err);
              }
            }
          }}
        />
      )}

      {/* AI Action Toast - shows when AI modifies topology */}
      {aiActionToast && (
        <div className="ai-action-toast">
          <div className="toast-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div className="toast-content">
            <span className="toast-source">AI</span>
            <span className="toast-description">{aiActionToast.description}</span>
          </div>
          <button
            className="toast-undo-btn"
            onClick={() => {
              handleUndo();
              dismissToast();
            }}
          >
            Undo
          </button>
          <button
            className="toast-dismiss-btn"
            onClick={dismissToast}
            title="Dismiss"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Undo All AI Actions button - shown when there are recent AI actions */}
      {hasUndoableAIActions && !aiActionToast && (
        <button
          className="undo-all-ai-btn"
          onClick={handleUndoAllAIActions}
          title={`Undo ${getRecentAIActions().length} AI changes`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M3 10h10a5 5 0 015 5v0a5 5 0 01-5 5H8" />
            <path d="M7 6l-4 4 4 4" />
          </svg>
          Undo AI Changes ({getRecentAIActions().length})
        </button>
      )}

      {/* Annotation context menu for edit, delete, and layer ordering */}
      <ContextMenu
        position={annotationContextMenu?.position ?? null}
        items={annotationContextMenu ? getAnnotationMenuItems(
          annotationContextMenu.annotation.type,
          handleEditAnnotationFromMenu,
          handleDeleteAnnotationFromMenu,
          handleBringToFront,
          handleBringForward,
          handleSendBackward,
          handleSendToBack
        ) : []}
        onClose={handleAnnotationContextMenuClose}
      />

      {/* Free-space context menu — discuss the whole topology with the AI */}
      <ContextMenu
        position={canvasMenu}
        items={[
          {
            id: 'discuss-topology-ai',
            label: 'Discuss this topology with AI',
            action: () => {
              onDiscussTopologyWithAI?.();
              setCanvasMenu(null);
            },
          },
        ]}
        onClose={() => setCanvasMenu(null)}
      />

      {/* Link context menu — Ask AI about / why erroring, and Delete */}
      <ContextMenu
        position={linkMenu?.position ?? null}
        items={linkMenu ? [
          {
            id: 'link-ask-ai-errors',
            label: 'Ask AI: why is this link erroring?',
            action: () => {
              onAskAIAboutElement?.('link', linkMenu.connection.id);
              setLinkMenu(null);
            },
          },
          {
            id: 'link-ask-ai-about',
            label: 'Ask AI about this link',
            action: () => {
              onAskAIAboutElement?.('link', linkMenu.connection.id);
              setLinkMenu(null);
            },
          },
          { id: 'link-divider', label: '', divider: true, action: () => {} },
          {
            id: 'link-delete',
            label: 'Delete link',
            action: () => {
              void handleDeleteConnection(linkMenu.connection);
              setLinkMenu(null);
            },
          },
        ] : []}
        onClose={() => setLinkMenu(null)}
      />
    </div>
  );
}
