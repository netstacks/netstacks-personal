import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import './EnterpriseDevicePanel.css';
import SearchField from './SearchField';
import { listEnterpriseDevices, type DeviceSummary } from '../api/enterpriseDevices';
import ContextMenu, { type MenuItem } from './ContextMenu';
import EnterpriseDeviceEditDialog from './EnterpriseDeviceEditDialog';
import { useHostnameFormatter } from '../hooks/useHostnameFormatter';

// Icons
import { getErrorMessage } from '../api/errors'
import Tooltip from './Tooltip';
import { userScopedKey } from '../lib/userScope';
const FAVORITES_KEY = 'enterprise-device-favorites';

const Icons = {
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

  // Edit device state
  const [editDevice, setEditDevice] = useState<DeviceSummary | null>(null);

  // Favorites stored in localStorage, per signed-in user (lib/userScope)
  const [favoriteDeviceIds, setFavoriteDeviceIds] = useState<Set<string>>(() => {
    const key = userScopedKey(FAVORITES_KEY);
    if (!key) return new Set();
    try {
      const stored = localStorage.getItem(key);
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
      const key = userScopedKey(FAVORITES_KEY);
      if (key) localStorage.setItem(key, JSON.stringify([...next]));
      return next;
    });
  };

  const isFavorite = (deviceId: string) => favoriteDeviceIds.has(deviceId);

  // Favorite devices (filtered from current device list)
  const favoriteDevices = useMemo(() => {
    return devices.filter(d => favoriteDeviceIds.has(d.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [devices, favoriteDeviceIds]);

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

  const deviceMenuItems = (device: DeviceSummary): MenuItem[] => [
    { id: 'connect', label: 'Connect', action: () => onDeviceConnect(device) },
    { id: 'favorite', label: isFavorite(device.id) ? 'Remove from Favorites' : 'Add to Favorites', action: () => toggleFavorite(device.id) },
    { id: 'edit-divider', label: '', divider: true, action: () => {} },
    { id: 'edit', label: 'Edit Device', action: () => setEditDevice(device) },
    ...(onViewLatestBackup || onOpenBackupHistory ? [{ id: 'backup-divider', label: '', divider: true, action: () => {} }] : []),
    ...(onViewLatestBackup ? [{ id: 'latest-backup', label: 'View Latest Backup', action: () => onViewLatestBackup(device) }] : []),
    ...(onOpenBackupHistory ? [{ id: 'backup-history', label: 'Backup History', action: () => onOpenBackupHistory(device) }] : []),
  ];

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
          <Tooltip label="Refresh"><button
            className="ns-btn ns-btn--ghost ns-icon-btn"
            onClick={fetchDevices}
            disabled={loading}
            aria-label="Refresh"
          >
            {Icons.refresh}
          </button></Tooltip>
        </>,
        headerTarget
      )}

      {/* Search */}
      <SearchField placeholder="Search devices..." value={searchQuery} onChange={setSearchQuery} />

      {/* Filter dropdowns */}
      <div className="device-panel-filters">
        <div className="device-filter-group">
          <label>Source</label>
          <select aria-label="Source" className="ns-select" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
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
          <select aria-label="Type" className="ns-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
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
          <select aria-label="Site" className="ns-select" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
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
                        <Tooltip label={isFavorite(device.id) ? 'Remove from favorites' : 'Add to favorites'}><button aria-label={isFavorite(device.id) ? 'Remove from favorites' : 'Add to favorites'}
                          className={`device-favorite-btn ${isFavorite(device.id) ? 'is-favorite' : ''}`}
                          onClick={(e) => toggleFavorite(device.id, e)}
                        >
                          {isFavorite(device.id) ? Icons.starFilled : Icons.star}
                        </button></Tooltip>
                        <span className="device-item-name">{formatName(device.name)}</span>
                        <Tooltip label="Connect with default credential"><button
                          className="device-connect-btn"
                          onClick={(e) => { e.stopPropagation(); (onDeviceQuickConnect || onDeviceConnect)(device); }}
                        >
                          Connect
                        </button></Tooltip>
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
                  <Tooltip label={isFavorite(device.id) ? 'Remove from favorites' : 'Add to favorites'}><button aria-label={isFavorite(device.id) ? 'Remove from favorites' : 'Add to favorites'}
                    className={`device-favorite-btn ${isFavorite(device.id) ? 'is-favorite' : ''}`}
                    onClick={(e) => toggleFavorite(device.id, e)}
                  >
                    {isFavorite(device.id) ? Icons.starFilled : Icons.star}
                  </button></Tooltip>
                  <span className="device-item-name">{formatName(device.name)}</span>
                  <Tooltip label="Connect with default credential"><button
                    className="device-connect-btn"
                    onClick={(e) => { e.stopPropagation(); (onDeviceQuickConnect || onDeviceConnect)(device); }}
                  >
                    Connect
                  </button></Tooltip>
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

      <ContextMenu
        position={contextMenu}
        items={contextMenu ? deviceMenuItems(contextMenu.device) : []}
        onClose={() => setContextMenu(null)}
      />

      {editDevice && (
        <EnterpriseDeviceEditDialog device={editDevice} onClose={() => setEditDevice(null)} onSaved={fetchDevices} />
      )}
    </div>
  );
}
