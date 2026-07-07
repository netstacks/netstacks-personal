// TopologyPanel - Sidebar panel for saved topologies with folders, drag-drop, multi-select
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  listTopologies,
  listTopologyFolders,
  createTopologyFolder,
  moveTopology,
  bulkDeleteTopologies,
  deleteTopology,
  updateTopologyName,
  shareTopology,
  type SavedTopologyListItem,
} from '../api/topology';
import { useClampedMenuPosition } from '../hooks/useClampedMenuPosition';
import type { Folder } from '../api/topology';
import { updateTopologyFolder, deleteTopologyFolder, moveTopologyFolder, importTopologyFromJson } from '../api/topology';
import { showToast } from './Toast';
import { getCurrentMode } from '../api/client';
import { ItemSelectionProvider, useItemSelection } from '../hooks/useItemSelection';
import NewTopologyDialog from './NewTopologyDialog';
import TracerouteDialog from './TracerouteDialog';
import type { Topology, Device, DeviceStatus } from '../types/topology';
import './TopologyPanel.css';
import { confirmDialog } from './ConfirmDialog';
import { usePersistedState } from '../hooks/usePersistedState';
import { useHostnameFormatter } from '../hooks/useHostnameFormatter';

import { getErrorMessage } from '../api/errors'
const isSortOrder = (v: unknown): v is 'default' | 'reverse' =>
  v === 'default' || v === 'reverse';

// Drag and drop types
type DragItemType = 'topology' | 'folder';
interface DragItem {
  id: string;
  type: DragItemType;
}
interface DropTarget {
  id: string;
  position: 'before' | 'after' | 'inside';
  type: 'topology' | 'folder' | 'root';
}

interface TopologyPanelProps {
  // Active topology (when a topology tab is open)
  activeTopology?: Topology | null;
  selectedDeviceId?: string | null;
  onDeviceSelect?: (device: Device) => void;
  onDeviceConnect?: (device: Device) => void;
  // Open topology as tab (optional - provides saved topologies list if provided)
  onOpenTopology?: (topologyId: string, topologyName: string) => void;
  // Open traceroute topology (in-memory)
  onOpenTracerouteTopology?: (topology: Topology) => void;
  // Start discovery for new topology
  onStartDiscovery?: (name: string, sessions: { id: string; name: string; host?: string; profileId?: string; cliFlavor?: string; credentialId?: string; snmpCredentialId?: string }[]) => void;
  // Connected session IDs for session picker
  connectedSessionIds?: string[];
}

// Device status colors
const STATUS_COLORS: Record<DeviceStatus, string> = {
  online: '#4caf50',
  offline: '#f44336',
  warning: '#ff9800',
  unknown: '#9e9e9e',
};

// Icons
const Icons = {
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  import: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  route: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
      <path d="M7 12h3M14 12h3" strokeDasharray="2 2" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
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
  folderPlus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
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
  sortAsc: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 4h13M3 8h9M3 12h5" />
      <path d="M17 4v16M14 17l3 3 3-3" />
    </svg>
  ),
  sortDesc: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 4h5M3 8h9M3 12h13" />
      <path d="M17 20V4M14 7l3-3 3 3" />
    </svg>
  ),
  expandAll: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 6h16M4 12h16M4 18h16" />
      <path d="M9 3l3 3 3-3M9 21l3-3 3 3" />
    </svg>
  ),
  collapseAll: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 6h16M4 12h16M4 18h16" />
      <path d="M9 9l3-3 3 3M9 15l3 3 3-3" />
    </svg>
  ),
};

function TopologyPanelContent({
  activeTopology,
  selectedDeviceId,
  onDeviceSelect,
  onDeviceConnect,
  onOpenTopology,
  onOpenTracerouteTopology,
  onStartDiscovery,
  connectedSessionIds = [],
}: TopologyPanelProps) {
  const formatName = useHostnameFormatter();
  const currentTopology = activeTopology ?? null;
  const isEnterprise = getCurrentMode() === 'enterprise';

  // --- Data State ---
  const [topologies, setTopologies] = useState<SavedTopologyListItem[]>([]);
  const [teamTopologies, setTeamTopologies] = useState<SavedTopologyListItem[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // --- UI State ---
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [tracerouteDialogOpen, setTracerouteDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [sortOrder, setSortOrder] = usePersistedState<'default' | 'reverse'>(
    'topology-panel-sort-order',
    'default',
    { validate: isSortOrder },
  );

  // --- Context Menu State ---
  const [topologyContextMenu, setTopologyContextMenu] = useState<{
    x: number; y: number; topologyId: string;
  } | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{
    x: number; y: number; folderId: string;
  } | null>(null);
  const { ref: topologyMenuRef, style: topologyMenuStyle } = useClampedMenuPosition(topologyContextMenu);
  const { ref: folderMenuRef, style: folderMenuStyle } = useClampedMenuPosition(folderContextMenu);

  // --- Rename State ---
  const [renamingTopologyId, setRenamingTopologyId] = useState<string | null>(null);
  const [renameTopologyValue, setRenameTopologyValue] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameTopologyInputRef = useRef<HTMLInputElement>(null);

  // --- Drag and Drop State ---
  const [draggedItem, setDraggedItem] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
  const autoExpandTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // --- Selection Hook ---
  const {
    selectedItemIds,
    toggleItemSelection,
    rangeItemSelect,
    clearItemSelection,
    isItemSelected,
    itemSelectionCount,
    selectedFolderIds,
    toggleFolderSelection,
    rangeFolderSelect,
    isFolderSelected,
  } = useItemSelection();

  // ── Data Fetching ──

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [topologiesData, foldersData] = await Promise.all([
        listTopologies(),
        listTopologyFolders().catch(() => [] as Folder[]),
      ]);
      setTopologies(topologiesData);
      setFolders(foldersData);

      // In enterprise mode, also load shared team topologies
      if (isEnterprise) {
        const shared = await listTopologies({ shared: true });
        const ownIds = new Set(topologiesData.map(t => t.id));
        setTeamTopologies(shared.filter(t => !ownIds.has(t.id)));
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load topologies'));
      console.error('Failed to load topologies:', err);
    } finally {
      setLoading(false);
    }
  }, [isEnterprise]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Refresh when a topology is created outside this panel (e.g. discovery flow).
  useEffect(() => {
    const onChanged = () => fetchData();
    window.addEventListener('topologies-changed', onChanged);
    return () => window.removeEventListener('topologies-changed', onChanged);
  }, [fetchData]);

  // ── Focus rename inputs ──

  useEffect(() => {
    if (renamingFolderId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingFolderId]);

  useEffect(() => {
    if (renamingTopologyId && renameTopologyInputRef.current) {
      renameTopologyInputRef.current.focus();
      renameTopologyInputRef.current.select();
    }
  }, [renamingTopologyId]);

  // ── Close context menus on outside click ──

  useEffect(() => {
    const handleClick = () => {
      setTopologyContextMenu(null);
      setFolderContextMenu(null);
    };
    if (topologyContextMenu || folderContextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [topologyContextMenu, folderContextMenu]);

  // ── Sort Order Toggle ──

  const toggleSortOrder = useCallback(() => {
    setSortOrder(prev => (prev === 'default' ? 'reverse' : 'default'));
  }, [setSortOrder]);

  // ── Folder expand/collapse ──

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

  const expandAllFolders = useCallback(() => {
    setExpandedFolders(new Set(folders.map(f => f.id)));
  }, [folders]);

  const collapseAllFolders = useCallback(() => {
    setExpandedFolders(new Set());
  }, []);

  // ── Memoized Data ──

  // Group topologies by folder_id
  const topologiesByFolder = useMemo(() => {
    const map = new Map<string | null, SavedTopologyListItem[]>();
    topologies.forEach(topo => {
      const folderId = topo.folder_id;
      if (!map.has(folderId)) {
        map.set(folderId, []);
      }
      map.get(folderId)!.push(topo);
    });
    map.forEach(folderTopos => {
      folderTopos.sort((a, b) => a.sort_order - b.sort_order);
    });
    return map;
  }, [topologies]);

  // Build folder tree
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

  // Filter topologies by search query
  const searchLower = searchQuery.toLowerCase().trim();

  const filteredTopologies = useMemo(() => {
    if (!searchLower) return topologies;
    return topologies.filter(t =>
      t.name.toLowerCase().includes(searchLower)
    );
  }, [topologies, searchLower]);

  const filteredTeamTopologies = useMemo(() => {
    if (!searchLower) return teamTopologies;
    return teamTopologies.filter(t =>
      t.name.toLowerCase().includes(searchLower)
    );
  }, [teamTopologies, searchLower]);

  // Set of filtered topology IDs for O(1) lookup
  const filteredTopologyIds = useMemo(() => {
    return new Set(filteredTopologies.map(t => t.id));
  }, [filteredTopologies]);

  // Check if topology matches search
  const topologyMatchesSearch = useCallback((topo: SavedTopologyListItem) => {
    if (!searchLower) return true;
    return filteredTopologyIds.has(topo.id);
  }, [searchLower, filteredTopologyIds]);

  // Get folder IDs that contain matching topologies
  const foldersWithMatches = useMemo(() => {
    if (!searchLower) return new Set<string>();
    const ids = new Set<string>();
    filteredTopologies.forEach(t => {
      if (t.folder_id) ids.add(t.folder_id);
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
  }, [filteredTopologies, folders, searchLower]);

  // Folder match counts for search badges
  const folderMatchCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!searchLower) return counts;
    folders.forEach(folder => {
      const folderTopos = topologiesByFolder.get(folder.id) || [];
      counts.set(folder.id, folderTopos.filter(t => filteredTopologyIds.has(t.id)).length);
    });
    return counts;
  }, [folders, topologiesByFolder, filteredTopologyIds, searchLower]);

  // Build flat list for virtualization
  type FlatItem =
    | { type: 'folder'; folder: Folder; depth: number }
    | { type: 'topology'; topology: SavedTopologyListItem; depth: number };

  const flatItems = useMemo(() => {
    const items: FlatItem[] = [];

    const addFolder = (folder: Folder, depth: number) => {
      // Skip folder if searching and no matching topologies in this subtree
      if (searchLower && !foldersWithMatches.has(folder.id)) return;

      items.push({ type: 'folder', folder, depth });

      const isExpanded = expandedFolders.has(folder.id) || !!searchLower;
      if (isExpanded) {
        const childFolders = childFoldersByParent.get(folder.id) || [];
        childFolders.forEach(child => addFolder(child, depth + 1));

        const folderTopos = topologiesByFolder.get(folder.id) || [];
        folderTopos.forEach(topo => {
          if (topologyMatchesSearch(topo)) {
            items.push({ type: 'topology', topology: topo, depth: depth + 1 });
          }
        });
      }
    };

    const addRootTopologies = () => {
      const rootTopos = topologiesByFolder.get(null) || [];
      rootTopos.forEach(topo => {
        if (topologyMatchesSearch(topo)) {
          items.push({ type: 'topology', topology: topo, depth: 0 });
        }
      });
    };

    if (sortOrder === 'default') {
      rootFolders.forEach(f => addFolder(f, 0));
      addRootTopologies();
    } else {
      addRootTopologies();
      rootFolders.forEach(f => addFolder(f, 0));
    }

    return items;
  }, [topologies, folders, expandedFolders, searchLower, sortOrder, topologiesByFolder, rootFolders, childFoldersByParent, foldersWithMatches, topologyMatchesSearch]);

  // Build flat ID lists for range selection
  const allTopologyIds = useMemo(() => {
    const ids: string[] = [];
    const collectFolderTopos = (folderId: string | null) => {
      const folderTopos = topologiesByFolder.get(folderId) || [];
      folderTopos.forEach(t => ids.push(t.id));
    };
    const processFolder = (folder: Folder) => {
      collectFolderTopos(folder.id);
      const children = childFoldersByParent.get(folder.id) || [];
      children.forEach(processFolder);
    };
    rootFolders.forEach(processFolder);
    collectFolderTopos(null);
    return ids;
  }, [topologies, folders]);

  const allFolderIds = useMemo(() => {
    const ids: string[] = [];
    const processFolder = (folder: Folder) => {
      ids.push(folder.id);
      const children = childFoldersByParent.get(folder.id) || [];
      children.forEach(processFolder);
    };
    rootFolders.forEach(processFolder);
    return ids;
  }, [folders]);

  // ── Virtualizer ──

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 32,
    overscan: 20,
  });

  // ── Selection Handlers ──

  const handleTopologyClick = useCallback((e: React.MouseEvent, topologyId: string) => {
    const isCtrlCmd = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    if (isShift) {
      rangeItemSelect(topologyId, allTopologyIds);
    } else {
      toggleItemSelection(topologyId, isCtrlCmd);
    }
  }, [rangeItemSelect, toggleItemSelection, allTopologyIds]);

  // ── Context Menu Handlers ──

  const handleTopologyContextMenu = (e: React.MouseEvent, topologyId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderContextMenu(null);
    setTopologyContextMenu({ x: e.clientX, y: e.clientY, topologyId });
  };

  const handleFolderContextMenu = (e: React.MouseEvent, folderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setTopologyContextMenu(null);
    setFolderContextMenu({ x: e.clientX, y: e.clientY, folderId });
  };

  // ── Topology Actions ──

  const handleRenameTopology = (topo: SavedTopologyListItem) => {
    setRenamingTopologyId(topo.id);
    setRenameTopologyValue(topo.name);
    setTopologyContextMenu(null);
  };

  const submitRenameTopology = async (id: string) => {
    if (!renameTopologyValue.trim()) {
      setRenamingTopologyId(null);
      return;
    }
    try {
      await updateTopologyName(id, renameTopologyValue.trim());
      setTopologies(prev =>
        prev.map(t => t.id === id ? { ...t, name: renameTopologyValue.trim() } : t)
      );
    } catch (err) {
      console.error('Failed to rename topology:', err);
    }
    setRenamingTopologyId(null);
  };

  const handleDeleteTopology = async (topologyId: string) => {
    setTopologyContextMenu(null);
    try {
      await deleteTopology(topologyId);
      setTopologies(prev => prev.filter(t => t.id !== topologyId));
    } catch (err) {
      console.error('Failed to delete topology:', err);
    }
  };

  const handleBulkDelete = async () => {
    setTopologyContextMenu(null);
    try {
      const ids = Array.from(selectedItemIds);
      const result = await bulkDeleteTopologies(ids);
      setTopologies(prev => prev.filter(t => !selectedItemIds.has(t.id)));
      clearItemSelection();

      if (result.failed > 0) {
        setError(`Deleted ${result.deleted} topologies, ${result.failed} failed`);
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete topologies'));
    }
  };

  const handleShareTopology = async (topo: SavedTopologyListItem) => {
    setTopologyContextMenu(null);
    const newShared = !topo.shared;
    try {
      await shareTopology(topo.id, newShared);
      setTopologies(prev =>
        prev.map(t => t.id === topo.id ? { ...t, shared: newShared } : t)
      );
    } catch (err) {
      console.error('Failed to share topology:', err);
    }
  };

  // ── Folder Actions ──

  const handleNewFolder = async () => {
    try {
      const newFolder = await createTopologyFolder('New Folder');
      setFolders(prev => [...prev, newFolder]);
      setRenamingFolderId(newFolder.id);
      setRenameFolderValue(newFolder.name);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to create folder'));
    }
  };

  const handleNewSubfolder = async (parentId: string) => {
    try {
      const newFolder = await createTopologyFolder('New Folder', parentId);
      setFolders(prev => [...prev, newFolder]);
      setExpandedFolders(prev => new Set([...prev, parentId]));
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
      const updated = await updateTopologyFolder(renamingFolderId, { name: renameFolderValue.trim() });
      setFolders(prev => prev.map(f => f.id === updated.id ? updated : f));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to rename folder'));
    }
    setRenamingFolderId(null);
  };

  const handleDeleteFolder = async (folderId: string) => {
    const folder = folders.find(f => f.id === folderId);
    setFolderContextMenu(null);
    const ok = await confirmDialog({
      title: 'Delete folder?',
      body: folder
        ? <>Delete topology folder <strong>{folder.name}</strong>? Topologies inside will be moved out of the folder.</>
        : 'Delete this folder? Topologies inside will be moved out.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteTopologyFolder(folderId);
      setFolders(prev => prev.filter(f => f.id !== folderId));
      // Topologies in the folder will have folder_id set to null by the backend
      await fetchData();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete folder'));
    }
  };

  // ── Drag and Drop ──

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
  }, [childFoldersByParent]);

  // Pointer-based drag start (Tauri compatible)
  const handlePointerDown = useCallback((e: React.PointerEvent, item: DragItem) => {
    if (e.button !== 0) return;
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
    if (!listRef.current || !draggedItem) return null;

    const folderHeaders = listRef.current.querySelectorAll('[data-folder-id]');
    const topologyItems = listRef.current.querySelectorAll('[data-topology-id]');

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

    // Check topologies
    for (const el of topologyItems) {
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        const topologyId = el.getAttribute('data-topology-id')!;

        // Can't drop on itself
        if (draggedItem.type === 'topology' && draggedItem.id === topologyId) return null;

        const midY = rect.top + rect.height / 2;
        const position = clientY < midY ? 'before' : 'after';

        return { id: topologyId, position, type: 'topology' };
      }
    }

    // Check if over root area
    const listRect = listRef.current.getBoundingClientRect();
    if (clientX >= listRect.left && clientX <= listRect.right && clientY >= listRect.top && clientY <= listRect.bottom) {
      return { id: 'root', position: 'inside', type: 'root' };
    }

    return null;
  }, [draggedItem, getDescendantFolderIds]);

  // Handle pointer move during drag
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggedItem || !dragStartPos) return;

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
      const maxOrder = Math.max(...siblings.map(s => s.sort_order));
      return maxOrder + 1000;
    }

    const actualIndex = position === 'after' ? targetIndex + 1 : targetIndex;

    if (actualIndex === 0) {
      return siblings[0].sort_order / 2;
    } else if (actualIndex >= siblings.length) {
      return siblings[siblings.length - 1].sort_order + 1000;
    } else {
      const before = siblings[actualIndex - 1].sort_order;
      const after = siblings[actualIndex].sort_order;
      return (before + after) / 2;
    }
  }, []);

  // Execute the actual drop operation
  const executeDrop = useCallback(async () => {
    if (!draggedItem || !dropTarget) return;

    try {
      if (draggedItem.type === 'topology') {
        // Check if dragged topology is part of multi-selection
        const toposToMove = selectedItemIds.has(draggedItem.id) && selectedItemIds.size > 1
          ? Array.from(selectedItemIds)
          : [draggedItem.id];

        let newFolderId: string | null = null;
        let baseSortOrder: number;

        if (dropTarget.type === 'folder') {
          if (dropTarget.position === 'inside') {
            newFolderId = dropTarget.id;
            const folderTopos = topologies
              .filter(t => t.folder_id === dropTarget.id)
              .sort((a, b) => a.sort_order - b.sort_order);
            baseSortOrder = calculateNewSortOrder(folderTopos, 0, 'inside');
          } else {
            const targetFolder = folders.find(f => f.id === dropTarget.id);
            newFolderId = targetFolder?.parent_id || null;
            const siblingFolders = folders
              .filter(f => f.parent_id === newFolderId)
              .sort((a, b) => a.sort_order - b.sort_order);
            const targetIndex = siblingFolders.findIndex(f => f.id === dropTarget.id);
            baseSortOrder = calculateNewSortOrder(siblingFolders, targetIndex, dropTarget.position);
          }
        } else if (dropTarget.type === 'topology') {
          const targetTopo = topologies.find(t => t.id === dropTarget.id);
          newFolderId = targetTopo?.folder_id || null;
          const siblingsTopos = topologies
            .filter(t => t.folder_id === newFolderId)
            .sort((a, b) => a.sort_order - b.sort_order);
          const targetIndex = siblingsTopos.findIndex(t => t.id === dropTarget.id);
          baseSortOrder = calculateNewSortOrder(siblingsTopos, targetIndex, dropTarget.position);
        } else {
          newFolderId = null;
          const rootTopos = topologies
            .filter(t => t.folder_id === null)
            .sort((a, b) => a.sort_order - b.sort_order);
          baseSortOrder = calculateNewSortOrder(rootTopos, 0, 'inside');
        }

        // Move all selected topologies
        for (let i = 0; i < toposToMove.length; i++) {
          const topoId = toposToMove[i];
          const newSortOrder = baseSortOrder + (i * 10);

          setTopologies(prev => prev.map(t =>
            t.id === topoId
              ? { ...t, folder_id: newFolderId, sort_order: newSortOrder }
              : t
          ));
          await moveTopology(topoId, { folder_id: newFolderId, sort_order: newSortOrder });
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
          const rootFoldersFiltered = folders
            .filter(f => f.parent_id === null && !foldersToMove.includes(f.id))
            .sort((a, b) => a.sort_order - b.sort_order);
          baseSortOrder = calculateNewSortOrder(rootFoldersFiltered, 0, 'inside');
        }

        // Filter out any folders that would create circular references
        const validFoldersToMove = foldersToMove.filter(folderId => {
          if (folderId === newParentId) return false;
          if (newParentId && getDescendantFolderIds(folderId).has(newParentId)) return false;
          return true;
        });

        // Move all valid selected folders
        for (let i = 0; i < validFoldersToMove.length; i++) {
          const folderId = validFoldersToMove[i];
          const newSortOrder = baseSortOrder + (i * 10);

          setFolders(prev => prev.map(f =>
            f.id === folderId
              ? { ...f, parent_id: newParentId, sort_order: newSortOrder }
              : f
          ));
          await moveTopologyFolder(folderId, { parent_id: newParentId, sort_order: newSortOrder });
        }
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to move item'));
      await fetchData();
    }
  }, [draggedItem, dropTarget, topologies, folders, selectedItemIds, selectedFolderIds, calculateNewSortOrder, getDescendantFolderIds, fetchData]);

  // Handle pointer up - execute drop
  const handlePointerUp = useCallback(async () => {
    if (!isDragging) {
      setDragStartPos(null);
      setDraggedItem(null);
      return;
    }

    if (dropTarget) {
      await executeDrop();
    }

    handleDragEnd();
  }, [isDragging, dropTarget, handleDragEnd, executeDrop]);

  // ── Render Helpers ──

  const renderTopologyItem = (topo: SavedTopologyListItem, depth: number) => {
    const selected = isItemSelected(topo.id);
    const isBeingDragged = draggedItem?.type === 'topology' && draggedItem.id === topo.id;
    const isDropTargetBefore = dropTarget?.type === 'topology' && dropTarget.id === topo.id && dropTarget.position === 'before';
    const isDropTargetAfter = dropTarget?.type === 'topology' && dropTarget.id === topo.id && dropTarget.position === 'after';
    const isRenaming = renamingTopologyId === topo.id;
    const isActive = currentTopology?.id === topo.id;

    return (
      <div
        data-topology-id={topo.id}
        className={`topology-item ${selected ? 'topology-item-selected' : ''} ${isActive ? 'active' : ''} ${isBeingDragged ? 'topology-dragging' : ''} ${isDropTargetBefore ? 'topology-drag-over-top' : ''} ${isDropTargetAfter ? 'topology-drag-over-bottom' : ''}`}
        onPointerDown={(e) => !isRenaming && handlePointerDown(e, { id: topo.id, type: 'topology' })}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClick={(e) => {
          if (isRenaming) return;
          handleTopologyClick(e, topo.id);
        }}
        onDoubleClick={() => onOpenTopology?.(topo.id, topo.name)}
        onContextMenu={e => handleTopologyContextMenu(e, topo.id)}
        style={{ touchAction: 'none', paddingLeft: depth > 0 ? `${depth * 16 + 8}px` : undefined }}
      >
        <span className="topology-icon">&#128208;</span>
        {isRenaming ? (
          <input
            ref={renameTopologyInputRef}
            className="rename-input"
            value={renameTopologyValue}
            onChange={e => setRenameTopologyValue(e.target.value)}
            onBlur={() => submitRenameTopology(topo.id)}
            onKeyDown={e => {
              if (e.key === 'Enter') submitRenameTopology(topo.id);
              if (e.key === 'Escape') setRenamingTopologyId(null);
            }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <>
            <span className="topology-name">{topo.name}</span>
            {isEnterprise && topo.shared && (
              <span className="topology-shared-badge" title="Published to team">shared</span>
            )}
          </>
        )}
      </div>
    );
  };

  const renderFolderItem = (folder: Folder, depth: number) => {
    const isExpanded = expandedFolders.has(folder.id) || !!searchLower;
    const folderTopos = topologiesByFolder.get(folder.id) || [];
    const childFolders = childFoldersByParent.get(folder.id) || [];
    const isRenaming = renamingFolderId === folder.id;

    const matchingCount = searchLower
      ? (folderMatchCounts.get(folder.id) || 0)
      : folderTopos.length + childFolders.length;

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
        className={`topology-folder-header ${folderSelected ? 'topology-folder-selected' : ''} ${isBeingDragged ? 'topology-dragging' : ''} ${isDropTargetBefore ? 'topology-drag-over-top' : ''} ${isDropTargetAfter ? 'topology-drag-over-bottom' : ''} ${isDropTargetInside ? 'topology-drag-over-inside' : ''} ${isInvalidDropTarget && draggedItem ? 'drop-invalid' : ''}`}
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
          className="topology-folder-chevron"
          onClick={(e) => {
            e.stopPropagation();
            toggleFolder(folder.id);
          }}
        >
          {isExpanded ? Icons.chevronDown : Icons.chevronRight}
        </span>
        <span
          className="topology-folder-icon"
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
            className="topology-folder-rename-input"
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
          <span className="topology-folder-name">{folder.name}</span>
        )}
        <span className="topology-folder-count">{matchingCount}</span>
      </div>
    );
  };

  // ── Render ──

  return (
    <div className="topology-panel" data-testid="topology-panel">
      {/* Toolbar */}
      <div className="topology-panel-toolbar">
        <button
          className="topology-panel-btn icon-only primary"
          onClick={() => setNewDialogOpen(true)}
          title="New Topology"
        >
          {Icons.plus}
        </button>
        <button
          className="topology-panel-btn icon-only"
          onClick={() => {
            // File picker → JSON read → importTopologyFromJson. Counterpart
            // to the JSON export in TopologyTabEditor — useful for moving
            // a topology between installs, sharing via git, or restoring
            // from a backup.
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.onchange = async (e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (!file) return;
              try {
                const text = await file.text();
                const created = await importTopologyFromJson(text);
                await fetchData();
                showToast(
                  `Imported "${created.name}" (${created.devices.length} devices, ${created.connections.length} connections)`,
                  'success',
                );
              } catch (err) {
                showToast(
                  getErrorMessage(err, 'Failed to import topology'),
                  'error',
                );
              }
            };
            input.click();
          }}
          title="Import topology JSON"
        >
          {Icons.import}
        </button>
        <button
          className="topology-panel-btn icon-only"
          onClick={() => setTracerouteDialogOpen(true)}
          title="Paste Traceroute / MTR"
        >
          {Icons.route}
        </button>
        <button
          className="topology-panel-btn icon-only"
          onClick={handleNewFolder}
          title="New Folder"
        >
          {Icons.folderPlus}
        </button>
        <button
          className="topology-panel-btn icon-only"
          onClick={fetchData}
          title="Refresh"
          disabled={loading}
        >
          {Icons.refresh}
        </button>
        <button
          className={`topology-panel-btn icon-only ${sortOrder === 'reverse' ? 'active' : ''}`}
          onClick={toggleSortOrder}
          title={sortOrder === 'default' ? 'Sort: Folders first (click to show topologies first)' : 'Sort: Topologies first (click to show folders first)'}
        >
          {sortOrder === 'default' ? Icons.sortAsc : Icons.sortDesc}
        </button>
      </div>

      {/* Search */}
      <div className="topology-panel-search">
        <span className="topology-search-icon">{Icons.search}</span>
        <input
          type="text"
          className="topology-search-input"
          placeholder="Search topologies..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button
            className="topology-search-clear"
            onClick={() => setSearchQuery('')}
            title="Clear search"
          >
            {Icons.x}
          </button>
        )}
      </div>

      {/* Loading / Error States */}
      {loading && (
        <div className="topology-panel-status">Loading...</div>
      )}

      {error && (
        <div className="topology-panel-error">
          {error}
          <button onClick={fetchData}>Retry</button>
        </div>
      )}

      {/* Topology List (Virtualized) */}
      {!loading && !error && (
        <div
          ref={listRef}
          className={`topology-list-container ${dropTarget?.type === 'root' ? 'topology-drag-over-inside' : ''}`}
        >
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
                      : renderTopologyItem(item.topology, item.depth)
                    }
                  </div>
                );
              })}
            </div>
          )}

          {/* Search results info */}
          {searchLower && filteredTopologies.length > 0 && (
            <div className="topology-search-results">
              {filteredTopologies.length} topology{filteredTopologies.length !== 1 ? 'ies' : ''} found
            </div>
          )}

          {/* No search results */}
          {searchLower && filteredTopologies.length === 0 && (
            <div className="topology-panel-empty">
              No topologies match "{searchQuery}"
            </div>
          )}

          {/* Empty state */}
          {!searchLower && topologies.length === 0 && folders.length === 0 && (
            <div className="topology-panel-empty">
              No saved topologies.
              <br />
              Click + to create one.
            </div>
          )}
        </div>
      )}

      {/* Team Topologies (enterprise mode) */}
      {isEnterprise && filteredTeamTopologies.length > 0 && (
        <div className="panel-section">
          <div className="section-header">
            <span>TEAM TOPOLOGIES</span>
          </div>
          <div className="topology-list">
            {filteredTeamTopologies.map(topo => (
              <div
                key={topo.id}
                className={`topology-item team ${currentTopology?.id === topo.id ? 'active' : ''}`}
                onClick={() => onOpenTopology?.(topo.id, topo.name)}
              >
                <span className="topology-icon">&#128208;</span>
                <span className="topology-name">{topo.name}</span>
                <span className="topology-shared-badge">team</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Devices Section (when topology tab is active) */}
      {currentTopology && (
        <div className="panel-section">
          <div className="section-header">
            <span>DEVICES ({currentTopology.name})</span>
          </div>
          <div className="device-list">
            {currentTopology.devices.map(device => (
              <div
                key={device.id}
                className={`device-item ${selectedDeviceId === device.id ? 'selected' : ''}`}
                onClick={() => onDeviceSelect?.(device)}
                onDoubleClick={() => onDeviceConnect?.(device)}
              >
                <span
                  className="status-indicator"
                  style={{ backgroundColor: STATUS_COLORS[device.status] }}
                />
                <span className="device-name">{formatName(device.name)}</span>
                <span className="device-status">
                  {device.sessionId ? '(connected)' : '(no session)'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Topology Context Menu */}
      {topologyContextMenu && (() => {
        const topo = topologies.find(t => t.id === topologyContextMenu.topologyId);
        if (!topo) return null;
        return (
          <div
            ref={topologyMenuRef}
            className="topology-context-menu"
            style={topologyMenuStyle}
          >
            {/* Bulk actions when multiple topologies selected */}
            {itemSelectionCount > 1 && (
              <>
                <button
                  className="topology-context-menu-item topology-context-menu-danger"
                  onClick={handleBulkDelete}
                >
                  {Icons.trash}
                  <span>Delete Selected ({itemSelectionCount})</span>
                </button>
                <div className="topology-context-menu-divider" />
              </>
            )}
            <button
              className="topology-context-menu-item"
              onClick={() => handleRenameTopology(topo)}
            >
              {Icons.edit}
              <span>Rename</span>
            </button>
            {isEnterprise && (
              <button
                className="topology-context-menu-item"
                onClick={() => handleShareTopology(topo)}
              >
                <span>{topo.shared ? 'Unpublish' : 'Publish to Team'}</span>
              </button>
            )}
            <div className="topology-context-menu-divider" />
            <button
              className="topology-context-menu-item topology-context-menu-danger"
              onClick={() => handleDeleteTopology(topo.id)}
            >
              {Icons.trash}
              <span>Delete</span>
            </button>
          </div>
        );
      })()}

      {/* Folder Context Menu */}
      {folderContextMenu && (
        <div
          ref={folderMenuRef}
          className="topology-context-menu"
          style={folderMenuStyle}
        >
          <button
            className="topology-context-menu-item"
            onClick={() => handleNewSubfolder(folderContextMenu.folderId)}
          >
            {Icons.folderPlus}
            <span>New Subfolder</span>
          </button>
          <div className="topology-context-menu-divider" />
          <button
            className="topology-context-menu-item"
            onClick={() => handleRenameFolder(folderContextMenu.folderId)}
          >
            {Icons.edit}
            <span>Rename Folder</span>
          </button>
          <div className="topology-context-menu-divider" />
          <button
            className="topology-context-menu-item"
            onClick={() => {
              expandAllFolders();
              setFolderContextMenu(null);
            }}
          >
            {Icons.expandAll}
            <span>Expand All Folders</span>
          </button>
          <button
            className="topology-context-menu-item"
            onClick={() => {
              collapseAllFolders();
              setFolderContextMenu(null);
            }}
          >
            {Icons.collapseAll}
            <span>Collapse All Folders</span>
          </button>
          <div className="topology-context-menu-divider" />
          <button
            className="topology-context-menu-item topology-context-menu-danger"
            onClick={() => handleDeleteFolder(folderContextMenu.folderId)}
          >
            {Icons.trash}
            <span>Delete Folder</span>
          </button>
        </div>
      )}

      {/* New Topology Dialog -- picks sessions then opens discovery */}
      <NewTopologyDialog
        isOpen={newDialogOpen}
        onClose={() => setNewDialogOpen(false)}
        onStartDiscovery={(name, sessions) => {
          setNewDialogOpen(false);
          onStartDiscovery?.(name, sessions);
        }}
        connectedSessionIds={connectedSessionIds}
      />

      {/* Traceroute Dialog */}
      <TracerouteDialog
        isOpen={tracerouteDialogOpen}
        onClose={() => setTracerouteDialogOpen(false)}
        onVisualize={(newTopology) => {
          onOpenTracerouteTopology?.(newTopology);
          setTracerouteDialogOpen(false);
        }}
      />

      {/* Drag Preview */}
      {isDragging && draggedItem && (
        <div
          ref={dragPreviewRef}
          className="topology-drag-preview"
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
            <div className="drag-preview-topology">
              <span>&#128208; {topologies.find(t => t.id === draggedItem.id)?.name || 'Topology'}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Wrapper component that provides the ItemSelectionProvider context
export default function TopologyPanel(props: TopologyPanelProps) {
  return (
    <ItemSelectionProvider>
      <TopologyPanelContent {...props} />
    </ItemSelectionProvider>
  );
}
