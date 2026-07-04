/**
 * TopologyToolbar - VS Code-style editing toolbar for topology canvas
 *
 * Provides tool selection, undo/redo, layer visibility, and export controls.
 */

import { useState } from 'react';
import type { DeviceType } from '../types/topology';
import type { DeviceFilterState } from '../types/topology';
import type { ShapeType } from '../types/annotations';
import type { TopologyEnrichmentOptions } from '../types/tracerouteEnrichment';
import type { LayoutType } from '../lib/topologyLayout';
import { useMultipleDropdowns } from '../hooks/useDropdown';
import { useCapabilitiesStore } from '../stores/capabilitiesStore';
import './TopologyToolbar.css';

/** Dropdown keys for the toolbar */
const DROPDOWN_KEYS = ['device', 'shape', 'layers', 'export', 'enrich', 'layout'] as const;
type DropdownKey = typeof DROPDOWN_KEYS[number];

/** Enrichment source info passed from parent */
export interface EnrichmentSources {
  netbox: Array<{ id: string; name: string }>;
  netstacksCrawler: Array<{ id: string; name: string }>;
  librenms: Array<{ id: string; name: string }>;
  mcp: Array<{ id: string; name: string; toolCount: number }>;
}

/** Available editing tool modes */
export type ToolMode = 'select' | 'pan' | 'device' | 'connect' | 'text' | 'shape' | 'line';

/** Device placement type (null when not placing) */
export type DevicePlacement = DeviceType | null;

/** Layer visibility configuration */
export interface LayerVisibility {
  devices: boolean;
  connections: boolean;
  annotations: boolean;
  grid: boolean;
}

/** Export format options */
export type ExportFormat = 'png' | 'svg' | 'json';

/** View mode type */
export type ViewMode = '2d' | '3d';

/** Toolbar component props */
export interface TopologyToolbarProps {
  /** Current selected tool mode */
  currentTool: ToolMode;
  /** Callback when tool changes */
  onToolChange: (tool: ToolMode) => void;
  /** Current device type to place (when in device mode) */
  deviceType: DevicePlacement;
  /** Callback when device type changes */
  onDeviceTypeChange: (type: DevicePlacement) => void;
  /** Current shape type to place (when in shape mode) */
  shapeType: ShapeType;
  /** Callback when shape type changes */
  onShapeTypeChange: (type: ShapeType) => void;
  /** Undo callback */
  onUndo: () => void;
  /** Redo callback */
  onRedo: () => void;
  /** Whether undo is available */
  canUndo: boolean;
  /** Whether redo is available */
  canRedo: boolean;
  /** Current layer visibility state */
  visibleLayers: LayerVisibility;
  /** Callback when layer visibility toggles */
  onLayerToggle: (layer: keyof LayerVisibility) => void;
  /** Export callback */
  onExport: (format: ExportFormat) => void;
  /** Hint text to display in center */
  hint?: string;
  /** Callback to start enrichment with selected options */
  onEnrichStart?: (options: TopologyEnrichmentOptions) => void;
  /** Whether enrichment is currently running (disables button) */
  enrichmentRunning?: boolean;
  /** Available enrichment sources (loaded by parent) */
  enrichmentSources?: EnrichmentSources;
  /** Number of devices with IP addresses (enrichable) */
  enrichableDeviceCount?: number;
  /** Current view mode (2D or 3D) */
  viewMode?: ViewMode;
  /** Callback when view mode changes */
  onViewModeChange?: (mode: ViewMode) => void;
  /** Callback to apply an auto-layout to the topology */
  onApplyLayout?: (type: LayoutType) => void;
  /** Callback to save topology to docs */
  onSaveToDocs?: () => void;
  /** Whether save to docs is in progress */
  savingToDocs?: boolean;
  /** Callback to save temporary topology */
  onSaveTopology?: () => void;
  /** Whether saving topology is in progress */
  savingTopology?: boolean;
  /** Whether live SNMP polling is active */
  isLive?: boolean;
  /** Callback to toggle live mode */
  onToggleLive?: () => void;
  /** Whether live mode is available (has SNMP-capable devices) */
  liveAvailable?: boolean;
  /** Enrichment progress */
  enrichmentProgress?: {
    enrichedCount: number;
    totalCount: number;
    status: 'idle' | 'running' | 'complete' | 'error';
  };
  /** Callback to run network discovery on traceroute hops */
  onDiscoverNetwork?: () => void;
  /** Whether the topology is traceroute-sourced (shows Discover Network button) */
  isTracerouteTopology?: boolean;
  /** Whether discovery is currently running */
  isDiscovering?: boolean;
  /** Current device visibility filters (discovery + status axes) */
  deviceFilters?: DeviceFilterState;
  /** Toggle a device filter value */
  onDeviceFilterToggle?: (axis: 'discovery' | 'status', key: string) => void;
}

/** All device types with display labels */
const DEVICE_TYPES: { type: DeviceType; label: string; icon: string }[] = [
  { type: 'router', label: 'Router', icon: 'R' },
  { type: 'switch', label: 'Switch', icon: 'S' },
  { type: 'firewall', label: 'Firewall', icon: 'F' },
  { type: 'server', label: 'Server', icon: 'Sv' },
  { type: 'cloud', label: 'Cloud', icon: 'C' },
  { type: 'access-point', label: 'Access Point', icon: 'AP' },
  { type: 'load-balancer', label: 'Load Balancer', icon: 'LB' },
  { type: 'wan-optimizer', label: 'WAN Optimizer', icon: 'WO' },
  { type: 'voice-gateway', label: 'Voice Gateway', icon: 'VG' },
  { type: 'wireless-controller', label: 'Wireless Controller', icon: 'WC' },
  { type: 'storage', label: 'Storage', icon: 'St' },
  { type: 'virtual', label: 'Virtual', icon: 'VM' },
  { type: 'sd-wan', label: 'SD-WAN', icon: 'SD' },
  { type: 'iot', label: 'IoT', icon: 'IoT' },
  { type: 'unknown', label: 'Unknown', icon: '?' },
];

/** Shape types with display labels */
const SHAPE_TYPES: { type: ShapeType; label: string }[] = [
  { type: 'rectangle', label: 'Rectangle' },
  { type: 'circle', label: 'Circle' },
  { type: 'diamond', label: 'Diamond' },
  { type: 'arrow', label: 'Arrow' },
  { type: 'cloud', label: 'Cloud' },
];

/** Layer names with display labels */
const LAYERS: { key: keyof LayerVisibility; label: string }[] = [
  { key: 'devices', label: 'Devices' },
  { key: 'connections', label: 'Connections' },
  { key: 'annotations', label: 'Annotations' },
  { key: 'grid', label: 'Grid' },
];

/** Auto-layout formats with display labels. */
const LAYOUTS: { type: LayoutType; label: string }[] = [
  { type: 'hierarchical', label: 'Hierarchical' },
  { type: 'forceDirected', label: 'Force-Directed' },
  { type: 'circular', label: 'Circular' },
  { type: 'grid', label: 'Grid' },
];

/** Inline enrich dropdown sub-component */
function EnrichDropdown({
  dropdown,
  enrichmentRunning,
  enrichmentSources,
  enrichableDeviceCount,
  onEnrichStart,
}: {
  dropdown: ReturnType<typeof useMultipleDropdowns<DropdownKey>>;
  enrichmentRunning: boolean;
  enrichmentSources?: EnrichmentSources;
  enrichableDeviceCount: number;
  onEnrichStart: (options: TopologyEnrichmentOptions) => void;
}) {
  // Toggle state for sources
  const [enableDns, setEnableDns] = useState(true);
  const [enableWhois, setEnableWhois] = useState(true);
  // Off by default — neighbor discovery makes a fresh SNMP round-trip per
  // device (slow on a large topology) and only adds value when CDP/LLDP
  // is actually enabled on the network.
  const [discoverNeighbors, setDiscoverNeighbors] = useState(false);
  // Off by default — port-stat enrichment hits /api/v0/ports/{id} per link
  // and only makes sense when a LibreNMS source is selected. When on, the
  // canvas colorizes edges by utilization and the hover tooltip shows
  // per-port rates/errors/speed.
  const [enableLinkStats, setEnableLinkStats] = useState(false);
  const [selectedNetbox, setSelectedNetbox] = useState<Set<string>>(new Set());
  const [selectedNetStacksCrawler, setSelectedNetStacksCrawler] = useState<Set<string>>(new Set());
  const [selectedLibrenms, setSelectedLibrenms] = useState<Set<string>>(new Set());
  const [selectedMcp, setSelectedMcp] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);

  // Pre-select all sources when they first load
  if (enrichmentSources && !initialized) {
    const nbIds = new Set(enrichmentSources.netbox.map(s => s.id));
    const ndIds = new Set(enrichmentSources.netstacksCrawler.map(s => s.id));
    const lnmsIds = new Set(enrichmentSources.librenms.map(s => s.id));
    const mcpIds = new Set(enrichmentSources.mcp.map(s => s.id));
    if (nbIds.size > 0 || ndIds.size > 0 || lnmsIds.size > 0 || mcpIds.size > 0 ||
        enrichmentSources.netbox.length === 0) {
      setSelectedNetbox(nbIds);
      setSelectedNetStacksCrawler(ndIds);
      setSelectedLibrenms(lnmsIds);
      setSelectedMcp(mcpIds);
      setInitialized(true);
    }
  }

  const toggle = (set: Set<string>, id: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  const hasIntegrations = enrichmentSources && (
    enrichmentSources.netbox.length > 0 ||
    enrichmentSources.netstacksCrawler.length > 0 ||
    enrichmentSources.librenms.length > 0
  );
  const hasMcp = enrichmentSources && enrichmentSources.mcp.length > 0;

  const handleRun = () => {
    onEnrichStart({
      enableDns,
      enableWhois,
      discoverNeighbors,
      // Only request port-stat enrichment when at least one LibreNMS source
      // is selected — otherwise it's a no-op that confuses the user.
      enableLinkStats: enableLinkStats && selectedLibrenms.size > 0,
      netboxConfigs: undefined, // Parent will resolve tokens from IDs
      netstacksCrawlerSourceIds: selectedNetStacksCrawler.size > 0 ? Array.from(selectedNetStacksCrawler) : undefined,
      librenmsSourceIds: selectedLibrenms.size > 0 ? Array.from(selectedLibrenms) : undefined,
      // netboxIds and mcpServerIds are passed as custom fields; parent resolves them
      _selectedNetboxIds: Array.from(selectedNetbox),
      _selectedMcpIds: Array.from(selectedMcp),
    } as TopologyEnrichmentOptions & { _selectedNetboxIds: string[]; _selectedMcpIds: string[] });
    dropdown.close('enrich');
  };

  return (
    <div className="toolbar-dropdown-wrapper" ref={dropdown.getRef('enrich')}>
      <button
        className={`toolbar-tool-btn toolbar-enrich-btn ${enrichmentRunning ? 'running' : ''} ${dropdown.isOpen('enrich') ? 'active' : ''}`}
        onClick={() => !enrichmentRunning && dropdown.toggle('enrich')}
        disabled={enrichmentRunning}
        title="Enrich topology devices with DNS, WHOIS, NetBox, and more"
      >
        {enrichmentRunning ? (
          <span className="toolbar-enrich-spinner" />
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        )}
        <span className="toolbar-enrich-label">
          {enrichmentRunning ? 'Enriching...' : 'Enrich'}
        </span>
        {!enrichmentRunning && (
          <svg className="dropdown-arrow" viewBox="0 0 12 12" width="8" height="8">
            <path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        )}
      </button>

      {dropdown.isOpen('enrich') && (
        <div className="toolbar-dropdown toolbar-enrich-dropdown">
          {/* Lookups section */}
          <div className="enrich-section">
            <div className="enrich-section-label">Lookups</div>
            <label className="enrich-check-item">
              <input type="checkbox" checked={enableDns} onChange={() => setEnableDns(!enableDns)} />
              <span>DNS Reverse</span>
            </label>
            <label className="enrich-check-item">
              <input type="checkbox" checked={enableWhois} onChange={() => setEnableWhois(!enableWhois)} />
              <span>WHOIS / ASN</span>
            </label>
          </div>

          {/* Topology expansion section */}
          <div className="enrich-section">
            <div className="enrich-section-label">Topology</div>
            <label className="enrich-check-item" title="Run SNMP LLDP/CDP discovery on each device with a profile and add any neighbors as new nodes (1 hop)">
              <input type="checkbox" checked={discoverNeighbors} onChange={() => setDiscoverNeighbors(!discoverNeighbors)} />
              <span>Discover neighbors (1 hop)</span>
            </label>
            <label
              className="enrich-check-item"
              title={selectedLibrenms.size === 0
                ? 'Select a LibreNMS source above to enable port stats'
                : 'Fetch per-port utilization/errors/speed from LibreNMS and colorize edges'}
            >
              <input
                type="checkbox"
                checked={enableLinkStats}
                disabled={selectedLibrenms.size === 0}
                onChange={() => setEnableLinkStats(!enableLinkStats)}
              />
              <span>Show port stats (LibreNMS)</span>
            </label>
          </div>

          {/* Integrations section */}
          {hasIntegrations && (
            <div className="enrich-section">
              <div className="enrich-section-label">Integrations</div>
              {enrichmentSources!.netbox.map(src => (
                <label key={src.id} className="enrich-check-item">
                  <input
                    type="checkbox"
                    checked={selectedNetbox.has(src.id)}
                    onChange={() => toggle(selectedNetbox, src.id, setSelectedNetbox)}
                  />
                  <span>NetBox: {src.name}</span>
                </label>
              ))}
              {enrichmentSources!.netstacksCrawler.map(src => (
                <label key={src.id} className="enrich-check-item">
                  <input
                    type="checkbox"
                    checked={selectedNetStacksCrawler.has(src.id)}
                    onChange={() => toggle(selectedNetStacksCrawler, src.id, setSelectedNetStacksCrawler)}
                  />
                  <span>NetStacks-Crawler: {src.name}</span>
                </label>
              ))}
              {enrichmentSources!.librenms.map(src => (
                <label key={src.id} className="enrich-check-item">
                  <input
                    type="checkbox"
                    checked={selectedLibrenms.has(src.id)}
                    onChange={() => toggle(selectedLibrenms, src.id, setSelectedLibrenms)}
                  />
                  <span>LibreNMS: {src.name}</span>
                </label>
              ))}
            </div>
          )}

          {/* MCP section */}
          {hasMcp && (
            <div className="enrich-section">
              <div className="enrich-section-label">MCP Servers</div>
              {enrichmentSources!.mcp.map(srv => (
                <label key={srv.id} className="enrich-check-item">
                  <input
                    type="checkbox"
                    checked={selectedMcp.has(srv.id)}
                    onChange={() => toggle(selectedMcp, srv.id, setSelectedMcp)}
                  />
                  <span>{srv.name}</span>
                  <span className="enrich-tool-count">{srv.toolCount} tools</span>
                </label>
              ))}
            </div>
          )}

          {/* Footer */}
          <div className="enrich-dropdown-footer">
            <span className="enrich-device-count">{enrichableDeviceCount} devices</span>
            <button
              className="enrich-run-btn"
              onClick={handleRun}
              disabled={enrichableDeviceCount === 0}
            >
              Run Enrichment
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TopologyToolbar({
  currentTool,
  onToolChange,
  deviceType,
  onDeviceTypeChange,
  shapeType,
  onShapeTypeChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  visibleLayers,
  onLayerToggle,
  onExport,
  hint,
  onEnrichStart,
  enrichmentRunning = false,
  enrichmentSources,
  enrichableDeviceCount = 0,
  viewMode = '2d',
  onViewModeChange,
  onApplyLayout,
  onSaveToDocs,
  savingToDocs = false,
  onSaveTopology,
  savingTopology = false,
  isLive = false,
  onToggleLive,
  liveAvailable = false,
  enrichmentProgress,
  onDiscoverNetwork,
  isTracerouteTopology = false,
  isDiscovering = false,
  deviceFilters,
  onDeviceFilterToggle,
}: TopologyToolbarProps) {
  // Consolidated dropdown state management with click-outside handling
  const dropdown = useMultipleDropdowns<DropdownKey>(DROPDOWN_KEYS);
  const hasIntegrations = useCapabilitiesStore((s) => s.hasFeature('local_integrations'));

  const handleDeviceSelect = (type: DeviceType) => {
    onDeviceTypeChange(type);
    onToolChange('device');
    dropdown.close('device');
  };

  const handleShapeSelect = (type: ShapeType) => {
    onShapeTypeChange(type);
    onToolChange('shape');
    dropdown.close('shape');
  };

  const handleExportSelect = (format: ExportFormat) => {
    onExport(format);
    dropdown.close('export');
  };

  return (
    <div className="topology-toolbar-container">
      {/* View Mode Toggle */}
      {onViewModeChange && (
        <>
          <div className="toolbar-group view-toggle-group">
            <button
              className={`toolbar-view-btn ${viewMode === '2d' ? 'active' : ''}`}
              onClick={() => onViewModeChange('2d')}
              title="2D View"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
              <span>2D</span>
            </button>
            <button
              className={`toolbar-view-btn ${viewMode === '3d' ? 'active' : ''}`}
              onClick={() => onViewModeChange('3d')}
              title="3D View"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
              <span>3D</span>
            </button>
          </div>
          <div className="toolbar-divider" />
        </>
      )}

      {/* Auto-Layout Dropdown */}
      {onApplyLayout && (
        <>
          <div className="toolbar-group">
            <div className="toolbar-dropdown-wrapper" ref={dropdown.getRef('layout')}>
              <button
                className="toolbar-tool-btn has-dropdown"
                onClick={() => dropdown.toggle('layout')}
                title="Auto-layout"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                  <circle cx="5" cy="6" r="2" />
                  <circle cx="19" cy="6" r="2" />
                  <circle cx="12" cy="18" r="2" />
                  <path d="M7 6h10M6 8l5 8M18 8l-5 8" />
                </svg>
                <svg className="dropdown-arrow" viewBox="0 0 12 12" width="8" height="8">
                  <path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
              {dropdown.isOpen('layout') && (
                <div className="toolbar-dropdown">
                  {LAYOUTS.map(({ type, label }) => (
                    <button
                      key={type}
                      className="dropdown-item"
                      onClick={() => { onApplyLayout(type); dropdown.close('layout'); }}
                    >
                      <span className="dropdown-label">{label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="toolbar-divider" />
        </>
      )}

      {/* Tool Selection Group */}
      <div className="toolbar-group">
        {/* Select Tool */}
        <button
          className={`toolbar-tool-btn ${currentTool === 'select' ? 'active' : ''}`}
          onClick={() => onToolChange('select')}
          title="Select (V)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M4 4l7 18 3-8 8-3L4 4z" />
          </svg>
        </button>

        {/* Pan Tool */}
        <button
          className={`toolbar-tool-btn ${currentTool === 'pan' ? 'active' : ''}`}
          onClick={() => onToolChange('pan')}
          title="Pan (H)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M18 11V6a2 2 0 00-2-2 2 2 0 00-2 2v0M14 10V4a2 2 0 00-2-2 2 2 0 00-2 2v2M10 10.5V6a2 2 0 00-2-2 2 2 0 00-2 2v8" />
            <path d="M18 8a2 2 0 114 0v6a8 8 0 01-8 8h-2c-2.8 0-4.5-.9-5.5-2.3A3 3 0 016 18v-.5" />
          </svg>
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* Device/Connect Group */}
      <div className="toolbar-group">
        {/* Device Tool with Dropdown */}
        <div className="toolbar-dropdown-wrapper" ref={dropdown.getRef('device')}>
          <button
            className={`toolbar-tool-btn has-dropdown ${currentTool === 'device' ? 'active' : ''}`}
            onClick={() => dropdown.toggle('device')}
            title="Device (D)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <rect x="2" y="2" width="20" height="20" rx="2" />
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
            </svg>
            <svg className="dropdown-arrow" viewBox="0 0 12 12" width="8" height="8">
              <path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          {dropdown.isOpen('device') && (
            <div className="toolbar-dropdown">
              {DEVICE_TYPES.map(({ type, label, icon }) => (
                <button
                  key={type}
                  className={`dropdown-item ${deviceType === type ? 'selected' : ''}`}
                  onClick={() => handleDeviceSelect(type)}
                >
                  <span className="dropdown-icon">{icon}</span>
                  <span className="dropdown-label">{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Connect Tool */}
        <button
          className={`toolbar-tool-btn ${currentTool === 'connect' ? 'active' : ''}`}
          onClick={() => onToolChange('connect')}
          title="Connect (C)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <circle cx="5" cy="12" r="3" />
            <circle cx="19" cy="12" r="3" />
            <path d="M8 12h8" />
          </svg>
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* Annotation Group */}
      <div className="toolbar-group">
        {/* Text Tool */}
        <button
          className={`toolbar-tool-btn ${currentTool === 'text' ? 'active' : ''}`}
          onClick={() => onToolChange('text')}
          title="Text (T)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M4 7V4h16v3M9 20h6M12 4v16" />
          </svg>
        </button>

        {/* Shape Tool with Dropdown */}
        <div className="toolbar-dropdown-wrapper" ref={dropdown.getRef('shape')}>
          <button
            className={`toolbar-tool-btn has-dropdown ${currentTool === 'shape' ? 'active' : ''}`}
            onClick={() => dropdown.toggle('shape')}
            title="Shape (S)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
            <svg className="dropdown-arrow" viewBox="0 0 12 12" width="8" height="8">
              <path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          {dropdown.isOpen('shape') && (
            <div className="toolbar-dropdown">
              {SHAPE_TYPES.map(({ type, label }) => (
                <button
                  key={type}
                  className={`dropdown-item ${shapeType === type ? 'selected' : ''}`}
                  onClick={() => handleShapeSelect(type)}
                >
                  <span className="dropdown-icon">
                    {type === 'rectangle' && (
                      <svg viewBox="0 0 16 16" width="14" height="14">
                        <rect x="2" y="4" width="12" height="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    )}
                    {type === 'circle' && (
                      <svg viewBox="0 0 16 16" width="14" height="14">
                        <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    )}
                    {type === 'diamond' && (
                      <svg viewBox="0 0 16 16" width="14" height="14">
                        <path d="M8 2L14 8L8 14L2 8Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    )}
                    {type === 'arrow' && (
                      <svg viewBox="0 0 16 16" width="14" height="14">
                        <path d="M2 8h10M9 5l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    )}
                    {type === 'cloud' && (
                      <svg viewBox="0 0 16 16" width="14" height="14">
                        <path d="M4 11a3 3 0 110-5 4 4 0 017.5-1A2.5 2.5 0 0113 11H4z" fill="none" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    )}
                  </span>
                  <span className="dropdown-label">{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Line Tool */}
        <button
          className={`toolbar-tool-btn ${currentTool === 'line' ? 'active' : ''}`}
          onClick={() => onToolChange('line')}
          title="Line (L)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M4 20L20 4" />
          </svg>
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* Undo/Redo Group */}
      <div className="toolbar-group">
        <button
          className="toolbar-tool-btn"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Cmd+Z)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M3 10h10a5 5 0 015 5v0a5 5 0 01-5 5H8" />
            <path d="M7 6l-4 4 4 4" />
          </svg>
        </button>

        <button
          className="toolbar-tool-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Cmd+Shift+Z)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M21 10H11a5 5 0 00-5 5v0a5 5 0 005 5h5" />
            <path d="M17 6l4 4-4 4" />
          </svg>
        </button>
      </div>

      {/* Center hint area */}
      <div className="toolbar-center-hint">
        {enrichmentProgress && enrichmentProgress.status === 'running' ? (
          <span className="toolbar-enrichment-progress">
            <span className="toolbar-enrichment-spinner" />
            Enriching... {enrichmentProgress.enrichedCount}/{enrichmentProgress.totalCount} devices
            <span
              className="toolbar-enrichment-bar"
              style={{
                width: `${(enrichmentProgress.enrichedCount / Math.max(enrichmentProgress.totalCount, 1)) * 100}%`,
              }}
            />
          </span>
        ) : enrichmentProgress && enrichmentProgress.status === 'complete' ? (
          <span className="toolbar-enrichment-done">
            Enriched {enrichmentProgress.totalCount} devices
          </span>
        ) : hint ? (
          <span className="toolbar-hint-text">{hint}</span>
        ) : null}
      </div>

      {/* Right-side actions */}
      <div className="toolbar-group toolbar-right-actions">
        {/* Discover Network Button (traceroute topologies only, professional+) */}
        {isTracerouteTopology && onDiscoverNetwork && hasIntegrations && (
          <button
            className="toolbar-tool-btn has-dropdown"
            onClick={onDiscoverNetwork}
            disabled={isDiscovering}
            title="Discover neighbors for each hop along the traceroute path"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16">
              <circle cx="12" cy="12" r="3" />
              <circle cx="12" cy="12" r="7" opacity="0.5" />
              <circle cx="12" cy="12" r="11" opacity="0.25" />
            </svg>
            <span style={{ fontSize: '11px', marginLeft: '3px', whiteSpace: 'nowrap' }}>
              {isDiscovering ? 'Discovering...' : 'Discover'}
            </span>
          </button>
        )}

        {/* Live SNMP Toggle (professional+) */}
        {onToggleLive && liveAvailable && hasIntegrations && (
          <button
            className={`toolbar-tool-btn toolbar-live-btn ${isLive ? 'active' : ''}`}
            onClick={onToggleLive}
            title={isLive ? 'Stop live SNMP polling' : 'Start live SNMP polling'}
          >
            {isLive && <span className="toolbar-live-dot" />}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
              <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4" />
              <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4" />
              <path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
            </svg>
            <span className="toolbar-live-label">Live</span>
          </button>
        )}

        {/* Enrich Button with Dropdown (professional+) */}
        {onEnrichStart && hasIntegrations && (
          <EnrichDropdown
            dropdown={dropdown}
            enrichmentRunning={enrichmentRunning}
            enrichmentSources={enrichmentSources}
            enrichableDeviceCount={enrichableDeviceCount}
            onEnrichStart={onEnrichStart}
          />
        )}

        {/* Layers Dropdown */}
        <div className="toolbar-dropdown-wrapper" ref={dropdown.getRef('layers')}>
          <button
            className="toolbar-tool-btn has-dropdown"
            onClick={() => dropdown.toggle('layers')}
            title="Layers"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
            <svg className="dropdown-arrow" viewBox="0 0 12 12" width="8" height="8">
              <path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          {dropdown.isOpen('layers') && (
            <div className="toolbar-dropdown layers-dropdown">
              {LAYERS.map(({ key, label }) => (
                <label key={key} className="dropdown-item checkbox-item">
                  <input
                    type="checkbox"
                    checked={visibleLayers[key]}
                    onChange={() => onLayerToggle(key)}
                  />
                  <span className="dropdown-label">{label}</span>
                </label>
              ))}
              {deviceFilters && onDeviceFilterToggle && (
                <>
                  <div className="dropdown-section-label">Discovery</div>
                  <label className="dropdown-item checkbox-item">
                    <input
                      type="checkbox"
                      checked={deviceFilters.discovery.managed}
                      onChange={() => onDeviceFilterToggle('discovery', 'managed')}
                    />
                    <span className="dropdown-label">Managed</span>
                  </label>
                  <label className="dropdown-item checkbox-item">
                    <input
                      type="checkbox"
                      checked={deviceFilters.discovery.neighbors}
                      onChange={() => onDeviceFilterToggle('discovery', 'neighbors')}
                    />
                    <span className="dropdown-label">Neighbors</span>
                  </label>
                  <div className="dropdown-section-label">Status</div>
                  {(['online', 'warning', 'offline', 'unknown'] as const).map(key => (
                    <label key={key} className="dropdown-item checkbox-item">
                      <input
                        type="checkbox"
                        checked={deviceFilters.status[key]}
                        onChange={() => onDeviceFilterToggle('status', key)}
                      />
                      <span className="dropdown-label">
                        {key.charAt(0).toUpperCase() + key.slice(1)}
                      </span>
                    </label>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Save Topology Button (for temporary topologies) */}
        {onSaveTopology && (
          <button
            className={`toolbar-tool-btn save-topology-btn ${savingTopology ? 'saving' : ''}`}
            onClick={onSaveTopology}
            disabled={savingTopology}
            title="Save topology to database"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </button>
        )}

        {/* Export to Docs Button */}
        {onSaveToDocs && (
          <button
            className={`toolbar-tool-btn save-docs-btn ${savingToDocs ? 'saving' : ''}`}
            onClick={onSaveToDocs}
            disabled={savingToDocs}
            title="Export snapshot to Docs"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </button>
        )}

        {/* Export Dropdown */}
        <div className="toolbar-dropdown-wrapper" ref={dropdown.getRef('export')}>
          <button
            className="toolbar-tool-btn has-dropdown"
            onClick={() => dropdown.toggle('export')}
            title="Export"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <svg className="dropdown-arrow" viewBox="0 0 12 12" width="8" height="8">
              <path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          {dropdown.isOpen('export') && (
            <div className="toolbar-dropdown export-dropdown">
              <button className="dropdown-item" onClick={() => handleExportSelect('png')}>
                <span className="dropdown-icon">
                  <svg viewBox="0 0 16 16" width="14" height="14">
                    <rect x="2" y="2" width="12" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <circle cx="6" cy="6" r="1.5" fill="currentColor" />
                    <path d="M14 10l-3-3-4 4-2-2-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  </svg>
                </span>
                <span className="dropdown-label">Export as PNG</span>
              </button>
              <button className="dropdown-item" onClick={() => handleExportSelect('svg')}>
                <span className="dropdown-icon">
                  <svg viewBox="0 0 16 16" width="14" height="14">
                    <rect x="2" y="2" width="12" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <text x="8" y="11" textAnchor="middle" fontSize="6" fill="currentColor">SVG</text>
                  </svg>
                </span>
                <span className="dropdown-label">Export as SVG</span>
              </button>
              <button className="dropdown-item" onClick={() => handleExportSelect('json')}>
                <span className="dropdown-icon">
                  <svg viewBox="0 0 16 16" width="14" height="14">
                    <path d="M4 4v3c0 1-1 2-2 2s2 1 2 2v3M12 4v3c0 1 1 2 2 2s-2 1-2 2v3" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </span>
                <span className="dropdown-label">Export as JSON</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
