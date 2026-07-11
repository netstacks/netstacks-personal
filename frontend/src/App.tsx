import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useClampedMenuPosition } from './hooks/useClampedMenuPosition'
import './App.css'
import './components/ContextMenu.css'
import { getClient } from './api/client'
import CommandPalette, { type Command } from './components/CommandPalette'
import Terminal, { type ConnectionStatus, type TerminalHandle } from './components/Terminal'
import type { CliFlavor } from './types/enrichment'
import SettingsPanel, { type SettingsTab } from './components/SettingsPanel'
import AboutModal from './components/AboutModal'
import Scratchpad from './components/Scratchpad'
import ScratchpadTab from './components/ScratchpadTab'
import AISidePanel, { type AgentMessage } from './components/AISidePanel'
import AIInlinePopup from './components/AIInlinePopup'
import ForceTouchPopover, { type ForceTouchContext, type ForceTouchOption } from './components/ForceTouchPopover'
import { forceTouchOptions } from './lib/forceTouchActions'
import AIFloatingChat from './components/AIFloatingChat'
import SessionPanel from './components/SessionPanel'
import EnterpriseDevicePanel from './components/EnterpriseDevicePanel'
import EnterpriseConnectDialog from './components/EnterpriseConnectDialog'
import DocsPanel from './components/DocsPanel'
import TopologyPanel from './components/TopologyPanel'
import ChangesPanel from './components/ChangesPanel'
import AgentsPanel from './components/AgentsPanel'
import AgentRunTab from './components/AgentRunTab'
import { useAgentTasksStore } from './hooks/useAgentTasks'
import { useAssistantName, useAssistantNameStore } from './stores/assistantName'
import ApiResponseTab from './components/ApiResponseTab'
import ConfigPanel from './components/config/ConfigPanel'
import { PluginPanel } from './components/PluginPanel'
import { IncidentsPanel } from './components/IncidentsPanel'
import { AlertsPanel } from './components/AlertsPanel'
import { ProfilingAgentsPanel } from './components/ProfilingAgentsPanel'
import { ProfilingAgentChat } from './components/ProfilingAgentChat'
import IncidentDetailTab from './components/IncidentDetailTab'
import AlertDetailTab from './components/AlertDetailTab'
import StackDetailTab from './components/config/StackDetailTab'
import TemplateDetailTab from './components/config/TemplateDetailTab'
import InstanceDetailTab from './components/config/InstanceDetailTab'
import DeploymentDetailTab from './components/config/DeploymentDetailTab'
import BackupHistoryTab from './components/BackupHistoryTab'
// Note: TopologyCanvas, TopologyCanvas3D, ViewToggle now used in TopologyTabEditor
// DocumentViewer - available for future modal/preview use
import DocumentTabEditor from './components/DocumentTabEditor'
import UnsavedDocumentTab from './components/UnsavedDocumentTab'
import TopologyTabEditor from './components/TopologyTabEditor'
import DeviceDetailTab from './components/DeviceDetailTab'
import LinkDetailTab from './components/LinkDetailTab'
import MopWorkspace from './components/mop/MopWorkspace'
import SftpPanel from './components/SftpPanel'
import SftpEditorTab from './components/SftpEditorTab'
import { useSftpStore } from './stores/sftpStore'
import { useTunnelStore } from './stores/tunnelStore'
import { useActiveTopologyStore } from './stores/activeTopologyStore'
import { useTopologyAICallbacks } from './hooks/useTopologyAICallbacks'
import { buildTopologySeed } from './lib/aiTopologySeed'
import { resolveDocSaveTarget } from './lib/docSaveTargets'
import { ASK_AI_HELP_EVENT } from './components/AskAiHelp'
import OnboardingWizard from './components/OnboardingWizard'
import ScriptEditor, { type ScriptEditorHandle } from './components/ScriptEditor'
import AIScriptGenerator from './components/AIScriptGenerator'
import QuickConnectDialog from './components/QuickConnectDialog'
import TabContextMenu, { type TabGroup } from './components/TabContextMenu'
import LaunchDialog, { type LaunchChoice } from './components/LaunchDialog'
import NamePromptModal from './components/NamePromptModal'
// Note: SplitPaneContainer available for future drag-resize split view
import DiscoveryModal, { type DiscoveryResult } from './components/DiscoveryModal'
import DiscoveryToast from './components/DiscoveryToast'
import AIProgressPanel, { type AIProgressLog } from './components/AIProgressPanel'
import SessionSettingsDialog from './components/SessionSettingsDialog'
import ShareSessionDialog from './components/ShareSessionDialog'
import StatusBar from './components/StatusBar'
import QuickCallVariablesDialog, { extractCallVariables } from './components/QuickCallVariablesDialog'
import type { QuickPrompt } from './api/quickPrompts'
import type { QuickAction } from './api/quickActions'
import { executeQuickAction } from './api/quickActions'
import type { QuickActionResult, ApiResource } from './types/quickAction'
import ApiResourceDialog from './components/ApiResourceDialog'
import type { GlobalSnippet } from './api/snippets'
import { useMultiSend } from './hooks/useMultiSend'
import { useKeyboard, displayShortcut } from './hooks/useKeyboard'
import { OVERLORD_OPEN_AI_POPUP_EVENT, type OverlordOpenAIPopupDetail } from './hooks/useMonacoOverlord'
import { TabSelectionProvider, useTabSelection } from './hooks/useTabSelection'
import { useEnrichment } from './hooks/useEnrichment'
// useMenuEvents is no longer mounted — every native-menu item is
// routed through the CommandRegistry (see useCommand registrations
// below). Hook left in tree for now; remove when no other importer
// remains.
import { listSessions, getSession, type Session } from './api/sessions'
import { type EnterpriseSession, getSessionDefinition } from './api/enterpriseSessions'
import { type DeviceSummary } from './api/enterpriseDevices'
import { listProfiles, type CredentialProfile } from './api/profiles'
import { createLayout, type Layout, type LayoutTab } from './api/layouts'
import {
  createGroup,
  updateGroup as apiUpdateGroup,
  type Group,
  type GroupTab,
} from './api/groups'
import { useLiveGroupAutoClear } from './hooks/useLiveGroup'
import type { Script } from './api/scripts'
import { getScript } from './api/scripts'
import { updateDocument, listDocuments, getDocument, createDocument, type Document, type DocumentCategory, type ContentType } from './api/docs'
import type { SearchHit } from './api/search'
import { createChange } from './api/changes'
import { createMopStep, type MopStep } from './types/change'
import type { AiContext } from './api/ai'
import { getDiscoveryPrompt, getWorkspaceInitPrompt, DEFAULT_WORKSPACE_INIT_PROMPT, DEFAULT_AI_DISCOVERY_PROMPT } from './api/ai'
import { aiToolInitFilename } from './lib/aiToolInitFile'
import { LocalFileOps } from './lib/fileOps'
import { createTopology, addNeighborDevice, createConnection as createTopologyConnection, getTopology, deleteDevice, updateDevice } from './api/topology'
// Note: Session topology API moved to TopologyTabEditor in Phase 20.1
import type { Topology, Device } from './types/topology'
import { TracerouteParser } from './lib/tracerouteParser'
import { parseSysDescr } from './lib/sysDescrParser'
import { resolveSnmpHost } from './lib/sessionHostResolver'
import { saveDeviceEnrichmentToDoc, saveLinkEnrichmentToDoc } from './lib/enrichmentExport'
import DeviceDetailsOverlay from './components/DeviceDetailsOverlay'
import ConnectionDetailsOverlay from './components/ConnectionDetailsOverlay'
// SessionQuickLook removed - double-click now directly opens terminal
import ContextMenu, { getDeviceMenuItems, type MenuItem } from './components/ContextMenu'
import { ToastContainer, showToast } from './components/Toast'
import { ConfirmDialogHost, confirmDialog } from './components/ConfirmDialog'
import UpdateChecker from './components/UpdateChecker'
import type { Connection } from './types/topology'
import { loadPanelSettings, savePanelSettings, PANEL_SETTINGS_CHANGED, type PanelSettings } from './api/panelSettings'
import { useSettings } from './hooks/useSettings'
import { useMode } from './hooks/useMode'
import { useCapabilitiesStore } from './stores/capabilitiesStore'
import { EnrichmentProvider } from './contexts/EnrichmentContext'
import { MopExecutionProvider, useMopExecutionOptional } from './contexts/MopExecutionContext'
import { AuthProvider } from './components/auth/AuthProvider'
import TroubleshootingDialog from './components/TroubleshootingDialog'
import DeviceEditDialog from './components/DeviceEditDialog'
import WorkspaceTab from './components/workspace/WorkspaceTab'
import WorkspaceNewDialog from './components/workspace/WorkspaceNewDialog'
import WorkspacesPanel, { addSavedWorkspace } from './components/workspace/WorkspacesPanel'
import { MenuBridge } from './commands/menuBridge'
import { useActiveContextStore, useCommand, dispatchCommand, getActiveContext, type ActiveContext } from './commands'
import { getPlatform } from './utils/platform'
import TopBar from './components/TopBar'
import WindowControls from './components/WindowControls'
import MenuBar from './components/MenuBar'
import type { WorkspaceConfig } from './types/workspace'
import { useTroubleshootingSession, type OnTimeoutCallback } from './hooks/useTroubleshootingSession'
import type { TroubleshootingSession } from './types/troubleshooting'
import { getTroubleshootingSettings } from './api/troubleshootingSettings'
import {
  summarizeTroubleshootingSession,
  saveTroubleshootingSummary,
  callAIChat,
  generateFallbackSummary,
} from './lib/troubleshootingAI'
// Integration APIs for AI Discovery (Phase 22)
import { listNetBoxSources } from './api/netboxSources'
import type { NetBoxNeighbor } from './api/netbox'

// Check if running in Tauri environment
import { getErrorMessage } from './api/errors'
import { logger } from './lib/logger'
const isTauri = '__TAURI_INTERNALS__' in window

// Tab type discriminator
type TabType = 'terminal' | 'document' | 'topology' | 'device-detail' | 'link-detail' | 'mop' | 'sftp-editor' | 'script' | 'api-response' | 'settings' | 'incident-detail' | 'alert-detail' | 'stack-detail' | 'backup-history' | 'config-template' | 'config-stack' | 'config-instance' | 'config-deployment' | 'workspace' | 'scratchpad' | 'agent-run' | 'ai-chat'

// Status for document tabs
type DocumentStatus = 'saved' | 'modified' | 'new'

// Status for topology tabs
type TopologyStatus = 'loading' | 'ready' | 'error'

// Status for detail tabs
type DetailStatus = 'loading' | 'ready'

// Unified tab interface supporting terminals, documents, topologies, and detail views
interface Tab {
  id: string
  type: TabType
  title: string
  // Agent-run-specific (an agent task opened as a tab)
  agentTaskId?: string
  // AI-chat-specific: seed conversation (e.g. continuing a finished agent run)
  aiChatSeed?: AgentMessage[]
  // The first user prompt of this chat — shown on hover so many chat tabs are
  // distinguishable.
  chatPrompt?: string
  // Terminal-specific
  sessionId?: string
  protocol?: 'ssh' | 'telnet'
  cliFlavor?: CliFlavor
  terminalTheme?: string | null
  fontSize?: number | null
  fontFamily?: string | null
  status: ConnectionStatus | DocumentStatus | TopologyStatus | DetailStatus
  profileId?: string
  // Jumpbox (enterprise Local Terminal)
  isJumpbox?: boolean
  // Enterprise SSH terminal-specific
  enterpriseProfileId?: string
  enterpriseSessionDefinitionId?: string
  enterpriseTargetHost?: string
  enterpriseTargetPort?: number
  // Document-specific
  documentId?: string
  documentCategory?: DocumentCategory
  /** Unsaved document content (not yet persisted to backend) */
  unsavedDoc?: { name: string; content: string; contentType: ContentType; category: DocumentCategory }
  // Topology-specific
  topologyId?: string
  topologyName?: string
  /** In-memory topology data (for traceroute visualizations) */
  temporaryTopology?: Topology
  isTemporaryTopology?: boolean
  // Device-detail-specific
  deviceName?: string
  deviceSessionId?: string
  deviceHost?: string
  deviceProfileId?: string
  deviceId?: string  // Enterprise mode: controller device UUID for SNMP polling
  deviceData?: Device
  // Backup-history-specific
  backupDeviceId?: string
  // Link-detail-specific
  connectionId?: string
  sourceDeviceName?: string
  targetDeviceName?: string
  sourceHost?: string
  targetHost?: string
  sourceInterfaceName?: string
  targetInterfaceName?: string
  // MOP workspace-specific
  mopPlanId?: string
  mopExecutionId?: string
  // SFTP editor fields
  sftpConnectionId?: string
  sftpFilePath?: string
  sftpFileName?: string
  sftpDeviceName?: string
  sftpDirty?: boolean
  // Script editor fields
  scriptId?: string
  scriptData?: Script
  // API response tab fields
  apiResponseTitle?: string
  apiResponseData?: string
  apiResponseStatus?: number
  apiResponseDurationMs?: number
  // Incident/Alert detail
  incidentId?: string
  alertId?: string
  // Stack detail tab
  stackDetailTemplateId?: string
  stackDetailInstanceId?: string
  // Config management tabs
  configTemplateId?: string
  configStackId?: string
  configInstanceId?: string
  configInstanceStackId?: string
  configDeploymentId?: string
  // Workspace tab
  workspaceConfig?: WorkspaceConfig
  // Scratchpad tab — content is owned by the tab itself; passed once
  // on creation, then internally state-managed by ScratchpadTab.
  scratchpadInitialContent?: string
  // Shared
  color?: string
}

// Type guard helpers
function isTerminalTab(tab: Tab): boolean {
  return tab.type === 'terminal'
}

function isDocumentTab(tab: Tab): boolean {
  return tab.type === 'document'
}

function isTopologyTab(tab: Tab): boolean {
  return tab.type === 'topology'
}

function isMopTab(tab: Tab): boolean {
  return tab.type === 'mop'
}

function isScriptTab(tab: Tab): boolean {
  return tab.type === 'script'
}

function isSettingsTab(tab: Tab): boolean {
  return tab.type === 'settings'
}

// Get icon for document based on category
function getDocumentIcon(category?: DocumentCategory): React.ReactNode {
  switch (category) {
    case 'notes':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      )
    case 'templates':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="21" x2="9" y2="9" />
        </svg>
      )
    case 'outputs':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      )
    case 'backups':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      )
    case 'history':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      )
    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      )
  }
}

// SVG Icons (inline for simplicity)
const Icons = {
  sessions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </svg>
  ),
  topology: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M12 9v3M9.5 16.5L12 12M14.5 16.5L12 12" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
    </svg>
  ),
  terminal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  pin: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 2L12 12" />
      <path d="M18 8L18 12L6 12L6 8" />
      <path d="M12 12L12 22" />
      <circle cx="12" cy="6" r="2" />
    </svg>
  ),
  pinOff: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 2L12 12" />
      <path d="M18 8L18 12L6 12L6 8" />
      <path d="M12 12L12 22" />
      <circle cx="12" cy="6" r="2" />
      <path d="M3 3L21 21" strokeWidth="2" />
    </svg>
  ),
  docs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  ),
  changes: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  topologyTab: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
      <circle cx="12" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M12 9v3M9.5 16.5L12 12M14.5 16.5L12 12" />
    </svg>
  ),
  agents: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.5" fill="currentColor" />
      <circle cx="15" cy="10" r="1.5" fill="currentColor" />
      <path d="M9 15h6" />
      <path d="M12 2v2" />
      <path d="M8 2h8" />
    </svg>
  ),
  scripts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M10 12l-2 2 2 2" />
      <path d="M14 12l2 2-2 2" />
    </svg>
  ),
  stacks: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <rect x="3" y="16" width="18" height="4" rx="1" />
    </svg>
  ),
  quickActions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
}

// Icon map for plugin manifest icon names → SVG elements
const pluginIconMap: Record<string, React.ReactNode> = {
  Bell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  ),
  Filter: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  ),
  FileCode: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M10 12l-2 2 2 2" />
      <path d="M14 12l2 2-2 2" />
    </svg>
  ),
  Rocket: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z" />
      <path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  ),
  AlertTriangle: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  Activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  pulse: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
}

// Default plugin icon (puzzle piece)
const defaultPluginIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M20 7h-4V3a1 1 0 00-1-1h-6a1 1 0 00-1 1v4H4a1 1 0 00-1 1v5h4a2 2 0 010 4H3v5a1 1 0 001 1h5v-4a2 2 0 014 0v4h5a1 1 0 001-1v-5h-4a2 2 0 010-4h4V8a1 1 0 00-1-1z" />
  </svg>
)

type ViewType = 'sessions' | 'topology' | 'docs' | 'changes' | 'agents' | 'stacks' | 'workspaces' | string

function AppContent() {
  const [activeView, setActiveView] = useState<ViewType>('sessions')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarPinned, setSidebarPinned] = useState(() => loadPanelSettings().leftSidebarPinned)
  const [aiPanelPinned, setAiPanelPinned] = useState(() => loadPanelSettings().aiPanelPinned)
  const [sidebarOverlay, setSidebarOverlay] = useState(() => loadPanelSettings().sidebarOverlay)
  const [hotEdgesEnabled, setHotEdgesEnabled] = useState(() => loadPanelSettings().hotEdgesEnabled)

  // Mode detection (for conditional feature gating)
  const { isEnterprise } = useMode()

  // Feature availability — driven by capabilities. In Personal Mode all
  // local features are always enabled. In Enterprise Mode the Controller
  // dictates which features are licensed.
  const hasFeature = useCapabilitiesStore((s) => s.hasFeature)
  const hasPermission = useCapabilitiesStore((s) => s.hasPermission)
  const isStandalone = useCapabilitiesStore((s) => s.isStandalone)
  const canTopology = hasFeature('local_topology')
  const canDocs = hasFeature('local_docs')
  const canAgents = hasFeature('local_ai_tools')
  const getPluginPanels = useCapabilitiesStore((s) => s.getPluginPanels)
  // MOPs is a core feature (not a plugin) — show Changes tab when feature is enabled
  const canChanges = canDocs && hasFeature('mops')

  // RBAC permission gating (enterprise only — standalone always shows all tabs)
  const showSessionsTab = isStandalone() || hasPermission('sessions.connect')
  const showDevicesTab = isStandalone() || hasPermission('devices.access')
  const showAgentsTab = isStandalone() || hasPermission('agents.manage')
  const showChangesTab = isStandalone() || hasPermission('mops.manage')

  // Set initial view to first permitted tab after permissions load
  const capabilitiesLoaded = useCapabilitiesStore((s) => s.capabilities !== null)
  const [initialViewSet, setInitialViewSet] = useState(false)
  useEffect(() => {
    if (!capabilitiesLoaded || initialViewSet) return
    setInitialViewSet(true)
    if (showSessionsTab) { setActiveView('sessions'); return }
    if (showDevicesTab) { setActiveView('devices'); return }
    if (canTopology) { setActiveView('topology'); return }
    if (canDocs) { setActiveView('docs'); return }
  }, [capabilitiesLoaded, initialViewSet, showSessionsTab, showDevicesTab, canTopology, canDocs])

  // Filter out 'stacks' (has dedicated StacksPanel) and admin-only panels like pipeline-rules
  // Incidents and alerts have dedicated panels but still need activity bar icons
  const allPluginPanels = getPluginPanels().filter(pp =>
    pp.pluginName !== 'stacks' && pp.panel.id !== 'pipeline-rules'
  )
  const pluginPanels = allPluginPanels.filter(pp =>
    pp.pluginName !== 'incidents' && pp.pluginName !== 'alerts' && pp.pluginName !== 'profiling-agents'
  )
  const canStacks = isEnterprise && hasFeature('service_stacks')
  const canSftp = hasFeature('local_sftp') || hasFeature('central_sftp')

  // SFTP store subscriptions
  const sftpConnectionCount = useSftpStore(s => s.connections.length)

  // Tunnel store: initialize polling and auto-start tunnels
  const startTunnelPolling = useTunnelStore(state => state.startPolling)
  const stopTunnelPolling = useTunnelStore(state => state.stopPolling)
  const autoStartAll = useTunnelStore(state => state.autoStartAll)

  // Mode logged once at startup (see main.tsx)

  // Global app settings (font, etc.)
  const { settings: appSettings, updateSetting: updateAppSetting } = useSettings()

  // First-run onboarding wizard (SP2)
  const [wizardOpen, setWizardOpen] = useState(false)

  // AI-proposed API Resource prefill (SP5-C): the AI assembles a config and the
  // user enters the secret + saves in this dialog.
  const [prefillApiResource, setPrefillApiResource] = useState<ApiResource | null>(null)

  // Active topology (published by TopologyTabEditor) → AI topology tools.
  // Individual selectors avoid re-rendering App on unrelated store writes.
  const atTopology = useActiveTopologyStore(s => s.topology)
  const atTopologyId = useActiveTopologyStore(s => s.topologyId)
  const atIsTemporary = useActiveTopologyStore(s => s.isTemporary)
  const atSetTopology = useActiveTopologyStore(s => s.setTopology)
  const atPushAction = useActiveTopologyStore(s => s.pushAction)
  const atShowAIActionToast = useActiveTopologyStore(s => s.showAIActionToast)
  const atDeviceStats = useActiveTopologyStore(s => s.deviceStats)
  const atLinkEnrichment = useActiveTopologyStore(s => s.linkEnrichment)
  const atLiveStats = useActiveTopologyStore(s => s.liveStats)
  const allowStructuralTopologyEdits = appSettings['ai.topology.allowStructuralEdits']
  const topologyAICallbacks = useTopologyAICallbacks({
    topology: atTopology,
    topologyId: atTopologyId,
    isTemporary: atIsTemporary,
    setTopology: atSetTopology ?? (() => {}),
    pushAction: atPushAction ?? ((a) => ({ id: crypto.randomUUID(), timestamp: new Date(), ...a })),
    showAIActionToast: atShowAIActionToast,
    deviceStats: atDeviceStats ?? null,
    linkEnrichment: atLinkEnrichment ?? null,
    liveStats: atLiveStats ?? null,
  }) ?? undefined

  // Seed the docked AI panel with a message and reveal it. Shared by the
  // topology "Ask AI" entry points (free space, device, link).
  const handleAskAISeed = useCallback((content: string) => {
    setAiChatOpen(true)
    setAiPanelCollapsed(false)
    setAiPanelInitialMessages([{ id: `msg_${Date.now()}`, type: 'user', content, timestamp: new Date() }])
  }, [])
  const handleDiscussTopologyWithAI = useCallback(() => {
    handleAskAISeed(buildTopologySeed('map'))
  }, [handleAskAISeed])
  const handleAskAIAboutElement = useCallback((kind: 'device' | 'link', id: string) => {
    handleAskAISeed(buildTopologySeed(kind, id))
  }, [handleAskAISeed])

  // Apply font settings to CSS custom properties so all components inherit them
  useEffect(() => {
    document.documentElement.style.setProperty('--font-family', appSettings.fontFamily)
    document.documentElement.style.setProperty('--font-size-base', `${appSettings.fontSize}px`)
    // Small font size is ~85% of base (e.g., 17px base -> 14px small)
    const smallFontSize = Math.round(appSettings.fontSize * 0.85)
    document.documentElement.style.setProperty('--font-size-small', `${smallFontSize}px`)
  }, [appSettings.fontFamily, appSettings.fontSize])

  // Toggle liquid-glass effects app-wide. `data-glass="off"` flips the --glass-*
  // tokens to opaque (see index.css), turning glass off everywhere at once.
  useEffect(() => {
    document.documentElement.setAttribute('data-glass', appSettings['ui.glassEffects'] === false ? 'off' : 'on')
  }, [appSettings['ui.glassEffects']])

  // The custom TopBar is always present. macOS keeps native decorations
  // (inset traffic lights via titleBarStyle: Overlay in tauri.conf).
  // Windows/Linux drop native decorations so the TopBar owns the chrome.
  const platform = getPlatform()
  useEffect(() => {
    if (platform === 'macos') return
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setDecorations(false))
      .catch(() => { /* not running under Tauri */ })
  }, [platform])

  // The TopBar is the drag handle on all platforms now.
  const titleBarDragProps: React.HTMLAttributes<HTMLDivElement> = {}


  // Suppress native context menu globally — React onContextMenu handlers
  // show custom menus while this prevents the OS/webview default menu from appearing.
  useEffect(() => {
    const suppress = (e: MouseEvent) => e.preventDefault()
    document.addEventListener('contextmenu', suppress, true)
    return () => document.removeEventListener('contextmenu', suppress, true)
  }, [])

  // Initialize tunnel polling and auto-start saved tunnels (standalone mode only)
  // In enterprise mode, tunnels are managed by the controller admin — don't auto-start
  useEffect(() => {
    if (isEnterprise) return
    startTunnelPolling()
    autoStartAll()
    return () => {
      stopTunnelPolling()
    }
  }, [isEnterprise])

  // Auto-switch to SFTP sidebar when first connection opens
  const prevSftpCountRef = useRef(0)
  useEffect(() => {
    if (sftpConnectionCount > prevSftpCountRef.current && sftpConnectionCount > 0) {
      // New connection added — switch to SFTP view
      setActiveView('sftp')
      setSidebarOpen(true)
    }
    if (sftpConnectionCount === 0 && activeView === 'sftp') {
      setActiveView('sessions')
    }
    prevSftpCountRef.current = sftpConnectionCount
  }, [sftpConnectionCount])

  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [isResizing, setIsResizing] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [aiChatOpen, setAiChatOpen] = useState(false)
  const [aiPanelCollapsed, setAiPanelCollapsed] = useState(false)
  const [aiExpandTrigger, setAiExpandTrigger] = useState(0)
  const [aiOverlordActive, setAiOverlordActive] = useState(false)
  const [aiPanelInitialMessages, setAiPanelInitialMessages] = useState<AgentMessage[] | undefined>(undefined)
  const [aiExternalPrompt, setAiExternalPrompt] = useState<{ prompt: string; counter: number } | undefined>(undefined)
  const [aiTopologyContext, setAiTopologyContext] = useState<{ topologyId: string; devices: Device[]; refreshCounter: number } | null>(null)
  // Track topology refresh keys to trigger reloads after AI updates
  const [topologyRefreshKeys, setTopologyRefreshKeys] = useState<Record<string, number>>({})

  // AI progress panel state (for background topology enrichment)
  const [aiProgressRunning, setAiProgressRunning] = useState(false)
  const [aiProgressTask, setAiProgressTask] = useState('')
  const [aiProgressLogs, setAiProgressLogs] = useState<AIProgressLog[]>([])
  const [aiProgressPercent, setAiProgressPercent] = useState(0)
  // Store enrichment messages for transfer to AI panel
  const [aiEnrichmentMessages, setAiEnrichmentMessages] = useState<AgentMessage[]>([])
  const [aiEnrichmentComplete, setAiEnrichmentComplete] = useState(false)
  const [_aiContext, setAiContext] = useState<AiContext | null>(null)
  const [aiPopup, setAiPopup] = useState<{
    isOpen: boolean
    position: { x: number; y: number }
    action: 'explain' | 'fix' | 'suggest'
    selectedText: string
    sessionId?: string
    sessionName?: string
  }>({ isOpen: false, position: { x: 0, y: 0 }, action: 'explain', selectedText: '' })
  const [aiFloatingChat, setAiFloatingChat] = useState<{
    isOpen: boolean
    position: { x: number; y: number }
    sessionId?: string
    sessionName?: string
    selectedText?: string
    /** When set, the pop-over auto-sends this prompt on open (contextual Ask-AI help). */
    initialPrompt?: string
  }>({ isOpen: false, position: { x: 0, y: 0 } })
  // macOS Force Touch action popover (force-click on terminal selection)
  const [forcePopover, setForcePopover] = useState<{
    isOpen: boolean
    position: { x: number; y: number }
    context: ForceTouchContext
    options: ForceTouchOption[]
  }>({ isOpen: false, position: { x: 0, y: 0 }, context: { text: '' }, options: [] })
  const [aiScriptGeneratorOpen, setAiScriptGeneratorOpen] = useState(false)
  const [quickConnectOpen, setQuickConnectOpen] = useState(false)
  const [quickConnectInitialHost, setQuickConnectInitialHost] = useState<string | undefined>(undefined)
  const [showAbout, setShowAbout] = useState(false)
  // Scratchpad: the floating-panel state lives here so minimize/restore
  // doesn't lose the buffer. `exists` flips true on first open and stays
  // until the user explicitly closes (which also clears content).
  const [scratchpadExists, setScratchpadExists] = useState(false)
  const [scratchpadMinimized, setScratchpadMinimized] = useState(false)
  const [scratchpadMaximized, setScratchpadMaximized] = useState(false)
  const [scratchpadContent, setScratchpadContent] = useState('')
  const [showNewWorkspace, setShowNewWorkspace] = useState(false)
  const [deployAgentDialogOpen, setDeployAgentDialogOpen] = useState(false)
  const [remoteWindowDeploying, setRemoteWindowDeploying] = useState(false)
  const [profilingChatAgent, setProfilingChatAgent] = useState<{id: string, name: string} | null>(null)
  // Unified tabs state (terminals and documents)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  // The AI Engineer profile name (e.g. "NetBot") used in place of "AI Assistant".
  const assistantName = useAssistantName()

  // Detect if active workspace uses NetStacks Agent — portal AI panel to Zone 3
  const activeWsConfig = useMemo(() => {
    const t = tabs.find(tab => tab.id === activeTabId && tab.type === 'workspace')
    return t?.workspaceConfig ?? null
  }, [tabs, activeTabId])
  const isNetstacksAgentActive = activeWsConfig?.aiTool?.tool === 'netstacks-agent'
  const [aiPortalTarget, setAiPortalTarget] = useState<HTMLElement | null>(null)
  const aiPortalObserverRef = useRef<MutationObserver | null>(null)

  useEffect(() => {
    if (aiPortalObserverRef.current) {
      aiPortalObserverRef.current.disconnect()
      aiPortalObserverRef.current = null
    }

    if (!isNetstacksAgentActive) {
      setAiPortalTarget(null)
      return
    }

    const findTarget = () => {
      const el = document.getElementById('workspace-ai-panel-target')
      const visible = el && el.style.display !== 'none'
      setAiPortalTarget(visible ? el : null)
    }

    findTarget()

    const observer = new MutationObserver(findTarget)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    aiPortalObserverRef.current = observer

    return () => observer.disconnect()
  }, [isNetstacksAgentActive, activeTabId])

  // Document data cache for document tabs (documentId -> Document)
  const [documentCache, setDocumentCache] = useState<Record<string, Document>>({})

  // Terminal refs for AI agent access (tabId -> TerminalHandle)
  const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map())

  // Script editor refs for AI overlord access (tabId -> ScriptEditorHandle)
  const scriptEditorRefs = useRef<Map<string, ScriptEditorHandle>>(new Map())

  // Tabs ref for stable access in callbacks without causing re-renders
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  // Tab context menu state
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const [contextMenuTabId, setContextMenuTabId] = useState<string | null>(null)
  const [tabGroups, setTabGroups] = useState<TabGroup[]>([])

  // Save layout dialog state (Phase 25)
  const [saveLayoutDialogOpen, setSaveLayoutDialogOpen] = useState(false)
  const [saveLayoutGroupId, setSaveLayoutGroupId] = useState<string | null>(null)
  const [layoutNameInput, setLayoutNameInput] = useState('')

  // Split pane resize state (Phase 25: resizable split views)
  const [splitPaneSizes, setSplitPaneSizes] = useState<Record<string, number[]>>({})
  const [isResizingSplit, setIsResizingSplit] = useState(false)
  const [resizingSplitIndex, setResizingSplitIndex] = useState<number | null>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const sidebarHeaderExtrasRef = useRef<HTMLSpanElement>(null)
  const restoringLayoutRef = useRef(false) // Guard against multiple rapid clicks
  const hotEdgeTimerRef = useRef<number | null>(null)

  // Split pane drag state (Phase 25: drag to reorder/remove)
  const [draggingSplitTabId, setDraggingSplitTabId] = useState<string | null>(null)
  const [splitDropTargetId, setSplitDropTargetId] = useState<string | null>(null)

  // Tab-to-edge drag state (Phase 25: SecureCRT-style drag to create splits)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [edgeDropZone, setEdgeDropZone] = useState<'left' | 'right' | 'top' | 'bottom' | null>(null)

  // Saved groups state (Plan 1: Tab Groups Redesign)
  const [liveGroupId, setLiveGroupId] = useState<string | null>(null)
  const [groupsRefreshKey, setGroupsRefreshKey] = useState(0)
  const [pendingLaunch, setPendingLaunch] = useState<Group | null>(null)
  const [defaultLaunchAction, setDefaultLaunchAction] = useState<LaunchChoice | null>(() => {
    const v = localStorage.getItem('defaultLaunchAction');
    return v === 'alongside' || v === 'replace' || v === 'new_window' ? v : null;
  })
  const [namePrompt, setNamePrompt] = useState<{ title: string; onConfirm: (name: string) => void } | null>(null)

  // Tab bar reorder drop target
  const [tabReorderDropTarget, setTabReorderDropTarget] = useState<{ tabId: string; side: 'before' | 'after' } | null>(null)

  // Standalone split view state (Phase 25: fluid split - independent of groups)
  const [splitTabs, setSplitTabs] = useState<string[]>([])
  // Layout types: horizontal (side-by-side), vertical (stacked),
  // '2-top-1-bottom' (2 on top row, 1 spanning bottom), '1-top-2-bottom' (1 spanning top, 2 on bottom)
  const [splitLayout, setSplitLayout] = useState<'horizontal' | 'vertical' | '2-top-1-bottom' | '1-top-2-bottom'>('horizontal')

  // Split pane context menu state (Phase 25)
  const [splitContextMenuPosition, setSplitContextMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const [splitContextMenuTabId, setSplitContextMenuTabId] = useState<string | null>(null)
  const splitContextMenu = useClampedMenuPosition(splitContextMenuPosition)

  // Discovery modal state
  const [discoveryModalOpen, setDiscoveryModalOpen] = useState(false)
  const [discoveryGroupName, setDiscoveryGroupName] = useState('')
  const [discoveryDevices, setDiscoveryDevices] = useState<{ name: string; tabId: string; ip?: string; profileId?: string; snmpProfileId?: string; cliFlavor?: string; credentialId?: string; snmpCredentialId?: string }[]>([])
  const [discoveryTargetTopologyId, setDiscoveryTargetTopologyId] = useState<string | null>(null)

  // Discovery toast state
  const [discoveryToast, setDiscoveryToast] = useState<{
    isVisible: boolean;
    deviceName: string;
    groupName: string;
    tabId: string;
  } | null>(null)

  // Selected sessions state (for keyboard shortcut)
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([])

  // Session settings dialog state (for tab/terminal context menu)
  const [sessionSettingsSession, setSessionSettingsSession] = useState<Session | null>(null)
  // Track session updates from terminal context menu to sync with SessionPanel
  const [externalSessionUpdate, setExternalSessionUpdate] = useState<Session | null>(null)

  // Share session dialog state
  const [shareSessionTabId, setShareSessionTabId] = useState<string | null>(null)
  // Track which sessions are actively shared: sessionId -> { token, viewerCount }
  const [sharedSessions, setSharedSessions] = useState<Map<string, { token: string; viewerCount: number }>>(new Map())

  // Enterprise connect dialog state (for credential selection before SSH connection)
  const [enterpriseConnectSession, setEnterpriseConnectSession] = useState<EnterpriseSession | null>(null)
  // The device's assigned profile id (device-anchored default) for the connect
  // dialog, so it can label which profile the "Device default" option resolves to.
  const [enterpriseConnectDeviceProfileId, setEnterpriseConnectDeviceProfileId] = useState<string | null>(null)

  // Profiles state (for looking up profile defaults like font size)
  const [profiles, setProfiles] = useState<CredentialProfile[]>([])

  // Load profiles on mount and refresh when profiles change
  useEffect(() => {
    if (!isEnterprise) {
      listProfiles().then(setProfiles).catch(console.error)
    }
    const handleProfilesChanged = () => {
      listProfiles().then(setProfiles).catch(console.error)
    }
    window.addEventListener('profiles-changed', handleProfilesChanged)
    return () => window.removeEventListener('profiles-changed', handleProfilesChanged)
  }, [isEnterprise])

  // Listen for session-restored event from AuthProvider (Phase 41)
  useEffect(() => {
    const handleSessionRestored = (event: Event) => {
      const customEvent = event as CustomEvent<{
        tabs: { id: string; title: string; active: boolean }[];
        timestamp: number;
      }>;

      logger.log('[App] Session restored, recreating tabs:', customEvent.detail);

      // Recreate tabs from restored state
      // Note: We only restore tab IDs and titles, not full session state (for security)
      // This creates placeholder tabs that users can re-connect manually
      const restoredTabs: Tab[] = customEvent.detail.tabs.map((restoredTab) => ({
        id: restoredTab.id,
        type: 'terminal' as const,
        title: restoredTab.title,
        sessionId: undefined, // Don't auto-connect (security)
        status: 'disconnected' as const,
      }));

      setTabs(restoredTabs);

      // Set active tab
      const activeTab = customEvent.detail.tabs.find((t) => t.active);
      if (activeTab) {
        setActiveTabId(activeTab.id);
      }
    };

    window.addEventListener('session-restored', handleSessionRestored);

    return () => {
      window.removeEventListener('session-restored', handleSessionRestored);
    };
  }, []);

  // Troubleshooting session state (Phase 26)
  const [troubleshootingDialogOpen, setTroubleshootingDialogOpen] = useState(false)
  // Honor the user's troubleshooting setting at boot — the panel's
  // checkbox feeds the same flag, so hardcoding `true` here made the
  // setting silently no-op for the app-level quick-start flow.
  const [captureAIConversations, setCaptureAIConversations] = useState(
    () => getTroubleshootingSettings().captureAIConversations
  )
  const [_isSummarizingSession, setIsSummarizingSession] = useState(false)

  // Status bar color state (customizable, defaults to VS Code blue)
  // _setStatusBarColor reserved for future settings UI integration
  const [statusBarColor, _setStatusBarColor] = useState('#007acc')


  // Topology state (legacy - overlays reference these but topologies now use tabs)
  const [topology] = useState<Topology | null>(null)
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)

  // Device details overlay state
  const [deviceOverlay, setDeviceOverlay] = useState<{
    device: Device | null;
    position: { x: number; y: number } | null;
  }>({ device: null, position: null })

  // Connection details overlay state
  const [connectionOverlay, setConnectionOverlay] = useState<{
    connection: Connection | null;
    position: { x: number; y: number } | null;
  }>({ connection: null, position: null })

  // Default context menu state (right-click in non-custom areas)
  const [defaultContextMenuPosition, setDefaultContextMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const [defaultContextMenuItems, setDefaultContextMenuItems] = useState<MenuItem[]>([])

  // Device context menu state (right-click)
  const [deviceContextMenu, setDeviceContextMenu] = useState<{
    device: Device | null;
    topologyId: string | null;
    position: { x: number; y: number } | null;
  }>({ device: null, topologyId: null, position: null })

  // Multi-send hook
  const {
    toggleMultiSend,
    isMultiSendEnabled,
    selectAllTerminals,
    registerListener,
    broadcast
  } = useMultiSend()

  // Keyboard shortcuts hook
  const keyboard = useKeyboard()

  // Tab multi-selection (Phase 25)
  const {
    selectedTabIds,
    toggleSelection: toggleTabSelection,
    rangeSelect: rangeSelectTab,
    isSelected: isTabSelected,
    clearSelection: clearTabSelection,
    selectionCount: tabSelectionCount
  } = useTabSelection()

  // Enrichment context for storing device/link data
  const { deviceEnrichments, getLinkEnrichment, setDeviceEnrichment } = useEnrichment()

  // Troubleshooting session hook (Phase 26)
  const {
    session: troubleshootingSession,
    isActive: isTroubleshootingActive,
    startSession: startTroubleshootingSession,
    addEntry: addTroubleshootingEntry,
    attachTopology: attachTroubleshootingTopology,
    endSession: endTroubleshootingSession,
    isCapturing: isTroubleshootingCapturing,
    setOnTimeout: setTroubleshootingTimeout,
  } = useTroubleshootingSession()

  // (`useCertRenewal()` used to be called here. The hook was always a
  // no-op — its body returned early because the cert renewal flow it
  // implemented required the sidecar's /cert/* endpoints to be alive
  // in enterprise mode, but the sidecar exits in enterprise mode by
  // design. See authStore.ts for the one-time-at-login cert flow that
  // actually runs today. Removed in S-8a.)

  // Computed values for StatusBar
  const connectedCount = useMemo(() => {
    return tabs.filter(tab => tab.status === 'connected').length
  }, [tabs])

  // Track which settings tab to open (for deep-linking from popovers)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined)

  // Open settings as a tab (VS Code style) - deduplicates to single settings tab
  const openSettingsTab = useCallback((tab?: SettingsTab) => {
    setSettingsInitialTab(tab)
    const existing = tabs.find(t => isSettingsTab(t))
    if (existing) {
      setActiveTabId(existing.id)
    } else {
      const newTab: Tab = {
        id: 'settings',
        type: 'settings',
        title: 'Settings',
        status: 'ready' as DetailStatus,
      }
      setTabs(prev => [...prev, newTab])
      setActiveTabId('settings')
    }
  }, [tabs])

  const openWorkspaceTab = useCallback(async (config: WorkspaceConfig) => {
    const existingTab = tabs.find(t => t.type === 'workspace' && t.workspaceConfig?.id === config.id)
    if (existingTab) {
      setActiveTabId(existingTab.id)
      setShowNewWorkspace(false)
      return
    }

    const isNewWorkspace = !existingTab
    await addSavedWorkspace(config)

    // Write AI tool init file if this is a new workspace and the tool expects one
    if (isNewWorkspace && config.mode === 'local') {
      const filename = aiToolInitFilename(config.aiTool.tool)
      if (filename) {
        try {
          const fileOps = new LocalFileOps()
          const fullPath = `${config.rootPath}/${filename}`
          const exists = await fileOps.exists(fullPath)
          if (!exists) {
            const prompt = await getWorkspaceInitPrompt() || DEFAULT_WORKSPACE_INIT_PROMPT
            await fileOps.writeFile(fullPath, prompt)
            logger.log(`Created workspace init file: ${filename}`)
          }
        } catch (err) {
          console.error('Failed to write workspace init file:', err)
          // Don't fail workspace creation if seed write fails
        }
      }
    }

    const newTab: Tab = {
      id: `workspace-${config.id}`,
      type: 'workspace',
      title: config.name,
      status: 'ready' as DetailStatus,
      workspaceConfig: config,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTab.id)
    setShowNewWorkspace(false)
  }, [tabs])

  const openBackupHistoryTab = useCallback((deviceId: string, deviceName: string) => {
    // Backup history is enterprise-only (Controller /config/* routes). Callers
    // include AI-panel navigation callbacks that fire in any mode, so gate here.
    if (!isEnterprise) return
    const existing = tabs.find(t => t.type === 'backup-history' && t.backupDeviceId === deviceId)
    if (existing) {
      setActiveTabId(existing.id)
      return
    }
    const newTab: Tab = {
      id: `backup-${deviceId}-${Date.now()}`,
      type: 'backup-history',
      title: `Backups: ${deviceName}`,
      status: 'ready' as DetailStatus,
      deviceName,
      backupDeviceId: deviceId,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTab.id)
  }, [tabs, isEnterprise])

  const activeSessionName = useMemo(() => {
    if (!activeTabId) return undefined
    const activeTab = tabs.find(t => t.id === activeTabId)
    return activeTab?.title
  }, [activeTabId, tabs])

  // SFTP status bar: is active tab an SSH terminal?
  const isTerminalFocused = useMemo(() => {
    const tab = tabs.find(t => t.id === activeTabId)
    return tab?.type === 'terminal' && tab?.protocol === 'ssh'
  }, [tabs, activeTabId])

  // Session ID of the active SSH tab (passed to pre-fill WorkspaceNewDialog)
  const activeTabSessionId = useMemo(() => {
    const tab = tabs.find(t => t.id === activeTabId)
    return tab?.type === 'terminal' ? tab.sessionId : undefined
  }, [tabs, activeTabId])

  // Open SFTP for a given session (reusable helper)
  const openSftpForSession = useCallback(async (sessionId: string) => {
    const sftpState = useSftpStore.getState()
    if (sftpState.getConnectionForSession(sessionId)) {
      // Already connected — just show panel
      sftpState.showPanel()
      setActiveView('sftp')
      setSidebarOpen(true)
      return
    }

    try {
      // Find the tab for this session to get enterprise fields
      const tab = tabs.find(t => t.sessionId === sessionId)

      if (isEnterprise) {
        // Enterprise mode: use tab data directly (no local session list)
        if (!tab) return
        await sftpState.openConnection({
          sessionId,
          deviceName: tab.title,
          cliFlavor: tab.cliFlavor || 'auto',
          sftpStartPath: null,
          enterpriseProfileId: tab.enterpriseProfileId,
          enterpriseTargetHost: tab.enterpriseTargetHost,
          enterpriseTargetPort: tab.enterpriseTargetPort,
        })
      } else {
        // Standalone mode: fetch session details from local agent
        const allSessions = await listSessions()
        const session = allSessions.find((s: any) => s.id === sessionId)
        if (!session) return

        await sftpState.openConnection({
          sessionId: session.id,
          deviceName: session.name,
          cliFlavor: session.cli_flavor,
          sftpStartPath: session.sftp_start_path || null,
        })
      }
      setActiveView('sftp')
      setSidebarOpen(true)
    } catch (err) {
      console.error('Failed to open SFTP:', err)
    }
  }, [tabs, isEnterprise])

  // SFTP toggle handler for status bar
  const handleStatusBarSftp = useCallback(async () => {
    const tab = tabs.find(t => t.id === activeTabId)
    if (!tab || tab.type !== 'terminal' || !tab.sessionId) return

    const sftpState = useSftpStore.getState()
    const existing = sftpState.getConnectionForSession(tab.sessionId)

    if (existing) {
      const wasVisible = sftpState.panelVisible
      sftpState.togglePanel()
      if (wasVisible) {
        // Toggling off — switch away from SFTP view
        setActiveView('sessions')
      } else {
        // Toggling on — switch to SFTP view
        setActiveView('sftp')
        setSidebarOpen(true)
      }
    } else {
      await openSftpForSession(tab.sessionId)
    }
  }, [tabs, activeTabId, openSftpForSession])

  // Get tabs to render in split view (standalone split - independent of groups)
  // Limited to 4 tabs max for clean layouts (side-by-side or 2x2 grid)
  const splitViewTabs = useMemo(() => {
    // Use standalone splitTabs if we have 2+ tabs in split
    if (splitTabs.length >= 2) {
      return splitTabs
        .slice(0, 4) // Limit to 4 tabs max
        .map(tabId => tabs.find(t => t.id === tabId))
        .filter((t): t is Tab => t !== undefined)
    }
    return null
  }, [splitTabs, tabs])

  // Check if active tab is part of the split view (for showing split vs single view)
  const isActiveTabInSplit = useMemo(() => {
    return splitViewTabs?.some(t => t.id === activeTabId) ?? false
  }, [splitViewTabs, activeTabId])

  // Memoize available sessions for AI panels to prevent infinite re-render loops.
  // Uses tab.id (unique per tab) so duplicate tabs to the same device are distinguishable.
  const availableSessions = useMemo(() => {
    return tabs
      .filter(tab => tab.type === 'terminal' && (tab.sessionId || tab.enterpriseSessionDefinitionId))
      .map(tab => ({
        id: tab.id,
        name: tab.title,
        connected: tab.status === 'connected',
        cliFlavor: tab.cliFlavor,
        // Saved session-definition id — what device memory + tribal context are
        // keyed on. tab.id is a runtime id (ssh-<uuid>-<ts>); memory is stored
        // under the saved id, so the AI side panel must look it up by this.
        savedSessionId: tab.sessionId || tab.enterpriseSessionDefinitionId,
      }))
  }, [tabs])

  // Sidebar resize handlers
  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return
      // Account for activity bar width (48px)
      const newWidth = e.clientX - 48
      // Clamp between 280 and 800 (280px minimum to fit toolbar buttons in one row)
      setSidebarWidth(Math.max(280, Math.min(800, newWidth)))
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing])

  // Listen for panel settings changes
  useEffect(() => {
    const handleSettingsChanged = (e: Event) => {
      const customEvent = e as CustomEvent<PanelSettings>
      setSidebarPinned(customEvent.detail.leftSidebarPinned)
      setAiPanelPinned(customEvent.detail.aiPanelPinned)
      setSidebarOverlay(customEvent.detail.sidebarOverlay)
      setHotEdgesEnabled(customEvent.detail.hotEdgesEnabled)
    }
    window.addEventListener(PANEL_SETTINGS_CHANGED, handleSettingsChanged)
    return () => window.removeEventListener(PANEL_SETTINGS_CHANGED, handleSettingsChanged)
  }, [])

  const handleActivityClick = (view: ViewType) => {
    if (activeView === view) {
      setSidebarOpen(!sidebarOpen)
    } else {
      setActiveView(view)
      setSidebarOpen(true)
    }
    // Reset profiling chat state when switching away from profiling-agents
    if (view !== 'plugin:profiling-agents:profiling-agents-list') {
      setProfilingChatAgent(null)
    }
  }

  // When a workspace tab becomes active, switch the sidebar to the workspaces
  // view so the file explorer shows. The sidebar's pinned/open state is left
  // alone — it honors the user's panel settings like every other tab.
  const isWorkspaceTabActive = useMemo(() => {
    const t = tabs.find(tab => tab.id === activeTabId)
    return t?.type === 'workspace'
  }, [tabs, activeTabId])

  useEffect(() => {
    if (isWorkspaceTabActive) {
      setActiveView('workspaces')
    }
  }, [isWorkspaceTabActive])

  // Auto-collapse sidebar when unpinned and clicking main area.
  // React events bubble through portal trees, so a click on a file in the
  // workspace file explorer (portaled INTO the sidebar DOM but still a
  // React child of the workspace tab inside main-area) would close the
  // sidebar. Check the DOM target — if it's inside .sidebar or
  // .activity-bar, leave the sidebar open.
  const handleMainAreaClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!sidebarPinned && sidebarOpen) {
      const target = e.target as HTMLElement
      if (target.closest('.sidebar') || target.closest('.activity-bar')) {
        return
      }
      setSidebarOpen(false)
    }
  }, [sidebarPinned, sidebarOpen])

  const getSidebarTitle = () => {
    switch (activeView) {
      case 'sessions': return isEnterprise ? 'Devices' : 'Sessions'
      case 'topology': return 'Topology'
      case 'docs': return 'Documents'
      case 'changes': return 'Changes'
      case 'agents': return 'Agents'
      case 'stacks': return 'Stacks'
      case 'sftp': return 'SFTP Browser'
      case 'workspaces': return 'Workspaces'
      default: {
        // Check for plugin panel
        const pluginPanel = pluginPanels.find(
          p => `plugin:${p.pluginName}:${p.panel.id}` === activeView
        )
        return pluginPanel?.panel.label ?? 'Panel'
      }
    }
  }

  // Note: Old Phase 20 session topology loading removed in Phase 20.1
  // Topologies now open as tabs via TopologyTabEditor

  // Note: Device position changes now handled by TopologyTabEditor

  // Handle device selection from panel or canvas (with optional screen position for overlay)
  const handleTopologyDeviceSelect = useCallback((device: Device, screenPosition?: { x: number; y: number }) => {
    setSelectedDeviceId(device.id)
    // Show device details overlay if screen position provided
    if (screenPosition) {
      setDeviceOverlay({ device, position: screenPosition })
    }
  }, [])

  // Close device details overlay
  const handleDeviceOverlayClose = useCallback(() => {
    setDeviceOverlay({ device: null, position: null })
  }, [])

  // Focus terminal for device (if it has an active session)
  const handleFocusTerminal = useCallback((device: Device) => {
    // Find tab with matching sessionId
    const tab = tabs.find(t => t.sessionId === device.sessionId)
    if (tab) {
      setActiveTabId(tab.id)
    }
    handleDeviceOverlayClose()
  }, [tabs])

  // Open AI chat with device context
  const handleOpenAIChat = useCallback((device: Device) => {
    logger.log('Opening AI Chat for device:', device.name)
    // Set device context for AI (using enhanced AiContext)
    setAiContext({
      device: {
        name: device.name,
        type: device.type,
        platform: device.platform,
        primaryIp: device.primaryIp,
        site: device.site,
        role: device.role,
        status: device.status,
      }
    })
    setAiChatOpen(true)
    handleDeviceOverlayClose()
  }, [])

  // Open AI chat from terminal with session context
  const handleOpenAIChatFromTerminal = useCallback((sessionName?: string) => {
    // Build context from active terminal
    const context: AiContext = {}
    if (sessionName) {
      context.sessionName = sessionName
    }
    // Terminal context is captured via getTerminalContext callback passed to AI components
    setAiContext(context)
    setAiChatOpen(true)
    setAiExpandTrigger(t => t + 1) // Expand if collapsed
  }, [])

  // Handle AI action from terminal context menu (inline popup)
  const handleTerminalAIAction = useCallback((action: string, text: string, position: { x: number; y: number }, sessionId?: string, sessionName?: string) => {
    setAiPopup({
      isOpen: true,
      position,
      action: action as 'explain' | 'fix' | 'suggest',
      selectedText: text,
      sessionId,
      sessionName,
    })
  }, [])

  // Cmd+I inside a prose Monaco editor (markdown / plaintext / log /
  // text / rst) dispatches a window event instead of opening the
  // inline-edit overlord — code rewrites in prose docs are useless.
  // Listen here and route to the same AIInlinePopup the terminal
  // "Ask AI" context menu uses, with full agent capability.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OverlordOpenAIPopupDetail>).detail
      if (!detail) return
      setAiPopup({
        isOpen: true,
        position: detail.position,
        action: 'explain',
        selectedText: detail.selectedText,
      })
    }
    window.addEventListener(OVERLORD_OPEN_AI_POPUP_EVENT, handler as EventListener)
    return () => window.removeEventListener(OVERLORD_OPEN_AI_POPUP_EVENT, handler as EventListener)
  }, [])

  // Handle floating AI chat from terminal context menu
  const handleTerminalAIFloatingChat = useCallback((position: { x: number; y: number }, sessionId?: string, sessionName?: string, selectedText?: string) => {
    setAiFloatingChat({
      isOpen: true,
      position,
      sessionId,
      sessionName,
      selectedText,
    })
  }, [])

  // Contextual "Ask AI" help (AskAiHelp buttons in settings) → open the floating
  // pop-over anchored near the click and auto-send the help question.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<import('./components/AskAiHelp').AskAiHelpDetail>).detail
      if (!detail) return
      // Keep the pop-over on-screen for clicks near the right/bottom edges.
      const x = Math.min(detail.position.x, window.innerWidth - 380)
      const y = Math.min(detail.position.y, window.innerHeight - 420)
      setAiFloatingChat({
        isOpen: true,
        position: { x: Math.max(12, x), y: Math.max(12, y) },
        initialPrompt: detail.prompt,
      })
    }
    window.addEventListener(ASK_AI_HELP_EVENT, handler as EventListener)
    return () => window.removeEventListener(ASK_AI_HELP_EVENT, handler as EventListener)
  }, [])

  // First-run onboarding wizard: show once on first launch (standalone only —
  // enterprise AI/integrations are controller-managed). Skipping/finishing sets
  // app.setupComplete; reopen via the command palette.
  useEffect(() => {
    if (!capabilitiesLoaded) return
    if (isStandalone() && !appSettings['app.setupComplete']) {
      setWizardOpen(true)
    }
    // Run once after capabilities resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilitiesLoaded])

  const handleWizardClose = useCallback(() => {
    setWizardOpen(false)
    updateAppSetting('app.setupComplete', true)
  }, [updateAppSetting])

  // Re-open the setup wizard from Settings → General → Onboarding.
  useEffect(() => {
    const handler = () => setWizardOpen(true)
    window.addEventListener('netstacks:open-setup-wizard', handler)
    return () => window.removeEventListener('netstacks:open-setup-wizard', handler)
  }, [])

  const handleWizardOpenIntegrations = useCallback(() => {
    handleWizardClose()
    openSettingsTab('integrations')
  }, [handleWizardClose, openSettingsTab])

  // AI proposes an API Resource → open the dialog pre-filled (SP5-C).
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<Partial<ApiResource>>).detail
      if (!d) return
      setPrefillApiResource({
        id: '',
        name: d.name || '',
        base_url: d.base_url || '',
        auth_type: (d.auth_type as ApiResource['auth_type']) || 'none',
        auth_header_name: d.auth_header_name,
        test_path: d.test_path,
        verify_ssl: true,
        timeout_secs: 30,
      } as ApiResource)
    }
    window.addEventListener('netstacks:prefill-api-resource', handler as EventListener)
    return () => window.removeEventListener('netstacks:prefill-api-resource', handler as EventListener)
  }, [])

  // macOS Force Touch (force click) on a terminal → open the action popover.
  // Built-in actions (Search Web, Copy) plus the user's custom commands flagged
  // for Force Touch (already bound to the selection by the terminal).
  const handleTerminalForceClick = useCallback((text: string, position: { x: number; y: number }, sessionId?: string, sessionName?: string, customActions: { id: string; label: string; run: () => void }[] = []) => {
    const options: ForceTouchOption[] = [
      ...forceTouchOptions,
      ...customActions.map(a => ({ id: a.id, label: a.label, run: () => a.run() })),
    ]
    setForcePopover({ isOpen: true, position, context: { text, sessionId, sessionName }, options })
  }, [])

  // Discover neighbors for a device - opens AI panel with discovery prompt
  const handleDiscoverNeighbors = useCallback((device: Device) => {
    handleDeviceOverlayClose()
    // Open AI panel with a prompt to discover neighbors for this device
    setAiExternalPrompt({
      prompt: `Discover neighbors for device "${device.name}"${device.primaryIp ? ` (${device.primaryIp})` : ''}. Use CDP/LLDP neighbor discovery commands if there's an active terminal session for this device, or query configured integration sources (LibreNMS, NetBox, NetStacks-Crawler) for neighbor information.`,
      counter: Date.now()
    })
    setAiChatOpen(true)
    setAiExpandTrigger(t => t + 1)
  }, [])

  // AI Discover - enriches topology with device details using external integrations
  // Opens AI side panel so user can see the work happening
  const handleAIDiscover = useCallback(async (topology: Topology) => {
    // Check for custom AI Discovery prompt from Settings > Prompts (stored in backend)
    const customDiscoveryPrompt = await getDiscoveryPrompt()

    // Set topology context for AI
    setAiTopologyContext({
      topologyId: topology.id,
      devices: topology.devices,
      refreshCounter: Date.now()
    })

    // Fetch available integration sources
    const [netboxSourcesResult] = await Promise.allSettled([
      listNetBoxSources()
    ])

    const netboxSourcesList = netboxSourcesResult.status === 'fulfilled' ? netboxSourcesResult.value : []

    // Build connection list
    const connectionList = topology.connections.map(c => {
      const source = topology.devices.find(d => d.id === c.sourceDeviceId)?.name || 'Unknown'
      const target = topology.devices.find(d => d.id === c.targetDeviceId)?.name || 'Unknown'
      const srcInt = c.sourceInterface || '?'
      const tgtInt = c.targetInterface || '?'
      return `${source} (${srcInt}) ↔ ${target} (${tgtInt})`
    }).join('\n')

    // Build detailed device info showing what's already collected
    const deviceInfoList = topology.devices.map(d => {
      const lines = [`  - **${d.name}** (Device ID: ${d.id})`]
      if (d.sessionId) lines.push(`    Session ID: ${d.sessionId}`)
      if (d.primaryIp) lines.push(`    IP: ${d.primaryIp}`)

      // Show already-collected info
      const collectedInfo: string[] = []
      if (d.vendor) collectedInfo.push(`Vendor: ${d.vendor}`)
      if (d.platform) collectedInfo.push(`Platform: ${d.platform}`)
      if (d.version) collectedInfo.push(`Version: ${d.version}`)
      if (d.model) collectedInfo.push(`Model: ${d.model}`)
      if (d.serial) collectedInfo.push(`Serial: ${d.serial}`)
      if (d.uptime) collectedInfo.push(`Uptime: ${d.uptime}`)
      if (d.type && d.type !== 'unknown') collectedInfo.push(`Type: ${d.type}`)

      if (collectedInfo.length > 0) {
        lines.push(`    Already collected: ${collectedInfo.join(', ')}`)
      } else {
        lines.push(`    Already collected: (none - discovery may have failed)`)
      }

      return lines.join('\n')
    }).join('\n')

    // Build available sources section
    const availableSourcesSection = []

    if (netboxSourcesList.length > 0) {
      availableSourcesSection.push(`**NetBox Sources:**`)
      for (const src of netboxSourcesList) {
        availableSourcesSection.push(`  - netbox_source_id: \`${src.id}\` (${src.name})`)
      }
      availableSourcesSection.push('')
    }

    // Count devices with sessions
    const devicesWithSessions = topology.devices.filter(d => d.sessionId).length

    // Build the prompt: editable instructions (custom OR the default) + the live
    // topology context. The default instructions live in DEFAULT_AI_DISCOVERY_PROMPT
    // (editable in Settings → Prompts), so the editor matches what actually runs.
    const discoveryContext = `

--- Topology Context ---
Topology: "${topology.name}" (${topology.devices.length} devices, ${topology.connections.length} connections, ${devicesWithSessions} with open sessions)
Topology ID: ${topology.id}

### Devices (Session IDs shown where available — use run_command with them):
${deviceInfoList || '(No devices)'}

### Connections:
${connectionList || '(No connections)'}
${netboxSourcesList.length > 0 ? `\n### NetBox Sources:\n${netboxSourcesList.map(s => `- netbox_source_id: \`${s.id}\` (${s.name})`).join('\n')}` : ''}
`
    const prompt = (customDiscoveryPrompt || DEFAULT_AI_DISCOVERY_PROMPT) + discoveryContext

    // Open AI side panel and send the prompt
    setAiChatOpen(true)
    setAiExternalPrompt(prev => ({
      prompt,
      counter: (prev?.counter || 0) + 1
    }))
  }, [])

  // Handle saving temporary topology - converts tab from temporary to saved
  const handleSaveTopology = useCallback((tabId: string, savedTopology: Topology) => {
    setTabs(prev => prev.map(tab => {
      if (tab.id === tabId) {
        return {
          ...tab,
          topologyId: savedTopology.id,
          topologyName: savedTopology.name,
          title: savedTopology.name,
          temporaryTopology: undefined,
          isTemporaryTopology: false,
        }
      }
      return tab
    }))
  }, [])

  // Handle quick prompt selection from status bar
  const handleQuickPromptSelect = useCallback((prompt: QuickPrompt) => {
    // Build context similar to AI Discovery
    const activeTab = tabs.find(t => t.id === activeTabId)

    const contextLines: string[] = []

    // Add active session info if on terminal tab
    if (activeTab && isTerminalTab(activeTab) && activeTab.sessionId) {
      contextLines.push(`Active Session: ${activeTab.title}`)
    }

    // Add connected sessions (from tabs with connected status)
    const connectedTabs = tabs.filter(t => isTerminalTab(t) && t.status === 'connected')
    if (connectedTabs.length > 0) {
      const names = connectedTabs.map(t => t.title).join(', ')
      contextLines.push(`Connected Sessions: ${names}`)
    }

    // Add topology info if on topology tab
    if (activeTab && isTopologyTab(activeTab) && activeTab.topologyId) {
      contextLines.push(`Active Topology ID: ${activeTab.topologyId}`)
    }

    // Build final prompt
    const contextSection = contextLines.length > 0
      ? `\n\n--- Current Context ---\n${contextLines.join('\n')}`
      : ''

    const fullPrompt = prompt.prompt + contextSection

    // Open AI panel and send prompt
    setAiChatOpen(true)
    setAiExternalPrompt({ prompt: fullPrompt, counter: Date.now() })
  }, [tabs, activeTabId])

  // Handle manage prompts - opens settings to prompts tab
  const handleManagePrompts = useCallback(() => {
    openSettingsTab('prompts')
  }, [openSettingsTab])

  // Handle snippet selection from status bar - paste into active terminal
  const handleSnippetSelect = useCallback((snippet: GlobalSnippet) => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (activeTab && isTerminalTab(activeTab)) {
      const handle = terminalRefs.current.get(activeTab.id)
      if (handle) {
        handle.writeText(snippet.command)
      }
    }
  }, [tabs, activeTabId])

  // Handle manage snippets - opens settings to snippets tab
  const handleManageSnippets = useCallback(() => {
    openSettingsTab('snippets')
  }, [openSettingsTab])

  // Pending Quick Call awaiting variable input (null when no prompt active)
  const [pendingQuickCall, setPendingQuickCall] = useState<{
    call: QuickAction
    variables: string[]
  } | null>(null)

  // Open a QuickActionResult as a new "API: <name>" document tab. Restored
  // from before commit 5e7e18d which moved Quick Actions into Settings and
  // dropped this handler — toasts no longer had a tab to open into.
  const handleOpenApiResponseTab = useCallback((title: string, result: QuickActionResult) => {
    const data = result.raw_body !== undefined && result.raw_body !== null
      ? JSON.stringify(result.raw_body, null, 2)
      : JSON.stringify(result, null, 2)
    const newTabId = `api-response-${Date.now()}`
    const newTab: Tab = {
      id: newTabId,
      type: 'api-response',
      title: `API: ${title}`,
      status: 'ready' as const,
      apiResponseTitle: title,
      apiResponseData: data,
      apiResponseStatus: result.status_code,
      apiResponseDurationMs: result.duration_ms,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTabId)
  }, [])

  // Actually run the call with the given variables (extracted into its own
  // closure so the variable-prompt dialog can call it on submit).
  const runQuickCall = useCallback(async (call: QuickAction, vars: Record<string, string>) => {
    try {
      const result = await executeQuickAction(call.id, vars)
      logger.debug('[quick-call]', result)

      // Build action buttons for the toast. Each becomes a small button.
      const actions: { label: string; onClick: () => void }[] = []

      // Action 1: open the full response in a new tab (when there's a body).
      if (result.raw_body !== undefined && result.raw_body !== null) {
        actions.push({
          label: 'Open in tab',
          onClick: () => handleOpenApiResponseTab(call.name, result),
        })
      }

      // Action 2: if the extracted value matches a known session by name or
      // host, offer a one-click "Connect to <name>" that opens its terminal.
      // Fire-and-forget; we add the action after sessions resolve (toast
      // rendering reads the actions array by reference but we send it to
      // showToast below; so we need sessions resolved BEFORE showToast).
      const ev = result.extracted_value
      if (ev !== undefined && ev !== null) {
        const candidates: string[] = typeof ev === 'string'
          ? [ev]
          : Array.isArray(ev) && ev.every(v => typeof v === 'string')
            ? (ev as string[]).slice(0, 1)  // only match first if array of strings
            : []
        if (candidates.length > 0) {
          try {
            const allSessions = await listSessions()
            const needle = candidates[0].trim().toLowerCase()
            const matched = allSessions.find((s) =>
              s.name.toLowerCase() === needle
              || s.host.toLowerCase() === needle
              || s.name.toLowerCase().includes(needle)
              || s.host.toLowerCase().includes(needle)
            )
            if (matched) {
              // Truncate long hostnames in the button label so the toast
              // message stays readable. Full session name lives in the
              // button's title tooltip via the rendered text being clipped
              // by CSS max-width if needed.
              const shortName = matched.name.length > 20
                ? `${matched.name.slice(0, 18)}…`
                : matched.name
              actions.push({
                label: `Connect to ${shortName}`,
                onClick: () => {
                  window.dispatchEvent(
                    new CustomEvent('netstacks:open-session', { detail: { sessionId: matched.id } })
                  )
                },
              })
            }
          } catch (e) {
            logger.debug('[quick-call] session match failed:', e)
          }
        }
      }

      // Build a toast message that actually reflects what came back.
      if (!result.success) {
        const detail = result.error
          ? `: ${result.error}`
          : result.status_code
            ? ` (HTTP ${result.status_code})`
            : ''
        showToast(`"${call.name}" failed${detail}`, 'error', undefined, actions)
        return
      }

      if (ev !== undefined && ev !== null) {
        const display = typeof ev === 'string' ? ev : JSON.stringify(ev)
        const truncated = display.length > 120 ? `${display.slice(0, 117)}…` : display
        showToast(`${call.name}: ${truncated}`, 'success', undefined, actions)
      } else if (call.json_extract_path) {
        showToast(
          `"${call.name}" ran (HTTP ${result.status_code}) but extract path "${call.json_extract_path}" had no match`,
          'warning',
          undefined,
          actions,
        )
      } else {
        showToast(`Executed "${call.name}" (HTTP ${result.status_code})`, 'success', undefined, actions)
      }
    } catch (e) {
      showToast(`"${call.name}" failed: ${getErrorMessage(e, String(e))}`, 'error')
    }
  }, [handleOpenApiResponseTab])

  // Handle quick call selection from status bar — if the call has any
  // {{variables}}, prompt the user to fill them in before firing. Built-in
  // vars (username/password/token) and multi-step extracted vars are
  // supplied by the backend and don't need user input.
  const handleQuickCallSelect = useCallback(async (call: QuickAction) => {
    const needed = extractCallVariables(call)
    if (needed.length === 0) {
      await runQuickCall(call, {})
      return
    }
    setPendingQuickCall({ call, variables: needed })
  }, [runQuickCall])

  // Handle manage quick calls - opens settings to quick calls tab
  const handleManageQuickCalls = useCallback(() => {
    openSettingsTab('quickCalls')
  }, [openSettingsTab])

  // Handle manage tunnels - opens settings to tunnels tab
  const handleManageTunnels = useCallback(() => {
    openSettingsTab('tunnels')
  }, [openSettingsTab])

  // Handle opening device detail in a dedicated tab
  const handleOpenDeviceDetailTab = useCallback((device: Device) => {
    // Check if tab already exists for this device
    const existingTab = tabs.find(
      t => t.type === 'device-detail' && t.deviceName === device.name
    )
    if (existingTab) {
      setActiveTabId(existingTab.id)
      return
    }

    // Use profile_id from the device (set during discovery or session link)
    const profileId = device.profileId

    // Create new device-detail tab
    const newTabId = `device-detail-${device.id || device.name}-${Date.now()}`
    const newTab: Tab = {
      id: newTabId,
      type: 'device-detail',
      title: `${device.name}`,
      status: 'ready' as const,
      deviceName: device.name,
      deviceSessionId: device.sessionId,
      deviceHost: device.primaryIp,
      deviceProfileId: profileId,
      deviceId: device.netboxId?.toString() || device.id,  // Enterprise: controller device UUID
      deviceData: device,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTabId)
  }, [tabs])

  // Handle opening link detail in a dedicated tab
  const handleOpenLinkDetailTab = useCallback((connection: Connection, sourceDevice: Device, targetDevice: Device) => {
    // Check if tab already exists for this connection
    const existingTab = tabs.find(
      t => t.type === 'link-detail' && t.connectionId === connection.id
    )
    if (existingTab) {
      setActiveTabId(existingTab.id)
      return
    }

    // For SNMP polling, prefer the SNMP profile (has communities) over the SSH profile
    const snmpProfileId = sourceDevice.snmpProfileId || sourceDevice.profileId

    // Create new link-detail tab
    const newTabId = `link-detail-${connection.id}-${Date.now()}`
    const newTab: Tab = {
      id: newTabId,
      type: 'link-detail',
      title: `${sourceDevice.name} - ${targetDevice.name}`,
      status: 'ready' as const,
      connectionId: connection.id,
      sourceDeviceName: sourceDevice.name,
      targetDeviceName: targetDevice.name,
      sourceHost: sourceDevice.primaryIp,
      targetHost: targetDevice.primaryIp,
      sourceInterfaceName: connection.sourceInterface,
      targetInterfaceName: connection.targetInterface,
      deviceProfileId: snmpProfileId,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTabId)
  }, [tabs])

  // Handle opening MOP workspace in a dedicated tab
  const handleOpenMopTab = useCallback((planId?: string, planName?: string, executionId?: string) => {
    // Check for existing tab with same plan
    if (planId) {
      const existingTab = tabs.find(t => t.type === 'mop' && t.mopPlanId === planId)
      if (existingTab) {
        setActiveTabId(existingTab.id)
        return
      }
    }

    const newTabId = `mop-${planId || 'new'}-${Date.now()}`
    const newTab: Tab = {
      id: newTabId,
      type: 'mop',
      title: planName || 'New MOP',
      mopPlanId: planId,
      mopExecutionId: executionId,
      status: 'ready' as DetailStatus,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTabId)
  }, [tabs])

  // Open (or focus) an agent run as a full main-window tab. The run lives on
  // the backend + the useAgentTasks store, so closing the tab doesn't stop it.
  const handleOpenAgentRunTab = useCallback((taskId: string, title: string) => {
    const existing = tabs.find(t => t.type === 'agent-run' && t.agentTaskId === taskId)
    if (existing) { setActiveTabId(existing.id); return }
    const newTabId = `agent-${taskId}`
    const newTab: Tab = {
      id: newTabId,
      type: 'agent-run',
      title: title || 'Agent Run',
      agentTaskId: taskId,
      status: 'ready' as DetailStatus,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTabId)
  }, [tabs])

  // Pop the AI chat tab out into its own window (the floating chat). NOTE: a
  // separate window can't reach the MAIN window's open terminals, so a popped
  // chat does backend-driven work (SSH to devices, docs) but not run_command on
  // a main-window terminal — an inherent multi-window limitation.
  const handlePopoutAIChat = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId)
    if (!tab || tab.type !== 'ai-chat') return
    const params = new URLSearchParams({ popout: 'chat', title: tab.title })
    const dropTab = () => {
      setTabs(prev => prev.filter(t => t.id !== tabId))
      if (activeTabId === tabId) {
        const remaining = tabs.filter(t => t.id !== tabId)
        setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null)
      }
    }
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      const popout = new WebviewWindow(`popout-${tab.id}`, {
        url: `index.html?${params.toString()}`,
        title: tab.title,
        width: 480,
        height: 720,
        minWidth: 360,
        minHeight: 420,
        decorations: true,
      })
      popout.once('tauri://created', dropTab)
      popout.once('tauri://error', (e) => {
        console.error('[popout] chat failed:', e)
        showToast('Failed to pop out chat', 'error')
      })
    } catch {
      const basePath = window.location.pathname.startsWith('/terminal') ? '/terminal/' : '/'
      const url = `${window.location.origin}${basePath}?${params.toString()}`
      const popup = window.open(url, `popout-${tab.id}`, 'width=480,height=720')
      if (popup) dropTab()
      else showToast('Pop-up blocked — please allow pop-ups for this site', 'warning')
    }
  }, [tabs, activeTabId])

  // Continue a finished agent run as a chat — IN THE SAME TAB. Converts the
  // static agent-run tab into a live chat session (reusing the AI chat engine),
  // seeded with the run's conversation so the user can keep talking to it.
  const handleContinueAgentInChat = useCallback((tabId: string, seed: AgentMessage[]) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId && t.type === 'agent-run'
        ? { ...t, type: 'ai-chat', aiChatSeed: seed, agentTaskId: undefined }
        : t
    ))
  }, [])

  // Open (or focus) the full AI chat-session tab — the maximize action from the
  // AI side panel. One chat tab at a time (focus if already open).
  const handleOpenAIChatTab = useCallback(() => {
    const existing = tabs.find(t => t.type === 'ai-chat')
    if (existing) { setActiveTabId(existing.id); return }
    const id = `ai-chat-${Date.now()}`
    const newTab: Tab = { id, type: 'ai-chat', title: useAssistantNameStore.getState().name, status: 'ready' as DetailStatus }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(id)
  }, [tabs])

  // Dock a chat tab back into the side panel (the reverse of "open as tab").
  // The conversation resumes via the shared lastConversationId, so the side
  // panel picks up exactly where the tab left off.
  const handleDockChatToPanel = useCallback((tabId: string) => {
    setAiChatOpen(true)
    setAiPanelCollapsed(false)
    setTabs(prev => prev.filter(t => t.id !== tabId))
    if (activeTabId === tabId) {
      const remaining = tabs.filter(t => t.id !== tabId)
      setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null)
    }
  }, [tabs, activeTabId])

  const handleOpenIncidentTab = useCallback((id?: string) => {
    if (id) {
      const existing = tabs.find(t => t.type === 'incident-detail' && t.incidentId === id)
      if (existing) { setActiveTabId(existing.id); return }
    } else {
      const existing = tabs.find(t => t.type === 'incident-detail' && !t.incidentId)
      if (existing) { setActiveTabId(existing.id); return }
    }
    const tab: Tab = {
      id: `incident-${id || 'new'}-${Date.now()}`,
      type: 'incident-detail',
      title: id ? 'Incident...' : 'New Incident',
      status: 'loading' as DetailStatus,
      incidentId: id,
    }
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [tabs])

  const handleOpenAlertTab = useCallback((id: string) => {
    const existing = tabs.find(t => t.type === 'alert-detail' && t.alertId === id)
    if (existing) { setActiveTabId(existing.id); return }
    const tab: Tab = {
      id: `alert-${id}-${Date.now()}`,
      type: 'alert-detail',
      title: 'Alert...',
      status: 'loading' as DetailStatus,
      alertId: id,
    }
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [tabs])

  // Handle opening a config template in a dedicated tab
  const handleOpenConfigTemplateTab = useCallback((templateId: string, templateName: string) => {
    const existing = tabs.find(t => t.type === 'config-template' && t.configTemplateId === templateId)
    if (existing) { setActiveTabId(existing.id); return }
    const tab: Tab = {
      id: `config-template-${templateId}`,
      type: 'config-template',
      title: `Template: ${templateName}`,
      status: 'connected' as DetailStatus,
      configTemplateId: templateId,
    }
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [tabs])

  // Handle creating a new config template tab
  const handleCreateConfigTemplate = useCallback(() => {
    const tabId = `config-template-new-${Date.now()}`
    const tab: Tab = {
      id: tabId,
      type: 'config-template',
      title: 'New Template',
      status: 'connected' as DetailStatus,
      configTemplateId: '',
    }
    setTabs(prev => [...prev, tab])
    setActiveTabId(tabId)
  }, [])

  // Handle creating a new config stack tab
  const handleCreateConfigStack = useCallback(() => {
    const tabId = `config-stack-new-${Date.now()}`
    const tab: Tab = {
      id: tabId,
      type: 'config-stack',
      title: 'New Stack',
      status: 'connected' as DetailStatus,
      configStackId: '',
    }
    setTabs(prev => [...prev, tab])
    setActiveTabId(tabId)
  }, [])

  // Handle opening a config stack in a dedicated tab
  const handleOpenConfigStackTab = useCallback((stackId: string, stackName: string) => {
    const existing = tabs.find(t => t.type === 'config-stack' && t.configStackId === stackId)
    if (existing) { setActiveTabId(existing.id); return }
    const tab: Tab = {
      id: `config-stack-${stackId}`,
      type: 'config-stack',
      title: `Stack: ${stackName}`,
      status: 'connected' as DetailStatus,
      configStackId: stackId,
    }
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [tabs])

  // Handle opening a config instance in a dedicated tab
  const handleOpenInstanceTab = useCallback((instanceId: string, instanceName: string, stackId?: string) => {
    if (instanceId) {
      const existing = tabs.find(t => t.type === 'config-instance' && t.configInstanceId === instanceId)
      if (existing) {
        setActiveTabId(existing.id)
        return
      }
    }
    const tabId = instanceId ? `config-instance-${instanceId}` : `config-instance-new-${Date.now()}`
    const newTab: Tab = {
      id: tabId,
      type: 'config-instance',
      title: instanceName || 'New Instance',
      status: 'connected' as DetailStatus,
      configInstanceId: instanceId || undefined,
      configInstanceStackId: stackId,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(tabId)
  }, [tabs])

  // Handle opening a deployment detail in a dedicated tab
  const handleOpenDeploymentTab = useCallback((deploymentId: string, deploymentName: string) => {
    const existing = tabs.find(t => t.type === 'config-deployment' && t.configDeploymentId === deploymentId)
    if (existing) { setActiveTabId(existing.id); return }
    const tab: Tab = {
      id: `config-deployment-${deploymentId}`,
      type: 'config-deployment',
      title: `Deployment: ${deploymentName}`,
      status: 'connected' as DetailStatus,
      configDeploymentId: deploymentId,
    }
    setTabs(prev => [...prev, tab])
    setActiveTabId(tab.id)
  }, [tabs])

  // Handle opening an SFTP file in an editor tab
  const handleSftpOpenFile = useCallback((connectionId: string, filePath: string, fileName: string, deviceName: string) => {
    // Check if already open
    const existing = tabs.find(t =>
      t.type === 'sftp-editor' &&
      t.sftpConnectionId === connectionId &&
      t.sftpFilePath === filePath
    )
    if (existing) {
      setActiveTabId(existing.id)
      return
    }

    const newTab: Tab = {
      id: `sftp-${connectionId}-${Date.now()}`,
      type: 'sftp-editor',
      title: `SFTP: ${deviceName}:${fileName}`,
      status: 'ready' as DetailStatus,
      sftpConnectionId: connectionId,
      sftpFilePath: filePath,
      sftpFileName: fileName,
      sftpDeviceName: deviceName,
      sftpDirty: false,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTab.id)
  }, [tabs])

  // Handle saving device enrichment to docs
  const handleSaveDeviceToDocs = useCallback(async (device: Device) => {
    // Get enrichment from context (via useEnrichment)
    const result = await saveDeviceEnrichmentToDoc(device, undefined, [])
    if (result.success) {
      showToast(`Device "${device.name}" saved to docs`, 'success')
    } else {
      showToast(`Failed to save device: ${result.error}`, 'error')
    }
  }, [])

  // Handle saving link enrichment to docs
  const handleSaveLinkToDocs = useCallback(async (connection: Connection, sourceDevice: Device, targetDevice: Device) => {
    // Create link enrichment from connection data
    if (connection.sourceInterface && connection.targetInterface) {
      const linkEnrichment = {
        connectionId: connection.id,
        collectedAt: new Date().toISOString(),
        sourceInterface: {
          name: connection.sourceInterface,
          status: connection.status === 'active' ? 'up' as const : 'down' as const,
        },
        destInterface: {
          name: connection.targetInterface,
          status: connection.status === 'active' ? 'up' as const : 'down' as const,
        },
      }
      const result = await saveLinkEnrichmentToDoc(
        sourceDevice,
        targetDevice,
        linkEnrichment,
        sourceDevice.name,
        targetDevice.name
      )
      if (result.success) {
        showToast(`Link ${sourceDevice.name} ↔ ${targetDevice.name} saved to docs`, 'success')
      } else {
        showToast(`Failed to save link: ${result.error}`, 'error')
      }
    } else {
      showToast('Cannot save link: missing interface names', 'warning')
    }
  }, [])

  // Note: Connection click now handled within TopologyTabEditor

  // Close connection details overlay
  const handleConnectionOverlayClose = useCallback(() => {
    setConnectionOverlay({ connection: null, position: null })
  }, [])

  // Get device names for connection overlay
  const getDeviceName = useCallback((deviceId: string) => {
    return topology?.devices.find(d => d.id === deviceId)?.name
  }, [topology])

  // Handle device right-click context menu
  const handleDeviceContextMenu = useCallback((device: Device, screenPosition: { x: number; y: number }, topologyId?: string) => {
    // Close overlays
    setDeviceOverlay({ device: null, position: null })
    setConnectionOverlay({ connection: null, position: null })
    // Show context menu
    setDeviceContextMenu({ device, topologyId: topologyId || null, position: screenPosition })
  }, [])

  // Close device context menu
  const closeDeviceContextMenu = useCallback(() => {
    setDeviceContextMenu({ device: null, topologyId: null, position: null })
  }, [])

  // Device edit dialog state
  const [editingDevice, setEditingDevice] = useState<{
    device: Device | null;
    topologyId: string | null;
  }>({ device: null, topologyId: null })

  // Handle device edit (opens edit dialog)
  const handleDeviceEdit = useCallback(() => {
    if (deviceContextMenu.device && deviceContextMenu.topologyId) {
      setEditingDevice({
        device: { ...deviceContextMenu.device },
        topologyId: deviceContextMenu.topologyId
      })
    }
    closeDeviceContextMenu()
  }, [deviceContextMenu, closeDeviceContextMenu])

  // Handle device delete
  const handleDeviceDelete = useCallback(async () => {
    const { device, topologyId } = deviceContextMenu
    if (!device || !topologyId) return

    try {
      await deleteDevice(topologyId, device.id)
      // Trigger topology refresh by incrementing refresh key
      setTopologyRefreshKeys(prev => ({
        ...prev,
        [topologyId]: (prev[topologyId] || 0) + 1
      }))
      showToast(`Device "${device.name}" deleted`, 'success')
    } catch (err) {
      console.error('Failed to delete device:', err)
      showToast(`Failed to delete device: ${getErrorMessage(err)}`, 'error')
    }
    closeDeviceContextMenu()
  }, [deviceContextMenu, closeDeviceContextMenu])

  // Save device edits
  const handleSaveDeviceEdit = useCallback(async (updates: Partial<Device>) => {
    const { device, topologyId } = editingDevice
    if (!device || !topologyId) return

    try {
      await updateDevice(topologyId, device.id, {
        name: updates.name,
        type: updates.type,
        status: updates.status,
        site: updates.site,
        role: updates.role,
      })
      // Trigger topology refresh
      setTopologyRefreshKeys(prev => ({
        ...prev,
        [topologyId]: (prev[topologyId] || 0) + 1
      }))
      showToast(`Device "${updates.name || device.name}" updated`, 'success')
      setEditingDevice({ device: null, topologyId: null })
    } catch (err) {
      console.error('Failed to update device:', err)
      showToast(`Failed to update device: ${getErrorMessage(err)}`, 'error')
    }
  }, [editingDevice])

  // Profile lookup map for resolving profile defaults
  const profileMap = useMemo(() => {
    const map = new Map<string, CredentialProfile>()
    for (const p of profiles) map.set(p.id, p)
    return map
  }, [profiles])

  const activeProfileName = useMemo(() => {
    if (!activeTabId) return undefined
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (!activeTab?.profileId) return undefined
    return profileMap.get(activeTab.profileId)?.name
  }, [activeTabId, tabs, profileMap])

  // Helper to get effective font settings from session, falling back to profile defaults
  const getEffectiveFontSettings = useCallback((session: Session): { fontSize: number | null; fontFamily: string | null; terminalTheme: string | null } => {
    const profile = profileMap.get(session.profile_id)
    return {
      fontSize: session.font_size_override ?? profile?.default_font_size ?? null,
      fontFamily: session.font_family ?? profile?.default_font_family ?? null,
      terminalTheme: session.terminal_theme ?? profile?.terminal_theme ?? null,
    }
  }, [profileMap])

  // Listen for "open session by ID" events (from toast actions, etc.)
  useEffect(() => {
    const handleOpenSession = async (e: Event) => {
      const { sessionId } = (e as CustomEvent<{ sessionId: string }>).detail
      const existingTab = tabsRef.current.find(t =>
        t.sessionId === sessionId && t.type === 'terminal'
      )
      if (existingTab) {
        if (existingTab.status === 'disconnected' || existingTab.status === 'error') {
          const handle = terminalRefs.current.get(existingTab.id)
          if (handle) handle.reconnect()
        }
        setActiveTabId(existingTab.id)
        return
      }
      try {
        const session = await getSession(sessionId)
        const { fontSize, fontFamily, terminalTheme } = getEffectiveFontSettings(session)
        const newId = `ssh-${session.id}-${Date.now()}`
        const newTab: Tab = {
          id: newId,
          type: 'terminal',
          title: session.name,
          sessionId: session.id,
          profileId: session.profile_id,
          protocol: session.protocol || 'ssh',
          cliFlavor: session.cli_flavor,
          terminalTheme,
          fontSize,
          fontFamily,
          color: session.color || undefined,
          status: 'connecting'
        }
        setTabs(prev => [...prev, newTab])
        setActiveTabId(newId)
      } catch (err) {
        console.error('Failed to open session:', err)
      }
    }
    window.addEventListener('netstacks:open-session', handleOpenSession)
    return () => window.removeEventListener('netstacks:open-session', handleOpenSession)
  }, [getEffectiveFontSettings])

  // Pop a popped-out terminal window back in as a tab. The popout emits the
  // Tauri 'pop-back-in' event (or postMessage in browser mode) with the same
  // params handlePopoutTab sent it, then closes itself.
  useEffect(() => {
    interface PopBackInPayload {
      sessionId?: string
      sessionName?: string
      protocol?: 'ssh' | 'telnet'
      cliFlavor?: string
      terminalTheme?: string
      fontSize?: number
      fontFamily?: string
      enterpriseProfileId?: string
      enterpriseSessionDefinitionId?: string
      enterpriseTargetHost?: string
      enterpriseTargetPort?: number
      isJumpbox?: boolean
    }

    const restoreTab = (p: PopBackInPayload) => {
      const newId = `popin-${p.sessionId || 'local'}-${Date.now()}`
      const newTab: Tab = {
        id: newId,
        type: 'terminal',
        title: p.sessionName || 'Terminal',
        sessionId: p.sessionId,
        protocol: p.protocol || 'ssh',
        cliFlavor: (p.cliFlavor as CliFlavor) || 'auto',
        terminalTheme: p.terminalTheme,
        fontSize: p.fontSize,
        fontFamily: p.fontFamily,
        enterpriseProfileId: p.enterpriseProfileId,
        enterpriseSessionDefinitionId: p.enterpriseSessionDefinitionId,
        enterpriseTargetHost: p.enterpriseTargetHost,
        enterpriseTargetPort: p.enterpriseTargetPort,
        isJumpbox: p.isJumpbox,
        status: 'connecting',
      }
      setTabs(prev => [...prev, newTab])
      setActiveTabId(newId)
    }

    // Tauri path
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<PopBackInPayload>('pop-back-in', (event) => {
          restoreTab(event.payload)
          // Bring the main window forward so the restored tab is visible.
          import('@tauri-apps/api/window')
            .then(({ getCurrentWindow }) => getCurrentWindow().setFocus())
            .catch(() => {})
        })
      )
      .then((fn) => { unlisten = fn })
      .catch(() => { /* not in Tauri */ })

    // Browser-popout path (window.open fallback posts to its opener)
    const handleMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      if (e.data?.type === 'netstacks:pop-back-in') restoreTab(e.data.payload as PopBackInPayload)
    }
    window.addEventListener('message', handleMessage)

    return () => {
      unlisten?.()
      window.removeEventListener('message', handleMessage)
    }
  }, [])

  // Handle "Open script output in doc tab" (unsaved until user explicitly saves)
  useEffect(() => {
    const handleOpenScriptOutput = (e: Event) => {
      const { title, content, contentType } = (e as CustomEvent).detail as { title: string; content: string; contentType?: ContentType }
      const ct = contentType || 'text'
      const newId = `unsaved-doc-${Date.now()}`
      const scriptTarget = resolveDocSaveTarget('scriptOutput')
      const newTab: Tab = {
        id: newId,
        type: 'document',
        title,
        status: 'new',
        documentCategory: scriptTarget.category,
        unsavedDoc: { name: title, content, contentType: ct, category: scriptTarget.category },
      }
      setTabs(prev => [...prev, newTab])
      setActiveTabId(newId)
    }
    window.addEventListener('netstacks:open-script-output', handleOpenScriptOutput)
    return () => window.removeEventListener('netstacks:open-script-output', handleOpenScriptOutput)
  }, [])

  // Handle "Open in Terminal" - connects directly if session exists, otherwise opens Quick Connect
  // Used by DeviceDetailsOverlay, DeviceDetailCard, and TopologyPanel
  const handleOpenDeviceTerminal = useCallback(async (device: Device) => {
    try {
      const allSessions = await listSessions()

      // First, try to find session by linked sessionId
      if (device.sessionId) {
        const session = allSessions.find(s => s.id === device.sessionId)
        if (session) {
          // Create terminal tab for this session
          const newId = `ssh-${session.id}-${Date.now()}`
          const { fontSize, fontFamily, terminalTheme } = getEffectiveFontSettings(session)
          const newTab: Tab = {
            id: newId,
            type: 'terminal',
            title: session.name,
            sessionId: session.id,
            profileId: session.profile_id,
            cliFlavor: session.cli_flavor,
            terminalTheme,
            fontSize,
            fontFamily,
            color: session.color || undefined,
            status: 'connecting'
          }
          setTabs(prev => [...prev, newTab])
          setActiveTabId(newId)
          logger.log('Connecting to linked session:', session.name, session.host)
          return
        }
      }

      // Second, try to find session by matching host IP
      if (device.primaryIp) {
        const sessionByIp = allSessions.find(s => s.host === device.primaryIp)
        if (sessionByIp) {
          // Create terminal tab for this session
          const newId = `ssh-${sessionByIp.id}-${Date.now()}`
          const { fontSize, fontFamily, terminalTheme } = getEffectiveFontSettings(sessionByIp)
          const newTab: Tab = {
            id: newId,
            type: 'terminal',
            title: sessionByIp.name,
            sessionId: sessionByIp.id,
            profileId: sessionByIp.profile_id,
            cliFlavor: sessionByIp.cli_flavor,
            terminalTheme,
            fontSize,
            fontFamily,
            color: sessionByIp.color || undefined,
            status: 'connecting'
          }
          setTabs(prev => [...prev, newTab])
          setActiveTabId(newId)
          logger.log('Connecting to session by IP:', sessionByIp.name, sessionByIp.host)
          return
        }
      }
    } catch (err) {
      console.error('Failed to fetch sessions:', err)
    }

    // Fall back to Quick Connect with device IP pre-filled
    if (device.primaryIp) {
      setQuickConnectInitialHost(device.primaryIp)
      setQuickConnectOpen(true)
      logger.log('Opening Quick Connect for device:', device.name, device.primaryIp)
    } else {
      logger.log('No primary IP for device:', device.name)
    }
  }, [getEffectiveFontSettings])

  // Handle device double-click (open/focus terminal)
  const handleTopologyDeviceDoubleClick = useCallback((device: Device, _screenPosition: { x: number; y: number }) => {
    // Close any open overlays
    setDeviceOverlay({ device: null, position: null })
    setConnectionOverlay({ connection: null, position: null })
    // Directly open/focus terminal for device
    handleOpenDeviceTerminal(device)
  }, [handleOpenDeviceTerminal])

  // Handle creating a new script
  const handleOpenScript = useCallback((script: Script) => {
    // If script has an ID, check if it's already open
    if (script.id) {
      const existingTab = tabs.find(t => isScriptTab(t) && t.scriptId === script.id)
      if (existingTab) {
        setActiveTabId(existingTab.id)
        return
      }
    }

    const newId = `script-${script.id || 'new'}-${Date.now()}`
    const newTab: Tab = {
      id: newId,
      type: 'script',
      title: script.name || 'Untitled Script',
      status: 'ready',
      scriptId: script.id || undefined,
      scriptData: script,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newId)
  }, [tabs])

  const handleNewScript = useCallback(() => {
    // Create a new empty script and open it as a tab
    const newScript: Script = {
      id: '', // Will be assigned on save
      name: 'Untitled Script',
      content: `# NetStacks Script
#
# EXECUTION MODEL:
#   Select devices in the toolbar → your script runs ONCE PER DEVICE.
#   Select 5 devices → 5 parallel runs, each with that device's credentials.
#   Select 0 devices → runs once standalone (no device context).
#
# DEVICE CONTEXT — injected per run via environment variables:
#
#   NETSTACKS_DEVICE      Full device JSON (host, port, username, password, etc.)
#   NETSTACKS_DEVICE_HOST IP address, e.g. "10.1.1.1"
#   NETSTACKS_DEVICE_NAME Display name, e.g. "PE1-NYC"
#   NETSTACKS_DEVICE_TYPE Netmiko type, e.g. "arista_eos", "cisco_ios"
#
#   The device JSON looks like:
#   {
#     "host": "10.1.1.1",
#     "port": 22,
#     "device_type": "arista_eos",
#     "username": "admin",
#     "password": "decrypted-password",
#     "name": "PE1-NYC"
#   }
#
# PARAMETERS — define main() with typed args and NetStacks shows a form:
#   def main(command: str = "show version", timeout: int = 30):
#
# DEPENDENCIES — just import, auto-installed on first run:
#   import netmiko, requests, jinja2, yaml, etc.
#
# EXECUTION MODES (set in toolbar):
#   Parallel  — all devices run at the same time (default)
#   Sequential — one device at a time, in order
#
# CUSTOM INPUT — JSON passed via NETSTACKS_INPUT env var

import os
import json
from netmiko import ConnectHandler

def main(command: str = "show version"):
    """Run a command on the selected device(s) and return the output."""

    device_json = os.environ.get("NETSTACKS_DEVICE")
    if not device_json:
        print("No devices selected.")
        print("Click the devices icon in the toolbar to select devices.")
        return

    device = json.loads(device_json)
    name = device.get("name", device["host"])

    # Connect using the injected credentials
    conn = ConnectHandler(
        device_type=device["device_type"],
        host=device["host"],
        username=device["username"],
        password=device.get("password", ""),
        port=device.get("port", 22),
    )

    output = conn.send_command(command)
    conn.disconnect()

    # Print results (collected per-device in the output panel)
    print(f"=== {name} ({device['host']}) ===")
    print(output)
`,
      is_template: false,
      last_run_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    handleOpenScript(newScript)
  }, [handleOpenScript])

  // Handle opening a document as a tab
  const handleOpenDocument = useCallback((doc: Document) => {
    // Check if this is a topology backup that should open as a topology
    if (doc.category === 'backups' && doc.content_type === 'json') {
      try {
        const parsed = JSON.parse(doc.content)
        // Check if it's a topology snapshot (has version and topology fields)
        if (parsed.version && parsed.topology && parsed.topology.devices) {
          // Check if already open as topology
          const existingTopologyTab = tabs.find(t =>
            isTopologyTab(t) && t.temporaryTopology?.id === `backup-${doc.id}`
          )
          if (existingTopologyTab) {
            setActiveTabId(existingTopologyTab.id)
            return
          }

          // Create temporary topology from backup data
          const temporaryTopology: Topology = {
            id: `backup-${doc.id}`,
            name: parsed.topology.name || doc.name,
            source: parsed.topology.source || 'backup',
            createdAt: parsed.topology.createdAt || parsed.exportedAt || new Date().toISOString(),
            updatedAt: parsed.topology.updatedAt || parsed.exportedAt || new Date().toISOString(),
            devices: parsed.topology.devices || [],
            connections: parsed.topology.connections || [],
          }

          // Open as topology tab
          const newId = `topology-backup-${doc.id}-${Date.now()}`
          const newTab: Tab = {
            id: newId,
            type: 'topology',
            title: `${doc.name} (Backup)`,
            status: 'ready' as TopologyStatus,
            temporaryTopology,
            isTemporaryTopology: true,
          }
          setTabs(prev => [...prev, newTab])
          setActiveTabId(newId)
          return
        }
      } catch {
        // Not valid JSON or not a topology snapshot - open as regular document
        logger.log('[handleOpenDocument] Could not parse as topology backup, opening as document')
      }
    }

    // Check if document is already open as a tab
    const existingTab = tabs.find(t => isDocumentTab(t) && t.documentId === doc.id)
    if (existingTab) {
      // Focus existing tab
      setActiveTabId(existingTab.id)
      return
    }

    // Cache document data
    setDocumentCache(prev => ({ ...prev, [doc.id]: doc }))

    // Create new document tab
    const newId = `doc-${doc.id}-${Date.now()}`
    const newTab: Tab = {
      id: newId,
      type: 'document',
      title: doc.name,
      status: 'saved',
      documentId: doc.id,
      documentCategory: doc.category,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newId)
  }, [tabs])

  // Open an artifact the agent saved (by document id) as a document tab — the
  // user can then split it beside the agent run.
  const handleOpenAgentArtifact = useCallback(async (docId: string) => {
    try {
      const doc = await getDocument(docId)
      if (doc) handleOpenDocument(doc)
    } catch (e) {
      console.error('[App] Failed to open agent artifact:', e)
    }
  }, [handleOpenDocument])

  // Handle opening a topology as a tab
  const handleOpenTopology = useCallback((topologyId: string, topologyName: string) => {
    // Check if already open
    const existingTab = tabs.find(t => t.type === 'topology' && t.topologyId === topologyId)
    if (existingTab) {
      setActiveTabId(existingTab.id)
      return
    }

    // Create new tab
    const newTab: Tab = {
      id: `topology-${topologyId}`,
      type: 'topology',
      title: topologyName,
      status: 'ready' as TopologyStatus,
      topologyId,
      topologyName,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTab.id)
  }, [tabs])

  // Route Command Center search selections to entity openers
  const handleNavigateHit = useCallback(async (hit: SearchHit) => {
    switch (hit.type) {
      case 'session':
      case 'device':
        window.dispatchEvent(new CustomEvent('netstacks:open-session', { detail: { sessionId: hit.id } }))
        return
      case 'topology':
        handleOpenTopology(hit.id, hit.title)
        return
      case 'mop':
        // /search returns MOP templates; planId opens a template for editing
        handleOpenMopTab(hit.id, hit.title, undefined)
        return
      case 'doc':
        try {
          handleOpenDocument(await getDocument(hit.id))
        } catch {
          // fetch error; toast handled upstream
        }
        return
      case 'script':
        try {
          handleOpenScript(await getScript(hit.id))
        } catch {
          // fetch error; ignore
        }
        return
      // quick-action / snippet / workspace: no first-class tab opener yet — deferred.
      default:
        return
    }
  }, [handleOpenTopology, handleOpenMopTab, handleOpenDocument, handleOpenScript])

  // Handle opening a traceroute topology as a new tab (in-memory, not saved)
  const handleOpenTracerouteTopology = useCallback((topology: Topology) => {
    const newId = `topology-traceroute-${Date.now()}`
    const newTab: Tab = {
      id: newId,
      type: 'topology',
      title: topology.name,
      status: 'ready' as TopologyStatus,
      topologyName: topology.name,
      temporaryTopology: topology,
      isTemporaryTopology: true,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newId)
  }, [])

  // Handle visualizing traceroute output from terminal
  const handleVisualizeTraceroute = useCallback((output: string) => {
    const result = TracerouteParser.parse(output)
    if (!result) {
      console.error('Failed to parse traceroute output')
      return
    }
    const topology = TracerouteParser.generateTopology(result)
    handleOpenTracerouteTopology(topology)
  }, [handleOpenTracerouteTopology])

  // Handle creating a new document
  const handleNewDocument = useCallback((category: DocumentCategory) => {
    // For now, log the category - can be expanded to show creation dialog
    logger.log('New document in category:', category)
  }, [])

  // Update document tab status (saved/modified)
  const updateDocumentTabStatus = useCallback((tabId: string, status: 'saved' | 'modified') => {
    setTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, status } : tab
    ))
  }, [])

  // Handle document save from tab editor
  const handleDocumentSave = useCallback(async (tabId: string, documentId: string, content: string) => {
    // Set status to saving (we'll use 'saved' during the save, status will update after)
    try {
      const updatedDoc = await updateDocument(documentId, { content })
      // Update document cache with new content
      setDocumentCache(prev => ({ ...prev, [documentId]: updatedDoc }))
      // Set status to saved
      updateDocumentTabStatus(tabId, 'saved')
    } catch (err) {
      console.error('Failed to save document:', err)
      // Keep modified status on error
      throw err
    }
  }, [updateDocumentTabStatus])

  // Save an unsaved document tab (persist to backend, convert to normal doc tab)
  const handleUnsavedDocSave = useCallback(async (
    tabId: string,
    name: string,
    category: DocumentCategory,
    contentType: ContentType,
    content: string,
  ) => {
    try {
      const doc = await createDocument({ name, category, content_type: contentType, content })
      setDocumentCache(prev => ({ ...prev, [doc.id]: doc }))
      setTabs(prev => prev.map(tab =>
        tab.id === tabId
          ? { ...tab, title: doc.name, status: 'saved' as DocumentStatus, documentId: doc.id, documentCategory: doc.category, unsavedDoc: undefined }
          : tab
      ))
      showToast(`Saved to ${category}`, 'success')
    } catch (err) {
      console.error('Failed to save document:', err)
      showToast('Failed to save document', 'error')
    }
  }, [])

  // Handle document modified state change
  const handleDocumentModified = useCallback((tabId: string, isModified: boolean) => {
    updateDocumentTabStatus(tabId, isModified ? 'modified' : 'saved')
  }, [updateDocumentTabStatus])

  // Create a new terminal tab
  const createTerminal = useCallback(() => {
    const newId = `terminal-${Date.now()}`
    const localCount = tabs.filter(t => isTerminalTab(t) && !t.sessionId).length
    const newTab: Tab = {
      id: newId,
      type: 'terminal',
      title: localCount === 0 ? 'Local Shell' : `Local Shell ${localCount + 1}`,
      status: 'connecting',
      isJumpbox: isEnterprise,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newId)
  }, [tabs, isEnterprise])

  // Update terminal connection status
  const updateTerminalStatus = useCallback((id: string, status: ConnectionStatus) => {
    setTabs(prev => prev.map(tab =>
      tab.id === id ? { ...tab, status } : tab
    ))
  }, [])

  // Update tab sessionId when enterprise SSH connects (controller assigns the session ID)
  const updateTabSessionId = useCallback((tabId: string, sessionId: string) => {
    setTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, sessionId } : tab
    ))
  }, [])

  const updateTabFields = useCallback((tabId: string, fields: Partial<Tab>) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, ...fields } : t))
  }, [])

  // Close a tab (terminal or document). `force` skips the unsaved-changes
  // prompt — set by the confirm-resolved branch below when the user opts to
  // close anyway.
  const closeTab = useCallback((id: string, force = false) => {
    const tab = tabs.find(t => t.id === id)
    if (!tab) return

    // Warn about unsaved SFTP editor changes
    if (!force && tab.type === 'sftp-editor' && tab.sftpDirty) {
      confirmDialog({
        title: 'Unsaved changes',
        body: `${tab.title} has unsaved changes. Close anyway?`,
        confirmLabel: 'Close without saving',
        destructive: true,
      }).then((ok) => {
        if (ok) closeTab(id, true)
      })
      return
    }

    setTabs(prev => {
      const filtered = prev.filter(t => t.id !== id)
      if (activeTabId === id && filtered.length > 0) {
        setActiveTabId(filtered[filtered.length - 1].id)
      } else if (filtered.length === 0) {
        setActiveTabId(null)
      }
      return filtered
    })

    // Also drop it from the split view, else a split-open tab (e.g. an artifact
    // opened beside an agent run) stays rendered with no tab to close it.
    setSplitTabs(prev => prev.filter(sid => sid !== id))

    // Clean up document cache if closing a document tab
    if (isDocumentTab(tab) && tab.documentId) {
      // Check if any other tab is using this document
      const otherTabsWithDoc = tabs.filter(t => t.id !== id && t.documentId === tab.documentId)
      if (otherTabsWithDoc.length === 0) {
        setDocumentCache(prev => {
          const next = { ...prev }
          delete next[tab.documentId!]
          return next
        })
      }
    }
  }, [activeTabId, tabs])

  // Backwards compatibility alias
  const closeTerminal = closeTab

  // Tab context menu handlers
  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenuPosition({ x: e.clientX, y: e.clientY })
    setContextMenuTabId(tabId)
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenuPosition(null)
    setContextMenuTabId(null)
  }, [])

  // Split pane context menu handlers (Phase 25)
  const handleSplitPaneContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setSplitContextMenuPosition({ x: e.clientX, y: e.clientY })
    setSplitContextMenuTabId(tabId)
  }, [])

  const closeSplitContextMenu = useCallback(() => {
    setSplitContextMenuPosition(null)
    setSplitContextMenuTabId(null)
  }, [])

  // Create a group from all tabs currently in split view
  const handleCreateGroupFromSplit = useCallback((groupName?: string) => {
    if (splitTabs.length < 2) return

    const name = groupName || `Split Group ${tabGroups.length + 1}`
    const newGroup: TabGroup = {
      id: `group-${Date.now()}`,
      name,
      tabIds: [...splitTabs],
      orientation: splitLayout === 'vertical' ? 'vertical' : 'horizontal'
    }

    setTabGroups(prev => [...prev, newGroup])
    closeSplitContextMenu()
  }, [splitTabs, splitLayout, tabGroups.length, closeSplitContextMenu])

  // Create a group from split tabs and run topology discovery
  const handleCreateGroupAndDiscover = useCallback(async () => {
    if (splitTabs.length < 2) return

    const connectedTabs = splitTabs
      .map(id => tabs.find(t => t.id === id))
      .filter((t): t is Tab => t !== undefined && t.type === 'terminal' && t.status === 'connected')

    if (connectedTabs.length === 0) {
      showToast('No connected terminals in split view. Make sure your sessions are connected (green dot in tab).', 'warning')
      closeSplitContextMenu()
      return
    }

    const groupName = `Discovery ${tabGroups.length + 1}`
    handleCreateGroupFromSplit(groupName)

    const allSessions = await listSessions()

    setDiscoveryGroupName(groupName)
    setDiscoveryDevices(connectedTabs.map(t => {
      const session = allSessions.find(s => s.id === t.sessionId)
      return {
        name: t.title,
        tabId: t.id,
        ip: session?.host,
        profileId: session?.profile_id,
        snmpProfileId: session?.profile_id,
        cliFlavor: session?.cli_flavor,
      }
    }))
    setDiscoveryTargetTopologyId(null)
    setDiscoveryModalOpen(true)
  }, [splitTabs, tabs, tabGroups.length, handleCreateGroupFromSplit, closeSplitContextMenu])

  // Save split view directly as a layout
  const handleSaveSplitAsLayout = useCallback(async () => {
    if (splitTabs.length < 2) {
      showToast('Need at least 2 tabs in split view to save', 'error')
      return
    }

    // Build mixed-type tabs array from split view
    const layoutTabs: LayoutTab[] = []
    const sessionIds: string[] = []

    for (const tabId of splitTabs) {
      const tab = tabs.find(t => t.id === tabId)
      if (!tab) continue

      if (isTerminalTab(tab) && tab.sessionId) {
        layoutTabs.push({ type: 'terminal', sessionId: tab.sessionId })
        sessionIds.push(tab.sessionId)
      } else if (isTopologyTab(tab) && tab.topologyId) {
        layoutTabs.push({ type: 'topology', topologyId: tab.topologyId })
      } else if (isDocumentTab(tab) && tab.documentId) {
        layoutTabs.push({ type: 'document', documentId: tab.documentId, documentName: tab.title })
      }
    }

    if (layoutTabs.length < 2) {
      showToast('Need at least 2 saved sessions to create layout', 'error')
      closeSplitContextMenu()
      return
    }

    // Generate layout name from tab titles
    const tabTitles = splitTabs
      .map(id => tabs.find(t => t.id === id)?.title)
      .filter(Boolean)
      .slice(0, 2)
      .join(' + ')
    const layoutName = tabTitles || `Split Layout ${Date.now() % 1000}`

    try {
      await createLayout({
        name: layoutName.trim(),
        sessionIds,
        tabs: layoutTabs,
        orientation: splitLayout,
      })
      showToast(`Layout "${layoutName.trim()}" saved`, 'success')
      closeSplitContextMenu()
    } catch {
      showToast('Failed to save layout', 'error')
      closeSplitContextMenu()
    }
  }, [splitTabs, tabs, splitLayout, closeSplitContextMenu, showToast])

  // Open session settings for a tab
  const handleOpenSessionSettings = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId)
    if (tab?.sessionId) {
      try {
        const allSessions = await listSessions()
        const session = allSessions.find(s => s.id === tab.sessionId)
        if (session) {
          setSessionSettingsSession(session)
        }
      } catch (err) {
        console.error('Failed to fetch session for settings:', err)
      }
    }
    closeContextMenu()
  }, [tabs, closeContextMenu])

  // Open device details tab from a terminal session tab
  const handleOpenDeviceDetailsFromTab = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId)
    if (!tab?.sessionId) return
    try {
      const allSessions = await listSessions()
      const session = allSessions.find(s => s.id === tab.sessionId)
      if (!session) return
      // Use the session name as the device name (hostname)
      const deviceName = session.name || session.host
      // Check if tab already exists for this device
      const existingTab = tabs.find(
        t => t.type === 'device-detail' && t.deviceName === deviceName
      )
      if (existingTab) {
        setActiveTabId(existingTab.id)
        return
      }
      // Create new device-detail tab
      const newTabId = `device-detail-${deviceName}-${Date.now()}`
      const newTab: Tab = {
        id: newTabId,
        type: 'device-detail',
        title: deviceName,
        status: 'ready' as const,
        deviceName,
        deviceSessionId: session.id,
        deviceHost: session.host,
        deviceProfileId: session.profile_id,
        deviceId: session.netbox_device_id != null ? String(session.netbox_device_id) : undefined,
      }
      setTabs(prev => [...prev, newTab])
      setActiveTabId(newTabId)
    } catch (err) {
      console.error('Failed to open device details:', err)
    }
    closeContextMenu()
  }, [tabs, closeContextMenu])

  // Pop out a terminal tab into its own Tauri window
  const handlePopoutTab = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId)
    if (!tab || !isTerminalTab(tab)) return

    const params = new URLSearchParams({
      popout: 'true',
      protocol: tab.protocol || 'ssh',
      sessionName: tab.title,
      cliFlavor: tab.cliFlavor || 'auto',
    })
    if (tab.sessionId) params.set('sessionId', tab.sessionId)
    if (tab.terminalTheme) params.set('terminalTheme', tab.terminalTheme)
    if (tab.fontSize) params.set('fontSize', String(tab.fontSize))
    if (tab.fontFamily) params.set('fontFamily', tab.fontFamily)
    if (tab.enterpriseProfileId) params.set('enterpriseProfileId', tab.enterpriseProfileId)
    if (tab.enterpriseSessionDefinitionId) params.set('enterpriseSessionDefinitionId', tab.enterpriseSessionDefinitionId)
    if (tab.enterpriseTargetHost) params.set('enterpriseTargetHost', tab.enterpriseTargetHost)
    if (tab.enterpriseTargetPort) params.set('enterpriseTargetPort', String(tab.enterpriseTargetPort))
    if (tab.isJumpbox) params.set('isJumpbox', 'true')

    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      const popout = new WebviewWindow(`popout-${tab.id}`, {
        url: `index.html?${params.toString()}`,
        title: tab.title,
        width: 800,
        height: 600,
        minWidth: 400,
        minHeight: 300,
        decorations: true,
      })

      popout.once('tauri://created', () => {
        // Remove tab from main window
        setTabs(prev => prev.filter(t => t.id !== tabId))
        if (activeTabId === tabId) {
          const remaining = tabs.filter(t => t.id !== tabId)
          setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null)
        }
      })

      popout.once('tauri://error', (e) => {
        console.error('[popout] Failed to create window:', e)
        showToast('Failed to pop out terminal', 'error')
      })
    } catch {
      // Browser fallback — open in new tab/window
      const basePath = window.location.pathname.startsWith('/terminal') ? '/terminal/' : '/'
      const url = `${window.location.origin}${basePath}?${params.toString()}`
      const popup = window.open(url, `popout-${tab.id}`, 'width=800,height=600')
      if (popup) {
        setTabs(prev => prev.filter(t => t.id !== tabId))
        if (activeTabId === tabId) {
          const remaining = tabs.filter(t => t.id !== tabId)
          setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null)
        }
      } else {
        showToast('Pop-up blocked — please allow pop-ups for this site', 'warning')
      }
    }
    closeContextMenu()
  }, [tabs, activeTabId, closeContextMenu])

  const duplicateTab = useCallback((id: string) => {
    const tab = tabs.find(t => t.id === id)
    if (!tab) return

    if (isTerminalTab(tab)) {
      const newId = `terminal-${Date.now()}`
      const newTab: Tab = {
        id: newId,
        type: 'terminal',
        title: `${tab.title} (copy)`,
        sessionId: tab.sessionId,
        profileId: tab.profileId,
        protocol: tab.protocol,
        cliFlavor: tab.cliFlavor,
        terminalTheme: tab.terminalTheme,
        fontSize: tab.fontSize,
        fontFamily: tab.fontFamily,
        color: tab.color,
        isJumpbox: tab.isJumpbox,
        enterpriseProfileId: tab.enterpriseProfileId,
        enterpriseSessionDefinitionId: tab.enterpriseSessionDefinitionId,
        enterpriseTargetHost: tab.enterpriseTargetHost,
        enterpriseTargetPort: tab.enterpriseTargetPort,
        status: 'connecting'
      }
      setTabs(prev => [...prev, newTab])
      setActiveTabId(newId)
    } else if (isDocumentTab(tab)) {
      // Document tabs can be duplicated too
      const newId = `doc-${tab.documentId}-${Date.now()}`
      const newTab: Tab = {
        id: newId,
        type: 'document',
        title: `${tab.title} (copy)`,
        status: 'saved',
        documentId: tab.documentId,
        documentCategory: tab.documentCategory,
      }
      setTabs(prev => [...prev, newTab])
      setActiveTabId(newId)
    }
  }, [tabs])

  const closeOtherTabs = useCallback((keepId: string) => {
    setTabs(prev => {
      const kept = prev.filter(t => t.id === keepId)
      if (kept.length > 0) {
        setActiveTabId(keepId)
      }
      return kept
    })
    setSplitTabs(prev => prev.filter(id => id === keepId))
  }, [])

  // Ring buffer of recently-closed terminal tabs so the user can recover
  // from an accidental Cmd+W. Capped to MAX_CLOSED_TABS — older entries
  // drop off the back. Only terminal tabs with a sessionId are recoverable
  // today (open via handleSSHConnect); other tab types are simply ignored.
  const MAX_CLOSED_TABS = 10
  const [closedTabs, setClosedTabs] = useState<Array<{ sessionId: string; title: string; closedAt: number }>>([])

  const recordClosedTab = useCallback((tab: Tab | undefined) => {
    if (!tab || tab.type !== 'terminal' || !tab.sessionId) return
    const sid = tab.sessionId
    setClosedTabs(prev => {
      // Drop duplicate of the same session — keep only the latest.
      const filtered = prev.filter(c => c.sessionId !== sid)
      return [{ sessionId: sid, title: tab.title, closedAt: Date.now() }, ...filtered].slice(0, MAX_CLOSED_TABS)
    })
  }, [])

  const closeAllTabs = useCallback(() => {
    setTabs(prev => {
      prev.forEach(t => recordClosedTab(t))
      return []
    })
    setActiveTabId(null)
    setSplitTabs([])
  }, [recordClosedTab])

  // Safety net: prune any split-view id whose tab no longer exists, no matter
  // how it was closed — so a split-open tab can never stay rendered with no tab.
  useEffect(() => {
    setSplitTabs(prev => {
      const valid = prev.filter(id => tabs.some(t => t.id === id))
      return valid.length === prev.length ? prev : valid
    })
  }, [tabs])

  // Keep AI chat tab titles in sync with the assistant (profile) name.
  useEffect(() => {
    setTabs(prev => {
      if (!prev.some(t => t.type === 'ai-chat' && t.title !== assistantName)) return prev
      return prev.map(t => (t.type === 'ai-chat' ? { ...t, title: assistantName } : t))
    })
  }, [assistantName])

  const closeTabsToRight = useCallback((anchorId: string) => {
    setTabs(prev => {
      const anchorIdx = prev.findIndex(t => t.id === anchorId)
      if (anchorIdx < 0) return prev
      const toClose = prev.slice(anchorIdx + 1)
      toClose.forEach(t => recordClosedTab(t))
      const remaining = prev.slice(0, anchorIdx + 1)
      // If active tab was in the closed set, move focus to the anchor.
      setActiveTabId(curr => (curr && remaining.some(t => t.id === curr)) ? curr : anchorId)
      return remaining
    })
  }, [recordClosedTab])

  const reopenLastClosedTab = useCallback(async () => {
    let head: { sessionId: string; title: string } | undefined
    setClosedTabs(prev => {
      if (prev.length === 0) return prev
      head = prev[0]
      return prev.slice(1)
    })
    if (!head) return
    try {
      const session = (await listSessions()).find(s => s.id === head!.sessionId)
      if (session) {
        handleSSHConnect(session)
      } else {
        showToast(`Cannot reopen "${head.title}" — session no longer exists`, 'warning')
      }
    } catch {
      showToast('Failed to reopen closed tab', 'error')
    }
  }, [])

  const createTabGroup = useCallback((name: string) => {
    const newGroup: TabGroup = {
      id: `group-${Date.now()}`,
      name,
      tabIds: contextMenuTabId ? [contextMenuTabId] : [],
      orientation: 'horizontal'
    }
    setTabGroups(prev => [...prev, newGroup])
  }, [contextMenuTabId])

  const moveToGroup = useCallback((groupId: string) => {
    if (!contextMenuTabId) return
    setTabGroups(prev => prev.map(g =>
      g.id === groupId
        ? { ...g, tabIds: [...g.tabIds.filter(id => id !== contextMenuTabId), contextMenuTabId] }
        : { ...g, tabIds: g.tabIds.filter(id => id !== contextMenuTabId) }
    ))
  }, [contextMenuTabId])

  const removeFromGroup = useCallback(() => {
    if (!contextMenuTabId) return
    setTabGroups(prev => prev.map(g => ({
      ...g,
      tabIds: g.tabIds.filter(id => id !== contextMenuTabId)
    })).filter(g => g.tabIds.length > 0))
  }, [contextMenuTabId])

  // Create group from selected tabs (Phase 25: Tab Multi-Select)
  const handleGroupSelectedTabs = useCallback(() => {
    if (selectedTabIds.size < 2) return

    const selectedIds = Array.from(selectedTabIds)
    setNamePrompt({
      title: 'Name this group',
      onConfirm: (name) => {
        const newGroup: TabGroup = {
          id: `group-${Date.now()}`,
          name,
          tabIds: selectedIds,
          orientation: 'horizontal',
        }

        setTabGroups(prev => [...prev, newGroup])
        clearTabSelection()

        // Set first tab in group as active
        if (selectedIds.length > 0) {
          setActiveTabId(selectedIds[0])
        }
      },
    })
  }, [selectedTabIds, tabGroups, clearTabSelection])

  // Confirm and save layout to database (Phase 25)
  const handleSaveLayoutConfirm = useCallback(async () => {
    if (!saveLayoutGroupId || !layoutNameInput.trim()) return

    const group = tabGroups.find(g => g.id === saveLayoutGroupId)
    if (!group) return

    // Build mixed-type tabs array (Phase 25: supports terminal, topology, document tabs)
    const layoutTabs: LayoutTab[] = []
    const sessionIds: string[] = [] // Legacy field for backward compatibility

    for (const tabId of group.tabIds) {
      const tab = tabs.find(t => t.id === tabId)
      if (!tab) continue

      if (isTerminalTab(tab) && tab.sessionId) {
        layoutTabs.push({
          type: 'terminal',
          sessionId: tab.sessionId,
        })
        sessionIds.push(tab.sessionId) // Also populate legacy field
      } else if (isTopologyTab(tab) && tab.topologyId) {
        layoutTabs.push({
          type: 'topology',
          topologyId: tab.topologyId,
        })
      } else if (isDocumentTab(tab) && tab.documentId) {
        layoutTabs.push({
          type: 'document',
          documentId: tab.documentId,
          documentName: tab.title,
        })
      }
    }

    try {
      await createLayout({
        name: layoutNameInput.trim(),
        sessionIds, // Legacy: for backward compatibility
        tabs: layoutTabs.length > 0 ? layoutTabs : undefined, // New: mixed tab types
        orientation: group.orientation,
      })
      setSaveLayoutDialogOpen(false)
      setSaveLayoutGroupId(null)
      setLayoutNameInput('')
    } catch (err) {
      console.error('Failed to save layout:', err)
    }
  }, [saveLayoutGroupId, layoutNameInput, tabGroups, tabs])

  // Handle "Restore Layout" from GroupsPanel (Phase 25)
  const handleRestoreLayout = useCallback(async (layout: Layout) => {
    // Guard against multiple rapid clicks
    if (restoringLayoutRef.current) return
    restoringLayoutRef.current = true

    const newTabIds: string[] = []

    // Use new tabs field if present, otherwise fall back to legacy sessionIds
    if (layout.tabs && layout.tabs.length > 0) {
      // New: restore mixed tab types (terminal, topology, document)
      const allSessions = await listSessions()
      const allDocuments = await listDocuments()

      for (const layoutTab of layout.tabs) {
        if (layoutTab.type === 'terminal' && layoutTab.sessionId) {
          // Check if session is already open
          const existingTab = tabs.find(t => t.sessionId === layoutTab.sessionId)
          if (existingTab) {
            newTabIds.push(existingTab.id)
          } else {
            // Open new terminal tab
            const session = allSessions.find(s => s.id === layoutTab.sessionId)
            if (session) {
              const newId = `ssh-${session.id}-${Date.now()}`
              const { fontSize, fontFamily, terminalTheme } = getEffectiveFontSettings(session)
              const newTab: Tab = {
                id: newId,
                type: 'terminal',
                title: session.name,
                sessionId: session.id,
                profileId: session.profile_id,
                cliFlavor: session.cli_flavor,
                terminalTheme,
                fontSize,
                fontFamily,
                color: session.color || undefined,
                status: 'connecting'
              }
              setTabs(prev => [...prev, newTab])
              newTabIds.push(newId)
            }
          }
        } else if (layoutTab.type === 'topology' && layoutTab.topologyId) {
          // Check if topology is already open
          const existingTab = tabs.find(t => isTopologyTab(t) && t.topologyId === layoutTab.topologyId)
          if (existingTab) {
            newTabIds.push(existingTab.id)
          } else {
            // Open new topology tab
            try {
              const topology = await getTopology(layoutTab.topologyId)
              const newId = `topology-${layoutTab.topologyId}-${Date.now()}`
              const newTab: Tab = {
                id: newId,
                type: 'topology',
                title: topology.name,
                topologyId: layoutTab.topologyId,
                status: 'ready'
              }
              setTabs(prev => [...prev, newTab])
              newTabIds.push(newId)
            } catch (err) {
              console.error('Failed to restore topology:', err)
            }
          }
        } else if (layoutTab.type === 'document' && layoutTab.documentId) {
          // Check if document is already open
          const existingTab = tabs.find(t => isDocumentTab(t) && t.documentId === layoutTab.documentId)
          if (existingTab) {
            newTabIds.push(existingTab.id)
          } else {
            // Open new document tab
            const doc = allDocuments.find(d => d.id === layoutTab.documentId)
            if (doc) {
              const newId = `doc-${layoutTab.documentId}-${Date.now()}`
              const newTab: Tab = {
                id: newId,
                type: 'document',
                title: doc.name,
                documentId: layoutTab.documentId,
                status: 'ready'
              }
              setTabs(prev => [...prev, newTab])
              newTabIds.push(newId)
              // Load document into cache
              const fullDoc = await getDocument(layoutTab.documentId)
              setDocumentCache(prev => ({ ...prev, [layoutTab.documentId!]: fullDoc }))
            }
          }
        }
      }
    } else {
      // Legacy: restore terminal tabs only using sessionIds
      const existingSessionIds = new Set(tabs.filter(t => t.sessionId).map(t => t.sessionId))
      const sessionsToOpen = layout.sessionIds.filter(id => !existingSessionIds.has(id))
      const allSessions = await listSessions()

      for (const sessionId of sessionsToOpen) {
        const session = allSessions.find(s => s.id === sessionId)
        if (session) {
          const newId = `ssh-${session.id}-${Date.now()}`
          const { fontSize, fontFamily, terminalTheme } = getEffectiveFontSettings(session)
          const newTab: Tab = {
            id: newId,
            type: 'terminal',
            title: session.name,
            sessionId: session.id,
            profileId: session.profile_id,
            cliFlavor: session.cli_flavor,
            terminalTheme,
            fontSize,
            fontFamily,
            color: session.color || undefined,
            status: 'connecting'
          }
          setTabs(prev => [...prev, newTab])
          newTabIds.push(newId)
        }
      }

      // Collect existing tab IDs for sessions that are already open
      for (const sessionId of layout.sessionIds) {
        if (existingSessionIds.has(sessionId)) {
          const existingTab = tabs.find(t => t.sessionId === sessionId)
          if (existingTab) {
            newTabIds.push(existingTab.id)
          }
        }
      }
    }

    // Activate split view with restored tabs (after a small delay to let tabs render)
    setTimeout(() => {
      if (newTabIds.length > 0) {
        // Set up the split view with the exact layout
        setSplitTabs(newTabIds)
        // Restore the exact layout type (horizontal, vertical, 2-top-1-bottom, 1-top-2-bottom)
        const validLayouts = ['horizontal', 'vertical', '2-top-1-bottom', '1-top-2-bottom'] as const
        const layoutType = validLayouts.includes(layout.orientation as typeof validLayouts[number])
          ? (layout.orientation as typeof validLayouts[number])
          : 'horizontal'
        setSplitLayout(layoutType)
        // Set first tab as active
        setActiveTabId(newTabIds[0])
      }
      // Reset guard after restore completes
      restoringLayoutRef.current = false
    }, 100)
  }, [tabs, documentCache, getEffectiveFontSettings])

  // === Saved Groups Handlers (Plan 1: Tab Groups Redesign) ===

  const bumpGroupsRefresh = useCallback(() => {
    setGroupsRefreshKey((k) => k + 1);
  }, []);

  const handleSaveCurrentAsGroup = useCallback(async () => {
    const groupTabs: GroupTab[] = tabs
      .filter((t) => t.type === 'terminal' || t.type === 'topology' || t.type === 'document')
      .map((t) => ({
        type: t.type as 'terminal' | 'topology' | 'document',
        sessionId: t.type === 'terminal' ? t.sessionId : undefined,
        topologyId: t.type === 'topology' ? (t.topologyId || t.id) : undefined,
        documentId: t.type === 'document' ? t.documentId : undefined,
        documentName: t.type === 'document' ? (t.unsavedDoc?.name || t.title) : undefined,
      }));

    if (groupTabs.length === 0) {
      showToast('No saveable tabs are open.', 'warning');
      return;
    }

    setNamePrompt({
      title: 'Name this group',
      onConfirm: async (name) => {
        try {
          await createGroup({ name, tabs: groupTabs });
          bumpGroupsRefresh();
        } catch (err) {
          console.error('Failed to save group:', err);
          showToast(`Failed to save group: ${getErrorMessage(err, 'unknown error')}`, 'error');
        }
      },
    })
  }, [tabs, bumpGroupsRefresh]);

  const performLaunch = useCallback(
    async (group: Group, action: LaunchChoice) => {
      // Reuse the existing handleRestoreLayout machinery for the actual tab-creation work.
      // It already handles reuse-existing-session and mixed types.
      // We synthesize a Layout-shaped object from the Group for compatibility.
      const layoutShape = {
        id: group.id,
        name: group.name,
        sessionIds: group.tabs.filter((t) => t.sessionId).map((t) => t.sessionId!),
        tabs: group.tabs.map((t) => ({
          type: t.type,
          sessionId: t.sessionId,
          topologyId: t.topologyId,
          documentId: t.documentId,
          documentName: t.documentName,
        })),
        orientation: 'horizontal' as const,
        sizes: [],
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      };

      if (action === 'replace') {
        // Close all current tabs first.
        setTabs([]);
      }
      if (action === 'new_window') {
        // For now, fall back to "alongside" until multi-window support exists.
        // (Tracked in CONCERNS.md; revisit when window manager lands.)
        console.warn('new_window launch not yet implemented; opening alongside.');
      }

      await handleRestoreLayout(layoutShape as Parameters<typeof handleRestoreLayout>[0]);
      setLiveGroupId(group.id);

      // Touch last_used_at on the server.
      apiUpdateGroup(group.id, { lastUsedAt: new Date().toISOString() }).catch(console.error);
    },
    [handleRestoreLayout]
  );

  const handleLaunchGroup = useCallback(
    (group: Group) => {
      const groupDefault = group.defaultLaunchAction;
      const effectiveAction: LaunchChoice | null =
        groupDefault && groupDefault !== 'ask'
          ? (groupDefault as LaunchChoice)
          : defaultLaunchAction;

      if (effectiveAction) {
        performLaunch(group, effectiveAction);
      } else {
        setPendingLaunch(group);
      }
    },
    [defaultLaunchAction, performLaunch]
  );

  const handleLaunchDialogConfirm = useCallback(
    (action: LaunchChoice, dontAskAgain: boolean) => {
      if (!pendingLaunch) return;
      if (dontAskAgain) {
        localStorage.setItem('defaultLaunchAction', action);
        setDefaultLaunchAction(action);
      }
      performLaunch(pendingLaunch, action);
      setPendingLaunch(null);
    },
    [pendingLaunch, performLaunch]
  );

  const handleTabDroppedOnGroup = useCallback(
    async (groupId: string, droppedTabId: string) => {
      const tab = tabs.find((t) => t.id === droppedTabId);
      if (!tab) return;
      try {
        // Fetch group, append, update.
        const groupsList = await import('./api/groups').then((m) => m.listGroups());
        const group = groupsList.find((g) => g.id === groupId);
        if (!group) return;
        const newTab: GroupTab = {
          type: tab.type as 'terminal' | 'topology' | 'document',
          sessionId: tab.type === 'terminal' ? tab.sessionId : undefined,
          topologyId: tab.type === 'topology' ? (tab.topologyId || tab.id) : undefined,
          documentId: tab.type === 'document' ? tab.documentId : undefined,
          documentName: tab.type === 'document' ? (tab.unsavedDoc?.name || tab.title) : undefined,
        };
        // Idempotent: don't add duplicates.
        const isDup = group.tabs.some((t) =>
          (t.sessionId && t.sessionId === newTab.sessionId) ||
          (t.topologyId && t.topologyId === newTab.topologyId) ||
          (t.documentId && t.documentId === newTab.documentId)
        );
        if (isDup) return;
        await apiUpdateGroup(groupId, { tabs: [...group.tabs, newTab] });
        bumpGroupsRefresh();
      } catch (err) {
        console.error('Failed to add tab to group:', err);
      }
    },
    [tabs, bumpGroupsRefresh]
  );

  const handleDiscoverTopologyForSavedGroup = useCallback(
    async (group: Group) => {
      // Mimic the body of the existing handleDiscoverTopologyFromGroup at lines 3455-3492,
      // but adapted to take a Group instead of using contextMenuTabId.

      // Get all terminal tabs from this group
      const groupTabIds = group.tabs
        .filter((t) => t.type === 'terminal' && t.sessionId)
        .map((t) => t.sessionId!);

      // Find matching tabs in the current open tabs that are connected
      const groupTabs = tabs.filter(t =>
        groupTabIds.includes(t.sessionId || '') &&
        t.type === 'terminal' &&
        t.status === 'connected'
      );

      if (groupTabs.length === 0) {
        showToast('No connected terminals in this group. Make sure your sessions are connected (green dot in tab).', 'warning');
        return;
      }

      // Fetch sessions to get host IPs and profile IDs for discovery
      const allSessions = await listSessions();

      // Set up and open the discovery modal.
      // snmpProfileId MUST come from the session's own profile, not the
      // first profile in the user's list. The previous `profiles[0]?.id`
      // was a copy-paste bug that pinned every discovery target to the
      // alphabetically-first profile, silently inheriting THAT profile's
      // jump_host_id even though the session itself used a different
      // profile with no jump.
      setDiscoveryGroupName(group.name);
      setDiscoveryDevices(groupTabs.map(t => {
        const session = allSessions.find(s => s.id === t.sessionId);
        return {
          name: t.title,
          tabId: t.id,
          ip: session?.host,
          profileId: session?.profile_id,
          snmpProfileId: session?.profile_id,
          cliFlavor: session?.cli_flavor,
        };
      }));
      setDiscoveryTargetTopologyId(null);
      setDiscoveryModalOpen(true);
    },
    [tabs]
  );

  const handleOpenTopologyTab = useCallback(
    (topologyId: string) => {
      // Use existing handleOpenTopology (line 2203)
      handleOpenTopology(topologyId, 'Topology');
    },
    [handleOpenTopology]
  );

  const [chipSessionsById, setChipSessionsById] = useState<Map<string, Session>>(new Map());

  useEffect(() => {
    let cancelled = false;
    listSessions()
      .then((all) => {
        if (cancelled) return;
        const map = new Map<string, Session>();
        for (const s of all) map.set(s.id, s);
        setChipSessionsById(map);
      })
      .catch((err) => console.error('Failed to load sessions for chip lookup:', err));
    return () => {
      cancelled = true;
    };
  }, [groupsRefreshKey]);

  const getTabTitleForChip = useCallback(
    (idOrSessionId: string) => {
      const tab = tabs.find((t) => t.id === idOrSessionId || t.sessionId === idOrSessionId);
      if (tab?.title) return tab.title;
      const session = chipSessionsById.get(idOrSessionId);
      if (session) return session.name || session.host || idOrSessionId;
      return idOrSessionId;
    },
    [tabs, chipSessionsById]
  );

  // === End Saved Groups Handlers ===

  // Keyboard shortcut Cmd/Ctrl+G to group selected tabs (Phase 25)
  // Cmd/Ctrl+Shift+G to save current tabs as group (Plan 1: Tab Groups Redesign)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check Shift+G first (more specific)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        handleSaveCurrentAsGroup()
        return
      }
      // Then plain G (without shift)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        handleGroupSelectedTabs()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleGroupSelectedTabs, handleSaveCurrentAsGroup])

  // === Saved Groups Live Tracking (Plan 1: Tab Groups Redesign) ===

  const [allGroups, setAllGroups] = useState<Group[]>([]);

  useEffect(() => {
    let cancelled = false;
    import('./api/groups').then((m) =>
      m
        .listGroups()
        .then((g) => {
          if (!cancelled) setAllGroups(g);
        })
        .catch((err) => console.error('Failed to load groups for live tracking:', err))
    );
    return () => {
      cancelled = true;
    };
  }, [groupsRefreshKey]);

  const openTabRefs = useMemo(
    () =>
      tabs.map((t) => ({
        id: t.id,
        type: t.type,
        sessionId: t.sessionId,
        topologyId: t.topologyId,
        documentId: t.documentId,
      })),
    [tabs]
  );

  const clearLiveGroupId = useCallback(() => setLiveGroupId(null), []);
  useLiveGroupAutoClear(liveGroupId, allGroups, openTabRefs, clearLiveGroupId);

  // === End Saved Groups Live Tracking ===

  // Split pane resize handlers (Phase 25: resizable split views)
  const handleSplitResizeStart = useCallback((e: React.MouseEvent, index: number) => {
    e.preventDefault()
    setIsResizingSplit(true)
    setResizingSplitIndex(index)
  }, [])

  useEffect(() => {
    if (!isResizingSplit || resizingSplitIndex === null || splitTabs.length < 2) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!splitContainerRef.current) return

      const container = splitContainerRef.current
      const rect = container.getBoundingClientRect()
      const tabCount = Math.min(splitTabs.length, 4)
      const minSize = 15 // Minimum 15% per pane

      // Get current sizes
      const currentSizes = splitPaneSizes['split'] || []

      // Handle different layouts
      if (tabCount === 2) {
        // Simple 2-pane layout
        const isHorizontal = splitLayout === 'horizontal'
        const totalSize = isHorizontal ? rect.width : rect.height
        const position = isHorizontal ? e.clientX - rect.left : e.clientY - rect.top
        const percentage = Math.max(minSize, Math.min(100 - minSize, (position / totalSize) * 100))

        setSplitPaneSizes(prev => ({
          ...prev,
          ['split']: [percentage, 100 - percentage]
        }))
      } else if (tabCount === 3) {
        if (splitLayout === '2-top-1-bottom') {
          // 2-top-1-bottom: index 0 = vertical divider (between top panes), index 1 = horizontal divider (top/bottom row)
          if (resizingSplitIndex === 0) {
            const percentage = Math.max(minSize, Math.min(100 - minSize, ((e.clientX - rect.left) / rect.width) * 100))
            setSplitPaneSizes(prev => ({
              ...prev,
              ['split']: [percentage, currentSizes[1] || 50, currentSizes[2] || 50]
            }))
          } else {
            const percentage = Math.max(minSize, Math.min(100 - minSize, ((e.clientY - rect.top) / rect.height) * 100))
            setSplitPaneSizes(prev => ({
              ...prev,
              ['split']: [currentSizes[0] || 50, percentage, 100 - percentage]
            }))
          }
        } else if (splitLayout === '1-top-2-bottom') {
          // 1-top-2-bottom: index 0 = horizontal divider (top/bottom row), index 1 = vertical divider (between bottom panes)
          if (resizingSplitIndex === 0) {
            const percentage = Math.max(minSize, Math.min(100 - minSize, ((e.clientY - rect.top) / rect.height) * 100))
            setSplitPaneSizes(prev => ({
              ...prev,
              ['split']: [currentSizes[0] || 50, percentage, 100 - percentage]
            }))
          } else {
            const percentage = Math.max(minSize, Math.min(100 - minSize, ((e.clientX - rect.left) / rect.width) * 100))
            setSplitPaneSizes(prev => ({
              ...prev,
              ['split']: [percentage, currentSizes[1] || 50, currentSizes[2] || 50]
            }))
          }
        } else {
          // Vertical 3-pane layout
          const totalHeight = rect.height
          const position = e.clientY - rect.top
          const percentage = (position / totalHeight) * 100

          const newSizes = [...(currentSizes.length >= 3 ? currentSizes : [33.33, 33.33, 33.34])]

          if (resizingSplitIndex === 0) {
            // First divider
            const newFirst = Math.max(minSize, Math.min(100 - 2 * minSize, percentage))
            const diff = newFirst - newSizes[0]
            newSizes[0] = newFirst
            newSizes[1] = Math.max(minSize, newSizes[1] - diff)
          } else {
            // Second divider
            const newSecond = Math.max(minSize, Math.min(100 - newSizes[0] - minSize, percentage - newSizes[0]))
            newSizes[1] = newSecond
            newSizes[2] = 100 - newSizes[0] - newSecond
          }

          setSplitPaneSizes(prev => ({ ...prev, ['split']: newSizes }))
        }
      } else if (tabCount === 4) {
        // 2x2 grid - index 0 is vertical center, index 1 is horizontal center
        if (resizingSplitIndex === 0) {
          const percentage = Math.max(minSize, Math.min(100 - minSize, ((e.clientX - rect.left) / rect.width) * 100))
          setSplitPaneSizes(prev => ({
            ...prev,
            ['split']: [percentage, currentSizes[1] || 50]
          }))
        } else {
          const percentage = Math.max(minSize, Math.min(100 - minSize, ((e.clientY - rect.top) / rect.height) * 100))
          setSplitPaneSizes(prev => ({
            ...prev,
            ['split']: [currentSizes[0] || 50, percentage]
          }))
        }
      }
    }

    const handleMouseUp = () => {
      setIsResizingSplit(false)
      setResizingSplitIndex(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingSplit, resizingSplitIndex, splitTabs, splitLayout, splitPaneSizes])

  // Split pane drag handlers (Phase 25: drag to reorder/remove) - using pointer events for Tauri compatibility
  const handleSplitPanePointerDown = useCallback((e: React.PointerEvent, tabId: string) => {
    if (e.button !== 0) return // Only left button
    e.preventDefault()
    setDraggingSplitTabId(tabId)
  }, [])

  // Refs for split pane drag (to avoid stale closures)
  const splitDropTargetIdRef = useRef(splitDropTargetId)
  splitDropTargetIdRef.current = splitDropTargetId
  const draggingSplitTabIdRef = useRef(draggingSplitTabId)
  draggingSplitTabIdRef.current = draggingSplitTabId

  // Track pointer movement for split pane reordering
  useEffect(() => {
    if (!draggingSplitTabId) {
      document.body.removeAttribute('data-split-dragging')
      return
    }

    document.body.setAttribute('data-split-dragging', 'true')

    const handlePointerMove = (e: PointerEvent) => {
      // Find which split pane the pointer is over
      const paneElements = document.querySelectorAll('.terminal-instance.split-pane-tab')
      let targetId: string | null = null

      paneElements.forEach((pane) => {
        const rect = pane.getBoundingClientRect()
        if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
          // Get the tab id from the pane's data attribute
          const paneTabId = pane.getAttribute('data-tab-id')
          if (paneTabId && paneTabId !== draggingSplitTabIdRef.current) {
            targetId = paneTabId
          }
        }
      })

      setSplitDropTargetId(targetId)
    }

    const handlePointerUp = (e: PointerEvent) => {
      const draggedId = draggingSplitTabIdRef.current
      const targetId = splitDropTargetIdRef.current

      if (draggedId && targetId && draggedId !== targetId) {
        // Reorder tabs within the split view
        setSplitTabs(prev => {
          const newSplitTabs = [...prev]
          const fromIndex = newSplitTabs.indexOf(draggedId)
          const toIndex = newSplitTabs.indexOf(targetId)
          if (fromIndex === -1 || toIndex === -1) return prev

          newSplitTabs.splice(fromIndex, 1)
          newSplitTabs.splice(toIndex, 0, draggedId)
          return newSplitTabs
        })
      } else if (draggedId) {
        // Check if dropped outside split area (remove from split)
        const container = splitContainerRef.current
        if (container) {
          const rect = container.getBoundingClientRect()
          const isOutside = e.clientX < rect.left || e.clientX > rect.right ||
                           e.clientY < rect.top || e.clientY > rect.bottom

          if (isOutside) {
            setSplitTabs(prev => prev.filter(id => id !== draggedId))
          }
        }
      }

      setDraggingSplitTabId(null)
      setSplitDropTargetId(null)
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)

    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
      document.body.removeAttribute('data-split-dragging')
    }
  }, [draggingSplitTabId])

  // Tab-to-edge drag handlers for creating split views (using pointer events for Tauri compatibility)
  const handleTabPointerDown = useCallback((e: React.PointerEvent, tabId: string) => {
    // Only start drag on left mouse button
    if (e.button !== 0) return
    setDraggingTabId(tabId)
  }, [])

  // Handle the actual split creation (defined before useEffect that uses it)
  const handleSplitDrop = useCallback(() => {
    if (!draggingTabId || !edgeDropZone) return

    // If already in split view, add the dragged tab to the split (max 4)
    if (splitTabs.length >= 2 && !splitTabs.includes(draggingTabId)) {
      if (splitTabs.length < 4) {
        // Add to split based on edge dropped
        let newSplitTabs: string[]
        if (edgeDropZone === 'left' || edgeDropZone === 'top') {
          newSplitTabs = [draggingTabId, ...splitTabs]
        } else {
          newSplitTabs = [...splitTabs, draggingTabId]
        }

        // Limit to 4 tabs
        newSplitTabs = newSplitTabs.slice(0, 4)

        // Update layout for new tab count
        const tabCount = newSplitTabs.length
        let newLayout = splitLayout
        if (tabCount === 3 && (splitLayout === 'horizontal' || splitLayout === 'vertical')) {
          // Switch to asymmetric layout when adding 3rd tab
          newLayout = (edgeDropZone === 'top' || edgeDropZone === 'bottom')
            ? (edgeDropZone === 'bottom' ? '2-top-1-bottom' : '1-top-2-bottom')
            : splitLayout
        }

        setSplitTabs(newSplitTabs)
        setSplitLayout(newLayout)
        setActiveTabId(draggingTabId)
      }
      setDraggingTabId(null)
      setEdgeDropZone(null)
      return
    }

    // Create new split with dragged tab and partner
    const layout = (edgeDropZone === 'left' || edgeDropZone === 'right') ? 'horizontal' : 'vertical'

    // Find the next available tab to split with
    // Priority: 1) active tab if different, 2) next terminal tab in sequence
    let partnerTabId: string | null = null

    if (activeTabId && activeTabId !== draggingTabId) {
      partnerTabId = activeTabId
    } else {
      // Find the next terminal tab that isn't the dragged one
      const terminalTabs = tabs.filter(t => t.type === 'terminal' && t.id !== draggingTabId)
      if (terminalTabs.length > 0) {
        // Get the tab that comes after the dragged tab, or the first one
        const draggedIndex = tabs.findIndex(t => t.id === draggingTabId)
        const nextTab = terminalTabs.find(t => tabs.indexOf(t) > draggedIndex) || terminalTabs[0]
        partnerTabId = nextTab.id
      }
    }

    if (!partnerTabId) {
      // No other tab to split with
      setDraggingTabId(null)
      setEdgeDropZone(null)
      return
    }

    // Determine tab order based on edge: dragged tab goes to the dropped edge
    // left/top = dragged first, right/bottom = dragged second
    let newSplitTabs: string[]
    if (edgeDropZone === 'left' || edgeDropZone === 'top') {
      newSplitTabs = [draggingTabId, partnerTabId]
    } else {
      newSplitTabs = [partnerTabId, draggingTabId]
    }

    // Set standalone split state
    setSplitTabs(newSplitTabs)
    setSplitLayout(layout)
    // Make the dragged tab active
    setActiveTabId(draggingTabId)
    setDraggingTabId(null)
    setEdgeDropZone(null)
  }, [draggingTabId, edgeDropZone, activeTabId, tabs, splitTabs, splitLayout])

  // Use ref to track edge zone for the effect (avoids stale closure)
  const edgeDropZoneRef = useRef(edgeDropZone)
  edgeDropZoneRef.current = edgeDropZone
  const tabReorderDropTargetRef = useRef(tabReorderDropTarget)
  tabReorderDropTargetRef.current = tabReorderDropTarget

  // Track pointer movement and detect edge zones or tab bar reorder targets
  useEffect(() => {
    if (!draggingTabId) {
      document.body.removeAttribute('data-tab-dragging')
      return
    }

    // Set global cursor during drag
    document.body.setAttribute('data-tab-dragging', 'true')

    const handlePointerMove = (e: PointerEvent) => {
      // Check if pointer is over the tab bar (reorder mode)
      const tabBar = document.querySelector('.tab-bar') as HTMLElement | null
      if (tabBar) {
        const tabBarRect = tabBar.getBoundingClientRect()
        if (e.clientX >= tabBarRect.left && e.clientX <= tabBarRect.right &&
            e.clientY >= tabBarRect.top && e.clientY <= tabBarRect.bottom) {
          // Pointer is over tab bar — find which tab it's over
          const tabElements = tabBar.querySelectorAll('.tab:not(.split-tab-indicator)')
          let found = false
          tabElements.forEach((tabEl) => {
            const rect = tabEl.getBoundingClientRect()
            if (e.clientX >= rect.left && e.clientX <= rect.right) {
              const tabId = tabEl.getAttribute('data-tab-id')
              if (tabId && tabId !== draggingTabId) {
                const midX = rect.left + rect.width / 2
                const side: 'before' | 'after' = e.clientX < midX ? 'before' : 'after'
                setTabReorderDropTarget({ tabId, side })
                found = true
              }
            }
          })
          if (!found) setTabReorderDropTarget(null)
          // Clear edge drop zone while over tab bar
          setEdgeDropZone(null)
          return
        }
      }

      // Not over tab bar — clear reorder target, check edge zones
      setTabReorderDropTarget(null)

      const terminalArea = splitContainerRef.current
      if (!terminalArea) return

      const rect = terminalArea.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const threshold = 60

      // Check if pointer is over the terminal area
      if (e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
        let zone: 'left' | 'right' | 'top' | 'bottom' | null = null
        if (x < threshold) zone = 'left'
        else if (x > rect.width - threshold) zone = 'right'
        else if (y < threshold) zone = 'top'
        else if (y > rect.height - threshold) zone = 'bottom'
        setEdgeDropZone(zone)
      } else {
        setEdgeDropZone(null)
      }
    }

    const handlePointerUp = () => {
      const reorderTarget = tabReorderDropTargetRef.current
      if (reorderTarget) {
        // Reorder tabs in the tab bar
        const draggedId = draggingTabId
        setTabs(prev => {
          const newTabs = [...prev]
          const fromIndex = newTabs.findIndex(t => t.id === draggedId)
          const toIndex = newTabs.findIndex(t => t.id === reorderTarget.tabId)
          if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return prev
          const [removed] = newTabs.splice(fromIndex, 1)
          const insertIndex = reorderTarget.side === 'before' ? toIndex : toIndex + 1
          const adjustedIndex = fromIndex < toIndex ? insertIndex - 1 : insertIndex
          newTabs.splice(adjustedIndex, 0, removed)
          return newTabs
        })
      } else if (edgeDropZoneRef.current) {
        // Check if we have a valid drop zone using ref (avoids stale closure)
        handleSplitDrop()
      }
      setDraggingTabId(null)
      setEdgeDropZone(null)
      setTabReorderDropTarget(null)
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)

    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
      document.body.removeAttribute('data-tab-dragging')
    }
  }, [draggingTabId, handleSplitDrop])

  // Handle split from context menu
  const handleSplitFromContextMenu = useCallback((orientation: 'horizontal' | 'vertical') => {
    if (!contextMenuTabId) return

    // Find another terminal tab to split with (prefer active tab if different)
    let partnerTabId: string | null = null
    if (activeTabId && activeTabId !== contextMenuTabId) {
      const activeTab = tabs.find(t => t.id === activeTabId)
      if (activeTab?.type === 'terminal') {
        partnerTabId = activeTabId
      }
    }

    // If no partner, find another terminal tab
    if (!partnerTabId) {
      const otherTerminal = tabs.find(t => t.type === 'terminal' && t.id !== contextMenuTabId)
      partnerTabId = otherTerminal?.id || null
    }

    // If still no partner, create a new local terminal
    if (!partnerTabId) {
      const newId = `terminal-${Date.now()}`
      const localCount = tabs.filter(t => isTerminalTab(t) && !t.sessionId).length
      const newTab: Tab = {
        id: newId,
        title: localCount === 0 ? 'Local Shell' : `Local Shell ${localCount + 1}`,
        type: 'terminal',
        status: 'connecting',
        isJumpbox: isEnterprise,
      }
      setTabs(prev => [...prev, newTab])
      partnerTabId = newId
    }

    // Set up the split view
    setSplitTabs([contextMenuTabId, partnerTabId])
    setSplitLayout(orientation)
    setActiveTabId(contextMenuTabId)
    closeContextMenu()
  }, [contextMenuTabId, activeTabId, tabs, closeContextMenu, isEnterprise])

  // Handle "Discover Topology" from tab context menu
  const handleDiscoverTopologyFromGroup = useCallback(async () => {
    if (!contextMenuTabId) return

    // Find the group this tab belongs to
    const group = tabGroups.find(g => g.tabIds.includes(contextMenuTabId))
    if (!group) return

    // Get all tabs in this group that are connected terminals
    const groupTabs = tabs.filter(t =>
      group.tabIds.includes(t.id) &&
      t.type === 'terminal' &&
      t.status === 'connected'
    )

    if (groupTabs.length === 0) {
      showToast('No connected terminals in this group. Make sure your sessions are connected (green dot in tab).', 'warning')
      return
    }

    // Fetch sessions to get host IPs and profile IDs for discovery
    const allSessions = await listSessions()

    // Set up and open the discovery modal — see note in handleStartDiscovery
    // above re: using session.profile_id, not profiles[0].
    setDiscoveryGroupName(group.name)
    setDiscoveryDevices(groupTabs.map(t => {
      const session = allSessions.find(s => s.id === t.sessionId)
      return {
        name: t.title,
        tabId: t.id,
        ip: session?.host,
        profileId: session?.profile_id,
        snmpProfileId: session?.profile_id,
        cliFlavor: session?.cli_flavor,
      }
    }))
    setDiscoveryTargetTopologyId(null)
    setDiscoveryModalOpen(true)
    closeContextMenu()
  }, [contextMenuTabId, tabGroups, tabs, closeContextMenu])

  // Handle discovery complete - save topology to database with neighbor persistence
  const handleDiscoveryComplete = useCallback(async (
    results: DiscoveryResult[]
  ) => {
    if (results.length === 0) {
      return
    }

    // Hydrate the live EnrichmentContext for each discovered device so
    // DeviceDetailTab (read path) shows vendor/model/OS the moment the
    // user clicks a device — without waiting for the topology DB round-trip.
    // The persisted topology write below is the durable copy; this is the
    // in-memory cache the UI actually reads on render.
    //
    // IMPORTANT: key enrichments by the database session UUID (Tab.sessionId),
    // not the Tab.id (`r.tabId`). chipSessionsById is keyed by session UUID,
    // and the runtime SNMP-host resolver in App.tsx looks sessions up there
    // — using Tab.id would silently make every override miss.
    for (const r of results) {
      if (!r.tabId) continue;
      const tab = tabs.find(t => t.id === r.tabId);
      const sessionUuid = tab?.sessionId;
      if (!sessionUuid) continue;
      const parsed = parseSysDescr(r.sysDescr);
      setDeviceEnrichment(sessionUuid, {
        sessionId: sessionUuid,
        collectedAt: new Date().toISOString(),
        hostname: r.sysName || undefined,
        vendor: parsed.vendor,
        model: parsed.model,
        osVersion: parsed.osVersion,
      });
    }

    // When a tab's name is just an IPv4 (placeholder until we know better),
    // prefer the SNMP-discovered sysName for the topology display. User-set
    // names like "Core-Router" still win.
    const looksLikeIp = (name: string | undefined | null): boolean =>
      !!name && /^\d{1,3}(\.\d{1,3}){3}$/.test(name.trim())
    const displayNameFor = (r: DiscoveryResult): string => {
      if (looksLikeIp(r.device) && r.sysName) return r.sysName
      return r.device
    }

    try {
      // Step 1: Create or reuse topology
      let savedTopology: Topology
      const isAddToExisting = !!discoveryTargetTopologyId
      if (discoveryTargetTopologyId) {
        savedTopology = await getTopology(discoveryTargetTopologyId)
      } else {
        const topologyName = `${discoveryGroupName} Topology`
        savedTopology = await createTopology(topologyName, [])
      }

      // Step 2: Add primary devices from discovery results
      const deviceIdMap = new Map<string, string>() // Map device name to new backend ID

      for (const result of results) {
        // Determine device type from name patterns, then refine with sysDescr
        let deviceType = 'unknown'
        const deviceName = result.device.toLowerCase()

        // Name-based inference (common network device naming conventions)
        if (deviceName.startsWith('pe') || deviceName.startsWith('p-') || deviceName.includes('-pe') ||
            deviceName.startsWith('rtr') || deviceName.startsWith('rr') || deviceName.includes('router') ||
            /^p\d/.test(deviceName)) {
          deviceType = 'router'
        } else if (deviceName.startsWith('sw') || deviceName.includes('switch')) {
          deviceType = 'switch'
        } else if (deviceName.startsWith('fw') || deviceName.includes('firewall') || deviceName.startsWith('asa')) {
          deviceType = 'firewall'
        }

        // Refine with sysDescr if name-based inference was inconclusive
        if (deviceType === 'unknown' && result.sysDescr) {
          const descLower = result.sysDescr.toLowerCase()
          if (descLower.includes('router') || descLower.includes('ios xr') || descLower.includes('junos')) {
            deviceType = 'router'
          } else if (descLower.includes('switch') || descLower.includes('catalyst') || descLower.includes('nexus') ||
                     descLower.includes('eos') || descLower.includes('arista')) {
            deviceType = 'switch'
          } else if (descLower.includes('firewall') || descLower.includes('fortigate') || descLower.includes('palo alto') ||
                     descLower.includes('asa') || descLower.includes('pan-os')) {
            deviceType = 'firewall'
          } else if (descLower.includes('ios') || descLower.includes('cisco')) {
            deviceType = 'router'  // Default Cisco IOS to router
          }
        }

        // When adding to existing topology, check if device is already present
        // (e.g. a neighbor stub being promoted to a fully discovered device)
        const existingDevice = isAddToExisting
          ? savedTopology.devices.find(d =>
              d.name.toLowerCase() === result.device.toLowerCase() ||
              (result.ip && d.primaryIp === result.ip))
          : undefined

        let deviceResult: { id: string }
        if (existingDevice) {
          // Promote the existing neighbor stub — update its type, set profile, clear neighbor status
          await updateDevice(savedTopology.id, existingDevice.id, {
            device_type: deviceType !== 'unknown' ? deviceType : undefined,
            notes: '',
            profile_id: result.profileId,
            snmp_profile_id: result.snmpProfileId,
          })
          deviceResult = existingDevice
        } else {
          deviceResult = await addNeighborDevice(savedTopology.id, {
            name: displayNameFor(result),
            host: result.ip,
            device_type: deviceType,
            x: 300 + (deviceIdMap.size % 3) * 200,
            y: 200 + Math.floor(deviceIdMap.size / 3) * 150,
            profile_id: result.profileId,
            snmp_profile_id: result.snmpProfileId,
          })
        }

        // Store enrichment data from SNMP sysDescr (platform, vendor, version)
        const enrichment: Record<string, string> = {}
        if (result.ip) enrichment.primary_ip = result.ip
        if (result.sysDescr) {
          enrichment.platform = result.sysDescr.split('\n')[0]
          // Parse vendor from sysDescr
          const descLower = result.sysDescr.toLowerCase()
          if (descLower.includes('cisco')) enrichment.vendor = 'Cisco'
          else if (descLower.includes('juniper') || descLower.includes('junos')) enrichment.vendor = 'Juniper'
          else if (descLower.includes('arista')) enrichment.vendor = 'Arista'
          else if (descLower.includes('nokia') || descLower.includes('alcatel')) enrichment.vendor = 'Nokia'
          else if (descLower.includes('huawei')) enrichment.vendor = 'Huawei'
          else if (descLower.includes('paloalto') || descLower.includes('palo alto')) enrichment.vendor = 'Palo Alto'
          else if (descLower.includes('fortinet') || descLower.includes('fortigate')) enrichment.vendor = 'Fortinet'
          else if (descLower.includes('mikrotik')) enrichment.vendor = 'MikroTik'
          else if (descLower.includes('ubiquiti')) enrichment.vendor = 'Ubiquiti'
          else if (descLower.includes('linux')) enrichment.vendor = 'Linux'
          // Parse version from common sysDescr patterns
          const versionMatch = result.sysDescr.match(/(?:Version|version|ver\.?)\s+([\d.]+\S*)/i)
          if (versionMatch) enrichment.version = versionMatch[1]
        }
        if (Object.keys(enrichment).length > 0) {
          logger.log(`[discovery] Enriching device "${result.device}":`, enrichment)
          try {
            await updateDevice(savedTopology.id, deviceResult.id, enrichment)
          } catch (err) {
            console.error(`[discovery] Failed to enrich device "${result.device}":`, err)
          }
        }

        deviceIdMap.set(result.device, deviceResult.id)
      }

      // Identity index: lowercase alias (sysName | IP | tab name) → canonical
      // device ID. Lets us detect "this neighbor is the same device we already
      // added under a different name" — fixes the common case where one tab
      // is named by IP (e.g. 172.30.0.200) but appears in another device's
      // CDP/LLDP table by hostname (e.g. RR1-NYC) or vice-versa.
      const aliasToDeviceId = new Map<string, string>()
      const registerAlias = (alias: string | undefined | null, deviceId: string) => {
        if (!alias) return
        const key = alias.toLowerCase().trim()
        if (key && !aliasToDeviceId.has(key)) {
          aliasToDeviceId.set(key, deviceId)
        }
      }

      // When adding to an existing topology, register all existing devices
      // so neighbor resolution links to them instead of creating duplicates.
      if (isAddToExisting) {
        for (const d of savedTopology.devices) {
          registerAlias(d.name, d.id)
          registerAlias(d.primaryIp, d.id)
        }
      }

      // Sessions are authoritative for SNMP IPs. When CDP returns a neighbor
      // by hostname (e.g. "P2-CHI") with a loopback IP (e.g. 10.255.0.11)
      // that's NOT actually SNMP-reachable, we want to use the management IP
      // of the matching session tab instead.
      //
      // Two sources of "I know this hostname's real management IP":
      //  1. Primaries in this discovery run that returned sysName via SNMP.
      //  2. Any session whose DeviceDetailTab previously cached a hostname
      //     (EnrichmentContext) — even if that session wasn't part of *this*
      //     discovery group, we still know what device it is.
      const sessionIpBySysName = new Map<string, string>()
      for (const r of results) {
        if (r.sysName && r.ip) {
          sessionIpBySysName.set(r.sysName.toLowerCase().trim(), r.ip)
        }
      }
      // Fold in EnrichmentContext: hostname → session.host for any session
      // whose DeviceDetailTab previously cached a hostname. Look the
      // session up in chipSessionsById (Tab itself has no `host` field —
      // the host lives on the linked Session record). Doesn't overwrite
      // primary results' entries; those are already authoritative matches.
      deviceEnrichments.forEach((enr) => {
        if (!enr.hostname) return
        const key = enr.hostname.toLowerCase().trim()
        if (!key || sessionIpBySysName.has(key)) return
        const session = chipSessionsById.get(enr.sessionId)
        if (session?.host) sessionIpBySysName.set(key, session.host)
      })

      // Register aliases for every primary device we just created so neighbor
      // resolution below can find them under any of (tab name, sysName, IP).
      for (const result of results) {
        const id = deviceIdMap.get(result.device)
        if (!id) continue
        registerAlias(result.device, id)
        registerAlias(result.sysName, id)
        registerAlias(result.ip, id)
      }

      const createdConnections = new Set<string>()
      let neighborIndex = 0

      // Single pass: for each primary's neighbors, either link to an existing
      // node (when alias resolves) or add as a new neighbor node and register
      // its aliases for the rest of the pass.
      for (const result of results) {
        const sourceId = deviceIdMap.get(result.device)
        if (!sourceId) continue

        const resultIndex = results.indexOf(result)
        const sourceX = 300 + (resultIndex % 3) * 200
        const sourceY = 200 + Math.floor(resultIndex / 3) * 150

        for (const neighbor of result.neighbors) {
          const nameKey = neighbor.neighborName?.toLowerCase().trim() ?? ''
          const ipKey = neighbor.neighborIp?.toLowerCase().trim() ?? ''
          // Resolve identity: try name first, then IP — first hit wins.
          const existingId =
            (nameKey && aliasToDeviceId.get(nameKey)) ||
            (ipKey && aliasToDeviceId.get(ipKey))

          if (existingId) {
            // Same device already on the canvas (either as a primary or a
            // previously-added neighbor). Just draw the link.
            if (existingId === sourceId) continue
            const connKey = [sourceId, existingId].sort().join('-')
            if (createdConnections.has(connKey)) continue
            createdConnections.add(connKey)
            try {
              await createTopologyConnection(savedTopology.id, {
                source_device_id: sourceId,
                target_device_id: existingId,
                source_interface: neighbor.localInterface,
                target_interface: neighbor.neighborInterface || undefined,
              })
            } catch (err) {
              console.error('Failed to create connection:', err)
            }
            continue
          }

          // Net-new neighbor — add it to the topology + register its aliases.
          // Position in a fan around the source device.
          const angle = (neighborIndex * 45) * (Math.PI / 180)
          const radius = 120
          const nx = sourceX + Math.cos(angle) * radius
          const ny = sourceY + Math.sin(angle) * radius

          // Infer device type from neighbor name, then platform description
          let neighborDeviceType = 'unknown'
          const nName = neighbor.neighborName.toLowerCase()
          if (nName.startsWith('pe') || nName.startsWith('p-') || nName.includes('-pe') ||
              nName.startsWith('rtr') || nName.startsWith('rr') || nName.includes('router') ||
              /^p\d/.test(nName)) {
            neighborDeviceType = 'router'
          } else if (nName.startsWith('sw') || nName.includes('switch')) {
            neighborDeviceType = 'switch'
          } else if (nName.startsWith('fw') || nName.includes('firewall') || nName.startsWith('asa')) {
            neighborDeviceType = 'firewall'
          }
          if (neighborDeviceType === 'unknown' && neighbor.neighborPlatform) {
            const platLower = neighbor.neighborPlatform.toLowerCase()
            if (platLower.includes('router') || platLower.includes('ios xr') || platLower.includes('junos')) {
              neighborDeviceType = 'router'
            } else if (platLower.includes('switch') || platLower.includes('catalyst') || platLower.includes('nexus') ||
                       platLower.includes('eos') || platLower.includes('arista')) {
              neighborDeviceType = 'switch'
            } else if (platLower.includes('firewall') || platLower.includes('fortigate') || platLower.includes('asa')) {
              neighborDeviceType = 'firewall'
            } else if (platLower.includes('ios') || platLower.includes('cisco')) {
              neighborDeviceType = 'router'
            }
          }

          // Session-IP override: if CDP gave us a loopback IP for a neighbor
          // whose name matches one of our session tabs, the session's IP is
          // the real SNMP-reachable management IP — never store the loopback.
          const sessionMatchedIp = nameKey ? sessionIpBySysName.get(nameKey) : undefined
          const neighborSnmpIp = sessionMatchedIp || neighbor.neighborIp || ''

          try {
            const neighborResult = await addNeighborDevice(savedTopology.id, {
              name: neighbor.neighborName,
              host: neighborSnmpIp,
              device_type: neighborDeviceType,
              x: nx,
              y: ny,
              profile_id: result.profileId,
              snmp_profile_id: result.snmpProfileId,
            })
            neighborIndex++
            registerAlias(neighbor.neighborName, neighborResult.id)
            registerAlias(neighbor.neighborIp, neighborResult.id)
            // Also register the session-matched IP so further CDP refs by
            // either alias resolve to the same node.
            if (sessionMatchedIp) registerAlias(sessionMatchedIp, neighborResult.id)

            await updateDevice(savedTopology.id, neighborResult.id, {
              notes: 'discovery:neighbor',
              ...(neighbor.neighborPlatform ? { platform: neighbor.neighborPlatform } : {}),
              ...(neighborSnmpIp ? { primary_ip: neighborSnmpIp } : {}),
            })

            await createTopologyConnection(savedTopology.id, {
              source_device_id: sourceId,
              target_device_id: neighborResult.id,
              source_interface: neighbor.localInterface,
              target_interface: neighbor.neighborInterface || undefined,
            })
          } catch (err) {
            console.error('Failed to add neighbor device:', err)
          }
        }
      }

      // Step 5: Fetch the complete saved topology and re-apply isNeighbor
      const completeTopology = await getTopology(savedTopology.id)
      for (const device of completeTopology.devices) {
        if (device.notes === 'discovery:neighbor') {
          device.isNeighbor = true
        }
      }

      // Step 6: Open or refresh topology tab
      if (isAddToExisting) {
        // Refresh existing topology tab
        setTopologyRefreshKeys(prev => ({
          ...prev,
          [savedTopology.id]: (prev[savedTopology.id] || 0) + 1
        }))
        // Switch to the existing topology tab
        const existingTab = tabs.find(t => t.type === 'topology' && t.topologyId === savedTopology.id)
        if (existingTab) setActiveTabId(existingTab.id)
      } else {
        const newTabId = `topology-${completeTopology.id}-${Date.now()}`
        const newTab: Tab = {
          id: newTabId,
          type: 'topology',
          title: completeTopology.name,
          topologyId: completeTopology.id,
          topologyName: completeTopology.name,
          status: 'ready',
        }
        setTabs(prev => [...prev, newTab])
        setActiveTabId(newTabId)
      }
      setDiscoveryTargetTopologyId(null)
      setDiscoveryModalOpen(false)
      // Discovery may have created a topology — refresh the sidebar list.
      window.dispatchEvent(new Event('topologies-changed'))
    } catch (err) {
      console.error('Failed to save topology:', err)
      showToast(`Failed to save topology: ${getErrorMessage(err)}`, 'error')
    }
  }, [discoveryGroupName, discoveryDevices, discoveryTargetTopologyId, tabs, chipSessionsById, deviceEnrichments, setDeviceEnrichment])

  // Discovery toast handlers
  const handleToastRunDiscovery = useCallback(() => {
    if (!discoveryToast) return
    setDiscoveryToast(null)
    setDiscoveryTargetTopologyId(null)
    setDiscoveryModalOpen(true)
  }, [discoveryToast])

  const handleToastDismiss = useCallback(() => {
    setDiscoveryToast(null)
  }, [])

  // Handle "New Topology" from TopologyPanel — picks sessions then opens discovery modal
  const handleStartDiscoveryFromPanel = useCallback((name: string, selectedSessions: { id: string; name: string; host?: string; profileId?: string; cliFlavor?: string; credentialId?: string; snmpCredentialId?: string }[]) => {
    // Map selected sessions to discovery devices, finding the tab ID for each
    const devices = selectedSessions.map(s => {
      const tab = tabs.find(t => t.sessionId === s.id && t.type === 'terminal' && t.status === 'connected')
      return {
        name: s.name,
        tabId: tab?.id || s.id,
        ip: s.host,
        profileId: s.profileId,
        snmpProfileId: s.profileId,
        cliFlavor: s.cliFlavor,
        // Enterprise mode: pass SSH + SNMP credential IDs separately for controller vault resolution
        credentialId: s.credentialId,
        snmpCredentialId: s.snmpCredentialId,
      }
    })

    setDiscoveryGroupName(name)
    setDiscoveryDevices(devices)
    setDiscoveryTargetTopologyId(null)
    setDiscoveryModalOpen(true)
  }, [tabs])

  // Handle SSH session connection
  const handleSSHConnect = useCallback((session: Session) => {
    // Check if there's an existing disconnected tab for this session
    // Use tabsRef to avoid dependency on tabs which would cause callback recreation
    const existingTab = tabsRef.current.find(t =>
      t.sessionId === session.id &&
      t.type === 'terminal' &&
      (t.status === 'disconnected' || t.status === 'error')
    )

    if (existingTab) {
      // Reconnect the existing tab
      const handle = terminalRefs.current.get(existingTab.id)
      if (handle) {
        handle.reconnect()
        setActiveTabId(existingTab.id)
        return
      }
    }

    // Create a new tab
    const newId = `ssh-${session.id}-${Date.now()}`
    const { fontSize, fontFamily, terminalTheme } = getEffectiveFontSettings(session)
    const newTab: Tab = {
      id: newId,
      type: 'terminal',
      title: session.name,
      sessionId: session.id,
      profileId: session.profile_id,
      protocol: session.protocol || 'ssh',
      cliFlavor: session.cli_flavor,
      terminalTheme,
      fontSize,
      fontFamily,
      color: session.color || undefined,
      status: 'connecting'
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newId)
    // Session info is passed through tab.sessionId - Terminal handles SSH connection via WebSocket
  }, [getEffectiveFontSettings])

  // Register MOP wizard "open session" callback so clicking a device in the
  // execution dashboard opens its terminal tab and minimizes the wizard
  const mopContext = useMopExecutionOptional()
  useEffect(() => {
    if (!mopContext) return
    const handleOpenSession = async (sessionId: string) => {
      // Check for existing tab with this sessionId
      const existingTab = tabsRef.current.find(t =>
        t.sessionId === sessionId && t.type === 'terminal'
      )
      if (existingTab) {
        // Reconnect if disconnected, otherwise just activate
        if (existingTab.status === 'disconnected' || existingTab.status === 'error') {
          const handle = terminalRefs.current.get(existingTab.id)
          if (handle) handle.reconnect()
        }
        setActiveTabId(existingTab.id)
        return
      }
      // Fetch session and create new terminal tab
      try {
        const session = await getSession(sessionId)
        const { fontSize, fontFamily, terminalTheme } = getEffectiveFontSettings(session)
        const newId = `ssh-${session.id}-${Date.now()}`
        const newTab: Tab = {
          id: newId,
          type: 'terminal',
          title: session.name,
          sessionId: session.id,
          profileId: session.profile_id,
          protocol: session.protocol || 'ssh',
          cliFlavor: session.cli_flavor,
          terminalTheme,
          fontSize,
          fontFamily,
          color: session.color || undefined,
          status: 'connecting'
        }
        setTabs(prev => [...prev, newTab])
        setActiveTabId(newId)
      } catch (err) {
        console.error('Failed to open session from MOP wizard:', err)
      }
    }
    mopContext.setOnOpenSession(handleOpenSession)
    return () => mopContext.setOnOpenSession(null)
  }, [mopContext, getEffectiveFontSettings])

  // Handle bulk connect for multiple sessions
  const handleBulkConnect = useCallback(async (sessionIds: string[]): Promise<void> => {
    if (sessionIds.length === 0) return

    try {
      // Fetch all sessions to get their full data
      const allSessions = await listSessions()
      const sessionsToConnect = allSessions.filter(s => sessionIds.includes(s.id))

      if (sessionsToConnect.length === 0) {
        console.warn('No matching sessions found for bulk connect')
        return
      }

      // Open terminals with a small stagger to avoid overwhelming connections
      const STAGGER_DELAY = 100 // ms between each connection

      for (let i = 0; i < sessionsToConnect.length; i++) {
        const session = sessionsToConnect[i]
        const { fontSize, fontFamily, terminalTheme } = getEffectiveFontSettings(session)

        // Create terminal tab for this session
        const newId = `ssh-${session.id}-${Date.now()}-${i}`
        const newTab: Tab = {
          id: newId,
          type: 'terminal',
          title: session.name,
          sessionId: session.id,
          profileId: session.profile_id,
          cliFlavor: session.cli_flavor,
          terminalTheme,
          fontSize,
          fontFamily,
          color: session.color || undefined,
          status: 'connecting'
        }

        setTabs(prev => [...prev, newTab])

        // Set the last one as active
        if (i === sessionsToConnect.length - 1) {
          setActiveTabId(newId)
        }

        logger.log('Bulk connecting to SSH session:', session.host, session.port, 'profile:', session.profile_id)

        // Stagger the connections
        if (i < sessionsToConnect.length - 1) {
          await new Promise(resolve => setTimeout(resolve, STAGGER_DELAY))
        }
      }

      logger.log(`Bulk connect: opened ${sessionsToConnect.length} sessions`)
    } catch (err) {
      console.error('Bulk connect failed:', err)
    }
  }, [getEffectiveFontSettings])

  // Handle device connect (Phase 42.2-03: Device browser to connect dialog)
  const handleDeviceConnect = useCallback((device: DeviceSummary) => {
    // Create a temporary session-like object for the connect dialog
    // The dialog will show device host/port and credential selection
    const tempSession: EnterpriseSession = {
      id: `device-${device.id}`,
      org_id: device.org_id,
      name: device.name,
      host: device.host,
      port: device.port,
      description: `Device: ${device.device_type}${device.site ? ` (${device.site})` : ''}`,
      cli_flavor: 'auto',
      tags: [],
      profile_override_id: null,
      created_by: null,
      active_connections: 0,
      created_at: device.created_at,
      updated_at: device.updated_at,
    }
    // profile_override_id stays null (means "use device/user default"); the
    // device's own assigned profile is threaded separately for dialog labeling.
    setEnterpriseConnectDeviceProfileId(device.profile_id ?? null)
    setEnterpriseConnectSession(tempSession)
  }, [])

  // Quick connect to a device (no dialog). Send NO profile_id so the controller
  // device-anchors: explicit override → device's assigned profile → user default
  // → error. Passing the user-default here would defeat device-anchoring.
  const handleDeviceQuickConnect = useCallback(async (device: DeviceSummary) => {
    const newId = `enterprise-ssh-device-${device.id}-${Date.now()}`
    const newTab: Tab = {
      id: newId,
      type: 'terminal',
      title: device.name,
      protocol: 'ssh',
      cliFlavor: 'auto',
      status: 'connecting',
      enterpriseProfileId: '', // empty → hook omits profile_id → device-anchored
      enterpriseSessionDefinitionId: `device-${device.id}`,
      enterpriseTargetHost: device.host,
      enterpriseTargetPort: device.port,
    } as Tab
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newId)
  }, [])

  // Handle profile selection from dialog - create enterprise terminal tab.
  // The chosen profile_id is carried on the in-memory Tab and threaded to the
  // /ws/ssh connect URL. The session definition's persisted override field is
  // now profile_override_id (FK to profiles); the connect-time selection here
  // is per-tab and not persisted onto the definition.
  const handleEnterpriseProfileSelected = useCallback((profileId: string) => {
    if (!enterpriseConnectSession) return

    // Create enterprise terminal tab
    const newId = `enterprise-ssh-${enterpriseConnectSession.id}-${Date.now()}`
    const newTab: Tab = {
      id: newId,
      type: 'terminal',
      title: enterpriseConnectSession.name,
      protocol: 'ssh',
      cliFlavor: enterpriseConnectSession.cli_flavor,
      status: 'connecting',
      enterpriseProfileId: profileId,
      enterpriseSessionDefinitionId: enterpriseConnectSession.id,
      enterpriseTargetHost: enterpriseConnectSession.host,
      enterpriseTargetPort: enterpriseConnectSession.port,
    } as Tab

    setTabs(prev => [...prev, newTab])
    setActiveTabId(newId)

    setEnterpriseConnectSession(null) // Close dialog
  }, [enterpriseConnectSession])

  // Handle selection changes from SessionPanel
  const handleSelectionChange = useCallback((ids: string[]) => {
    setSelectedSessionIds(ids)
  }, [])

  // Handle session updates from SessionPanel (updates open tabs)
  const handleSessionUpdated = useCallback((updatedSession: Session) => {
    const { fontSize, fontFamily, terminalTheme } = getEffectiveFontSettings(updatedSession)
    setTabs(prev => prev.map(tab =>
      tab.sessionId === updatedSession.id
        ? {
            ...tab,
            title: updatedSession.name,
            terminalTheme,
            fontSize,
            fontFamily,
            color: updatedSession.color || undefined,
            cliFlavor: updatedSession.cli_flavor,
          }
        : tab
    ))
  }, [getEffectiveFontSettings])


  // === Troubleshooting Session Handlers (Phase 26) ===

  // Handle starting a new troubleshooting session from dialog
  const handleStartTroubleshootingSession = useCallback((
    name: string,
    terminalIds: string[],
    includeAI: boolean
  ) => {
    setCaptureAIConversations(includeAI)
    startTroubleshootingSession(name, terminalIds)
    setTroubleshootingDialogOpen(false)
  }, [startTroubleshootingSession])

  // Handle ending troubleshooting session (from StatusBar indicator)
  const handleEndTroubleshootingSession = useCallback(async () => {
    const session = endTroubleshootingSession()
    if (!session) return

    // Check if session has enough entries to summarize
    if (session.entries.length === 0) {
      showToast('Session ended with no captured entries', 'info')
      return
    }

    // Start summarization
    setIsSummarizingSession(true)
    showToast('Generating troubleshooting summary...', 'info', 5000)

    // Always generate fallback first so we have something to save even if AI fails
    const fallback = generateFallbackSummary(session)

    try {
      // Try AI summarization first
      let summary
      try {
        summary = await summarizeTroubleshootingSession(session, callAIChat)
      } catch (aiError) {
        console.warn('[Troubleshooting] AI summarization failed, using fallback:', aiError)
        summary = fallback
      }

      // Save the summary as a document
      const result = await saveTroubleshootingSummary(summary, session.topologyId)

      showToast(
        `Summary saved: ${result.documentName}`,
        'success',
        4000
      )
      logger.log('[Troubleshooting] Document created:', result.documentId)

    } catch (err) {
      console.error('[Troubleshooting] Failed to save summary, attempting fallback save:', err)

      // Retry with fallback summary if AI summary save failed
      try {
        const result = await saveTroubleshootingSummary(fallback, session.topologyId)
        showToast(
          `Summary saved (basic): ${result.documentName}`,
          'success',
          4000
        )
      } catch (retryErr) {
        console.error('[Troubleshooting] Fallback save also failed:', retryErr)
        showToast(
          `Failed to save summary: ${getErrorMessage(retryErr)}`,
          'error',
          5000
        )
      }
    } finally {
      setIsSummarizingSession(false)
    }
  }, [endTroubleshootingSession])

  // Handle troubleshooting session timeout (auto-save on inactivity)
  const handleTroubleshootingTimeout: OnTimeoutCallback = useCallback(async (session: TroubleshootingSession) => {
    if (session.entries.length === 0) {
      showToast('Session timed out with no entries', 'info')
      return
    }

    showToast('Session timed out - generating summary...', 'info', 5000)
    setIsSummarizingSession(true)

    const fallback = generateFallbackSummary(session)

    try {
      let summary
      try {
        summary = await summarizeTroubleshootingSession(session, callAIChat)
      } catch (aiError) {
        console.warn('[Troubleshooting] AI summarization failed on timeout, using fallback:', aiError)
        summary = fallback
      }

      const result = await saveTroubleshootingSummary(summary, session.topologyId)
      showToast(`Auto-saved summary: ${result.documentName}`, 'success', 4000)
      logger.log('[Troubleshooting] Timeout document created:', result.documentId)
    } catch (err) {
      console.error('[Troubleshooting] Failed to save timeout summary, attempting fallback:', err)
      try {
        const result = await saveTroubleshootingSummary(fallback, session.topologyId)
        showToast(`Auto-saved summary (basic): ${result.documentName}`, 'success', 4000)
      } catch (retryErr) {
        console.error('[Troubleshooting] Fallback save also failed:', retryErr)
        showToast(
          `Failed to auto-save summary: ${getErrorMessage(retryErr)}`,
          'error',
          5000
        )
      }
    } finally {
      setIsSummarizingSession(false)
    }
  }, [])

  // Set up timeout callback for troubleshooting session
  useEffect(() => {
    setTroubleshootingTimeout(handleTroubleshootingTimeout)
  }, [setTroubleshootingTimeout, handleTroubleshootingTimeout])

  // Handle attaching topology to troubleshooting session
  const handleAttachTroubleshootingTopology = useCallback(() => {
    // Find the active topology tab
    const activeTab = tabs.find(t => t.id === activeTabId && t.type === 'topology')
    if (activeTab?.topologyId) {
      attachTroubleshootingTopology(activeTab.topologyId)
    } else {
      // Find any open topology tab
      const topoTab = tabs.find(t => t.type === 'topology' && t.topologyId)
      if (topoTab?.topologyId) {
        attachTroubleshootingTopology(topoTab.topologyId)
      }
    }
  }, [tabs, activeTabId, attachTroubleshootingTopology])

  // Callback for terminal components to capture commands/output.
  // The caller (Terminal) already gates on the isTroubleshootingActive prop
  // which was pre-evaluated with isTroubleshootingCapturing(tab.id). We only
  // re-check isTroubleshootingActive here as a safety guard — we must NOT
  // re-check isCapturing because Terminal passes its backend sessionId which
  // differs from the tab.id stored in session.terminalIds.
  const handleTroubleshootingCapture = useCallback((
    terminalId: string,
    terminalName: string,
    type: 'command' | 'output',
    content: string
  ) => {
    if (isTroubleshootingActive) {
      addTroubleshootingEntry(terminalId, terminalName, type, content)
    }
  }, [isTroubleshootingActive, addTroubleshootingEntry])

  // Callback for AI panel to capture chat messages
  const handleTroubleshootingAICapture = useCallback((
    type: 'ai-chat',
    content: string
  ) => {
    if (isTroubleshootingActive && captureAIConversations) {
      addTroubleshootingEntry('ai-panel', 'AI Assistant', type, content)
    }
  }, [isTroubleshootingActive, captureAIConversations, addTroubleshootingEntry])

  // Get connected sessions for the dialog (Phase 26)
  const connectedSessionsForTroubleshooting = useMemo(() => {
    return tabs
      .filter(tab => tab.type === 'terminal' && tab.status === 'connected')
      .map(tab => ({
        id: tab.id,
        name: tab.title,
      }))
  }, [tabs])

  // Define available commands
  const commands: Command[] = [
    {
      id: 'new-terminal',
      label: 'New Terminal',
      category: 'Terminal',
      shortcut: 'Cmd+T',
      action: createTerminal
    },
    {
      id: 'view-sessions',
      label: 'View: Show Sessions',
      category: 'View',
      action: () => {
        setActiveView('sessions')
        setSidebarOpen(true)
      }
    },
    {
      id: 'view-topology',
      label: 'View: Show Topology',
      category: 'View',
      action: () => {
        setActiveView('topology')
        setSidebarOpen(true)
      }
    },
    {
      id: 'open-settings',
      label: 'Open Settings',
      category: 'Preferences',
      shortcut: 'Cmd+,',
      action: () => openSettingsTab()
    },
    {
      id: 'about',
      label: 'About NetStacks',
      category: 'Help',
      action: () => setShowAbout(true)
    },
    {
      id: 'toggle-sidebar',
      label: 'View: Toggle Sidebar',
      category: 'View',
      shortcut: 'Cmd+B',
      action: () => setSidebarOpen(prev => !prev)
    },
    {
      id: 'quick-connect',
      label: 'Quick Connect',
      category: 'Sessions',
      shortcut: 'Cmd+Shift+Q',
      action: () => setQuickConnectOpen(true)
    },
    {
      id: 'ai-chat',
      label: 'AI: Open Chat',
      category: 'AI',
      shortcut: 'Cmd+I',
      action: () => setAiChatOpen(true)
    },
    {
      id: 'setup-wizard',
      label: 'Setup Wizard',
      category: 'General',
      action: () => setWizardOpen(true)
    },
    {
      id: 'ai-overlay',
      label: 'AI: Open Chat Tab',
      category: 'AI',
      shortcut: 'Cmd+Shift+A',
      action: () => {
        // Open the full chat-session tab (replaces the old floating overlay).
        handleOpenAIChatTab()
      }
    },
    {
      id: 'view-docs',
      label: 'View: Show Documents',
      category: 'View',
      action: () => {
        setActiveView('docs')
        setSidebarOpen(true)
      }
    },
    {
      id: 'ai-generate-script',
      label: 'AI: Generate Script',
      category: 'AI',
      shortcut: 'Cmd+Shift+G',
      action: () => setAiScriptGeneratorOpen(true)
    },
    {
      id: 'new-script',
      label: 'New Script',
      category: 'Scripts',
      action: handleNewScript
    },
    // Troubleshooting (Phase 26)
    {
      id: 'start-troubleshooting',
      label: 'Start Troubleshooting Session',
      category: 'Sessions',
      shortcut: 'Cmd+Shift+K',
      action: () => {
        if (!isTroubleshootingActive) {
          setTroubleshootingDialogOpen(true)
        }
      }
    },
    {
      id: 'end-troubleshooting',
      label: 'End Troubleshooting Session',
      category: 'Sessions',
      action: () => {
        if (isTroubleshootingActive) {
          handleEndTroubleshootingSession()
        }
      }
    },
  ]

  // ── Scratchpad handlers ──────────────────────────────────────────
  // Clicking the status-bar / menu / keyboard binding restores the
  // existing in-memory buffer if there is one (minimized or not), or
  // creates a fresh empty one otherwise.
  const handleOpenScratchpad = useCallback(() => {
    setScratchpadExists(true)
    setScratchpadMinimized(false)
  }, [])
  const handleCloseScratchpad = useCallback(() => {
    setScratchpadExists(false)
    setScratchpadMinimized(false)
    setScratchpadMaximized(false)
    setScratchpadContent('')
  }, [])
  const handleMinimizeScratchpad = useCallback(() => {
    setScratchpadMinimized(true)
  }, [])
  const handleToggleScratchpadMax = useCallback(() => {
    setScratchpadMaximized(m => !m)
  }, [])
  const handlePopScratchpadToTab = useCallback(() => {
    const initialContent = scratchpadContent
    const newTab: Tab = {
      id: `scratchpad-${Date.now()}`,
      type: 'scratchpad',
      title: 'Scratchpad',
      status: 'ready' as DetailStatus,
      scratchpadInitialContent: initialContent,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTab.id)
    // Floating panel is done — clear in-memory state so a future open
    // starts fresh. The tab owns its own buffer from here.
    setScratchpadExists(false)
    setScratchpadMinimized(false)
    setScratchpadMaximized(false)
    setScratchpadContent('')
  }, [scratchpadContent])

  // Handle save for active document tab
  const handleSaveActiveDocument = useCallback(() => {
    if (!activeTabId) return
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (!activeTab || !isDocumentTab(activeTab) || !activeTab.documentId) return

    // Trigger save in DocumentTabEditor via a custom event
    const event = new CustomEvent('netstacks:save-document', { detail: { tabId: activeTabId } })
    window.dispatchEvent(event)
  }, [activeTabId, tabs])

  // AI Agent: Execute command on a terminal session
  // This finds the terminal by sessionId and sends the command
  const handleAgentExecuteCommand = useCallback(async (sessionId: string, command: string): Promise<string> => {
    // Look up by tab.id first (AI context uses tab IDs), fall back to sessionId for backwards compat
    const tab = tabs.find(t => t.id === sessionId) ||
      tabs.find(t => t.type === 'terminal' && (t.sessionId === sessionId || t.enterpriseSessionDefinitionId === sessionId))
    if (!tab) {
      throw new Error(`No terminal found for session ${sessionId}`)
    }

    // Get the terminal handle
    const handle = terminalRefs.current.get(tab.id)
    if (!handle) {
      throw new Error(`Terminal handle not available for session ${sessionId}`)
    }

    if (!handle.isConnected()) {
      throw new Error(`Terminal for session ${sessionId} is not connected`)
    }

    // Execute command and return output
    return handle.sendCommand(command)
  }, [tabs])

  // AI Agent: Get terminal context (recent output)
  const handleAgentGetTerminalContext = useCallback(async (sessionId: string, lines?: number, sinceOffset?: number): Promise<string> => {
    // Look up by tab.id first (AI context uses tab IDs), fall back to sessionId for backwards compat
    const tab = tabs.find(t => t.id === sessionId) ||
      tabs.find(t => t.type === 'terminal' && (t.sessionId === sessionId || t.enterpriseSessionDefinitionId === sessionId))
    if (!tab) {
      throw new Error(`No terminal found for session ${sessionId}`)
    }

    // Get the terminal handle
    const handle = terminalRefs.current.get(tab.id)
    if (!handle) {
      throw new Error(`Terminal handle not available for session ${sessionId}`)
    }

    return handle.getBuffer(lines, sinceOffset)
  }, [tabs])

  // AI live-context deps: provide terminal buffer + session metadata for live workspace envelope
  const liveContextDeps = useMemo(() => ({
    getBuffer: (sessionId: string, lines: number): string | null => {
      const tab = tabs.find(t => t.id === sessionId) ||
        tabs.find(t => t.type === 'terminal' && (t.sessionId === sessionId || t.enterpriseSessionDefinitionId === sessionId))
      if (!tab) return null
      const handle = terminalRefs.current.get(tab.id)
      return handle ? handle.getBuffer(lines) : null
    },
    getSession: (sessionId: string) => {
      const tab = tabs.find(t => t.id === sessionId) ||
        tabs.find(t => t.type === 'terminal' && (t.sessionId === sessionId || t.enterpriseSessionDefinitionId === sessionId))
      if (!tab) return null
      return { name: tab.title, cliFlavor: tab.cliFlavor }
    },
    getEditorState: (): { path: string; dirty: boolean } | null => {
      const activeTab = tabs.find(t => t.id === activeTabId)
      if (!activeTab || !isDocumentTab(activeTab)) return null
      return {
        path: activeTab.title,
        dirty: activeTab.status === 'modified',
      }
    },
  }), [tabs, activeTabId])

  // AI Agent: Open a saved session (create terminal tab and connect)
  const handleAgentOpenSession = useCallback(async (sessionId: string): Promise<void> => {
    // Check if session is already open
    const existingTab = tabs.find(t => t.sessionId === sessionId && t.type === 'terminal')
    if (existingTab) {
      // Just switch to it
      setActiveTabId(existingTab.id)
      return
    }

    if (isEnterprise) {
      // Enterprise mode: fetch session definition from Controller
      const session = await getSessionDefinition(sessionId)
      if (!session) {
        throw new Error(`Session ${sessionId} not found`)
      }

      // Agent-open intentionally connects device-anchored (no profile_id) so the
      // controller resolves the device's default profile. We do NOT auto-apply a
      // session definition's persisted profile_override_id here — profile choice
      // for agent-launched sessions stays device-default unless the user picks one.
      const newId = `enterprise-ssh-${session.id}-${Date.now()}`
      const newTab: Tab = {
        id: newId,
        type: 'terminal',
        title: session.name,
        protocol: 'ssh',
        cliFlavor: session.cli_flavor,
        status: 'connecting',
        sessionId: session.id,
        enterpriseSessionDefinitionId: session.id,
        enterpriseTargetHost: session.host,
        enterpriseTargetPort: session.port,
      } as Tab
      setTabs(prev => [...prev, newTab])
      setActiveTabId(newId)
    } else {
      // Personal mode: fetch from local sidecar
      const allSessions = await listSessions()
      const session = allSessions.find(s => s.id === sessionId)
      if (!session) {
        throw new Error(`Session ${sessionId} not found`)
      }

      const newId = `ssh-${session.id}-${Date.now()}`
      const { fontSize, fontFamily, terminalTheme } = getEffectiveFontSettings(session)
      const newTab: Tab = {
        id: newId,
        type: 'terminal',
        title: session.name,
        sessionId: session.id,
        profileId: session.profile_id,
        cliFlavor: session.cli_flavor,
        terminalTheme,
        fontSize,
        fontFamily,
        color: session.color || undefined,
        status: 'connecting'
      }
      setTabs(prev => [...prev, newTab])
      setActiveTabId(newId)
    }
  }, [tabs, isEnterprise, getEffectiveFontSettings])

  // AI Agent: List documents by category
  const handleAgentListDocuments = useCallback(async (category?: DocumentCategory): Promise<Document[]> => {
    const docs = await listDocuments(category)
    return docs
  }, [])

  // AI Agent: Read a document by ID, or by name when byName is set (newest match)
  const handleAgentReadDocument = useCallback(async (documentId: string, byName?: boolean): Promise<Document | null> => {
    try {
      if (byName) {
        const all = await listDocuments()
        const lower = documentId.toLowerCase()
        const match =
          all.filter(d => d.name.toLowerCase() === lower)
             .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0]
          || all.find(d => d.name.toLowerCase().includes(lower))
        if (!match) return null
        return await getDocument(match.id)
      }
      return await getDocument(documentId)
    } catch {
      return null
    }
  }, [])

  // AI Agent: Search documents by name/content
  const handleAgentSearchDocuments = useCallback(async (query: string, category?: DocumentCategory): Promise<Document[]> => {
    const docs = await listDocuments(category)
    const lowerQuery = query.toLowerCase()
    return docs.filter(d =>
      d.name.toLowerCase().includes(lowerQuery) ||
      d.content.toLowerCase().includes(lowerQuery)
    )
  }, [])

  // AI Agent: Save document (create or update)
  const handleAgentSaveDocument = useCallback(async (
    path: string,
    content: string,
    category: DocumentCategory = 'outputs',
    mode: 'overwrite' | 'append' = 'overwrite',
    sessionId?: string
  ): Promise<{ id: string; name: string }> => {
    // Determine content type from path extension
    const getContentType = (name: string): ContentType => {
      if (name.endsWith('.json')) return 'json'
      if (name.endsWith('.csv')) return 'csv'
      if (name.endsWith('.j2') || name.endsWith('.jinja') || name.endsWith('.jinja2')) return 'jinja'
      if (name.endsWith('.md')) return 'markdown'
      if (name.endsWith('.conf') || name.endsWith('.cfg') || name.endsWith('.config')) return 'config'
      return 'text'
    }

    // Parse path for folder structure; when the AI gives no folder, use the
    // user-configured default folder for AI saves.
    const parts = path.split('/')
    const name = parts.pop() || path
    const parentFolder = parts.length > 0
      ? parts.join('/')
      : (resolveDocSaveTarget('aiAgentDefault').folder ?? null)

    // Check if document already exists with same name in category
    const existingDocs = await listDocuments(category, parentFolder || undefined)
    const existingDoc = existingDocs.find(d => d.name === name)

    if (existingDoc) {
      // Update existing document
      const newContent = mode === 'append'
        ? existingDoc.content + '\n' + content
        : content
      const updated = await updateDocument(existingDoc.id, { content: newContent })
      return { id: updated.id, name: updated.name }
    } else {
      // Create new document
      const doc = await createDocument({
        name,
        category,
        content_type: getContentType(name),
        content,
        parent_folder: parentFolder,
        session_id: sessionId,
      })
      return { id: doc.id, name: doc.name }
    }
  }, [])

  // AI Agent: Create MOP (Method of Procedure)
  const handleCreateMop = useCallback(async (params: {
    name: string;
    description?: string;
    session_ids: string[];
    pre_checks: Array<{ command: string; description?: string; expected_output?: string }>;
    changes: Array<{ command: string; description?: string }>;
    post_checks: Array<{ command: string; description?: string; expected_output?: string }>;
    rollback?: Array<{ command: string; description?: string }>;
  }): Promise<{ changeId: string; changeName: string }> => {
    // Build MOP steps array
    const mopSteps: MopStep[] = []
    let order = 0

    // Add pre-check steps
    for (const step of params.pre_checks) {
      const mopStep = createMopStep('pre_check', step.command, order++, step.description)
      if (step.expected_output) {
        mopStep.expected_output = step.expected_output
      }
      mopSteps.push(mopStep)
    }

    // Add change steps
    for (const step of params.changes) {
      mopSteps.push(createMopStep('change', step.command, order++, step.description))
    }

    // Add post-check steps
    for (const step of params.post_checks) {
      const mopStep = createMopStep('post_check', step.command, order++, step.description)
      if (step.expected_output) {
        mopStep.expected_output = step.expected_output
      }
      mopSteps.push(mopStep)
    }

    // Add rollback steps if provided
    if (params.rollback) {
      for (const step of params.rollback) {
        mopSteps.push(createMopStep('rollback', step.command, order++, step.description))
      }
    }

    // Create the change using the first session_id as the primary target
    // Note: In the future we may want to support multi-session MOPs
    const primarySessionId = params.session_ids[0]

    const change = await createChange({
      session_id: primarySessionId,
      name: params.name,
      description: params.description || `MOP for ${params.session_ids.length} device(s): ${params.name}`,
      mop_steps: mopSteps,
      created_by: 'AI Assistant',
    })

    // Show toast notification
    showToast(`MOP "${change.name}" created`, 'success')

    return {
      changeId: change.id,
      changeName: change.name,
    }
  }, [])

  // ============================================
  // Integration Handlers for AI Discovery (Phase 22)
  // ============================================

  // NetBox: Get neighbors for a device
  const handleNetBoxGetNeighbors = useCallback(async (sourceId: string, deviceId: number): Promise<NetBoxNeighbor[]> => {
    // Call through backend proxy endpoint (backend handles auth)
    const { data } = await getClient().http.get(`/netbox-sources/${sourceId}/devices/${deviceId}/neighbors`)
    return data.neighbors || []
  }, [])

  // Callback when AI updates a topology device - triggers refresh of TopologyTabEditor
  const handleTopologyDeviceUpdated = useCallback((topologyId: string) => {
    logger.log('[App] handleTopologyDeviceUpdated called with topologyId:', topologyId)
    setTopologyRefreshKeys(prev => {
      const newKey = (prev[topologyId] || 0) + 1
      logger.log('[App] Updating topologyRefreshKeys:', topologyId, '→', newKey)
      return {
        ...prev,
        [topologyId]: newKey
      }
    })
  }, [])

  // Register keyboard shortcut handlers
  useEffect(() => {
    keyboard.registerAction('newTerminal', createTerminal)
    keyboard.registerAction('closeTab', () => {
      if (activeTabId) closeTerminal(activeTabId)
    })
    keyboard.registerAction('commandPalette', () => setCommandPaletteOpen(true))
    keyboard.registerAction('toggleSidebar', () => setSidebarOpen(prev => !prev))
    keyboard.registerAction('settings', () => openSettingsTab())
    keyboard.registerAction('aiChat', () => {
      // If there's an active terminal tab, pass its name as context
      if (activeTabId) {
        const activeTab = tabs.find(t => t.id === activeTabId)
        if (activeTab && isTerminalTab(activeTab)) {
          handleOpenAIChatFromTerminal(activeTab.title)
          return
        }
      }
      // Otherwise just open without context
      setAiChatOpen(true)
      setAiExpandTrigger(t => t + 1) // Expand if collapsed
    })
    keyboard.registerAction('aiGenerateScript', () => setAiScriptGeneratorOpen(true))
    keyboard.registerAction('quickConnect', () => setQuickConnectOpen(true))
    keyboard.registerAction('connectSelectedSessions', () => {
      if (selectedSessionIds.length > 0) {
        handleBulkConnect(selectedSessionIds)
      }
    })
    // Save document shortcut
    keyboard.registerAction('saveDocument', handleSaveActiveDocument)
    // Troubleshooting session shortcut (Phase 26)
    keyboard.registerAction('startTroubleshooting', () => {
      if (isTroubleshootingActive) return
      setTroubleshootingDialogOpen(true)
    })
    // Tab navigation
    keyboard.registerAction('nextTab', () => {
      if (tabs.length < 2) return
      const currentIndex = tabs.findIndex(t => t.id === activeTabId)
      const nextIndex = (currentIndex + 1) % tabs.length
      setActiveTabId(tabs[nextIndex].id)
    })
    keyboard.registerAction('previousTab', () => {
      if (tabs.length < 2) return
      const currentIndex = tabs.findIndex(t => t.id === activeTabId)
      const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length
      setActiveTabId(tabs[prevIndex].id)
    })
    // Terminal-specific shortcuts
    keyboard.registerAction('toggleMultiSend', () => {
      if (activeTabId) toggleMultiSend(activeTabId)
    })
    keyboard.registerAction('reconnect', () => {
      // Emit reconnect event for the active terminal
      window.dispatchEvent(new CustomEvent('menu://reconnect'))
    })
    // Quick Look shortcuts
    keyboard.registerAction('quickLookNotes', () => {
      setActiveView('docs')
      setSidebarOpen(true)
    })
    keyboard.registerAction('quickLookTemplates', () => {
      setActiveView('docs')
      setSidebarOpen(true)
    })
    keyboard.registerAction('quickLookOutputs', () => {
      setActiveView('docs')
      setSidebarOpen(true)
    })
    keyboard.registerAction('scratchpadOpen', () => handleOpenScratchpad())

    return () => {
      keyboard.unregisterAction('newTerminal')
      keyboard.unregisterAction('closeTab')
      keyboard.unregisterAction('commandPalette')
      keyboard.unregisterAction('toggleSidebar')
      keyboard.unregisterAction('settings')
      keyboard.unregisterAction('aiChat')
      keyboard.unregisterAction('aiGenerateScript')
      keyboard.unregisterAction('quickConnect')
      keyboard.unregisterAction('connectSelectedSessions')
      keyboard.unregisterAction('saveDocument')
      keyboard.unregisterAction('startTroubleshooting')
      keyboard.unregisterAction('nextTab')
      keyboard.unregisterAction('previousTab')
      keyboard.unregisterAction('quickLookNotes')
      keyboard.unregisterAction('quickLookTemplates')
      keyboard.unregisterAction('quickLookOutputs')
      keyboard.unregisterAction('toggleMultiSend')
      keyboard.unregisterAction('reconnect')
      keyboard.unregisterAction('scratchpadOpen')
    }
  }, [keyboard, createTerminal, closeTerminal, activeTabId, tabs, selectedSessionIds, handleBulkConnect, handleSaveActiveDocument, handleOpenAIChatFromTerminal, isTroubleshootingActive])

  // ── Native menu commands ──────────────────────────────────────────
  // Every native-menu item is registered here as a Command so the
  // MenuBridge can dispatch it AND keep the menu item enabled/disabled
  // based on the ActiveContext. Right-click context menus and the
  // forthcoming Command Palette read from the same registry, so each
  // entry only needs to be defined once.

  // File ----------------------------------------------------------
  useCommand({
    id: 'file.new-session', label: 'New Session', category: 'file',
    accelerator: 'CmdOrCtrl+N',
    run: () => setQuickConnectOpen(true),
  })
  useCommand({
    id: 'file.new-terminal', label: 'New Terminal Tab', category: 'file',
    accelerator: 'CmdOrCtrl+T',
    run: () => createTerminal(),
  })
  useCommand({
    id: 'file.new-document', label: 'New Document', category: 'file',
    accelerator: 'CmdOrCtrl+Shift+N',
    run: () => handleNewDocument('notes'),
  })
  useCommand({
    id: 'file.quick-connect', label: 'Quick Connect…', category: 'file',
    accelerator: 'CmdOrCtrl+Shift+Q',
    run: () => setQuickConnectOpen(true),
  })
  useCommand({
    id: 'workspace.deployRemoteAgent',
    label: 'Deploy Remote Agent…',
    category: 'workspace',
    description: 'Deploy a remote agent to the active SSH server and open it as a workspace tab',
    // Enterprise mode is a thin shell — it must never deploy an agent.
    when: (ctx) => !ctx.isEnterprise && ctx.activeTabType === 'terminal' && ctx.terminalStatus === 'connected',
    run: () => setDeployAgentDialogOpen(true),
  })
  useCommand({
    id: 'workspace.openRemoteWindow',
    label: 'Open Remote Window…',
    category: 'workspace',
    description: 'Open a full NetStacks window connected to a remote agent on the active SSH server',
    // Enterprise mode is a thin shell — it must never deploy an agent.
    when: (ctx) => !ctx.isEnterprise && ctx.activeTabType === 'terminal' && ctx.terminalStatus === 'connected',
    run: async () => {
      const sessionId = activeTabSessionId
      if (!sessionId) return
      try {
        const { deployRemoteAgent, ensureRemoteCertTrusted } = await import('./api/remoteAgent')
        const result = await deployRemoteAgent(sessionId)
        await ensureRemoteCertTrusted(result)
        const params = `remoteAgentUrl=${encodeURIComponent(`https://${result.host}:${result.port}`)}&remoteAgentToken=${encodeURIComponent(result.auth_token)}`
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('open_new_window', { urlParams: params })
      } catch (err) {
        console.error('[App] Failed to open remote window:', err)
        showToast('Failed to open remote window: ' + (getErrorMessage(err, String(err))), 'error')
      }
    },
  })
  useCommand({
    id: 'file.save', label: 'Save', category: 'file',
    accelerator: 'CmdOrCtrl+S',
    // Enabled only when an editable tab is active. handleSaveActiveDocument
    // is itself a no-op for non-editable tab types, but greying out the
    // menu communicates that intentionally.
    when: (ctx) =>
      ctx.activeTabType === 'document' ||
      ctx.activeTabType === 'script' ||
      ctx.activeTabType === 'sftp-editor' ||
      ctx.activeTabType === 'mop',
    run: () => handleSaveActiveDocument(),
  })
  useCommand({
    id: 'file.close-tab', label: 'Close Tab', category: 'file',
    accelerator: 'CmdOrCtrl+W',
    when: (ctx) => ctx.activeTabId !== null,
    run: () => {
      if (activeTabId) closeTerminal(activeTabId)
    },
  })

  // App / global -------------------------------------------------
  useCommand({
    id: 'app.settings', label: 'Settings…', category: 'view',
    accelerator: 'CmdOrCtrl+,',
    run: () => openSettingsTab(),
  })

  // Edit ----------------------------------------------------------
  useCommand({
    id: 'edit.find', label: 'Find…', category: 'edit',
    accelerator: 'CmdOrCtrl+F',
    // Find dispatches a DOM event to the active terminal, so only
    // make sense when one is focused.
    when: (ctx) => ctx.activeTabType === 'terminal',
    run: () => {
      if (!activeTabId) return
      const el = document.querySelector(`[data-terminal-id="${activeTabId}"]`)
      el?.dispatchEvent(new CustomEvent('terminal-find', { bubbles: true }))
    },
  })

  // View ----------------------------------------------------------
  useCommand({
    id: 'view.command-palette', label: 'Command Palette…', category: 'view',
    accelerator: 'CmdOrCtrl+Shift+P',
    run: () => setCommandPaletteOpen(true),
  })
  useCommand({
    id: 'view.toggle-sidebar', label: 'Toggle Sidebar', category: 'view',
    accelerator: 'CmdOrCtrl+B',
    run: () => setSidebarOpen(prev => !prev),
  })
  useCommand({
    id: 'view.toggle-ai-panel', label: 'Toggle AI Panel', category: 'view',
    accelerator: 'CmdOrCtrl+I',
    run: () => setAiOverlordActive(prev => !prev),
  })
  useCommand({
    id: 'view.zoom-reset', label: 'Actual Size', category: 'view',
    accelerator: 'CmdOrCtrl+0',
    run: () => { document.body.style.zoom = '1' },
  })
  useCommand({
    id: 'view.zoom-in', label: 'Zoom In', category: 'view',
    accelerator: 'CmdOrCtrl+=',
    run: () => {
      const current = parseFloat(document.body.style.zoom || '1')
      document.body.style.zoom = String(Math.min(current + 0.1, 2))
    },
  })
  useCommand({
    id: 'view.zoom-out', label: 'Zoom Out', category: 'view',
    accelerator: 'CmdOrCtrl+-',
    run: () => {
      const current = parseFloat(document.body.style.zoom || '1')
      document.body.style.zoom = String(Math.max(current - 0.1, 0.5))
    },
  })

  // Session -------------------------------------------------------
  useCommand({
    id: 'session.reconnect', label: 'Reconnect', category: 'session',
    accelerator: 'CmdOrCtrl+Shift+R',
    // Reconnect only makes sense on a terminal that's in an
    // interruptible state. Greying it out for documents/topology is
    // the whole point of context-aware menus.
    when: (ctx) =>
      ctx.activeTabType === 'terminal' &&
      (ctx.terminalStatus === 'connected' ||
        ctx.terminalStatus === 'disconnected' ||
        ctx.terminalStatus === 'error'),
    run: () => {
      if (!activeTabId) return
      const el = document.querySelector(`[data-terminal-id="${activeTabId}"]`)
      el?.dispatchEvent(new CustomEvent('terminal-reconnect', { bubbles: true }))
    },
  })
  useCommand({
    id: 'session.toggle-multi-send', label: 'Toggle Multi-Send', category: 'session',
    accelerator: 'CmdOrCtrl+Shift+M',
    when: (ctx) => ctx.activeTabType === 'terminal',
    run: () => {
      if (activeTabId) toggleMultiSend(activeTabId)
    },
  })
  useCommand({
    id: 'session.connect-selected', label: 'Connect Selected Sessions', category: 'session',
    accelerator: 'CmdOrCtrl+Shift+Return',
    when: (ctx) => ctx.selectionCount > 0,
    run: () => {
      if (selectedSessionIds.length > 0) handleBulkConnect(selectedSessionIds)
    },
  })
  useCommand({
    id: 'session.start-troubleshooting', label: 'Start Troubleshooting…', category: 'session',
    accelerator: 'CmdOrCtrl+Shift+K',
    // Predicate doesn't read isTroubleshootingActive from context yet
    // (would require plumbing it through ActiveContext). For now the
    // dialog-open handler is the gate.
    run: () => {
      if (!isTroubleshootingActive) setTroubleshootingDialogOpen(true)
    },
  })

  // Window --------------------------------------------------------
  useCommand({
    id: 'window.next-tab', label: 'Show Next Tab', category: 'window',
    accelerator: 'CmdOrCtrl+Shift+]',
    // Disable when there's only one (or zero) tabs — there's nowhere
    // to navigate to.
    when: () => tabs.length > 1,
    run: () => {
      if (tabs.length > 1 && activeTabId) {
        const i = tabs.findIndex(t => t.id === activeTabId)
        setActiveTabId(tabs[(i + 1) % tabs.length].id)
      }
    },
  })
  useCommand({
    id: 'window.previous-tab', label: 'Show Previous Tab', category: 'window',
    accelerator: 'CmdOrCtrl+Shift+[',
    when: () => tabs.length > 1,
    run: () => {
      if (tabs.length > 1 && activeTabId) {
        const i = tabs.findIndex(t => t.id === activeTabId)
        setActiveTabId(tabs[(i - 1 + tabs.length) % tabs.length].id)
      }
    },
  })

  // Tools ---------------------------------------------------------
  // Each entry jumps to the corresponding Settings tab. openSettingsTab
  // already accepts an optional initial-tab arg.
  useCommand({
    id: 'tools.quick-actions', label: 'Quick Actions…', category: 'tools',
    run: () => openSettingsTab('quickCalls'),
  })
  useCommand({
    id: 'tools.snippets', label: 'Snippets…', category: 'tools',
    when: (ctx) => !ctx.isEnterprise,
    run: () => openSettingsTab('snippets'),
  })
  useCommand({
    id: 'tools.mapped-keys', label: 'Mapped Keys…', category: 'tools',
    run: () => openSettingsTab('mappedKeys'),
  })
  useCommand({
    id: 'tools.vault', label: 'Credential Vault…', category: 'tools',
    when: (ctx) => !ctx.isEnterprise,
    run: () => openSettingsTab('security'),
  })
  useCommand({
    id: 'tools.recordings', label: 'Recordings…', category: 'tools',
    when: (ctx) => !ctx.isEnterprise,
    run: () => openSettingsTab('recordings'),
  })
  useCommand({
    id: 'tools.layouts', label: 'Saved Layouts…', category: 'tools',
    when: (ctx) => !ctx.isEnterprise,
    run: () => openSettingsTab('layouts'),
  })
  useCommand({
    id: 'tools.session-logs', label: 'Session Logs…', category: 'tools',
    when: (ctx) => !ctx.isEnterprise,
    run: () => openSettingsTab('sessionLogs'),
  })
  useCommand({
    id: 'tools.host-keys', label: 'Trusted Host Keys…', category: 'tools',
    run: () => openSettingsTab('hostKeys'),
  })
  useCommand({
    id: 'tools.scratchpad', label: 'Scratchpad…', category: 'tools',
    description: 'Open a quick-notes scratchpad. Saves to the active workspace, or to Docs › Notes.',
    accelerator: 'CmdOrCtrl+Shift+J',
    run: () => handleOpenScratchpad(),
  })

  // AI ------------------------------------------------------------
  useCommand({
    id: 'ai.settings', label: 'AI Settings…', category: 'ai',
    run: () => openSettingsTab('ai'),
  })
  useCommand({
    id: 'ai.mcp-servers', label: 'MCP Servers…', category: 'ai',
    // McpServersSection is gated !isEnterprise — so is this command.
    when: (ctx) => !ctx.isEnterprise,
    run: () => openSettingsTab('ai'),
  })
  useCommand({
    id: 'ai.memory', label: 'AI Memory…', category: 'ai',
    run: () => openSettingsTab('ai'),
  })
  useCommand({
    id: 'ai.toggle-chat', label: 'Toggle AI Assistant', category: 'ai',
    accelerator: 'CmdOrCtrl+J',
    // Same target state as view.toggle-ai-panel — having both
    // surfaces is intentional ("AI" feels right for an AI menu).
    run: () => setAiOverlordActive(prev => !prev),
  })

  // Window — Tabs submenu -----------------------------------------
  useCommand({
    id: 'window.close-all-tabs', label: 'Close All Tabs', category: 'window',
    accelerator: 'CmdOrCtrl+Shift+W',
    when: () => tabs.length > 0,
    run: () => closeAllTabs(),
  })
  useCommand({
    id: 'window.close-tabs-right', label: 'Close Tabs to the Right', category: 'window',
    // Needs an active tab AND at least one tab to its right.
    when: () => {
      if (!activeTabId) return false
      const i = tabs.findIndex(t => t.id === activeTabId)
      return i >= 0 && i < tabs.length - 1
    },
    run: () => {
      if (activeTabId) closeTabsToRight(activeTabId)
    },
  })
  useCommand({
    id: 'window.reopen-closed-tab', label: 'Reopen Closed Tab', category: 'window',
    accelerator: 'CmdOrCtrl+Shift+T',
    when: () => closedTabs.length > 0,
    run: () => { void reopenLastClosedTab() },
  })

  // Navigation — Cmd+1..9 jumps to the Nth tab. Standard browser /
  // terminal-emulator convention; these don't appear in the native menu
  // (would clutter Window) but they're available via Palette and the
  // global keyboard accelerator.
  useCommand({
    id: 'navigation.go-to-tab-1', label: 'Go to Tab 1', category: 'navigation',
    accelerator: 'CmdOrCtrl+1',
    when: () => tabs.length >= 1,
    run: () => { if (tabs[0]) setActiveTabId(tabs[0].id) },
  })
  useCommand({
    id: 'navigation.go-to-tab-2', label: 'Go to Tab 2', category: 'navigation',
    accelerator: 'CmdOrCtrl+2',
    when: () => tabs.length >= 2,
    run: () => { if (tabs[1]) setActiveTabId(tabs[1].id) },
  })
  useCommand({
    id: 'navigation.go-to-tab-3', label: 'Go to Tab 3', category: 'navigation',
    accelerator: 'CmdOrCtrl+3',
    when: () => tabs.length >= 3,
    run: () => { if (tabs[2]) setActiveTabId(tabs[2].id) },
  })
  useCommand({
    id: 'navigation.go-to-tab-4', label: 'Go to Tab 4', category: 'navigation',
    accelerator: 'CmdOrCtrl+4',
    when: () => tabs.length >= 4,
    run: () => { if (tabs[3]) setActiveTabId(tabs[3].id) },
  })
  useCommand({
    id: 'navigation.go-to-tab-5', label: 'Go to Tab 5', category: 'navigation',
    accelerator: 'CmdOrCtrl+5',
    when: () => tabs.length >= 5,
    run: () => { if (tabs[4]) setActiveTabId(tabs[4].id) },
  })
  useCommand({
    id: 'navigation.go-to-tab-6', label: 'Go to Tab 6', category: 'navigation',
    accelerator: 'CmdOrCtrl+6',
    when: () => tabs.length >= 6,
    run: () => { if (tabs[5]) setActiveTabId(tabs[5].id) },
  })
  useCommand({
    id: 'navigation.go-to-tab-7', label: 'Go to Tab 7', category: 'navigation',
    accelerator: 'CmdOrCtrl+7',
    when: () => tabs.length >= 7,
    run: () => { if (tabs[6]) setActiveTabId(tabs[6].id) },
  })
  useCommand({
    id: 'navigation.go-to-tab-8', label: 'Go to Tab 8', category: 'navigation',
    accelerator: 'CmdOrCtrl+8',
    when: () => tabs.length >= 8,
    run: () => { if (tabs[7]) setActiveTabId(tabs[7].id) },
  })
  useCommand({
    id: 'navigation.go-to-last-tab', label: 'Go to Last Tab', category: 'navigation',
    accelerator: 'CmdOrCtrl+9',
    when: () => tabs.length > 0,
    run: () => { if (tabs.length > 0) setActiveTabId(tabs[tabs.length - 1].id) },
  })

  // Global keydown listener for Cmd/Ctrl+1..9. The accelerator field on
  // each command above is display-only; the actual key binding lives
  // here because these commands are intentionally excluded from the
  // native menu (would clutter Window).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (!/^[1-9]$/.test(e.key)) return
      // Skip when typing in inputs/textareas/contenteditable so users
      // can still type digits in form fields with no modifier conflicts.
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return
      const id = e.key === '9' ? 'navigation.go-to-last-tab' : `navigation.go-to-tab-${e.key}`
      e.preventDefault()
      void dispatchCommand(id, getActiveContext())
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Sidebar view switchers — equivalents to clicking the activity bar.
  // Available from the Palette so users can keyboard-navigate the app
  // without leaving home row.
  useCommand({
    id: 'navigation.view-sessions', label: isEnterprise ? 'Show Devices' : 'Show Sessions',
    category: 'navigation',
    run: () => { setActiveView('sessions'); setSidebarOpen(true) },
  })
  useCommand({
    id: 'navigation.view-topology', label: 'Show Topology', category: 'navigation',
    run: () => { setActiveView('topology'); setSidebarOpen(true) },
  })
  useCommand({
    id: 'navigation.view-docs', label: 'Show Documents', category: 'navigation',
    run: () => { setActiveView('docs'); setSidebarOpen(true) },
  })
  useCommand({
    id: 'navigation.view-changes', label: 'Show MOPs', category: 'navigation',
    run: () => { setActiveView('changes'); setSidebarOpen(true) },
  })
  useCommand({
    id: 'navigation.view-agents', label: 'Show Agents', category: 'navigation',
    run: () => { setActiveView('agents'); setSidebarOpen(true) },
  })
  useCommand({
    id: 'navigation.view-workspaces', label: 'Show Workspaces', category: 'navigation',
    run: () => { setActiveView('workspaces'); setSidebarOpen(true) },
  })

  // Help ----------------------------------------------------------
  useCommand({
    id: 'help.docs', label: 'NetStacks Documentation', category: 'help',
    run: async () => {
      try {
        const { open } = await import('@tauri-apps/plugin-shell')
        await open('https://www.netstacks.net/docs')
      } catch {
        window.open('https://www.netstacks.net/docs', '_blank', 'noopener,noreferrer')
      }
    },
  })
  useCommand({
    id: 'help.about', label: 'About NetStacks', category: 'help',
    run: () => setShowAbout(true),
  })

  // Default context menu for areas without custom context menus
  // Child components with their own context menus call stopPropagation() so this only fires
  // for areas that don't have custom handlers (text content, empty areas, etc.)
  const handleGlobalContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()

    const target = e.target as HTMLElement

    // Skip areas that have their own context menus via native event listeners
    // (these don't call React stopPropagation, so the event still reaches here)
    if (target.closest('.xterm')) return
    if (target.closest('.topology-canvas-container')) return
    if (target.closest('.topology-3d-canvas')) return

    // Build default context menu items based on what's selected/focused
    const selection = window.getSelection()?.toString() || ''
    const isEditable = target instanceof HTMLInputElement ||
                       target instanceof HTMLTextAreaElement ||
                       target.isContentEditable

    const items: MenuItem[] = []

    if (isEditable && selection) {
      items.push({
        id: 'default-cut',
        label: 'Cut',
        shortcut: '\u2318X',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>,
        action: () => {
          navigator.clipboard.writeText(selection).catch(() => {})
          document.execCommand('delete')
        }
      })
    }

    if (selection) {
      items.push({
        id: 'default-copy',
        label: 'Copy',
        shortcut: '\u2318C',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
        action: () => {
          navigator.clipboard.writeText(selection).catch(() => {})
        }
      })
    }

    if (isEditable) {
      items.push({
        id: 'default-paste',
        label: 'Paste',
        shortcut: '\u2318V',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>,
        action: () => {
          navigator.clipboard.readText().then(text => {
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
              const start = target.selectionStart ?? target.value.length
              const end = target.selectionEnd ?? start
              target.setRangeText(text, start, end, 'end')
              target.dispatchEvent(new Event('input', { bubbles: true }))
            } else {
              document.execCommand('insertText', false, text)
            }
          }).catch(() => {})
        }
      })
    }

    if (items.length > 0 && !isEditable) {
      // Add divider before Select All when we have Copy but no editable items
      items.push({ id: 'default-divider', label: '', divider: true, action: () => {} })
    }

    if (isEditable) {
      if (items.length > 0) {
        items.push({ id: 'default-divider', label: '', divider: true, action: () => {} })
      }
      items.push({
        id: 'default-select-all',
        label: 'Select All',
        shortcut: '\u2318A',
        action: () => {
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            target.select()
          } else {
            document.execCommand('selectAll')
          }
        }
      })
    } else if (selection || target.closest('[class*="message"]') || target.closest('[class*="content"]') || target.closest('.sidebar-content') || target.closest('.welcome')) {
      // Show Select All for text content areas even if nothing selected yet
      items.push({
        id: 'default-select-all',
        label: 'Select All',
        shortcut: '\u2318A',
        action: () => {
          document.execCommand('selectAll')
        }
      })
    }

    if (items.length > 0) {
      setDefaultContextMenuPosition({ x: e.clientX, y: e.clientY })
      setDefaultContextMenuItems(items)
    }
  }, [])

  // Helper to render a single tab's content (Phase 25: Split View support)
  const renderTabContent = useCallback((tab: Tab) => {
    if (isTerminalTab(tab)) {
      return (
        <Terminal
          ref={(handle) => {
            if (handle) {
              terminalRefs.current.set(tab.id, handle)
            } else {
              terminalRefs.current.delete(tab.id)
            }
          }}
          id={tab.id}
          sessionId={tab.sessionId}
          protocol={tab.protocol}
          sessionName={tab.title}
          cliFlavor={tab.cliFlavor}
          terminalTheme={tab.terminalTheme}
          fontSize={tab.fontSize}
          fontFamily={tab.fontFamily}
          onClose={() => closeTerminal(tab.id)}
          onAIAction={handleTerminalAIAction}
          onAIFloatingChat={handleTerminalAIFloatingChat}
          onForceClick={handleTerminalForceClick}
          onSessionSettings={tab.sessionId ? async () => {
            try {
              const allSessions = await listSessions()
              const session = allSessions.find(s => s.id === tab.sessionId)
              if (session) {
                setSessionSettingsSession(session)
              }
            } catch (err) {
              console.error('Failed to fetch session for settings:', err)
            }
          } : undefined}
          onStatusChange={(status) => updateTerminalStatus(tab.id, status)}
          onBroadcast={broadcast}
          onRegisterBroadcastListener={registerListener}
          onVisualizeTraceroute={handleVisualizeTraceroute}
          // Troubleshooting session capture (Phase 26)
          onTroubleshootingCapture={handleTroubleshootingCapture}
          isTroubleshootingActive={isTroubleshootingActive && isTroubleshootingCapturing(tab.id)}
          enterpriseProfileId={tab.enterpriseProfileId}
          enterpriseSessionDefinitionId={tab.enterpriseSessionDefinitionId}
          enterpriseTargetHost={tab.enterpriseTargetHost}
          enterpriseTargetPort={tab.enterpriseTargetPort}
          isJumpbox={tab.isJumpbox}
          onEnterpriseSessionId={(sid) => updateTabSessionId(tab.id, sid)}
          aiOverlordActive={aiOverlordActive}
          onOverlordAnnotationClick={(reason, text, highlightType) => {
            // Open AI side panel with context about this finding
            const prompt = `I'm looking at my terminal output and AI Overlord flagged something:\n\n**${highlightType.toUpperCase()}**: ${reason}\n\nThe flagged text was: \`${text}\`\n\nCan you explain this in more detail and suggest what I should do?`
            setAiExternalPrompt({ prompt, counter: Date.now() })
            setAiChatOpen(true)
            if (aiPanelCollapsed) {
              setAiPanelCollapsed(false)
              setAiExpandTrigger(prev => prev + 1)
            }
          }}
        />
      )
    } else if (isTopologyTab(tab) && (tab.topologyId || tab.temporaryTopology)) {
      return (
        <TopologyTabEditor
          topologyId={tab.topologyId}
          initialTopology={tab.temporaryTopology}
          isTemporary={tab.isTemporaryTopology}
          onDeviceDoubleClick={handleTopologyDeviceDoubleClick}
          onDeviceContextMenu={handleDeviceContextMenu}
          onDiscussTopologyWithAI={handleDiscussTopologyWithAI}
          onAskAIAboutElement={handleAskAIAboutElement}
          onAIDiscover={handleAIDiscover}
          onSaveTopology={(savedTopology) => handleSaveTopology(tab.id, savedTopology)}
          onOpenDeviceDetailTab={handleOpenDeviceDetailTab}
          onOpenLinkDetailTab={handleOpenLinkDetailTab}
          onSaveDeviceToDocs={handleSaveDeviceToDocs}
          onSaveLinkToDocs={handleSaveLinkToDocs}
          refreshKey={tab.topologyId ? topologyRefreshKeys[tab.topologyId] : undefined}
        />
      )
    } else if (isDocumentTab(tab) && tab.unsavedDoc) {
      return (
        <UnsavedDocumentTab
          tabId={tab.id}
          unsavedDoc={tab.unsavedDoc}
          onSave={handleUnsavedDocSave}
        />
      )
    } else if (isDocumentTab(tab) && tab.documentId && documentCache[tab.documentId]) {
      return (
        <DocumentTabEditor
          document={documentCache[tab.documentId]}
          tabId={tab.id}
          onSave={(content) => handleDocumentSave(tab.id, tab.documentId!, content)}
          onModified={(isModified) => handleDocumentModified(tab.id, isModified)}
        />
      )
    } else if (tab.type === 'agent-run' && tab.agentTaskId) {
      return (
        <AgentRunTab
          taskId={tab.agentTaskId}
          onOpenArtifact={handleOpenAgentArtifact}
          onContinueChat={(seed) => handleContinueAgentInChat(tab.id, seed)}
          onOpenRun={(id) => {
            const t = useAgentTasksStore.getState().tasks.find((x) => x.id === id)
            const title = (t?.delegation_label || t?.prompt || 'Agent run')
            handleOpenAgentRunTab(id, title.length > 32 ? `${title.slice(0, 32)}…` : title)
          }}
        />
      )
    } else if (tab.type === 'ai-chat') {
      // Full chat-session tab — the AI side panel in 'tab' variant (same chat
      // engine: streaming, tool audits, history), with room to breathe.
      return (
        <AISidePanel
          variant="tab"
          isOpen
          onClose={() => {}}
          onPopOut={() => handlePopoutAIChat(tab.id)}
          onDockToPanel={() => handleDockChatToPanel(tab.id)}
          onPromptCapture={(prompt) => setTabs(prev => prev.map(t => (t.id === tab.id ? { ...t, chatPrompt: prompt } : t)))}
          onManagePrompts={handleManagePrompts}
          initialMessages={tab.aiChatSeed}
          availableSessions={availableSessions}
          onExecuteCommand={handleAgentExecuteCommand}
          getTerminalContext={handleAgentGetTerminalContext}
          liveContextDeps={liveContextDeps}
          onOpenSession={handleAgentOpenSession}
          onListDocuments={handleAgentListDocuments}
          onReadDocument={handleAgentReadDocument}
          onSearchDocuments={handleAgentSearchDocuments}
          onSaveDocument={handleAgentSaveDocument}
          onNetBoxGetNeighbors={handleNetBoxGetNeighbors}
          onTopologyDeviceUpdated={handleTopologyDeviceUpdated}
          topologyCallbacks={topologyAICallbacks}
          allowStructuralTopologyEdits={allowStructuralTopologyEdits}
          onCreateMop={handleCreateMop}
          onTroubleshootingCapture={handleTroubleshootingAICapture}
          isTroubleshootingActive={isTroubleshootingActive}
          captureAIConversations={captureAIConversations}
          onNavigateToBackup={(deviceId, deviceName) => openBackupHistoryTab(deviceId, deviceName)}
          onNavigateToDevice={(deviceId, deviceName) => {
            const existing = tabs.find(t => t.type === 'device-detail' && t.deviceName === deviceName)
            if (existing) {
              setActiveTabId(existing.id)
            } else {
              const newTab: Tab = {
                id: `device-detail-${deviceId}-${Date.now()}`,
                type: 'device-detail',
                title: deviceName,
                status: 'ready',
                deviceName,
              }
              setTabs(prev => [...prev, newTab])
              setActiveTabId(newTab.id)
            }
          }}
          onOpenTerminalSession={(deviceName) => {
            const session = tabs.find(t => isTerminalTab(t) && t.title === deviceName)
            if (session) setActiveTabId(session.id)
          }}
          onNavigateToMop={(mopId, mopName) => handleOpenMopTab(mopId, mopName)}
          onNavigateToTopology={(topologyName) => {
            const existing = tabs.find(t => t.type === 'topology' && t.title === topologyName)
            if (existing) setActiveTabId(existing.id)
          }}
          onNavigateToSettings={(t) => openSettingsTab(t as import('./components/SettingsPanel').SettingsTab | undefined)}
        />
      )
    } else if (tab.type === 'device-detail' && tab.deviceName) {
      // Device detail tab - shows full device enrichment.
      // Pull jump info from the device's session so SNMP queries route
      // through the configured bastion when the device sits behind one.
      const deviceSession = tab.deviceSessionId ? chipSessionsById.get(tab.deviceSessionId) : undefined;
      // Sessions are authoritative for SNMP IPs: if this device's name
      // matches a session whose hostname we've seen, use that session's
      // host even if the topology stored a stale CDP loopback IP.
      const resolvedHost = resolveSnmpHost(tab.deviceName, tab.deviceHost, deviceEnrichments, chipSessionsById);
      return (
        <DeviceDetailTab
          deviceName={tab.deviceName}
          device={tab.deviceData}
          sessionId={tab.deviceSessionId}
          host={resolvedHost}
          profileId={tab.deviceProfileId || profiles[0]?.id}
          jumpHostId={deviceSession?.jump_host_id ?? null}
          jumpSessionId={deviceSession?.jump_session_id ?? null}
          deviceId={tab.deviceId}
          enrichment={tab.deviceSessionId ? (() => {
            // Look up enrichment by matching sessionId field to tab's deviceSessionId
            for (const enrichment of deviceEnrichments.values()) {
              if (enrichment.sessionId === tab.deviceSessionId) return enrichment;
            }
            // Also try direct key lookup (enrichment may be keyed by sessionId)
            return deviceEnrichments.get(tab.deviceSessionId);
          })() : undefined}
          onOpenTerminal={tab.deviceSessionId ? () => {
            // Open terminal for the device's session
            const existingTerminal = tabs.find(t => isTerminalTab(t) && t.sessionId === tab.deviceSessionId)
            if (existingTerminal) {
              setActiveTabId(existingTerminal.id)
            } else {
              // Create new terminal tab - find session first
              listSessions().then(sessions => {
                const session = sessions.find(s => s.id === tab.deviceSessionId)
                if (session) {
                  const newId = `ssh-${session.id}-${Date.now()}`
                  const { fontSize, fontFamily, terminalTheme } = getEffectiveFontSettings(session)
                  const newTab: Tab = {
                    id: newId,
                    type: 'terminal',
                    title: session.name || session.host,
                    sessionId: session.id,
                    profileId: session.profile_id,
                    cliFlavor: (session.cli_flavor as Tab['cliFlavor']) || 'auto',
                    terminalTheme,
                    fontSize,
                    fontFamily,
                    color: session.color || undefined,
                    status: 'connecting',
                  }
                  setTabs(prev => [...prev, newTab])
                  setActiveTabId(newId)
                }
              })
            }
          } : undefined}
        />
      )
    } else if (tab.type === 'link-detail' && tab.connectionId) {
      // Link detail tab - shows side-by-side interface comparison.
      // Same session-IP-authoritative override as DeviceDetailTab: if the
      // source or target name matches a session whose hostname we've seen,
      // that session's host wins over CDP's potentially-loopback IP.
      const resolvedSourceHost = resolveSnmpHost(tab.sourceDeviceName, tab.sourceHost, deviceEnrichments, chipSessionsById);
      const resolvedTargetHost = resolveSnmpHost(tab.targetDeviceName, tab.targetHost, deviceEnrichments, chipSessionsById);
      return (
        <LinkDetailTab
          connectionId={tab.connectionId}
          sourceDeviceName={tab.sourceDeviceName || 'Unknown'}
          targetDeviceName={tab.targetDeviceName || 'Unknown'}
          linkEnrichment={getLinkEnrichment(tab.connectionId)}
          sourceHost={resolvedSourceHost}
          targetHost={resolvedTargetHost}
          profileId={tab.deviceProfileId || profiles[0]?.id}
          sourceInterfaceName={tab.sourceInterfaceName}
          targetInterfaceName={tab.targetInterfaceName}
        />
      )
    } else if (tab.type === 'sftp-editor' && tab.sftpConnectionId && tab.sftpFilePath) {
      return (
        <SftpEditorTab
          connectionId={tab.sftpConnectionId}
          filePath={tab.sftpFilePath}
          fileName={tab.sftpFileName || ''}
          deviceName={tab.sftpDeviceName || ''}
          onDirtyChange={(dirty) => {
            setTabs(prev => prev.map(t =>
              t.id === tab.id
                ? {
                    ...t,
                    sftpDirty: dirty,
                    title: dirty
                      ? `SFTP: ${tab.sftpDeviceName}:${tab.sftpFileName} *`
                      : `SFTP: ${tab.sftpDeviceName}:${tab.sftpFileName}`,
                  }
                : t
            ))
          }}
        />
      )
    } else if (isMopTab(tab)) {
      return (
        <MopWorkspace
          planId={tab.mopPlanId}
          executionId={tab.mopExecutionId}
          onTitleChange={(title) => {
            setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, title } : t))
          }}
          onDelete={() => closeTab(tab.id)}
          onOpenDocument={handleOpenDocument}
        />
      )
    } else if (isScriptTab(tab) && tab.scriptData) {
      return (
        <ScriptEditor
          ref={(handle) => {
            if (handle) {
              scriptEditorRefs.current.set(tab.id, handle)
            } else {
              scriptEditorRefs.current.delete(tab.id)
            }
          }}
          script={tab.scriptData}
          onSave={(updatedScript) => {
            setTabs(prev => prev.map(t =>
              t.id === tab.id
                ? { ...t, title: updatedScript.name, scriptId: updatedScript.id, scriptData: updatedScript }
                : t
            ))
          }}
        />
      )
    } else if (isSettingsTab(tab)) {
      return (
        <div className="settings-tab-content">
          <SettingsPanel initialTab={settingsInitialTab} onOpenApiResponseTab={handleOpenApiResponseTab} />
        </div>
      )
    } else if (tab.type === 'api-response' && tab.apiResponseData) {
      return (
        <ApiResponseTab
          title={tab.apiResponseTitle}
          data={tab.apiResponseData}
          statusCode={tab.apiResponseStatus}
          durationMs={tab.apiResponseDurationMs}
        />
      )
    } else if (tab.type === 'incident-detail') {
      return (
        <IncidentDetailTab
          incidentId={tab.incidentId}
          onOpenAlertTab={handleOpenAlertTab}
          onClose={() => closeTab(tab.id)}
          onTitleChange={(title) => setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, title } : t))}
          onCreated={(id, title) => updateTabFields(tab.id, { incidentId: id, title })}
        />
      )
    } else if (tab.type === 'alert-detail') {
      return (
        <AlertDetailTab
          alertId={tab.alertId!}
          onOpenIncidentTab={(id) => handleOpenIncidentTab(id)}
          onTitleChange={(title) => setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, title } : t))}
        />
      )
    } else if (tab.type === 'stack-detail' && tab.stackDetailTemplateId) {
      return (
        <StackDetailTab
          stackId={tab.stackDetailTemplateId}
          onOpenInstanceTab={handleOpenInstanceTab}
          onTitleChange={(title) => setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, title } : t))}
        />
      )
    } else if (tab.type === 'config-template') {
      return (
        <TemplateDetailTab
          templateId={tab.configTemplateId || ''}
          onTitleChange={(title) => setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, title } : t))}
          onDeleted={() => closeTab(tab.id)}
        />
      )
    } else if (tab.type === 'config-stack') {
      return (
        <StackDetailTab
          stackId={tab.configStackId || ''}
          onOpenInstanceTab={handleOpenInstanceTab}
          onOpenDeploymentTab={handleOpenDeploymentTab}
          onTitleChange={(title) => setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, title } : t))}
          onDeleted={() => closeTab(tab.id)}
        />
      )
    } else if (tab.type === 'config-instance') {
      return (
        <InstanceDetailTab
          instanceId={tab.configInstanceId}
          stackId={tab.configInstanceStackId}
          onTitleChange={(title) => setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, title } : t))}
          onDeleted={() => closeTab(tab.id)}
          onOpenDeploymentTab={handleOpenDeploymentTab}
          onOpenMopTab={(executionId, name) => {
            const tabId = `mop-exec-${executionId}`
            const existing = tabs.find(t => t.id === tabId)
            if (existing) { setActiveTabId(existing.id); return }
            const newTab: Tab = {
              id: tabId,
              type: 'mop' as TabType,
              title: name,
              status: 'ready' as DetailStatus,
              mopExecutionId: executionId,
            }
            setTabs(prev => [...prev, newTab])
            setActiveTabId(tabId)
          }}
        />
      )
    } else if (tab.type === 'config-deployment' && tab.configDeploymentId) {
      return (
        <DeploymentDetailTab
          deploymentId={tab.configDeploymentId}
          onTitleChange={(title) => setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, title } : t))}
        />
      )
    } else if (tab.type === 'workspace' && tab.workspaceConfig) {
      return (
        <WorkspaceTab
          config={tab.workspaceConfig}
          isActive={tab.id === activeTabId}
        />
      )
    } else if (tab.type === 'scratchpad') {
      return (
        <ScratchpadTab
          initialContent={tab.scratchpadInitialContent ?? ''}
          activeWorkspace={activeWsConfig}
          onClose={() => closeTerminal(tab.id)}
        />
      )
    } else if (tab.type === 'backup-history') {
      return (
        <BackupHistoryTab
          deviceId={tab.backupDeviceId!}
          deviceName={tab.deviceName || 'Device'}
          onAskAI={(question, context) => {
            // Open AI panel with the question pre-filled. Attach the config +
            // operator-notes context so the assistant can reason about the
            // exact backup the user selected (not just the question text).
            if (aiPanelCollapsed) setAiPanelCollapsed(false)
            const content = context ? `${question}\n\n---\n${context}` : question
            setAiPanelInitialMessages([{ id: `msg_${Date.now()}`, type: 'user', content, timestamp: new Date() }])
          }}
        />
      )
    } else {
      return (
        <div className="document-tab-content">
          <div className="document-tab-placeholder">
            <span className="document-tab-placeholder-icon">
              {getDocumentIcon(tab.documentCategory)}
            </span>
            <h2>Loading...</h2>
            <p>Loading document content...</p>
          </div>
        </div>
      )
    }
  }, [closeTerminal, handleTerminalAIAction, handleTerminalAIFloatingChat, handleTerminalForceClick, updateTerminalStatus, updateTabSessionId, broadcast, registerListener, handleVisualizeTraceroute, handleTopologyDeviceDoubleClick, handleDeviceContextMenu, handleAIDiscover, handleSaveTopology, handleOpenDeviceDetailTab, handleOpenLinkDetailTab, handleSaveDeviceToDocs, handleSaveLinkToDocs, documentCache, handleDocumentSave, handleDocumentModified, tabs, topologyRefreshKeys, deviceEnrichments, getLinkEnrichment, profiles, isTroubleshootingActive, isTroubleshootingCapturing, handleTroubleshootingCapture, aiOverlordActive])

  // ── CommandRegistry: keep ActiveContext in sync with React state ──
  // Tracks active tab type + connection status + sidebar view + enterprise
  // mode so registered Commands can gate themselves via `when` predicates.
  // Runs whenever any of these inputs change; the store does its own
  // shallow-equality check before notifying subscribers, so a no-op
  // setContext call is cheap.
  useEffect(() => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    const next: ActiveContext = {
      activeTabType: (activeTab?.type ?? null) as ActiveContext['activeTabType'],
      activeTabId: activeTabId ?? null,
      terminalStatus: activeTab?.type === 'terminal'
        ? (activeTab.status as ActiveContext['terminalStatus']) ?? null
        : null,
      // Per-tab dirty state isn't tracked in App.tsx yet — surfaces that
      // own dirty state (DocumentTabEditor, MopWorkspace, ScriptEditor)
      // will overwrite this via setContext when they mount/update.
      isDirty: false,
      activeSidebarView: activeView,
      // Sessions panel selection (drives e.g. session.connect-selected).
      // Other sidebar panels with their own selection state will need to
      // push to ActiveContext directly when their commands depend on it.
      selectionCount: selectedSessionIds.length,
      isEnterprise,
    }
    useActiveContextStore.getState().setContext(next)
  }, [activeTabId, tabs, activeView, isEnterprise, selectedSessionIds])

  return (
    <AuthProvider>
      <div className="app" onContextMenu={handleGlobalContextMenu}>
        {/* CommandRegistry ↔ native menu bridge. Mounted at the root so
            it stays alive for the whole session. Doesn't render anything. */}
        <MenuBridge />
        <TopBar
          platform={platform}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(o => !o)}
          aiPanelOpen={!aiPanelCollapsed && aiChatOpen}
          onToggleAiPanel={() => { if (!aiPanelCollapsed && aiChatOpen) { setAiChatOpen(false) } else { setAiChatOpen(true); setAiPanelCollapsed(false) } }}
          onOpenCommandCenter={() => setCommandPaletteOpen(true)}
          menuSlot={platform === 'macos' ? undefined : <MenuBar />}
          windowControlsSlot={platform === 'macos' ? undefined : <WindowControls />}
        />
        <div className="app-body" data-testid="app-body">
        {/* Activity Bar */}
        <div className="activity-bar" data-testid="activity-bar">
          <div className="activity-bar-top" {...titleBarDragProps}>
            {showSessionsTab && (
            <button
              className={`activity-bar-item ${activeView === 'sessions' ? 'active' : ''}`}
              onClick={() => handleActivityClick('sessions')}
              title="Sessions" data-testid="nav-sessions"
            >
              {Icons.sessions}
            </button>
            )}
            {canTopology && (
            <button
              className={`activity-bar-item ${activeView === 'topology' ? 'active' : ''}`}
              onClick={() => handleActivityClick('topology')}
              title="Network Topology" data-testid="nav-topology"
            >
              {Icons.topology}
            </button>
            )}
            {canDocs && (
            <button
              className={`activity-bar-item ${activeView === 'docs' ? 'active' : ''}`}
              onClick={() => handleActivityClick('docs')}
              title="Documents" data-testid="nav-docs"
            >
              {Icons.docs}
            </button>
            )}
            {canChanges && showChangesTab && (
            <button
              className={`activity-bar-item ${activeView === 'changes' ? 'active' : ''}`}
              onClick={() => handleActivityClick('changes')}
              title="Changes" data-testid="nav-changes"
            >
              {Icons.changes}
            </button>
            )}
            {canAgents && showAgentsTab && (
              <button
                className={`activity-bar-item ${activeView === 'agents' ? 'active' : ''}`}
                onClick={() => handleActivityClick('agents')}
                title="Agents" data-testid="nav-agents"
              >
                {Icons.agents}
              </button>
            )}
            {canStacks && (
              <button
                className={`activity-bar-item ${activeView === 'stacks' ? 'active' : ''}`}
                onClick={() => handleActivityClick('stacks')}
                title="Stacks"
              >
                {Icons.stacks}
              </button>
            )}
            {allPluginPanels.length > 0 && allPluginPanels.map((pp) => {
              const viewId = `plugin:${pp.pluginName}:${pp.panel.id}`
              return (
                <button
                  key={viewId}
                  className={`activity-bar-item ${activeView === viewId ? 'active' : ''}`}
                  onClick={() => handleActivityClick(viewId as ViewType)}
                  title={pp.panel.label}
                >
                  {pp.panel.icon && pluginIconMap[pp.panel.icon] ? pluginIconMap[pp.panel.icon] : defaultPluginIcon}
                </button>
              )
            })}
            {sftpConnectionCount > 0 && (
              <button
                className={`activity-bar-item ${activeView === 'sftp' ? 'active' : ''}`}
                onClick={() => handleActivityClick('sftp' as ViewType)}
                title={`SFTP Browser (${sftpConnectionCount})`}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" width="24" height="24">
                  <path d="M14.5 3H7.71l-.85-.85A.5.5 0 006.5 2h-5a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-10a.5.5 0 00-.5-.5z" />
                </svg>
              </button>
            )}
            <button
              className={`activity-bar-item ${activeView === 'workspaces' ? 'active' : ''}`}
              onClick={() => handleActivityClick('workspaces')}
              title="Workspaces"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="24" height="24">
                <path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H13L11 5H5C3.89543 5 3 5.89543 3 7Z" />
                <path d="M12 11V17M9 14H15" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="activity-bar-bottom">
            <button
              className="activity-bar-item"
              onClick={() => openSettingsTab()}
              title={`Settings (${displayShortcut('Cmd+,')})`} data-testid="nav-settings"
            >
              {Icons.settings}
            </button>
          </div>
        </div>

        {/* Sidebar */}
        <div
          className={`sidebar ${!sidebarOpen ? 'collapsed' : ''} ${sidebarOverlay ? 'overlay' : ''}`}
          style={{ width: sidebarOpen ? sidebarWidth : 0 }}
        >
          <div className="sidebar-header">
            <span>{getSidebarTitle()}</span>
            <span className="sidebar-header-extras" ref={sidebarHeaderExtrasRef} />
            <button
              className={`sidebar-pin-btn ${sidebarPinned ? 'pinned' : ''}`}
              onClick={() => {
                // P1-2: persist via savePanelSettings so the value
                // survives reload. Previously only local state flipped,
                // and reload restored the old setting from disk.
                const next = !sidebarPinned
                setSidebarPinned(next)
                savePanelSettings({ ...loadPanelSettings(), leftSidebarPinned: next })
              }}
              title={sidebarPinned ? 'Unpin sidebar (auto-collapse)' : 'Pin sidebar (stay open)'}
            >
              {sidebarPinned ? Icons.pin : Icons.pinOff}
            </button>
          </div>
          <div className="sidebar-content">
            {activeView === 'sessions' && !isEnterprise && (
              <SessionPanel
                onConnect={handleSSHConnect}
                onOpenLocalShell={createTerminal}
                onBulkConnect={handleBulkConnect}
                onDisconnect={(sessionIds) => {
                  const ids = new Set(sessionIds);
                  // Close every connected terminal tab whose session matches.
                  tabs
                    .filter(t => isTerminalTab(t) && t.status === 'connected' && t.sessionId && ids.has(t.sessionId))
                    .forEach(t => closeTab(t.id, true));
                }}
                connectedSessionIds={
                  new Set(
                    tabs
                      .filter(t => isTerminalTab(t) && t.status === 'connected' && t.sessionId)
                      .map(t => t.sessionId!),
                  )
                }
                onSelectionChange={handleSelectionChange}
                onSessionUpdated={handleSessionUpdated}
                externalSessionUpdate={externalSessionUpdate}
                liveGroupId={liveGroupId}
                groupsRefreshKey={groupsRefreshKey}
                onLaunchGroup={handleLaunchGroup}
                onSaveCurrentAsGroup={handleSaveCurrentAsGroup}
                onTabDroppedOnGroup={handleTabDroppedOnGroup}
                onDiscoverTopology={handleDiscoverTopologyForSavedGroup}
                onOpenTopology={handleOpenTopologyTab}
                getTabTitle={getTabTitleForChip}
                onOpenRemoteWindow={async (sessionId) => {
                  setRemoteWindowDeploying(true)
                  try {
                    const { deployRemoteAgent, ensureRemoteCertTrusted } = await import('./api/remoteAgent')
                    const result = await deployRemoteAgent(sessionId)
                    await ensureRemoteCertTrusted(result)
                    const params = `remoteAgentUrl=${encodeURIComponent(`https://${result.host}:${result.port}`)}&remoteAgentToken=${encodeURIComponent(result.auth_token)}`
                    const { invoke } = await import('@tauri-apps/api/core')
                    await invoke('open_new_window', { urlParams: params })
                  } catch (err) {
                    console.error('[App] Failed to open remote window:', err)
                    const detail = (err as any)?.response?.data?.error || (getErrorMessage(err, String(err)))
                    showToast('Failed to open remote window: ' + detail, 'error')
                  } finally {
                    setRemoteWindowDeploying(false)
                  }
                }}
              />
            )}
            {activeView === 'sessions' && isEnterprise && (
              <EnterpriseDevicePanel
                onDeviceConnect={handleDeviceConnect}
                onDeviceQuickConnect={handleDeviceQuickConnect}
                onViewLatestBackup={(device) => openBackupHistoryTab(device.id, device.name)}
                onOpenBackupHistory={(device) => openBackupHistoryTab(device.id, device.name)}
                headerTarget={sidebarHeaderExtrasRef.current}
              />
            )}
            {activeView === 'topology' && (
              <TopologyPanel
                selectedDeviceId={selectedDeviceId}
                onDeviceSelect={handleTopologyDeviceSelect}
                onDeviceConnect={handleOpenDeviceTerminal}
                onOpenTopology={handleOpenTopology}
                onOpenTracerouteTopology={handleOpenTracerouteTopology}
                onStartDiscovery={handleStartDiscoveryFromPanel}
                connectedSessionIds={tabs
                  .filter(tab => isTerminalTab(tab) && tab.status === 'connected' && tab.sessionId)
                  .map(tab => tab.sessionId!)
                }
              />
            )}
            {activeView === 'docs' && (
              <DocsPanel
                onOpenDocument={handleOpenDocument}
                onNewDocument={handleNewDocument}
              />
            )}
            {activeView === 'changes' && (
              <ChangesPanel onOpenMopTab={handleOpenMopTab} />
            )}
            {canAgents && activeView === 'agents' && (
              <AgentsPanel onOpenAgentRun={handleOpenAgentRunTab} />
            )}
            {activeView === 'stacks' && canStacks && (
              <ConfigPanel onOpenTemplateTab={handleOpenConfigTemplateTab} onOpenStackTab={handleOpenConfigStackTab} onOpenInstanceTab={handleOpenInstanceTab} onCreateTemplate={handleCreateConfigTemplate} onCreateStack={handleCreateConfigStack} />
            )}
            {activeView === 'workspaces' && (
              <WorkspacesPanel
                onOpenWorkspace={openWorkspaceTab}
                onNewWorkspace={() => setShowNewWorkspace(true)}
                openWorkspaceIds={new Set(tabs.filter(t => t.type === 'workspace' && t.workspaceConfig).map(t => t.workspaceConfig!.id))}
                onCloseWorkspace={(id) => {
                  // Close the open workspace tab WITHOUT touching the saved
                  // config (delete on a separate path).
                  tabs
                    .filter(t => t.type === 'workspace' && t.workspaceConfig?.id === id)
                    .forEach(t => closeTab(t.id, true));
                }}
                onOpenScript={handleOpenScript}
                onNewScript={handleNewScript}
                onAIGenerate={() => setAiScriptGeneratorOpen(true)}
              />
            )}
            {activeView === 'sftp' && (
              <SftpPanel onOpenFile={handleSftpOpenFile} />
            )}
            {activeView === 'plugin:incidents:incident-list' && (
              <IncidentsPanel onOpenIncidentTab={handleOpenIncidentTab} />
            )}
            {activeView === 'plugin:alerts:alert-list' && (
              <AlertsPanel onOpenAlertTab={handleOpenAlertTab} />
            )}
            {activeView === 'plugin:profiling-agents:profiling-agents-list' && !profilingChatAgent && (
              <ProfilingAgentsPanel
                onOpenChat={(id, name) => setProfilingChatAgent({ id, name })}
                onOpenConfig={() => {}}
              />
            )}
            {activeView === 'plugin:profiling-agents:profiling-agents-list' && profilingChatAgent && (
              <ProfilingAgentChat
                agentId={profilingChatAgent.id}
                agentName={profilingChatAgent.name}
                onBack={() => setProfilingChatAgent(null)}
              />
            )}
            {pluginPanels.map((pp) => {
              const viewId = `plugin:${pp.pluginName}:${pp.panel.id}`
              return activeView === viewId ? (
                <PluginPanel
                  key={viewId}
                  pluginName={pp.pluginName}
                  panelId={pp.panel.id}
                  label={pp.panel.label}
                  dataEndpoint={pp.panel.data_endpoint}
                  columns={pp.panel.columns}
                  actions={pp.panel.actions}
                  refreshIntervalSeconds={pp.panel.refresh_interval_seconds}
                />
              ) : null
            })}
          </div>
          {/* Resize handle */}
          {sidebarOpen && (
            <div
              className="sidebar-resize-handle"
              onMouseDown={startResizing}
            />
          )}
        </div>

        {/* Main Area - Always shows tabs (terminals, documents, topologies) */}
        <div className="main-area" data-testid="main-area" onClick={handleMainAreaClick}>
          {/* Tab Bar */}
              {tabs.length > 0 && (
                <div className="tab-bar" data-testid="tab-bar" {...titleBarDragProps}>
                  {/* Combined split tab when split view is active */}
                  {splitTabs.length >= 2 && (() => {
                    const splitTabObjects = splitTabs.map(id => tabs.find(t => t.id === id)).filter((t): t is Tab => t !== undefined)
                    const combinedTitle = splitTabObjects.map(t => t.title).join(' | ')
                    const isSplitActive = splitTabs.includes(activeTabId || '')
                    return (
                      <div
                        key="split-combined-tab"
                        role="button"
                        tabIndex={0}
                        className={`tab tab-type-split tab-split-combined ${isSplitActive ? 'active' : ''}`}
                        onClick={() => {
                          // Click on combined tab makes the first split tab active
                          if (splitTabs.length > 0) {
                            setActiveTabId(splitTabs[0])
                          }
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setActiveTabId(splitTabs[0]) }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          // Use the first split tab for context menu (or could show split-wide menu)
                          setSplitContextMenuPosition({ x: e.clientX, y: e.clientY })
                          setSplitContextMenuTabId(splitTabs[0])
                        }}
                      >
                        <span className="tab-icon tab-icon-split" title="Split View">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <line x1="12" y1="3" x2="12" y2="21" />
                          </svg>
                        </span>
                        <span className="tab-status-indicator" />
                        <span className="tab-title">{combinedTitle}</span>
                        <button
                          className="tab-close"
                          onClick={(e) => {
                            e.stopPropagation()
                            // Exit split view - revert to first tab only
                            setSplitTabs([])
                            if (splitTabs.length > 0) {
                              setActiveTabId(splitTabs[0])
                            }
                          }}
                          title="Exit split view"
                        >
                          ×
                        </button>
                      </div>
                    )
                  })()}
                  {/* Regular tabs (hide tabs that are in split view) */}
                  {tabs.filter(tab => !splitTabs.includes(tab.id)).map(tab => (
                    <div
                      key={tab.id}
                      role="button"
                      tabIndex={0}
                      data-tab-id={tab.id}
                      title={tab.type === 'ai-chat' ? (tab.chatPrompt || 'New chat — send a message to start') : tab.title}
                      className={`tab tab-type-${tab.type} tab-status-${tab.status} ${activeTabId === tab.id ? 'active' : ''} ${isTabSelected(tab.id) ? 'tab-selected' : ''} ${draggingTabId === tab.id ? 'dragging' : ''} ${tabReorderDropTarget?.tabId === tab.id ? `tab-reorder-${tabReorderDropTarget.side}` : ''} ${tab.sessionId && sharedSessions.has(tab.sessionId) ? 'tab-sharing' : ''}`}
                      onClick={(e) => {
                        // Don't trigger click if we were dragging
                        if (draggingTabId) return
                        if (e.shiftKey) {
                          rangeSelectTab(tab.id, tabs.map(t => t.id))
                        } else if (e.metaKey || e.ctrlKey) {
                          toggleTabSelection(tab.id, true)
                        } else {
                          toggleTabSelection(tab.id, false)
                          setActiveTabId(tab.id)
                        }
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setActiveTabId(tab.id) }}
                      onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
                      onPointerDown={(e) => handleTabPointerDown(e, tab.id)}
                      style={tab.color ? { '--tab-color': tab.color } as React.CSSProperties : undefined}
                    >
                      {/* Tab icon - terminal, document, topology, or mop based on type */}
                      {isTerminalTab(tab) ? (
                        <span className="tab-icon tab-icon-terminal" title="Terminal">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                            <polyline points="4 17 10 11 4 5" />
                            <line x1="12" y1="19" x2="20" y2="19" />
                          </svg>
                        </span>
                      ) : isTopologyTab(tab) ? (
                        <span className="tab-icon tab-icon-topology" title="Topology">
                          {Icons.topologyTab}
                        </span>
                      ) : isMopTab(tab) ? (
                        <span className="tab-icon tab-icon-mop" title="MOP Workspace">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
                            <rect x="9" y="3" width="6" height="4" rx="1" />
                            <line x1="9" y1="12" x2="15" y2="12" />
                            <line x1="9" y1="16" x2="13" y2="16" />
                          </svg>
                        </span>
                      ) : isScriptTab(tab) ? (
                        <span className="tab-icon tab-icon-script" title="Script">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                            <polyline points="16 18 22 12 16 6" />
                            <polyline points="8 6 2 12 8 18" />
                            <line x1="14" y1="4" x2="10" y2="20" />
                          </svg>
                        </span>
                      ) : tab.type === 'workspace' ? (
                        <span className="tab-icon tab-icon-workspace" title="Workspace">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                            <path d="M3 7V17C3 18.1 3.9 19 5 19H19C20.1 19 21 18.1 21 17V9C21 7.9 20.1 7 19 7H13L11 5H5C3.9 5 3 5.9 3 7Z" />
                          </svg>
                        </span>
                      ) : isSettingsTab(tab) ? (
                        <span className="tab-icon tab-icon-settings" title="Settings">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                            <circle cx="12" cy="12" r="3"/>
                            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
                          </svg>
                        </span>
                      ) : (
                        <span className="tab-icon tab-icon-document" title={tab.documentCategory || 'Document'}>
                          {getDocumentIcon(tab.documentCategory)}
                        </span>
                      )}
                      {/* Status indicator dot */}
                      <span className="tab-status-indicator" />
                      {/* Multi-send indicator for terminal tabs */}
                      {isTerminalTab(tab) && isMultiSendEnabled(tab.id) && (
                        <span className="tab-multisend-indicator" title="Multi-send enabled">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                            <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                          </svg>
                        </span>
                      )}
                      {/* Share indicator for terminal tabs — click to manage/stop sharing */}
                      {isTerminalTab(tab) && tab.sessionId && sharedSessions.has(tab.sessionId) && (
                        <span
                          className="tab-share-indicator tab-share-indicator-active"
                          title="Sharing — click to manage"
                          onClick={(e) => { e.stopPropagation(); setShareSessionTabId(tab.id) }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                            <circle cx="18" cy="5" r="3" />
                            <circle cx="6" cy="12" r="3" />
                            <circle cx="18" cy="19" r="3" />
                            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                          </svg>
                        </span>
                      )}
                      {/* Viewer count badge for shared sessions */}
                      {isTerminalTab(tab) && tab.sessionId && (() => {
                        const share = sharedSessions.get(tab.sessionId!)
                        return share && share.viewerCount > 0 ? (
                          <span className="tab-share-viewers" title={`${share.viewerCount} viewer${share.viewerCount !== 1 ? 's' : ''}`}>
                            {share.viewerCount}
                          </span>
                        ) : null
                      })()}
                      <span className="tab-title">{tab.title}</span>
                      <button
                        className="tab-close"
                        onClick={(e) => {
                          e.stopPropagation()
                          closeTerminal(tab.id)
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button className="tab-add" onClick={createTerminal} title="New Terminal">
                    +
                  </button>
                </div>
              )}

              {/* Tab Content Area */}
              <div
                ref={splitContainerRef}
                className={`terminal-area ${isActiveTabInSplit ? 'split-view-mode' : ''} ${isResizingSplit ? 'resizing' : ''}`}
                data-drop-zone={draggingTabId && edgeDropZone ? edgeDropZone : undefined}
              >
                {tabs.length === 0 ? (
                  <div className="welcome">
                    <img src={`${import.meta.env.BASE_URL}logo.png`} alt="NetStacks" className="welcome-logo" />
                    <p className="welcome-hint">Press <kbd>{displayShortcut('Cmd+T')}</kbd> to open a terminal</p>
                  </div>
                ) : (
                  /* Phase 25: Always render all tabs, use CSS for split view layout */
                  <>
                    {tabs.map(tab => {
                      const splitIndex = splitViewTabs?.findIndex(t => t.id === tab.id) ?? -1
                      const isInSplitView = splitIndex >= 0
                      // Show split view only when active tab is part of the split
                      // Otherwise show only the active non-split tab
                      const isVisible = isActiveTabInSplit ? isInSplitView : (activeTabId === tab.id)

                      // Calculate split pane style based on layout type
                      const calculateSplitStyle = (): React.CSSProperties | undefined => {
                        // Only apply split styles when actively showing split view
                        if (!isInSplitView || !splitViewTabs || !isActiveTabInSplit) return undefined

                        const tabCount = splitViewTabs.length
                        const sizes = splitPaneSizes['split'] || []

                        // Base style overrides CSS defaults - must explicitly set all position properties
                        const baseStyle: React.CSSProperties = {
                          position: 'absolute',
                          display: 'flex',
                          flexDirection: 'column',
                          // Reset all position properties to auto (overrides CSS bottom:0, right:0)
                          top: 'auto',
                          left: 'auto',
                          right: 'auto',
                          bottom: 'auto',
                        }

                        // Handle asymmetric layouts for 3 tabs
                        if (tabCount === 3 && splitLayout === '2-top-1-bottom') {
                          // sizes[0] = left/right ratio for top row, sizes[1] = top row height %, sizes[2] = bottom row height %
                          const leftWidth = sizes[0] || 50
                          const topHeight = sizes[1] || 50
                          const bottomHeight = sizes[2] || 50

                          if (splitIndex === 0) {
                            return { ...baseStyle, top: 0, left: 0, width: `${leftWidth}%`, height: `${topHeight}%` }
                          } else if (splitIndex === 1) {
                            return { ...baseStyle, top: 0, left: `${leftWidth}%`, width: `${100 - leftWidth}%`, height: `${topHeight}%` }
                          } else {
                            return { ...baseStyle, top: `${topHeight}%`, left: 0, width: '100%', height: `${bottomHeight}%` }
                          }
                        }

                        if (tabCount === 3 && splitLayout === '1-top-2-bottom') {
                          // sizes[0] = left/right ratio for bottom row, sizes[1] = top row height %, sizes[2] = bottom row height %
                          const leftWidth = sizes[0] || 50
                          const topHeight = sizes[1] || 50
                          const bottomHeight = sizes[2] || 50

                          if (splitIndex === 0) {
                            return { ...baseStyle, top: 0, left: 0, width: '100%', height: `${topHeight}%` }
                          } else if (splitIndex === 1) {
                            return { ...baseStyle, top: `${topHeight}%`, left: 0, width: `${leftWidth}%`, height: `${bottomHeight}%` }
                          } else {
                            return { ...baseStyle, top: `${topHeight}%`, left: `${leftWidth}%`, width: `${100 - leftWidth}%`, height: `${bottomHeight}%` }
                          }
                        }

                        // Handle 4 tabs as 2x2 grid
                        if (tabCount === 4) {
                          // sizes[0] = vertical divider position (left/right), sizes[1] = horizontal divider position (top/bottom)
                          const colWidth = sizes[0] || 50
                          const rowHeight = sizes[1] || 50
                          const row = Math.floor(splitIndex / 2)
                          const col = splitIndex % 2

                          return {
                            ...baseStyle,
                            top: row === 0 ? 0 : `${rowHeight}%`,
                            left: col === 0 ? 0 : `${colWidth}%`,
                            width: col === 0 ? `${colWidth}%` : `${100 - colWidth}%`,
                            height: row === 0 ? `${rowHeight}%` : `${100 - rowHeight}%`,
                          }
                        }

                        // Default: horizontal or vertical layout
                        const paneSize = sizes[splitIndex] || (100 / tabCount)
                        let position = 0
                        for (let i = 0; i < splitIndex; i++) {
                          position += sizes[i] || (100 / tabCount)
                        }

                        const isHorizontal = splitLayout === 'horizontal'
                        if (isHorizontal) {
                          // Horizontal: position left-to-right with explicit height
                          return { ...baseStyle, top: 0, left: `${position}%`, width: `${paneSize}%`, height: '100%' }
                        } else {
                          // Vertical: position top-to-bottom with explicit width
                          return { ...baseStyle, top: `${position}%`, left: 0, width: '100%', height: `${paneSize}%` }
                        }
                      }

                      const splitStyle = calculateSplitStyle()

                      return (
                        <div
                          key={tab.id}
                          data-tab-id={tab.id}
                          className={`terminal-instance ${isVisible ? 'active' : ''} ${isInSplitView ? 'split-pane-tab' : ''} ${draggingSplitTabId === tab.id ? 'dragging' : ''} ${splitDropTargetId === tab.id ? 'drop-target' : ''}`}
                          style={splitStyle}
                        >
                          {/* Split pane header with drag handle (only visible in split view) */}
                          <div
                            className="split-pane-header"
                            style={{ display: isInSplitView ? 'flex' : 'none', cursor: isInSplitView ? 'grab' : undefined }}
                            onPointerDown={isInSplitView ? (e) => handleSplitPanePointerDown(e, tab.id) : undefined}
                            onContextMenu={isInSplitView ? (e) => handleSplitPaneContextMenu(e, tab.id) : undefined}
                          >
                            <span className="split-pane-title">{tab.title}</span>
                            {/* Layout toggle - only show on first pane */}
                            {splitIndex === 0 && splitViewTabs && splitViewTabs.length >= 2 && (
                              <button
                                className="split-layout-toggle"
                                onClick={() => {
                                  // Cycle through layouts based on tab count
                                  const tabCount = splitViewTabs.length
                                  if (tabCount === 2) {
                                    // Toggle between horizontal and vertical
                                    setSplitLayout(prev => prev === 'horizontal' ? 'vertical' : 'horizontal')
                                  } else if (tabCount === 3) {
                                    // Cycle: horizontal -> vertical -> 2-top-1-bottom -> 1-top-2-bottom
                                    setSplitLayout(prev => {
                                      if (prev === 'horizontal') return 'vertical'
                                      if (prev === 'vertical') return '2-top-1-bottom'
                                      if (prev === '2-top-1-bottom') return '1-top-2-bottom'
                                      return 'horizontal'
                                    })
                                  } else if (tabCount === 4) {
                                    // For 4 tabs, just use grid
                                    setSplitLayout('horizontal')
                                  }
                                }}
                                title={`Layout: ${splitLayout}${splitViewTabs.length >= 3 ? ' (click to change)' : ''}`}
                              >
                                {splitLayout === 'horizontal' ? '⬛⬛' :
                                 splitLayout === 'vertical' ? '⬛\n⬛' :
                                 splitLayout === '2-top-1-bottom' ? '⬛⬛\n⬛' : '⬛\n⬛⬛'}
                              </button>
                            )}
                            <button
                              className="split-pane-remove"
                              onClick={() => {
                                // Remove tab from split view (fluid split - no group involved)
                                setSplitTabs(prev => prev.filter(id => id !== tab.id))
                              }}
                              title="Remove from split view"
                            >
                              ×
                            </button>
                          </div>
                          {/* Always use same DOM structure to prevent Terminal remount */}
                          <div className={isInSplitView ? 'split-pane-content' : 'single-pane-content'}>
                            {renderTabContent(tab)}
                          </div>
                        </div>
                      )
                    })}
                    {/* Resize handles between split panes */}
                    {splitViewTabs && splitViewTabs.length >= 2 && (() => {
                      const handles: React.ReactElement[] = []
                      const sizes = splitPaneSizes['split'] || []
                      const tabCount = splitViewTabs.length

                      if (tabCount === 2) {
                        // Simple 2-pane layout
                        const isHorizontal = splitLayout === 'horizontal'
                        const size1 = sizes[0] || 50
                        handles.push(
                          <div
                            key="resize-0"
                            className={`split-resize-handle ${isHorizontal ? 'horizontal' : 'vertical'}`}
                            style={isHorizontal ? { left: `${size1}%` } : { top: `${size1}%` }}
                            onMouseDown={(e) => handleSplitResizeStart(e, 0)}
                          />
                        )
                      } else if (tabCount === 3) {
                        const leftWidth = sizes[0] || 50
                        const topHeight = sizes[1] || 50

                        if (splitLayout === '2-top-1-bottom') {
                          // Vertical handle between top panes
                          handles.push(
                            <div
                              key="resize-top"
                              className="split-resize-handle horizontal"
                              style={{ left: `${leftWidth}%`, top: 0, height: `${topHeight}%`, bottom: 'auto' }}
                              onMouseDown={(e) => handleSplitResizeStart(e, 0)}
                            />
                          )
                          // Horizontal handle between top row and bottom
                          handles.push(
                            <div
                              key="resize-row"
                              className="split-resize-handle vertical"
                              style={{ top: `${topHeight}%` }}
                              onMouseDown={(e) => handleSplitResizeStart(e, 1)}
                            />
                          )
                        } else if (splitLayout === '1-top-2-bottom') {
                          // Horizontal handle between top and bottom row
                          handles.push(
                            <div
                              key="resize-row"
                              className="split-resize-handle vertical"
                              style={{ top: `${topHeight}%` }}
                              onMouseDown={(e) => handleSplitResizeStart(e, 0)}
                            />
                          )
                          // Vertical handle between bottom panes
                          handles.push(
                            <div
                              key="resize-bottom"
                              className="split-resize-handle horizontal"
                              style={{ left: `${leftWidth}%`, top: `${topHeight}%`, height: `${100 - topHeight}%`, bottom: 'auto' }}
                              onMouseDown={(e) => handleSplitResizeStart(e, 1)}
                            />
                          )
                        } else {
                          // Vertical 3-pane layout - two horizontal handles
                          const size1 = sizes[0] || 33.33
                          const size2 = sizes[1] || 33.33
                          handles.push(
                            <div
                              key="resize-0"
                              className="split-resize-handle vertical"
                              style={{ top: `${size1}%` }}
                              onMouseDown={(e) => handleSplitResizeStart(e, 0)}
                            />
                          )
                          handles.push(
                            <div
                              key="resize-1"
                              className="split-resize-handle vertical"
                              style={{ top: `${size1 + size2}%` }}
                              onMouseDown={(e) => handleSplitResizeStart(e, 1)}
                            />
                          )
                        }
                      } else if (tabCount === 4) {
                        const colWidth = sizes[0] || 50
                        const rowHeight = sizes[1] || 50
                        // 2x2 grid - center vertical and horizontal handles
                        handles.push(
                          <div
                            key="resize-v"
                            className="split-resize-handle horizontal"
                            style={{ left: `${colWidth}%` }}
                            onMouseDown={(e) => handleSplitResizeStart(e, 0)}
                          />
                        )
                        handles.push(
                          <div
                            key="resize-h"
                            className="split-resize-handle vertical"
                            style={{ top: `${rowHeight}%` }}
                            onMouseDown={(e) => handleSplitResizeStart(e, 1)}
                          />
                        )
                      }

                      return handles
                    })()}
                  </>
                )}
          </div>
        </div>

        {/* AI Side Panel — portaled to Zone 3 when NetStacks Agent is active */}
        {aiPortalTarget ? createPortal(
        <div className="workspace-ai-panel-inline">
        <AISidePanel
          isOpen={true}
          onClose={() => {
            setAiChatOpen(false)
            setAiContext(null)
            setAiPanelInitialMessages(undefined)
          }}
          expandTrigger={aiExpandTrigger}
          onOpenAsTab={() => handleOpenAIChatTab()}
          onManagePrompts={handleManagePrompts}
          availableSessions={availableSessions}
          onExecuteCommand={handleAgentExecuteCommand}
          getTerminalContext={handleAgentGetTerminalContext}
          liveContextDeps={liveContextDeps}
          onOpenSession={handleAgentOpenSession}
          onListDocuments={handleAgentListDocuments}
          onReadDocument={handleAgentReadDocument}
          onSearchDocuments={handleAgentSearchDocuments}
          onSaveDocument={handleAgentSaveDocument}
          initialMessages={aiPanelInitialMessages}
          defaultPinned={aiPanelPinned}

          externalPrompt={aiExternalPrompt}
          topologyContext={aiTopologyContext ? {
            topologyId: aiTopologyContext.topologyId,
            devices: aiTopologyContext.devices,
            onRefresh: () => setAiTopologyContext(prev => prev ? { ...prev, refreshCounter: Date.now() } : null)
          } : undefined}
          // Integration callbacks for AI Discovery (Phase 22)
          onNetBoxGetNeighbors={handleNetBoxGetNeighbors}
          onTopologyDeviceUpdated={handleTopologyDeviceUpdated}
          topologyCallbacks={topologyAICallbacks}
          allowStructuralTopologyEdits={allowStructuralTopologyEdits}
          // MOP creation callback
          onCreateMop={handleCreateMop}
          // Troubleshooting session capture (Phase 26)
          onTroubleshootingCapture={handleTroubleshootingAICapture}
          isTroubleshootingActive={isTroubleshootingActive}
          captureAIConversations={captureAIConversations}
          onCollapsedChange={setAiPanelCollapsed}
          focusedSessionId={(() => {
            const activeTab = tabs.find(t => t.id === activeTabId)
            if (activeTab && isTerminalTab(activeTab) && (activeTab.sessionId || activeTab.enterpriseSessionDefinitionId)) return activeTab.id
            return undefined
          })()}
          focusedSessionName={(() => {
            const activeTab = tabs.find(t => t.id === activeTabId)
            if (activeTab && isTerminalTab(activeTab)) return activeTab.title
            return undefined
          })()}
          scriptContext={(() => {
            const activeTab = tabs.find(t => t.id === activeTabId)
            if (!activeTab || !isScriptTab(activeTab)) return undefined
            const handle = scriptEditorRefs.current.get(activeTab.id)
            if (!handle) return undefined
            return {
              name: handle.getName(),
              getContent: () => handle.getContent(),
              onApplyCode: (code: string) => handle.applyContent(code),
            }
          })()}
          onNavigateToBackup={(deviceId, deviceName, _searchText) => {
            openBackupHistoryTab(deviceId, deviceName)
          }}
          onNavigateToDevice={(deviceId, deviceName) => {
            const existing = tabs.find(t => t.type === 'device-detail' && t.deviceName === deviceName)
            if (existing) {
              setActiveTabId(existing.id)
            } else {
              const newTab: Tab = {
                id: `device-detail-${deviceId}-${Date.now()}`,
                type: 'device-detail',
                title: deviceName,
                status: 'ready',
                deviceName,
              }
              setTabs(prev => [...prev, newTab])
              setActiveTabId(newTab.id)
            }
          }}
          onOpenTerminalSession={(deviceName) => {
            const session = tabs.find(t => isTerminalTab(t) && t.title === deviceName)
            if (session) {
              setActiveTabId(session.id)
            }
          }}
          onNavigateToMop={(mopId, mopName) => {
            handleOpenMopTab(mopId, mopName)
          }}
          onNavigateToTopology={(topologyName) => {
            const existing = tabs.find(t => t.type === 'topology' && t.title === topologyName)
            if (existing) {
              setActiveTabId(existing.id)
            }
          }}
          onNavigateToSettings={(tab) => {
            openSettingsTab(tab as import('./components/SettingsPanel').SettingsTab | undefined)
          }}
        />
        </div>, aiPortalTarget) : (
        <AISidePanel
          isOpen={aiChatOpen}
          onClose={() => {
            setAiChatOpen(false)
            setAiContext(null)
            setAiPanelInitialMessages(undefined)
          }}
          expandTrigger={aiExpandTrigger}
          onOpenAsTab={() => handleOpenAIChatTab()}
          onManagePrompts={handleManagePrompts}
          availableSessions={availableSessions}
          onExecuteCommand={handleAgentExecuteCommand}
          getTerminalContext={handleAgentGetTerminalContext}
          liveContextDeps={liveContextDeps}
          onOpenSession={handleAgentOpenSession}
          onListDocuments={handleAgentListDocuments}
          onReadDocument={handleAgentReadDocument}
          onSearchDocuments={handleAgentSearchDocuments}
          onSaveDocument={handleAgentSaveDocument}
          initialMessages={aiPanelInitialMessages}
          defaultPinned={aiPanelPinned}
          externalPrompt={aiExternalPrompt}
          topologyContext={aiTopologyContext ? {
            topologyId: aiTopologyContext.topologyId,
            devices: aiTopologyContext.devices,
            onRefresh: () => setAiTopologyContext(prev => prev ? { ...prev, refreshCounter: Date.now() } : null)
          } : undefined}
          onNetBoxGetNeighbors={handleNetBoxGetNeighbors}
          onTopologyDeviceUpdated={handleTopologyDeviceUpdated}
          topologyCallbacks={topologyAICallbacks}
          allowStructuralTopologyEdits={allowStructuralTopologyEdits}
          onCreateMop={handleCreateMop}
          onTroubleshootingCapture={handleTroubleshootingAICapture}
          isTroubleshootingActive={isTroubleshootingActive}
          captureAIConversations={captureAIConversations}
          onCollapsedChange={setAiPanelCollapsed}
          focusedSessionId={(() => {
            const activeTab = tabs.find(t => t.id === activeTabId)
            if (activeTab && isTerminalTab(activeTab) && (activeTab.sessionId || activeTab.enterpriseSessionDefinitionId)) return activeTab.id
            return undefined
          })()}
          focusedSessionName={(() => {
            const activeTab = tabs.find(t => t.id === activeTabId)
            if (activeTab && isTerminalTab(activeTab)) return activeTab.title
            return undefined
          })()}
          scriptContext={(() => {
            const activeTab = tabs.find(t => t.id === activeTabId)
            if (!activeTab || !isScriptTab(activeTab)) return undefined
            const handle = scriptEditorRefs.current.get(activeTab.id)
            if (!handle) return undefined
            return {
              name: handle.getName(),
              getContent: () => handle.getContent(),
              onApplyCode: (code: string) => handle.applyContent(code),
            }
          })()}
          onNavigateToBackup={(deviceId, deviceName) => {
            openBackupHistoryTab(deviceId, deviceName)
          }}
          onNavigateToDevice={(deviceId, deviceName) => {
            const existing = tabs.find(t => t.type === 'device-detail' && t.deviceName === deviceName)
            if (existing) {
              setActiveTabId(existing.id)
            } else {
              const newTab: Tab = {
                id: `device-detail-${deviceId}-${Date.now()}`,
                type: 'device-detail',
                title: deviceName,
                status: 'ready',
                deviceName,
              }
              setTabs(prev => [...prev, newTab])
              setActiveTabId(newTab.id)
            }
          }}
          onOpenTerminalSession={(deviceName) => {
            const session = tabs.find(t => isTerminalTab(t) && t.title === deviceName)
            if (session) {
              setActiveTabId(session.id)
            }
          }}
          onNavigateToMop={(mopId, mopName) => {
            handleOpenMopTab(mopId, mopName)
          }}
          onNavigateToTopology={(topologyName) => {
            const existing = tabs.find(t => t.type === 'topology' && t.title === topologyName)
            if (existing) {
              setActiveTabId(existing.id)
            }
          }}
          onNavigateToSettings={(tab) => {
            openSettingsTab(tab as import('./components/SettingsPanel').SettingsTab | undefined)
          }}
        />
        )}

        {/* Hot Edge Zones - invisible trigger areas at window edges */}
        {hotEdgesEnabled && !sidebarOpen && (
          <div
            className="hot-edge hot-edge-left"
            onMouseEnter={() => {
              hotEdgeTimerRef.current = window.setTimeout(() => setSidebarOpen(true), 150)
            }}
            onMouseLeave={() => {
              if (hotEdgeTimerRef.current) clearTimeout(hotEdgeTimerRef.current)
            }}
          />
        )}
        {hotEdgesEnabled && (!aiChatOpen || aiPanelCollapsed) && (
          <div
            className="hot-edge hot-edge-right"
            onMouseEnter={() => {
              hotEdgeTimerRef.current = window.setTimeout(() => {
                if (!aiChatOpen) {
                  setAiChatOpen(true)
                }
                setAiExpandTrigger(prev => prev + 1)
              }, 150)
            }}
            onMouseLeave={() => {
              if (hotEdgeTimerRef.current) clearTimeout(hotEdgeTimerRef.current)
            }}
          />
        )}
      </div>

      {/* Quick Call variable prompt */}
      {pendingQuickCall && (
        <QuickCallVariablesDialog
          call={pendingQuickCall.call}
          variables={pendingQuickCall.variables}
          onCancel={() => setPendingQuickCall(null)}
          onSubmit={async (values) => {
            const { call } = pendingQuickCall
            setPendingQuickCall(null)
            await runQuickCall(call, values)
          }}
        />
      )}

      {/* Status Bar */}
      <StatusBar
        activeSessionName={activeSessionName}
        activeProfileName={activeProfileName}
        connectedCount={connectedCount}
        statusBarColor={statusBarColor}
        activeView={activeView}
        onToggleAIOverlord={() => setAiOverlordActive(prev => !prev)}
        aiOverlordActive={aiOverlordActive}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onOpenSettings={() => openSettingsTab()}
        onQuickPromptSelect={handleQuickPromptSelect}
        onManagePrompts={handleManagePrompts}
        onSnippetSelect={handleSnippetSelect}
        onManageSnippets={handleManageSnippets}
        onQuickCallSelect={handleQuickCallSelect}
        onManageQuickCalls={handleManageQuickCalls}
        onManageTunnels={handleManageTunnels}
        troubleshootingSession={troubleshootingSession}
        onStartTroubleshootingSession={() => setTroubleshootingDialogOpen(true)}
        onEndTroubleshootingSession={handleEndTroubleshootingSession}
        onAttachTroubleshootingTopology={handleAttachTroubleshootingTopology}
        onOpenMcpSettings={() => openSettingsTab('ai')}
        isTerminalFocused={isTerminalFocused}
        canSftp={canSftp}
        sftpConnectionCount={sftpConnectionCount}
        onToggleSftp={handleStatusBarSftp}
        onOpenScratchpad={() => handleOpenScratchpad()}
        onOpenAgentRun={() => {
          const running = useAgentTasksStore.getState().tasks
            .filter(t => t.status === 'running')
            .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))
          const t = running[0]
          if (t) handleOpenAgentRunTab(t.id, t.prompt.length > 32 ? `${t.prompt.slice(0, 32)}…` : t.prompt)
        }}
        scratchpadMinimized={scratchpadExists && scratchpadMinimized}
      />

      {/* Command Palette */}
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={commands}
        onNavigate={handleNavigateHit}
      />


      {/* Force Touch action popover (macOS force-click on terminal selection) */}
      <ForceTouchPopover
        isOpen={forcePopover.isOpen}
        position={forcePopover.position}
        context={forcePopover.context}
        options={forcePopover.options}
        onClose={() => setForcePopover(prev => ({ ...prev, isOpen: false }))}
      />

      {/* AI Inline Popup (context menu actions) - has full agent capability */}
      <AIInlinePopup
        isOpen={aiPopup.isOpen}
        position={aiPopup.position}
        action={aiPopup.action}
        selectedText={aiPopup.selectedText}
        sessionId={aiPopup.sessionId}
        sessionName={aiPopup.sessionName}
        onClose={() => setAiPopup(prev => ({ ...prev, isOpen: false }))}
        availableSessions={availableSessions}
        onExecuteCommand={handleAgentExecuteCommand}
        getTerminalContext={handleAgentGetTerminalContext}
        liveContextDeps={liveContextDeps}
        onListDocuments={handleAgentListDocuments}
        onReadDocument={handleAgentReadDocument}
        onSearchDocuments={handleAgentSearchDocuments}
        onSaveDocument={handleAgentSaveDocument}
        onContinueInPanel={(messages) => {
          setAiPopup(prev => ({ ...prev, isOpen: false }))
          setAiPanelInitialMessages(messages)
          setAiChatOpen(true)
          setAiExpandTrigger(t => t + 1)
        }}
      />

      {/* AI Floating Chat (from terminal "Ask AI" context menu) - has full agent capability */}
      <AIFloatingChat
        isOpen={aiFloatingChat.isOpen}
        position={aiFloatingChat.position}
        sessionId={aiFloatingChat.sessionId}
        sessionName={aiFloatingChat.sessionName}
        selectedText={aiFloatingChat.selectedText}
        initialPrompt={aiFloatingChat.initialPrompt}
        onClose={() => setAiFloatingChat(prev => ({ ...prev, isOpen: false }))}
        availableSessions={availableSessions}
        onExecuteCommand={handleAgentExecuteCommand}
        getTerminalContext={handleAgentGetTerminalContext}
        liveContextDeps={liveContextDeps}
        onListDocuments={handleAgentListDocuments}
        onReadDocument={handleAgentReadDocument}
        onSearchDocuments={handleAgentSearchDocuments}
        onSaveDocument={handleAgentSaveDocument}
        topologyCallbacks={topologyAICallbacks}
        allowStructuralTopologyEdits={allowStructuralTopologyEdits}
        onContinueInPanel={(messages) => {
          setAiFloatingChat(prev => ({ ...prev, isOpen: false }))
          setAiPanelInitialMessages(messages)
          setAiChatOpen(true)
          setAiExpandTrigger(t => t + 1)
        }}
      />

      {/* AI Script Generator */}
      <AIScriptGenerator
        isOpen={aiScriptGeneratorOpen}
        onClose={() => setAiScriptGeneratorOpen(false)}
        onEditInPanel={(script) => {
          setAiScriptGeneratorOpen(false)
          handleOpenScript(script)
        }}
        onSave={(script) => {
          setAiScriptGeneratorOpen(false)
          handleOpenScript(script)
        }}
      />

      {/* Quick Connect Dialog */}
      <QuickConnectDialog
        isOpen={quickConnectOpen}
        onClose={() => {
          setQuickConnectOpen(false)
          setQuickConnectInitialHost(undefined)
        }}
        initialHost={quickConnectInitialHost}
        onConnect={(sessionOrInfo) => {
          // If it's a saved session, it has an id
          if ('id' in sessionOrInfo && sessionOrInfo.id) {
            handleSSHConnect(sessionOrInfo as Session)
          } else {
            // Quick connect without saving - create temporary tab
            const info = sessionOrInfo as { host: string; port: number; username: string; profile_id?: string }
            const newId = `quick-${Date.now()}`
            const newTab: Tab = {
              id: newId,
              type: 'terminal',
              title: `${info.username}@${info.host}`,
              fontSize: null,
              fontFamily: null,
              status: 'connecting'
            }
            setTabs(prev => [...prev, newTab])
            setActiveTabId(newId)
            logger.log('Quick connecting to:', info.host, info.port, info.username)
          }
        }}
      />

      {/* Save Layout Dialog (Phase 25) */}
      {saveLayoutDialogOpen && (
        <div className="modal-overlay" onClick={() => setSaveLayoutDialogOpen(false)}>
          <div className="save-layout-dialog" onClick={e => e.stopPropagation()}>
            <h3>Save Layout</h3>
            <p className="save-layout-dialog-description">
              Save this group configuration as a layout to restore later.
            </p>
            <input
              type="text"
              className="save-layout-dialog-input"
              placeholder="Layout name"
              value={layoutNameInput}
              onChange={e => setLayoutNameInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveLayoutConfirm()
                if (e.key === 'Escape') setSaveLayoutDialogOpen(false)
              }}
              autoFocus
            />
            <div className="save-layout-dialog-actions">
              <button
                className="save-layout-dialog-btn save-layout-dialog-btn-cancel"
                onClick={() => setSaveLayoutDialogOpen(false)}
              >
                Cancel
              </button>
              <button
                className="save-layout-dialog-btn save-layout-dialog-btn-save"
                onClick={handleSaveLayoutConfirm}
                disabled={!layoutNameInput.trim()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tab Context Menu */}
      {contextMenuTabId && (
        <TabContextMenu
          position={contextMenuPosition}
          tabId={contextMenuTabId}
          sessionId={tabs.find(t => t.id === contextMenuTabId)?.sessionId}
          isMultiSendEnabled={isMultiSendEnabled(contextMenuTabId)}
          groups={tabGroups}
          currentGroupId={tabGroups.find(g => g.tabIds.includes(contextMenuTabId))?.id || null}
          onClose={closeContextMenu}
          onReconnect={() => {
            const handle = terminalRefs.current.get(contextMenuTabId)
            if (handle) {
              handle.reconnect()
              closeContextMenu()
            } else {
              showToast('Terminal not available for reconnect', 'error')
            }
          }}
          onDuplicateTab={() => duplicateTab(contextMenuTabId)}
          onPopOut={(() => {
            const tab = tabs.find(t => t.id === contextMenuTabId);
            if (!tab || tab.type !== 'terminal') return undefined;
            // Disable popout for local shell (jumpbox) tabs in enterprise mode — they can't reconnect in a separate window
            if (isEnterprise && !tab.sessionId) return undefined;
            return () => handlePopoutTab(contextMenuTabId);
          })()}
          onSplitRight={() => handleSplitFromContextMenu('horizontal')}
          onSplitDown={() => handleSplitFromContextMenu('vertical')}
          onToggleMultiSend={() => toggleMultiSend(contextMenuTabId)}
          onSelectAllTabs={() => selectAllTerminals(tabs.map(t => t.id))}
          onCreateGroup={createTabGroup}
          onMoveToGroup={moveToGroup}
          onRemoveFromGroup={removeFromGroup}
          onCloseTab={() => closeTerminal(contextMenuTabId)}
          onCloseOtherTabs={() => closeOtherTabs(contextMenuTabId)}
          onCloseTabsToRight={() => closeTabsToRight(contextMenuTabId)}
          onCloseAllTabs={() => closeAllTabs()}
          onReopenLastClosed={() => reopenLastClosedTab()}
          canReopenClosed={closedTabs.length > 0}
          onSessionSettings={() => handleOpenSessionSettings(contextMenuTabId)}
          onOpenDeviceDetails={() => handleOpenDeviceDetailsFromTab(contextMenuTabId)}
          onDiscoverTopology={handleDiscoverTopologyFromGroup}
          selectedTabCount={tabSelectionCount}
          onGroupSelectedTabs={handleGroupSelectedTabs}
          onToggleSftp={canSftp && tabs.find(t => t.id === contextMenuTabId)?.sessionId ? async () => {
            const tab = tabs.find(t => t.id === contextMenuTabId)
            if (!tab?.sessionId) return
            const sftpState = useSftpStore.getState()
            const existing = sftpState.getConnectionForSession(tab.sessionId)
            if (existing) {
              await sftpState.closeConnection(existing.id)
            } else {
              await openSftpForSession(tab.sessionId)
            }
          } : undefined}
          isSftpEnabled={!!useSftpStore.getState().getConnectionForSession(tabs.find(t => t.id === contextMenuTabId)?.sessionId || '')}
          onShareSession={isEnterprise && tabs.find(t => t.id === contextMenuTabId)?.sessionId ? () => {
            setShareSessionTabId(contextMenuTabId)
          } : undefined}
          onDeployRemoteAgent={(() => {
            const ctxTab = tabs.find(t => t.id === contextMenuTabId)
            if (!ctxTab || ctxTab.type !== 'terminal' || ctxTab.protocol !== 'ssh') return undefined
            const flavor = ctxTab.cliFlavor
            if (flavor !== 'linux' && flavor !== 'auto') return undefined
            return () => setDeployAgentDialogOpen(true)
          })()}
        />
      )}

      {/* Share Session Dialog */}
      {shareSessionTabId && (() => {
        const shareTab = tabs.find(t => t.id === shareSessionTabId)
        if (!shareTab?.sessionId) return null
        return (
          <ShareSessionDialog
            isOpen={true}
            sessionId={shareTab.sessionId}
            sessionName={shareTab.title}
            onClose={() => setShareSessionTabId(null)}
            onShareStatusChange={(sid, share) => {
              setSharedSessions(prev => {
                const next = new Map(prev)
                if (share) {
                  next.set(sid, share)
                } else {
                  next.delete(sid)
                }
                return next
              })
            }}
          />
        )
      })()}

      {/* Split Pane Context Menu (Phase 25) */}
      {splitContextMenuPosition && splitContextMenuTabId && (
        <div
          ref={splitContextMenu.ref}
          className="split-context-menu"
          style={{ ...splitContextMenu.style, zIndex: 10000 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-section">
            <div className="context-menu-header">This Tab</div>
            {/* Move Up - only show if not first */}
            {splitTabs.indexOf(splitContextMenuTabId) > 0 && (
              <button
                className="context-menu-item"
                onClick={() => {
                  setSplitTabs(prev => {
                    const idx = prev.indexOf(splitContextMenuTabId)
                    if (idx <= 0) return prev
                    const newTabs = [...prev]
                    ;[newTabs[idx - 1], newTabs[idx]] = [newTabs[idx], newTabs[idx - 1]]
                    return newTabs
                  })
                  closeSplitContextMenu()
                }}
              >
                <span className="context-menu-icon">↑</span>
                Move Up
              </button>
            )}
            {/* Move Down - only show if not last */}
            {splitTabs.indexOf(splitContextMenuTabId) < splitTabs.length - 1 && (
              <button
                className="context-menu-item"
                onClick={() => {
                  setSplitTabs(prev => {
                    const idx = prev.indexOf(splitContextMenuTabId)
                    if (idx < 0 || idx >= prev.length - 1) return prev
                    const newTabs = [...prev]
                    ;[newTabs[idx], newTabs[idx + 1]] = [newTabs[idx + 1], newTabs[idx]]
                    return newTabs
                  })
                  closeSplitContextMenu()
                }}
              >
                <span className="context-menu-icon">↓</span>
                Move Down
              </button>
            )}
            <button
              className="context-menu-item"
              onClick={() => {
                setSplitTabs(prev => prev.filter(id => id !== splitContextMenuTabId))
                closeSplitContextMenu()
              }}
            >
              <span className="context-menu-icon">✕</span>
              Remove from Split
            </button>
            <button
              className="context-menu-item"
              onClick={() => {
                closeTerminal(splitContextMenuTabId)
                closeSplitContextMenu()
              }}
            >
              <span className="context-menu-icon">🗑</span>
              Close Tab
            </button>
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-section">
            <div className="context-menu-header">Split View ({splitTabs.length} tabs)</div>
            {/* Add tabs to split - show available terminal tabs not in split */}
            {tabs.filter(t => t.type === 'terminal' && !splitTabs.includes(t.id)).length > 0 && splitTabs.length < 4 && (
              <div className="context-menu-submenu-container">
                <button className="context-menu-item context-menu-item-submenu">
                  <span className="context-menu-icon">➕</span>
                  Add Tab to Split
                  <span className="context-menu-arrow">▶</span>
                </button>
                <div className="context-menu-submenu">
                  {tabs.filter(t => t.type === 'terminal' && !splitTabs.includes(t.id)).map(tab => (
                    <button
                      key={tab.id}
                      className="context-menu-item"
                      onClick={() => {
                        setSplitTabs(prev => [...prev, tab.id].slice(0, 4))
                        closeSplitContextMenu()
                      }}
                    >
                      <span className={`context-menu-status-dot ${tab.status}`} />
                      {tab.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button
              className="context-menu-item"
              onClick={handleSaveSplitAsLayout}
            >
              <span className="context-menu-icon">💾</span>
              Save as Layout
            </button>
            <button
              className="context-menu-item"
              onClick={() => handleCreateGroupFromSplit()}
            >
              <span className="context-menu-icon">📁</span>
              Create Group from Split
            </button>
            <button
              className="context-menu-item"
              onClick={handleCreateGroupAndDiscover}
            >
              <span className="context-menu-icon">🔍</span>
              Create Group & Discover Topology
            </button>
            <button
              className="context-menu-item"
              onClick={() => {
                const allEnabled = splitTabs.every(id => isMultiSendEnabled(id))
                splitTabs.forEach(id => {
                  if (allEnabled) {
                    if (isMultiSendEnabled(id)) toggleMultiSend(id)
                  } else {
                    if (!isMultiSendEnabled(id)) toggleMultiSend(id)
                  }
                })
                closeSplitContextMenu()
              }}
            >
              <span className="context-menu-icon">{splitTabs.every(id => isMultiSendEnabled(id)) ? '🔗' : '⛓'}</span>
              {splitTabs.every(id => isMultiSendEnabled(id)) ? 'Disable Multi-Send on All' : 'Enable Multi-Send on All'}
            </button>
            <button
              className="context-menu-item context-menu-item-danger"
              onClick={() => {
                setSplitTabs([])
                closeSplitContextMenu()
              }}
            >
              <span className="context-menu-icon">✕</span>
              Exit Split View
            </button>
            <button
              className="context-menu-item context-menu-item-danger"
              onClick={() => {
                // Close all tabs in split view and exit
                const tabsToClose = [...splitTabs]
                setSplitTabs([])
                tabsToClose.forEach(id => closeTerminal(id))
                closeSplitContextMenu()
              }}
            >
              <span className="context-menu-icon">🗑</span>
              Close All & Exit
            </button>
          </div>
        </div>
      )}

      {/* Click outside to close split context menu */}
      {splitContextMenuPosition && (
        <div
          className="split-context-menu-backdrop"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 9999,
          }}
          onClick={closeSplitContextMenu}
        />
      )}

      {/* Device Details Overlay (shown on topology device click) */}
      <DeviceDetailsOverlay
        device={deviceOverlay.device}
        position={deviceOverlay.position}
        onClose={handleDeviceOverlayClose}
        onFocusTerminal={handleFocusTerminal}
        onOpenAIChat={handleOpenAIChat}
        onDiscoverNeighbors={handleDiscoverNeighbors}
        onOpenSession={handleOpenDeviceTerminal}
        onOpenInTab={handleOpenDeviceDetailTab}
      />

      {/* Connection Details Overlay (shown on topology link click) */}
      <ConnectionDetailsOverlay
        connection={connectionOverlay.connection}
        position={connectionOverlay.position}
        sourceDeviceName={connectionOverlay.connection ? getDeviceName(connectionOverlay.connection.sourceDeviceId) : undefined}
        targetDeviceName={connectionOverlay.connection ? getDeviceName(connectionOverlay.connection.targetDeviceId) : undefined}
        onClose={handleConnectionOverlayClose}
      />

      {/* Device Context Menu (right-click on topology devices) */}
      <ContextMenu
        position={deviceContextMenu.position}
        items={deviceContextMenu.device ? getDeviceMenuItems(
          deviceContextMenu.device.name,
          handleDeviceEdit,
          handleDeviceDelete,
          // AI: Analyze Device
          () => {
            if (deviceContextMenu.device) {
              handleOpenAIChat(deviceContextMenu.device)
              const device = deviceContextMenu.device
              setAiExternalPrompt({
                prompt: `Analyze the network device "${device.name}" (${device.type}). Provide details about its role, typical configuration, and any recommendations for this ${device.platform || 'device'}.`,
                counter: Date.now()
              })
            }
            closeDeviceContextMenu()
          },
          // AI: Show Config
          () => {
            if (deviceContextMenu.device) {
              handleOpenAIChat(deviceContextMenu.device)
              const device = deviceContextMenu.device
              setAiExternalPrompt({
                prompt: `Generate a recommended baseline configuration for "${device.name}" (${device.type}, ${device.platform || 'unknown platform'}). Include common best practices for this device type.`,
                counter: Date.now()
              })
            }
            closeDeviceContextMenu()
          },
          // AI: Troubleshoot
          () => {
            if (deviceContextMenu.device) {
              handleOpenAIChat(deviceContextMenu.device)
              const device = deviceContextMenu.device
              setAiExternalPrompt({
                prompt: `Help me troubleshoot potential issues with "${device.name}" (${device.type}). What common problems should I check for on this ${device.platform || 'device'}?`,
                counter: Date.now()
              })
            }
            closeDeviceContextMenu()
          },
          // AI: Find Path To...
          () => {
            if (deviceContextMenu.device) {
              handleOpenAIChat(deviceContextMenu.device)
              const device = deviceContextMenu.device
              setAiExternalPrompt({
                prompt: `Help me trace the network path from "${device.name}" to another device. What commands should I run to discover the path and what should I look for?`,
                counter: Date.now()
              })
            }
            closeDeviceContextMenu()
          },
          // Focus Terminal
          () => {
            if (deviceContextMenu.device) handleFocusTerminal(deviceContextMenu.device)
            closeDeviceContextMenu()
          },
          // Open AI Chat
          () => {
            if (deviceContextMenu.device) handleOpenAIChat(deviceContextMenu.device)
            closeDeviceContextMenu()
          },
          // Discover Neighbors
          () => {
            if (deviceContextMenu.device) handleDiscoverNeighbors(deviceContextMenu.device)
            closeDeviceContextMenu()
          },
          // Connect (open SSH session to device)
          () => {
            if (deviceContextMenu.device) handleOpenDeviceTerminal(deviceContextMenu.device)
            closeDeviceContextMenu()
          },
          // Add to Discovery (only for neighbor devices)
          deviceContextMenu.device?.isNeighbor ? async () => {
            const device = deviceContextMenu.device
            if (!device) return
            closeDeviceContextMenu()

            const allSessions = await listSessions()
            const matchedSession = allSessions.find(s =>
              (device.primaryIp && s.host === device.primaryIp) ||
              s.name.toLowerCase() === device.name.toLowerCase()
            )

            if (!matchedSession) {
              showToast(`"${device.name}" is not a managed device. No saved session found matching this device by IP or name. Add it as a session first, then try again.`, 'warning')
              return
            }

            const topoTab = tabs.find(t => t.type === 'topology' && t.topologyId === deviceContextMenu.topologyId)
            setDiscoveryGroupName(topoTab?.topologyName || topoTab?.title || 'Discovery')
            setDiscoveryTargetTopologyId(deviceContextMenu.topologyId || null)
            setDiscoveryDevices([{
              name: device.name,
              tabId: '',
              ip: matchedSession.host || device.primaryIp,
              profileId: matchedSession.profile_id,
              snmpProfileId: matchedSession.profile_id,
              cliFlavor: matchedSession.cli_flavor,
            }])
            setDiscoveryModalOpen(true)
          } : undefined
        ) : []}
        onClose={closeDeviceContextMenu}
      />

      {/* Default Context Menu (right-click in areas without custom menus) */}
      <ContextMenu
        position={defaultContextMenuPosition}
        items={defaultContextMenuItems}
        onClose={() => {
          setDefaultContextMenuPosition(null)
          setDefaultContextMenuItems([])
        }}
      />

      {/* Discovery Modal */}
      <DiscoveryModal
        isOpen={discoveryModalOpen}
        onClose={() => setDiscoveryModalOpen(false)}
        groupName={discoveryGroupName}
        devices={discoveryDevices}
        onDiscoveryComplete={handleDiscoveryComplete}
      />

      {/* Discovery Toast (auto-discovery prompt when new tab joins topology group) */}
      {discoveryToast && (
        <DiscoveryToast
          isVisible={discoveryToast.isVisible}
          deviceName={discoveryToast.deviceName}
          groupName={discoveryToast.groupName}
          onRunDiscovery={handleToastRunDiscovery}
          onDismiss={handleToastDismiss}
        />
      )}

      {/* AI Progress Panel (floating, for background topology enrichment) */}
      <AIProgressPanel
        isRunning={aiProgressRunning}
        currentTask={aiProgressTask}
        logs={aiProgressLogs}
        progress={aiProgressPercent}
        isComplete={aiEnrichmentComplete}
        onDismiss={() => {
          setAiProgressRunning(false)
          setAiProgressLogs([])
          setAiProgressPercent(0)
          setAiProgressTask('')
          setAiEnrichmentComplete(false)
          setAiEnrichmentMessages([])
        }}
        onOpenInAIPanel={() => {
          // Transfer messages to AI side panel
          setAiPanelInitialMessages(aiEnrichmentMessages)
          setAiChatOpen(true)
          // Clear enrichment state
          setAiEnrichmentComplete(false)
          setAiProgressLogs([])
          setAiProgressPercent(0)
          setAiProgressTask('')
        }}
      />

      {/* About Modal */}
      <AboutModal
        isOpen={showAbout}
        onClose={() => setShowAbout(false)}
      />

      {/* Scratchpad — transient Monaco editor for quick notes */}
      <Scratchpad
        open={scratchpadExists}
        minimized={scratchpadMinimized}
        maximized={scratchpadMaximized}
        content={scratchpadContent}
        onContentChange={setScratchpadContent}
        onMinimize={handleMinimizeScratchpad}
        onToggleMaximize={handleToggleScratchpadMax}
        onPopToTab={handlePopScratchpadToTab}
        onClose={handleCloseScratchpad}
        activeWorkspace={activeWsConfig}
      />

      {/* New Workspace Dialog */}
      {showNewWorkspace && (
        <WorkspaceNewDialog
          sessions={[]}
          onSubmit={openWorkspaceTab}
          onCancel={() => setShowNewWorkspace(false)}
        />
      )}

      {/* Remote Window Deploy — shown while deploying agent for right-click "Open Remote Window" */}
      {remoteWindowDeploying && (
        <div className="modal-overlay">
          <div className="workspace-deploy-loading" style={{ background: 'var(--color-bg-primary)', borderRadius: 8, padding: 32, minWidth: 280, height: 'auto', width: 'auto' }}>
            <div className="workspace-deploy-spinner" />
            <div className="workspace-deploy-text">Deploying agent...</div>
            <div className="workspace-deploy-subtext">Uploading and launching the remote agent binary</div>
          </div>
        </div>
      )}

      {/* Deploy Remote Agent — opens workspace dialog pre-filled for the active SSH session */}
      {deployAgentDialogOpen && (
        <WorkspaceNewDialog
          sessions={[]}
          initialMode="remote"
          initialSessionId={activeTabSessionId}
          onSubmit={(config) => { openWorkspaceTab(config); setDeployAgentDialogOpen(false) }}
          onCancel={() => setDeployAgentDialogOpen(false)}
        />
      )}

      {/* Troubleshooting Session Dialog (Phase 26) */}
      <TroubleshootingDialog
        isOpen={troubleshootingDialogOpen}
        onClose={() => setTroubleshootingDialogOpen(false)}
        onStart={handleStartTroubleshootingSession}
        connectedSessions={connectedSessionsForTroubleshooting}
      />

      {/* Launch Group Dialog (Plan 1: Tab Groups Redesign) */}
      {pendingLaunch && (
        <LaunchDialog
          groupName={pendingLaunch.name}
          tabCount={pendingLaunch.tabs.length}
          tabSummary={pendingLaunch.tabs
            .map((t) => getTabTitleForChip(t.sessionId || t.topologyId || t.documentId || ''))
            .join(', ')}
          hasTopology={!!pendingLaunch.topologyId}
          defaultAction={defaultLaunchAction || 'alongside'}
          onConfirm={handleLaunchDialogConfirm}
          onCancel={() => setPendingLaunch(null)}
        />
      )}

      {/* Name Prompt Modal (Plan 1: Tab Groups - Tauri-compatible name prompt) */}
      {namePrompt && (
        <NamePromptModal
          title={namePrompt.title}
          onConfirm={(name) => {
            const cb = namePrompt.onConfirm;
            setNamePrompt(null);
            cb(name);
          }}
          onCancel={() => setNamePrompt(null)}
        />
      )}

      {/* Device Edit Dialog (from topology device context menu) */}
      <DeviceEditDialog
        device={editingDevice.device}
        onSave={handleSaveDeviceEdit}
        onClose={() => setEditingDevice({ device: null, topologyId: null })}
      />

      {/* Session Settings Dialog (from tab/terminal context menu) */}
      <SessionSettingsDialog
        isOpen={sessionSettingsSession !== null}
        session={sessionSettingsSession}
        onClose={() => setSessionSettingsSession(null)}
        onPreviewFont={(fontSize, fontFamily) => {
          // Live preview font changes on the terminal
          if (sessionSettingsSession) {
            setTabs(prev => prev.map(tab =>
              tab.sessionId === sessionSettingsSession.id
                ? { ...tab, fontSize, fontFamily }
                : tab
            ))
          }
        }}
        onSessionSaved={(updatedSession) => {
          // Update any open tabs with this session to reflect new settings
          setTabs(prev => prev.map(tab =>
            tab.sessionId === updatedSession.id
              ? {
                  ...tab,
                  title: updatedSession.name,
                  ...(() => {
                    const eff = getEffectiveFontSettings(updatedSession)
                    return { terminalTheme: eff.terminalTheme, fontSize: eff.fontSize, fontFamily: eff.fontFamily }
                  })(),
                  color: updatedSession.color || undefined,
                  cliFlavor: updatedSession.cli_flavor,
                }
              : tab
          ))
          // Notify SessionPanel of the update so reconnects use fresh data
          setExternalSessionUpdate(updatedSession)
          // Close dialog after save
          setSessionSettingsSession(null)
        }}
      />

      {/* Enterprise Connect Dialog (credential selection before SSH) */}
      {enterpriseConnectSession && (
        <EnterpriseConnectDialog
          session={enterpriseConnectSession}
          onConnect={handleEnterpriseProfileSelected}
          onCancel={() => setEnterpriseConnectSession(null)}
          deviceName={enterpriseConnectSession.id.startsWith('device-') ? enterpriseConnectSession.name : undefined}
          deviceProfileId={enterpriseConnectDeviceProfileId ?? undefined}
        />
      )}

      {/* Toast notifications */}
      <ToastContainer />

      {/* Confirmation dialog host (imperative API: confirmDialog({...})) */}
      <ConfirmDialogHost />

      {/* First-run onboarding wizard (SP2) */}
      <OnboardingWizard
        isOpen={wizardOpen}
        onClose={handleWizardClose}
        onOpenIntegrations={handleWizardOpenIntegrations}
      />

      {/* AI-proposed API Resource (SP5-C) — user enters the secret + saves */}
      {prefillApiResource && (
        <ApiResourceDialog
          resource={prefillApiResource}
          mode="create"
          onClose={() => setPrefillApiResource(null)}
          onSaved={() => {
            setPrefillApiResource(null)
            showToast('API Resource saved — the AI can now use it to collect and onboard devices.', 'success')
          }}
        />
      )}

      {/* Auto-update checker (Tauri only) */}
      {isTauri && <UpdateChecker />}
      </div>
    </AuthProvider>
  )
}

// Wrapper component that provides the TabSelectionProvider, EnrichmentProvider, and MopExecutionProvider contexts
function App() {
  return (
    <TabSelectionProvider>
      <EnrichmentProvider>
        <MopExecutionProvider>
          <AppContent />
        </MopExecutionProvider>
      </EnrichmentProvider>
    </TabSelectionProvider>
  )
}

export default App
