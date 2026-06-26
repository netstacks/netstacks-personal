import { useState, useCallback, createContext, useContext, type ReactNode, useMemo } from 'react';

/**
 * Hook for managing session and folder multi-selection state.
 * Supports Cmd/Ctrl+Click toggle and Shift+Click range selection.
 * Selection is session-transient (not persisted to localStorage).
 */

interface SessionSelectionContextValue {
  // Session selection (backward compatible)
  selectedSessionIds: Set<string>;
  toggleSelection: (sessionId: string, isCtrlCmd: boolean) => void;
  rangeSelect: (sessionId: string, allSessionIds: string[]) => void;
  selectAll: (sessionIds: string[]) => void;
  clearSelection: () => void;
  isSelected: (sessionId: string) => boolean;
  selectionCount: number;

  // Folder selection
  selectedFolderIds: Set<string>;
  toggleFolderSelection: (folderId: string, isCtrlCmd: boolean) => void;
  rangeFolderSelect: (folderId: string, allFolderIds: string[]) => void;
  isFolderSelected: (folderId: string) => boolean;
  folderSelectionCount: number;

  // Combined
  totalSelectionCount: number;
  clearAllSelections: () => void;
  hasAnySelection: boolean;
}

const SessionSelectionContext = createContext<SessionSelectionContextValue | null>(null);

export function SessionSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  // Track last-clicked items for Shift+Click range selection
  const [lastClickedSessionId, setLastClickedSessionId] = useState<string | null>(null);
  const [lastClickedFolderId, setLastClickedFolderId] = useState<string | null>(null);

  // Toggle selection for Cmd/Ctrl+Click (sessions)
  const toggleSelection = useCallback((sessionId: string, isCtrlCmd: boolean) => {
    setSelectedSessionIds(prev => {
      const next = new Set(prev);
      if (isCtrlCmd) {
        // Cmd/Ctrl+Click: toggle this session without affecting others
        if (next.has(sessionId)) {
          next.delete(sessionId);
        } else {
          next.add(sessionId);
        }
      } else {
        // Plain click: clear all selections, select only this session
        setSelectedFolderIds(new Set()); // Clear folder selections too
        next.clear();
        next.add(sessionId);
      }
      return next;
    });
    setLastClickedSessionId(sessionId);
  }, []);

  // Toggle selection for Cmd/Ctrl+Click (folders)
  const toggleFolderSelection = useCallback((folderId: string, isCtrlCmd: boolean) => {
    setSelectedFolderIds(prev => {
      const next = new Set(prev);
      if (isCtrlCmd) {
        // Cmd/Ctrl+Click: toggle this folder without affecting others
        if (next.has(folderId)) {
          next.delete(folderId);
        } else {
          next.add(folderId);
        }
      } else {
        // Plain click: clear all selections, select only this folder
        setSelectedSessionIds(new Set()); // Clear session selections too
        next.clear();
        next.add(folderId);
      }
      return next;
    });
    setLastClickedFolderId(folderId);
  }, []);

  // Range select for Shift+Click (sessions)
  const rangeSelect = useCallback((sessionId: string, allSessionIds: string[]) => {
    if (!lastClickedSessionId) {
      // No previous click, just select this session
      setSelectedSessionIds(new Set([sessionId]));
      setLastClickedSessionId(sessionId);
      return;
    }

    const lastIndex = allSessionIds.indexOf(lastClickedSessionId);
    const currentIndex = allSessionIds.indexOf(sessionId);

    if (lastIndex === -1 || currentIndex === -1) {
      // One of the sessions not found in list, just select this session
      setSelectedSessionIds(new Set([sessionId]));
      setLastClickedSessionId(sessionId);
      return;
    }

    // Select all sessions between lastClicked and current (inclusive)
    const startIndex = Math.min(lastIndex, currentIndex);
    const endIndex = Math.max(lastIndex, currentIndex);
    const rangeIds = allSessionIds.slice(startIndex, endIndex + 1);

    setSelectedSessionIds(prev => {
      const next = new Set(prev);
      rangeIds.forEach(id => next.add(id));
      return next;
    });
    // Don't update lastClickedSessionId on range select to allow extending selection
  }, [lastClickedSessionId]);

  // Range select for Shift+Click (folders)
  const rangeFolderSelect = useCallback((folderId: string, allFolderIds: string[]) => {
    if (!lastClickedFolderId) {
      // No previous click, just select this folder
      setSelectedFolderIds(new Set([folderId]));
      setLastClickedFolderId(folderId);
      return;
    }

    const lastIndex = allFolderIds.indexOf(lastClickedFolderId);
    const currentIndex = allFolderIds.indexOf(folderId);

    if (lastIndex === -1 || currentIndex === -1) {
      // One of the folders not found in list, just select this folder
      setSelectedFolderIds(new Set([folderId]));
      setLastClickedFolderId(folderId);
      return;
    }

    // Select all folders between lastClicked and current (inclusive)
    const startIndex = Math.min(lastIndex, currentIndex);
    const endIndex = Math.max(lastIndex, currentIndex);
    const rangeIds = allFolderIds.slice(startIndex, endIndex + 1);

    setSelectedFolderIds(prev => {
      const next = new Set(prev);
      rangeIds.forEach(id => next.add(id));
      return next;
    });
    // Don't update lastClickedFolderId on range select to allow extending selection
  }, [lastClickedFolderId]);

  // Select all provided sessions
  const selectAll = useCallback((sessionIds: string[]) => {
    setSelectedSessionIds(new Set(sessionIds));
    if (sessionIds.length > 0) {
      setLastClickedSessionId(sessionIds[sessionIds.length - 1]);
    }
  }, []);

  // Clear session selections
  const clearSelection = useCallback(() => {
    setSelectedSessionIds(new Set());
    setLastClickedSessionId(null);
  }, []);

  // Clear all selections (sessions and folders)
  const clearAllSelections = useCallback(() => {
    setSelectedSessionIds(new Set());
    setSelectedFolderIds(new Set());
    setLastClickedSessionId(null);
    setLastClickedFolderId(null);
  }, []);

  // Check if a session is selected
  const isSelected = useCallback((sessionId: string) => {
    return selectedSessionIds.has(sessionId);
  }, [selectedSessionIds]);

  // Check if a folder is selected
  const isFolderSelected = useCallback((folderId: string) => {
    return selectedFolderIds.has(folderId);
  }, [selectedFolderIds]);

  // Selection counts
  const selectionCount = useMemo(() => selectedSessionIds.size, [selectedSessionIds]);
  const folderSelectionCount = useMemo(() => selectedFolderIds.size, [selectedFolderIds]);
  const totalSelectionCount = useMemo(() => selectedSessionIds.size + selectedFolderIds.size, [selectedSessionIds, selectedFolderIds]);
  const hasAnySelection = useMemo(() => selectedSessionIds.size > 0 || selectedFolderIds.size > 0, [selectedSessionIds, selectedFolderIds]);

  const value = useMemo<SessionSelectionContextValue>(() => ({
    selectedSessionIds,
    toggleSelection,
    rangeSelect,
    selectAll,
    clearSelection,
    isSelected,
    selectionCount,
    selectedFolderIds,
    toggleFolderSelection,
    rangeFolderSelect,
    isFolderSelected,
    folderSelectionCount,
    totalSelectionCount,
    clearAllSelections,
    hasAnySelection,
  }), [
    selectedSessionIds,
    toggleSelection,
    rangeSelect,
    selectAll,
    clearSelection,
    isSelected,
    selectionCount,
    selectedFolderIds,
    toggleFolderSelection,
    rangeFolderSelect,
    isFolderSelected,
    folderSelectionCount,
    totalSelectionCount,
    clearAllSelections,
    hasAnySelection,
  ]);

  return (
    <SessionSelectionContext.Provider value={value}>
      {children}
    </SessionSelectionContext.Provider>
  );
}

export function useSessionSelection() {
  const context = useContext(SessionSelectionContext);
  if (!context) {
    throw new Error('useSessionSelection must be used within a SessionSelectionProvider');
  }
  return context;
}
