import { useState, useCallback, createContext, useContext, type ReactNode, useMemo } from 'react';

/**
 * Hook for managing tab multi-selection state.
 * Supports Cmd/Ctrl+Click toggle and Shift+Click range selection.
 * Selection is session-transient (not persisted).
 */

interface TabSelectionContextValue {
  selectedTabIds: Set<string>;
  toggleSelection: (tabId: string, isCtrlCmd: boolean) => void;
  rangeSelect: (tabId: string, allTabIds: string[]) => void;
  selectAll: (tabIds: string[]) => void;
  clearSelection: () => void;
  isSelected: (tabId: string) => boolean;
  selectionCount: number;
}

const TabSelectionContext = createContext<TabSelectionContextValue | null>(null);

export function TabSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(new Set());
  // Track last-clicked tab for Shift+Click range selection
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);

  // Toggle selection for Cmd/Ctrl+Click
  const toggleSelection = useCallback((tabId: string, isCtrlCmd: boolean) => {
    setSelectedTabIds(prev => {
      const next = new Set(prev);
      if (isCtrlCmd) {
        // Cmd/Ctrl+Click: toggle this tab without affecting others
        if (next.has(tabId)) {
          next.delete(tabId);
        } else {
          next.add(tabId);
        }
      } else {
        // Plain click: clear selection (active tab handled separately in App.tsx)
        next.clear();
      }
      return next;
    });
    setLastClickedId(tabId);
  }, []);

  // Range select for Shift+Click
  const rangeSelect = useCallback((tabId: string, allTabIds: string[]) => {
    if (!lastClickedId) {
      // No previous click, just select this tab
      setSelectedTabIds(new Set([tabId]));
      setLastClickedId(tabId);
      return;
    }

    const lastIndex = allTabIds.indexOf(lastClickedId);
    const currentIndex = allTabIds.indexOf(tabId);

    if (lastIndex === -1 || currentIndex === -1) {
      // One of the tabs not found in list, just select this tab
      setSelectedTabIds(new Set([tabId]));
      setLastClickedId(tabId);
      return;
    }

    // Select all tabs between lastClicked and current (inclusive)
    const startIndex = Math.min(lastIndex, currentIndex);
    const endIndex = Math.max(lastIndex, currentIndex);
    const rangeIds = allTabIds.slice(startIndex, endIndex + 1);

    setSelectedTabIds(prev => {
      const next = new Set(prev);
      rangeIds.forEach(id => next.add(id));
      return next;
    });
    // Don't update lastClickedId on range select to allow extending selection
  }, [lastClickedId]);

  // Select all provided tabs
  const selectAll = useCallback((tabIds: string[]) => {
    setSelectedTabIds(new Set(tabIds));
    if (tabIds.length > 0) {
      setLastClickedId(tabIds[tabIds.length - 1]);
    }
  }, []);

  // Clear all selections
  const clearSelection = useCallback(() => {
    setSelectedTabIds(new Set());
    setLastClickedId(null);
  }, []);

  // Check if a tab is selected
  const isSelected = useCallback((tabId: string) => {
    return selectedTabIds.has(tabId);
  }, [selectedTabIds]);

  // Selection count
  const selectionCount = useMemo(() => selectedTabIds.size, [selectedTabIds]);

  const value = useMemo<TabSelectionContextValue>(() => ({
    selectedTabIds,
    toggleSelection,
    rangeSelect,
    selectAll,
    clearSelection,
    isSelected,
    selectionCount,
  }), [selectedTabIds, toggleSelection, rangeSelect, selectAll, clearSelection, isSelected, selectionCount]);

  return (
    <TabSelectionContext.Provider value={value}>
      {children}
    </TabSelectionContext.Provider>
  );
}

export function useTabSelection() {
  const context = useContext(TabSelectionContext);
  if (!context) {
    throw new Error('useTabSelection must be used within a TabSelectionProvider');
  }
  return context;
}
