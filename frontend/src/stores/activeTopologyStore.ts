/**
 * activeTopologyStore - shares the currently-open topology + live telemetry
 *
 * Topology state lives inside TopologyTabEditor, but the global AISidePanel needs
 * to see and act on it. This store is the bridge: TopologyTabEditor publishes the
 * active topology, live SNMP stats, and its mutation callbacks; App.tsx reads them
 * to build topologyCallbacks for the AI. When no topology tab is focused the store
 * holds nulls and the AI's topology tools are simply unavailable.
 */
import { create } from 'zustand'
import type React from 'react'
import type { Topology } from '../types/topology'
import type { DeviceStatsMap, LiveStatsMap } from '../hooks/useTopologyLive'
import type { LinkEnrichment } from '../types/enrichment'
import type { TopologyAction } from '../types/topologyHistory'

/** Matches useTopologyHistory's pushAction signature so the editor can publish
 *  its real callback with no cast. */
export type TopologyPushAction = (action: Omit<TopologyAction, 'id' | 'timestamp'>) => TopologyAction

export interface ActiveTopologyPayload {
  topology: Topology | null
  topologyId?: string
  isTemporary?: boolean
  deviceStats?: DeviceStatsMap | null
  linkEnrichment?: Map<string, LinkEnrichment> | null
  liveStats?: LiveStatsMap | null
  setTopology?: React.Dispatch<React.SetStateAction<Topology | null>>
  pushAction?: TopologyPushAction
  setHighlights?: (h: { targets: string[]; color: string; label?: string }) => void
  clearHighlights?: () => void
  showAIActionToast?: (action: TopologyAction) => void
}

interface ActiveTopologyState extends ActiveTopologyPayload {
  publish: (p: ActiveTopologyPayload) => void
  clear: () => void
}

const EMPTY: ActiveTopologyPayload = {
  topology: null,
  topologyId: undefined,
  isTemporary: false,
  deviceStats: null,
  linkEnrichment: null,
  liveStats: null,
  setTopology: undefined,
  pushAction: undefined,
  setHighlights: undefined,
  clearHighlights: undefined,
  showAIActionToast: undefined,
}

export const useActiveTopologyStore = create<ActiveTopologyState>((set) => ({
  ...EMPTY,
  publish: (p) => set({ ...EMPTY, ...p }),
  clear: () => set({ ...EMPTY }),
}))
