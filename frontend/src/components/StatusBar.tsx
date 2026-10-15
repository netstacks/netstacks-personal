import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import './StatusBar.css'
import { getRemoteAgentHost } from '../api/client'
import { useAgentTasksStore } from '../hooks/useAgentTasks'
import ContextMenu from './ContextMenu'
import { useContextMenu } from '../hooks/useContextMenu'
import { useOverlayDismiss } from '../hooks/useOverlayDismiss'
import { useKeybindings, formatShortcut, getPlatformBinding } from '../hooks/useKeyboard'
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
import type { TroubleshootingSession } from '../types/troubleshooting'
import { useMode } from '../hooks/useMode'
import { useAuthStore } from '../stores/authStore'
import { listOrganizations } from '../api/auth'
import { getErrorMessage } from '../api/errors'
import type { OrganizationSummary } from '../types/auth'
import { useQueryClient } from '@tanstack/react-query'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'
import type { CertStatus } from '../api/cert'
import { listMcpServers, connectMcpServer, type McpServer } from '../api/mcp'
import Tooltip from './Tooltip'

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
  // Platform-neutral palette glyph (a prompt in a box); the ⌘ symbol is Mac-only.
  command: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <polyline points="8 10 11 12.5 8 15" />
      <line x1="13" y1="15" x2="16" y2="15" />
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
  // Shortcut hints follow the user's keybindings (Settings → Keyboard).
  const keybindings = useKeybindings()
  const binding = (action: keyof typeof keybindings) => getPlatformBinding(keybindings[action])
  const hint = (action: keyof typeof keybindings) => formatShortcut(binding(action))
  const remoteHost = useMemo(() => getRemoteAgentHost(), [])
  // Persistent agent handle: count running agent tasks straight from the store
  // (a primitive selector — safe). The item only appears while > 0.
  const agentRunningCount = useAgentTasksStore((s) => s.tasks.filter((t) => t.status === 'running').length)
  const contextMenu = useContextMenu()

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
  const switchOrg = useAuthStore((state) => state.switchOrg)
  const queryClient = useQueryClient()

  // Organization switcher (platform admins): the list is loaded when the
  // controller popover opens; switching re-mints the token and remounts the app.
  const [organizations, setOrganizations] = useState<OrganizationSummary[] | null>(null)
  const [orgSwitching, setOrgSwitching] = useState(false)
  const [orgError, setOrgError] = useState<string | null>(null)
  const canSwitchOrg = isEnterprise && isAuthenticated && !!user?.is_platform_admin
  const activeOrgName = organizations?.find((o) => o.id === user?.org_id)?.name

  const handleSwitchOrg = useCallback(async (orgId: string) => {
    if (!orgId || orgId === user?.org_id) return
    setOrgSwitching(true)
    setOrgError(null)
    try {
      // Drop every cached query so nothing from the previous organization survives the remount
      await switchOrg(orgId, () => queryClient.clear())
    } catch (err) {
      setOrgError(getErrorMessage(err, 'Failed to switch organization'))
    } finally {
      setOrgSwitching(false)
    }
  }, [switchOrg, queryClient, user?.org_id])
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
    if (!showControllerInfo || !canSwitchOrg || organizations !== null) return
    let cancelled = false
    listOrganizations()
      .then((orgs) => { if (!cancelled) setOrganizations(orgs) })
      .catch(() => { if (!cancelled) setOrganizations([]) })
    return () => { cancelled = true }
  }, [showControllerInfo, canSwitchOrg, organizations])

  useEffect(() => {
    if (showControllerInfo) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showControllerInfo, handleClickOutside])
  useOverlayDismiss({
    onDismiss: () => {
      setShowControllerInfo(false)
      setPermissionsExpanded(false)
    },
    enabled: showControllerInfo,
    clickOutside: false,
  })

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
  useOverlayDismiss({ onDismiss: () => setShowMcpPopover(false), enabled: showMcpPopover, clickOutside: false })

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
        '--status-bar-bg': colors.background,
        '--status-bar-text': colors.text,
        '--status-bar-hover': colors.hoverBackground,
        '--status-bar-accent': colors.accentBackground,
      } as React.CSSProperties}
    >
      {/* Left section: connection status, active session, and troubleshooting indicator */}
      <div className="status-bar-left">
        {/* Remote agent indicator — VS Code style */}
        {remoteHost && (
          <Tooltip label={`Connected to remote agent on ${remoteHost}`}><div className="status-bar-remote-indicator">
            <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
              <path d="M14 1H2a1 1 0 00-1 1v8a1 1 0 001 1h5v2H5v1h6v-1H9v-2h5a1 1 0 001-1V2a1 1 0 00-1-1zm0 9H2V2h12v8z"/>
            </svg>
            <span>{remoteHost}</span>
          </div></Tooltip>
        )}
        {/* Enterprise mode: Controller connection indicator */}
        {isEnterprise && (
          <div style={{ position: 'relative' }}>
            <Tooltip label={isAuthenticated
                ? `Controller: ${controllerUrl || 'Connected'}`
                : 'Controller: Disconnected'
              }><button
              ref={controllerBtnRef}
              className="status-bar-item status-bar-item-btn"
              onClick={() => {
                setShowControllerInfo(!showControllerInfo)
                if (showControllerInfo) setPermissionsExpanded(false)
              }}
            >
              {Icons.controller}
              <span className={`status-bar-connection-dot ${isAuthenticated ? 'connected' : ''}`} />
              <span>{isAuthenticated ? instanceName : 'Disconnected'}</span>
            </button></Tooltip>
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
                    {canSwitchOrg && organizations && organizations.length > 0 ? (
                      <>
                        <Tooltip label="Platform administrator: open the terminal in another organization"><select
                          className="controller-info-select"
                          value={user.org_id}
                          disabled={orgSwitching}
                          onChange={(e) => { void handleSwitchOrg(e.target.value) }}
                          aria-label="Switch organization"
                        >
                          {organizations.map((org) => (
                            <option key={org.id} value={org.id}>
                              {org.name}{org.id === user.home_org_id ? ' (home)' : ''}
                            </option>
                          ))}
                        </select></Tooltip>
                        {orgSwitching && <div className="controller-info-detail">Switching…</div>}
                        {orgError && <div className="controller-info-detail controller-info-error">{orgError}</div>}
                      </>
                    ) : (
                      <div className="controller-info-detail">{activeOrgName ?? `${user.org_id.slice(0, 8)}…`}</div>
                    )}
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
          <Tooltip label={
            certStatus.valid
              ? `Certificate valid until ${certStatus.expires_at}`
              : certStatus.error || 'Certificate not available'
          }><div className="status-bar-item">
            <span className={`status-bar-connection-dot ${certStatus.valid ? 'connected' : ''}`} />
            <span>
              {certStatus.valid
                ? `Cert: ${formatTimeRemaining(certStatus.expires_at)}`
                : 'Cert: expired'}
            </span>
          </div></Tooltip>
        )}
        {/* Personal mode: device connection status */}
        {!isEnterprise && settings.showConnectionStatus && (
          <Tooltip label={connectedCount > 0 ? `${connectedCount} connected` : 'No connections'}><button
            className="status-bar-item status-bar-item-btn"
          >
            <span className={`status-bar-connection-dot ${connectedCount > 0 ? 'connected' : ''}`} />
            <span>{connectedCount > 0 ? connectedCount : 'No connections'}</span>
          </button></Tooltip>
        )}
        {/* MCP Servers indicator (standalone mode only, AI tools required) */}
        {!isEnterprise && hasFeature('local_ai_tools') && mcpTotal > 0 && (
          <div style={{ position: 'relative' }}>
            <Tooltip label={`MCP Servers: ${mcpConnected}/${mcpTotal} connected`}><button
              ref={mcpBtnRef}
              className="status-bar-item status-bar-item-btn"
              onClick={() => setShowMcpPopover(!showMcpPopover)}
            >
              {Icons.mcp}
              <span className={`status-bar-connection-dot ${mcpConnected === mcpTotal ? 'connected' : mcpConnected > 0 ? 'partial' : ''}`} />
              <span>MCP {mcpConnected}/{mcpTotal}</span>
            </button></Tooltip>
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
          <Tooltip label={activeProfileName ? `Active Session (Profile: ${activeProfileName})` : 'Active Session'}><span className="status-bar-item">
            {Icons.terminal}
            <span>{activeSessionName}{activeProfileName && <span style={{ opacity: 0.7 }}> as {activeProfileName}</span>}</span>
          </span></Tooltip>
        )}
        {/* Session tunnel forward dots */}
        {activeSessionName && tunnels.some(t => t.id.startsWith('session:')) && (
          <span className="status-bar-tunnel-dots">
            {tunnels
              .filter(t => t.id.startsWith('session:'))
              .map(t => (
                <Tooltip key={t.id} label={`${formatTunnelSpec(t)} (${t.status})`}><span
                  className={`status-bar-tunnel-dot ${t.status}`}
                  role="img" aria-label={`${formatTunnelSpec(t)} (${t.status})`}
                /></Tooltip>
              ))
            }
            <span className="status-bar-tunnel-dots-label">fwd</span>
          </span>
        )}
        {isTerminalFocused && canSftp && onToggleSftp && (
          <>
            <span className="status-bar-divider" />
            <Tooltip label="SFTP File Browser"><button
              className="status-bar-item status-bar-item-btn"
              onClick={onToggleSftp}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                <path d="M14.5 3H7.71l-.85-.85A.5.5 0 006.5 2h-5a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-10a.5.5 0 00-.5-.5z" />
              </svg>
              <span>SFTP{sftpConnectionCount && sftpConnectionCount > 0 ? ` (${sftpConnectionCount})` : ''}</span>
            </button></Tooltip>
          </>
        )}
        {/* Troubleshooting: start button when no session, indicator when active */}
        {!troubleshootingSession && onStartTroubleshootingSession && hasFeature('local_session_recording') && (
          <>
            <span className="status-bar-divider" />
            <Tooltip label="Start Troubleshooting Session" shortcut={binding('startTroubleshooting')}><button
              className="status-bar-item status-bar-item-btn status-bar-troubleshoot-start"
              onClick={onStartTroubleshootingSession}
            >
              {Icons.record}
              <span>Troubleshoot</span>
            </button></Tooltip>
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
            <Tooltip label="Quick Look: Notes" shortcut={binding('quickLookNotes')}><button
              className="status-bar-item status-bar-item-btn status-bar-quicklook-btn"
              onClick={() => onQuickLook('notes')}
              aria-label="Quick Look: Notes"
            >
              {Icons.notes}
            </button></Tooltip>
            <Tooltip label="Quick Look: Templates" shortcut={binding('quickLookTemplates')}><button
              className="status-bar-item status-bar-item-btn status-bar-quicklook-btn"
              onClick={() => onQuickLook('templates')}
              aria-label="Quick Look: Templates"
            >
              {Icons.templates}
            </button></Tooltip>
            <Tooltip label="Quick Look: Outputs" shortcut={binding('quickLookOutputs')}><button
              className="status-bar-item status-bar-item-btn status-bar-quicklook-btn"
              onClick={() => onQuickLook('outputs')}
              aria-label="Quick Look: Outputs"
            >
              {Icons.outputs}
            </button></Tooltip>
            <span className="status-bar-divider" />
          </div>
        )}
        {/* Tunnels button — standalone only. In enterprise, tunnels are created
            and managed by the controller admin via the Admin UI (/api/admin/tunnels);
            the terminal client neither manages them nor has a /api/tunnels route. */}
        {!isEnterprise && (
        <div style={{ position: 'relative' }}>
          <Tooltip label="SSH Tunnels"><button
            className="status-bar-item status-bar-item-btn"
            onClick={() => setShowTunnelPopover(!showTunnelPopover)}
          >
            <span className="status-bar-tunnel-icon">&#8651;</span>
            <span>Tunnels</span>
            {activeTunnelCount > 0 && (
              <span className={`status-bar-tunnel-badge ${failedTunnels ? 'error' : ''}`}>
                {failedTunnels ? failedCount : activeTunnelCount}
              </span>
            )}
          </button></Tooltip>
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
            <Tooltip label="Snippets"><button
              className="status-bar-item status-bar-item-btn"
              onClick={() => setShowSnippetsMenu(!showSnippetsMenu)}
            >
              {Icons.snippets}
              <span>Snippets</span>
            </button></Tooltip>
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
            <Tooltip label="Quick Prompts"><button
              className="status-bar-item status-bar-item-btn"
              onClick={() => setShowPromptsMenu(!showPromptsMenu)}
            >
              {Icons.prompts}
              <span>Prompts</span>
            </button></Tooltip>
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
            <Tooltip label="Quick Calls"><button
              className="status-bar-item status-bar-item-btn"
              onClick={() => setShowQuickCallsMenu(!showQuickCallsMenu)}
            >
              {Icons.quickActions}
              <span>Calls</span>
            </button></Tooltip>
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
          <Tooltip label={aiOverlordActive
              ? 'AI Highlights on — terminal output is scanned live for errors, security issues and anomalies (click to disable)'
              : 'Enable AI Highlights — scan terminal output live for errors, security issues and anomalies'}><button
            className={`status-bar-item status-bar-item-btn status-bar-item-ai${aiOverlordActive ? ' ai-overlord-active' : ''}`}
            onClick={onToggleAIOverlord}
          >
            {Icons.aiActive}
            {/* Labelled "AI Highlights", not "Overlord": that name belongs to the
                agent mode, and this button never opened the AI panel (NS-APP-23). */}
            <span>AI Highlights</span>
          </button></Tooltip>
        )}
        {onOpenAgentRun && agentRunningCount > 0 && (
          <Tooltip label={`${agentRunningCount} agent run${agentRunningCount === 1 ? '' : 's'} active — click to open`}><button
            className="status-bar-item status-bar-item-btn has-indicator"
            onClick={onOpenAgentRun}
          >
            {Icons.agent}
            <span>{agentRunningCount} agent{agentRunningCount === 1 ? '' : 's'}</span>
            <span className="status-bar-indicator-dot" aria-hidden="true" />
          </button></Tooltip>
        )}
        {settings.showScratchpad && onOpenScratchpad && (
          <Tooltip label={scratchpadMinimized ? 'Scratchpad — minimized buffer, open to restore' : 'Scratchpad — quick notes'} shortcut={binding('scratchpadOpen')}><button
            className={`status-bar-item status-bar-item-btn${scratchpadMinimized ? ' has-indicator' : ''}`}
            onClick={onOpenScratchpad}
          >
            {Icons.notes}
            <span>Scratch</span>
            {scratchpadMinimized && <span className="status-bar-indicator-dot" aria-hidden="true" />}
            {settings.showKeyboardShortcuts && <kbd>{hint('scratchpadOpen')}</kbd>}
          </button></Tooltip>
        )}
        {settings.showCommandPalette && (
          <Tooltip label="Command Palette" shortcut={binding('commandPalette')}><button
            className="status-bar-item status-bar-item-btn"
            onClick={onOpenCommandPalette}
            aria-label="Command Palette"
          >
            {Icons.command}
            {settings.showKeyboardShortcuts && <kbd>{hint('commandPalette')}</kbd>}
          </button></Tooltip>
        )}
        {settings.showSettings && (
          <Tooltip label="Settings"><button
            className="status-bar-item status-bar-item-btn"
            onClick={onOpenSettings}
            aria-label="Settings"
          >
            {Icons.settings}
          </button></Tooltip>
        )}
      </div>
      <ContextMenu position={contextMenu.position} items={contextMenu.items} onClose={contextMenu.close} />
    </div>
  )
}
