// terminal/frontend/src/components/GroupsPanel.tsx
//
// Plan 1: unified Groups list driven by /groups. No more Active vs Saved split —
// everything is persistent. Live indicator = the group currently launched in
// this window. Drop tabs onto a row to add. "+ Save current" creates a new group
// from the open tabs.

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  listGroups,
  deleteGroup,
  updateGroup,
  type Group,
} from '../api/groups';
import ContextMenu from './ContextMenu';
import { useContextMenu } from '../hooks/useContextMenu';
import './GroupsPanel.css';

export interface GroupsPanelProps {
  liveGroupId: string | null;
  /** Triggered when user clicks a group row → App.tsx opens the LaunchDialog. */
  onLaunchGroup: (group: Group) => void;
  /** Triggered when user clicks "+ Save current" → App.tsx prompts for a name and POSTs. */
  onSaveCurrentAsGroup: () => void;
  /** Triggered when user accepts a tab drop → App.tsx adds the tab to the group via updateGroup. */
  onTabDroppedOnGroup: (groupId: string, droppedTabId: string) => void;
  /** Triggered when user clicks the inline "Discover topology" pill. */
  onDiscoverTopology: (group: Group) => void;
  /** Triggered when user clicks the topology badge — open the topology tab. */
  onOpenTopology: (topologyId: string) => void;
  /** Returns a display title for an open tab id (for chip labels). */
  getTabTitle: (tabIdOrSessionId: string) => string;
  /**
   * Bumped by App.tsx whenever a group should be re-fetched (e.g., after save / launch).
   * The panel internally fetches on mount and whenever this changes.
   */
  refreshKey: number;
}

export default function GroupsPanel(props: GroupsPanelProps) {
  const {
    liveGroupId,
    onLaunchGroup,
    onSaveCurrentAsGroup,
    onTabDroppedOnGroup,
    onDiscoverTopology,
    onOpenTopology,
    getTabTitle,
    refreshKey,
  } = props;

  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const contextMenu = useContextMenu();

  // Fetch on mount + whenever refreshKey changes
  useEffect(() => {
    setLoading(true);
    listGroups()
      .then(setGroups)
      .catch((err) => {
        console.error('Failed to load groups:', err);
        setGroups([]);
      })
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return groups;
    const f = filter.toLowerCase();
    return groups.filter((g) => {
      if (g.name.toLowerCase().includes(f)) return true;
      return g.tabs.some((t) => {
        const id = t.sessionId || t.topologyId || t.documentId || '';
        return getTabTitle(id).toLowerCase().includes(f);
      });
    });
  }, [groups, filter, getTabTitle]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteGroup(id);
      setGroups((prev) => prev.filter((g) => g.id !== id));
    } catch (err) {
      console.error('Failed to delete group:', err);
    }
  }, []);

  const submitRename = useCallback(
    async (group: Group) => {
      const name = renameValue.trim();
      setRenamingId(null);
      setRenameValue('');
      if (!name || name === group.name) return;
      try {
        const updated = await updateGroup(group.id, { name });
        setGroups((prev) => prev.map((g) => (g.id === group.id ? updated : g)));
      } catch (err) {
        console.error('Failed to rename group:', err);
      }
    },
    [renameValue]
  );

  const openContextMenu = useCallback(
    (e: React.MouseEvent, group: Group) => {
      contextMenu.open(e, [
        {
          id: 'rename',
          label: 'Rename',
          action: () => {
            setRenamingId(group.id);
            setRenameValue(group.name);
          },
        },
        { id: 'discover', label: 'Run topology discovery', action: () => onDiscoverTopology(group) },
        { id: 'div-1', label: '', divider: true, action: () => {} },
        { id: 'delete', label: 'Delete group', action: () => handleDelete(group.id) },
      ]);
    },
    [contextMenu, onDiscoverTopology, handleDelete]
  );

  const onDragOver = (e: React.DragEvent, groupId: string) => {
    if (e.dataTransfer.types.includes('application/x-tab-id')) {
      e.preventDefault();
      setDropTargetId(groupId);
    }
  };

  const onDragLeave = (groupId: string) => {
    if (dropTargetId === groupId) setDropTargetId(null);
  };

  const onDrop = (e: React.DragEvent, group: Group) => {
    e.preventDefault();
    setDropTargetId(null);
    const tabId = e.dataTransfer.getData('application/x-tab-id');
    if (!tabId) return;
    onTabDroppedOnGroup(group.id, tabId);
  };

  return (
    <div className="groups-panel" data-testid="groups-panel">
      <div className="groups-toolbar">
        <input
          className="groups-search"
          type="text"
          placeholder="Search groups..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="groups-save-current"
          onClick={onSaveCurrentAsGroup}
          title="Save all currently open tabs as a new group (⌘⇧G)"
        >
          ＋ Save current
        </button>
      </div>

      {loading ? (
        <div className="groups-empty">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="groups-empty">
          {filter ? 'No groups match.' : 'No saved groups yet. Click "+ Save current" to create one.'}
        </div>
      ) : (
        <div className="groups-list">
          {filtered.map((group) => {
            const isLive = group.id === liveGroupId;
            const isDropTarget = group.id === dropTargetId;
            return (
              <div
                key={group.id}
                data-group-id={group.id}
                className={`groups-row ${isLive ? 'live' : ''} ${isDropTarget ? 'drop-target' : ''}`}
                onClick={() => onLaunchGroup(group)}
                onContextMenu={(e) => openContextMenu(e, group)}
                onDragOver={(e) => onDragOver(e, group.id)}
                onDragLeave={() => onDragLeave(group.id)}
                onDrop={(e) => onDrop(e, group)}
              >
                <div className="groups-row-h">
                  {isLive && <span className="groups-live-dot" title="Currently live in this window" />}
                  {renamingId === group.id ? (
                    <input
                      className="groups-rename-input"
                      type="text"
                      value={renameValue}
                      autoFocus
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => submitRename(group)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitRename(group);
                        if (e.key === 'Escape') {
                          setRenamingId(null);
                          setRenameValue('');
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="groups-name">{group.name}</span>
                  )}
                  <button
                    className="groups-overflow"
                    onClick={(e) => {
                      e.stopPropagation();
                      openContextMenu(e, group);
                    }}
                  >
                    ⋯
                  </button>
                </div>

                <div className="groups-row-meta">
                  <span>
                    {isLive ? 'Live · ' : 'Saved · '}
                    {group.tabs.length} {group.tabs.length === 1 ? 'tab' : 'tabs'}
                  </span>
                  {group.topologyId ? (
                    <button
                      className="groups-topo-badge"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenTopology(group.topologyId!);
                      }}
                      title="Open topology"
                    >
                      ◈ topology
                    </button>
                  ) : (
                    <button
                      className="groups-topo-pill"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDiscoverTopology(group);
                      }}
                      title="Discover topology from this group's tabs"
                    >
                      ◈ Discover topology
                    </button>
                  )}
                </div>

                <div className="groups-row-details">
                  <div className="groups-row-details-inner">
                    <div className="groups-row-chips">
                      {group.tabs.map((t, i) => {
                        const id = t.sessionId || t.topologyId || t.documentId || '';
                        const title = getTabTitle(id) || t.documentName || id || t.type;
                        return (
                          <span key={i} className={`groups-chip groups-chip-${t.type}`}>
                            {title}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ContextMenu position={contextMenu.position} items={contextMenu.items} onClose={contextMenu.close} />
    </div>
  );
}
