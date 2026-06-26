import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import './StatusBar.css'
import { getRemoteAgentHost } from '../api/client'
import { useAgentTasksStore } from '../hooks/useAgentTasks'
import ContextMenu from './ContextMenu'
import { useContextMenu } from '../hooks/useContextMenu'
import {
  type StatusBarSettings,
  loadStatusBarSettings,
  getStatusBarColors,
  STATUS_BAR_SETTINGS_CHANGED,
} from '../api/statusBarSettings'
import QuickPromptsMenu from './QuickPromptsMenu'
import type { QuickPrompt } from '../api/quickPrompts'
import SnippetsMenu from './SnippetsMenu'
import type { GlobalSnippet } from '../api/snippets'
import QuickCallsMenu from './QuickCallsMenu'
import type { QuickAction } from '../api/quickActions'
import TroubleshootingIndicator from './TroubleshootingIndicator'
import { useTunnelStore } from '../stores/tunnelStore'
import TunnelPopover from './TunnelPopover'
import { formatTunnelSpec } from '../api/tunnels'
import { useMopExecutionOptional } from '../contexts/MopExecutionContext'
import type { TroubleshootingSession } from '../types/troubleshooting'
import { useMode } from '../hooks/useMode'
import { useAuthStore } from '../stores/authStore'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'
import type { CertStatus } from '../api/cert'
import { listMcpServers, connectMcpServer, type McpServer } from '../api/mcp'

// SVG Icons
const Icons = {
  connection: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <circle cx="12" cy="12" r="10"/>
      <path d="M2 12h20"/>
      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
    </svg>
  ),
  terminal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="4 17 10 11 4 5"/>
      <line x1="12" y1="19" x2="20" y2="19"/>
    </svg>
  ),
  agent: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10.5H13z"/>
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  ),
  ai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M12 2a10 10 0 0110 10c0 5.52-4.48 10-10 10S2 17.52 2 12 6.48 2 12 2z"/>
      <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
      <circle cx="9" cy="10" r="1" fill="currentColor"/>
      <circle cx="15" cy="10" r="1" fill="currentColor"/>
    </svg>
  ),
  aiActive: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M12 3l1.5 3.5L17 8l-3.5 1.5L12 13l-1.5-3.5L7 8l3.5-1.5L12 3z" fill="currentColor"/>
      <path d="M19 10l1 2.5L22.5 14 20 15.5 19 18l-1-2.5L15.5 14 18 12.5 19 10z" fill="currentColor"/>
      <path d="M5 16l.75 1.75L7.5 18.5 5.75 19.25 5 21l-.75-1.75L2.5 18.5l1.75-.75L5 16z" fill="currentColor"/>
    </svg>
  ),
  command: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M18 3a3 3 0 00-3 3v12a3 3 0 003 3 3 3 0 003-3 3 3 0 00-3-3H6a3 3 0 00-3 3 3 3 0 003 3 3 3 0 003-3V6a3 3 0 00-3-3 3 3 0 00-3 3 3 3 0 003 3h12a3 3 0 003-3 3 3 0 00-3-3z"/>
    </svg>
  ),
  prompts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  record: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
  controller: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <circle cx="7" cy="10" r="1" fill="currentColor" />
      <circle cx="12" cy="10" r="1" fill="currentColor" />
    </svg>
  ),
  notes: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  ),
  templates: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
  ),
  outputs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  mcp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <rect x="2" y="3" width="20" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <circle cx="15" cy="9" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  snippets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="8" y1="16" x2="12" y2="16" />
    </svg>
  ),
  quickActions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
}

function formatTimeRemaining(expiresAt: string | null): string {
  if (!expiresAt) return 'unknown'
  const remaining = new Date(expiresAt).getTime() - Date.now()
  if (remaining <= 0) return 'expired'
  const hours = Math.floor(remaining / (1000 * 60 * 60))
  const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60))
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export interface StatusBarProps {
  /** Name of the active session (shown in status bar) */
  activeSessionName?: string
  /** Name of the active session's credential profile (shown after session name) */
  activeProfileName?: string
  /** Number of connected sessions */
  connectedCount: number
  /** Background color for the status bar (defaults to VS Code blue) */
  statusBarColor?: string
  /** Callback when AI Overlord toggle is clicked */
  onToggleAIOverlord?: () => void
  /** Whether AI Overlord is currently active */
  aiOverlordActive?: boolean
  /** Callback when command palette button is clicked */
  onOpenCommandPalette?: () => void
  /** Callback when settings button is clicked */
  onOpenSettings?: () => void
  /** Callback when a quick prompt is selected */
  onQuickPromptSelect?: (prompt: QuickPrompt) => void
  /** Callback when "Manage Prompts" is clicked */
  onManagePrompts?: () => void
  /** Active troubleshooting session (if any) */
  troubleshootingSession?: TroubleshootingSession | null
  /** Callback when troubleshooting session should start */
  onStartTroubleshootingSession?: () => void
  /** Callback when troubleshooting session should end */
  onEndTroubleshootingSession?: () => void
  /** Callback when topology should be attached to session */
  onAttachTroubleshootingTopology?: () => void
  /** Current active view (used to hide Quick Look in docs view) */
  activeView?: string
  /** Callback when a Quick Look button is clicked */
  onQuickLook?: (category: string) => void
  /** Callback when a snippet is selected from the menu */
  onSnippetSelect?: (snippet: GlobalSnippet) => void
  /** Callback when "Manage Snippets" is clicked */
  onManageSnippets?: () => void
  /** Callback when a quick call is selected from the menu */
  onQuickCallSelect?: (call: QuickAction) => void
  /** Callback when "Manage Quick Calls" is clicked */
  onManageQuickCalls?: () => void
  /** Callback when "Manage Tunnels..." is clicked in tunnel popover */
  onManageTunnels?: () => void
  /** Callback when MCP indicator is clicked (opens settings to MCP section) */
  onOpenMcpSettings?: () => void
  /** Whether the active tab is an SSH terminal (for SFTP button visibility) */
  isTerminalFocused?: boolean
  /** Whether the SFTP feature is available */
  canSftp?: boolean
  /** Number of active SFTP connections */
  sftpConnectionCount?: number
  /** Callback when SFTP button is clicked */
  onToggleSftp?: () => void
  /** Callback to open the Scratchpad */
  onOpenScratchpad?: () => void
  /** True if a Scratchpad buffer exists but is minimized — drives a dot
   *  on the status-bar button so users know clicking will restore. */
  scratchpadMinimized?: boolean
  /** Open (or focus) a running agent run as a tab. The item only shows while
   *  one or more agents are running — a persistent handle even if its tab is
   *  closed (the run lives on the backend). */
  onOpenAgentRun?: () => void
}

export default function StatusBar({
  activeSessionName,
  activeProfileName,
  connectedCount,
  statusBarColor = '#007acc',
  activeView,
  onToggleAIOverlord,
  aiOverlordActive = false,
  onOpenCommandPalette,
  onOpenSettings,
  onQuickLook,
  onQuickPromptSelect,
  onManagePrompts,
  onSnippetSelect,
  onManageSnippets,
  onQuickCallSelect,
  onManageQuickCalls,
  troubleshootingSession,
  onStartTroubleshootingSession,
  onEndTroubleshootingSession,
  onAttachTroubleshootingTopology,
  onManageTunnels,
  onOpenMcpSettings,
  isTerminalFocused,
  canSftp,
  sftpConnectionCount,
  onToggleSftp,
  onOpenScratchpad,
  scratchpadMinimized = false,
  onOpenAgentRun,
}: StatusBarProps) {
  const remoteHost = useMemo(() => getRemoteAgentHost(), [])
  // Persistent agent handle: count running agent tasks straight from the store
  // (a primitive selector — safe). The item only appears while > 0.
  const agentRunningCount = useAgentTasksStore((s) => s.tasks.filter((t) => t.status === 'running').length)
  const contextMenu = useContextMenu()
  const mopContext = useMopExecutionOptional()

  // Load and manage status bar settings
  const [settings, setSettings] = useState<StatusBarSettings>(() => loadStatusBarSettings())
  const [showPromptsMenu, setShowPromptsMenu] = useState(false)
  const [showSnippetsMenu, setShowSnippetsMenu] = useState(false)
  const [showQuickCallsMenu, setShowQuickCallsMenu] = useState(false)
  const [showTunnelPopover, setShowTunnelPopover] = useState(false)
  const tunnels = useTunnelStore(state => state.tunnels)
  const getActiveTunnelCount = useTunnelStore(state => state.getActiveTunnelCount)
  const hasFailedTunnels = useTunnelStore(state => state.hasFailedTunnels)
  const getFailedCount = useTunnelStore(state => state.getFailedCount)
  const activeTunnelCount = getActiveTunnelCount()
  const failedTunnels = hasFailedTunnels()
  const failedCount = getFailedCount()
  const [showControllerInfo, setShowControllerInfo] = useState(false)
  const controllerPopoverRef = useRef<HTMLDivElement>(null)
  const controllerBtnRef = useRef<HTMLButtonElement>(null)
  const [permissionsExpanded, setPermissionsExpanded] = useState(false)

  // MCP server status (standalone mode only)
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [showMcpPopover, setShowMcpPopover] = useState(false)
  const [mcpConnecting, setMcpConnecting] = useState<string | null>(null)
  const mcpPopoverRef = useRef<HTMLDivElement>(null)
  const mcpBtnRef = useRef<HTMLButtonElement>(null)

  // Get mode and auth state for Controller indicator
  const { isEnterprise, controllerUrl } = useMode()
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const user = useAuthStore((state) => state.user)
  const capabilities = useCapabilitiesStore(state => state.capabilities)
  const hasFeature = useCapabilitiesStore(state => state.hasFeature)
  const instanceName = capabilities?.instance_name || 'Controller'

  // Certificate status (enterprise mode) — derived from auth store cert info
  const certInfo = useAuthStore((state) => state.certInfo)
  const certStatus: CertStatus | null = (() => {
    if (!isEnterprise || !isAuthenticated || !certInfo) return null
    const validBefore = new Date(certInfo.valid_before)
    const isValid = validBefore.getTime() > Date.now()
    return {
      valid: isValid,
      expires_at: certInfo.valid_before,
      public_key_fingerprint: null,
      error: isValid ? null : 'Certificate expired',
    }
  })()

  // Click-outside handler for controller info popover
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (
      controllerPopoverRef.current &&
      !controllerPopoverRef.current.contains(e.target as Node) &&
      controllerBtnRef.current &&
      !controllerBtnRef.current.contains(e.target as Node)
    ) {
      setShowControllerInfo(false)
      setPermissionsExpanded(false)
    }
  }, [])

  useEffect(() => {
    if (showControllerInfo) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showControllerInfo, handleClickOutside])

  // Listen for settings changes from the settings panel
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'netstacks:statusBarSettings') {
        setSettings(loadStatusBarSettings())
      }
    }
    const handleSettingsChanged = (e: Event) => {
      const customEvent = e as CustomEvent<StatusBarSettings>
      setSettings(customEvent.detail)
    }
    window.addEventListener('storage', handleStorage)
    window.addEventListener(STATUS_BAR_SETTINGS_CHANGED, handleSettingsChanged)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(STATUS_BAR_SETTINGS_CHANGED, handleSettingsChanged)
    }
  }, [])

  // Fetch MCP servers (standalone mode only) with polling
  const fetchMcpServers = useCallback(() => {
    if (isEnterprise) return
    listMcpServers()
      .then(setMcpServers)
      .catch(() => { /* MCP API unavailable */ })
  }, [isEnterprise])

  useEffect(() => {
    fetchMcpServers()
    const interval = setInterval(fetchMcpServers, 15000) // Poll every 15s
    return () => clearInterval(interval)
  }, [fetchMcpServers])

  // Click-outside handler for MCP popover
  useEffect(() => {
    if (!showMcpPopover) return
    const handler = (e: MouseEvent) => {
      if (
        mcpPopoverRef.current && !mcpPopoverRef.current.contains(e.target as Node) &&
        mcpBtnRef.current && !mcpBtnRef.current.contains(e.target as Node)
      ) {
        setShowMcpPopover(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMcpPopover])

  // MCP connect handler
  const handleMcpConnect = useCallback(async (id: string) => {
    setMcpConnecting(id)
    try {
      const updated = await connectMcpServer(id)
      setMcpServers(prev => prev.map(s => s.id === id ? updated : s))
    } catch {
      /* connection failed — will show as disconnected */
    } finally {
      setMcpConnecting(null)
    }
  }, [])

  // MCP derived state
  const mcpTotal = mcpServers.length
  const mcpConnected = mcpServers.filter(s => s.connected).length

  // Get colors based on theme
  const colors = getStatusBarColors(settings)
  const effectiveColor = settings.theme !== 'vscode-blue'
    ? colors.background
    : statusBarColor

  // NOTE: all hooks must stay above the early return below — declaring this
  // useCallback after `if (!settings.enabled) return null` skips it when the
  // status bar is hidden, crashing with "rendered fewer hooks than expected".
  const handleStatusBarContextMenu = useCallback((e: React.MouseEvent) => {
    contextMenu.open(e, [
      {
        id: 'customize',
        label: 'Customize Status Bar',
        icon: Icons.settings,
        action: () => onOpenSettings?.(),
      },
    ])
  }, [contextMenu, onOpenSettings])

  // If status bar is disabled, don't render
  if (!settings.enabled) {
    return null
  }

  // Show Quick Look buttons only when NOT in Docs view, setting is enabled, AND docs feature available
  const showQuickLook = activeView !== 'docs' && settings.showQuickLook && hasFeature('local_docs')

  return (
    <div
      data-testid="status-bar" className={`status-bar${settings.compactMode ? ' compact' : ''}`}
      onContextMenu={handleStatusBarContextMenu}
      style={{
        '--status-bar-bg': effectiveColor,
        '--status-bar-text': colors.text,
        '--status-bar-hover': colors.hoverBackground,
        '--status-bar-accent': colors.accentBackground,
      } as React.CSSProperties}
    >
      {/* Left section: connection status, active session, and troubleshooting indicator */}
      <div className="status-bar-left">
        {/* Remote agent indicator — VS Code style */}
        {remoteHost && (
          <div className="status-bar-remote-indicator" title={`Connected to remote agent on ${remoteHost}`}>
            <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
              <path d="M14 1H2a1 1 0 00-1 1v8a1 1 0 001 1h5v2H5v1h6v-1H9v-2h5a1 1 0 001-1V2a1 1 0 00-1-1zm0 9H2V2h12v8z"/>
            </svg>
            <span>{remoteHost}</span>
          </div>
        )}
        {/* Enterprise mode: Controller connection indicator */}
        {isEnterprise && (
          <div style={{ position: 'relative' }}>
            <button
              ref={controllerBtnRef}
              className="status-bar-item status-bar-item-btn"
              title={isAuthenticated
                ? `Controller: ${controllerUrl || 'Connected'}`
                : 'Controller: Disconnected'
              }
              onClick={() => {
                setShowControllerInfo(!showControllerInfo)
                if (showControllerInfo) setPermissionsExpanded(false)
              }}
            >
              {Icons.controller}
              <span className={`status-bar-connection-dot ${isAuthenticated ? 'connected' : ''}`} />
              <span>{isAuthenticated ? instanceName : 'Disconnected'}</span>
            </button>
            {showControllerInfo && (
              <div ref={controllerPopoverRef} className="controller-info-popover">
                <div className="controller-info-section">
                  <div className="controller-info-heading">User</div>
                  <div className="controller-info-row">
                    <span className="controller-info-label">{user?.display_name || user?.username || '—'}</span>
                    {user?.auth_provider && (
                      <span className="controller-info-badge">{user.auth_provider}</span>
                    )}
                  </div>
                  {user?.email && (
                    <div className="controller-info-detail">{user.email}</div>
                  )}
                </div>

                {user?.org_id && (
                  <div className="controller-info-section">
                    <div className="controller-info-heading">Organization</div>
                    <div className="controller-info-detail">{user.org_id.slice(0, 8)}…</div>
                  </div>
                )}

                {user?.roles && user.roles.length > 0 && (
                  <div className="controller-info-section">
                    <div className="controller-info-heading">Roles</div>
                    <div className="controller-info-badges">
                      {user.roles.map((role) => (
                        <span key={role} className="controller-info-badge">{role}</span>
                      ))}
                    </div>
                  </div>
                )}

                {user?.permissions && user.permissions.length > 0 && (
                  <div className="controller-info-section">
                    <button
                      className="controller-info-heading controller-info-toggle"
                      onClick={() => setPermissionsExpanded(!permissionsExpanded)}
                    >
                      Permissions ({user.permissions.length})
                      <span className={`controller-info-chevron ${permissionsExpanded ? 'expanded' : ''}`}>▸</span>
                    </button>
                    {permissionsExpanded && (
                      <div className="controller-info-permissions">
                        {user.permissions.map((perm) => (
                          <span key={perm} className="controller-info-perm">{perm}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="controller-info-section">
                  <div className="controller-info-heading">Controller</div>
                  <div className="controller-info-row">
                    <span className="controller-info-detail">{controllerUrl || '—'}</span>
                    <span className={`controller-info-status ${isAuthenticated ? 'connected' : ''}`}>
                      {isAuthenticated ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>
                </div>

                <div className="controller-info-section">
                  <div className="controller-info-heading">License</div>
                  <span className="controller-info-badge controller-info-license">
                    {capabilities?.license_tier || 'unknown'}
                  </span>
                </div>

                {(() => {
                  const enabledFeatures = capabilities?.features?.filter(f => f.enabled) ?? [];
                  if (enabledFeatures.length === 0) return null;
                  return (
                    <div className="controller-info-section">
                      <div className="controller-info-heading">Features</div>
                      <div className="controller-info-badges">
                        {enabledFeatures.map((f) => (
                          <span key={f.name} className="controller-info-badge controller-info-feature">{f.name.replace(/_/g, ' ')}</span>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}
        {/* Certificate status indicator (enterprise mode) */}
        {isEnterprise && isAuthenticated && certStatus && (
          <div className="status-bar-item" title={
            certStatus.valid
              ? `Certificate valid until ${certStatus.expires_at}`
              : certStatus.error || 'Certificate not available'
          }>
            <span className={`status-bar-connection-dot ${certStatus.valid ? 'connected' : ''}`} />
            <span>
              {certStatus.valid
                ? `Cert: ${formatTimeRemaining(certStatus.expires_at)}`
                : 'Cert: expired'}
            </span>
          </div>
        )}
        {/* Personal mode: device connection status */}
        {!isEnterprise && settings.showConnectionStatus && (
          <button
            className="status-bar-item status-bar-item-btn"
            title={connectedCount > 0 ? `${connectedCount} connected` : 'No connections'}
          >
            <span className={`status-bar-connection-dot ${connectedCount > 0 ? 'connected' : ''}`} />
            <span>{connectedCount > 0 ? connectedCount : 'No connections'}</span>
          </button>
        )}
        {/* MCP Servers indicator (standalone mode only, AI tools required) */}
        {!isEnterprise && hasFeature('local_ai_tools') && mcpTotal > 0 && (
          <div style={{ position: 'relative' }}>
            <button
              ref={mcpBtnRef}
              className="status-bar-item status-bar-item-btn"
              title={`MCP Servers: ${mcpConnected}/${mcpTotal} connected`}
              onClick={() => setShowMcpPopover(!showMcpPopover)}
            >
              {Icons.mcp}
              <span className={`status-bar-connection-dot ${mcpConnected === mcpTotal ? 'connected' : mcpConnected > 0 ? 'partial' : ''}`} />
              <span>MCP {mcpConnected}/{mcpTotal}</span>
            </button>
            {showMcpPopover && (
              <div ref={mcpPopoverRef} className="mcp-status-popover">
                <div className="mcp-status-heading">MCP Servers</div>
                {mcpServers.map(server => (
                  <div key={server.id} className="mcp-status-server">
                    <span className={`mcp-status-dot ${server.connected ? 'connected' : ''}`} />
                    <span className="mcp-status-name" title={server.name}>{server.name}</span>
                    <span className="mcp-status-transport">{server.transport_type.toUpperCase()}</span>
                    <span className="mcp-status-tools">
                      {server.tools.filter(t => t.enabled).length}/{server.tools.length}
                    </span>
                    {!server.connected && (
                      <button
                        className="mcp-status-connect-btn"
                        onClick={() => handleMcpConnect(server.id)}
                        disabled={mcpConnecting === server.id}
                      >
                        {mcpConnecting === server.id ? '...' : 'Connect'}
                      </button>
                    )}
                  </div>
                ))}
                {onOpenMcpSettings && (
                  <button
                    className="mcp-status-settings-btn"
                    onClick={() => { setShowMcpPopover(false); onOpenMcpSettings() }}
                  >
                    MCP Settings
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {settings.showActiveSession && activeSessionName && (
          <span className="status-bar-item" title={activeProfileName ? `Active Session (Profile: ${activeProfileName})` : 'Active Session'}>
            {Icons.terminal}
            <span>{activeSessionName}{activeProfileName && <span style={{ opacity: 0.7 }}> as {activeProfileName}</span>}</span>
          </span>
        )}
        {/* Session tunnel forward dots */}
        {activeSessionName && tunnels.some(t => t.id.startsWith('session:')) && (
          <span className="status-bar-tunnel-dots">
            {tunnels
              .filter(t => t.id.startsWith('session:'))
              .map(t => (
                <span
                  key={t.id}
                  className={`status-bar-tunnel-dot ${t.status}`}
                  title={`${formatTunnelSpec(t)} (${t.status})`}
                />
              ))
            }
            <span className="status-bar-tunnel-dots-label">fwd</span>
          </span>
        )}
        {isTerminalFocused && canSftp && onToggleSftp && (
          <>
            <span className="status-bar-divider" />
            <button
              className="status-bar-item status-bar-item-btn"
              onClick={onToggleSftp}
              title="SFTP File Browser"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                <path d="M14.5 3H7.71l-.85-.85A.5.5 0 006.5 2h-5a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-10a.5.5 0 00-.5-.5z" />
              </svg>
              <span>SFTP{sftpConnectionCount && sftpConnectionCount > 0 ? ` (${sftpConnectionCount})` : ''}</span>
            </button>
          </>
        )}
        {/* Troubleshooting: start button when no session, indicator when active */}
        {!troubleshootingSession && onStartTroubleshootingSession && hasFeature('local_session_recording') && (
          <>
            <span className="status-bar-divider" />
            <button
              className="status-bar-item status-bar-item-btn status-bar-troubleshoot-start"
              onClick={onStartTroubleshootingSession}
              title="Start Troubleshooting Session (Cmd+Shift+T)"
            >
              {Icons.record}
              <span>Troubleshoot</span>
            </button>
          </>
        )}
        {troubleshootingSession && onEndTroubleshootingSession && onAttachTroubleshootingTopology && hasFeature('local_session_recording') && (
          <>
            <span className="status-bar-divider" />
            <TroubleshootingIndicator
              session={troubleshootingSession}
              onEndSession={onEndTroubleshootingSession}
              onAttachTopology={onAttachTroubleshootingTopology}
            />
          </>
        )}
        {/* Minimized MOP Wizard indicator */}
        {mopContext?.isWizardMinimized && (
          <>
            <span className="status-bar-divider" />
            <button
              className="status-bar-item status-bar-item-btn status-bar-mop-indicator"
              onClick={() => mopContext.restoreWizard()}
              title="Restore MOP Wizard"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="7" y1="8" x2="17" y2="8" />
                <line x1="7" y1="12" x2="17" y2="12" />
                <line x1="7" y1="16" x2="13" y2="16" />
              </svg>
              <span>
                MOP: {mopContext.selectedChange?.name || mopContext.selectedTemplate?.name || 'Execution'}
              </span>
              {mopContext.execution.state.progress && (
                <span style={{ opacity: 0.8 }}>
                  {mopContext.execution.state.progress.phase === 'pre_checks' ? 'Pre' :
                   mopContext.execution.state.progress.phase === 'change_execution' ? 'Exec' :
                   mopContext.execution.state.progress.phase === 'post_checks' ? 'Post' :
                   mopContext.execution.state.progress.phase}
                  {' '}{mopContext.execution.state.progress.percentComplete}%
                </span>
              )}
              <span className={`status-bar-connection-dot ${
                mopContext.execution.state.execution?.status === 'running' ? 'connected' :
                mopContext.execution.state.execution?.status === 'failed' ? '' :
                'partial'
              }`} />
            </button>
          </>
        )}
      </div>

      {/* Center section: optional message area */}
      <div className="status-bar-center">
        {/* Reserved for status messages, notifications, etc. */}
      </div>

      {/* Right section: quick actions */}
      <div className="status-bar-right">
        {/* Quick Look buttons - only show when NOT in Docs view and setting enabled */}
        {showQuickLook && onQuickLook && (
          <div className="status-bar-quicklook">
            <button
              className="status-bar-item status-bar-item-btn status-bar-quicklook-btn"
              onClick={() => onQuickLook('notes')}
              title="Quick Look: Notes (Cmd+Shift+N)"
            >
              {Icons.notes}
            </button>
            <button
              className="status-bar-item status-bar-item-btn status-bar-quicklook-btn"
              onClick={() => onQuickLook('templates')}
              title="Quick Look: Templates (Cmd+Shift+T)"
            >
              {Icons.templates}
            </button>
            <button
              className="status-bar-item status-bar-item-btn status-bar-quicklook-btn"
              onClick={() => onQuickLook('outputs')}
              title="Quick Look: Outputs (Cmd+Shift+O)"
            >
              {Icons.outputs}
            </button>
            <span className="status-bar-divider" />
          </div>
        )}
        {/* Tunnels button — standalone only. In enterprise, tunnels are created
            and managed by the controller admin via the Admin UI (/api/admin/tunnels);
            the terminal client neither manages them nor has a /api/tunnels route. */}
        {!isEnterprise && (
        <div style={{ position: 'relative' }}>
          <button
            className="status-bar-item status-bar-item-btn"
            onClick={() => setShowTunnelPopover(!showTunnelPopover)}
            title="SSH Tunnels"
          >
            <span className="status-bar-tunnel-icon">&#8651;</span>
            <span>Tunnels</span>
            {activeTunnelCount > 0 && (
              <span className={`status-bar-tunnel-badge ${failedTunnels ? 'error' : ''}`}>
                {failedTunnels ? failedCount : activeTunnelCount}
              </span>
            )}
          </button>
          {showTunnelPopover && (
            <TunnelPopover
              onClose={() => setShowTunnelPopover(false)}
              onManageTunnels={() => {
                if (onManageTunnels) onManageTunnels()
                else if (onOpenSettings) onOpenSettings()
                setShowTunnelPopover(false)
              }}
            />
          )}
        </div>
        )}
        {settings.showSnippets && (
          <div style={{ position: 'relative' }}>
            <button
              className="status-bar-item status-bar-item-btn"
              onClick={() => setShowSnippetsMenu(!showSnippetsMenu)}
              title="Snippets"
            >
              {Icons.snippets}
              <span>Snippets</span>
            </button>
            {showSnippetsMenu && onSnippetSelect && onManageSnippets && (
              <SnippetsMenu
                onClose={() => setShowSnippetsMenu(false)}
                onSelectSnippet={(snippet) => {
                  onSnippetSelect(snippet)
                  setShowSnippetsMenu(false)
                }}
                onManageSnippets={() => {
                  onManageSnippets()
                  setShowSnippetsMenu(false)
                }}
              />
            )}
          </div>
        )}
        {settings.showQuickPrompts && hasFeature('local_custom_prompts') && (
          <div style={{ position: 'relative' }}>
            <button
              className="status-bar-item status-bar-item-btn"
              onClick={() => setShowPromptsMenu(!showPromptsMenu)}
              title="Quick Prompts"
            >
              {Icons.prompts}
              <span>Prompts</span>
            </button>
            {showPromptsMenu && onQuickPromptSelect && onManagePrompts && (
              <QuickPromptsMenu
                onClose={() => setShowPromptsMenu(false)}
                onSelectPrompt={(prompt) => {
                  onQuickPromptSelect(prompt)
                  setShowPromptsMenu(false)
                }}
                onManagePrompts={() => {
                  onManagePrompts()
                  setShowPromptsMenu(false)
                }}
              />
            )}
          </div>
        )}
        {settings.showQuickCalls && hasFeature('local_custom_prompts') && (
          <div style={{ position: 'relative' }}>
            <button
              className="status-bar-item status-bar-item-btn"
              onClick={() => setShowQuickCallsMenu(!showQuickCallsMenu)}
              title="Quick Calls"
            >
              {Icons.quickActions}
              <span>Calls</span>
            </button>
            {showQuickCallsMenu && onQuickCallSelect && onManageQuickCalls && (
              <QuickCallsMenu
                onClose={() => setShowQuickCallsMenu(false)}
                onSelectCall={(call) => {
                  onQuickCallSelect(call)
                  setShowQuickCallsMenu(false)
                }}
                onManageQuickCalls={() => {
                  onManageQuickCalls()
                  setShowQuickCallsMenu(false)
                }}
              />
            )}
          </div>
        )}
        {settings.showAIButton && hasFeature('local_ai_tools') && (
          <button
            className={`status-bar-item status-bar-item-btn status-bar-item-ai${aiOverlordActive ? ' ai-overlord-active' : ''}`}
            onClick={onToggleAIOverlord}
            title={aiOverlordActive ? 'AI Overlord Active (click to disable)' : 'Enable AI Overlord'}
          >
            {Icons.aiActive}
            <span>Overlord</span>
            {settings.showKeyboardShortcuts && <kbd>I</kbd>}
          </button>
        )}
        {onOpenAgentRun && agentRunningCount > 0 && (
          <button
            className="status-bar-item status-bar-item-btn has-indicator"
            onClick={onOpenAgentRun}
            title={`${agentRunningCount} agent run${agentRunningCount === 1 ? '' : 's'} active — click to open`}
          >
            {Icons.agent}
            <span>{agentRunningCount} agent{agentRunningCount === 1 ? '' : 's'}</span>
            <span className="status-bar-indicator-dot" aria-hidden="true" />
          </button>
        )}
        {settings.showScratchpad && onOpenScratchpad && (
          <button
            className={`status-bar-item status-bar-item-btn${scratchpadMinimized ? ' has-indicator' : ''}`}
            onClick={onOpenScratchpad}
            title={scratchpadMinimized
              ? 'Scratchpad — minimized buffer (Cmd+Shift+J to restore)'
              : 'Scratchpad (Cmd+Shift+J) — quick notes'}
          >
            {Icons.notes}
            <span>Scratch</span>
            {scratchpadMinimized && <span className="status-bar-indicator-dot" aria-hidden="true" />}
            {settings.showKeyboardShortcuts && <kbd>J</kbd>}
          </button>
        )}
        {settings.showCommandPalette && (
          <button
            className="status-bar-item status-bar-item-btn"
            onClick={onOpenCommandPalette}
            title="Command Palette (Cmd+Shift+P)"
          >
            {Icons.command}
            {settings.showKeyboardShortcuts && <kbd>P</kbd>}
          </button>
        )}
        {settings.showSettings && (
          <button
            className="status-bar-item status-bar-item-btn"
            onClick={onOpenSettings}
            title="Settings"
          >
            {Icons.settings}
          </button>
        )}
      </div>
      <ContextMenu position={contextMenu.position} items={contextMenu.items} onClose={contextMenu.close} />
    </div>
  )
}
