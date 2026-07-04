import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle, memo } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import './Terminal.css'
import { getClient } from '../api/client'
import ContextMenu, { getAIMenuItems, getDetectionMenuItems, getCustomCommandMenuItems } from './ContextMenu'
import ReconnectOverlay from './ReconnectOverlay'
import FindBar, { type SearchOptions } from './FindBar'
import { type LogFormat, processForLog } from './SessionLogging'
import { useTerminalWatcher } from '../hooks/useTerminalWatcher'
import { useDetection } from '../hooks/useDetection'
import { useCommandSafety } from '../hooks/useCommandSafety'
import type { Detection } from '../types/detection'
import type { CliFlavor } from '../types/enrichment'
import type { TerminalContext } from '../api/ai'
import InlineSuggestion from './InlineSuggestion'
import { useCommandSuggestions } from '../hooks/useCommandSuggestions'
import { useSettings } from '../hooks/useSettings'
import { getTerminalTheme } from '../lib/terminalThemes'
import { RecordingCapture } from '../api/recordings'
import { createDocument, getDocument, updateDocument, type DocumentCategory, type ContentType } from '../api/docs'
import { resolveDocSaveTarget } from '../lib/docSaveTargets'
import { showToast } from './Toast'
import { getImageFromClipboard, convertToPng, copyToClipboard, readClipboardText } from '../lib/clipboard'
import { openExternalUrl } from '../lib/openExternal'
import { LocalFileOps } from '../lib/fileOps'
import { createAgentHttpClient } from '../api/localClient'
import { HighlightEngine, type AdHocHighlight, type DetectionRuleExtras } from '../lib/highlightEngine'
import { installEnrichPopup, type EnrichPopupAPI } from '../lib/enrichPopup'
import { AnsiHighlighter } from '../lib/ansiHighlighter'
import { stripAnsi } from '../lib/ansi'
import { useHighlightRules } from '../hooks/useHighlightRules'
import { networkPreset } from '../data/highlightPresets/network'
import { useAIHighlighting } from '../hooks/useAIHighlighting'
import { getHighlightTypeColor } from '../api/ai'
import SessionContextPopup from './SessionContextPopup'
import { useSessionContext } from '../hooks/useSessionContext'
import type { SessionContext as SessionContextType } from '../types/sessionContext'
// getWsUrl replaced by getClient().wsUrlWithAuth()
import { getSession, listSessions } from '../api/sessions'
import { listMappedKeys, type MappedKey } from '../api/mappedKeys'
import { listCustomCommands, type CustomCommand } from '../api/customCommands'
import { executeQuickAction } from '../api/quickActions'
import { runScript, runScriptStream, analyzeScript, getScript, type ScriptStreamEvent } from '../api/scripts'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'
import { TracerouteParser } from '../lib/tracerouteParser'
import { displayShortcut } from '../hooks/useKeyboard'
import { CommandWarningDialog } from './CommandWarningDialog'
import { CommandWarningIndicator } from './CommandWarningIndicator'
import { useNextStepSuggestions } from '../hooks/useNextStepSuggestions'
import { NextStepSuggestions } from './NextStepSuggestions'
import InterfaceSnmpQuickLook from './InterfaceSnmpQuickLook'
import { useEnterpriseSSH } from '../hooks/useEnterpriseSSH'
import { registerDropTarget } from '../lib/tauriDragDrop'
import { useJumpboxTerminal } from '../hooks/useJumpboxTerminal'

import { getErrorMessage } from '../api/errors'
import { logger } from '../lib/logger'
interface TerminalMessage {
  type: 'Input' | 'Output' | 'Resize' | 'Close' | 'Error' | 'Connected' | 'Disconnected'
  data?: string | { cols: number; rows: number }
  session_id?: string
  reason?: string
  /** Display name of the resolved jump (jump host name or session name) for
   *  Connected messages — `undefined` for direct connections. Drives the
   *  top-right "via {jumpName}" pill. */
  via_jump?: string
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

interface TerminalProps {
  id: string
  /** Session ID for SSH connection (if not provided, opens local terminal) */
  sessionId?: string
  /** Connection protocol (ssh or telnet, default ssh) */
  protocol?: 'ssh' | 'telnet'
  /** Session name for AI context */
  sessionName?: string
  /** CLI flavor for AI command suggestions */
  cliFlavor?: CliFlavor
  /** Terminal color theme ID (null = use default) */
  terminalTheme?: string | null
  /** Terminal font size (null = use default 14) */
  fontSize?: number | null
  /** Terminal font family (null = use default monospace) */
  fontFamily?: string | null
  onClose?: () => void
  onAIAction?: (action: string, text: string, position: { x: number; y: number }, sessionId?: string, sessionName?: string) => void
  /** Open floating AI chat at a position */
  onAIFloatingChat?: (position: { x: number; y: number }, sessionId?: string, sessionName?: string, selectedText?: string) => void
  /** macOS Force Touch (force click) on the terminal → action popover. Only
   *  fires on Force Touch hardware; no-op everywhere else. `customActions` are
   *  the user's custom commands flagged "Enable in Force Touch Menu", already
   *  bound to run against the current selection. */
  onForceClick?: (text: string, position: { x: number; y: number }, sessionId?: string, sessionName?: string, customActions?: { id: string; label: string; run: () => void }[]) => void
  /** Open session settings dialog for this terminal's session */
  onSessionSettings?: () => void
  onStatusChange?: (status: ConnectionStatus) => void
  autoReconnect?: boolean
  reconnectDelay?: number
  maxReconnectAttempts?: number
  // Multi-send support
  onBroadcast?: (input: string, sourceId: string) => void
  onRegisterBroadcastListener?: (terminalId: string, listener: (input: string, sourceId: string) => void) => () => void
  /** Enable keyword highlighting (default: true) */
  highlightingEnabled?: boolean
  /** Auto copy selection to clipboard (SecureCRT-style) */
  copyOnSelect?: boolean
  /** Callback when user wants to ask AI about session context */
  onAskAIContext?: (context: SessionContextType) => void
  /** Callback when user wants to view all session contexts (open settings dialog) */
  onViewAllContexts?: () => void
  /** Callback to visualize traceroute output on topology */
  onVisualizeTraceroute?: (output: string) => void
  // Troubleshooting session capture (Phase 26)
  /** Callback for capturing commands/output to troubleshooting session */
  onTroubleshootingCapture?: (terminalId: string, terminalName: string, type: 'command' | 'output', content: string) => void
  /** Whether troubleshooting session is active for this terminal */
  isTroubleshootingActive?: boolean
  /** Whether AI Overlord mode is active for this terminal */
  aiOverlordActive?: boolean
  /** Callback when user clicks on an AI Overlord annotation to discuss with AI */
  onOverlordAnnotationClick?: (reason: string, text: string, highlightType: string) => void
  // Enterprise SSH (Phase 42)
  /** Enterprise profile ID for SSH via Controller (profile contract, Phase 8) */
  enterpriseProfileId?: string
  /** Enterprise session definition ID for tracking */
  enterpriseSessionDefinitionId?: string
  /** Target host for enterprise SSH connection */
  enterpriseTargetHost?: string
  /** Target port for enterprise SSH connection */
  enterpriseTargetPort?: number
  /** Whether this terminal is a jumpbox (enterprise Local Terminal via Docker exec) */
  isJumpbox?: boolean
  /** Workspace root path (for local workspace terminals) */
  workspaceRoot?: string
  /** Remote agent connection — when set, terminal WebSocket connects to the
   *  remote agent instead of the local sidecar. */
  remoteAgentUrl?: string
  remoteAgentToken?: string
  /** Callback when enterprise SSH session receives a session ID from the controller */
  onEnterpriseSessionId?: (sessionId: string) => void
}

/**
 * Imperative handle for Terminal component
 * Allows external code to send commands and read terminal buffer
 */
export interface TerminalHandle {
  /** Send a command to the terminal and capture output */
  sendCommand: (command: string, timeoutMs?: number) => Promise<string>
  /** Write text to the terminal without executing (no Enter appended) */
  writeText: (text: string) => void
  /** Get recent terminal output buffer. If sinceOffset provided, returns delta JSON. */
  getBuffer: (lines?: number, sinceOffset?: number) => string
  /** Check if terminal is connected */
  isConnected: () => boolean
  /** Start recording terminal session */
  startRecording: (name?: string) => Promise<string>
  /** Stop recording terminal session */
  stopRecording: () => Promise<string | null>
  /** Check if recording is active */
  isRecording: () => boolean
  /** Reconnect to the session */
  reconnect: () => void
}

const DEFAULT_RECONNECT_DELAY = 5
const DEFAULT_MAX_ATTEMPTS = 0 // 0 = infinite

/** Convert mouse coordinates to terminal cell position */
function mouseToTerminalCell(
  e: MouseEvent,
  terminal: XTerm,
  container: HTMLElement
): { col: number; row: number; absoluteLine: number } | null {
  const rect = container.querySelector('.xterm-screen')?.getBoundingClientRect()
  if (!rect) return null
  const cellWidth = rect.width / terminal.cols
  const cellHeight = rect.height / terminal.rows
  return {
    col: Math.floor((e.clientX - rect.left) / cellWidth),
    row: Math.floor((e.clientY - rect.top) / cellHeight),
    absoluteLine: terminal.buffer.active.viewportY + Math.floor((e.clientY - rect.top) / cellHeight),
  }
}


// Global registry for terminal image drop handlers.
// One shared tauriDragDrop target routes drops to the correct terminal
// by checking data-terminal-id on the matched .terminal-container element.
const terminalImageDropHandlers = new Map<string, (paths: string[]) => void>()
let terminalDropRegistered = false

function ensureTerminalDropTarget() {
  if (terminalDropRegistered) return
  terminalDropRegistered = true
  registerDropTarget({
    selector: '.terminal-container',
    onDrop: (paths: string[], matchedEl: Element) => {
      const terminalId = matchedEl.getAttribute('data-terminal-id')
      if (!terminalId) return
      const handler = terminalImageDropHandlers.get(terminalId)
      handler?.(paths)
    },
  })
}

const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({
  id,
  sessionId,
  protocol,
  sessionName,
  cliFlavor = 'auto',
  terminalTheme,
  fontSize,
  fontFamily,
  onClose,
  onAIAction,
  onAIFloatingChat,
  onForceClick,
  onSessionSettings,
  onStatusChange,
  autoReconnect = true,
  reconnectDelay = DEFAULT_RECONNECT_DELAY,
  maxReconnectAttempts = DEFAULT_MAX_ATTEMPTS,
  onBroadcast,
  onRegisterBroadcastListener,
  highlightingEnabled = true,
  copyOnSelect,
  onAskAIContext,
  onViewAllContexts,
  onVisualizeTraceroute,
  onTroubleshootingCapture,
  isTroubleshootingActive,
  enterpriseProfileId,
  enterpriseSessionDefinitionId,
  enterpriseTargetHost,
  enterpriseTargetPort,
  isJumpbox,
  workspaceRoot,
  remoteAgentUrl,
  remoteAgentToken,
  onEnterpriseSessionId,
  aiOverlordActive = false,
  onOverlordAnnotationClick,
}: TerminalProps, ref: React.ForwardedRef<TerminalHandle>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const countdownIntervalRef = useRef<number | null>(null)
  const isConnectedRef = useRef(false)
  // Track if we've ever had a successful connection (to avoid showing reconnect overlay on initial failures)
  const hasEverConnectedRef = useRef(false)
  // Flag to prevent reconnect loop when intentionally closing connection
  const isIntentionalCloseRef = useRef(false)
  // Reconnect function ref for imperative handle
  const reconnectFnRef = useRef<(() => void) | null>(null)

  // Store callbacks in refs to avoid re-running effect when they change
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onStatusChangeRef = useRef(onStatusChange)
  onStatusChangeRef.current = onStatusChange
  // Kept current so the Force Touch listener (registered once in the setup
  // effect) always sees the latest callback + session without re-running it.
  const onForceClickRef = useRef(onForceClick)
  onForceClickRef.current = onForceClick
  const sessionMetaRef = useRef({ sessionId, sessionName })
  sessionMetaRef.current = { sessionId, sessionName }
  // Builds the force-click custom actions for a given selection. Assigned later
  // in render (once the run handlers exist) so the once-registered listener can
  // call it without re-running the terminal setup effect.
  const buildForceActionsRef = useRef<(selection: string) => { id: string; label: string; run: () => void }[]>(() => [])

  // Paste-from-clipboard bound to the live terminal instance (set in the
  // terminal-creation effect; used by the context menu and middle-click).
  const pasteFromClipboardRef = useRef<() => void>(() => {})
  // Troubleshooting capture callback (Phase 26)
  const onTroubleshootingCaptureRef = useRef(onTroubleshootingCapture)
  onTroubleshootingCaptureRef.current = onTroubleshootingCapture
  const isTroubleshootingActiveRef = useRef(isTroubleshootingActive)
  isTroubleshootingActiveRef.current = isTroubleshootingActive
  const sessionNameRef = useRef(sessionName)
  sessionNameRef.current = sessionName

  // Right-click context menu state
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const [contextMenuText, setContextMenuText] = useState('')
  const [contextMenuDetection, setContextMenuDetection] = useState<Detection | null>(null)

  // SNMP Quick-Look state
  const [snmpQuickLook, setSnmpQuickLook] = useState<{
    interfaceName: string
    position: { x: number; y: number }
  } | null>(null)
  const sessionHostRef = useRef<string>('')
  const sessionProfileIdRef = useRef<string>('')
  // Jump configured for THIS session — propagated to SNMP requests so
  // they go through the bastion when the device isn't directly reachable.
  const sessionJumpHostIdRef = useRef<string | null>(null)
  const sessionJumpSessionIdRef = useRef<string | null>(null)

  // Terminal instance state for useDetection hook
  const [terminalInstance, setTerminalInstance] = useState<XTerm | null>(null)

  // Enterprise SSH state. The value isn't read yet (reserved for future
  // enterprise features); only the setter is used today.
  const [, setEnterpriseSessionId] = useState<string | null>(null)
  const [enterpriseHost, setEnterpriseHost] = useState<string>('')
  // Enterprise SSH tabs always carry a session-definition id (set on every
  // controller connect path). The profile id is now optional — agent-open
  // connects device-anchored with no profile_id — so gate on the session id,
  // which is co-extensive with the legacy credential-id gate.
  const isEnterpriseMode = Boolean(enterpriseSessionDefinitionId)
  const isJumpboxMode = Boolean(isJumpbox) && !enterpriseSessionDefinitionId && !sessionId
  const instanceName = useCapabilitiesStore((s) => s.capabilities?.instance_name) || 'Controller'

  // Reconnect state
  const [showReconnectOverlay, setShowReconnectOverlay] = useState(false)
  const [countdown, setCountdown] = useState(reconnectDelay)
  const [attemptCount, setAttemptCount] = useState(0)
  const [autoReconnectDisabled, setAutoReconnectDisabled] = useState(!autoReconnect)

  // Display name of the resolved jump for THIS connection (sent on Connected).
  // Drives the top-right "via {jumpName}" pill. `null` for direct connections.
  const [viaJumpName, setViaJumpName] = useState<string | null>(null)

  // Find bar state
  const [showFindBar, setShowFindBar] = useState(false)
  const [searchMatchCount, setSearchMatchCount] = useState(0)
  const [currentSearchMatch, setCurrentSearchMatch] = useState(0)

  // Logging state
  const [isLogging, setIsLogging] = useState(false)
  const [logFormat, setLogFormat] = useState<LogFormat>('plain')
  const [logTimestamps, setLogTimestamps] = useState(false)
  const [logFilePath, setLogFilePath] = useState<string | null>(null)
  const logBufferRef = useRef<string[]>([])
  const logFlushIntervalRef = useRef<number | null>(null)
  const logOutputRef = useRef<((data: string) => void) | null>(null)

  // Recording state (asciicast v2 format)
  const [isRecordingActive, setIsRecordingActive] = useState(false)
  const recordingCaptureRef = useRef<RecordingCapture>(new RecordingCapture())

  // Image paste state
  const imageCounterRef = useRef<number>(1)
  const workspaceRootRef = useRef<string>('')

  // Session context popup state (proactive notification on connect)
  const [showContextPopup, setShowContextPopup] = useState(false)
  const { contexts: sessionContexts, refresh: refreshSessionContexts } = useSessionContext({ sessionId: sessionId || '' })
  // Store callbacks in refs to avoid re-running effects
  const onAskAIContextRef = useRef(onAskAIContext)
  onAskAIContextRef.current = onAskAIContext
  const onViewAllContextsRef = useRef(onViewAllContexts)
  onViewAllContextsRef.current = onViewAllContexts
  const refreshSessionContextsRef = useRef(refreshSessionContexts)
  refreshSessionContextsRef.current = refreshSessionContexts

  // Highlight engine state. Color highlight rules are now rendered by ANSI
  // injection (ansiHighlighterRef) so they survive copy/reflow; the decoration
  // engine is kept only for interactive detection rules + AI ad-hoc highlights.
  const highlightEngineRef = useRef<HighlightEngine | null>(null)
  const ansiHighlighterRef = useRef<AnsiHighlighter | null>(null)
  // Hover enrichment popover (link-provider based; supersedes the old MAC/IP popup)
  const enrichPopupRef = useRef<EnrichPopupAPI | null>(null)

  // Fetch highlight rules for this terminal (with caching)
  // In enterprise mode, sessionId prop is undefined — use enterpriseSessionDefinitionId as the session key
  const effectiveSessionId = sessionId || enterpriseSessionDefinitionId || undefined
  const { rules: highlightRules, refetch: refetchHighlightRules } = useHighlightRules({
    sessionId: effectiveSessionId,
    autoFetch: highlightingEnabled,
  })
  void refetchHighlightRules // Available for future live rule updates

  // Save to docs dialog state (retroactive capture)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveDialogPath, setSaveDialogPath] = useState('')
  const [saveDialogContent, setSaveDialogContent] = useState('')
  const saveDialogInputRef = useRef<HTMLInputElement>(null)

  // Docs capture state for >> docs/path syntax
  interface CaptureConfig {
    docPath: string           // Full path like "configs/router1-config"
    mode: 'append' | 'overwrite'  // >> = append, > = overwrite
    buffer: string[]          // Captured output
    startTime: number         // For timeout tracking
    byteCount: number         // Running byte count
  }
  const [captureMode, setCaptureMode] = useState<CaptureConfig | null>(null)
  const captureTimeoutRef = useRef<number | null>(null)
  const captureModeRef = useRef<CaptureConfig | null>(null)
  const CAPTURE_TIMEOUT_MS = 60000 // Default 60s timeout
  // Keep captureModeRef in sync
  captureModeRef.current = captureMode

  // Settings
  const { settings } = useSettings()
  // Store settings in ref to avoid triggering reconnections
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // Copy on select - profile-level setting removed, use global only
  const [profileCopyOnSelect] = useState<boolean | null>(null)

  // Profile mapped keys for keyboard shortcuts
  // Note: We use a ref for fast lookup in keydown handlers; state isn't needed for rendering
  const profileMappedKeysRef = useRef<MappedKey[]>([])
  const customCommandsRef = useRef<CustomCommand[]>([])
  const [customCommandsLoaded, setCustomCommandsLoaded] = useState(false)

  // Fetch session metadata when sessionId is present
  useEffect(() => {
    if (!sessionId) return

    // In enterprise mode, use the host from props (no need to fetch)
    if (isEnterpriseMode && enterpriseTargetHost) {
      sessionHostRef.current = enterpriseTargetHost
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const session = await getSession(sessionId)
        if (cancelled) return
        // Store session host and profile_id for SNMP Quick-Look
        sessionHostRef.current = session.host
        sessionProfileIdRef.current = session.profile_id || ''
        sessionJumpHostIdRef.current = session.jump_host_id ?? null
        sessionJumpSessionIdRef.current = session.jump_session_id ?? null
      } catch (err) {
        logger.debug('Could not fetch session metadata:', err)
      }
    })()

    return () => { cancelled = true }
  }, [sessionId, isEnterpriseMode, enterpriseTargetHost])

  // Fetch global mapped keys
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const keys = await listMappedKeys()
        if (cancelled) return
        profileMappedKeysRef.current = keys
      } catch (err) {
        logger.debug('Could not fetch mapped keys:', err)
        profileMappedKeysRef.current = []
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Fetch custom commands for right-click menu
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const cmds = await listCustomCommands()
        if (cancelled) return
        customCommandsRef.current = cmds
        setCustomCommandsLoaded(true)
      } catch (err) {
        logger.debug('Could not fetch custom commands:', err)
        customCommandsRef.current = []
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Copy on select - determine from props, profile, or global settings (SecureCRT-style auto clipboard)
  // Priority: prop > profile setting > global setting
  const effectiveCopyOnSelect = copyOnSelect ?? profileCopyOnSelect ?? settings['terminal.copyOnSelect']
  const copyOnSelectRef = useRef(effectiveCopyOnSelect)
  copyOnSelectRef.current = effectiveCopyOnSelect

  // AI Highlighting - only active when Overlord is enabled
  const {
    highlights: aiHighlights,
    isAnalyzing: _isAIAnalyzing,
    addOutput: addAIOutput,
    clear: clearAIHighlights,
  } = useAIHighlighting({
    enabled: aiOverlordActive,
    cliFlavor,
    debounceMs: 1500,
    provider: settings['ai.overlord.provider'],
    model: settings['ai.overlord.model'],
  })
  void _isAIAnalyzing // Available for future use (e.g., status indicator)

  // Command autocomplete state
  const { suggestions, isLoading: isLoadingSuggestions, fetchSuggestions, clear: clearSuggestions } = useCommandSuggestions()
  const [currentInput, setCurrentInput] = useState('')
  const [cursorPosition, setCursorPosition] = useState({ x: 0, y: 0 })
  // Store in refs to avoid triggering reconnections
  const fetchSuggestionsRef = useRef(fetchSuggestions)
  fetchSuggestionsRef.current = fetchSuggestions
  const clearSuggestionsRef = useRef(clearSuggestions)
  clearSuggestionsRef.current = clearSuggestions
  const cliFlavorRef = useRef(cliFlavor)
  cliFlavorRef.current = cliFlavor

  // Terminal watcher for AI context
  const terminalWatcher = useTerminalWatcher({
    bufferLines: 50,
  })
  // Store terminalWatcher in ref to avoid re-creating connect function
  const terminalWatcherRef = useRef(terminalWatcher)
  terminalWatcherRef.current = terminalWatcher

  // Get terminal context for AI features (use ref to avoid dependency issues)
  const _getTerminalContext = useCallback((): TerminalContext => {
    return terminalWatcherRef.current.getContext()
  }, [])
  void _getTerminalContext // Exported via imperative handle

  // Detection engine for network identifiers (IPs, MACs, hostnames, etc.)
  // This hook is a pure metadata provider — decorations are handled by the HighlightEngine
  const { getDetectionAt, setCustomRegexPatterns } = useDetection(terminalInstance)
  const getDetectionAtRef = useRef(getDetectionAt)
  getDetectionAtRef.current = getDetectionAt

  // Register custom regex patterns from custom commands into the detection engine
  useEffect(() => {
    if (!customCommandsLoaded) return
    const cmds = customCommandsRef.current
    const regexPatterns: { typeKey: string; pattern: string; name: string }[] = []
    for (const cmd of cmds) {
      if (!cmd.enabled || !cmd.detection_types) continue
      try {
        const types: string[] = JSON.parse(cmd.detection_types)
        for (const t of types) {
          if (t.startsWith('regex:')) {
            regexPatterns.push({ typeKey: t, pattern: t.slice(6), name: cmd.name })
          }
        }
      } catch { /* ignore */ }
    }
    setCustomRegexPatterns(regexPatterns)
  }, [customCommandsLoaded, setCustomRegexPatterns])

  // Command safety analysis for dangerous command warnings
  const {
    currentAnalysis: safetyAnalysis,
    pendingAnalysis: pendingSafetyAnalysis,
    analyzeCommand: analyzeSafetyCommand,
    checkBeforeSend: checkSafetyBeforeSend,
    clearPending: clearSafetyPending,
    setPending: setSafetyPending,
  } = useCommandSafety({
    cliFlavor: cliFlavor,
    deviceHostname: sessionName,
    enabled: settings['commandSafety.enabled'] ?? true,
  })
  // Store in refs to avoid triggering reconnections
  const analyzeSafetyCommandRef = useRef(analyzeSafetyCommand)
  analyzeSafetyCommandRef.current = analyzeSafetyCommand
  const checkSafetyBeforeSendRef = useRef(checkSafetyBeforeSend)
  checkSafetyBeforeSendRef.current = checkSafetyBeforeSend
  const setSafetyPendingRef = useRef(setSafetyPending)
  setSafetyPendingRef.current = setSafetyPending

  // Next-step suggestions (Phase 24: AI-powered contextual suggestions)
  const {
    suggestions: nextStepSuggestions,
    loading: nextStepLoading,
    generateSuggestions: generateNextStepSuggestions,
    clearSuggestions: clearNextStepSuggestions,
    useSuggestion: useNextStepSuggestion,
    setSuggestionCallback: setNextStepCallback,
  } = useNextStepSuggestions({
    enabled: settings['ai.nextStepSuggestions'] ?? true,
  })
  const [showNextStepSuggestions, setShowNextStepSuggestions] = useState(false)
  // Track last executed command for suggestions
  const lastCommandRef = useRef<string>('')
  // Track recent output for prompt detection
  const recentOutputRef = useRef<string>('')
  // Store in refs to avoid triggering reconnections
  const generateNextStepSuggestionsRef = useRef(generateNextStepSuggestions)
  generateNextStepSuggestionsRef.current = generateNextStepSuggestions
  const clearNextStepSuggestionsRef = useRef(clearNextStepSuggestions)
  clearNextStepSuggestionsRef.current = clearNextStepSuggestions

  // Expose imperative handle for external command execution (AI agent)
  useImperativeHandle(ref, () => ({
    sendCommand: async (command: string, timeoutMs: number = 5000): Promise<string> => {
      return new Promise((resolve, reject) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          reject(new Error('Terminal not connected'))
          return
        }

        // Capture output starting now
        const outputBuffer: string[] = []
        const startTime = Date.now()

        // Create a temporary listener to capture output
        const originalOnMessage = wsRef.current.onmessage
        const ws = wsRef.current
        wsRef.current.onmessage = (event) => {
          // Call original handler first
          if (originalOnMessage && ws) {
            originalOnMessage.call(ws, event)
          }

          try {
            const msg: TerminalMessage = JSON.parse(event.data)
            if (msg.type === 'Output' && typeof msg.data === 'string') {
              outputBuffer.push(msg.data)
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Send command + Enter
        wsRef.current.send(JSON.stringify({
          type: 'Input',
          data: command + '\r'
        }))

        // Wait for timeout then return captured output
        const checkComplete = () => {
          const elapsed = Date.now() - startTime

          // Check if we've received output and had a quiet period (100ms no new data)
          // or if timeout reached
          if (elapsed >= timeoutMs) {
            // Restore original handler
            if (wsRef.current) {
              wsRef.current.onmessage = originalOnMessage
            }
            resolve(outputBuffer.join(''))
          } else {
            setTimeout(checkComplete, 100)
          }
        }

        setTimeout(checkComplete, 100)
      })
    },

    writeText: (text: string): void => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'Input', data: text }))
      }
    },

    getBuffer: (lines: number = 50, sinceOffset?: number): string => {
      if (sinceOffset !== undefined) {
        const delta = terminalWatcherRef.current.getContextSince(sinceOffset)
        return JSON.stringify(delta)
      }
      const context = terminalWatcherRef.current.getContext()
      const recentOutput = context.recentOutput || ''
      const allLines = recentOutput.split('\n')
      return JSON.stringify({
        recentOutput: stripAnsi(allLines.slice(-lines).join('\n')),
        offset: terminalWatcherRef.current.getCurrentOffset(),
        totalLines: Math.min(lines, allLines.length),
      })
    },

    isConnected: (): boolean => {
      return isConnectedRef.current
    },

    startRecording: async (name?: string): Promise<string> => {
      if (recordingCaptureRef.current.recording) {
        throw new Error('Recording already in progress')
      }
      const terminal = terminalRef.current
      if (!terminal) {
        throw new Error('Terminal not initialized')
      }
      const recordingName = name || `Recording ${new Date().toLocaleString()}`
      const recordingId = await recordingCaptureRef.current.start(
        recordingName,
        terminal.cols,
        terminal.rows,
        sessionId
      )
      setIsRecordingActive(true)
      return recordingId
    },

    stopRecording: async (): Promise<string | null> => {
      const recordingId = await recordingCaptureRef.current.stop()
      setIsRecordingActive(false)
      return recordingId
    },

    isRecording: (): boolean => {
      return recordingCaptureRef.current.recording
    },

    reconnect: (): void => {
      if (reconnectFnRef.current) {
        reconnectFnRef.current()
      }
    }
  }), [sessionId])

  const handleResize = useCallback(() => {
    if (fitAddonRef.current && terminalRef.current) {
      try {
        fitAddonRef.current.fit()
        // Send resize to backend
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const { cols, rows } = terminalRef.current
          wsRef.current.send(JSON.stringify({
            type: 'Resize',
            data: { cols, rows }
          }))
        }
      } catch {
        // Ignore fit errors during initialization
      }
    }
  }, [])

  // Clear countdown interval
  const clearCountdownInterval = useCallback(() => {
    if (countdownIntervalRef.current) {
      window.clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
  }, [])

  // Enterprise SSH connection (conditional hook usage)
  // This hook is only active for enterprise (controller-managed) sessions.
  // profileId may be empty (agent-open / device-anchored) → controller resolves
  // the device's default profile.
  // eslint-disable-next-line react-hooks/rules-of-hooks -- isEnterpriseMode is fixed for this terminal's lifetime, so hook order is stable across renders (deliberate).
  const enterpriseSSH = isEnterpriseMode ? useEnterpriseSSH({
    profileId: enterpriseProfileId ?? '',
    sessionDefinitionId: enterpriseSessionDefinitionId,
    host: enterpriseTargetHost,
    port: enterpriseTargetPort,
    cols: fitAddonRef.current ? terminalRef.current?.cols || 80 : 80,
    rows: fitAddonRef.current ? terminalRef.current?.rows || 24 : 24,
    autoReconnect,
    maxReconnectAttempts,
    onData: (data) => {
      if (terminalRef.current) {
        terminalRef.current.write(ansiHighlighterRef.current?.process(data) ?? data)
        // Log output if logging is active
        logOutputRef.current?.(data)
        // Feed output to terminal watcher for AI context
        terminalWatcherRef.current.addOutput(data)
        // Feed output to AI highlighting only after user pressed Enter
        if (aiCommandSentRef.current) {
          addAIOutputRef.current?.(data)
        }
        // Track recent output for next-step suggestions
        recentOutputRef.current += data
        if (recentOutputRef.current.length > 2000) {
          recentOutputRef.current = recentOutputRef.current.slice(-2000)
        }
        // Capture for troubleshooting (use tab id for consistent matching)
        if (isTroubleshootingActiveRef.current && onTroubleshootingCaptureRef.current) {
          onTroubleshootingCaptureRef.current(id, sessionNameRef.current || 'Terminal', 'output', data)
        }
      }
    },
    onConnected: (sshSessionId) => {
      logger.log('[Enterprise SSH] Connected, session ID:', sshSessionId)
      setEnterpriseSessionId(sshSessionId)
      onEnterpriseSessionId?.(sshSessionId)
      isConnectedRef.current = true
      hasEverConnectedRef.current = true
      onStatusChangeRef.current?.('connected')
      setShowReconnectOverlay(false)
      setAttemptCount(0)
      // Write connection status message to terminal
      if (terminalRef.current && enterpriseHost) {
        terminalRef.current.writeln(`\r\n\x1b[32mConnected to ${enterpriseHost} via Controller\x1b[0m\r\n`)
      }
      // Focus terminal so keyboard input works
      terminalRef.current?.focus()
    },
    onDisconnected: (reason) => {
      logger.log('[Enterprise SSH] Disconnected:', reason)
      isConnectedRef.current = false
      onStatusChangeRef.current?.('disconnected')
      if (terminalRef.current) {
        terminalRef.current.writeln(`\r\n\x1b[31mDisconnected: ${reason}\x1b[0m\r\n`)
      }
      if (hasEverConnectedRef.current && !autoReconnectDisabled) {
        setShowReconnectOverlay(true)
      }
    },
    onReconnecting: (attempt, delay) => {
      logger.log(`[Enterprise SSH] Reconnecting attempt ${attempt}, delay ${delay}ms`)
      setAttemptCount(attempt)
      setCountdown(Math.ceil(delay / 1000))
      // Only show overlay if we've had a successful connection before —
      // don't flash "Connection Lost" during initial connection (React Strict Mode
      // double-mount causes a harmless disconnect before first connect succeeds)
      if (hasEverConnectedRef.current) {
        setShowReconnectOverlay(true)
      }
    },
    onReconnectFailed: () => {
      logger.log('[Enterprise SSH] Max reconnection attempts reached')
      if (terminalRef.current) {
        terminalRef.current.writeln(`\r\n\x1b[31mSession ended\x1b[0m\r\n`)
      }
    },
    onError: (message) => {
      console.error('[Enterprise SSH] Error:', message)
      if (terminalRef.current) {
        // Check for common auth failures
        if (message.toLowerCase().includes('auth')) {
          terminalRef.current.writeln(`\r\n\x1b[31mAuthentication failed — check credentials with your administrator\x1b[0m\r\n`)
        } else {
          terminalRef.current.writeln(`\r\n\x1b[31mError: ${message}\x1b[0m\r\n`)
        }
      }
    },
  }) : null

  // Jumpbox terminal connection (conditional hook usage)
  // This hook is only active when isJumpbox is true and no enterprise credential/session
  // eslint-disable-next-line react-hooks/rules-of-hooks -- isJumpboxMode is fixed for this terminal's lifetime, so hook order is stable across renders (deliberate).
  const jumpboxTerminal = isJumpboxMode ? useJumpboxTerminal({
    cols: fitAddonRef.current ? terminalRef.current?.cols || 80 : 80,
    rows: fitAddonRef.current ? terminalRef.current?.rows || 24 : 24,
    onData: (data) => {
      if (terminalRef.current) {
        terminalRef.current.write(ansiHighlighterRef.current?.process(data) ?? data)
        logOutputRef.current?.(data)
        terminalWatcherRef.current.addOutput(data)
        if (aiCommandSentRef.current) {
          addAIOutputRef.current?.(data)
        }
        recentOutputRef.current += data
        if (recentOutputRef.current.length > 2000) {
          recentOutputRef.current = recentOutputRef.current.slice(-2000)
        }
        if (isTroubleshootingActiveRef.current && onTroubleshootingCaptureRef.current) {
          onTroubleshootingCaptureRef.current(id, sessionNameRef.current || 'Terminal', 'output', data)
        }
      }
    },
    onConnected: (jumpboxSessionId) => {
      logger.log('[Jumpbox] Connected, session ID:', jumpboxSessionId)
      isConnectedRef.current = true
      hasEverConnectedRef.current = true
      onStatusChangeRef.current?.('connected')
      setShowReconnectOverlay(false)
      if (terminalRef.current) {
        terminalRef.current.writeln(`\r\n\x1b[32mJumpbox terminal ready\x1b[0m\r\n`)
      }
      terminalRef.current?.focus()
    },
    onDisconnected: (reason) => {
      logger.log('[Jumpbox] Disconnected:', reason)
      isConnectedRef.current = false
      onStatusChangeRef.current?.('disconnected')
      if (terminalRef.current) {
        terminalRef.current.writeln(`\r\n\x1b[31mDisconnected: ${reason}\x1b[0m\r\n`)
      }
    },
    onError: (message) => {
      console.error('[Jumpbox] Error:', message)
      if (terminalRef.current) {
        terminalRef.current.writeln(`\r\n\x1b[31mError: ${message}\x1b[0m\r\n`)
      }
    },
  }) : null

  // Stable refs for enterprise SSH functions (avoids re-subscribing on every render)
  const enterpriseSendDataRef = useRef<((data: string) => void) | null>(null)
  const enterpriseSendResizeRef = useRef<((cols: number, rows: number) => void) | null>(null)
  const enterpriseReconnectRef = useRef<(() => void) | null>(null)
  enterpriseSendDataRef.current = enterpriseSSH?.sendData ?? null
  enterpriseSendResizeRef.current = enterpriseSSH?.sendResize ?? null
  enterpriseReconnectRef.current = enterpriseSSH?.reconnect ?? null

  // Stable refs for jumpbox functions
  const jumpboxSendDataRef = useRef<((data: string) => void) | null>(null)
  const jumpboxSendResizeRef = useRef<((cols: number, rows: number) => void) | null>(null)
  const jumpboxReconnectRef = useRef<(() => void) | null>(null)
  jumpboxSendDataRef.current = jumpboxTerminal?.sendData ?? null
  jumpboxSendResizeRef.current = jumpboxTerminal?.sendResize ?? null
  jumpboxReconnectRef.current = jumpboxTerminal?.reconnect ?? null

  // Sync workspaceRoot prop to ref for use in paste handler
  useEffect(() => {
    if (workspaceRoot) workspaceRootRef.current = workspaceRoot
  }, [workspaceRoot])

  // Build a FileOps client that targets the workspace's agent. For remote
  // workspaces the screenshot lives on the remote box, so we must talk to
  // the remote agent — using the local default would write to the wrong host.
  const makeWorkspaceFileOps = useCallback(() => {
    if (remoteAgentUrl && remoteAgentToken) {
      return new LocalFileOps(createAgentHttpClient(remoteAgentUrl, remoteAgentToken))
    }
    return new LocalFileOps()
  }, [remoteAgentUrl, remoteAgentToken])

  // Initialize image counter from existing screenshot files
  useEffect(() => {
    if (!workspaceRoot) return
    const localFileOps = makeWorkspaceFileOps()
    const sep = workspaceRoot.includes('/') ? '/' : '\\'
    const screenshotsDir = `${workspaceRoot}${sep}.netstacks${sep}screenshots`
    localFileOps.readDir(screenshotsDir).then((entries) => {
      let maxN = 0
      for (const entry of entries) {
        const match = entry.name.match(/^(\d+)\.png$/)
        if (match) {
          const n = parseInt(match[1], 10)
          if (n > maxN) maxN = n
        }
      }
      imageCounterRef.current = maxN + 1
    }).catch(() => {
      imageCounterRef.current = 1
    })
  }, [workspaceRoot, makeWorkspaceFileOps])

  // Shared image save + token injection logic (used by paste, DOM drop, and Tauri drop)
  const handleImageDropRef = useRef<((imageBlob: Blob) => Promise<void>) | undefined>(undefined)
  handleImageDropRef.current = async (imageBlob: Blob) => {
    try {
      const pngData = await convertToPng(imageBlob)
      const n = imageCounterRef.current

      const isLocal = !sessionId && !enterpriseSessionDefinitionId && !isJumpbox
      let savedPath: string

      if (isLocal) {
        const wsRoot = workspaceRootRef.current
        if (wsRoot) {
          const sep = wsRoot.includes('/') ? '/' : '\\'
          savedPath = `${wsRoot}${sep}.netstacks${sep}screenshots${sep}${n}.png`
        } else {
          savedPath = `/tmp/netstacks-screenshots/${n}.png`
        }
        const localFileOps = makeWorkspaceFileOps()
        await localFileOps.writeFileBinary(savedPath, pngData)
      } else {
        savedPath = `/tmp/netstacks-screenshots/${n}.png`

        let binary = ''
        const chunkSize = 8192
        for (let i = 0; i < pngData.length; i += chunkSize) {
          binary += String.fromCharCode(...pngData.subarray(i, i + chunkSize))
        }
        const b64 = btoa(binary)

        const cmd = `stty -echo 2>/dev/null; mkdir -p /tmp/netstacks-screenshots && printf '%s' '${b64}' | base64 -d > "${savedPath}" && stty echo 2>/dev/null\r`

        if (enterpriseSendDataRef.current) {
          enterpriseSendDataRef.current(cmd)
        } else if (jumpboxSendDataRef.current) {
          jumpboxSendDataRef.current(cmd)
        } else if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'Input', data: cmd }))
        }

        await new Promise(resolve => setTimeout(resolve, 500))
      }

      // Write just the path into the terminal input (no Enter).
      // CLI tools like Claude Code detect image paths and handle them
      // natively; for a plain shell the path is ready to use in a command.
      const input = savedPath + ' '
      if (enterpriseSendDataRef.current) {
        enterpriseSendDataRef.current(input)
      } else if (jumpboxSendDataRef.current) {
        jumpboxSendDataRef.current(input)
      } else if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'Input', data: input }))
      }

      imageCounterRef.current = n + 1
      showToast(`Screenshot saved to ${savedPath}`, 'success')
    } catch (err) {
      console.error('Failed to save pasted image:', err)
      showToast('Failed to save screenshot', 'error')
    }
  }

  // Tauri native file drop handler — register/unregister in the global map.
  // Uses a single shared tauriDragDrop registration for all terminals,
  // routing by data-terminal-id on the matched element.
  useEffect(() => {
    const handler = async (paths: string[]) => {
      const imagePath = paths.find(p => /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(p))
      if (!imagePath) return
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const bytes = await invoke<number[] | Uint8Array>('read_dropped_file', { path: imagePath })
        const u8 = new Uint8Array(bytes)
        const blob = new Blob([u8], { type: 'image/png' })
        handleImageDropRef.current?.(blob)
      } catch (err) {
        console.error('Failed to read dropped image:', err)
        showToast('Failed to read dropped image', 'error')
      }
    }
    terminalImageDropHandlers.set(id, handler)
    ensureTerminalDropTarget()
    return () => { terminalImageDropHandlers.delete(id) }
  }, [id])

  // Enterprise SSH resize handler
  useEffect(() => {
    if (isEnterpriseMode && terminalInstance) {
      const disposable = terminalInstance.onResize(() => {
        if (fitAddonRef.current && enterpriseSendResizeRef.current) {
          enterpriseSendResizeRef.current(terminalInstance.cols, terminalInstance.rows)
        }
      })
      return () => disposable.dispose()
    }
  }, [isEnterpriseMode, terminalInstance])

  // Enterprise SSH terminal input handler
  useEffect(() => {
    if (isEnterpriseMode && terminalInstance) {
      const disposable = terminalInstance.onData((data) => {
        // Auto-reconnect on keypress if disconnected
        if (!isConnectedRef.current) {
          reconnectFnRef.current?.()
          return
        }
        // Gate AI Overlord: mark command sent on Enter, clear on typing
        aiCommandSentRef.current = (data === '\r' || data === '\n')
        enterpriseSendDataRef.current?.(data)
        // Capture for troubleshooting
        if (isTroubleshootingActiveRef.current && onTroubleshootingCaptureRef.current) {
          onTroubleshootingCaptureRef.current(id, sessionNameRef.current || 'Terminal', 'command', data)
        }
      })
      return () => disposable.dispose()
    }
  }, [isEnterpriseMode, terminalInstance, id])

  // Jumpbox resize handler
  useEffect(() => {
    if (isJumpboxMode && terminalInstance) {
      const disposable = terminalInstance.onResize(() => {
        if (fitAddonRef.current && jumpboxSendResizeRef.current) {
          jumpboxSendResizeRef.current(terminalInstance.cols, terminalInstance.rows)
        }
      })
      return () => disposable.dispose()
    }
  }, [isJumpboxMode, terminalInstance])

  // Jumpbox terminal input handler
  useEffect(() => {
    if (isJumpboxMode && terminalInstance) {
      const disposable = terminalInstance.onData((data) => {
        // Gate AI Overlord: mark command sent on Enter, clear on typing
        aiCommandSentRef.current = (data === '\r' || data === '\n')
        jumpboxSendDataRef.current?.(data)
        if (isTroubleshootingActiveRef.current && onTroubleshootingCaptureRef.current) {
          onTroubleshootingCaptureRef.current(id, sessionNameRef.current || 'Terminal', 'command', data)
        }
      })
      return () => disposable.dispose()
    }
  }, [isJumpboxMode, terminalInstance, id])

  // Update reconnect function ref for enterprise mode
  useEffect(() => {
    if (isEnterpriseMode) {
      reconnectFnRef.current = () => {
        logger.log('[Enterprise SSH] Manual reconnect triggered')
        setShowReconnectOverlay(false)
        enterpriseReconnectRef.current?.()
      }
    }
  }, [isEnterpriseMode])

  // Update reconnect function ref for jumpbox mode
  useEffect(() => {
    if (isJumpboxMode) {
      reconnectFnRef.current = () => {
        logger.log('[Jumpbox] Manual reconnect triggered')
        jumpboxReconnectRef.current?.()
      }
    }
  }, [isJumpboxMode])

  // Show connecting message for enterprise SSH
  useEffect(() => {
    if (isEnterpriseMode && terminalRef.current && enterpriseHost) {
      terminalRef.current.writeln(`\x1b[2mConnecting to ${enterpriseHost}...\x1b[0m`)
    }
  }, [isEnterpriseMode, enterpriseHost])

  // Show connecting message for jumpbox
  useEffect(() => {
    if (isJumpboxMode && terminalRef.current) {
      terminalRef.current.writeln(`\x1b[2mStarting jumpbox container...\x1b[0m`)
    }
  }, [isJumpboxMode])

  // Fetch enterprise session host for display
  useEffect(() => {
    if (isEnterpriseMode && enterpriseSessionDefinitionId && !enterpriseHost) {
      // Try to get host from session name if available
      if (sessionName && sessionName.includes('@')) {
        const host = sessionName.split('@')[1]
        setEnterpriseHost(host || 'remote host')
      } else {
        setEnterpriseHost('remote host')
      }
    }
  }, [isEnterpriseMode, enterpriseSessionDefinitionId, sessionName, enterpriseHost])

  // Connect to WebSocket (Personal mode only)
  const connect = useCallback(() => {
    // Skip if in enterprise mode - useEnterpriseSSH handles connection
    if (isEnterpriseMode) return
    // Skip if in jumpbox mode - useJumpboxTerminal handles connection
    if (isJumpboxMode) return
    if (!terminalRef.current) return

    const terminal = terminalRef.current

    // Check if there's an existing WebSocket that's still connecting or open
    // This handles React Strict Mode's double-invoke - the second mount should
    // not create a new connection if one is already in progress
    if (wsRef.current) {
      const state = wsRef.current.readyState
      if (state === WebSocket.CONNECTING) {
        logger.log('WebSocket already connecting, skipping')
        return
      }
      if (state === WebSocket.OPEN) {
        logger.log('WebSocket already open, skipping')
        return
      }
      // WebSocket is CLOSING or CLOSED, close it and create new one
      isIntentionalCloseRef.current = true
      wsRef.current.close()
    }

    // Defer status change to avoid React state update during render
    queueMicrotask(() => {
      onStatusChangeRef.current?.('connecting')
    })
    setShowReconnectOverlay(false)
    clearCountdownInterval()

    // Build WebSocket URL with connection type and session ID
    const params = new URLSearchParams()
    if (sessionId) {
      params.set('type', protocol || 'ssh')
      params.set('session_id', sessionId)
    } else {
      params.set('type', 'local')
    }
    // Send initial PTY dimensions so the remote shell starts at the correct size
    // (avoids garbled display in full-screen apps like vim/nano)
    if (terminalRef.current) {
      if (fitAddonRef.current) {
        try { fitAddonRef.current.fit() } catch { /* ignore during init */ }
      }
      params.set('cols', String(terminalRef.current.cols))
      params.set('rows', String(terminalRef.current.rows))
    }
    // Use remote agent URL if available, otherwise local sidecar
    let wsUrl: string
    if (remoteAgentUrl && remoteAgentToken) {
      const base = remoteAgentUrl.replace(/^https?:/, 'wss:')
      wsUrl = `${base}/ws/terminal?${params.toString()}&token=${encodeURIComponent(remoteAgentToken)}`
    } else {
      wsUrl = getClient().wsUrlWithAuth(`/ws/terminal?${params.toString()}`)
    }
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      logger.log('Terminal WebSocket opened')
      // For local terminals, mark connected immediately
      // For SSH, wait for Connected message from server (after successful auth)
      if (!sessionId) {
        isConnectedRef.current = true
        hasEverConnectedRef.current = true
        onStatusChangeRef.current?.('connected')
        setShowReconnectOverlay(false)
        setAttemptCount(0)
        setCountdown(reconnectDelay)
      }
      // Send initial resize
      handleResize()
    }

    ws.onmessage = (event) => {
      try {
        const msg: TerminalMessage = JSON.parse(event.data)
        switch (msg.type) {
          case 'Connected':
            // SSH connection established successfully
            logger.log('SSH connection established')
            isConnectedRef.current = true
            hasEverConnectedRef.current = true
            onStatusChangeRef.current?.('connected')
            setShowReconnectOverlay(false)
            setAttemptCount(0)
            setCountdown(reconnectDelay)
            // Capture the resolved jump for the "via X" pill (null = direct).
            setViaJumpName(typeof msg.via_jump === 'string' ? msg.via_jump : null)
            // Re-send the actual terminal size now that the DOM is laid out.
            // The initial size in the WS query string can be stale because
            // fit() runs synchronously before measurement is complete; if the
            // server-side TTY is sized wrong, TUIs (e.g. Ink-based CLIs) emit
            // cursor-positioning escapes that land off-by-N cells.
            handleResize()
            // Fetch session context and show popup if any exists
            if (sessionId) {
              refreshSessionContextsRef.current().then((contexts) => {
                if (contexts && contexts.length > 0) {
                  setShowContextPopup(true)
                }
              }).catch((err) => {
                console.error('Failed to fetch session context:', err)
              })
            }
            break
          case 'Output':
            if (typeof msg.data === 'string') {
              // Inject ANSI color codes for keyword highlight rules before
              // xterm parses the chunk (durable coloring; survives copy/reflow).
              terminal.write(ansiHighlighterRef.current?.process(msg.data) ?? msg.data)
              // If we receive output but connection wasn't marked as connected,
              // update status (handles race condition where Connected message was missed)
              if (!isConnectedRef.current) {
                logger.log('Received output while not connected - updating status to connected')
                isConnectedRef.current = true
                hasEverConnectedRef.current = true
                onStatusChangeRef.current?.('connected')
                setShowReconnectOverlay(false)
                setAttemptCount(0)
                setCountdown(reconnectDelay)
                clearCountdownInterval()
              }
              // Log output if logging is active
              logOutputRef.current?.(msg.data)
              // Feed output to terminal watcher for AI context
              terminalWatcherRef.current.addOutput(msg.data)
              // Add to capture buffer if in capture mode
              if (captureModeRef.current) {
                addToCaptureBufferRef.current(msg.data)
              }
              // Capture output for recording (asciicast format)
              if (recordingCaptureRef.current.recording) {
                recordingCaptureRef.current.addOutput(msg.data)
              }
              // Capture output for troubleshooting session (Phase 26)
              if (isTroubleshootingActiveRef.current && onTroubleshootingCaptureRef.current) {
                onTroubleshootingCaptureRef.current(
                  sessionId || id,
                  sessionNameRef.current || 'Terminal',
                  'output',
                  msg.data
                )
              }
              // Feed output to AI highlighting only after user pressed Enter
              if (aiCommandSentRef.current) {
                addAIOutputRef.current?.(msg.data)
              }
              // Track recent output for next-step suggestions
              recentOutputRef.current += msg.data
              // Keep only last 2000 chars to prevent memory bloat
              if (recentOutputRef.current.length > 2000) {
                recentOutputRef.current = recentOutputRef.current.slice(-2000)
              }
              // Check if command completed (detect prompt patterns)
              // Common patterns: $ # > (hostname)# (hostname)> etc.
              const promptPatterns = [
                /[$#>]\s*$/,                        // Common Unix/Cisco prompts
                /\(config[^)]*\)#\s*$/,             // Cisco config mode
                /\S+[#>]\s*$/,                      // hostname# or hostname>
                /%\s*$/,                            // csh/tcsh prompt
              ]
              const recentLines = recentOutputRef.current.split('\n')
              const lastLine = recentLines[recentLines.length - 1] || ''
              const hasPrompt = promptPatterns.some(p => p.test(lastLine))

              // If prompt detected and we have a last command, generate suggestions
              if (hasPrompt && lastCommandRef.current && settingsRef.current['ai.nextStepSuggestions'] !== false) {
                // Build context for suggestions
                const context = {
                  terminal: terminalWatcherRef.current.getContext(),
                  cliFlavor: cliFlavorRef.current,
                }
                generateNextStepSuggestionsRef.current(
                  lastCommandRef.current,
                  recentOutputRef.current,
                  context
                )
                setShowNextStepSuggestions(true)
                // Clear last command so we don't re-trigger
                lastCommandRef.current = ''
                // Clear recent output
                recentOutputRef.current = ''
              }
            }
            break
          case 'Disconnected':
            terminal.writeln(`\r\n\x1b[31mDisconnected: ${msg.reason || 'Connection closed'}\x1b[0m`)
            break
          case 'Close':
            terminal.writeln('\r\n\x1b[31mConnection closed\x1b[0m')
            onCloseRef.current?.()
            break
          case 'Error':
            if (typeof msg.data === 'string') {
              terminal.writeln(`\r\n\x1b[31mError: ${msg.data}\x1b[0m`)
            }
            break
        }
      } catch (e) {
        console.error('Failed to parse terminal message:', e)
      }
    }

    ws.onerror = (error) => {
      if (isIntentionalCloseRef.current) return
      console.error('Terminal WebSocket error:', error)
      onStatusChangeRef.current?.('error')
      terminal.writeln('\r\n\x1b[31mWebSocket error\x1b[0m')
    }

    ws.onclose = () => {
      logger.log('Terminal WebSocket closed')
      const wasConnected = isConnectedRef.current
      isConnectedRef.current = false

      // If this was an intentional close (reconnecting), don't trigger reconnect logic
      if (isIntentionalCloseRef.current) {
        isIntentionalCloseRef.current = false
        return
      }

      onStatusChangeRef.current?.('disconnected')

      // Only show reconnect overlay if we've had a successful connection before
      // This prevents the overlay from flashing during initial connection attempts
      if (hasEverConnectedRef.current && wasConnected && !autoReconnectDisabled) {
        setShowReconnectOverlay(true)
        startReconnectCountdown()
      } else if (hasEverConnectedRef.current && wasConnected) {
        setShowReconnectOverlay(true)
      }
    }

    // Handle terminal input
    const dataDisposable = terminal.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reconnectFnRef.current?.()
        return
      }

      // Gate AI Overlord: mark command sent on Enter, clear on typing
      if (data === '\r' || data === '\n') {
        aiCommandSentRef.current = true
      } else {
        aiCommandSentRef.current = false
      }

      // Track command line buffer for capture syntax detection
      // This must happen BEFORE sending data to handle suffix syntax interception
      if (data === '\r' || data === '\n') {
        // Enter pressed - check for capture syntax
        const cmdLine = commandLineBufferRef.current.trim()
        const captureConfig = parseCaptureSyntaxRef.current(cmdLine)
        if (captureConfig) {
          // Start capture mode
          startCaptureRef.current(captureConfig.docPath, captureConfig.mode)

          // If suffix syntax was used (command |> docs/path), we need to:
          // 1. Clear the line already typed on the device (Ctrl+U)
          // 2. Send only the actual command (without the |> docs/... part)
          if (captureConfig.command) {
            // Clear the current line on the device (Ctrl+U works on most shells/network devices)
            ws.send(JSON.stringify({ type: 'Input', data: '\x15' }))
            // Small delay to let the clear take effect, then send actual command
            setTimeout(() => {
              ws.send(JSON.stringify({ type: 'Input', data: captureConfig.command + '\r' }))
            }, 50)
            commandLineBufferRef.current = ''
            // Don't send the original Enter or broadcast - we're handling it ourselves
            return
          }
        }

        // Check command safety before sending (Phase 24: Smart Warnings)
        if (cmdLine) {
          const { shouldWarn, analysis } = checkSafetyBeforeSendRef.current(cmdLine)
          if (shouldWarn) {
            // Store the pending command and show dialog
            setSafetyPendingRef.current(analysis)
            // Don't send yet - wait for user decision
            return
          }
        }

        // Save last command for next-step suggestions (Phase 24)
        if (cmdLine) {
          lastCommandRef.current = cmdLine
          // Clear recent output buffer to start fresh for this command
          recentOutputRef.current = ''
          // Capture command for troubleshooting session (Phase 26)
          if (isTroubleshootingActiveRef.current && onTroubleshootingCaptureRef.current) {
            onTroubleshootingCaptureRef.current(
              sessionId || id,
              sessionNameRef.current || 'Terminal',
              'command',
              cmdLine
            )
          }
        }
        commandLineBufferRef.current = ''
      } else if (data === '\x7f' || data === '\b') {
        // Backspace - remove last char from command buffer
        commandLineBufferRef.current = commandLineBufferRef.current.slice(0, -1)
        // Re-analyze command after backspace
        analyzeSafetyCommandRef.current(commandLineBufferRef.current)
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        // Printable character - add to command buffer
        commandLineBufferRef.current += data
        // Analyze command for safety warning indicator
        analyzeSafetyCommandRef.current(commandLineBufferRef.current)
        // Auto-hide next-step suggestions when user starts typing
        if (showNextStepSuggestions) {
          setShowNextStepSuggestions(false)
          clearNextStepSuggestionsRef.current()
        }
      } else if (data === '\x03') {
        // Ctrl+C - clear command buffer
        commandLineBufferRef.current = ''
        // Clear safety analysis
        analyzeSafetyCommandRef.current('')
      }

      // Send data to device
      ws.send(JSON.stringify({
        type: 'Input',
        data: data
      }))
      // Broadcast to other multi-send enabled terminals
      onBroadcast?.(data, id)
      // Capture input for recording (asciicast format)
      if (recordingCaptureRef.current.recording) {
        recordingCaptureRef.current.addInput(data)
      }
      // Track input for autocomplete (only if enabled)
      if (settingsRef.current['ai.inlineSuggestions']) {
        if (data === '\r' || data === '\n') {
          // Enter pressed - clear input and suggestions
          clearSuggestionsRef.current()
          setCurrentInput('')
        } else if (data === '\x7f' || data === '\b') {
          // Backspace - remove last char
          setCurrentInput(prev => {
            const newInput = prev.slice(0, -1)
            if (newInput.length >= 2) {
              fetchSuggestionsRef.current(newInput, {
                terminal: terminalWatcherRef.current.getContext(),
                cliFlavor: cliFlavorRef.current
              })
            } else {
              clearSuggestionsRef.current()
            }
            return newInput
          })
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          // Printable character - add to input and fetch suggestions
          setCurrentInput(prev => {
            const newInput = prev + data
            fetchSuggestionsRef.current(newInput, {
              terminal: terminalWatcherRef.current.getContext(),
              cliFlavor: cliFlavorRef.current
            })
            return newInput
          })
        }
      }
    })

    return () => {
      dataDisposable.dispose()
    }
  // Note: All dynamic callbacks accessed via refs to prevent reconnection loops
  }, [handleResize, autoReconnectDisabled, reconnectDelay, clearCountdownInterval, onBroadcast, id, sessionId])

  // Store connect in ref so connection effect doesn't re-run when connect changes
  const connectRef = useRef(connect)
  connectRef.current = connect

  // Start reconnect countdown
  const startReconnectCountdown = useCallback(() => {
    if (maxReconnectAttempts > 0 && attemptCount >= maxReconnectAttempts) {
      // Max attempts reached, don't auto-reconnect
      return
    }

    setCountdown(reconnectDelay)
    clearCountdownInterval()

    countdownIntervalRef.current = window.setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearCountdownInterval()
          // Trigger reconnect
          setAttemptCount(a => a + 1)
          connect()
          return reconnectDelay
        }
        return prev - 1
      })
    }, 1000)
  }, [reconnectDelay, maxReconnectAttempts, attemptCount, clearCountdownInterval, connect])

  // Handle reconnect now button
  const handleReconnectNow = useCallback(() => {
    clearCountdownInterval()
    setAttemptCount(a => a + 1)
    // Force close any existing WebSocket to allow fresh reconnect
    if (wsRef.current) {
      isIntentionalCloseRef.current = true
      wsRef.current.close()
      wsRef.current = null
    }
    connect()
  }, [clearCountdownInterval, connect])

  // Expose reconnect function for imperative handle (standalone/local only — enterprise sets its own)
  if (!isEnterpriseMode && !isJumpboxMode) {
    reconnectFnRef.current = handleReconnectNow
  }

  // Handle cancel button
  const handleCancel = useCallback(() => {
    clearCountdownInterval()
    setShowReconnectOverlay(false)
    setCountdown(reconnectDelay)
  }, [clearCountdownInterval, reconnectDelay])

  // Handle disable auto-reconnect
  const handleDisableAutoReconnect = useCallback(() => {
    setAutoReconnectDisabled(true)
    clearCountdownInterval()
  }, [clearCountdownInterval])

  // ── Search ──────────────────────────────────────────────────────
  // SearchAddon doesn't expose match count, so the "1 of 1" counter
  // was completely fake. Two real problems audit P1-6 flagged:
  //   1. Prev/Next called findNext('') without options, so case/regex
  //      toggles only affected the initial Find — Prev/Next reverted
  //      to defaults mid-search.
  //   2. Counter always showed "1 of 1" regardless of actual matches.
  //
  // Fix:
  //   • Capture the current term + options in a ref so Prev/Next pass
  //     the same options as the initial search.
  //   • Compute total match count by scanning the terminal buffer
  //     ourselves on each new search; current-index advances on
  //     Prev/Next.
  const searchStateRef = useRef<{ term: string; options: SearchOptions }>({
    term: '',
    options: { caseSensitive: false, regex: false },
  })

  const countMatches = useCallback((term: string, options: SearchOptions): number => {
    const term0 = term
    if (!term0 || !terminalRef.current) return 0
    let regex: RegExp
    try {
      const flags = options.caseSensitive ? 'g' : 'gi'
      const pattern = options.regex
        ? term0
        : term0.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      regex = new RegExp(pattern, flags)
    } catch {
      // Invalid regex — treat as zero matches rather than throwing.
      return 0
    }
    const buf = terminalRef.current.buffer.active
    let count = 0
    // Scan every line in the active buffer (visible viewport + scrollback).
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y)?.translateToString(true) ?? ''
      const matches = line.match(regex)
      if (matches) count += matches.length
    }
    return count
  }, [])

  const handleSearch = useCallback((term: string, options: SearchOptions) => {
    searchStateRef.current = { term, options }
    if (!searchAddonRef.current || !term) {
      setSearchMatchCount(0)
      setCurrentSearchMatch(0)
      return
    }

    const result = searchAddonRef.current.findNext(term, {
      caseSensitive: options.caseSensitive,
      regex: options.regex,
      decorations: {
        matchBackground: '#515c6a',
        matchBorder: '#74879f',
        matchOverviewRuler: '#d186167e',
        activeMatchBackground: '#515c6a',
        activeMatchBorder: '#007acc',
        activeMatchColorOverviewRuler: '#007acc'
      }
    })

    if (result) {
      const total = countMatches(term, options)
      setSearchMatchCount(total)
      // First match is the one xterm just highlighted.
      setCurrentSearchMatch(total > 0 ? 1 : 0)
    } else {
      setSearchMatchCount(0)
      setCurrentSearchMatch(0)
    }
  }, [countMatches])

  const handleSearchNext = useCallback(() => {
    if (!searchAddonRef.current) return
    const { term, options } = searchStateRef.current
    if (!term) return
    // Pass term + options so the search keeps respecting Aa / regex
    // toggles. findNext continues forward from the current highlight.
    const result = searchAddonRef.current.findNext(term, {
      caseSensitive: options.caseSensitive,
      regex: options.regex,
    })
    if (result && searchMatchCount > 0) {
      setCurrentSearchMatch(prev => prev < searchMatchCount ? prev + 1 : 1)
    }
  }, [searchMatchCount])

  const handleSearchPrev = useCallback(() => {
    if (!searchAddonRef.current) return
    const { term, options } = searchStateRef.current
    if (!term) return
    const result = searchAddonRef.current.findPrevious(term, {
      caseSensitive: options.caseSensitive,
      regex: options.regex,
    })
    if (result && searchMatchCount > 0) {
      setCurrentSearchMatch(prev => prev > 1 ? prev - 1 : searchMatchCount)
    }
  }, [searchMatchCount])

  const handleCloseFindBar = useCallback(() => {
    setShowFindBar(false)
    searchAddonRef.current?.clearDecorations()
    setSearchMatchCount(0)
    setCurrentSearchMatch(0)
    // Focus terminal after closing find bar
    terminalRef.current?.focus()
  }, [])

  // Logging functions
  const flushLogBuffer = useCallback(async () => {
    if (logBufferRef.current.length === 0 || !logFilePath) return

    const content = logBufferRef.current.join('')
    logBufferRef.current = []

    try {
      await getClient().http.post('/logs/append', { path: logFilePath, content })
    } catch (err) {
      console.error('Failed to flush log buffer:', err)
    }
  }, [logFilePath])

  const startLogging = useCallback(async (format: LogFormat, timestamps: boolean) => {
    try {
      const { data } = await getClient().http.post(`/terminals/${id}/log/start`, { format, timestamps })

      const { path } = data
      setLogFilePath(path)
      setLogFormat(format)
      setLogTimestamps(timestamps)
      setIsLogging(true)
      logBufferRef.current = []

      // Start periodic flush (every 2 seconds)
      logFlushIntervalRef.current = window.setInterval(() => {
        flushLogBuffer()
      }, 2000)

      logger.log('Started logging to:', path)
    } catch (err) {
      console.error('Failed to start logging:', err)
      throw err
    }
  }, [id, flushLogBuffer])

  const stopLogging = useCallback(async () => {
    // Stop flush interval
    if (logFlushIntervalRef.current) {
      window.clearInterval(logFlushIntervalRef.current)
      logFlushIntervalRef.current = null
    }

    // Final flush
    await flushLogBuffer()

    // Notify backend and save log to docs
    try {
      await getClient().http.post(`/terminals/${id}/log/stop`, {
        path: logFilePath,
        session_id: sessionId,
        session_name: sessionName,
      })
    } catch (err) {
      console.error('Failed to stop logging on backend:', err)
    }

    setIsLogging(false)
    logger.log('Stopped logging')
  }, [id, flushLogBuffer, logFilePath, sessionId, sessionName])

  const logOutput = useCallback((data: string) => {
    if (!isLogging) return

    const processed = processForLog(data, logFormat, logTimestamps)
    logBufferRef.current.push(processed)
  }, [isLogging, logFormat, logTimestamps])

  // Keep logOutputRef in sync with the latest logOutput function
  useEffect(() => {
    logOutputRef.current = logOutput
  }, [logOutput])

  // Recording control functions (asciicast format)
  const startRecording = useCallback(async (name?: string) => {
    if (recordingCaptureRef.current.recording) {
      console.warn('Recording already in progress')
      return null
    }
    const terminal = terminalRef.current
    if (!terminal) {
      console.error('Terminal not initialized')
      return null
    }
    try {
      const recordingName = name || `Recording ${new Date().toLocaleString()}`
      const recordingId = await recordingCaptureRef.current.start(
        recordingName,
        terminal.cols,
        terminal.rows,
        sessionId
      )
      setIsRecordingActive(true)
      logger.log('Started recording:', recordingId)
      return recordingId
    } catch (err) {
      console.error('Failed to start recording:', err)
      return null
    }
  }, [sessionId])

  const stopRecording = useCallback(async () => {
    if (!recordingCaptureRef.current.recording) {
      return null
    }
    try {
      const recordingId = await recordingCaptureRef.current.stop()
      setIsRecordingActive(false)
      logger.log('Stopped recording:', recordingId)

      // Save recording to docs (fire-and-forget)
      if (recordingId) {
        getClient().http.post(`/recordings/${recordingId}/save-to-docs`, { session_id: sessionId })
          .catch(err => console.error('Failed to save recording to docs:', err))
      }

      return recordingId
    } catch (err) {
      console.error('Failed to stop recording:', err)
      setIsRecordingActive(false)
      return null
    }
  }, [sessionId])

  // Docs capture functions for capture syntax
  // Supports both prefix syntax (>> docs/path) and suffix syntax (command |> docs/path)
  // Parse capture syntax from input: returns { docPath, mode, command? } or null
  const parseCaptureSyntax = useCallback((input: string): { docPath: string; mode: 'append' | 'overwrite'; command?: string } | null => {
    // SUFFIX SYNTAX (preferred): command |> docs/path or command |>> docs/path
    // This is more intuitive: "run this command, save output to docs"
    const suffixAppendMatch = input.match(/^(.+?)\s*\|>>\s*docs\/(.+)$/)
    if (suffixAppendMatch) {
      return { command: suffixAppendMatch[1].trim(), docPath: suffixAppendMatch[2].trim(), mode: 'append' }
    }
    const suffixOverwriteMatch = input.match(/^(.+?)\s*\|>\s*docs\/(.+)$/)
    if (suffixOverwriteMatch) {
      return { command: suffixOverwriteMatch[1].trim(), docPath: suffixOverwriteMatch[2].trim(), mode: 'overwrite' }
    }

    // LEGACY PREFIX SYNTAX: >> docs/path (starts capture mode for next command)
    const appendMatch = input.match(/^>>\s*docs\/(.+)$/)
    if (appendMatch) {
      return { docPath: appendMatch[1].trim(), mode: 'append' }
    }
    const overwriteMatch = input.match(/^>\s*docs\/(.+)$/)
    if (overwriteMatch) {
      return { docPath: overwriteMatch[1].trim(), mode: 'overwrite' }
    }
    return null
  }, [])

  // Start capture mode
  const startCapture = useCallback((docPath: string, mode: 'append' | 'overwrite') => {
    // Clear any existing timeout
    if (captureTimeoutRef.current) {
      window.clearTimeout(captureTimeoutRef.current)
    }

    const config: CaptureConfig = {
      docPath,
      mode,
      buffer: [],
      startTime: Date.now(),
      byteCount: 0,
    }
    setCaptureMode(config)

    // Set capture timeout
    captureTimeoutRef.current = window.setTimeout(() => {
      console.warn('Capture timeout reached for:', docPath)
      // Don't auto-cancel, just warn - user can cancel with Esc or Ctrl+C
    }, CAPTURE_TIMEOUT_MS)

    logger.log(`Started capture mode: ${mode === 'append' ? '>>' : '>'} docs/${docPath}`)
  }, [])

  // Add output to capture buffer
  const addToCaptureBuffer = useCallback((data: string) => {
    setCaptureMode(prev => {
      if (!prev) return null
      return {
        ...prev,
        buffer: [...prev.buffer, data],
        byteCount: prev.byteCount + data.length,
      }
    })
  }, [])

  // Cancel capture mode (used by keyboard shortcut and UI)
  const cancelCapture = useCallback(() => {
    if (captureTimeoutRef.current) {
      window.clearTimeout(captureTimeoutRef.current)
      captureTimeoutRef.current = null
    }
    setCaptureMode(null)
    logger.log('Capture cancelled')
  }, [])

  // Helper to detect document category from path
  const detectCategoryFromPath = useCallback((path: string): DocumentCategory => {
    const lowerPath = path.toLowerCase()
    if (lowerPath.startsWith('configs/') || lowerPath.includes('config')) return 'outputs'
    if (lowerPath.startsWith('templates/')) return 'templates'
    if (lowerPath.startsWith('notes/')) return 'notes'
    if (lowerPath.startsWith('backups/')) return 'backups'
    if (lowerPath.startsWith('history/')) return 'history'
    // Fall back to the user-configured terminal-capture category.
    return resolveDocSaveTarget('terminalCapture').category
  }, [])

  // Helper to detect content type from content
  const detectContentType = useCallback((content: string): ContentType => {
    const trimmed = content.trim()
    // Check for JSON
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        JSON.parse(trimmed)
        return 'json'
      } catch {
        // Not valid JSON
      }
    }
    // Check for CSV (has comma-separated lines)
    const lines = trimmed.split('\n')
    if (lines.length > 1 && lines.every(line => line.includes(','))) {
      return 'csv'
    }
    // Check for Jinja templates
    if (trimmed.includes('{{') || trimmed.includes('{%')) {
      return 'jinja'
    }
    // Check for config-like content (key=value, interface, hostname, etc.)
    if (/^(interface|hostname|router|ip|username|set|config)/im.test(trimmed)) {
      return 'config'
    }
    return 'text'
  }, [])

  // Helper to extract parent folder and name from path
  const parseDocPath = useCallback((fullPath: string): { name: string; parentFolder: string | null } => {
    const parts = fullPath.split('/')
    const name = parts.pop() || fullPath
    const parentFolder = parts.length > 0 ? parts.join('/') : null
    return { name, parentFolder }
  }, [])

  // Complete capture and save to docs
  const completeCapture = useCallback(async () => {
    if (!captureMode) return

    if (captureTimeoutRef.current) {
      window.clearTimeout(captureTimeoutRef.current)
      captureTimeoutRef.current = null
    }

    const { docPath, mode, buffer } = captureMode
    const content = buffer.join('')

    logger.log(`Completing capture: ${mode} to docs/${docPath} (${content.length} bytes)`)

    // Clear capture mode immediately
    setCaptureMode(null)

    if (content.length === 0) {
      showToast('No content captured', 'warning')
      return
    }

    try {
      const category = detectCategoryFromPath(docPath)
      const contentType = detectContentType(content)
      const { name, parentFolder } = parseDocPath(docPath)

      if (mode === 'overwrite') {
        // Create or replace document
        await createDocument({
          name,
          category,
          content_type: contentType,
          content,
          parent_folder: parentFolder,
          session_id: sessionId || null,
        })
        showToast(`Saved to docs/${docPath}`, 'success')
      } else {
        // Append mode - try to find existing document first
        // Search for document by name and parent folder
        try {
          // First try to find the document by searching
          const { data: docs } = await getClient().http.get('/docs', {
            params: { name, ...(parentFolder ? { parent_folder: parentFolder } : {}) }
          })
          const existingDoc = docs.find((d: { name: string; parent_folder: string | null }) =>
            d.name === name && d.parent_folder === parentFolder
          )

          if (existingDoc) {
            // Get current document to append to
            const doc = await getDocument(existingDoc.id)
            const appendedContent = doc.content + '\n' + content
            await updateDocument(existingDoc.id, { content: appendedContent })
            showToast(`Appended to docs/${docPath}`, 'success')
          } else {
            // No existing document - create new
            await createDocument({
              name,
              category,
              content_type: contentType,
              content,
              parent_folder: parentFolder,
              session_id: sessionId || null,
            })
            showToast(`Saved to docs/${docPath}`, 'success')
          }
        } catch {
          // Fallback - create new document
          await createDocument({
            name,
            category,
            content_type: contentType,
            content,
            parent_folder: parentFolder,
            session_id: sessionId || null,
          })
          showToast(`Saved to docs/${docPath}`, 'success')
        }
      }
    } catch (err) {
      console.error('Failed to save capture:', err)
      showToast(`Failed to save: ${getErrorMessage(err)}`, 'error')
    }
  }, [captureMode, sessionId, detectCategoryFromPath, detectContentType, parseDocPath])

  // Expose capture functions for keyboard shortcuts and UI (Task 3 and 4)
  void cancelCapture
  void completeCapture

  // --- Retroactive Capture (Save to Docs button) ---
  // Extract all text from the terminal buffer
  const getTerminalText = useCallback((lines?: number): string => {
    const terminal = terminalRef.current
    if (!terminal) return ''

    const buffer = terminal.buffer.active
    const totalLines = buffer.length
    const linesToExtract = lines ?? totalLines

    const textLines: string[] = []
    const startLine = Math.max(0, totalLines - linesToExtract)

    for (let i = startLine; i < totalLines; i++) {
      const line = buffer.getLine(i)
      if (line) {
        textLines.push(line.translateToString(true))
      }
    }

    return textLines.join('\n')
  }, [])

  // Open save dialog with current terminal content
  const openSaveToDocsDialog = useCallback(() => {
    const content = getTerminalText()
    if (!content.trim()) {
      showToast('No terminal content to save', 'warning')
      return
    }
    setSaveDialogContent(content)
    setSaveDialogPath('')
    setShowSaveDialog(true)
    // Focus input after dialog opens
    setTimeout(() => {
      saveDialogInputRef.current?.focus()
    }, 50)
  }, [getTerminalText])

  // Handle save dialog submission
  const handleSaveDialogSubmit = useCallback(async () => {
    if (!saveDialogPath.trim()) {
      showToast('Please enter a document path', 'warning')
      return
    }

    const docPath = saveDialogPath.trim().replace(/^docs\//, '')
    const content = saveDialogContent

    try {
      const category = detectCategoryFromPath(docPath)
      const contentType = detectContentType(content)
      const { name, parentFolder } = parseDocPath(docPath)

      await createDocument({
        name,
        category,
        content_type: contentType,
        content,
        parent_folder: parentFolder,
        session_id: sessionId || null,
      })

      showToast(`Saved to docs/${docPath}`, 'success')
      setShowSaveDialog(false)
      setSaveDialogPath('')
      setSaveDialogContent('')
      // Re-focus terminal
      terminalRef.current?.focus()
    } catch (err) {
      console.error('Failed to save to docs:', err)
      showToast(`Failed to save: ${getErrorMessage(err)}`, 'error')
    }
  }, [saveDialogPath, saveDialogContent, sessionId, detectCategoryFromPath, detectContentType, parseDocPath])

  // Close save dialog
  const closeSaveDialog = useCallback(() => {
    setShowSaveDialog(false)
    setSaveDialogPath('')
    setSaveDialogContent('')
    terminalRef.current?.focus()
  }, [])

  // Store capture functions in refs for use in connect function and keyboard shortcuts
  const parseCaptureSyntaxRef = useRef(parseCaptureSyntax)
  parseCaptureSyntaxRef.current = parseCaptureSyntax
  const startCaptureRef = useRef(startCapture)
  startCaptureRef.current = startCapture
  const addToCaptureBufferRef = useRef(addToCaptureBuffer)
  addToCaptureBufferRef.current = addToCaptureBuffer
  const addAIOutputRef = useRef(addAIOutput)
  addAIOutputRef.current = addAIOutput
  const completeCaptureRef = useRef(completeCapture)
  completeCaptureRef.current = completeCapture
  const cancelCaptureRef = useRef(cancelCapture)
  cancelCaptureRef.current = cancelCapture
  const openSaveToDocsDialogRef = useRef(openSaveToDocsDialog)
  openSaveToDocsDialogRef.current = openSaveToDocsDialog

  // Track command line buffer for capture syntax detection
  const commandLineBufferRef = useRef('')

  // Gate AI Overlord output: only feed terminal output to AI after user presses Enter.
  // Resets to false when user starts typing again, so character echoes aren't analyzed.
  const aiCommandSentRef = useRef(false)

  // Export logging state and functions for parent components (unused currently but available for future integration)
  const _loggingState = {
    isLogging,
    logFormat,
    logTimestamps,
    logFilePath,
    startLogging,
    stopLogging,
    setLogFormat,
    setLogTimestamps,
  }
  void _loggingState // Suppress unused variable warning

  useEffect(() => {
    if (!containerRef.current) return

    // Create terminal instance with theme and font settings (session-specific → global settings → defaults)
    const effectiveFontSize = fontSize ?? settingsRef.current.fontSize ?? 14
    const effectiveFontFamily = fontFamily ?? 'Menlo, Monaco, Consolas, monospace'
    // Use session theme, or fall back to default theme from settings
    const effectiveTheme = terminalTheme ?? settingsRef.current['terminal.defaultTheme']
    // Font weight setting
    const fontWeight = settingsRef.current['terminal.fontWeight'] ?? 'normal'
    const terminal = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: effectiveFontSize,
      fontFamily: effectiveFontFamily,
      fontWeight: fontWeight as 'normal' | 'bold',
      theme: getTerminalTheme(effectiveTheme),
      allowProposedApi: true,
    })
    // Load addons
    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon(async (_event, uri) => {
      const opened = await openExternalUrl(uri)
      if (!opened) {
        showToast('Failed to open link in browser', 'error', 4000)
      }
    })
    const searchAddon = new SearchAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.loadAddon(searchAddon)

    // Clipboard paste that works inside the Tauri WebView (WebKitGTK on
    // Linux blocks navigator.clipboard.readText — readClipboardText goes
    // through the clipboard-manager plugin first). Exposed via ref for
    // the context menu.
    const pasteFromClipboard = async () => {
      const text = await readClipboardText()
      if (text) terminal.paste(text)
    }
    pasteFromClipboardRef.current = () => { void pasteFromClipboard() }

    // SecureCRT/Linux-convention clipboard keys: Ctrl+Shift+C / Ctrl+Insert
    // copy, Ctrl+Shift+V / Shift+Insert paste. Registered ahead of xterm's
    // keyboard handling so they never reach the remote shell as input
    // (plain Ctrl+C still sends SIGINT as a terminal must).
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const key = e.key.toLowerCase()
      const ctrlShift = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey
      const isCopy = (ctrlShift && key === 'c')
        || (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey && key === 'insert')
      const isPaste = (ctrlShift && key === 'v')
        || (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && key === 'insert')
      if (isCopy) {
        e.preventDefault()
        const selection = terminal.getSelection()
        if (selection) void copyToClipboard(selection)
        return false
      }
      if (isPaste) {
        e.preventDefault()
        void pasteFromClipboard()
        return false
      }
      return true
    })

    // Open terminal in container
    terminal.open(containerRef.current)

    // Enable GPU-accelerated rendering (WebGL)
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        webglAddon.dispose()
      })
      terminal.loadAddon(webglAddon)
    } catch {
      // WebGL not available — falls back to default DOM renderer
    }

    // Store refs
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon
    // Set terminal instance for useDetection hook
    setTerminalInstance(terminal)

    // Hover enrichment popover — registers xterm link providers for the
    // agent's active matchers and shows a streaming enrichment card on hover.
    // Reads settings live so the toggle takes effect without remount.
    if (containerRef.current) {
      enrichPopupRef.current = installEnrichPopup(terminal, containerRef.current, {
        sessionId: effectiveSessionId ?? null,
        getCliFlavor: () => cliFlavorRef.current ?? null,
        getSettings: () => ({
          hoverEnabled: settingsRef.current['terminal.enrichment.hoverEnabled'] !== false
            && settingsRef.current['terminal.hoverLookups'] !== false,
          aiDigestEnabled: settingsRef.current['terminal.enrichment.aiDigestEnabled'] === true,
          disabledSources: (settingsRef.current['terminal.enrichment.disabledSources'] as string[] | undefined) ?? [],
        }),
      })
    }

    // Initial fit
    setTimeout(() => {
      handleResize()
    }, 0)

    // Listen for events on the terminal container
    const terminalEl = containerRef.current

    // Handle right-click context menu
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      const selection = terminal.getSelection() || ''
      setContextMenuText(selection)

      // Check for detection at click position
      const cell = terminal.element ? mouseToTerminalCell(e, terminal, terminal.element) : null
      if (cell) {
        const detection = getDetectionAtRef.current(cell.absoluteLine, cell.col)
        setContextMenuDetection(detection)
      } else {
        setContextMenuDetection(null)
      }

      setContextMenuPosition({
        x: e.clientX,
        y: e.clientY
      })
    }

    // Handle keyboard shortcuts for find, capture, and profile mapped keys
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check profile mapped keys first
      // Works in all modes: standalone (wsRef), enterprise (enterpriseSendDataRef), jumpbox (jumpboxSendDataRef)
      const canSendMappedKey = profileMappedKeysRef.current.length > 0 && (
        wsRef.current?.readyState === WebSocket.OPEN ||
        enterpriseSendDataRef.current !== null ||
        jumpboxSendDataRef.current !== null
      )
      if (canSendMappedKey) {
        // Build the key combo from the event
        const parts: string[] = []
        if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
        if (e.altKey) parts.push('Alt')
        if (e.shiftKey) parts.push('Shift')

        // Get the key name
        let key = e.key
        if (key === ' ') key = 'Space'
        else if (key.length === 1) key = key.toUpperCase()
        // Keep function keys, arrow keys, etc. as-is

        // Don't check if only modifier pressed
        if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
          parts.push(key)
          const keyCombo = parts.join('+')

          // Check if this key combo matches any mapped key
          const matchedKey = profileMappedKeysRef.current.find(
            mk => mk.key_combo.toLowerCase() === keyCombo.toLowerCase()
          )

          if (matchedKey) {
            e.preventDefault()
            e.stopPropagation()
            const commandWithEnter = matchedKey.command + '\r'
            // Send via the appropriate transport
            if (enterpriseSendDataRef.current) {
              enterpriseSendDataRef.current(commandWithEnter)
            } else if (jumpboxSendDataRef.current) {
              jumpboxSendDataRef.current(commandWithEnter)
            } else if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ type: 'Input', data: commandWithEnter }))
            }
            return
          }
        }
      }

      // Cmd+F or Ctrl+F - Open find bar
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        setShowFindBar(true)
        return
      }

      // Cmd+Shift+S or Ctrl+Shift+S - Open Save to Docs dialog
      // (e.key is 'S' when Shift is held, so compare case-insensitively)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        e.stopPropagation()
        openSaveToDocsDialogRef.current()
        return
      }

      // Capture mode shortcuts (only when in capture mode)
      if (captureModeRef.current) {
        // Ctrl+D or Cmd+D - Complete capture
        if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
          e.preventDefault()
          e.stopPropagation()
          completeCaptureRef.current()
          return
        }
        // Escape - Cancel capture
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          cancelCaptureRef.current()
          return
        }
      }
    }

    // Handle mouseup for auto-copy on select (SecureCRT-style).
    // copyToClipboard (not navigator.clipboard) — WebKitGTK on Linux
    // rejects the browser API, the Tauri plugin path always works.
    const handleMouseUp = () => {
      if (!copyOnSelectRef.current) return
      const selection = terminal.getSelection()
      if (selection && selection.length > 0) {
        void copyToClipboard(selection)
      }
    }

    // Middle-click paste (Linux/SecureCRT convention). Skipped while the
    // remote app has mouse reporting on (vim, htop, ...) — the click
    // belongs to the app and xterm forwards it.
    const handleMiddleClick = (e: MouseEvent) => {
      if (e.button !== 1) return
      if (settingsRef.current['terminal.middleClickPaste'] === false) return
      if (terminal.modes.mouseTrackingMode !== 'none') return
      e.preventDefault()
      pasteFromClipboardRef.current()
    }

    // Ctrl/Cmd+Scroll to adjust terminal font size
    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const term = terminalRef.current
      if (!term || !fitAddonRef.current) return
      const current = term.options.fontSize ?? 14
      const delta = e.deltaY < 0 ? 1 : -1
      const newSize = Math.max(8, Math.min(32, current + delta))
      if (newSize !== current) {
        term.options.fontSize = newSize
        fitAddonRef.current.fit()
        term.refresh(0, term.rows - 1)
      }
    }

    // Handle clipboard paste with image data (Cmd+V / Ctrl+V)
    const handlePaste = async (e: ClipboardEvent) => {
      const imageBlob = getImageFromClipboard(e.clipboardData)
      if (!imageBlob) return
      e.preventDefault()
      e.stopPropagation()
      handleImageDropRef.current?.(imageBlob)
    }

    // macOS Force Touch (force click) → action popover. ADDITIVE & NON-BLOCKING:
    // these are a separate WebKit event stream. We never call stopPropagation,
    // and only preventDefault on `webkitmouseforcewillbegin` — which is required
    // both to receive the rest of the sequence and to suppress the OS default
    // force-click (Look Up / data detectors). Normal click, selection, mouseup
    // and contextmenu are completely unaffected. On hardware without Force Touch
    // these events never fire, so the feature is simply absent.
    const handleForceWillBegin = (e: Event) => {
      e.preventDefault()
    }
    const handleForceClick = (e: Event) => {
      const me = e as MouseEvent
      const selection = terminal.getSelection() || ''
      const { sessionId: sid, sessionName: sname } = sessionMetaRef.current
      const customActions = buildForceActionsRef.current(selection)
      onForceClickRef.current?.(selection, { x: me.clientX, y: me.clientY }, sid, sname, customActions)
    }

    if (terminalEl) {
      terminalEl.addEventListener('contextmenu', handleContextMenu)
      terminalEl.addEventListener('keydown', handleKeyDown)
      terminalEl.addEventListener('mouseup', handleMouseUp)
      terminalEl.addEventListener('mousedown', handleMiddleClick)
      terminalEl.addEventListener('wheel', handleWheel, { passive: false })
      terminalEl.addEventListener('paste', handlePaste as unknown as EventListener, true)
      terminalEl.addEventListener('webkitmouseforcewillbegin', handleForceWillBegin)
      terminalEl.addEventListener('webkitmouseforcedown', handleForceClick)
    }

    // Resize observer (debounced via rAF to avoid per-pixel thrashing)
    let resizeRafId: number | null = null
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRafId !== null) return
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null
        handleResize()
      })
    })
    resizeObserver.observe(containerRef.current)

    // Window resize
    window.addEventListener('resize', handleResize)

    return () => {
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId)
      resizeObserver.disconnect()
      window.removeEventListener('resize', handleResize)
      if (terminalEl) {
        terminalEl.removeEventListener('contextmenu', handleContextMenu)
        terminalEl.removeEventListener('keydown', handleKeyDown)
        terminalEl.removeEventListener('mouseup', handleMouseUp)
        terminalEl.removeEventListener('mousedown', handleMiddleClick)
        terminalEl.removeEventListener('wheel', handleWheel)
        terminalEl.removeEventListener('paste', handlePaste as unknown as EventListener, true)
        terminalEl.removeEventListener('webkitmouseforcewillbegin', handleForceWillBegin)
        terminalEl.removeEventListener('webkitmouseforcedown', handleForceClick)
      }
      clearCountdownInterval()
      // Clean up logging
      if (logFlushIntervalRef.current) {
        window.clearInterval(logFlushIntervalRef.current)
      }
      // Clean up highlight engine
      if (highlightEngineRef.current) {
        highlightEngineRef.current.destroy()
        highlightEngineRef.current = null
      }
      // Clean up hover enrichment popover
      if (enrichPopupRef.current) {
        enrichPopupRef.current.dispose()
        enrichPopupRef.current = null
      }
      if (wsRef.current) {
        isIntentionalCloseRef.current = true
        wsRef.current.close()
      }
      // Clear terminal instance for useDetection hook
      setTerminalInstance(null)
      terminal.dispose()
    }
  }, [id, handleResize, clearCountdownInterval])

  // Connect on mount after terminal is ready (use ref to prevent reconnection loops)
  // Deferred via setTimeout(0) so React StrictMode's rapid unmount/remount cycle
  // clears the timer before any WebSocket is created, preventing double SSH connections.
  useEffect(() => {
    if (terminalRef.current) {
      let connectCleanup: (() => void) | undefined
      const timer = window.setTimeout(() => {
        connectCleanup = connectRef.current()
      }, 0)
      return () => {
        window.clearTimeout(timer)
        connectCleanup?.()
      }
    }
  }, []) // Empty deps - only connect once on mount

  // Track cursor position for inline suggestions
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !settingsRef.current['ai.inlineSuggestions']) return

    // Calculate cursor pixel position from terminal buffer
    const updateCursorPosition = () => {
      // Get the wrapper element (parent of containerRef) for accurate positioning
      const wrapper = containerRef.current?.parentElement
      if (!wrapper) return

      // Try to get position from actual cursor element in DOM
      const cursorElement = containerRef.current?.querySelector('.xterm-cursor')
      if (cursorElement) {
        const wrapperRect = wrapper.getBoundingClientRect()
        const cursorRect = cursorElement.getBoundingClientRect()
        setCursorPosition({
          x: cursorRect.right - wrapperRect.left,
          y: cursorRect.top - wrapperRect.top
        })
        return
      }

      // Fallback: calculate from buffer position
      const buffer = terminal.buffer.active
      const cursorX = buffer.cursorX
      const cursorY = buffer.cursorY

      // Get terminal dimensions (font size is 14px, line height ~1.2)
      const charWidth = 8.4 // Approximate character width for Menlo 14px
      const lineHeight = 17 // Line height for 14px font

      // Calculate pixel position relative to terminal content
      const x = cursorX * charWidth
      const y = cursorY * lineHeight

      setCursorPosition({ x, y })
    }

    // Update on cursor move (via onCursorMove if available) or on data
    const cursorDisposable = terminal.onCursorMove?.(updateCursorPosition)

    // Also update when input is tracked
    const dataDisposable = terminal.onData(() => {
      // Small delay to let cursor position update
      requestAnimationFrame(updateCursorPosition)
    })

    // Initial update
    updateCursorPosition()

    return () => {
      cursorDisposable?.dispose()
      dataDisposable.dispose()
    }
  }, []) // Use settingsRef to avoid dependency issues

  // Update terminal theme when prop changes or settings default changes
  useEffect(() => {
    if (terminalRef.current && fitAddonRef.current) {
      // Use session theme, or fall back to default theme from settings
      const effectiveTheme = terminalTheme ?? settings['terminal.defaultTheme']
      const newTheme = getTerminalTheme(effectiveTheme)
      terminalRef.current.options.theme = newTheme
      // Force terminal to re-render with new theme colors
      terminalRef.current.clearSelection()
      fitAddonRef.current.fit()
      terminalRef.current.refresh(0, terminalRef.current.rows - 1)
    }
  }, [terminalTheme, settings])

  // Update terminal font when props or global settings change
  useEffect(() => {
    if (terminalRef.current && fitAddonRef.current) {
      const effectiveFontSize = fontSize ?? settings.fontSize ?? 14
      const effectiveFontFamily = fontFamily ?? 'Menlo, Monaco, Consolas, monospace'
      terminalRef.current.options.fontSize = effectiveFontSize
      terminalRef.current.options.fontFamily = effectiveFontFamily
      // Re-fit terminal to account for font size changes
      fitAddonRef.current.fit()
      terminalRef.current.refresh(0, terminalRef.current.rows - 1)
    }
  }, [fontSize, fontFamily, settings.fontSize])

  // Update terminal font weight when setting changes
  useEffect(() => {
    if (terminalRef.current && fitAddonRef.current) {
      const fontWeight = settings['terminal.fontWeight'] ?? 'normal'
      terminalRef.current.options.fontWeight = fontWeight as 'normal' | 'bold'
      // Re-fit and refresh terminal to apply new settings
      fitAddonRef.current.fit()
      terminalRef.current.refresh(0, terminalRef.current.rows - 1)
    }
  }, [settings['terminal.fontWeight']])

  // Initialize and update highlight engine (includes detection rules)
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !highlightingEnabled) {
      // Clean up existing engine if highlighting disabled
      if (highlightEngineRef.current) {
        highlightEngineRef.current.destroy()
        highlightEngineRef.current = null
      }
      // Stop ANSI color injection
      if (ansiHighlighterRef.current) {
        ansiHighlighterRef.current.setRules([])
        ansiHighlighterRef.current = null
      }
      return
    }

    // Create decoration engine if needed — now used ONLY for interactive
    // detection rules + AI ad-hoc highlights (hover/click metadata). Plain
    // color highlight rules are rendered via ANSI injection below.
    if (!highlightEngineRef.current) {
      highlightEngineRef.current = new HighlightEngine(terminal, sessionId)
    }

    // Color highlight rules → ANSI injection (durable across copy/reflow).
    // Applied to future output only; changing a rule re-colors new lines, not
    // scrollback. Empty list when the hook hasn't loaded yet; the effect
    // re-runs (highlightRules is a dep) once rules resolve.
    if (!ansiHighlighterRef.current) {
      ansiHighlighterRef.current = new AnsiHighlighter()
    }
    ansiHighlighterRef.current.setRules(highlightRules)

    // Wire detection rules into the highlight engine for unified decorations
    const detectionHighlighting = settings['detection.highlighting']
    if (detectionHighlighting) {
      // Map network preset rule names to detection types
      const presetTypeMap: Record<string, string> = {
        'IPv4 Address': 'ipv4',
        'IPv6 Address': 'ipv6',
        'MAC Address (colon)': 'mac',
        'MAC Address (dash)': 'mac',
        'MAC Address (dot)': 'mac',
        'Cisco Interface': 'interface',
        'Linux Interface': 'interface',
        'VLAN ID': 'vlan',
        'CIDR Notation': 'cidr',
        'AS Number': 'asn',
      }

      const detectionRules: import('../api/highlightRules').HighlightRule[] = []
      const extras = new Map<string, DetectionRuleExtras>()
      const now = new Date().toISOString()

      for (const preset of networkPreset) {
        const detectionType = presetTypeMap[preset.name]
        if (!detectionType) continue

        // Create a synthetic HighlightRule with a stable ID for detection
        const ruleId = `detection-${preset.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`
        detectionRules.push({
          id: ruleId,
          name: preset.name,
          pattern: preset.pattern,
          is_regex: preset.is_regex ?? false,
          case_sensitive: preset.case_sensitive ?? false,
          whole_word: preset.whole_word ?? false,
          foreground: null,  // Detection rules don't color by default; user rules do
          background: null,
          bold: false,
          italic: false,
          underline: false,
          category: 'Detection',
          priority: (preset.priority ?? 50) + 1000,  // Lower priority than user rules
          enabled: true,
          session_id: null,
          created_at: now,
          updated_at: now,
        })

        extras.set(ruleId, {
          detectionType,
          borderStyle: '1px dotted rgba(100, 180, 255, 0.8)',
          cursor: 'context-menu',
          tooltipPrefix: `Right-click for ${detectionType} options`,
        })
      }

      // Also register custom regex patterns from custom commands
      for (const cmd of customCommandsRef.current) {
        if (!cmd.enabled || !cmd.detection_types) continue
        try {
          const types: string[] = JSON.parse(cmd.detection_types)
          for (const t of types) {
            if (!t.startsWith('regex:')) continue
            const pattern = t.slice(6)
            if (!pattern) continue
            const ruleId = `detection-regex-${cmd.id}`
            detectionRules.push({
              id: ruleId,
              name: `Custom: ${cmd.name}`,
              pattern,
              is_regex: true,
              case_sensitive: false,
              whole_word: false,
              foreground: null,
              background: null,
              bold: false,
              italic: false,
              underline: false,
              category: 'Detection',
              priority: 1100,
              enabled: true,
              session_id: null,
              created_at: now,
              updated_at: now,
            })
            extras.set(ruleId, {
              detectionType: t,  // store full "regex:<pattern>" so context menu can match
              borderStyle: '1px dotted rgba(180, 140, 255, 0.8)',
              cursor: 'context-menu',
              tooltipPrefix: `Right-click for ${cmd.name}`,
            })
          }
        } catch { /* ignore parse errors */ }
      }

      highlightEngineRef.current.setDetectionRules(detectionRules, extras)
    } else {
      highlightEngineRef.current.clearDetectionRules()
    }
  }, [highlightingEnabled, highlightRules, sessionId, settings['detection.highlighting']])

  // Set up scroll handler for highlight updates
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !highlightingEnabled) return

    // Scroll: scan only newly-visible lines (no debounce — data already in buffer)
    const scrollDisposable = terminal.onScroll(() => {
      highlightEngineRef.current?.scanViewport()
    })

    // New data: scan incrementally after xterm processes each write batch.
    // onWriteParsed fires at most once per animation frame — much better
    // than onData which fires on every SSH data chunk.
    const writeDisposable = terminal.onWriteParsed(() => {
      highlightEngineRef.current?.notifyDataWritten()
    })

    return () => {
      scrollDisposable.dispose()
      writeDisposable.dispose()
    }
  }, [highlightingEnabled])

  // Line numbers gutter — syncs with terminal viewport
  const showLineNumbers = settings['terminal.lineNumbers'] ?? false
  const updateLineNumbers = useCallback(() => {
    const terminal = terminalRef.current
    const gutter = gutterRef.current
    if (!terminal || !gutter || !showLineNumbers) return

    // Sync line-height with xterm's actual cell dimensions
    const cellHeight = (terminal as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height: number } } } } } })
      ._core?._renderService?.dimensions?.css?.cell?.height
    if (cellHeight) {
      gutter.style.lineHeight = `${cellHeight}px`
    }

    // Match xterm's top padding (xterm container has var(--spacing-xs) padding)
    const xtermEl = containerRef.current?.querySelector('.xterm') as HTMLElement | null
    if (xtermEl) {
      const xtermPad = getComputedStyle(xtermEl).paddingTop
      gutter.style.paddingTop = xtermPad
    }

    const buffer = terminal.buffer.active
    const viewportY = buffer.viewportY
    const rows = terminal.rows
    const totalLines = buffer.length

    const lines: string[] = []
    for (let i = 0; i < rows; i++) {
      const lineNum = viewportY + i + 1
      lines.push(lineNum <= totalLines ? String(lineNum) : '')
    }
    gutter.textContent = lines.join('\n')
  }, [showLineNumbers])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !showLineNumbers) return

    updateLineNumbers()

    const scrollDisp = terminal.onScroll(() => updateLineNumbers())
    const writeDisp = terminal.onWriteParsed(() => updateLineNumbers())
    const resizeDisp = terminal.onResize(() => updateLineNumbers())

    return () => {
      scrollDisp.dispose()
      writeDisp.dispose()
      resizeDisp.dispose()
    }
  }, [showLineNumbers, updateLineNumbers])

  // Apply AI highlights when they change
  useEffect(() => {
    if (!highlightEngineRef.current || aiHighlights.length === 0) return
    const terminal = terminalRef.current
    if (!terminal) return

    // Resolve AI highlight positions against the xterm buffer.
    // Search a bounded range (viewport ± margin) rather than the entire buffer.
    const buffer = terminal.buffer.active
    const adHocHighlights: AdHocHighlight[] = []
    const resolvedHighlights: Array<{ line: number; start: number; end: number; tooltip?: string; reason?: string; text?: string; highlightType?: string }> = []

    const searchMargin = 100
    const searchEnd = Math.min(buffer.length, buffer.viewportY + terminal.rows + searchMargin)
    const searchStart = Math.max(0, buffer.viewportY - searchMargin)
    const usedPositions = new Set<string>()

    for (const h of aiHighlights) {
      if (!h.text || h.text.trim().length === 0) continue

      let foundLine = -1
      let foundStart = -1
      for (let i = searchEnd - 1; i >= searchStart; i--) {
        const line = buffer.getLine(i)
        if (!line) continue
        const lineText = line.translateToString(true)
        let searchFrom = 0
        while (searchFrom < lineText.length) {
          const pos = lineText.indexOf(h.text, searchFrom)
          if (pos === -1) break
          const key = `${i}:${pos}`
          if (!usedPositions.has(key)) {
            foundLine = i
            foundStart = pos
            break
          }
          searchFrom = pos + 1
        }
        if (foundLine !== -1) break
      }

      if (foundLine === -1) continue
      usedPositions.add(`${foundLine}:${foundStart}`)

      const color = getHighlightTypeColor(h.type)
      const tooltipText = `${h.type.toUpperCase()}: ${h.reason} (${Math.round(h.confidence * 100)}% confidence)`

      const resolvedEntry = {
        line: foundLine,
        start: foundStart,
        end: foundStart + h.text.length,
        tooltip: aiOverlordActive ? `${tooltipText}\n\nClick to discuss with AI` : tooltipText,
        reason: h.reason,
        text: h.text,
        highlightType: h.type,
      }
      resolvedHighlights.push(resolvedEntry)

      adHocHighlights.push({
        line: foundLine,
        start: foundStart,
        end: foundStart + h.text.length,
        foreground: color,
        background: undefined,
        className: aiOverlordActive ? `ai-overlord-highlight ai-overlord-${h.type}` : `ai-highlight-${h.type}`,
        tooltip: resolvedEntry.tooltip,
      })
    }

    resolvedHighlightsRef.current = resolvedHighlights

    if (adHocHighlights.length > 0) {
      highlightEngineRef.current.applyAdHocHighlights(adHocHighlights)
    }
  }, [aiHighlights, aiOverlordActive, onOverlordAnnotationClick])

  // Ref for resolved highlight positions (used by mousemove hover and click)
  const resolvedHighlightsRef = useRef<Array<{ line: number; start: number; end: number; tooltip?: string; highlightType?: string; reason?: string; text?: string }>>([])

  // Overlord hover popup — uses mousemove on the terminal container since
  // xterm's canvas captures events and decoration elements can't receive hover.
  useEffect(() => {
    const container = containerRef.current
    const terminal = terminalRef.current
    if (!container || !terminal || !aiOverlordActive) return

    let popup: HTMLElement | null = null
    let currentHighlightKey = ''
    let lastMoveTime = 0

    const handleMouseMove = (e: MouseEvent) => {
      const highlights = resolvedHighlightsRef.current
      if (highlights.length === 0) {
        if (popup) { popup.remove(); popup = null; currentHighlightKey = '' }
        return
      }

      // Throttle: skip if less than 50ms since last execution
      const now = Date.now()
      if (now - lastMoveTime < 50) return
      lastMoveTime = now

      // Convert mouse position to terminal row/col
      const cell = mouseToTerminalCell(e, terminal, container)
      if (!cell) return

      // Check if cursor is over any highlight
      let hoveredHighlight: typeof highlights[0] | null = null
      for (const h of highlights) {
        if (h.line === cell.absoluteLine && cell.col >= h.start && cell.col < h.end) {
          hoveredHighlight = h
          break
        }
      }

      if (!hoveredHighlight) {
        if (popup) { popup.remove(); popup = null; currentHighlightKey = '' }
        return
      }

      const key = `${hoveredHighlight.line}:${hoveredHighlight.start}`
      if (key === currentHighlightKey && popup) return // Already showing
      currentHighlightKey = key

      const tooltipText = hoveredHighlight.tooltip || ''
      if (!tooltipText) {
        if (popup) { popup.remove(); popup = null }
        return
      }

      // Parse tooltip: "TYPE: reason (confidence)\n\nClick to discuss"
      const mainLine = tooltipText.split('\n')[0] || ''
      const colonIdx = mainLine.indexOf(':')
      const highlightType = colonIdx > 0 ? mainLine.slice(0, colonIdx).trim() : 'INFO'
      const reason = colonIdx > 0 ? mainLine.slice(colonIdx + 1).trim() : mainLine
      const typeColors: Record<string, string> = {
        'ERROR': '#ff6b6b', 'WARNING': '#ffa726', 'SECURITY': '#ba68c8',
        'ANOMALY': '#4dd0e1', 'INFO': '#64b5f6'
      }
      const typeColor = typeColors[highlightType] || '#64b5f6'

      const escHtml = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

      // Reuse existing popup element or create one
      if (!popup) {
        popup = document.createElement('div')
        popup.className = 'ai-overlord-popup'
        document.body.appendChild(popup)
      }
      popup.innerHTML = `
        <div class="ai-overlord-popup-header">
          <span class="ai-overlord-popup-badge" style="background:${typeColor}">${escHtml(highlightType)}</span>
          <span class="ai-overlord-popup-label">AI Overlord</span>
        </div>
        <div class="ai-overlord-popup-body">${escHtml(reason)}</div>
        <div class="ai-overlord-popup-footer">Click to discuss with AI</div>
      `

      // Position above the hovered cell
      const screenRect = container.querySelector('.xterm-screen')?.getBoundingClientRect()
      if (!screenRect) return
      const cellW = screenRect.width / terminal.cols
      const cellH = screenRect.height / terminal.rows
      const popupX = screenRect.left + hoveredHighlight.start * cellW
      const popupY = screenRect.top + cell.row * cellH - 8
      popup.style.left = `${popupX}px`
      popup.style.top = `${popupY}px`
      popup.style.borderLeft = `3px solid ${typeColor}`
    }

    const handleMouseLeave = () => {
      if (popup) { popup.remove(); popup = null; currentHighlightKey = '' }
    }

    const handleClick = (e: MouseEvent) => {
      const highlights = resolvedHighlightsRef.current
      if (highlights.length === 0) return

      const cell = mouseToTerminalCell(e, terminal, container)
      if (!cell) return

      for (const h of highlights) {
        if (h.line === cell.absoluteLine && cell.col >= h.start && cell.col < h.end && h.reason && h.text && h.highlightType) {
          onOverlordAnnotationClick?.(h.reason, h.text, h.highlightType)
          if (popup) { popup.remove(); popup = null; currentHighlightKey = '' }
          break
        }
      }
    }

    container.addEventListener('mousemove', handleMouseMove)
    container.addEventListener('mouseleave', handleMouseLeave)
    container.addEventListener('click', handleClick)
    return () => {
      container.removeEventListener('mousemove', handleMouseMove)
      container.removeEventListener('mouseleave', handleMouseLeave)
      container.removeEventListener('click', handleClick)
      if (popup) { popup.remove(); popup = null }
    }
  }, [aiOverlordActive, onOverlordAnnotationClick])

  // NOTE: the legacy single-line MAC/IP hover popup (manual mousemove → OUI/DNS
  // lookup) has been superseded by the richer link-provider enrichment popover
  // installed in the terminal-init effect above (installEnrichPopup). The OUI
  // vendor + reverse-DNS lookups are now built-in enrichment sources.

  // When overlord is toggled on, analyze existing terminal buffer
  // When disabled, clear highlights
  useEffect(() => {
    if (aiOverlordActive) {
      // Delay slightly to ensure the hook's enabled state has propagated
      const timer = setTimeout(() => {
        const terminal = terminalRef.current
        if (terminal) {
          const buffer = terminal.buffer.active
          const lines: string[] = []
          const lineCount = Math.min(buffer.length, 200)
          for (let i = Math.max(0, buffer.length - lineCount); i < buffer.length; i++) {
            const line = buffer.getLine(i)
            if (line) lines.push(line.translateToString(true))
          }
          const bufferText = lines.join('\n')
          if (bufferText.trim()) {
            addAIOutputRef.current?.(bufferText)
          }
        }
      }, 500)
      return () => clearTimeout(timer)
    } else {
      clearAIHighlights()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiOverlordActive])

  // Set up next-step suggestion callback (Phase 24)
  useEffect(() => {
    setNextStepCallback((command: string) => {
      // Type the command into terminal
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'Input',
          data: command
        }))
        // Update the command buffer
        commandLineBufferRef.current = command
      }
    })
  }, [setNextStepCallback])

  // Handler for using a next-step suggestion
  const handleUseNextStepSuggestion = useCallback((command: string) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- useNextStepSuggestion is a plain callback from useNextStepSuggestions(), not a React hook; the use* name trips the rule.
    useNextStepSuggestion(command)
    setShowNextStepSuggestions(false)
  }, [useNextStepSuggestion])

  // Handler for dismissing next-step suggestions
  const handleDismissNextStepSuggestions = useCallback(() => {
    clearNextStepSuggestions()
    setShowNextStepSuggestions(false)
  }, [clearNextStepSuggestions])

  // Register broadcast listener for multi-send
  useEffect(() => {
    if (!onRegisterBroadcastListener) return

    const handleBroadcast = (input: string, _sourceId: string) => {
      // Send the input to this terminal's WebSocket
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'Input',
          data: input
        }))
      }
    }

    const unregister = onRegisterBroadcastListener(id, handleBroadcast)
    return unregister
  }, [id, onRegisterBroadcastListener])

  // Close right-click context menu
  const closeContextMenu = useCallback(() => {
    setContextMenuPosition(null)
    setContextMenuText('')
    setContextMenuDetection(null)
  }, [])

  // Handle accepting an autocomplete suggestion
  const handleSelectSuggestion = useCallback((command: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return

    // Calculate what to send: the remaining part of the command after current input
    const remaining = command.slice(currentInput.length)

    // Send the remaining characters to complete the command
    if (remaining) {
      wsRef.current.send(JSON.stringify({
        type: 'Input',
        data: remaining
      }))
    }

    // Clear suggestions and input tracking
    clearSuggestions()
    setCurrentInput('')
  }, [currentInput, clearSuggestions])

  // Handle Tab key for accepting inline suggestion
  useEffect(() => {
    const terminalEl = containerRef.current
    if (!terminalEl) return

    const handleAutocompleteKeys = (e: KeyboardEvent) => {
      if (suggestions.length === 0) return

      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        // Accept first suggestion (inline ghost text)
        const suggestion = suggestions[0]
        if (suggestion) {
          handleSelectSuggestion(suggestion.command)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        clearSuggestions()
        setCurrentInput('')
      }
    }

    terminalEl.addEventListener('keydown', handleAutocompleteKeys, true)
    return () => {
      terminalEl.removeEventListener('keydown', handleAutocompleteKeys, true)
    }
  }, [suggestions, handleSelectSuggestion, clearSuggestions])

  // Handler to open floating AI chat at right-click position
  const handleAskAI = useCallback(() => {
    if (contextMenuPosition && onAIFloatingChat) {
      // Position to the right of click, with some offset
      onAIFloatingChat({
        x: contextMenuPosition.x + 10,
        y: contextMenuPosition.y
      }, sessionId, sessionName, contextMenuText || undefined)
    }
  }, [contextMenuPosition, onAIFloatingChat, sessionId, sessionName, contextMenuText])

  // Session context popup handlers
  const handleContextPopupDismiss = useCallback(() => {
    setShowContextPopup(false)
  }, [])

  const handleContextPopupAskAI = useCallback((context: SessionContextType) => {
    setShowContextPopup(false)
    onAskAIContextRef.current?.(context)
  }, [])

  const handleContextPopupViewAll = useCallback(() => {
    setShowContextPopup(false)
    onViewAllContextsRef.current?.()
  }, [])

  // Detection action handlers for context menu
  const handleDetectionRunCommand = useCallback((cmd: string) => {
    if (isEnterpriseMode) {
      enterpriseSendDataRef.current?.(cmd + '\r')
    } else if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'Input', data: cmd + '\r' }))
    }
  }, [isEnterpriseMode])

  const handleDetectionRunQuickAction = useCallback(async (
    quickActionId: string, variableName: string, value: string
  ) => {
    try {
      const result = await executeQuickAction(quickActionId, { [variableName]: value })
      if (result.success) {
        const display = result.extracted_value != null
          ? (typeof result.extracted_value === 'string' ? result.extracted_value : JSON.stringify(result.extracted_value))
          : `HTTP ${result.status_code}`

        // Try to match the extracted value against a session name for a "Connect" link
        let action: { label: string; onClick: () => void } | undefined
        if (typeof result.extracted_value === 'string' && result.extracted_value.length > 0) {
          try {
            const sessions = await listSessions()
            const hostname = result.extracted_value
            const match = sessions.find(s =>
              s.name.toLowerCase() === hostname.toLowerCase()
              || s.host.toLowerCase() === hostname.toLowerCase()
            )
            if (match) {
              action = {
                label: `Connect →`,
                onClick: () => window.dispatchEvent(
                  new CustomEvent('netstacks:open-session', { detail: { sessionId: match.id } })
                ),
              }
            }
          } catch { /* ignore session lookup failures */ }
        }

        showToast(`${value} → ${display}`, 'success', 8000, action)
      } else {
        showToast(`${value} → ${result.error || `HTTP ${result.status_code}`}`, 'error', 8000)
      }
    } catch (err) {
      showToast(`Failed: ${getErrorMessage(err)}`, 'error', 5000)
    }
  }, [])

  const handleDetectionRunScript = useCallback(async (scriptId: string, detectedValue: string | null) => {
    try {
      // Analyze script to find the param name (if any)
      let scriptName = 'Script Output';
      let mainArgs: string | undefined;
      try {
        const analysis = await analyzeScript(scriptId);
        if (detectedValue && analysis.has_main && analysis.params.length === 1) {
          mainArgs = JSON.stringify({ [analysis.params[0].name]: detectedValue });
        }
      } catch { /* no params, run without args */ }

      // Get script name for the doc title
      try {
        const script = await getScript(scriptId);
        scriptName = script.name;
      } catch { /* use default */ }

      let rawResult: string;
      if (isEnterpriseMode) {
        // Enterprise mode: use polling-based execution (no SSE stream on controller)
        const result = await runScript(scriptId, { main_args: mainArgs });
        rawResult = ('stdout' in result ? result.stdout : '').trim();
        if ('stderr' in result && result.stderr) {
          showToast(result.stderr, 'error', 5000);
        }
      } else {
        // Standalone mode: use SSE streaming
        const output: string[] = [];
        await runScriptStream(scriptId, { main_args: mainArgs }, (event: ScriptStreamEvent) => {
          if (event.event === 'stdout') output.push(event.data);
          if (event.event === 'error') showToast(event.data, 'error', 5000);
        });
        rawResult = output.join('\n').trim();
      }
      if (!rawResult) {
        showToast('Script completed', 'success', 5000);
        return;
      }

      // Detect JSON output and pretty-print it
      let result = rawResult;
      let isJson = false;
      try {
        const parsed = JSON.parse(rawResult);
        if (typeof parsed === 'object' && parsed !== null) {
          result = JSON.stringify(parsed, null, 2);
          isJson = true;
        }
      } catch { /* not JSON, use raw */ }

      // Try to match output against sessions for a "Connect" link
      let sessionAction: { label: string; onClick: () => void } | undefined;
      try {
        const sessions = await listSessions();
        const lines = rawResult.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          const match = sessions.find(s =>
            s.name.toLowerCase() === line.toLowerCase()
            || s.host.toLowerCase() === line.toLowerCase()
          );
          if (match) {
            sessionAction = {
              label: `Connect to ${match.name} →`,
              onClick: () => window.dispatchEvent(
                new CustomEvent('netstacks:open-session', { detail: { sessionId: match.id } })
              ),
            };
            break;
          }
        }
      } catch { /* ignore session lookup failures */ }

      const openInTab = () => {
        const docTitle = detectedValue
          ? `${scriptName} - ${detectedValue}`
          : `${scriptName} - ${new Date().toLocaleTimeString()}`;
        window.dispatchEvent(new CustomEvent('netstacks:open-script-output', {
          detail: { title: docTitle, content: result, contentType: isJson ? 'json' : 'text' },
        }));
      };

      const isShort = result.length < 120 && !result.includes('\n');
      const prefix = detectedValue ? <><strong>{detectedValue}</strong>{' → '}</> : null;

      const message = (
        <span className={isShort ? 'toast-inline-content' : 'toast-rich-content'}>
          <span className="toast-result-text">
            {prefix}
            {isShort ? result : <pre className="toast-script-output">{result}</pre>}
          </span>
          <span className="toast-result-actions">
            <button
              className="toast-open-tab"
              title="Open in tab"
              onClick={(e) => { e.stopPropagation(); openInTab(); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <polyline points="15,3 21,3 21,9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </button>
            {sessionAction && (
              <button
                className="toast-action"
                onClick={(e) => { e.stopPropagation(); sessionAction!.onClick(); }}
              >
                {sessionAction.label}
              </button>
            )}
          </span>
        </span>
      );
      showToast(message, 'success', isShort ? 8000 : 12000);
    } catch (err) {
      showToast(`Script failed: ${getErrorMessage(err)}`, 'error', 5000);
    }
  }, [])

  const handleDetectionCopy = useCallback((text: string) => {
    void copyToClipboard(text)
  }, [])

  const handleDetectionAIAction = useCallback((action: string, context: string) => {
    // Open AI chat with detection context
    if (contextMenuPosition && onAIFloatingChat) {
      onAIFloatingChat(
        { x: contextMenuPosition.x + 10, y: contextMenuPosition.y },
        sessionId,
        sessionName,
        context
      )
    }
    // Trigger AI action with context
    onAIAction?.(action, context, contextMenuPosition || { x: 100, y: 100 }, sessionId, sessionName)
  }, [contextMenuPosition, onAIFloatingChat, onAIAction, sessionId, sessionName])

  // SNMP Quick-Look handler for interface detections
  const handleSnmpQuickLook = useCallback((interfaceName: string) => {
    if (!sessionHostRef.current || !sessionProfileIdRef.current) return
    setSnmpQuickLook({
      interfaceName,
      position: contextMenuPosition || { x: 0, y: 0 },
    })
  }, [contextMenuPosition])

  // Command safety dialog handlers (Phase 24: Smart Warnings)
  const handleSafetyProceed = useCallback(() => {
    if (pendingSafetyAnalysis && wsRef.current?.readyState === WebSocket.OPEN) {
      // Send the command that was pending
      const cmd = pendingSafetyAnalysis.command + '\r'
      wsRef.current.send(JSON.stringify({ type: 'Input', data: cmd }))
      commandLineBufferRef.current = ''
      // Clear suggestions if inline suggestions enabled
      if (settingsRef.current['ai.inlineSuggestions']) {
        clearSuggestionsRef.current()
        setCurrentInput('')
      }
    }
    clearSafetyPending()
  }, [pendingSafetyAnalysis, clearSafetyPending])

  const handleSafetyCancel = useCallback(() => {
    // User cancelled - clear the command line buffer but don't clear terminal
    commandLineBufferRef.current = ''
    clearSafetyPending()
    // Re-focus terminal
    terminalRef.current?.focus()
  }, [clearSafetyPending])

  const handleSafetyUseAlternative = useCallback((altCommand: string) => {
    // Replace current command with alternative
    // Clear pending state first
    clearSafetyPending()
    // Clear current command buffer
    commandLineBufferRef.current = ''
    // Type the alternative command to the terminal
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // We just clear and start fresh - the user can then press Enter to send
      // Note: The alternative is just displayed, user must press Enter to execute
      wsRef.current.send(JSON.stringify({ type: 'Input', data: altCommand }))
      commandLineBufferRef.current = altCommand
    }
    // Re-focus terminal
    terminalRef.current?.focus()
  }, [clearSafetyPending])

  // Get menu items for the right-click context menu
  // Include session info when triggering AI actions so AI knows which terminal to use
  const aiMenuItems = getAIMenuItems(
    contextMenuText,
    () => onAIAction?.('explain', contextMenuText, contextMenuPosition || { x: 100, y: 100 }, sessionId, sessionName),
    () => onAIAction?.('fix', contextMenuText, contextMenuPosition || { x: 100, y: 100 }, sessionId, sessionName),
    () => onAIAction?.('suggest', contextMenuText, contextMenuPosition || { x: 100, y: 100 }, sessionId, sessionName),
    () => { void copyToClipboard(contextMenuText) },
    () => pasteFromClipboardRef.current(),
    handleAskAI,
    sessionId && onSessionSettings ? onSessionSettings : undefined
  )

  // Add logging menu items
  const loggingMenuItems = [
    {
      id: 'divider-logging',
      label: '',
      divider: true,
      action: () => {}
    },
    isLogging ? {
      id: 'stop-logging',
      label: 'Stop Session Logging',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ),
      action: () => stopLogging()
    } : {
      id: 'start-logging',
      label: 'Start Session Logging',
      icon: (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="8" />
        </svg>
      ),
      action: () => startLogging('plain', false)
    },
  ]

  // Add recording menu items (asciicast format)
  const handleStartRecordingClick = () => {
    startRecording()
  }

  const recordingMenuItems = [
    isRecordingActive ? {
      id: 'stop-recording',
      label: 'Stop Recording',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ),
      action: () => stopRecording()
    } : {
      id: 'start-recording',
      label: 'Start Recording',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="3" fill="currentColor" />
        </svg>
      ),
      action: handleStartRecordingClick
    },
  ]

  // Add save to docs menu item (retroactive capture)
  const saveToDocsMenuItems = [
    {
      id: 'save-to-docs',
      label: 'Save Output to Docs...',
      shortcut: displayShortcut('⇧⌘S'),
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="18" x2="12" y2="12" />
          <polyline points="9 15 12 12 15 15" />
        </svg>
      ),
      action: () => openSaveToDocsDialog()
    },
  ]

  // Traceroute visualization menu items (only show if selected text looks like traceroute output)
  const isTracerouteOutput = contextMenuText && TracerouteParser.isTracerouteOutput(contextMenuText)
  const tracerouteMenuItems = isTracerouteOutput && onVisualizeTraceroute ? [
    {
      id: 'divider-traceroute',
      label: '',
      divider: true,
      action: () => {}
    },
    {
      id: 'visualize-traceroute',
      label: 'Visualize Traceroute / MTR',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
          <path d="M7 12h3M14 12h3" strokeDasharray="2 2" />
        </svg>
      ),
      action: () => onVisualizeTraceroute(contextMenuText)
    }
  ] : []

  // Build context menu items - detection-specific if clicked on detection, else standard AI menu
  const customCommandItems = getCustomCommandMenuItems(
    customCommandsRef.current,
    contextMenuDetection,
    handleDetectionRunCommand,
    handleDetectionRunQuickAction,
    handleDetectionRunScript,
  )

  // Force-click custom actions: custom commands flagged "Enable in Force Touch
  // Menu", bound to run against the selection using the same execution paths as
  // the right-click menu. Built here (handlers in scope) and surfaced to the
  // Force Touch popover via onForceClick.
  buildForceActionsRef.current = (selection: string) =>
    customCommandsRef.current
      .filter(c => {
        if (!c.show_in_force_click || !c.enabled) return false
        // "On Detection" actions (detection_types set) consume the selected
        // text, so only surface them when there's actually a selection to pass.
        // "Always Show" (static) actions are fine with or without a selection.
        if (c.detection_types) return selection.trim().length > 0
        return true
      })
      .map(c => ({
        id: `cc-${c.id}`,
        label: c.name,
        run: () => {
          if (c.action_type === 'script' && c.script_id) {
            handleDetectionRunScript(c.script_id, selection || null)
          } else if (c.action_type === 'quick_action' && c.quick_action_id && c.quick_action_variable) {
            handleDetectionRunQuickAction(c.quick_action_id, c.quick_action_variable, selection)
          } else {
            handleDetectionRunCommand(c.command.replace(/\{value\}/g, selection))
          }
        },
      }))

  const contextMenuItems = contextMenuDetection
    ? [...getDetectionMenuItems(
        contextMenuDetection,
        handleDetectionRunCommand,
        handleDetectionCopy,
        handleDetectionAIAction,
        sessionHostRef.current && sessionProfileIdRef.current ? handleSnmpQuickLook : undefined
      ), ...(useCapabilitiesStore.getState().hasFeature('local_integrations') ? customCommandItems : [])]
    : [...aiMenuItems, ...loggingMenuItems, ...(useCapabilitiesStore.getState().hasFeature('local_session_recording') ? recordingMenuItems : []), ...saveToDocsMenuItems, ...tracerouteMenuItems, ...(useCapabilitiesStore.getState().hasFeature('local_integrations') ? customCommandItems : [])]

  return (
    <div className="terminal-container" data-testid="terminal-container" data-terminal-id={id}>
      <FindBar
        visible={showFindBar}
        onSearch={handleSearch}
        onNext={handleSearchNext}
        onPrev={handleSearchPrev}
        onClose={handleCloseFindBar}
        matchCount={searchMatchCount}
        currentMatch={currentSearchMatch}
      />
      {/* Logging indicator */}
      {isLogging && (
        <div className="terminal-logging-indicator" title={logFilePath || 'Recording session'}>
          <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10">
            <circle cx="12" cy="12" r="8" />
          </svg>
          <span>LOG</span>
        </div>
      )}
      {/* Recording indicator (asciicast) */}
      {isRecordingActive && (
        <div className="terminal-recording-indicator" title="Recording terminal session">
          <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10">
            <circle cx="12" cy="12" r="8" />
          </svg>
          <span>REC</span>
        </div>
      )}
      {/* Enterprise "via Controller" badge */}
      {isEnterpriseMode && (
        <div className="terminal-proxy-badge" title="Connected via Controller (Enterprise Mode)">
          via {instanceName}
        </div>
      )}
      {/* Jump badge — shows the resolved jump (host or session) for SSH
          connections that went through one. Stacks below the Controller
          pill when both are present so they don't overlap. */}
      {viaJumpName && (
        <div
          className="terminal-jump-badge"
          style={isEnterpriseMode ? { top: 36 } : undefined}
          title={`Connected through jump: ${viaJumpName}`}
        >
          via {viaJumpName}
        </div>
      )}
      {/* Save to Docs dialog */}
      {showSaveDialog && (
        <div className="terminal-save-dialog-overlay" onClick={closeSaveDialog}>
          <div className="terminal-save-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="terminal-save-dialog-header">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span>Save Terminal Output to Docs</span>
              <button className="terminal-save-dialog-close" onClick={closeSaveDialog}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="terminal-save-dialog-content">
              <label>Document Path</label>
              <div className="terminal-save-dialog-input-wrapper">
                <span className="terminal-save-dialog-prefix">docs/</span>
                <input
                  ref={saveDialogInputRef}
                  type="text"
                  value={saveDialogPath}
                  onChange={(e) => setSaveDialogPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSaveDialogSubmit()
                    } else if (e.key === 'Escape') {
                      closeSaveDialog()
                    }
                  }}
                  placeholder="configs/router1-config"
                />
              </div>
              <div className="terminal-save-dialog-hint">
                Use / to create folders (e.g., configs/site-a/router1)
              </div>
              <div className="terminal-save-dialog-preview">
                <span>{saveDialogContent.split('\n').length} lines</span>
                <span>{saveDialogContent.length.toLocaleString()} chars</span>
              </div>
            </div>
            <div className="terminal-save-dialog-actions">
              <button className="terminal-save-dialog-cancel" onClick={closeSaveDialog}>
                Cancel
              </button>
              <button className="terminal-save-dialog-submit" onClick={handleSaveDialogSubmit}>
                Save to Docs
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Capture mode indicator (>> docs/path) */}
      {captureMode && (
        <div className="terminal-capture-indicator">
          <div className="terminal-capture-indicator-pulse" />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="terminal-capture-path">
            {captureMode.mode === 'append' ? '>>' : '>'} docs/{captureMode.docPath}
          </span>
          <span className="terminal-capture-bytes">
            {captureMode.byteCount < 1024
              ? `${captureMode.byteCount} B`
              : captureMode.byteCount < 1048576
                ? `${(captureMode.byteCount / 1024).toFixed(1)} KB`
                : `${(captureMode.byteCount / 1048576).toFixed(1)} MB`}
          </span>
          <button
            className="terminal-capture-complete"
            onClick={() => completeCapture()}
            title="Complete capture and save (Ctrl+D)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </button>
          <button
            className="terminal-capture-cancel"
            onClick={() => cancelCapture()}
            title="Cancel capture (Esc)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
      <div className="terminal-content-wrapper">
        <div className="terminal-content-row">
          {showLineNumbers && (
            <div className="terminal-line-numbers" ref={gutterRef} />
          )}
          <div className="terminal-content" ref={containerRef} />
        </div>
        {settings['ai.inlineSuggestions'] && (
          <InlineSuggestion
            suggestion={suggestions[0]?.command || null}
            currentInput={currentInput}
            position={cursorPosition}
            isLoading={isLoadingSuggestions}
          />
        )}
        {/* Command safety warning indicator while typing */}
        {safetyAnalysis && safetyAnalysis.level !== 'safe' && (
          <CommandWarningIndicator
            level={safetyAnalysis.level}
            message={safetyAnalysis.warnings[0]?.message}
            visible={true}
          />
        )}
        {/* Next-step suggestions after command execution (Phase 24) */}
        <NextStepSuggestions
          suggestions={nextStepSuggestions}
          loading={nextStepLoading}
          onUseSuggestion={handleUseNextStepSuggestion}
          onDismiss={handleDismissNextStepSuggestions}
          visible={showNextStepSuggestions}
        />
      </div>
      <ReconnectOverlay
        visible={showReconnectOverlay}
        countdown={countdown}
        attemptCount={attemptCount}
        onReconnectNow={() => reconnectFnRef.current?.()}
        onCancel={handleCancel}
        onDisableAutoReconnect={handleDisableAutoReconnect}
        autoReconnectDisabled={autoReconnectDisabled}
        maxAttempts={isEnterpriseMode ? maxReconnectAttempts : undefined}
      />
      <ContextMenu
        position={contextMenuPosition}
        items={contextMenuItems}
        onClose={closeContextMenu}
      />
      {/* SNMP Interface Quick-Look popover */}
      {snmpQuickLook && sessionHostRef.current && sessionProfileIdRef.current && (
        <InterfaceSnmpQuickLook
          interfaceName={snmpQuickLook.interfaceName}
          deviceHost={sessionHostRef.current}
          profileId={sessionProfileIdRef.current}
          jumpHostId={sessionJumpHostIdRef.current}
          jumpSessionId={sessionJumpSessionIdRef.current}
          position={snmpQuickLook.position}
          onClose={() => setSnmpQuickLook(null)}
        />
      )}
      {/* Session context popup - shown when connecting to device with existing context */}
      {showContextPopup && sessionContexts.length > 0 && (
        <SessionContextPopup
          contexts={sessionContexts}
          sessionName={sessionName || 'Session'}
          onDismiss={handleContextPopupDismiss}
          onAskAI={handleContextPopupAskAI}
          onViewAll={handleContextPopupViewAll}
        />
      )}
      {/* Command safety warning dialog - shown when attempting to execute dangerous command */}
      {pendingSafetyAnalysis && (
        <CommandWarningDialog
          analysis={pendingSafetyAnalysis}
          onProceed={handleSafetyProceed}
          onCancel={handleSafetyCancel}
          onUseAlternative={handleSafetyUseAlternative}
        />
      )}
    </div>
  )
})

export default memo(Terminal)
