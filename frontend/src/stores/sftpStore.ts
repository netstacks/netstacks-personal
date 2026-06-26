import { create } from 'zustand'
import { sftpConnect, sftpDisconnect } from '../api/sftp'
import type { CliFlavor } from '../api/sessions'
import { resolveSftpStartPath } from '../lib/sftpStartPaths'

import { getErrorMessage } from '../api/errors'
export interface SftpConnection {
  id: string
  sessionId: string
  deviceName: string
  cliFlavor: CliFlavor
  sftpStartPath: string | null
  homeDir: string | null
  connected: boolean
  error: string | null
}

interface SftpState {
  connections: SftpConnection[]
  activeConnectionId: string | null
  panelVisible: boolean

  openConnection: (params: {
    sessionId: string
    deviceName: string
    cliFlavor: CliFlavor
    sftpStartPath: string | null
    enterpriseCredentialId?: string
    enterpriseTargetHost?: string
    enterpriseTargetPort?: number
  }) => Promise<void>
  closeConnection: (id: string) => Promise<void>
  closeConnectionForSession: (sessionId: string) => Promise<void>
  setActiveConnection: (id: string) => void
  togglePanel: () => void
  showPanel: () => void
  getConnection: (id: string) => SftpConnection | undefined
  getConnectionForSession: (sessionId: string) => SftpConnection | undefined
  getConnectionCount: () => number
  getStartPath: (id: string) => string
}

export const useSftpStore = create<SftpState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  panelVisible: false,

  openConnection: async ({ sessionId, deviceName, cliFlavor, sftpStartPath, enterpriseCredentialId, enterpriseTargetHost, enterpriseTargetPort }) => {
    // Don't open duplicate for same session
    const existing = get().connections.find(c => c.sessionId === sessionId)
    if (existing) {
      set({ activeConnectionId: existing.id, panelVisible: true })
      return
    }

    const id = sessionId // Use sessionId as SFTP connection ID
    try {
      const enterpriseParams = enterpriseCredentialId && enterpriseTargetHost
        ? { credential_id: enterpriseCredentialId, host: enterpriseTargetHost, port: enterpriseTargetPort }
        : undefined
      const result = await sftpConnect(id, sessionId, enterpriseParams)

      const connection: SftpConnection = {
        id,
        sessionId,
        deviceName,
        cliFlavor,
        sftpStartPath,
        homeDir: result.home_dir,
        connected: result.connected,
        error: null,
      }

      set(state => ({
        connections: [...state.connections, connection],
        activeConnectionId: id,
        panelVisible: true,
      }))
    } catch (err) {
      const message = getErrorMessage(err, 'Failed to connect SFTP')
      const connection: SftpConnection = {
        id,
        sessionId,
        deviceName,
        cliFlavor,
        sftpStartPath,
        homeDir: null,
        connected: false,
        error: message,
      }
      set(state => ({
        connections: [...state.connections, connection],
        activeConnectionId: id,
        panelVisible: true,
      }))
    }
  },

  closeConnection: async (id: string) => {
    try {
      await sftpDisconnect(id)
    } catch {
      // Ignore disconnect errors
    }
    set(state => {
      const remaining = state.connections.filter(c => c.id !== id)
      return {
        connections: remaining,
        activeConnectionId: remaining.length > 0
          ? (state.activeConnectionId === id ? remaining[0].id : state.activeConnectionId)
          : null,
        panelVisible: remaining.length > 0,
      }
    })
  },

  closeConnectionForSession: async (sessionId: string) => {
    const conn = get().connections.find(c => c.sessionId === sessionId)
    if (conn) {
      await get().closeConnection(conn.id)
    }
  },

  setActiveConnection: (id: string) => set({ activeConnectionId: id }),

  togglePanel: () => set(state => ({ panelVisible: !state.panelVisible })),

  showPanel: () => set({ panelVisible: true }),

  getConnection: (id: string) => get().connections.find(c => c.id === id),

  getConnectionForSession: (sessionId: string) =>
    get().connections.find(c => c.sessionId === sessionId),

  getConnectionCount: () => get().connections.length,

  getStartPath: (id: string) => {
    const conn = get().connections.find(c => c.id === id)
    if (!conn) return '/'
    return resolveSftpStartPath(conn.sftpStartPath, conn.cliFlavor, conn.homeDir)
  },
}))
