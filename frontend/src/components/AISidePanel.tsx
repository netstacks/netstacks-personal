import { useState, useEffect, useRef, useCallback, useMemo, type PointerEvent as ReactPointerEvent } from 'react'
import './AISidePanel.css'
import MarkdownViewer from './MarkdownViewer'
import ContextMenu from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import { useContextMenu } from '../hooks/useContextMenu'
import { PromoteToTaskDialog } from './PromoteToTaskDialog'
import { useAIAgent, type AgentSession, type AgentMessage, type AddSessionContextParams, type NeighborParseResult, type AddNeighborParams, type AddNeighborResult, type NetBoxImportParams, type NetBoxImportResult, type CreateMopParams, type CreateMopResult } from '../hooks/useAIAgent'
import type { TopologyAICallbacks } from '../lib/topologyAITools'
import type { LiveContextDeps } from '../lib/aiLiveContext'
import { useAgentTasks } from '../hooks/useAgentTasks'
import { listAiConversations, getAiConversation, createAiConversation, updateAiConversation, deleteAiConversation, type AiConversationSummary } from '../api/aiConversations'
import type { PermissionMode } from '../api/agent'
import { type AgentType, AGENT_TYPES, PERMISSION_MODES } from '../lib/aiModes'
import { useModeNames } from '../hooks/useModeNames'
import type { CliFlavor } from '../api/sessions'
import type { Document, DocumentCategory } from '../api/docs'
import type { SessionContextEntry, AiProviderType } from '../api/ai'
import { hasAiApiKey, checkOllamaStatus, fetchOllamaModels, getAiStatus, getAiConfig } from '../api/ai'
import { getCurrentMode } from '../api/client'
import { useSettings } from '../hooks/useSettings'
import { loadPanelSettings, savePanelSettings } from '../api/panelSettings'
import { useMode } from '../hooks/useMode'
import { isOnboarded } from '../api/aiEngineerProfile'
import { useAssistantName } from '../stores/assistantName'
import { useQuickPrompts } from '../stores/quickPrompts'
import { NeighborParser } from '../lib/neighborParser'
import { createConnection } from '../api/topology'
import type { Device as TopologyDevice } from '../types/topology'
import type { NetBoxNeighbor } from '../api/netbox'

// Re-export for App.tsx
import { logger } from '../lib/logger'
export type { AgentMessage }

// localStorage pointer to the conversation to resume when the panel reopens.
const LAST_CONVO_KEY = 'netstacks.ai.panel.lastConversationId'

// Quick Actions collapse/dismiss preferences (persist across sessions).
const QA_EXPANDED_KEY = 'netstacks.ai.quickActions.expanded'

/** Derive a short conversation title from the first user message. */
function deriveConversationTitle(messages: AgentMessage[]): string {
  const firstUser = messages.find(m => m.type === 'user')
  const c = firstUser?.content
  const text = (typeof c === 'string' ? c : '').trim().replace(/\s+/g, ' ')
  return text ? text.slice(0, 60) : 'New chat'
}

interface AISidePanelProps {
  isOpen: boolean
  onClose: () => void
  /** Increment to trigger expand (for Cmd+I when collapsed) */
  expandTrigger?: number
  /** Available sessions for the AI agent - includes connection status */
  availableSessions?: Array<{
    id: string
    name: string
    connected?: boolean
    cliFlavor?: CliFlavor
    /** Saved session-definition id — the key device memory/context is stored under. */
    savedSessionId?: string
  }>
  /** Callback when command needs to be executed - runs in the terminal so user can see it */
  onExecuteCommand?: (sessionId: string, command: string) => Promise<string>
  /** Callback to get terminal output context */
  getTerminalContext?: (sessionId: string, lines?: number) => Promise<string>
  /** Live context dependencies for workspace state injection */
  liveContextDeps?: LiveContextDeps
  /** Callback to open a saved session (opens terminal tab and connects) */
  onOpenSession?: (sessionId: string) => Promise<void>
  /** Callback to list documents by category */
  onListDocuments?: (category?: DocumentCategory) => Promise<Document[]>
  /** Callback to read document content by ID */
  onReadDocument?: (documentId: string, byName?: boolean) => Promise<Document | null>
  /** Callback to search documents by name/content */
  onSearchDocuments?: (query: string, category?: DocumentCategory) => Promise<Document[]>
  /** Callback to save/create a document */
  onSaveDocument?: (path: string, content: string, category?: DocumentCategory, mode?: 'overwrite' | 'append', sessionId?: string) => Promise<{ id: string; name: string }>
  /** Initial messages to continue a conversation from popup/floating chat */
  initialMessages?: AgentMessage[]
  /** Callback to add session context (tribal knowledge) */
  onAddSessionContext?: (sessionId: string, params: AddSessionContextParams) => Promise<{ id: string }>
  /** Callback to list session context entries */
  onListSessionContext?: (sessionId: string) => Promise<SessionContextEntry[]>
  /** Default pinned state from settings */
  defaultPinned?: boolean
  /** Topology context for neighbor discovery (Phase 22) */
  topologyContext?: {
    topologyId: string
    devices: TopologyDevice[]
    onRefresh: () => void
  }
  /** NetBox topology callbacks (Phase 22) */
  onNetBoxGetNeighbors?: (sourceId: string, deviceId: number) => Promise<NetBoxNeighbor[]>
  onNetBoxImportTopology?: (params: NetBoxImportParams) => Promise<NetBoxImportResult>
  /** Callback when AI updates a topology device - triggers refresh */
  onTopologyDeviceUpdated?: (topologyId: string) => void
  /** Topology AI tool callbacks for the active topology (query/analyze/modify). */
  topologyCallbacks?: TopologyAICallbacks
  /** When false (default), AI structural topology edits are withheld. */
  allowStructuralTopologyEdits?: boolean
  /** MOP creation callback */
  onCreateMop?: (params: CreateMopParams) => Promise<CreateMopResult>
  /** External prompt to send (e.g., from AI Discover button) - increment counter to re-trigger same prompt */
  externalPrompt?: { prompt: string; counter: number }
  // Troubleshooting session capture (Phase 26)
  /** Callback to capture AI chat messages for troubleshooting session */
  onTroubleshootingCapture?: (type: 'ai-chat', content: string) => void
  /** Whether troubleshooting session is active */
  isTroubleshootingActive?: boolean
  /** Whether to capture AI conversations (from session settings) */
  captureAIConversations?: boolean
  /** Callback when collapsed state changes */
  onCollapsedChange?: (collapsed: boolean) => void
  /** Currently focused session ID (from active terminal tab) — auto-tracks active tab */
  focusedSessionId?: string
  /** Currently focused session name (for display/context) */
  focusedSessionName?: string
  /** Script overlord context - when a script tab is active */
  scriptContext?: {
    name: string
    getContent: () => string
    onApplyCode: (code: string) => void
  }
  /** UI navigation callbacks for AI tools */
  onNavigateToBackup?: (deviceId: string, deviceName: string, searchText?: string) => void
  onNavigateToDevice?: (deviceId: string, deviceName: string) => void
  onOpenTerminalSession?: (deviceName: string) => void
  onNavigateToMop?: (mopId: string, mopName: string) => void
  onNavigateToTopology?: (topologyName: string) => void
  onNavigateToSettings?: (tab?: string) => void
  /** Render surface: 'panel' (docked side panel) or 'tab' (full-window chat,
   *  no side-panel chrome — used by the chat-session tab). */
  variant?: 'panel' | 'tab'
  /** Maximize the side panel into a full chat-session tab. */
  onOpenAsTab?: () => void
  /** Pop the chat tab out into its own window (tab variant only). */
  onPopOut?: () => void
  /** Dock the chat tab back into the side panel (tab variant only). */
  onDockToPanel?: () => void
  /** Report this chat's first user prompt (for the tab's hover tooltip). */
  onPromptCapture?: (prompt: string) => void
  /** Open the Quick Prompts editor (Settings → Prompts). */
  onManagePrompts?: () => void
}

type AgentState = 'idle' | 'thinking' | 'executing' | 'waiting_approval' | 'error'

interface DisplayMessage {
  id: string
  type: 'user' | 'agent' | 'command-request' | 'command-result' | 'error' | 'system'
  content: string
  timestamp: Date
  command?: string
  sessionId?: string
  sessionName?: string
  output?: string
}

const STATE_LABELS: Record<AgentState, string> = {
  idle: 'Ready',
  thinking: 'Analyzing...',
  executing: 'Running...',
  waiting_approval: 'Needs Approval',
  error: 'Error',
}


const SCRIPT_QUICK_ACTIONS = [
  { id: 'explain', label: 'Explain Script', icon: 'info', prompt: 'Explain what this script does, step by step' },
  { id: 'improve', label: 'Improve Script', icon: 'star', prompt: 'Suggest improvements to this script for better reliability and readability' },
  { id: 'fix', label: 'Fix / Harden', icon: 'shield', prompt: 'Add proper error handling, input validation, and make this script production-ready' },
  { id: 'add-comments', label: 'Add Comments', icon: 'comment', prompt: 'Add clear, helpful comments to this script' },
]

const AISidePanel = ({
  isOpen,
  onClose,
  expandTrigger,
  availableSessions = [],
  onExecuteCommand,
  getTerminalContext,
  liveContextDeps,
  onOpenSession,
  onListDocuments,
  onReadDocument,
  onSearchDocuments,
  onSaveDocument,
  initialMessages,
  onAddSessionContext,
  onListSessionContext,
  defaultPinned = true,
  topologyContext,
  onNetBoxGetNeighbors,
  onNetBoxImportTopology,
  onTopologyDeviceUpdated,
  topologyCallbacks,
  allowStructuralTopologyEdits,
  onCreateMop,
  externalPrompt,
  onTroubleshootingCapture,
  isTroubleshootingActive,
  captureAIConversations,
  onCollapsedChange,
  focusedSessionId,
  focusedSessionName: _focusedSessionName,
  scriptContext,
  onNavigateToBackup,
  onNavigateToDevice,
  onOpenTerminalSession,
  onNavigateToMop,
  onNavigateToTopology,
  onNavigateToSettings,
  variant = 'panel',
  onOpenAsTab,
  onPopOut,
  onDockToPanel,
  onPromptCapture,
  onManagePrompts,
}: AISidePanelProps) => {
  // Full-window chat-session tab vs docked side panel.
  const isTab = variant === 'tab'
  const assistantName = useAssistantName()
  // Panel state
  const [width, setWidth] = useState(380)
  const [isResizing, setIsResizing] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isPinned, setIsPinned] = useState(defaultPinned)
  const [aiTabY, setAiTabY] = useState(100) // vertical position of collapsed AI tab

  // Quick Actions: default to the compact inset chip; expand shows the grid,
  // collapse returns to the chip (persisted).
  const [quickActionsExpanded, setQuickActionsExpanded] = useState(() => {
    try { return localStorage.getItem(QA_EXPANDED_KEY) === '1' } catch { return false }
  })
  const toggleQuickActions = useCallback(() => {
    setQuickActionsExpanded(v => {
      const next = !v
      try { localStorage.setItem(QA_EXPANDED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [])

  // Favorited Quick Prompts pinned to the chat top (shared, reactive store —
  // updates the moment you edit prompts in Settings). Only favorites show here.
  const favoritePrompts = useQuickPrompts().filter(p => p.is_favorite)

  // Notify parent of collapsed state changes (skip initial mount)
  const prevCollapsed = useRef(isCollapsed)
  useEffect(() => {
    if (prevCollapsed.current !== isCollapsed) {
      prevCollapsed.current = isCollapsed
      onCollapsedChange?.(isCollapsed)
    }
  }, [isCollapsed, onCollapsedChange])

  // Unified AI state
  const [input, setInput] = useState('')
  // Large-prompt editor bubble (the expand icon opens it; movable + resizable).
  const [promptEditorOpen, setPromptEditorOpen] = useState(false)
  const [pePos, setPePos] = useState<{ x: number; y: number } | null>(null)
  const peDrag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const openPromptEditor = () => {
    setPePos(prev => prev ?? {
      x: Math.max(20, (window.innerWidth - 720) / 2),
      y: Math.max(20, (window.innerHeight - 480) / 2),
    })
    setPromptEditorOpen(true)
  }
  const onPeHeadDown = (e: ReactPointerEvent) => {
    if (!pePos) return
    peDrag.current = { sx: e.clientX, sy: e.clientY, ox: pePos.x, oy: pePos.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPeHeadMove = (e: ReactPointerEvent) => {
    if (!peDrag.current) return
    const { sx, sy, ox, oy } = peDrag.current
    setPePos({ x: ox + (e.clientX - sx), y: oy + (e.clientY - sy) })
  }
  const onPeHeadUp = (e: ReactPointerEvent) => {
    peDrag.current = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('auto')
  const [selectedSession, setSelectedSession] = useState<string>('')
  const [agentType, setAgentType] = useState<AgentType>('autopilot')
  const modeNames = useModeNames()

  // Get default provider from settings
  const { settings: appSettings } = useSettings()

  // Provider/Model selection (two separate dropdowns)
  const [selectedProvider, setSelectedProvider] = useState<AiProviderType>('anthropic')
  const [defaultModel, setDefaultModel] = useState<string>('')
  const [, setAvailableModels] = useState<{ value: string; label: string }[]>([])
  const [providerConfigured, setProviderConfigured] = useState<Record<AiProviderType, boolean>>({
    anthropic: false,
    openai: false,
    openrouter: false,
    ollama: false,
    litellm: false,
    custom: false,
  })

  // AI Engineer onboarding detection (standalone mode only)
  const [onboardingNeeded, setOnboardingNeeded] = useState(false)
  const { isEnterprise } = useMode()

  // Re-check onboarding when panel becomes visible (catches profile changes from settings)
  useEffect(() => {
    if (isEnterprise) return
    isOnboarded().then(completed => {
      setOnboardingNeeded(!completed)
    })
  }, [isEnterprise, isOpen])

  // Promote to task dialog state
  const [showPromoteDialog, setShowPromoteDialog] = useState(false)
  const { createTask } = useAgentTasks()
  const msgContextMenu = useContextMenu()

  // Convert availableSessions to AgentSession format
  const agentSessions: AgentSession[] = useMemo(() =>
    availableSessions.map(s => ({
      id: s.id,
      name: s.name,
      connected: s.connected ?? true,
      cliFlavor: s.cliFlavor,
    })),
    [availableSessions]
  )

  // Neighbor discovery callback (Phase 22)
  // Runs CDP or LLDP command, parses output, returns neighbor info
  const handleDiscoverNeighbors = useCallback(async (
    sessionId: string,
    protocol: 'cdp' | 'lldp' | 'auto'
  ): Promise<NeighborParseResult> => {
    if (!onExecuteCommand) {
      throw new Error('Command execution not available')
    }

    // Look up session to get CLI flavor
    const session = availableSessions.find(s => s.id === sessionId)
    const cliFlavor = session?.cliFlavor || 'auto'

    // Disable paging based on device type
    // Different vendors use different commands to disable terminal paging
    // For 'auto' mode, we skip paging commands and rely on | no-more pipe instead
    // to avoid sending wrong commands that clutter the terminal
    if (cliFlavor !== 'auto') {
      try {
        switch (cliFlavor) {
          case 'cisco-ios':
          case 'cisco-ios-xr':
          case 'cisco-nxos':
          case 'arista':
            // Cisco IOS / IOS-XR / NX-OS and Arista EOS all use this command
            await onExecuteCommand(sessionId, 'terminal length 0')
            break
          case 'juniper':
            // Juniper uses screen-length in operational mode
            await onExecuteCommand(sessionId, 'set cli screen-length 0')
            break
          case 'paloalto':
            // Palo Alto PAN-OS
            await onExecuteCommand(sessionId, 'set cli pager off')
            break
          case 'fortinet':
            // Fortinet FortiOS - disable output paging
            await onExecuteCommand(sessionId, 'config system console')
            await onExecuteCommand(sessionId, 'set output standard')
            await onExecuteCommand(sessionId, 'end')
            break
        }
      } catch {
        // Ignore paging command errors - device may already have paging disabled
      }
    }

    // Helper to append no-more pipe for commands.
    // Junos uses `| no-more` to suppress paging. Cisco IOS / IOS-XR /
    // NX-OS / Arista treat that as a syntax error ("% Invalid input
    // detected at '^' marker"). So only append it when we *know* the
    // flavor is Juniper. For 'auto', do nothing — let the AI probe and
    // call set_session_cli_flavor first; sending Junos syntax to an
    // unknown device is worse than no-pager-disable.
    const addNoPager = (cmd: string): string => {
      if (cliFlavor === 'juniper') {
        return `${cmd} | no-more`
      }
      if (cliFlavor === 'fortinet') {
        return `${cmd} | grep -v "^--More--"`
      }
      return cmd
    }

    // Determine command based on protocol
    let output = ''
    let detectedProtocol: 'cdp' | 'lldp' = 'cdp'

    if (protocol === 'auto' || protocol === 'cdp') {
      try {
        output = await onExecuteCommand(sessionId, addNoPager('show cdp neighbors detail'))
        if (NeighborParser.isCdpOutput(output)) {
          detectedProtocol = 'cdp'
        } else if (protocol === 'auto') {
          // CDP didn't work, try LLDP
          output = await onExecuteCommand(sessionId, addNoPager('show lldp neighbors detail'))
          detectedProtocol = 'lldp'
        }
      } catch {
        if (protocol === 'auto') {
          // Try LLDP as fallback
          output = await onExecuteCommand(sessionId, addNoPager('show lldp neighbors detail'))
          detectedProtocol = 'lldp'
        } else {
          throw new Error('CDP command failed')
        }
      }
    } else if (protocol === 'lldp') {
      output = await onExecuteCommand(sessionId, addNoPager('show lldp neighbors detail'))
      detectedProtocol = 'lldp'
    }

    // Parse the output
    const parseResult = NeighborParser.parse(output)

    return {
      protocol: detectedProtocol,
      neighbors: parseResult.neighbors,
      deviceName: parseResult.deviceName,
    }
  }, [onExecuteCommand, availableSessions])

  // Add neighbor to topology callback (Phase 22)
  // NOTE: This only creates connections between existing devices on the map.
  // If a neighbor is discovered that's not on the map, we report it but don't add it.
  const handleAddNeighborToTopology = useCallback(async (
    params: AddNeighborParams
  ): Promise<AddNeighborResult> => {
    if (!topologyContext) {
      throw new Error('No topology context available')
    }

    // Check if neighbor device already exists on the map
    // Try to match by name (case-insensitive) or by IP
    const existingDevice = topologyContext.devices.find(d => {
      const nameMatch = d.name.toLowerCase() === params.neighbor_name.toLowerCase()
      const ipMatch = params.neighbor_ip && d.primaryIp === params.neighbor_ip
      return nameMatch || ipMatch
    })

    if (!existingDevice) {
      // Device not on the map - report this but don't add it
      throw new Error(
        `Neighbor "${params.neighbor_name}"${params.neighbor_ip ? ` (${params.neighbor_ip})` : ''} ` +
        `is not on this topology map. Only devices with active SSH sessions can be shown.`
      )
    }

    // Create connection between source and existing neighbor
    const connection = await createConnection(topologyContext.topologyId, {
      source_device_id: params.source_device_id,
      target_device_id: existingDevice.id,
      source_interface: params.local_interface,
      target_interface: params.remote_interface,
    })

    // Refresh topology to show new connection
    topologyContext.onRefresh()

    return {
      deviceId: existingDevice.id,
      connectionId: connection.id,
    }
  }, [topologyContext])

  // DB-backed chat history. `seed` drives the agent hook's initial messages;
  // `conversationId` is the row we save into (null = unsaved/new chat).
  const [seed, setSeed] = useState<AgentMessage[] | undefined>(
    initialMessages && initialMessages.length ? initialMessages : undefined
  )
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [conversations, setConversations] = useState<AiConversationSummary[]>([])

  // Use the unified AI agent hook
  const {
    messages: agentMessages,
    agentState,
    pendingCommands,
    sendMessage,
    approveCommands,
    rejectCommands,
    stopAgent,
    clearMessages,
    tokenUsage,
    resetTokenUsage,
  } = useAIAgent({
    sessions: agentSessions,
    onExecuteCommand,
    getTerminalContext,
    liveContextDeps,
    onOpenSession,
    permissionMode,
    // Pass selected provider/model to the hook
    provider: selectedProvider,
    model: defaultModel,
    onListDocuments,
    onReadDocument,
    onSearchDocuments,
    onSaveDocument,
    initialMessages: seed,
    // Session context callbacks (Phase 14)
    onAddSessionContext,
    onListSessionContext,
    // Neighbor discovery callbacks (Phase 22)
    onDiscoverNeighbors: topologyContext ? handleDiscoverNeighbors : undefined,
    onAddNeighborToTopology: topologyContext ? handleAddNeighborToTopology : undefined,
    // NetBox topology callbacks (Phase 22)
    onNetBoxGetNeighbors,
    onNetBoxImportTopology,
    // NetStacksCrawler topology callbacks (Phase 22)
    // MOP creation callback
    onCreateMop,
    // Topology refresh callback
    onTopologyDeviceUpdated,
    // Topology AI tools for the active topology (Phase 27-07)
    topologyCallbacks,
    allowStructuralTopologyEdits,
    // Active session context — tells the AI which session is focused
    activeSessionId: selectedSession,
    activeSessionName: availableSessions.find(s => s.id === selectedSession)?.name,
    // Device memory/context are keyed on the SAVED session id, not the runtime
    // tab id used as activeSessionId here.
    activeMemorySessionId: availableSessions.find(s => s.id === selectedSession)?.savedSessionId,
    // Script overlord context
    scriptContext: scriptContext ? { name: scriptContext.name, getContent: scriptContext.getContent } : undefined,
    // Agent type for system prompt and tool filtering
    agentType,
    // UI navigation callbacks
    onNavigateToBackup,
    onNavigateToDevice,
    onOpenTerminalSession,
    onNavigateToMop,
    onNavigateToTopology,
    onNavigateToSettings,
    // Stream responses everywhere — side panel, tab, all surfaces. (Previously
    // gated to overlay-only for no good reason; streaming is the better default.)
    streaming: true,
  })

  // Resume the most recent conversation on first mount (unless a continue-in-
  // panel seed was provided). Loads its messages into the agent hook via `seed`.
  useEffect(() => {
    if (initialMessages && initialMessages.length) return
    const lastId = localStorage.getItem(LAST_CONVO_KEY)
    if (!lastId) return
    getAiConversation(lastId)
      .then(conv => { setSeed(conv.messages); setConversationId(conv.id) })
      .catch(() => localStorage.removeItem(LAST_CONVO_KEY))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Continue-in-panel hand-off (after mount): seed from the prop as a new convo.
  const continueHandledRef = useRef(false)
  useEffect(() => {
    if (!continueHandledRef.current) { continueHandledRef.current = true; return }
    if (initialMessages && initialMessages.length) {
      setSeed(initialMessages)
      setConversationId(null)
    }
  }, [initialMessages])

  // Save the conversation (create on first message, update thereafter).
  // Debounced so streaming token updates don't thrash the DB. Failures are
  // swallowed so persistence can never break the chat.
  useEffect(() => {
    if (agentMessages.length === 0) return
    const t = setTimeout(async () => {
      const title = deriveConversationTitle(agentMessages)
      try {
        if (conversationId) {
          await updateAiConversation(conversationId, { messages: agentMessages, title })
        } else {
          const created = await createAiConversation({ messages: agentMessages, title, agent_type: agentType })
          setConversationId(created.id)
          localStorage.setItem(LAST_CONVO_KEY, created.id)
        }
      } catch { /* ignore */ }
    }, 700)
    return () => clearTimeout(t)
  }, [agentMessages, conversationId, agentType])

  const handleNewChat = useCallback(() => {
    clearMessages()
    setSeed(undefined)
    setConversationId(null)
    setShowHistory(false)
    localStorage.removeItem(LAST_CONVO_KEY)
  }, [clearMessages])

  const handleToggleHistory = useCallback(async () => {
    if (!showHistory) {
      try { setConversations(await listAiConversations()) } catch { setConversations([]) }
    }
    setShowHistory(v => !v)
  }, [showHistory])

  const handleLoadConversation = useCallback(async (id: string) => {
    try {
      const conv = await getAiConversation(id)
      setSeed(conv.messages)
      setConversationId(conv.id)
      localStorage.setItem(LAST_CONVO_KEY, conv.id)
      setShowHistory(false)
    } catch { /* ignore */ }
  }, [])

  const handleDeleteConversation = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await deleteAiConversation(id)
      setConversations(prev => prev.filter(c => c.id !== id))
      if (id === conversationId) handleNewChat()
    } catch { /* ignore */ }
  }, [conversationId, handleNewChat])

  // Convert agent messages to DisplayMessage format for display
  const displayMessages: DisplayMessage[] = useMemo(() => {
    if (agentMessages.length === 0) {
      return [{
        id: 'system-welcome',
        type: 'system',
        content: onboardingNeeded
          ? 'Welcome! I\'d like to get to know how you work so I can be more helpful. Type "hi" or anything to start a quick setup conversation.'
          : `${assistantName} ready. Ask a question or use a quick action below.`,
        timestamp: new Date(),
      }]
    }

    return agentMessages.map((msg): DisplayMessage => {
      // Direct type mappings; all others become 'agent'
      const type: DisplayMessage['type'] =
        msg.type === 'user' ? 'user' :
        msg.type === 'command-result' ? 'command-result' :
        msg.type === 'error' ? 'error' :
        'agent'

      return {
        id: msg.id,
        type,
        content: msg.content,
        timestamp: msg.timestamp,
        command: msg.command,
        sessionId: msg.sessionId,
        sessionName: msg.sessionName,
        output: msg.output,
      }
    })
  }, [agentMessages, onboardingNeeded, assistantName])

  // Report the chat's first user prompt once, so the host can show it on the
  // tab's hover tooltip (helps tell many chat tabs apart).
  const promptReportedRef = useRef(false)
  useEffect(() => {
    if (promptReportedRef.current || !onPromptCapture) return
    const firstUser = agentMessages.find(m => m.type === 'user')
    const text = firstUser?.content?.trim()
    if (text) {
      promptReportedRef.current = true
      onPromptCapture(text)
    }
  }, [agentMessages, onPromptCapture])

  // Refs
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Auto-size the input to its content (within reason — caps at ~9 lines, then
  // scrolls). Runs whenever the text changes (typing, pasting, clearing).
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(180, el.scrollHeight)}px`
  }, [input])

  // Update isPinned when default setting changes
  useEffect(() => {
    setIsPinned(defaultPinned)
  }, [defaultPinned])

  // Auto-track focused tab — when user switches terminal tabs, update selected session
  useEffect(() => {
    if (focusedSessionId && availableSessions.some(s => s.id === focusedSessionId)) {
      setSelectedSession(focusedSessionId)
    }
  }, [focusedSessionId, availableSessions])

  // Auto-select first session if none selected
  useEffect(() => {
    if (availableSessions.length > 0 && !selectedSession) {
      setSelectedSession(availableSessions[0].id)
    }
  }, [availableSessions, selectedSession])

  // Load AI provider configuration on mount
  useEffect(() => {
    const loadProviderConfig = async () => {
      try {
        const enabledProviders: AiProviderType[] = appSettings['ai.enabledProviders'] || ['anthropic']
        const isEnabled = (type: AiProviderType) => enabledProviders.includes(type)

        let configured: Record<AiProviderType, boolean>
        let ollamaModels: { value: string; label: string }[] = []

        if (getCurrentMode() === 'enterprise') {
          // Enterprise mode: query Controller for centrally configured providers
          const status = await getAiStatus()
          const providerTypes = new Set(status.providers.map(p => p.type))
          configured = {
            anthropic: providerTypes.has('anthropic'),
            openai: providerTypes.has('openai'),
            openrouter: providerTypes.has('openrouter'),
            ollama: providerTypes.has('ollama'),
            litellm: providerTypes.has('litellm'),
            custom: providerTypes.has('custom'),
          }
        } else {
          // Personal mode: check vault for API keys (only for enabled
          // providers). allSettled so one provider's vault error doesn't
          // hide the other's available key — treat any rejection as "no
          // key" rather than blanking both.
          const [anthropicRes, openaiRes] = await Promise.allSettled([
            isEnabled('anthropic') ? hasAiApiKey('anthropic') : Promise.resolve(false),
            isEnabled('openai') ? hasAiApiKey('openai') : Promise.resolve(false),
          ])
          const hasAnthropic = anthropicRes.status === 'fulfilled' ? anthropicRes.value : false
          const hasOpenAI = openaiRes.status === 'fulfilled' ? openaiRes.value : false

          // Check Ollama only if enabled
          let ollamaRunning = false
          if (isEnabled('ollama')) {
            try {
              const status = await checkOllamaStatus()
              ollamaRunning = status.running
              if (ollamaRunning) {
                ollamaModels = await fetchOllamaModels()
              }
            } catch {
              // Ollama not available
            }
          }

          // Check custom provider: has API key OR uses OAuth2 auth
          let customConfigured = false
          if (isEnabled('custom')) {
            const hasKey = await hasAiApiKey('custom')
            if (hasKey) {
              customConfigured = true
            } else {
              // Check if OAuth2 is configured (doesn't need a static key upfront)
              try {
                const cfg = await getAiConfig()
                if (cfg?.provider === 'custom' && cfg.auth_mode === 'oauth2') {
                  customConfigured = true
                }
              } catch { /* ignore */ }
            }
          }

          configured = {
            anthropic: isEnabled('anthropic') && hasAnthropic,
            openai: isEnabled('openai') && hasOpenAI,
            openrouter: isEnabled('openrouter') && await hasAiApiKey('openrouter'),
            ollama: isEnabled('ollama') && ollamaRunning,
            litellm: isEnabled('litellm'), // LiteLLM doesn't need API key
            custom: customConfigured,
          }
        }
        setProviderConfigured(configured)

        // Use default provider from settings, or first configured provider
        const defaultProvider = appSettings['ai.defaultProvider']
        let initialProvider: AiProviderType = defaultProvider

        // If default provider isn't configured, fall back to first configured one
        if (!configured[defaultProvider]) {
          if (configured.anthropic) initialProvider = 'anthropic'
          else if (configured.openai) initialProvider = 'openai'
          else if (configured.openrouter) initialProvider = 'openrouter'
          else if (configured.ollama) initialProvider = 'ollama'
          else if (configured.litellm) initialProvider = 'litellm'
          else if (configured.custom) initialProvider = 'custom'
        }

        setSelectedProvider(initialProvider)

        // Load models from settings for selected provider
        const getModelsFromSettings = (provider: AiProviderType): { value: string; label: string }[] => {
          const key = `ai.models.${provider}` as keyof typeof appSettings
          const modelList = (appSettings[key] as string[]) || []
          return modelList.map(m => ({ value: m, label: m }))
        }

        // Set available models for selected provider
        let models: { value: string; label: string }[] = []
        if (initialProvider === 'ollama' && ollamaModels.length > 0) {
          models = ollamaModels
        } else if (initialProvider === 'custom') {
          // Custom provider: get model from backend config (not localStorage)
          try {
            const cfg = await getAiConfig()
            if (cfg?.provider === 'custom' && cfg.model) {
              models = [{ value: cfg.model, label: cfg.model }]
            }
          } catch { /* ignore */ }
        } else {
          models = getModelsFromSettings(initialProvider)
        }

        // Select first model if available
        if (models.length > 0) {
          setDefaultModel(models[0].value)
        }

        setAvailableModels(models)
      } catch (err) {
        console.error('Failed to load AI provider config:', err)
      }
    }
    loadProviderConfig()
  }, [appSettings])

  // Update available models when provider changes
  useEffect(() => {
    const updateModels = async () => {
      // Helper to get models from settings
      const getModelsFromSettings = (provider: AiProviderType): { value: string; label: string }[] => {
        const key = `ai.models.${provider}` as keyof typeof appSettings
        const modelList = (appSettings[key] as string[]) || []
        return modelList.map(m => ({ value: m, label: m }))
      }

      const enabledProviders: AiProviderType[] = appSettings['ai.enabledProviders'] || ['anthropic']
      let models: { value: string; label: string }[] = []
      if (selectedProvider === 'ollama' && enabledProviders.includes('ollama')) {
        try {
          const fetched = await fetchOllamaModels()
          // For Ollama, use fetched models, fall back to configured models in settings
          models = fetched.length > 0 ? fetched : getModelsFromSettings('ollama')
        } catch {
          models = getModelsFromSettings('ollama')
        }
      } else if (selectedProvider === 'custom') {
        // Custom provider: get model from backend config
        try {
          const cfg = await getAiConfig()
          if (cfg?.provider === 'custom' && cfg.model) {
            models = [{ value: cfg.model, label: cfg.model }]
          }
        } catch { /* ignore */ }
      } else {
        models = getModelsFromSettings(selectedProvider)
      }

      setAvailableModels(models)
      // Auto-select first model if current model not in list
      if (models.length > 0 && !models.find(m => m.value === defaultModel)) {
        setDefaultModel(models[0].value)
      }
    }
    updateModels()
  }, [selectedProvider, appSettings]) // Re-run when provider or settings change

  // Focus input when opened
  useEffect(() => {
    if (isOpen && !isCollapsed) {
      setTimeout(() => {
        inputRef.current?.focus()
      }, 100)
    }
  }, [isOpen, isCollapsed])

  // Expand when trigger changes (Cmd+I pressed)
  useEffect(() => {
    if (isOpen && expandTrigger) {
      setIsCollapsed(false)
      setTimeout(() => {
        inputRef.current?.focus()
      }, 100)
    }
  }, [expandTrigger, isOpen])

  // ESC to collapse, click outside to auto-collapse when unpinned (docked only)
  useEffect(() => {
    if (!isOpen || isCollapsed || isTab) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsCollapsed(true)
      }
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (!isPinned && panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsCollapsed(true)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, isCollapsed, isPinned, isTab])

  // Scroll to bottom on new messages
  useEffect(() => {
    if (messagesRef.current) {
      // Defer scroll until after paint so scrollHeight reflects the new message
      requestAnimationFrame(() => {
        if (messagesRef.current) {
          messagesRef.current.scrollTop = messagesRef.current.scrollHeight
        }
      })
    }
  }, [displayMessages])

  // Capture AI chat messages for troubleshooting session (Phase 26)
  // We track the last captured message count to only capture new messages
  const lastCapturedCountRef = useRef(0)
  useEffect(() => {
    // Only capture if troubleshooting is active and AI capture is enabled
    if (!isTroubleshootingActive || !captureAIConversations || !onTroubleshootingCapture) {
      return
    }

    // Capture any new messages since last time
    const newMessages = agentMessages.slice(lastCapturedCountRef.current)
    for (const msg of newMessages) {
      // Format message for capture
      const role = msg.type === 'user' ? 'User' : 'AI'
      const captureContent = `[${role}] ${msg.content}`
      onTroubleshootingCapture('ai-chat', captureContent)
    }

    // Update last captured count
    lastCapturedCountRef.current = agentMessages.length
  }, [agentMessages, isTroubleshootingActive, captureAIConversations, onTroubleshootingCapture])

  // Handle resize
  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX
      setWidth(Math.max(320, Math.min(650, newWidth)))
    }

    const handleMouseUp = () => setIsResizing(false)

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // Message handlers
  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!input.trim() || agentState === 'thinking' || agentState === 'executing') return

    const userMessage = input.trim()
    setInput('')

    // Send message through the agent hook - it handles the agentic loop
    await sendMessage(userMessage)
  }, [input, agentState, sendMessage])

  const handleQuickAction = useCallback((prompt: string) => {
    setInput(prompt)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  // Handle promoting chat to background task
  const handlePromoteToTask = useCallback(async (prompt: string) => {
    const task = await createTask(prompt)
    logger.log('[AISidePanel] Created background task:', task.id)
  }, [createTask])

  const handlePopOut = useCallback(() => {
    // Maximize the side panel into a full chat-session tab.
    onOpenAsTab?.()
  }, [onOpenAsTab])

  // Handle external prompts (e.g., from AI Discover button)
  const lastExternalPromptCounter = useRef(0)
  useEffect(() => {
    if (externalPrompt && externalPrompt.counter !== lastExternalPromptCounter.current) {
      lastExternalPromptCounter.current = externalPrompt.counter
      // Only send if not busy
      if (agentState !== 'thinking' && agentState !== 'executing') {
        sendMessage(externalPrompt.prompt)
      }
    }
  }, [externalPrompt, agentState, sendMessage])

  // Use hook functions directly - no need for wrapper callbacks

  const isAgentBusy = agentState === 'thinking' || agentState === 'executing'

  // True once the agent's reply has actually started streaming text. Used to
  // show EITHER the thinking dots (pre-token) OR the streaming cursor (mid-text)
  // — never both, and never an empty bubble with a lone cursor.
  const lastDisplayMsg = displayMessages[displayMessages.length - 1]
  const isStreamingText =
    isAgentBusy && lastDisplayMsg?.type === 'agent' && !!lastDisplayMsg.content?.trim()

  const showPanel = isOpen && !isCollapsed

  // Context menu for chat messages
  const handleMessageContextMenu = useCallback((e: React.MouseEvent, msg: DisplayMessage) => {
    const items: MenuItem[] = []
    const selection = window.getSelection()?.toString() || ''

    // Copy selected text first (most common action)
    if (selection) {
      items.push({
        id: 'copy-selection',
        label: 'Copy',
        shortcut: '\u2318C',
        action: () => navigator.clipboard.writeText(selection)
      })
    }

    // Message-type-specific actions
    if (msg.type === 'user') {
      items.push({ id: 'copy-message', label: 'Copy Message', action: () => navigator.clipboard.writeText(msg.content) })
    } else if (msg.type === 'agent') {
      items.push(
        { id: 'copy-message', label: 'Copy Message', action: () => navigator.clipboard.writeText(msg.content) },
        { id: 'copy-markdown', label: 'Copy as Markdown', action: () => navigator.clipboard.writeText(msg.content) },
      )
    } else if (msg.type === 'command-request') {
      items.push({ id: 'copy-command', label: 'Copy Command', action: () => navigator.clipboard.writeText(msg.command || msg.content) })
    } else if (msg.type === 'command-result') {
      items.push({ id: 'copy-output', label: 'Copy Output', action: () => navigator.clipboard.writeText(msg.output || msg.content) })
    } else if (msg.type === 'system' || msg.type === 'error') {
      items.push({ id: 'copy-message', label: 'Copy Message', action: () => navigator.clipboard.writeText(msg.content) })
    }

    if (items.length > 0) {
      msgContextMenu.open(e, items)
    }
  }, [msgContextMenu])

  return (
    <>
      {/* Collapsed tab view — draggable vertically (docked panel only) */}
      {isOpen && isCollapsed && !isTab && (
        <div
          className="ai-side-panel-tab"
          style={{ top: aiTabY }}
          onClick={() => setIsCollapsed(false)}
          onMouseDown={(e) => {
            e.preventDefault()
            const startY = e.clientY
            const startTop = aiTabY
            const onMove = (me: MouseEvent) => {
              const newY = Math.max(40, Math.min(window.innerHeight - 60, startTop + me.clientY - startY))
              setAiTabY(newY)
            }
            const onUp = () => {
              document.removeEventListener('mousemove', onMove)
              document.removeEventListener('mouseup', onUp)
            }
            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          <span>AI</span>
          {agentState !== 'idle' && (
            <span className={`ai-side-panel-tab-status ${agentState}`} />
          )}
          {displayMessages.length > 1 && (
            <span className="ai-side-panel-tab-badge">
              {displayMessages.length - 1}
            </span>
          )}
        </div>
      )}

      <div
        ref={panelRef}
        data-testid="ai-panel"
        className={`ai-side-panel ${isTab ? 'tab-mode' : ''} ${isResizing ? 'resizing' : ''} ${!isTab && !isPinned ? 'floating' : ''} ${!isTab && !showPanel ? 'closed' : ''}`}
        style={isTab ? undefined : {
          width: showPanel ? width : 0,
        }}
      >
      {/* Resize handle (docked panel only) */}
      {!isTab && (
        <div
          className="ai-side-panel-resize"
          onMouseDown={() => setIsResizing(true)}
        />
      )}

      {/* Header */}
      <div className="ai-side-panel-header">
        {showHistory && (
          <div className="ai-history-dropdown" onMouseDown={e => e.stopPropagation()}>
            <div className="ai-history-dropdown-header">
              <span>Chat history</span>
              <button className="ai-side-panel-btn" onClick={() => setShowHistory(false)} title="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {conversations.length === 0 ? (
              <div className="ai-history-empty">No saved conversations yet.</div>
            ) : (
              <div className="ai-history-list">
                {conversations.map(c => (
                  <div
                    key={c.id}
                    className={`ai-history-item${c.id === conversationId ? ' active' : ''}`}
                    onClick={() => handleLoadConversation(c.id)}
                  >
                    <div className="ai-history-item-main">
                      <span className="ai-history-item-title">{c.title || 'Untitled'}</span>
                      <span className="ai-history-item-time">{new Date(c.updated_at).toLocaleString()}</span>
                    </div>
                    <button
                      className="ai-history-item-del"
                      onClick={(e) => handleDeleteConversation(c.id, e)}
                      title="Delete conversation"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="ai-side-panel-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          <span>{assistantName}</span>
          {agentState !== 'idle' && (
            <div className="ai-side-panel-agent-status">
              <div className={`ai-side-panel-status-dot ${agentState}`} />
              <span>{STATE_LABELS[agentState]}</span>
            </div>
          )}
        </div>
        {/* Token Usage Display */}
        {tokenUsage.requestCount > 0 && (
          <div className="ai-side-panel-token-usage" title={`In: ${tokenUsage.inputTokens.toLocaleString()} | Out: ${tokenUsage.outputTokens.toLocaleString()} | Requests: ${tokenUsage.requestCount}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span className="ai-token-count">{tokenUsage.totalTokens.toLocaleString()}</span>
            <button
              className="ai-token-reset"
              onClick={resetTokenUsage}
              title="Reset token counter"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          </div>
        )}
        <div className="ai-side-panel-actions">
          {displayMessages.length > 1 && (
            <>
              <button
                className="ai-side-panel-btn"
                onClick={() => setShowPromoteDialog(true)}
                title="Promote to background task"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </button>
              <button
                className="ai-side-panel-btn"
                onClick={handleToggleHistory}
                title="Chat history"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                  <circle cx="12" cy="12" r="9" />
                  <polyline points="12 7 12 12 15 14" />
                </svg>
              </button>
              <button
                className="ai-side-panel-btn"
                onClick={handleNewChat}
                title="New chat"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </>
          )}
          {/* Dock the chat tab back into the side panel (tab variant only) */}
          {isTab && onDockToPanel && (
            <button className="ai-side-panel-btn" onClick={onDockToPanel} title="Dock to side panel">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <line x1="14" y1="4" x2="14" y2="20" />
              </svg>
            </button>
          )}
          {/* Pop the chat tab out into its own window (tab variant only) */}
          {isTab && onPopOut && (
            <button className="ai-side-panel-btn" onClick={onPopOut} title="Pop out into its own window">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                <path d="M14 4h6v6" />
                <path d="M20 4l-8 8" />
                <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
              </svg>
            </button>
          )}
          {/* Open-as-tab button (docked panel only — tab mode is already full) */}
          {!isTab && (
            <button className="ai-side-panel-btn" onClick={handlePopOut} title="Open as a full chat tab">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}
          {!isTab && (
            <button
              className={`ai-side-panel-btn ${isPinned ? 'pinned' : ''}`}
              onClick={() => {
                // P1-2: persist via savePanelSettings so the value
                // survives reload. Previously only local state flipped.
                const next = !isPinned
                setIsPinned(next)
                savePanelSettings({ ...loadPanelSettings(), aiPanelPinned: next })
              }}
              title={isPinned ? 'Unpin (auto-collapse)' : 'Pin (stay open)'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4.76z" />
              </svg>
            </button>
          )}
          {!isTab && (
            <button
              className="ai-side-panel-btn"
              onClick={() => setIsCollapsed(true)}
              title="Collapse (Esc)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                <polyline points="13 17 18 12 13 7" />
                <polyline points="6 17 11 12 6 7" />
              </svg>
            </button>
          )}
          <button
            className="ai-side-panel-btn"
            onClick={onClose}
            title="Close (Cmd+I)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Quick Actions — compact inset chip by default; expand shows the grid,
          collapse returns to the chip. */}
      {!quickActionsExpanded ? (
        <button
          className="ai-side-panel-quick-actions-restore"
          onClick={toggleQuickActions}
          title="Show quick actions"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {scriptContext ? 'Script Overlord' : 'Quick Actions'}
        </button>
      ) : (
      <div className="ai-side-panel-quick-actions" data-testid="ai-quick-actions">
        <div className="ai-side-panel-quick-actions-header">
          <button
            className="ai-side-panel-quick-actions-label"
            onClick={toggleQuickActions}
            title="Collapse quick actions"
          >
            <svg className="ai-qa-chevron open" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="11" height="11">
              <polyline points="6 9 12 15 18 9" />
            </svg>
            {scriptContext ? 'Script Overlord' : 'Quick Actions'}
          </button>
          {!scriptContext && onManagePrompts && (
            <button
              className="ai-side-panel-quick-actions-manage"
              style={{ marginLeft: 'auto' }}
              onClick={onManagePrompts}
              title="Edit quick prompts"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
            </button>
          )}
          <button
            className="ai-side-panel-quick-actions-dismiss"
            onClick={toggleQuickActions}
            title="Collapse quick actions"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="ai-side-panel-quick-actions-grid">
          {scriptContext ? (
            SCRIPT_QUICK_ACTIONS.map(action => (
            <button
              key={action.id}
              className="ai-side-panel-quick-action"
              onClick={() => handleQuickAction(action.prompt)}
              disabled={isAgentBusy}
            >
              {action.icon === 'wifi' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                  <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                  <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                  <line x1="12" y1="20" x2="12.01" y2="20" />
                </svg>
              )}
              {action.icon === 'cpu' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
                  <rect x="9" y="9" width="6" height="6" />
                  <line x1="9" y1="1" x2="9" y2="4" />
                  <line x1="15" y1="1" x2="15" y2="4" />
                  <line x1="9" y1="20" x2="9" y2="23" />
                  <line x1="15" y1="20" x2="15" y2="23" />
                  <line x1="20" y1="9" x2="23" y2="9" />
                  <line x1="20" y1="14" x2="23" y2="14" />
                  <line x1="1" y1="9" x2="4" y2="9" />
                  <line x1="1" y1="14" x2="4" y2="14" />
                </svg>
              )}
              {action.icon === 'alert' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              )}
              {action.icon === 'server' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                  <line x1="6" y1="6" x2="6.01" y2="6" />
                  <line x1="6" y1="18" x2="6.01" y2="18" />
                </svg>
              )}
              {action.icon === 'info' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              )}
              {action.icon === 'star' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              )}
              {action.icon === 'shield' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              )}
              {action.icon === 'comment' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
              )}
              <span>{action.label}</span>
            </button>
            ))
          ) : favoritePrompts.length > 0 ? (
            favoritePrompts.slice(0, 8).map(p => (
              <button
                key={p.id}
                className="ai-side-panel-quick-action"
                onClick={() => handleQuickAction(p.prompt)}
                disabled={isAgentBusy}
                title={p.prompt}
              >
                <svg viewBox="0 0 24 24" fill={p.is_favorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <span>{p.name}</span>
              </button>
            ))
          ) : (
            <button
              className="ai-side-panel-quick-action ai-qa-add"
              onClick={() => onManagePrompts?.()}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              <span>Favorite prompts to pin them here</span>
            </button>
          )}
        </div>
      </div>
      )}

      {/* Messages */}
      <div className="ai-side-panel-messages" data-testid="ai-messages" ref={messagesRef}>
        {displayMessages
          // Hide an agent bubble while it's still empty (pre-first-token) — the
          // thinking dots cover that moment instead of a blank bubble.
          .filter(m => !(m.type === 'agent' && !m.content?.trim()))
          .map(msg => (
          <div key={msg.id} className={`ai-side-panel-message message-${msg.type}`} onContextMenu={(e) => handleMessageContextMenu(e, msg)}>
            {msg.type === 'system' && (
              <div className="ai-side-panel-system-message">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                {msg.content}
              </div>
            )}
            {msg.type === 'user' && (
              <div className="ai-side-panel-message-content">{msg.content}</div>
            )}
            {msg.type === 'agent' && (
              <div className="ai-side-panel-message-content">
                <MarkdownViewer content={msg.content} />
                {/* Streaming cursor — only on the last agent message once text
                    is actually streaming (never on an empty bubble). */}
                {isStreamingText && msg.id === lastDisplayMsg?.id && (
                  <span className="ai-streaming-cursor" />
                )}
                {scriptContext && (() => {
                  // Extract python code blocks and show "Apply to Script" buttons
                  const codeBlockRegex = /```(?:python)?\n([\s\S]*?)```/g
                  const codeBlocks: string[] = []
                  let match
                  while ((match = codeBlockRegex.exec(msg.content)) !== null) {
                    codeBlocks.push(match[1].trim())
                  }
                  if (codeBlocks.length > 0) {
                    return (
                      <div className="ai-side-panel-script-actions">
                        {codeBlocks.map((code, i) => (
                          <button
                            key={i}
                            className="ai-side-panel-apply-code-btn"
                            onClick={() => scriptContext.onApplyCode(code)}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            {codeBlocks.length === 1 ? 'Apply to Script' : `Apply Block ${i + 1}`}
                          </button>
                        ))}
                      </div>
                    )
                  }
                  return null
                })()}
              </div>
            )}
            {msg.type === 'command-request' && (
              <div className="ai-side-panel-command-message">
                <div className="ai-side-panel-command-header warning">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  <span>Command Request</span>
                  {msg.sessionName && <span className="ai-side-panel-command-session">on {msg.sessionName}</span>}
                </div>
                <code className="ai-side-panel-code command">{msg.command}</code>
                {msg.content && <div className="ai-side-panel-command-note">{msg.content}</div>}
              </div>
            )}
            {msg.type === 'command-result' && (
              <div className="ai-side-panel-command-inline">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                {msg.command && <code>{msg.command}</code>}
                {msg.sessionName && <span className="ai-cmd-session">{msg.sessionName}</span>}
              </div>
            )}
            {msg.type === 'error' && (
              <div className="ai-side-panel-error">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {msg.content}
              </div>
            )}
          </div>
        ))}

        {/* Pending Approval */}
        {pendingCommands.length > 0 && (
          <div className="ai-side-panel-pending">
            <div className="ai-side-panel-pending-header">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>Approval Required</span>
              <span className="ai-side-panel-pending-count">({pendingCommands.length})</span>
            </div>
            <div className="ai-side-panel-pending-commands">
              {pendingCommands.map(cmd => (
                <div key={cmd.id} className="ai-side-panel-pending-command">
                  <div className="ai-side-panel-pending-session">{cmd.sessionName}</div>
                  <code className="ai-side-panel-pending-code">{cmd.command}</code>
                </div>
              ))}
            </div>
            <div className="ai-side-panel-pending-buttons">
              <button className="ai-side-panel-pending-btn approve" onClick={approveCommands}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Approve{pendingCommands.length > 1 ? ' All' : ''}
              </button>
              <button className="ai-side-panel-pending-btn reject" onClick={rejectCommands}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                Reject
              </button>
            </div>
          </div>
        )}

        {/* Thinking dots — only before the reply starts streaming (so it's
            never shown alongside the streaming cursor). */}
        {isAgentBusy && !isStreamingText && (
          <div className="ai-side-panel-message assistant">
            <div className="ai-side-panel-loading">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        )}
      </div>

      {/* Input - Cursor Style */}
      <div className="ai-input-container">
        <form onSubmit={handleSubmit}>
          {/* Text Input */}
          <textarea
            ref={inputRef}
            className="ai-input-textarea" data-testid="ai-input"
            placeholder={isAgentBusy ? 'Agent is working...' : 'Describe what to troubleshoot…'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
            disabled={isAgentBusy}
            rows={isTab ? 2 : 1}
          />
          <button
            type="button"
            className="ai-input-expand"
            onClick={openPromptEditor}
            title="Expand to edit a large prompt"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13">
              <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>

          {/* Bottom Bar */}
          <div className="ai-input-bottom-bar">
            {/* Left: Selectors */}
            <div className="ai-input-selectors">
              {/* Agent Type */}
              <div className="ai-text-selector">
                <select
                  value={agentType}
                  onChange={e => {
                    const type = e.target.value as AgentType
                    setAgentType(type)
                    setPermissionMode(AGENT_TYPES[type].defaultPermissionMode)
                  }}
                  disabled={isAgentBusy}
                  title={AGENT_TYPES[agentType].description}
                >
                  {Object.values(AGENT_TYPES).map(at => (
                    <option key={at.id} value={at.id}>{modeNames[at.id]}</option>
                  ))}
                </select>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>

              {/* Provider */}
              <div className="ai-text-selector provider-selector">
                <select
                  value={selectedProvider}
                  onChange={e => setSelectedProvider(e.target.value as AiProviderType)}
                  disabled={isAgentBusy}
                >
                  {providerConfigured.anthropic && (
                    <option value="anthropic">Anthropic</option>
                  )}
                  {providerConfigured.openai && (
                    <option value="openai">OpenAI</option>
                  )}
                  {providerConfigured.openrouter && (
                    <option value="openrouter">OpenRouter</option>
                  )}
                  {providerConfigured.ollama && (
                    <option value="ollama">Ollama</option>
                  )}
                  {providerConfigured.litellm && (
                    <option value="litellm">LiteLLM</option>
                  )}
                  {providerConfigured.custom && (
                    <option value="custom">Custom</option>
                  )}
                  {!providerConfigured.anthropic && !providerConfigured.openai && !providerConfigured.openrouter && !providerConfigured.ollama && !providerConfigured.litellm && !providerConfigured.custom && (
                    <option value="" disabled>No AI</option>
                  )}
                </select>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>

              {/* Permission Mode */}
              <div className={`ai-text-selector mode-selector${permissionMode === 'yolo' ? ' yolo-active' : ''}`}>
                <select
                  value={permissionMode}
                  onChange={e => setPermissionMode(e.target.value as PermissionMode)}
                  disabled={isAgentBusy}
                  title={PERMISSION_MODES[permissionMode].description}
                >
                  {(Object.entries(PERMISSION_MODES) as [PermissionMode, { label: string }][]).map(([key, pm]) => (
                    <option key={key} value={key}>{pm.label}</option>
                  ))}
                </select>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>

              {/* Session */}
              <div className="ai-icon-selector" title={availableSessions.find(s => s.id === selectedSession)?.name || 'Select session'}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8" />
                  <path d="M12 17v4" />
                </svg>
                <select
                  value={selectedSession}
                  onChange={e => setSelectedSession(e.target.value)}
                  disabled={isAgentBusy}
                >
                  {availableSessions.length === 0 ? (
                    <option value="">No sessions</option>
                  ) : (
                    availableSessions.map(session => (
                      <option key={session.id} value={session.id}>
                        {session.name}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>

            {/* Right: Send or Stop */}
            {isAgentBusy ? (
              <button
                type="button"
                className="ai-send-btn ai-stop-btn" data-testid="ai-send"
                onClick={stopAgent}
                title="Stop generating"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                type="submit"
                className="ai-send-btn"
                disabled={!input.trim()}
                title="Send (Enter)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <path d="M22 2L11 13" />
                  <path d="M22 2L15 22L11 13L2 9L22 2Z" />
                </svg>
              </button>
            )}
          </div>
        </form>
      </div>
    </div>

    {/* Large-prompt editor bubble */}
    {promptEditorOpen && (
      <div className="ai-prompt-editor-overlay" onClick={() => setPromptEditorOpen(false)}>
        <div
          className="ai-prompt-editor"
          onClick={e => e.stopPropagation()}
          style={pePos ? { left: pePos.x, top: pePos.y } : undefined}
        >
          <div
            className="ai-prompt-editor-head"
            onPointerDown={onPeHeadDown}
            onPointerMove={onPeHeadMove}
            onPointerUp={onPeHeadUp}
          >
            <span>Edit prompt</span>
            <button
              className="ai-prompt-editor-close"
              onPointerDown={e => e.stopPropagation()}
              onClick={() => setPromptEditorOpen(false)}
              title="Close"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <textarea
            className="ai-prompt-editor-textarea"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Write or paste a long prompt…"
            autoFocus
            onKeyDown={e => {
              if ((e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
                e.preventDefault()
                setPromptEditorOpen(false)
                handleSubmit()
              }
            }}
          />
          <div className="ai-prompt-editor-actions">
            <span className="ai-prompt-editor-hint">⌘/Ctrl+Enter to send</span>
            <button className="ai-prompt-editor-btn" onClick={() => setPromptEditorOpen(false)}>Done</button>
            <button
              className="ai-prompt-editor-btn primary"
              disabled={!input.trim() || isAgentBusy}
              onClick={() => { setPromptEditorOpen(false); handleSubmit() }}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Promote to Background Task Dialog */}
    {showPromoteDialog && (
      <PromoteToTaskDialog
        messages={agentMessages}
        onClose={() => setShowPromoteDialog(false)}
        onPromote={handlePromoteToTask}
      />
    )}
    <ContextMenu position={msgContextMenu.position} items={msgContextMenu.items} onClose={msgContextMenu.close} />
    </>
  )
}

export default AISidePanel
