import { useState, useCallback, createContext, useContext, type ReactNode, useMemo } from 'react';

interface ItemSelectionContextValue {
  selectedItemIds: Set<string>;
  toggleItemSelection: (itemId: string, isCtrlCmd: boolean) => void;
  rangeItemSelect: (itemId: string, allItemIds: string[]) => void;
  selectAllItems: (itemIds: string[]) => void;
  clearItemSelection: () => void;
  isItemSelected: (itemId: string) => boolean;
  itemSelectionCount: number;

  selectedFolderIds: Set<string>;
  toggleFolderSelection: (folderId: string, isCtrlCmd: boolean) => void;
  rangeFolderSelect: (folderId: string, allFolderIds: string[]) => void;
  isFolderSelected: (folderId: string) => boolean;
  folderSelectionCount: number;

  totalSelectionCount: number;
  clearAllSelections: () => void;
  hasAnySelection: boolean;
}

const ItemSelectionContext = createContext<ItemSelectionContextValue | null>(null);

export function ItemSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const [lastClickedItemId, setLastClickedItemId] = useState<string | null>(null);
  const [lastClickedFolderId, setLastClickedFolderId] = useState<string | null>(null);

  const toggleItemSelection = useCallback((itemId: string, isCtrlCmd: boolean) => {
    setSelectedItemIds(prev => {
      const next = new Set(prev);
      if (isCtrlCmd) {
        if (next.has(itemId)) {
          next.delete(itemId);
        } else {
          next.add(itemId);
        }
      } else {
        setSelectedFolderIds(new Set());
        next.clear();
        next.add(itemId);
      }
      return next;
    });
    setLastClickedItemId(itemId);
  }, []);

  const toggleFolderSelection = useCallback((folderId: string, isCtrlCmd: boolean) => {
    setSelectedFolderIds(prev => {
      const next = new Set(prev);
      if (isCtrlCmd) {
        if (next.has(folderId)) {
          next.delete(folderId);
        } else {
          next.add(folderId);
        }
      } else {
        setSelectedItemIds(new Set());
        next.clear();
        next.add(folderId);
      }
      return next;
    });
    setLastClickedFolderId(folderId);
  }, []);

  const rangeItemSelect = useCallback((itemId: string, allItemIds: string[]) => {
    if (!lastClickedItemId) {
      setSelectedItemIds(new Set([itemId]));
      setLastClickedItemId(itemId);
      return;
    }
    const lastIndex = allItemIds.indexOf(lastClickedItemId);
    const currentIndex = allItemIds.indexOf(itemId);
    if (lastIndex === -1 || currentIndex === -1) {
      setSelectedItemIds(new Set([itemId]));
      setLastClickedItemId(itemId);
      return;
    }
    const startIndex = Math.min(lastIndex, currentIndex);
    const endIndex = Math.max(lastIndex, currentIndex);
    const rangeIds = allItemIds.slice(startIndex, endIndex + 1);
    setSelectedItemIds(prev => {
      const next = new Set(prev);
      rangeIds.forEach(id => next.add(id));
      return next;
    });
  }, [lastClickedItemId]);

  const rangeFolderSelect = useCallback((folderId: string, allFolderIds: string[]) => {
    if (!lastClickedFolderId) {
      setSelectedFolderIds(new Set([folderId]));
      setLastClickedFolderId(folderId);
      return;
    }
    const lastIndex = allFolderIds.indexOf(lastClickedFolderId);
    const currentIndex = allFolderIds.indexOf(folderId);
    if (lastIndex === -1 || currentIndex === -1) {
      setSelectedFolderIds(new Set([folderId]));
      setLastClickedFolderId(folderId);
      return;
    }
    const startIndex = Math.min(lastIndex, currentIndex);
    const endIndex = Math.max(lastIndex, currentIndex);
    const rangeIds = allFolderIds.slice(startIndex, endIndex + 1);
    setSelectedFolderIds(prev => {
      const next = new Set(prev);
      rangeIds.forEach(id => next.add(id));
      return next;
    });
  }, [lastClickedFolderId]);

  const selectAllItems = useCallback((itemIds: string[]) => {
    setSelectedItemIds(new Set(itemIds));
    if (itemIds.length > 0) {
      setLastClickedItemId(itemIds[itemIds.length - 1]);
    }
  }, []);

  const clearItemSelection = useCallback(() => {
    setSelectedItemIds(new Set());
    setLastClickedItemId(null);
  }, []);

  const clearAllSelections = useCallback(() => {
    setSelectedItemIds(new Set());
    setSelectedFolderIds(new Set());
    setLastClickedItemId(null);
    setLastClickedFolderId(null);
  }, []);

  const isItemSelected = useCallback((itemId: string) => {
    return selectedItemIds.has(itemId);
  }, [selectedItemIds]);

  const isFolderSelected = useCallback((folderId: string) => {
    return selectedFolderIds.has(folderId);
  }, [selectedFolderIds]);

  const itemSelectionCount = useMemo(() => selectedItemIds.size, [selectedItemIds]);
  const folderSelectionCount = useMemo(() => selectedFolderIds.size, [selectedFolderIds]);
  const totalSelectionCount = useMemo(() => selectedItemIds.size + selectedFolderIds.size, [selectedItemIds, selectedFolderIds]);
  const hasAnySelection = useMemo(() => selectedItemIds.size > 0 || selectedFolderIds.size > 0, [selectedItemIds, selectedFolderIds]);

  const value = useMemo<ItemSelectionContextValue>(() => ({
    selectedItemIds,
    toggleItemSelection,
    rangeItemSelect,
    selectAllItems,
    clearItemSelection,
    isItemSelected,
    itemSelectionCount,
    selectedFolderIds,
    toggleFolderSelection,
    rangeFolderSelect,
    isFolderSelected,
    folderSelectionCount,
    totalSelectionCount,
    clearAllSelections,
    hasAnySelection,
  }), [
    selectedItemIds,
    toggleItemSelection,
    rangeItemSelect,
    selectAllItems,
    clearItemSelection,
    isItemSelected,
    itemSelectionCount,
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
    <ItemSelectionContext.Provider value={value}>
      {children}
    </ItemSelectionContext.Provider>
  );
}

export function useItemSelection() {
  const context = useContext(ItemSelectionContext);
  if (!context) {
    throw new Error('useItemSelection must be used within an ItemSelectionProvider');
  }
  return context;
}
