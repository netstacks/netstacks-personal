import { useCallback, useRef, createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'

export type MultiSendListener = (input: string, sourceId: string) => void

interface MultiSendManager {
  enabled: Set<string>
  listeners: Map<string, MultiSendListener>
  stateListeners: Set<() => void>
}

// Global manager shared across all useMultiSend instances
const manager: MultiSendManager = {
  enabled: new Set(),
  listeners: new Map(),
  stateListeners: new Set(),
}

// Cached snapshot for useSyncExternalStore (must be referentially stable)
let cachedSnapshot: Set<string> = new Set()

// Notify all state listeners when enabled set changes
function notifyStateChange(): void {
  // Update cached snapshot only when state changes
  cachedSnapshot = new Set(manager.enabled)
  manager.stateListeners.forEach(listener => listener())
}

// Subscribe to manager state changes
function subscribeToManager(callback: () => void): () => void {
  manager.stateListeners.add(callback)
  return () => manager.stateListeners.delete(callback)
}

// Get snapshot of enabled terminals (returns cached reference)
function getEnabledSnapshot(): Set<string> {
  return cachedSnapshot
}

/**
 * Hook for managing multi-send functionality across terminals.
 * Multi-send allows input typed in one terminal to be broadcast to all
 * other terminals with multi-send enabled.
 */
export function useMultiSend() {
  // Use useSyncExternalStore for efficient external state synchronization
  const enabledTerminals = useSyncExternalStore(subscribeToManager, getEnabledSnapshot, getEnabledSnapshot)
  const broadcastingRef = useRef(false)

  const toggleMultiSend = useCallback((terminalId: string) => {
    if (manager.enabled.has(terminalId)) {
      manager.enabled.delete(terminalId)
    } else {
      manager.enabled.add(terminalId)
    }
    notifyStateChange()
  }, [])

  const isMultiSendEnabled = useCallback((terminalId: string) => {
    return manager.enabled.has(terminalId)
  }, [])

  const getMultiSendTerminals = useCallback(() => {
    return Array.from(manager.enabled)
  }, [])

  const clearMultiSend = useCallback(() => {
    manager.enabled.clear()
    notifyStateChange()
  }, [])

  const selectAllTerminals = useCallback((terminalIds: string[]) => {
    terminalIds.forEach(id => manager.enabled.add(id))
    notifyStateChange()
  }, [])

  const registerListener = useCallback((terminalId: string, listener: MultiSendListener) => {
    manager.listeners.set(terminalId, listener)
    return () => {
      manager.listeners.delete(terminalId)
    }
  }, [])

  const broadcast = useCallback((input: string, sourceId: string) => {
    if (broadcastingRef.current) return
    if (!manager.enabled.has(sourceId)) return

    broadcastingRef.current = true
    try {
      manager.enabled.forEach(terminalId => {
        if (terminalId !== sourceId) {
          const listener = manager.listeners.get(terminalId)
          listener?.(input, sourceId)
        }
      })
    } finally {
      broadcastingRef.current = false
    }
  }, [])

  return {
    enabledTerminals,
    toggleMultiSend,
    isMultiSendEnabled,
    getMultiSendTerminals,
    clearMultiSend,
    selectAllTerminals,
    registerListener,
    broadcast,
  }
}

// Create a shared context for multi-send state
interface MultiSendContextValue {
  enabledTerminals: Set<string>
  toggleMultiSend: (terminalId: string) => void
  isMultiSendEnabled: (terminalId: string) => boolean
  getMultiSendTerminals: () => string[]
  clearMultiSend: () => void
  selectAllTerminals: (terminalIds: string[]) => void
  registerListener: (terminalId: string, listener: MultiSendListener) => () => void
  broadcast: (input: string, sourceId: string) => void
}

const MultiSendContext = createContext<MultiSendContextValue | null>(null)

export function MultiSendProvider({ children }: { children: ReactNode }) {
  const multiSend = useMultiSend()

  return (
    <MultiSendContext.Provider value={multiSend}>
      {children}
    </MultiSendContext.Provider>
  )
}

export function useMultiSendContext() {
  const context = useContext(MultiSendContext)
  if (!context) {
    throw new Error('useMultiSendContext must be used within a MultiSendProvider')
  }
  return context
}
