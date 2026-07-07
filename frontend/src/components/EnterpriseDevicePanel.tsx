import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import './EnterpriseDevicePanel.css';
import { listEnterpriseDevices, updateEnterpriseDevice, type DeviceSummary } from '../api/enterpriseDevices';
import { useClampedMenuPosition } from '../hooks/useClampedMenuPosition';
import DeviceMemoryEditor from './DeviceMemoryEditor';
import SessionContextEditor from './SessionContextEditor';
import { useAuthStore } from '../stores/authStore';
import { useHostnameFormatter } from '../hooks/useHostnameFormatter';

// Icons
import { getErrorMessage } from '../api/errors'
const Icons = {
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  ),
  star: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  starFilled: (
    <svg viewBox="0 0 24 24" fill="#f5c842" stroke="#f5c842" strokeWidth="1.5">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
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
};

interface EnterpriseDevicePanelProps {
  onDeviceConnect: (device: DeviceSummary) => void;
  /** Quick connect with default credential — used by the Connect button */
  onDeviceQuickConnect?: (device: DeviceSummary) => void;
  onViewLatestBackup?: (device: DeviceSummary) => void;
  onOpenBackupHistory?: (device: DeviceSummary) => void;
  /** Render count badge + refresh button into the sidebar header */
  headerTarget?: HTMLElement | null;
}

export default function EnterpriseDevicePanel({
  onDeviceConnect,
  onDeviceQuickConnect,
  onViewLatestBackup,
  onOpenBackupHistory,
  headerTarget,
}: EnterpriseDevicePanelProps) {
  const formatName = useHostnameFormatter()
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [siteFilter, setSiteFilter] = useState('all');
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    device: DeviceSummary;
  } | null>(null);
  const { ref: contextMenuRef, style: contextMenuStyle } = useClampedMenuPosition(contextMenu);

  // Edit device state
  const [editDevice, setEditDevice] = useState<DeviceSummary | null>(null);
  const [editForm, setEditForm] = useState<{
    name: string;
    host: string;
    port: number;
    device_type: string;
    description: string;
    site: string;
    manufacturer: string;
    model: string;
  }>({ name: '', host: '', port: 22, device_type: '', description: '', site: '', manufacturer: '', model: '' });
  const [editSaving, setEditSaving] = useState(false);
  const [editTab, setEditTab] = useState<'properties' | 'memory' | 'context'>('properties');

  // Current user — author for device-memory entries created from this panel.
  const currentUser = useAuthStore((s) => s.user)?.username ?? 'Unknown';

  // Favorites stored in localStorage
  const [favoriteDeviceIds, setFavoriteDeviceIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('enterprise-device-favorites');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [showFavorites, setShowFavorites] = useState(true);

  // Toggle favorite status for a device
  const toggleFavorite = (deviceId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setFavoriteDeviceIds(prev => {
      const next = new Set(prev);
      if (next.has(deviceId)) {
        next.delete(deviceId);
      } else {
        next.add(deviceId);
      }
      localStorage.setItem('enterprise-device-favorites', JSON.stringify([...next]));
      return next;
    });
  };

  const isFavorite = (deviceId: string) => favoriteDeviceIds.has(deviceId);

  // Favorite devices (filtered from current device list)
  const favoriteDevices = useMemo(() => {
    return devices.filter(d => favoriteDeviceIds.has(d.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [devices, favoriteDeviceIds]);

  // Open edit device dialog
  const handleEditDevice = (device: DeviceSummary) => {
    setEditDevice(device);
    setEditTab('properties');
    setEditForm({
      name: device.name,
      host: device.host,
      port: device.port,
      device_type: device.device_type,
      description: '',
      site: device.site || '',
      manufacturer: device.manufacturer || '',
      model: device.model || '',
    });
  };

  // Save device edits
  const handleSaveEdit = async () => {
    if (!editDevice) return;
    setEditSaving(true);
    try {
      await updateEnterpriseDevice(editDevice.id, editForm);
      setEditDevice(null);
      fetchDevices(); // Refresh the device list
    } catch (err) {
      console.error('Failed to update device:', err);
    } finally {
      setEditSaving(false);
    }
  };

  // Fetch devices on mount
  const fetchDevices = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listEnterpriseDevices({ limit: 1000 });
      setDevices(response.items);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load devices'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDevices();
  }, []);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu]);

  // Extract unique values for filter dropdowns
  const filterOptions = useMemo(() => {
    const sources = new Set<string>();
    const types = new Set<string>();
    const sites = new Set<string>();

    devices.forEach((device) => {
      sources.add(device.source);
      types.add(device.device_type);
      if (device.site) sites.add(device.site);
    });

    return {
      sources: Array.from(sources).sort(),
      types: Array.from(types).sort(),
      sites: Array.from(sites).sort(),
    };
  }, [devices]);

  // Filter devices based on search and filter dropdowns
  const filteredDevices = useMemo(() => {
    const searchLower = searchQuery.toLowerCase().trim();

    return devices.filter((device) => {
      // Search filter
      if (searchLower) {
        const matchesSearch =
          device.name.toLowerCase().includes(searchLower) ||
          device.host.toLowerCase().includes(searchLower) ||
          (device.site && device.site.toLowerCase().includes(searchLower)) ||
          (device.manufacturer && device.manufacturer.toLowerCase().includes(searchLower)) ||
          (device.model && device.model.toLowerCase().includes(searchLower));

        if (!matchesSearch) return false;
      }

      // Source filter
      if (sourceFilter !== 'all' && device.source !== sourceFilter) {
        return false;
      }

      // Type filter
      if (typeFilter !== 'all' && device.device_type !== typeFilter) {
        return false;
      }

      // Site filter
      if (siteFilter !== 'all' && device.site !== siteFilter) {
        return false;
      }

      return true;
    });
  }, [devices, searchQuery, sourceFilter, typeFilter, siteFilter]);

  return (
    <div className="enterprise-device-panel">
      {/* Portal count + refresh into sidebar header */}
      {headerTarget && createPortal(
        <>
          <span className="device-count-badge">{filteredDevices.length}</span>
          <button
            className="device-refresh-btn"
            onClick={fetchDevices}
            disabled={loading}
            title="Refresh"
          >
            {Icons.refresh}
          </button>
        </>,
        headerTarget
      )}

      {/* Search */}
      <div className="device-panel-search">
        <span className="device-panel-search-icon">{Icons.search}</span>
        <input
          type="search"
          className="device-panel-search-input"
          placeholder="Search devices..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Filter dropdowns */}
      <div className="device-panel-filters">
        <div className="device-filter-group">
          <label>Source</label>
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
            <option value="all">All Sources</option>
            {filterOptions.sources.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </div>

        <div className="device-filter-group">
          <label>Type</label>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">All Types</option>
            {filterOptions.types.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>

        <div className="device-filter-group">
          <label>Site</label>
          <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
            <option value="all">All Sites</option>
            {filterOptions.sites.map((site) => (
              <option key={site} value={site}>
                {site}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="device-panel-status">Loading devices...</div>
      )}

      {/* Error state */}
      {error && (
        <div className="device-panel-error">
          {error}
          <button onClick={fetchDevices}>Retry</button>
        </div>
      )}

      {/* Device list */}
      {!loading && !error && (
        <div className="device-list">
          {/* Favorites Section */}
          {!searchQuery && favoriteDevices.length > 0 && (
            <div className="device-favorites-section">
              <div
                className="device-favorites-header"
                onClick={() => setShowFavorites(!showFavorites)}
              >
                <div className="device-favorites-chevron">
                  {showFavorites ? Icons.chevronDown : Icons.chevronRight}
                </div>
                {Icons.starFilled}
                <span className="device-favorites-title">Favorites</span>
                <span className="device-count-badge">{favoriteDevices.length}</span>
              </div>
              {showFavorites && (
                <div className="device-favorites-list">
                  {favoriteDevices.map((device) => (
                    <div
                      key={device.id}
                      className="device-item device-item-favorite"
                      onClick={() => onDeviceConnect(device)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu({ x: e.clientX, y: e.clientY, device });
                      }}
                      title={`Connect to ${device.host}:${device.port}`}
                    >
                      <div className="device-item-header">
                        <button
                          className={`device-favorite-btn ${isFavorite(device.id) ? 'is-favorite' : ''}`}
                          onClick={(e) => toggleFavorite(device.id, e)}
                          title={isFavorite(device.id) ? 'Remove from favorites' : 'Add to favorites'}
                        >
                          {isFavorite(device.id) ? Icons.starFilled : Icons.star}
                        </button>
                        <span className="device-item-name">{formatName(device.name)}</span>
                        <button
                          className="device-connect-btn"
                          onClick={(e) => { e.stopPropagation(); (onDeviceQuickConnect || onDeviceConnect)(device); }}
                          title="Connect with default credential"
                        >
                          Connect
                        </button>
                      </div>
                      <div className="device-item-details">
                        <div className="device-item-details-inner">
                          <div className="device-item-host">
                            {formatName(device.host)}:{device.port}
                            <span className="device-source-badge">{device.source}</span>
                            <span className="device-type-badge">{device.device_type}</span>
                          </div>
                          {device.site && (
                            <div className="device-item-site">Site: {device.site}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {filteredDevices.length === 0 ? (
            <div className="device-panel-empty">No devices found</div>
          ) : (
            filteredDevices.map((device) => (
              <div
                key={device.id}
                className="device-item"
                onClick={() => onDeviceConnect(device)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, device });
                }}
                title={`Connect to ${device.host}:${device.port}`}
              >
                <div className="device-item-header">
                  <button
                    className={`device-favorite-btn ${isFavorite(device.id) ? 'is-favorite' : ''}`}
                    onClick={(e) => toggleFavorite(device.id, e)}
                    title={isFavorite(device.id) ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    {isFavorite(device.id) ? Icons.starFilled : Icons.star}
                  </button>
                  <span className="device-item-name">{formatName(device.name)}</span>
                  <button
                    className="device-connect-btn"
                    onClick={(e) => { e.stopPropagation(); (onDeviceQuickConnect || onDeviceConnect)(device); }}
                    title="Connect with default credential"
                  >
                    Connect
                  </button>
                </div>
                <div className="device-item-details">
                  <div className="device-item-details-inner">
                    <div className="device-item-host">
                      {formatName(device.host)}:{device.port}
                      <span className="device-source-badge">{device.source}</span>
                      <span className="device-type-badge">{device.device_type}</span>
                    </div>
                    {device.site && (
                      <div className="device-item-site">Site: {device.site}</div>
                    )}
                    {(device.manufacturer || device.model) && (
                      <div className="device-item-meta">
                        {device.manufacturer && <span>{device.manufacturer}</span>}
                        {device.manufacturer && device.model && <span> • </span>}
                        {device.model && <span>{device.model}</span>}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="enterprise-context-menu"
          style={contextMenuStyle}
        >
          <button
            className="enterprise-context-menu-item"
            onClick={() => {
              onDeviceConnect(contextMenu.device);
              setContextMenu(null);
            }}
          >
            Connect
          </button>
          <button
            className="enterprise-context-menu-item"
            onClick={() => {
              toggleFavorite(contextMenu.device.id);
              setContextMenu(null);
            }}
          >
            {isFavorite(contextMenu.device.id) ? 'Remove from Favorites' : 'Add to Favorites'}
          </button>
          <div className="enterprise-context-menu-divider" />
          <button
            className="enterprise-context-menu-item"
            onClick={() => {
              handleEditDevice(contextMenu.device);
              setContextMenu(null);
            }}
          >
            Edit Device
          </button>
          {(onViewLatestBackup || onOpenBackupHistory) && (
            <>
              <div className="enterprise-context-menu-divider" />
              {onViewLatestBackup && (
                <button
                  className="enterprise-context-menu-item"
                  onClick={() => {
                    onViewLatestBackup(contextMenu.device);
                    setContextMenu(null);
                  }}
                >
                  View Latest Backup
                </button>
              )}
              {onOpenBackupHistory && (
                <button
                  className="enterprise-context-menu-item"
                  onClick={() => {
                    onOpenBackupHistory(contextMenu.device);
                    setContextMenu(null);
                  }}
                >
                  Backup History
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Edit Device Dialog */}
      {editDevice && (
        <div className="device-edit-overlay">
          <div className="device-edit-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="device-edit-header">
              <h3>Edit Device</h3>
              <button className="device-edit-close" onClick={() => setEditDevice(null)}>&times;</button>
            </div>
            <div className="device-edit-tabs">
              <button
                className={`device-edit-tab ${editTab === 'properties' ? 'active' : ''}`}
                onClick={() => setEditTab('properties')}
              >
                Properties
              </button>
              <button
                className={`device-edit-tab ${editTab === 'memory' ? 'active' : ''}`}
                onClick={() => setEditTab('memory')}
              >
                Device Memory
              </button>
              <button
                className={`device-edit-tab ${editTab === 'context' ? 'active' : ''}`}
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
                <input value={editForm.name} onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))} />
              </div>
              <div className="device-edit-row">
                <div className="device-edit-field">
                  <label>Host</label>
                  <input value={editForm.host} onChange={(e) => setEditForm(prev => ({ ...prev, host: e.target.value }))} />
                </div>
                <div className="device-edit-field" style={{ maxWidth: 80 }}>
                  <label>Port</label>
                  <input
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
                <input value={editForm.device_type} onChange={(e) => setEditForm(prev => ({ ...prev, device_type: e.target.value }))} />
              </div>
              <div className="device-edit-row">
                <div className="device-edit-field">
                  <label>Site</label>
                  <input value={editForm.site} onChange={(e) => setEditForm(prev => ({ ...prev, site: e.target.value }))} />
                </div>
              </div>
              <div className="device-edit-row">
                <div className="device-edit-field">
                  <label>Manufacturer</label>
                  <input value={editForm.manufacturer} onChange={(e) => setEditForm(prev => ({ ...prev, manufacturer: e.target.value }))} />
                </div>
                <div className="device-edit-field">
                  <label>Model</label>
                  <input value={editForm.model} onChange={(e) => setEditForm(prev => ({ ...prev, model: e.target.value }))} />
                </div>
              </div>
            </div>
            <div className="device-edit-actions">
              <button className="device-edit-btn" onClick={() => setEditDevice(null)} disabled={editSaving}>
                Cancel
              </button>
              <button className="device-edit-btn primary" onClick={handleSaveEdit} disabled={editSaving}>
                {editSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
              </>
            )}
            {editTab === 'memory' && (
              <div className="device-edit-memory">
                <DeviceMemoryEditor deviceId={editDevice.id} currentUser={currentUser} />
              </div>
            )}
            {editTab === 'context' && (
              <div className="device-edit-memory">
                <SessionContextEditor deviceId={editDevice.id} currentUser={currentUser} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
