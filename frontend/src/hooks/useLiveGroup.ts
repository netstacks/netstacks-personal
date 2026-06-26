// terminal/frontend/src/hooks/useLiveGroup.ts
//
// Tracks which saved Group is currently "live" — i.e., was launched in the
// current window and still has at least one of its tabs open. Live state is
// set explicitly by handleLaunchGroup in App.tsx, not derived by content matching.

import { useEffect } from 'react';
import type { Group } from '../api/groups';

export interface OpenTabRef {
  id: string;
  type: string;
  sessionId?: string;
  topologyId?: string;
  documentId?: string;
}

/**
 * If the live group's tabs are all gone from the open-tabs list, clears the live ID.
 * Pass `clearLiveGroupId` from App.tsx state.
 */
export function useLiveGroupAutoClear(
  liveGroupId: string | null,
  groups: Group[],
  openTabs: OpenTabRef[],
  clearLiveGroupId: () => void
) {
  useEffect(() => {
    if (!liveGroupId) return;
    const live = groups.find((g) => g.id === liveGroupId);
    if (!live) {
      clearLiveGroupId();
      return;
    }
    // A group tab "matches" an open tab if any of its identifying fields match.
    const stillAlive = live.tabs.some((gt) =>
      openTabs.some((ot) => {
        if (gt.type === 'terminal' && gt.sessionId) return ot.sessionId === gt.sessionId;
        if (gt.type === 'topology' && gt.topologyId) return ot.topologyId === gt.topologyId;
        if (gt.type === 'document' && gt.documentId) return ot.documentId === gt.documentId;
        return false;
      })
    );
    if (!stillAlive) {
      clearLiveGroupId();
    }
  }, [liveGroupId, groups, openTabs, clearLiveGroupId]);
}
