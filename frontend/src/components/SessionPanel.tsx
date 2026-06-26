import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import './SessionPanel.css';
import { useClampedMenuPosition } from '../hooks/useClampedMenuPosition';
import {
  listSessions,
  listFolders,
  deleteSession,
  bulkDeleteSessions,
  createSession,
  createFolder,
  updateFolder,
  deleteFolder,
  exportSession,
  exportFolder,
  importSessions,
  listHistory,
  deleteHistory,
  moveSession,
  moveFolder,
  type Session,
  type Folder,
  type ConnectionHistory,
  type ExportData,
  sessionsToCSV,
  csvToExportData,
  generateExampleCSV,
} from '../api/sessions';
import { listProfiles } from '../api/profiles';
import SessionSettingsDialog from './SessionSettingsDialog';
import BroadcastCommandDialog from './BroadcastCommandDialog';
import GroupsPanel from './GroupsPanel';
import { useSessionSelection, SessionSelectionProvider } from '../hooks/useSessionSelection';
import { downloadFile } from '../lib/formatters';
import { showToast } from './Toast';
import { confirmDialog } from './ConfirmDialog';
import { usePersistedState } from '../hooks/usePersistedState';

import { getErrorMessage } from '../api/errors'
const isSortOrder = (v: unknown): v is 'default' | 'reverse' =>
  v === 'default' || v === 'reverse';

// Drag and drop types
type DragItemType = 'session' | 'folder';
interface DragItem {
  id: string;
  type: DragItemType;
}
interface DropTarget {
  id: string;
  position: 'before' | 'after' | 'inside';
  type: 'session' | 'folder' | 'root';
}

interface SessionPanelProps {
  onConnect: (session: Session) => void;
  onOpenLocalShell?: () => void;
  onBulkConnect?: (sessionIds: string[]) => Promise<void>;
  /** Close every connected terminal tab for the given session(s). */
  onDisconnect?: (sessionIds: string[]) => void;
  /** IDs of sessions that currently have at least one connected terminal tab.
   *  Used to swap the context-menu "Connect" entry for "Disconnect" so the
   *  sidebar isn't a one-way valve. */
  connectedSessionIds?: Set<string>;
  onSelectionChange?: (selectedIds: string[]) => void;
  /** Called when a session is created or updated, so parent can update open tabs */
  onSessionUpdated?: (session: Session) => void;
  /** Session updated externally (e.g., from terminal context menu settings) - triggers internal state update */
  externalSessionUpdate?: Session | null;
  // Groups panel props (Plan 1: redesign)
  liveGroupId?: string | null;
  groupsRefreshKey?: number;
  onLaunchGroup?: (group: import('../api/groups').Group) => void;
  onSaveCurrentAsGroup?: () => void;
  onTabDroppedOnGroup?: (groupId: string, droppedTabId: string) => void;
  onDiscoverTopology?: (group: import('../api/groups').Group) => void;
  onOpenTopology?: (topologyId: string) => void;
  getTabTitle?: (tabIdOrSessionId: string) => string;
  onOpenRemoteWindow?: (sessionId: string) => void;
}

// Icons
const Icons = {
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  ),
  folderOpen: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v1" />
      <path d="M2 10l4 9h14l4-9H6" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  chevronRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  chevronDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
  connect: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  newTab: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  ),
  duplicate: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  ),
  export: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  ),
  import: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  folderPlus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  ),
  clock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  broadcast: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
      <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
      <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
    </svg>
  ),
  star: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  starFilled: (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  sortAsc: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 4h13M3 8h9M3 12h5" />
      <path d="M17 4v16M14 17l3 3 3-3" />
    </svg>
  ),
  terminal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  sortDesc: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 4h5M3 8h9M3 12h13" />
      <path d="M17 20V4M14 7l3-3 3 3" />
    </svg>
  ),
  collapseAll: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 6h16M4 12h16M4 18h16" />
      <path d="M9 9l3-3 3 3M9 15l3 3 3-3" />
    </svg>
  ),
  expandAll: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 6h16M4 12h16M4 18h16" />
      <path d="M9 3l3 3 3-3M9 21l3-3 3 3" />
    </svg>
  ),
};

// Format relative time (e.g., "2 hours ago")
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function downloadJson(data: ExportData, filename: string): void {
  downloadFile(JSON.stringify(data, null, 2), filename, 'application/json');
}

function downloadTextFile(content: string, filename: string, mimeType: string): void {
  downloadFile(content, filename, mimeType);
}

function SessionPanelContent({
  onConnect,
  onDisconnect,
  connectedSessionIds,
  onOpenLocalShell,
  onBulkConnect,
  onSelectionChange,
  onSessionUpdated,
  externalSessionUpdate,
  // Groups panel props
  liveGroupId,
  groupsRefreshKey,
  onLaunchGroup,
  onSaveCurrentAsGroup,
  onTabDroppedOnGroup,
  onDiscoverTopology,
  onOpenTopology,
  getTabTitle,
  onOpenRemoteWindow,
}: SessionPanelProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [recentConnections, setRecentConnections] = useState<ConnectionHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [bulkConnecting, setBulkConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [defaultFolderId, setDefaultFolderId] = useState<string | null>(null);
  const [sessionContextMenu, setSessionContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{ x: number; y: number; folderId: string } | null>(null);
  const { ref: sessionMenuRef, style: sessionMenuStyle } = useClampedMenuPosition(sessionContextMenu);
  const { ref: folderMenuRef, style: folderMenuStyle } = useClampedMenuPosition(folderContextMenu);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState('');
  const [showRecent, setShowRecent] = usePersistedState('session-panel-show-recent', true);
  const [broadcastDialogOpen, setBroadcastDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // Sub-tab state for Sessions/Groups navigation (Phase 25). Persisted
  // so the user stays on Groups across panel re-mounts (tab switches,
  // settings dialogs, hot reload in dev).
  const [activeSubTab, setActiveSubTab] = usePersistedState<'sessions' | 'groups'>(
    'session-panel-sub-tab',
    'sessions',
    { validate: (v): v is 'sessions' | 'groups' => v === 'sessions' || v === 'groups' },
  );
  // Sort order: 'default' = folders first, 'reverse' = sessions first
  const [sortOrder, setSortOrder] = usePersistedState<'default' | 'reverse'>(
    'session-panel-sort-order',
    'default',
    { validate: isSortOrder },
  );
  // Favorites stored in localStorage. Cross-window sync: a second
  // popout marking a session as favorite should reflect here too.
  const [favoriteSessionIds, setFavoriteSessionIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('session-panel-favorites');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== 'session-panel-favorites') return;
      if (e.newValue === null) {
        setFavoriteSessionIds(new Set());
        return;
      }
      try {
        const parsed = JSON.parse(e.newValue);
        if (Array.isArray(parsed)) setFavoriteSessionIds(new Set(parsed));
      } catch {
        /* ignore parse errors on incoming updates */
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);
  // Show/hide favorites section
  const [showFavorites, setShowFavorites] = usePersistedState('session-panel-show-favorites', true);

  // Drag and drop state (using pointer events for Tauri compatibility)
  const [draggedItem, setDraggedItem] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const autoExpandTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement>(null);
  const sessionListRef = useRef<HTMLDivElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Multi-selection hook
  const {
    selectedSessionIds,
    toggleSelection,
    rangeSelect,
    clearSelection,
    isSelected,
    selectionCount,
    selectedFolderIds,
    toggleFolderSelection,
    rangeFolderSelect,
    isFolderSelected,
  } = useSessionSelection();

  // Notify parent of selection changes for keyboard shortcut support
  useEffect(() => {
    if (onSelectionChange) {
      onSelectionChange(Array.from(selectedSessionIds));
    }
  }, [selectedSessionIds, onSelectionChange]);

  // Handle external session updates (e.g., from terminal context menu settings)
  useEffect(() => {
    if (externalSessionUpdate) {
      setSessions(prev => prev.map(s =>
        s.id === externalSessionUpdate.id ? externalSessionUpdate : s
      ));
    }
  }, [externalSessionUpdate]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // allSettled: don't let a folders/history failure wipe the sessions
      // list (or vice versa). Surface only the worst failure (sessions) as
      // a panel error since folders+history have sane fallbacks.
      const [sessionsRes, foldersRes, historyRes] = await Promise.allSettled([
        listSessions(),
        listFolders(),
        listHistory(),
      ]);
      if (sessionsRes.status === 'fulfilled') {
        setSessions(sessionsRes.value);
      } else {
        throw sessionsRes.reason;
      }
      setFolders(foldersRes.status === 'fulfilled' ? foldersRes.value : []);
      setRecentConnections(
        (historyRes.status === 'fulfilled' ? historyRes.value : []).slice(0, 5),
      );
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load sessions'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Toggle favorite status for a session
  const toggleFavorite = useCallback((sessionId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setFavoriteSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      localStorage.setItem('session-panel-favorites', JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Toggle sort order — persistence handled by usePersistedState.
  const toggleSortOrder = useCallback(() => {
    setSortOrder(prev => (prev === 'default' ? 'reverse' : 'default'));
  }, [setSortOrder]);

  // Collapse all folders
  const collapseAllFolders = useCallback(() => {
    setExpandedFolders(new Set());
  }, []);

  // Expand all folders
  const expandAllFolders = useCallback(() => {
    setExpandedFolders(new Set(folders.map(f => f.id)));
  }, [folders]);

  // Check if session is favorite
  const isFavorite = useCallback((sessionId: string) => {
    return favoriteSessionIds.has(sessionId);
  }, [favoriteSessionIds]);

  // Get favorite sessions
  const favoriteSessions = useMemo(() => {
    return sessions.filter(s => favoriteSessionIds.has(s.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions, favoriteSessionIds]);

  // Close context menus on click outside
  useEffect(() => {
    const handleClick = () => {
      setSessionContextMenu(null);
      setFolderContextMenu(null);
    };
    if (sessionContextMenu || folderContextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [sessionContextMenu, folderContextMenu]);

  // Focus rename input when renaming
  useEffect(() => {
    if (renamingFolderId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingFolderId]);

  const toggleFolder = (folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  // Session context menu handlers
  const handleSessionContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderContextMenu(null);
    setSessionContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  };

  const handleConnectSession = (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session) onConnect(session);
    setSessionContextMenu(null);
  };

  const handleDisconnectSession = (sessionId: string) => {
    onDisconnect?.([sessionId]);
    setSessionContextMenu(null);
  };

  const isSessionConnected = useCallback(
    (sessionId: string) => connectedSessionIds?.has(sessionId) ?? false,
    [connectedSessionIds],
  );

  const handleDuplicateSession = async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    try {
      const newSession = await createSession({
        name: `${session.name} (Copy)`,
        folder_id: session.folder_id,
        host: session.host,
        port: session.port,
        profile_id: session.profile_id,
        color: session.color,
      });
      setSessions(prev => [...prev, newSession]);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to duplicate session'));
    }
    setSessionContextMenu(null);
  };

  const handleExportSession = async (sessionId: string) => {
    try {
      const data = await exportSession(sessionId);
      const session = sessions.find(s => s.id === sessionId);
      downloadJson(data, `${session?.name || 'session'}.json`);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to export session'));
    }
    setSessionContextMenu(null);
  };

  const handleDeleteSession = async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    setSessionContextMenu(null);
    const ok = await confirmDialog({
      title: 'Delete session?',
      body: session ? <>Delete saved session <strong>{session.name}</strong>?</> : 'Delete this session?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteSession(sessionId);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete session'));
    }
  };

  const handleOpenSettings = (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      setEditingSession(session);
      setDialogOpen(true);
    }
    setSessionContextMenu(null);
  };

  // Folder context menu handlers
  const handleFolderContextMenu = (e: React.MouseEvent, folderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSessionContextMenu(null);
    setFolderContextMenu({ x: e.clientX, y: e.clientY, folderId });
  };

  const handleNewSessionInFolder = (folderId: string) => {
    setDefaultFolderId(folderId);
    setEditingSession(null);
    setDialogOpen(true);
    setFolderContextMenu(null);
  };

  const handleNewSubfolder = async (parentId: string) => {
    try {
      const newFolder = await createFolder('New Folder', parentId);
      setFolders(prev => [...prev, newFolder]);
      setExpandedFolders(prev => new Set([...prev, parentId]));
      // Start renaming immediately
      setRenamingFolderId(newFolder.id);
      setRenameFolderValue(newFolder.name);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to create folder'));
    }
    setFolderContextMenu(null);
  };

  const handleRenameFolder = (folderId: string) => {
    const folder = folders.find(f => f.id === folderId);
    if (folder) {
      setRenamingFolderId(folderId);
      setRenameFolderValue(folder.name);
    }
    setFolderContextMenu(null);
  };

  const handleRenameFolderSubmit = async () => {
    if (!renamingFolderId || !renameFolderValue.trim()) {
      setRenamingFolderId(null);
      return;
    }

    try {
      const updated = await updateFolder(renamingFolderId, { name: renameFolderValue.trim() });
      setFolders(prev => prev.map(f => f.id === updated.id ? updated : f));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to rename folder'));
    }
    setRenamingFolderId(null);
  };

  const handleExportFolder = async (folderId: string) => {
    try {
      const data = await exportFolder(folderId);
      const folder = folders.find(f => f.id === folderId);
      downloadJson(data, `${folder?.name || 'folder'}.json`);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to export folder'));
    }
    setFolderContextMenu(null);
  };

  const handleImportSessions = () => {
    fileInputRef.current?.click();
    setFolderContextMenu(null);
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const isCSV = file.name.toLowerCase().endsWith('.csv');

      let data: ExportData;
      let csvWarnings: string[] = [];

      if (isCSV) {
        const parsed = csvToExportData(text);
        data = parsed.data;
        csvWarnings = parsed.warnings;
      } else {
        data = JSON.parse(text);
        if (data.format !== 'netstacks-sessions') {
          throw new Error('Invalid file format');
        }
      }

      const result = await importSessions(data);
      await fetchData(); // Refresh the list

      const allWarnings = [...csvWarnings, ...result.warnings];
      const message = `Imported ${result.sessions_created} session(s) and ${result.folders_created} folder(s).`;
      if (allWarnings.length > 0) {
        showToast(`${message} ${allWarnings.length} warning(s) — see console.`, 'warning');
        console.warn('[SessionPanel] Import warnings:', allWarnings);
      } else {
        showToast(message, 'success');
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to import sessions'));
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleExportCSV = async () => {
    try {
      const profiles = await listProfiles();
      const csv = sessionsToCSV(sessions, folders, profiles);
      downloadTextFile(csv, 'netstacks-sessions.csv', 'text/csv');
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to export CSV'));
    }
  };

  const handleDownloadExampleCSV = () => {
    downloadTextFile(generateExampleCSV(), 'netstacks-example.csv', 'text/csv');
  };

  const handleDeleteFolder = async (folderId: string) => {
    const folder = folders.find(f => f.id === folderId);
    setFolderContextMenu(null);
    const ok = await confirmDialog({
      title: 'Delete folder?',
      body: folder
        ? <>Delete folder <strong>{folder.name}</strong>? Sessions inside will be moved out of the folder.</>
        : 'Delete this folder? Sessions inside will be moved out.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteFolder(folderId);
      setFolders(prev => prev.filter(f => f.id !== folderId));
      // Sessions in the folder will have folder_id set to null by the backend
      await fetchData();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete folder'));
    }
  };

  // === Drag and Drop Handlers ===

  // Calculate all descendant folder IDs for cycle prevention
  const getDescendantFolderIds = useCallback((folderId: string): Set<string> => {
    const descendants = new Set<string>();
    const collectDescendants = (parentId: string) => {
      const children = childFoldersByParent.get(parentId) || [];
      children.forEach(child => {
        descendants.add(child.id);
        collectDescendants(child.id);
      });
    };
    collectDescendants(folderId);
    return descendants;
  }, []);

  // Pointer-based drag start (Tauri compatible)
  const handlePointerDown = useCallback((e: React.PointerEvent, item: DragItem) => {
    // Only left mouse button
    if (e.button !== 0) return;

    // Don't prevent default - allow click events to work
    // Just record the start position and item for potential drag
    setDragStartPos({ x: e.clientX, y: e.clientY });
    setDraggedItem(item);
  }, []);

  // Handle drag end / cleanup
  const handleDragEnd = useCallback(() => {
    setDraggedItem(null);
    setDropTarget(null);
    setIsDragging(false);
    setDragStartPos(null);
    document.body.style.cursor = '';
    document.body.removeAttribute('data-dragging');
    if (autoExpandTimeoutRef.current) {
      clearTimeout(autoExpandTimeoutRef.current);
      autoExpandTimeoutRef.current = null;
    }
  }, []);

  // Find drop target from pointer position
  const findDropTarget = useCallback((clientX: number, clientY: number): DropTarget | null => {
    if (!sessionListRef.current || !draggedItem) return null;

    // Get all folder and session elements
    const folderHeaders = sessionListRef.current.querySelectorAll('[data-folder-id]');
    const sessionItems = sessionListRef.current.querySelectorAll('[data-session-id]');

    // Check folders first
    for (const el of folderHeaders) {
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        const folderId = el.getAttribute('data-folder-id')!;

        // Can't drop folder on itself or its descendants
        if (draggedItem.type === 'folder') {
          if (draggedItem.id === folderId) return null;
          const descendants = getDescendantFolderIds(draggedItem.id);
          if (descendants.has(folderId)) return null;
        }

        const relativeY = clientY - rect.top;
        const height = rect.height;
        let position: 'before' | 'after' | 'inside';
        if (relativeY < height * 0.25) {
          position = 'before';
        } else if (relativeY > height * 0.75) {
          position = 'after';
        } else {
          position = 'inside';
        }

        return { id: folderId, position, type: 'folder' };
      }
    }

    // Check sessions
    for (const el of sessionItems) {
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        const sessionId = el.getAttribute('data-session-id')!;

        // Can't drop on itself
        if (draggedItem.type === 'session' && draggedItem.id === sessionId) return null;

        const midY = rect.top + rect.height / 2;
        const position = clientY < midY ? 'before' : 'after';

        return { id: sessionId, position, type: 'session' };
      }
    }

    // Check if over root area (session list but not on any item)
    const listRect = sessionListRef.current.getBoundingClientRect();
    if (clientX >= listRect.left && clientX <= listRect.right && clientY >= listRect.top && clientY <= listRect.bottom) {
      return { id: 'root', position: 'inside', type: 'root' };
    }

    return null;
  }, [draggedItem, getDescendantFolderIds]);

  // Handle pointer move during drag
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggedItem || !dragStartPos) return;

    // Start dragging after threshold
    const dx = e.clientX - dragStartPos.x;
    const dy = e.clientY - dragStartPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (!isDragging && distance > 5) {
      setIsDragging(true);
      document.body.style.cursor = 'grabbing';
      document.body.setAttribute('data-dragging', 'true');
    }

    if (isDragging) {
      // Update drag preview position
      if (dragPreviewRef.current) {
        dragPreviewRef.current.style.left = `${e.clientX + 10}px`;
        dragPreviewRef.current.style.top = `${e.clientY + 10}px`;
      }

      // Find and set drop target
      const target = findDropTarget(e.clientX, e.clientY);
      setDropTarget(target);

      // Auto-expand folders on hover
      if (target?.type === 'folder' && target.position === 'inside') {
        const folder = folders.find(f => f.id === target.id);
        if (folder && !expandedFolders.has(target.id)) {
          if (!autoExpandTimeoutRef.current) {
            autoExpandTimeoutRef.current = setTimeout(() => {
              setExpandedFolders(prev => new Set([...prev, target.id]));
              autoExpandTimeoutRef.current = null;
            }, 500);
          }
        }
      } else if (autoExpandTimeoutRef.current) {
        clearTimeout(autoExpandTimeoutRef.current);
        autoExpandTimeoutRef.current = null;
      }
    }
  }, [draggedItem, dragStartPos, isDragging, findDropTarget, folders, expandedFolders]);

  // Calculate new sort order for dropped item
  const calculateNewSortOrder = useCallback((
    siblings: { sort_order: number }[],
    targetIndex: number,
    position: 'before' | 'after' | 'inside'
  ): number => {
    if (siblings.length === 0) return 1000;

    if (position === 'inside') {
      // Adding to end of folder
      const maxOrder = Math.max(...siblings.map(s => s.sort_order));
      return maxOrder + 1000;
    }

    const actualIndex = position === 'after' ? targetIndex + 1 : targetIndex;

    if (actualIndex === 0) {
      // Insert at beginning
      return siblings[0].sort_order / 2;
    } else if (actualIndex >= siblings.length) {
      // Insert at end
      return siblings[siblings.length - 1].sort_order + 1000;
    } else {
      // Insert between two items
      const before = siblings[actualIndex - 1].sort_order;
      const after = siblings[actualIndex].sort_order;
      return (before + after) / 2;
    }
  }, []);

  // Execute the actual drop operation
  const executeDrop = useCallback(async () => {
    if (!draggedItem || !dropTarget) return;

    try {
      if (draggedItem.type === 'session') {
        // Check if dragged session is part of multi-selection
        const sessionsToMove = selectedSessionIds.has(draggedItem.id) && selectedSessionIds.size > 1
          ? Array.from(selectedSessionIds)
          : [draggedItem.id];

        let newFolderId: string | null = null;
        let baseSortOrder: number;

        if (dropTarget.type === 'folder') {
          if (dropTarget.position === 'inside') {
            newFolderId = dropTarget.id;
            const folderSessions = sessions
              .filter(s => s.folder_id === dropTarget.id)
              .sort((a, b) => a.sort_order - b.sort_order);
            baseSortOrder = calculateNewSortOrder(folderSessions, 0, 'inside');
          } else {
            const targetFolder = folders.find(f => f.id === dropTarget.id);
            newFolderId = targetFolder?.parent_id || null;
            const siblingFolders = folders
              .filter(f => f.parent_id === newFolderId)
              .sort((a, b) => a.sort_order - b.sort_order);
            const targetIndex = siblingFolders.findIndex(f => f.id === dropTarget.id);
            baseSortOrder = calculateNewSortOrder(siblingFolders, targetIndex, dropTarget.position);
          }
        } else if (dropTarget.type === 'session') {
          const targetSession = sessions.find(s => s.id === dropTarget.id);
          newFolderId = targetSession?.folder_id || null;
          const siblingsSessions = sessions
            .filter(s => s.folder_id === newFolderId)
            .sort((a, b) => a.sort_order - b.sort_order);
          const targetIndex = siblingsSessions.findIndex(s => s.id === dropTarget.id);
          baseSortOrder = calculateNewSortOrder(siblingsSessions, targetIndex, dropTarget.position);
        } else {
          newFolderId = null;
          const rootSessions = sessions
            .filter(s => s.folder_id === null)
            .sort((a, b) => a.sort_order - b.sort_order);
          baseSortOrder = calculateNewSortOrder(rootSessions, 0, 'inside');
        }

        // Move all selected sessions
        for (let i = 0; i < sessionsToMove.length; i++) {
          const sessionId = sessionsToMove[i];
          const newSortOrder = baseSortOrder + (i * 10); // Increment sort order for each

          setSessions(prev => prev.map(s =>
            s.id === sessionId
              ? { ...s, folder_id: newFolderId, sort_order: newSortOrder }
              : s
          ));
          await moveSession(sessionId, { folder_id: newFolderId, sort_order: newSortOrder });
        }

      } else if (draggedItem.type === 'folder') {
        // Check if dragged folder is part of multi-selection
        const foldersToMove = selectedFolderIds.has(draggedItem.id) && selectedFolderIds.size > 1
          ? Array.from(selectedFolderIds)
          : [draggedItem.id];

        let newParentId: string | null = null;
        let baseSortOrder: number;

        if (dropTarget.type === 'folder') {
          if (dropTarget.position === 'inside') {
            newParentId = dropTarget.id;
            const childFolders = folders
              .filter(f => f.parent_id === dropTarget.id)
              .sort((a, b) => a.sort_order - b.sort_order);
            baseSortOrder = calculateNewSortOrder(childFolders, 0, 'inside');
          } else {
            const targetFolder = folders.find(f => f.id === dropTarget.id);
            newParentId = targetFolder?.parent_id || null;
            const siblingFolders = folders
              .filter(f => f.parent_id === newParentId && !foldersToMove.includes(f.id))
              .sort((a, b) => a.sort_order - b.sort_order);
            const targetIndex = siblingFolders.findIndex(f => f.id === dropTarget.id);
            baseSortOrder = calculateNewSortOrder(siblingFolders, targetIndex, dropTarget.position);
          }
        } else {
          newParentId = null;
          const rootFolders = folders
            .filter(f => f.parent_id === null && !foldersToMove.includes(f.id))
            .sort((a, b) => a.sort_order - b.sort_order);
          baseSortOrder = calculateNewSortOrder(rootFolders, 0, 'inside');
        }

        // Filter out any folders that would create circular references
        const validFoldersToMove = foldersToMove.filter(folderId => {
          // Can't move a folder into itself or its descendants
          if (folderId === newParentId) return false;
          if (newParentId && getDescendantFolderIds(folderId).has(newParentId)) return false;
          return true;
        });

        // Move all valid selected folders
        for (let i = 0; i < validFoldersToMove.length; i++) {
          const folderId = validFoldersToMove[i];
          const newSortOrder = baseSortOrder + (i * 10); // Increment sort order for each

          setFolders(prev => prev.map(f =>
            f.id === folderId
              ? { ...f, parent_id: newParentId, sort_order: newSortOrder }
              : f
          ));
          await moveFolder(folderId, { parent_id: newParentId, sort_order: newSortOrder });
        }
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to move item'));
      await fetchData();
    }
  }, [draggedItem, dropTarget, sessions, folders, selectedSessionIds, selectedFolderIds, calculateNewSortOrder, getDescendantFolderIds, fetchData]);

  // Handle pointer up - execute drop
  const handlePointerUp = useCallback(async () => {
    // Only process if we were actually dragging (not just clicking)
    if (!isDragging) {
      // Just clean up without affecting click behavior
      setDragStartPos(null);
      setDraggedItem(null);
      return;
    }

    if (dropTarget) {
      // Execute the drop
      await executeDrop();
    }

    handleDragEnd();
  }, [isDragging, dropTarget, handleDragEnd, executeDrop]);

  const handleSessionSaved = (session: Session) => {
    if (editingSession) {
      // Update existing session
      setSessions(prev => prev.map(s => s.id === session.id ? session : s));
    } else {
      // Add new session
      setSessions(prev => [...prev, session]);
    }
    // Notify parent to update open tabs with new session data
    onSessionUpdated?.(session);
    setDialogOpen(false);
    setEditingSession(null);
    setDefaultFolderId(null);
  };

  const handleDialogClose = () => {
    setDialogOpen(false);
    setEditingSession(null);
    setDefaultFolderId(null);
  };

  const handleNewSession = () => {
    setEditingSession(null);
    setDefaultFolderId(null);
    setDialogOpen(true);
  };

  const handleNewFolder = async () => {
    try {
      const newFolder = await createFolder('New Folder');
      setFolders(prev => [...prev, newFolder]);
      setRenamingFolderId(newFolder.id);
      setRenameFolderValue(newFolder.name);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to create folder'));
    }
  };

  // Group sessions by folder (memoized to avoid rebuild on every render)
  const sessionsByFolder = useMemo(() => {
    const map = new Map<string | null, Session[]>();
    // When not searching, exclude favorites from folder lists (they show in Favorites section)
    const visibleSessions = searchQuery.trim() ? sessions : sessions.filter(s => !favoriteSessionIds.has(s.id));
    visibleSessions.forEach(session => {
      const folderId = session.folder_id;
      if (!map.has(folderId)) {
        map.set(folderId, []);
      }
      map.get(folderId)!.push(session);
    });
    map.forEach(folderSessions => {
      folderSessions.sort((a, b) => a.sort_order - b.sort_order);
    });
    return map;
  }, [sessions, searchQuery, favoriteSessionIds]);

  // Build folder tree for nested rendering (memoized)
  const { rootFolders, childFoldersByParent } = useMemo(() => {
    const roots = folders.filter(f => f.parent_id === null).sort((a, b) => a.sort_order - b.sort_order);
    const childMap = new Map<string, Folder[]>();
    folders.forEach(f => {
      if (f.parent_id) {
        if (!childMap.has(f.parent_id)) {
          childMap.set(f.parent_id, []);
        }
        childMap.get(f.parent_id)!.push(f);
      }
    });
    childMap.forEach(children => {
      children.sort((a, b) => a.sort_order - b.sort_order);
    });
    return { rootFolders: roots, childFoldersByParent: childMap };
  }, [folders]);

  // Filter sessions and folders based on search query
  const searchLower = searchQuery.toLowerCase().trim();
  const filteredSessions = useMemo(() => {
    let result = sessions;
    // When not searching, hide favorited sessions from the main list
    // (they appear in the Favorites section instead)
    if (!searchLower) {
      return result.filter(s => !favoriteSessionIds.has(s.id));
    }
    return result.filter(s =>
      s.name.toLowerCase().includes(searchLower) ||
      s.host.toLowerCase().includes(searchLower)
    );
  }, [sessions, searchLower, favoriteSessionIds]);

  // Get folder IDs that contain matching sessions (to show in search results)
  const foldersWithMatches = useMemo(() => {
    if (!searchLower) return new Set<string>();
    const ids = new Set<string>();
    filteredSessions.forEach(s => {
      if (s.folder_id) ids.add(s.folder_id);
    });
    // Also include parent folders
    const addParents = (folderId: string) => {
      const folder = folders.find(f => f.id === folderId);
      if (folder?.parent_id) {
        ids.add(folder.parent_id);
        addParents(folder.parent_id);
      }
    };
    [...ids].forEach(addParents);
    return ids;
  }, [filteredSessions, folders, searchLower]);

  // Build flat list of all session IDs in display order (for range selection)
  const allSessionIds = useMemo(() => {
    const ids: string[] = [];
    const collectFolderSessions = (folderId: string | null) => {
      const folderSessions = sessionsByFolder.get(folderId) || [];
      folderSessions.forEach(s => ids.push(s.id));
    };

    // Helper to collect sessions recursively
    const processFolder = (folder: Folder) => {
      collectFolderSessions(folder.id);
      const children = childFoldersByParent.get(folder.id) || [];
      children.forEach(processFolder);
    };

    // Process root folders first
    rootFolders.forEach(processFolder);
    // Then root-level sessions
    collectFolderSessions(null);

    return ids;
  // Note: These dependencies would trigger rebuilds on re-renders, but that's acceptable
  // since sessions/folders are stable between fetches
  }, [sessions, folders]);

  // Build flat list of all folder IDs in display order (for range selection)
  const allFolderIds = useMemo(() => {
    const ids: string[] = [];

    // Helper to collect folders recursively in display order
    const processFolder = (folder: Folder) => {
      ids.push(folder.id);
      const children = childFoldersByParent.get(folder.id) || [];
      children.forEach(processFolder);
    };

    // Process root folders first
    rootFolders.forEach(processFolder);

    return ids;
  }, [folders]);

  // Handle session click with modifier keys
  const handleSessionClick = useCallback((e: React.MouseEvent, sessionId: string) => {
    // Check for modifier keys
    const isCtrlCmd = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    if (isShift) {
      // Shift+Click: range selection
      rangeSelect(sessionId, allSessionIds);
    } else {
      // Plain click or Cmd/Ctrl+Click: toggle selection
      toggleSelection(sessionId, isCtrlCmd);
    }
  }, [rangeSelect, toggleSelection, allSessionIds]);

  // Set of filtered session IDs for O(1) lookup instead of O(n) .some()
  const filteredSessionIds = useMemo(() => {
    return new Set(filteredSessions.map(s => s.id));
  }, [filteredSessions]);

  // Check if session matches search filter - O(1) with Set
  const sessionMatchesSearch = useCallback((session: Session) => {
    if (!searchLower) return true;
    return filteredSessionIds.has(session.id);
  }, [searchLower, filteredSessionIds]);

  // Build flat list of visible items for virtualization
  type FlatItem =
    | { type: 'folder'; folder: Folder; depth: number }
    | { type: 'session'; session: Session; depth: number };

  const flatItems = useMemo(() => {
    const items: FlatItem[] = [];

    const addFolder = (folder: Folder, depth: number) => {
      // Skip folder if searching and no matching sessions in this folder or children
      if (searchLower && !foldersWithMatches.has(folder.id)) return;

      items.push({ type: 'folder', folder, depth });

      const isExpanded = expandedFolders.has(folder.id) || !!searchLower;
      if (isExpanded) {
        const childFolders = childFoldersByParent.get(folder.id) || [];
        childFolders.forEach(child => addFolder(child, depth + 1));

        const folderSessions = sessionsByFolder.get(folder.id) || [];
        folderSessions.forEach(session => {
          if (sessionMatchesSearch(session)) {
            items.push({ type: 'session', session, depth: depth + 1 });
          }
        });
      }
    };

    const addRootSessions = () => {
      const rootSessions = sessionsByFolder.get(null) || [];
      rootSessions.forEach(session => {
        if (sessionMatchesSearch(session)) {
          items.push({ type: 'session', session, depth: 0 });
        }
      });
    };

    if (sortOrder === 'default') {
      rootFolders.forEach(f => addFolder(f, 0));
      addRootSessions();
    } else {
      addRootSessions();
      rootFolders.forEach(f => addFolder(f, 0));
    }

    return items;
  }, [sessions, folders, expandedFolders, searchLower, sortOrder, sessionsByFolder, rootFolders, childFoldersByParent, foldersWithMatches, sessionMatchesSearch]);

  // Folder match counts (memoized for search performance)
  const folderMatchCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!searchLower) return counts;
    folders.forEach(folder => {
      const folderSessions = sessionsByFolder.get(folder.id) || [];
      counts.set(folder.id, folderSessions.filter(s => filteredSessionIds.has(s.id)).length);
    });
    return counts;
  }, [folders, sessionsByFolder, filteredSessionIds, searchLower]);

  // Virtualizer for flat item list - uses sessionListRef as scroll parent
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => sessionListRef.current,
    estimateSize: () => 32, // estimated row height in px
    overscan: 20, // render extra rows above/below viewport for smooth scrolling
  });

  // Render a single session item (used by virtualizer)
  const renderSessionItem = (session: Session, depth: number) => {
    const selected = isSelected(session.id);
    const isBeingDragged = draggedItem?.type === 'session' && draggedItem.id === session.id;
    const isDropTargetBefore = dropTarget?.type === 'session' && dropTarget.id === session.id && dropTarget.position === 'before';
    const isDropTargetAfter = dropTarget?.type === 'session' && dropTarget.id === session.id && dropTarget.position === 'after';

    return (
      <div
        data-session-id={session.id}
        data-testid="session-item"
        className={`session-item ${selected ? 'session-item-selected' : ''} ${isBeingDragged ? 'dragging' : ''} ${isDropTargetBefore ? 'drag-over-top' : ''} ${isDropTargetAfter ? 'drag-over-bottom' : ''}`}
        onPointerDown={(e) => handlePointerDown(e, { id: session.id, type: 'session' })}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClick={(e) => handleSessionClick(e, session.id)}
        onDoubleClick={() => onConnect(session)}
        onContextMenu={(e) => handleSessionContextMenu(e, session.id)}
        title={`${session.host}:${session.port}`}
        style={{ touchAction: 'none', marginLeft: depth > 0 ? `${depth * 16}px` : undefined }}
      >
        <div className="session-item-header">
          <button
            className={`session-favorite-btn ${isFavorite(session.id) ? 'is-favorite' : ''}`}
            onClick={(e) => toggleFavorite(session.id, e)}
            title={isFavorite(session.id) ? 'Remove from favorites' : 'Add to favorites'}
          >
            {isFavorite(session.id) ? Icons.starFilled : Icons.star}
          </button>
          <span className="session-item-name">{session.name}</span>
          <button
            className="session-connect-btn"
            onClick={(e) => {
              e.stopPropagation();
              onConnect(session);
            }}
            title="Connect"
          >
            Connect
          </button>
        </div>
        <div className="session-item-details">
          <div className="session-item-details-inner">
            <div className="session-item-host">{session.host}:{session.port}</div>
          </div>
        </div>
      </div>
    );
  };

  // Render a folder header item (used by virtualizer)
  const renderFolderItem = (folder: Folder, depth: number) => {
    const isExpanded = expandedFolders.has(folder.id) || !!searchLower;
    const folderSessions = sessionsByFolder.get(folder.id) || [];
    const childFolders = childFoldersByParent.get(folder.id) || [];
    const isRenaming = renamingFolderId === folder.id;

    const matchingCount = searchLower
      ? (folderMatchCounts.get(folder.id) || 0)
      : folderSessions.length + childFolders.length;

    const isBeingDragged = draggedItem?.type === 'folder' && draggedItem.id === folder.id;
    const isDropTargetBefore = dropTarget?.type === 'folder' && dropTarget.id === folder.id && dropTarget.position === 'before';
    const isDropTargetAfter = dropTarget?.type === 'folder' && dropTarget.id === folder.id && dropTarget.position === 'after';
    const isDropTargetInside = dropTarget?.type === 'folder' && dropTarget.id === folder.id && dropTarget.position === 'inside';
    const isInvalidDropTarget = draggedItem?.type === 'folder' && (
      draggedItem.id === folder.id ||
      getDescendantFolderIds(draggedItem.id).has(folder.id)
    );
    const folderSelected = isFolderSelected(folder.id);

    return (
      <div
        data-folder-id={folder.id}
        className={`folder-header ${folderSelected ? 'folder-selected' : ''} ${isBeingDragged ? 'dragging' : ''} ${isDropTargetBefore ? 'drag-over-top' : ''} ${isDropTargetAfter ? 'drag-over-bottom' : ''} ${isDropTargetInside ? 'drag-over-inside' : ''} ${isInvalidDropTarget && draggedItem ? 'drop-invalid' : ''}`}
        onPointerDown={(e) => !isRenaming && handlePointerDown(e, { id: folder.id, type: 'folder' })}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{ touchAction: 'none', paddingLeft: depth > 0 ? `${depth * 16}px` : undefined }}
        onClick={(e) => {
          if (isRenaming) return;
          const isCtrlCmd = e.metaKey || e.ctrlKey;
          const isShift = e.shiftKey;

          e.preventDefault();

          if (isShift) {
            rangeFolderSelect(folder.id, allFolderIds);
          } else if (isCtrlCmd) {
            toggleFolderSelection(folder.id, true);
          } else {
            toggleFolderSelection(folder.id, false);
          }
        }}
        onDoubleClick={() => {
          toggleFolder(folder.id);
        }}
        onContextMenu={(e) => handleFolderContextMenu(e, folder.id)}
      >
        <span
          className="folder-chevron"
          onClick={(e) => {
            e.stopPropagation();
            toggleFolder(folder.id);
          }}
        >
          {isExpanded ? Icons.chevronDown : Icons.chevronRight}
        </span>
        <span
          className="folder-icon"
          onClick={(e) => {
            e.stopPropagation();
            toggleFolder(folder.id);
          }}
        >
          {isExpanded ? Icons.folderOpen : Icons.folder}
        </span>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="folder-rename-input"
            value={renameFolderValue}
            onChange={(e) => setRenameFolderValue(e.target.value)}
            onBlur={handleRenameFolderSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameFolderSubmit();
              if (e.key === 'Escape') setRenamingFolderId(null);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="folder-name">{folder.name}</span>
        )}
        <span className="folder-count">{matchingCount}</span>
      </div>
    );
  };

  return (
    <div className="session-panel" data-testid="session-panel">
      {/* Sub-tab navigation (Phase 25) */}
      <div className="session-panel-tabs">
        <button
          className={`session-panel-tab ${activeSubTab === 'sessions' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('sessions')} data-testid="tab-sessions"
        >
          Sessions
        </button>
        <button
          className={`session-panel-tab ${activeSubTab === 'groups' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('groups')}
          data-testid="tab-groups"
        >
          Groups
        </button>
      </div>

      {activeSubTab === 'sessions' ? (
        <>
          <div className="session-panel-toolbar">
            <button
              className="session-panel-btn icon-only primary"
              onClick={handleNewSession} data-testid="btn-new-session"
              title="New Session"
            >
              {Icons.plus}
            </button>
            <button
              className="session-panel-btn icon-only"
              onClick={handleNewFolder}
              title="New Folder"
            >
              {Icons.folderPlus}
            </button>
            <button
              className="session-panel-btn icon-only"
              onClick={onOpenLocalShell}
              title="Local Shell"
            >
              {Icons.terminal}
            </button>
            <button
              className="session-panel-btn icon-only"
              onClick={fetchData}
              title="Refresh"
              disabled={loading}
            >
              {Icons.refresh}
            </button>
            <button
              className={`session-panel-btn icon-only ${sortOrder === 'reverse' ? 'active' : ''}`}
              onClick={toggleSortOrder}
              title={sortOrder === 'default' ? 'Sort: Folders first (click to show sessions first)' : 'Sort: Sessions first (click to show folders first)'}
            >
              {sortOrder === 'default' ? Icons.sortAsc : Icons.sortDesc}
            </button>
            <div className="session-panel-toolbar-separator" />
            <button
              className="session-panel-btn icon-only"
              onClick={handleExportCSV}
              title="Export CSV"
            >
              {Icons.export}
            </button>
            <button
              className="session-panel-btn icon-only"
              onClick={handleImportSessions}
              title="Import CSV/JSON"
            >
              {Icons.import}
            </button>
            <button
              className="session-panel-btn icon-only"
              onClick={handleDownloadExampleCSV}
              title="Download Example CSV Template"
            >
              {Icons.duplicate}
            </button>
          </div>

          {/* Search input */}
          <div className="session-search">
            <span className="session-search-icon">{Icons.search}</span>
            <input
              type="text"
              className="session-search-input"
              placeholder="Search sessions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="session-search-clear"
                onClick={() => setSearchQuery('')}
                title="Clear search"
              >
                {Icons.x}
              </button>
            )}
          </div>

          {/* Hidden file input for import */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.csv"
            style={{ display: 'none' }}
            onChange={handleFileImport}
          />

          {loading && (
            <div className="session-panel-status">
              Loading sessions...
            </div>
          )}

          {error && (
            <div className="session-panel-error">
              {error}
              <button onClick={fetchData}>Retry</button>
            </div>
          )}

          {!loading && !error && (
            <div
              ref={sessionListRef}
              className={`session-list ${dropTarget?.type === 'root' ? 'drag-over-root' : ''}`}
            >
              {/* Favorites Section - hide during search */}
              {!searchLower && favoriteSessions.length > 0 && (
                <div className="favorites-section">
                  <div
                    className="favorites-section-header"
                    onClick={() => setShowFavorites(!showFavorites)}
                  >
                    <span className="folder-chevron">
                      {showFavorites ? Icons.chevronDown : Icons.chevronRight}
                    </span>
                    {Icons.starFilled}
                    <span className="folder-name">Favorites</span>
                    <span className="folder-count">{favoriteSessions.length}</span>
                  </div>
                  {showFavorites && (
                    <div className="favorites-section-list">
                      {favoriteSessions.map(session => (
                        <div
                          key={`fav-${session.id}`}
                          className="session-item session-item-favorite"
                          onDoubleClick={() => onConnect(session)}
                          onContextMenu={(e) => handleSessionContextMenu(e, session.id)}
                          title={`${session.host}:${session.port}`}
                        >
                          <div className="session-item-header">
                            <button
                              className="session-favorite-btn is-favorite"
                              onClick={(e) => toggleFavorite(session.id, e)}
                              title="Remove from favorites"
                            >
                              {Icons.starFilled}
                            </button>
                            <span className="session-item-name">{session.name}</span>
                            <button
                              className="session-connect-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                onConnect(session);
                              }}
                              title="Connect"
                            >
                              Connect
                            </button>
                          </div>
                          <div className="session-item-details">
                            <div className="session-item-details-inner">
                              <div className="session-item-host">{session.host}:{session.port}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Recent Connections Section - hide during search */}
              {!searchLower && recentConnections.length > 0 && (
                <div className="recent-section">
                  <div
                    className="recent-section-header"
                    onClick={() => setShowRecent(!showRecent)}
                  >
                    <span className="folder-chevron">
                      {showRecent ? Icons.chevronDown : Icons.chevronRight}
                    </span>
                    {Icons.clock}
                    <span className="folder-name">Recent</span>
                    <span className="folder-count">{recentConnections.length}</span>
                  </div>
                  {showRecent && (
                    <div className="recent-section-list">
                      {recentConnections.map(entry => {
                        // Find matching session if exists
                        const session = entry.session_id ? sessions.find(s => s.id === entry.session_id) : null;
                        return (
                          <div
                            key={entry.id}
                            className="recent-connection-item"
                            onClick={() => {
                              if (session) {
                                onConnect(session);
                              }
                            }}
                            title={`${entry.username}@${entry.host}:${entry.port}`}
                          >
                            <span className="recent-status-dot" />
                            <span className="recent-name">
                              {session?.name || `${entry.username}@${entry.host}`}
                            </span>
                            <span className="recent-time">{formatRelativeTime(entry.connected_at)}</span>
                            <button
                              className="recent-clear-btn"
                              title="Remove from history"
                              onClick={async (e) => {
                                e.stopPropagation();
                                // Optimistic remove; if delete fails the next
                                // fetchData() re-adds it.
                                setRecentConnections(prev => prev.filter(r => r.id !== entry.id));
                                try {
                                  await deleteHistory(entry.id);
                                } catch (err) {
                                  console.error('Failed to delete history entry:', err);
                                }
                              }}
                            >
                              &times;
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Virtualized session/folder list */}
              {flatItems.length > 0 && (
                <div
                  style={{
                    height: `${virtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                  }}
                >
                  {virtualizer.getVirtualItems().map(virtualRow => {
                    const item = flatItems[virtualRow.index];
                    return (
                      <div
                        key={virtualRow.key}
                        data-index={virtualRow.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        {item.type === 'folder'
                          ? renderFolderItem(item.folder, item.depth)
                          : renderSessionItem(item.session, item.depth)
                        }
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Search results info */}
              {searchLower && filteredSessions.length > 0 && (
                <div className="session-search-results">
                  {filteredSessions.length} session{filteredSessions.length !== 1 ? 's' : ''} found
                </div>
              )}

              {/* No search results */}
              {searchLower && filteredSessions.length === 0 && (
                <div className="session-panel-empty">
                  No sessions match "{searchQuery}"
                </div>
              )}

              {/* Empty state - no sessions at all */}
              {!searchLower && sessions.length === 0 && folders.length === 0 && (
                <div className="session-panel-empty">
                  No sessions configured.
                  <br />
                  Click + to add one.
                </div>
              )}

              </div>
          )}
        </>
      ) : (
        <GroupsPanel
          liveGroupId={liveGroupId ?? null}
          onLaunchGroup={onLaunchGroup ?? (() => {})}
          onSaveCurrentAsGroup={onSaveCurrentAsGroup ?? (() => {})}
          onTabDroppedOnGroup={onTabDroppedOnGroup ?? (() => {})}
          onDiscoverTopology={onDiscoverTopology ?? (() => {})}
          onOpenTopology={onOpenTopology ?? (() => {})}
          getTabTitle={getTabTitle ?? ((id) => id)}
          refreshKey={groupsRefreshKey ?? 0}
        />
      )}

      {/* Session Context Menu */}
      {sessionContextMenu && (
        <div
          ref={sessionMenuRef}
          className="session-context-menu"
          style={sessionMenuStyle}
        >
          {/* Bulk actions when multiple sessions selected */}
          {selectionCount > 1 && (
            <>
              <button
                className="context-menu-item"
                onClick={async () => {
                  setSessionContextMenu(null);
                  if (!onBulkConnect || bulkConnecting) return;
                  setBulkConnecting(true);
                  try {
                    await onBulkConnect(Array.from(selectedSessionIds));
                    clearSelection();
                  } catch (err) {
                    console.error('Bulk connect failed:', err);
                  } finally {
                    setBulkConnecting(false);
                  }
                }}
                disabled={bulkConnecting || !onBulkConnect}
              >
                {Icons.connect}
                <span>Connect All ({selectionCount})</span>
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  setSessionContextMenu(null);
                  setBroadcastDialogOpen(true);
                }}
              >
                {Icons.broadcast}
                <span>Broadcast Command...</span>
              </button>
              <button
                className="context-menu-item danger"
                onClick={async () => {
                  setSessionContextMenu(null);
                  const ok = await confirmDialog({
                    title: 'Delete selected sessions?',
                    body: `Delete ${selectedSessionIds.size} session${selectedSessionIds.size === 1 ? '' : 's'}? Empty folders will be cleaned up.`,
                    confirmLabel: 'Delete',
                    destructive: true,
                  });
                  if (!ok) return;
                  try {
                    const result = await bulkDeleteSessions(Array.from(selectedSessionIds));
                    // Remove deleted sessions from local state
                    const remainingSessions = sessions.filter(s => !selectedSessionIds.has(s.id));
                    setSessions(remainingSessions);
                    clearSelection();

                    // Check for empty folders and offer to delete them
                    // Find all folders that became empty (recursively from leaves up)
                    const findEmptyFolders = (currentFolders: typeof folders, currentSessions: typeof sessions): typeof folders => {
                      const empty: typeof folders = [];
                      let remaining = [...currentFolders];
                      let changed = true;

                      while (changed) {
                        changed = false;
                        const newEmpty: typeof folders = [];
                        remaining = remaining.filter(f => {
                          const hasSession = currentSessions.some(s => s.folder_id === f.id);
                          const hasChildFolder = remaining.some(child => child.parent_id === f.id && !empty.some(e => e.id === child.id));
                          if (!hasSession && !hasChildFolder) {
                            newEmpty.push(f);
                            changed = true;
                            return false;
                          }
                          return true;
                        });
                        empty.push(...newEmpty);
                      }
                      return empty;
                    };

                    const emptyFolders = findEmptyFolders(folders, remainingSessions);

                    if (emptyFolders.length > 0) {
                      // Auto-delete empty folders
                      const foldersToDelete = [...emptyFolders].reverse();
                      for (const folder of foldersToDelete) {
                        try {
                          await deleteFolder(folder.id);
                        } catch (e) {
                          console.error('Failed to delete folder:', folder.name, e);
                        }
                      }
                      setFolders(prev => prev.filter(f => !emptyFolders.some(ef => ef.id === f.id)));
                    }

                    if (result.failed > 0) {
                      setError(`Deleted ${result.deleted} sessions, ${result.failed} failed`);
                    }
                  } catch (err) {
                    setError(getErrorMessage(err, 'Failed to delete sessions'));
                  }
                }}
              >
                {Icons.trash}
                <span>Delete Selected ({selectionCount})</span>
              </button>
              <div className="context-menu-divider" />
            </>
          )}
          <button
            className="context-menu-item"
            onClick={() => handleConnectSession(sessionContextMenu.sessionId)}
          >
            {Icons.connect}
            <span>Connect</span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => handleConnectSession(sessionContextMenu.sessionId)}
          >
            {Icons.newTab}
            <span>Connect in New Tab</span>
          </button>
          {isSessionConnected(sessionContextMenu.sessionId) && onDisconnect && (
            <button
              className="context-menu-item"
              onClick={() => handleDisconnectSession(sessionContextMenu.sessionId)}
              title="Close every connected terminal tab for this session"
            >
              <span>Disconnect</span>
            </button>
          )}
          <div className="context-menu-divider" />
          <button
            className="context-menu-item"
            onClick={() => {
              toggleFavorite(sessionContextMenu.sessionId);
              setSessionContextMenu(null);
            }}
          >
            {isFavorite(sessionContextMenu.sessionId) ? Icons.starFilled : Icons.star}
            <span>{isFavorite(sessionContextMenu.sessionId) ? 'Remove from Favorites' : 'Add to Favorites'}</span>
          </button>
          {(() => {
            const sess = sessions.find(s => s.id === sessionContextMenu.sessionId)
            if (sess && sess.protocol === 'ssh' && (sess.cli_flavor === 'linux' || sess.cli_flavor === 'auto') && onOpenRemoteWindow) {
              return (
                <>
                  <div className="context-menu-divider" />
                  <button
                    className="context-menu-item"
                    onClick={() => { onOpenRemoteWindow(sessionContextMenu.sessionId); setSessionContextMenu(null) }}
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16">
                      <path d="M14 1H2a1 1 0 00-1 1v8a1 1 0 001 1h5v2H5v1h6v-1H9v-2h5a1 1 0 001-1V2a1 1 0 00-1-1zm0 9H2V2h12v8z"/>
                    </svg>
                    <span>Open Remote Window</span>
                  </button>
                </>
              )
            }
            return null
          })()}
          <div className="context-menu-divider" />
          <button
            className="context-menu-item"
            onClick={() => handleOpenSettings(sessionContextMenu.sessionId)}
          >
            {Icons.settings}
            <span>Settings...</span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => handleDuplicateSession(sessionContextMenu.sessionId)}
          >
            {Icons.duplicate}
            <span>Duplicate Session</span>
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item"
            onClick={() => handleExportSession(sessionContextMenu.sessionId)}
          >
            {Icons.export}
            <span>Export Session...</span>
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item danger"
            onClick={() => handleDeleteSession(sessionContextMenu.sessionId)}
          >
            {Icons.trash}
            <span>Delete Session</span>
          </button>
        </div>
      )}

      {/* Folder Context Menu */}
      {folderContextMenu && (
        <div
          ref={folderMenuRef}
          className="session-context-menu"
          style={folderMenuStyle}
        >
          <button
            className="context-menu-item"
            onClick={() => handleNewSessionInFolder(folderContextMenu.folderId)}
          >
            {Icons.plus}
            <span>New Session in Folder</span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => handleNewSubfolder(folderContextMenu.folderId)}
          >
            {Icons.folderPlus}
            <span>New Subfolder</span>
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item"
            onClick={() => handleRenameFolder(folderContextMenu.folderId)}
          >
            {Icons.edit}
            <span>Rename Folder</span>
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item"
            onClick={() => {
              expandAllFolders();
              setFolderContextMenu(null);
            }}
          >
            {Icons.expandAll}
            <span>Expand All Folders</span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              collapseAllFolders();
              setFolderContextMenu(null);
            }}
          >
            {Icons.collapseAll}
            <span>Collapse All Folders</span>
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item"
            onClick={() => handleExportFolder(folderContextMenu.folderId)}
          >
            {Icons.export}
            <span>Export Folder...</span>
          </button>
          <button
            className="context-menu-item"
            onClick={handleImportSessions}
          >
            {Icons.import}
            <span>Import Sessions...</span>
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item danger"
            onClick={() => handleDeleteFolder(folderContextMenu.folderId)}
          >
            {Icons.trash}
            <span>Delete Folder</span>
          </button>
        </div>
      )}

      {/* Session Dialog (Create/Edit) */}
      <SessionSettingsDialog
        isOpen={dialogOpen}
        session={editingSession}
        onClose={handleDialogClose}
        onSessionSaved={handleSessionSaved}
        defaultFolderId={defaultFolderId}
      />

      {/* Broadcast Command Dialog */}
      <BroadcastCommandDialog
        isOpen={broadcastDialogOpen}
        onClose={() => setBroadcastDialogOpen(false)}
        selectedSessionIds={Array.from(selectedSessionIds)}
        sessions={sessions}
      />

      {/* Drag Preview */}
      {isDragging && draggedItem && (
        <div
          ref={dragPreviewRef}
          className="drag-preview"
          style={{
            position: 'fixed',
            pointerEvents: 'none',
            zIndex: 9999,
          }}
        >
          {draggedItem.type === 'folder' ? (
            <div className="drag-preview-folder">
              {Icons.folder}
              <span>{folders.find(f => f.id === draggedItem.id)?.name || 'Folder'}</span>
            </div>
          ) : (
            <div className="drag-preview-session">
              <span>{sessions.find(s => s.id === draggedItem.id)?.name || 'Session'}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Wrapper component that provides the SessionSelectionProvider context
function SessionPanel(props: SessionPanelProps) {
  return (
    <SessionSelectionProvider>
      <SessionPanelContent {...props} />
    </SessionSelectionProvider>
  );
}

export default SessionPanel;
