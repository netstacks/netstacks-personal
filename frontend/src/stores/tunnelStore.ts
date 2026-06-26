import { create } from 'zustand'
import {
  listTunnels,
  startTunnel as apiStartTunnel,
  stopTunnel as apiStopTunnel,
  reconnectTunnel as apiReconnectTunnel,
  startAllTunnels,
  getTunnelStatus,
  type TunnelWithState,
  type TunnelRuntimeState,
} from '../api/tunnels'

import { getErrorMessage } from '../api/errors'
export const SESSION_TUNNEL_PREFIX = 'session:';

interface TunnelState {
  tunnels: TunnelWithState[]
  loading: boolean
  error: string | null
  pollInterval: ReturnType<typeof setInterval> | null

  fetchTunnels: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
  startTunnel: (id: string) => Promise<void>
  stopTunnel: (id: string) => Promise<void>
  reconnectTunnel: (id: string) => Promise<void>
  autoStartAll: () => Promise<void>

  getActiveTunnelCount: () => number
  hasFailedTunnels: () => boolean
  getFailedCount: () => number
}

export const useTunnelStore = create<TunnelState>((set, get) => ({
  tunnels: [],
  loading: false,
  error: null,
  pollInterval: null,

  fetchTunnels: async () => {
    try {
      const tunnels = await listTunnels()
      set({ tunnels, error: null })
    } catch (err) {
      const message = getErrorMessage(err, 'Failed to fetch tunnels')
      set({ error: message })
    }
  },

  startPolling: () => {
    const existing = get().pollInterval
    if (existing) return

    get().fetchTunnels()

    const interval = setInterval(async () => {
      try {
        const statuses = await getTunnelStatus()
        const statusMap = new Map<string, TunnelRuntimeState>(
          statuses.map(s => [s.id, s])
        )
        set(state => {
          const existingIds = new Set(state.tunnels.map(t => t.id))
          const hasNewSessionTunnels = statuses.some(
            s => s.id.startsWith(SESSION_TUNNEL_PREFIX) && !existingIds.has(s.id)
          )
          const hasRemovedSessionTunnels = state.tunnels.some(
            t => t.id.startsWith(SESSION_TUNNEL_PREFIX) && !statusMap.has(t.id)
          )
          if (hasNewSessionTunnels || hasRemovedSessionTunnels) {
            get().fetchTunnels()
            return {}
          }
          return {
            tunnels: state.tunnels.map(t => {
              const runtime = statusMap.get(t.id)
              if (runtime) {
                return {
                  ...t,
                  status: runtime.status,
                  uptime_secs: runtime.uptime_secs,
                  bytes_tx: runtime.bytes_tx,
                  bytes_rx: runtime.bytes_rx,
                  last_error: runtime.last_error,
                  retry_count: runtime.retry_count,
                }
              }
              return t
            }),
          }
        })
      } catch {
        // Silently ignore poll errors
      }
    }, 5000)

    set({ pollInterval: interval })
  },

  stopPolling: () => {
    const interval = get().pollInterval
    if (interval) {
      clearInterval(interval)
      set({ pollInterval: null })
    }
  },

  startTunnel: async (id: string) => {
    await apiStartTunnel(id)
    await get().fetchTunnels()
  },

  stopTunnel: async (id: string) => {
    await apiStopTunnel(id)
    await get().fetchTunnels()
  },

  reconnectTunnel: async (id: string) => {
    await apiReconnectTunnel(id)
    await get().fetchTunnels()
  },

  autoStartAll: async () => {
    try {
      await startAllTunnels()
      await get().fetchTunnels()
    } catch (err) {
      console.error('Failed to auto-start tunnels:', err)
    }
  },

  getActiveTunnelCount: () => {
    return get().tunnels.filter(t =>
      t.status === 'connected' || t.status === 'connecting' || t.status === 'reconnecting'
    ).length
  },

  hasFailedTunnels: () => {
    return get().tunnels.some(t => t.status === 'failed')
  },

  getFailedCount: () => {
    return get().tunnels.filter(t => t.status === 'failed').length
  },
}))
