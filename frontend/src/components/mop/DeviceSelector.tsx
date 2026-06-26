/**
 * DeviceSelector - Multi-select device picker with folder grouping
 *
 * Features:
 * - Folder-based grouping
 * - Search/filter
 * - Multi-select with checkbox UI
 * - Visual feedback for selected devices
 */

import { useState, useEffect, useMemo } from 'react';
import { useMopExecutionContext } from '../../contexts/MopExecutionContext';
import { listSessions, listFolders, type Session, type Folder } from '../../api/sessions';

// Icons
const Icons = {
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  server: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <rect x="2" y="3" width="20" height="6" rx="1" />
      <rect x="2" y="11" width="20" height="6" rx="1" />
      <circle cx="6" cy="6" r="1" />
      <circle cx="6" cy="14" r="1" />
    </svg>
  ),
};

interface DeviceSelectorProps {
  onDevicesChange?: (deviceIds: string[]) => void;
}

export default function DeviceSelector({ onDevicesChange }: DeviceSelectorProps) {
  const { execution } = useMopExecutionContext();

  // Local state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  // Load sessions and folders
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [sessionsData, foldersData] = await Promise.all([
          listSessions(),
          listFolders(),
        ]);
        if (cancelled) return;
        setSessions(sessionsData);
        setFolders(foldersData);
      } catch (err) {
        if (!cancelled) console.error('Failed to load sessions:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Build folder counts
  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = { all: sessions.length, unfiled: 0 };
    for (const session of sessions) {
      if (session.folder_id) {
        counts[session.folder_id] = (counts[session.folder_id] || 0) + 1;
      } else {
        counts.unfiled++;
      }
    }
    return counts;
  }, [sessions]);

  // Filter sessions
  const filteredSessions = useMemo(() => {
    let filtered = sessions;

    // Filter by folder
    if (selectedFolderId === 'unfiled') {
      filtered = filtered.filter(s => !s.folder_id);
    } else if (selectedFolderId) {
      filtered = filtered.filter(s => s.folder_id === selectedFolderId);
    }

    // Filter by search
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(s =>
        s.name.toLowerCase().includes(query) ||
        s.host?.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [sessions, selectedFolderId, searchQuery]);

  // Handle session toggle
  const toggleSession = async (session: Session) => {
    const newSelected = new Set(selectedSessionIds);
    if (newSelected.has(session.id)) {
      newSelected.delete(session.id);
      // Remove device from execution
      // Note: Would need removeDevice API endpoint
    } else {
      newSelected.add(session.id);
      // Add device to execution
      try {
        await execution.addDevice(session.id, newSelected.size - 1);
      } catch (err) {
        console.error('Failed to add device:', err);
      }
    }
    setSelectedSessionIds(newSelected);
    onDevicesChange?.(Array.from(newSelected));
  };

  // Handle select all in current view
  const selectAll = async () => {
    const newSelected = new Set(selectedSessionIds);
    for (const session of filteredSessions) {
      if (!newSelected.has(session.id)) {
        newSelected.add(session.id);
        try {
          await execution.addDevice(session.id, newSelected.size - 1);
        } catch (err) {
          console.error('Failed to add device:', err);
        }
      }
    }
    setSelectedSessionIds(newSelected);
    onDevicesChange?.(Array.from(newSelected));
  };

  // Handle clear selection
  const clearSelection = () => {
    setSelectedSessionIds(new Set());
    // Note: Would need to remove all devices from execution
    onDevicesChange?.([]);
  };

  if (loading) {
    return (
      <div className="device-selector">
        <div className="mop-loading-overlay" style={{ position: 'relative', minHeight: 200 }}>
          <div className="mop-loading-spinner" />
          <span className="mop-loading-text">Loading devices...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="device-selector">
      <div className="device-selector-header">
        <h3>Select Target Devices ({selectedSessionIds.size} selected)</h3>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div className="device-search">
            <span className="search-icon">{Icons.search}</span>
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          <button className="mop-btn mop-btn-secondary" onClick={selectAll}>
            Select All
          </button>
          {selectedSessionIds.size > 0 && (
            <button className="mop-btn mop-btn-secondary" onClick={clearSelection}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="device-selector-content">
        {/* Folder sidebar */}
        <div className="device-folders">
          <div
            className={`folder-item ${selectedFolderId === null ? 'selected' : ''}`}
            onClick={() => setSelectedFolderId(null)}
          >
            <span className="folder-icon-small">{Icons.folder}</span>
            <span className="folder-name">All Devices</span>
            <span className="folder-count">{folderCounts.all}</span>
          </div>
          {folders.map(folder => (
            <div
              key={folder.id}
              className={`folder-item ${selectedFolderId === folder.id ? 'selected' : ''}`}
              onClick={() => setSelectedFolderId(folder.id)}
            >
              <span className="folder-icon-small">{Icons.folder}</span>
              <span className="folder-name">{folder.name}</span>
              <span className="folder-count">{folderCounts[folder.id] || 0}</span>
            </div>
          ))}
          {folderCounts.unfiled > 0 && (
            <div
              className={`folder-item ${selectedFolderId === 'unfiled' ? 'selected' : ''}`}
              onClick={() => setSelectedFolderId('unfiled')}
            >
              <span className="folder-icon-small">{Icons.folder}</span>
              <span className="folder-name">Unfiled</span>
              <span className="folder-count">{folderCounts.unfiled}</span>
            </div>
          )}
        </div>

        {/* Device list */}
        <div className="device-list">
          {filteredSessions.length === 0 ? (
            <div className="mop-empty-state" style={{ gridColumn: '1 / -1' }}>
              <div className="mop-empty-state-icon">{Icons.server}</div>
              <div className="mop-empty-state-title">No Devices Found</div>
              <div className="mop-empty-state-desc">
                {searchQuery ? 'Try adjusting your search.' : 'No devices in this folder.'}
              </div>
            </div>
          ) : (
            filteredSessions.map(session => (
              <div
                key={session.id}
                className={`device-card ${selectedSessionIds.has(session.id) ? 'selected' : ''}`}
                onClick={() => toggleSession(session)}
              >
                <div className="device-card-header">
                  <span className="device-card-icon">{Icons.server}</span>
                  <div className="device-card-info">
                    <div className="device-card-name">{session.name}</div>
                    <div className="device-card-host">{session.host || 'localhost'}</div>
                  </div>
                  <div className="device-card-checkbox">
                    {selectedSessionIds.has(session.id) && Icons.check}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
