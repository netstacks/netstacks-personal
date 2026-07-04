import { useState, useEffect, useMemo, useRef } from 'react';
import { getErrorMessage } from '../api/errors';
import { useDirtyGuard } from '../hooks/useDirtyGuard';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import { useMode } from '../hooks/useMode';
import './SessionSettingsDialog.css';
import {
  createSession,
  updateSession,
  listFolders,
  listJumpHosts,
  listSessions,
  getSessionJumpDependents,
  CLI_FLAVOR_OPTIONS,
  PORT_FORWARD_TYPE_OPTIONS,
  type Session,
  type Folder,
  type NewSession,
  type CliFlavor,
  type PortForward,
  type PortForwardType,
  type JumpHost,
  type JumpDependents,
  type Protocol,
  PROTOCOL_OPTIONS,
} from '../api/sessions';
import { listProfiles, type CredentialProfile } from '../api/profiles';
import { TERMINAL_THEMES } from '../lib/terminalThemes';
import SessionContextEditor from './SessionContextEditor';
import DeviceMemoryEditor from './DeviceMemoryEditor';
import ProfileEditorDialog from './ProfileEditorDialog';
import { useCapabilitiesStore } from '../stores/capabilitiesStore';

interface SessionSettingsDialogProps {
  isOpen: boolean;
  session: Session | null;  // null = create mode, session = edit mode
  onClose: () => void;
  onSessionSaved: (session: Session) => void;
  defaultFolderId?: string | null;  // Pre-select folder when creating new session
  /** Callback to preview font changes in real-time on the terminal */
  onPreviewFont?: (fontSize: number | null, fontFamily: string | null) => void;
}

type TabName = 'general' | 'ssh' | 'terminal' | 'context' | 'memory';

// Font family options for terminal
const FONT_FAMILY_OPTIONS = [
  { id: '', label: 'Default (Menlo, Monaco, Consolas)' },
  { id: 'Menlo, Monaco, Consolas, monospace', label: 'Menlo' },
  { id: 'Monaco, Menlo, Consolas, monospace', label: 'Monaco' },
  { id: 'Consolas, Monaco, Menlo, monospace', label: 'Consolas' },
  { id: '"SF Mono", Menlo, Monaco, monospace', label: 'SF Mono' },
  { id: '"Fira Code", Menlo, Monaco, monospace', label: 'Fira Code' },
  { id: '"JetBrains Mono", Menlo, Monaco, monospace', label: 'JetBrains Mono' },
  { id: '"Source Code Pro", Menlo, Monaco, monospace', label: 'Source Code Pro' },
  { id: '"Ubuntu Mono", Menlo, Monaco, monospace', label: 'Ubuntu Mono' },
  { id: '"IBM Plex Mono", Menlo, Monaco, monospace', label: 'IBM Plex Mono' },
  { id: '"Cascadia Code", Menlo, Monaco, monospace', label: 'Cascadia Code' },
  { id: '"Hack", Menlo, Monaco, monospace', label: 'Hack' },
];

// Icons for the dialog
const Icons = {
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  reset: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  ),
};

function SessionSettingsDialog({
  isOpen,
  session,
  onClose,
  onSessionSaved,
  defaultFolderId,
  onPreviewFont,
}: SessionSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<TabName>('general');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
  const [jumpHosts, setJumpHosts] = useState<JumpHost[]>([]);
  const [jumpSessions, setJumpSessions] = useState<Session[]>([]);
  const [jumpDependents, setJumpDependents] = useState<JumpDependents | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  // Inline profile creation from the SSH tab, so a first-time user doesn't
  // have to leave the dialog for Settings → Profiles.
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const hasAITools = useCapabilitiesStore((s) => s.hasFeature('local_ai_tools'));

  // Drag state
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const dialogRef = useRef<HTMLDivElement>(null);

  const isEditing = !!session;
  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? null;

  // General tab state
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [folderId, setFolderId] = useState<string | null>(null);

  const [protocol, setProtocol] = useState<Protocol>('ssh');

  // SSH tab state — jump is encoded as a single string so a single <select>
  // can offer both kinds in optgroups (mutually exclusive at the data layer):
  //   ''             — inherit from profile
  //   'host:<id>'    — use a JumpHost record
  //   'session:<id>' — use another Session as the jump endpoint
  const [jumpSelection, setJumpSelection] = useState<string>('');
  // Jump hosts are a standalone-mode concept. In enterprise mode the Controller
  // is the egress/jump, so the Jump (Bastion) section is hidden entirely.
  const { isEnterprise } = useMode();
  const [legacySsh, setLegacySsh] = useState(false);
  const [portForwards, setPortForwards] = useState<PortForward[]>([]);
  const [newForwardType, setNewForwardType] = useState<PortForwardType>('local');
  const [newLocalPort, setNewLocalPort] = useState<number | ''>('');
  const [newRemoteHost, setNewRemoteHost] = useState('');
  const [newRemotePort, setNewRemotePort] = useState<number | ''>('');

  // Terminal tab state
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [reconnectDelay, setReconnectDelay] = useState(5);
  const [scrollbackLines, setScrollbackLines] = useState(10000);
  const [localEcho, setLocalEcho] = useState(false);
  const [fontSizeOverride, setFontSizeOverride] = useState<number | null>(null);
  const [cliFlavor, setCliFlavor] = useState<CliFlavor>('auto');
  // Auto commands on connect
  const [autoCommands, setAutoCommands] = useState<string[]>([]);
  const [newAutoCommand, setNewAutoCommand] = useState('');

  // SFTP state
  const [sftpStartPath, setSftpStartPath] = useState<string>('');

  // Display state
  const [terminalTheme, setTerminalTheme] = useState<string | null>(null);
  const [fontFamily, setFontFamily] = useState<string | null>(null);

  // Track original font settings for cancel/reset
  const [originalFontSize, setOriginalFontSize] = useState<number | null>(null);
  const [originalFontFamily, setOriginalFontFamily] = useState<string | null>(null);

  // Load session data when dialog opens
  useEffect(() => {
    if (isOpen) {
      if (session) {
        // Edit mode: populate with existing session data
        setName(session.name);
        setHost(session.host);
        setPort(session.port);
        setFolderId(session.folder_id);
        setAutoReconnect(session.auto_reconnect);
        setReconnectDelay(session.reconnect_delay);
        setScrollbackLines(session.scrollback_lines);
        setLocalEcho(session.local_echo);
        setFontSizeOverride(session.font_size_override);
        setOriginalFontSize(session.font_size_override);
        setCliFlavor(session.cli_flavor || 'auto');
        setTerminalTheme(session.terminal_theme || null);
        setFontFamily(session.font_family || null);
        setOriginalFontFamily(session.font_family || null);
        setSelectedProfileId(session.profile_id);
        setProtocol(session.protocol || 'ssh');
        // Encode existing jump ref into the unified selection.
        if (session.jump_host_id) {
          setJumpSelection(`host:${session.jump_host_id}`);
        } else if (session.jump_session_id) {
          setJumpSelection(`session:${session.jump_session_id}`);
        } else {
          setJumpSelection('');
        }
        setLegacySsh(session.legacy_ssh || false);
        setPortForwards(session.port_forwards || []);
        setNewForwardType('local');
        setNewLocalPort('');
        setNewRemoteHost('');
        setNewRemotePort('');
        setAutoCommands(session.auto_commands || []);
        setNewAutoCommand('');
        setSftpStartPath(session.sftp_start_path || '');
      } else {
        // Create mode: reset to defaults
        setName('');
        setHost('');
        setPort(22);
        setFolderId(defaultFolderId || null);
        setAutoReconnect(true);
        setReconnectDelay(5);
        setScrollbackLines(10000);
        setLocalEcho(false);
        setFontSizeOverride(null);
        setOriginalFontSize(null);
        setCliFlavor('auto');
        setTerminalTheme(null);
        setFontFamily(null);
        setOriginalFontFamily(null);
        setSelectedProfileId('');
        setProtocol('ssh');
        setJumpSelection('');
        setLegacySsh(false);
        setPortForwards([]);
        setNewForwardType('local');
        setNewLocalPort('');
        setNewRemoteHost('');
        setNewRemotePort('');
        setAutoCommands([]);
        setNewAutoCommand('');
        setSftpStartPath('');
      }

      // Reset to first tab and clear errors
      setActiveTab('general');
      setError(null);

      // Load folders, profiles, and jump hosts
      listFolders()
        .then(setFolders)
        .catch(() => setFolders([]));
      listProfiles()
        .then(setProfiles)
        .catch(() => setProfiles([]));
      listJumpHosts()
        .then(setJumpHosts)
        .catch(() => setJumpHosts([]));
      // Sessions list (filtered to leaves) feeds the "Sessions" optgroup.
      listSessions()
        .then(setJumpSessions)
        .catch(() => setJumpSessions([]));
      // In edit mode, fetch dependents so the UI can show "used as jump by N".
      if (session) {
        getSessionJumpDependents(session.id)
          .then(setJumpDependents)
          .catch(() => setJumpDependents(null));
      } else {
        setJumpDependents(null);
      }

      // Focus name input after a short delay
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [isOpen, session, defaultFolderId]);

  // Dirty-state guard — snapshot the loaded session (or create-mode
  // defaults) and prompt before discarding edits on close.
  const initialSnapshot = useMemo(() => session ? {
    name: session.name,
    host: session.host,
    port: session.port,
    folderId: session.folder_id,
    selectedProfileId: session.profile_id,
    protocol: session.protocol || 'ssh',
    jumpSelection: session.jump_host_id
      ? `host:${session.jump_host_id}`
      : session.jump_session_id
      ? `session:${session.jump_session_id}`
      : '',
    legacySsh: session.legacy_ssh || false,
    portForwards: session.port_forwards || [],
    autoReconnect: session.auto_reconnect,
    reconnectDelay: session.reconnect_delay,
    scrollbackLines: session.scrollback_lines,
    localEcho: session.local_echo,
    fontSizeOverride: session.font_size_override,
    cliFlavor: session.cli_flavor || 'auto',
    autoCommands: session.auto_commands || [],
    sftpStartPath: session.sftp_start_path || '',
    terminalTheme: session.terminal_theme || null,
    fontFamily: session.font_family || null,
  } : {
    name: '', host: '', port: 22, folderId: defaultFolderId || null,
    selectedProfileId: '', protocol: 'ssh' as Protocol, jumpSelection: '',
    legacySsh: false, portForwards: [] as PortForward[],
    autoReconnect: true, reconnectDelay: 5, scrollbackLines: 10000,
    localEcho: false, fontSizeOverride: null as number | null,
    cliFlavor: 'auto' as CliFlavor, autoCommands: [] as string[],
    sftpStartPath: '', terminalTheme: null as string | null,
    fontFamily: null as string | null,
  }, [session, defaultFolderId]);

  const currentSnapshot = {
    name, host, port, folderId, selectedProfileId, protocol, jumpSelection,
    legacySsh, portForwards, autoReconnect, reconnectDelay, scrollbackLines,
    localEcho, fontSizeOverride, cliFlavor, autoCommands, sftpStartPath,
    terminalTheme, fontFamily,
  };

  const { confirmDiscard, reset: resetDirty } = useDirtyGuard(currentSnapshot, {
    initial: initialSnapshot,
    resetKey: `${session?.id ?? 'new'}:${isOpen ? '1' : '0'}`,
  });

  const handleSave = async () => {
    // Validation
    if (!name.trim()) {
      setError('Name is required');
      setActiveTab('general');
      return;
    }
    if (!host.trim()) {
      setError('Host is required');
      setActiveTab('general');
      return;
    }
    // Profile is required - all auth comes from profile
    if (!selectedProfileId) {
      setError('Credential Profile is required');
      setActiveTab('ssh');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const sessionData: NewSession = {
        name: name.trim(),
        host: host.trim(),
        port,
        folder_id: folderId,
        icon: null,
        color: null,
        auto_reconnect: autoReconnect,
        reconnect_delay: reconnectDelay,
        scrollback_lines: scrollbackLines,
        local_echo: localEcho,
        font_size_override: fontSizeOverride,
        profile_id: selectedProfileId,
        cli_flavor: cliFlavor,
        terminal_theme: terminalTheme,
        font_family: fontFamily,
        // Decode the unified jump selection into mutually-exclusive fields.
        jump_host_id: jumpSelection.startsWith('host:') ? jumpSelection.slice(5) : null,
        jump_session_id: jumpSelection.startsWith('session:') ? jumpSelection.slice(8) : null,
        legacy_ssh: legacySsh,
        port_forwards: portForwards,
        auto_commands: autoCommands,
        protocol,
        sftp_start_path: sftpStartPath || null,
      };

      let savedSession: Session;
      if (isEditing && session) {
        savedSession = await updateSession(session.id, sessionData);
      } else {
        savedSession = await createSession(sessionData);
      }

      // Mark snapshot clean before invoking the close — otherwise the
      // confirmDiscard guard above would re-prompt for these saved edits.
      resetDirty();
      onSessionSaved(savedSession);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, `Failed to ${isEditing ? 'update' : 'create'} session`));
    } finally {
      setSaving(false);
    }
  };

  // Port forwarding handlers (Phase 06.3)
  const handleAddPortForward = () => {
    if (newLocalPort === '') return;
    // Dynamic forwards only need local port
    if (newForwardType !== 'dynamic' && (!newRemoteHost.trim() || newRemotePort === '')) return;

    const newForward: PortForward = {
      id: crypto.randomUUID(),
      forward_type: newForwardType,
      local_port: newLocalPort as number,
      remote_host: newForwardType === 'dynamic' ? null : newRemoteHost.trim(),
      remote_port: newForwardType === 'dynamic' ? null : (newRemotePort as number),
      bind_address: null,
      enabled: true,
    };

    setPortForwards([...portForwards, newForward]);
    setNewLocalPort('');
    setNewRemoteHost('');
    setNewRemotePort('');
  };

  const handleDeletePortForward = (forwardId: string) => {
    setPortForwards(portForwards.filter((f) => f.id !== forwardId));
  };

  const handleTogglePortForward = (forwardId: string) => {
    setPortForwards(
      portForwards.map((f) =>
        f.id === forwardId ? { ...f, enabled: !f.enabled } : f
      )
    );
  };

  const formatPortForward = (fwd: PortForward): string => {
    if (fwd.forward_type === 'dynamic') {
      return `SOCKS on :${fwd.local_port}`;
    }
    const arrow = fwd.forward_type === 'local' ? '->' : '<-';
    return `:${fwd.local_port} ${arrow} ${fwd.remote_host}:${fwd.remote_port}`;
  };

  // Handle font size slider change with live preview
  const handleFontSizeChange = (newSize: number | null) => {
    setFontSizeOverride(newSize);
    onPreviewFont?.(newSize, fontFamily);
  };

  // Handle font family change with live preview
  const handleFontFamilyChange = (newFamily: string | null) => {
    setFontFamily(newFamily);
    onPreviewFont?.(fontSizeOverride, newFamily);
  };

  // Handle dialog close - reset font preview to original values, and
  // prompt to discard any unsaved edits before actually closing.
  const handleClose = async () => {
    if (!(await confirmDiscard())) return;
    onPreviewFont?.(originalFontSize, originalFontFamily);
    onClose();
  };

  const { backdropProps, contentProps } = useOverlayDismiss({
    onDismiss: handleClose,
    enabled: isOpen && !saving,
  });

  // Drag handlers
  const handleDragStart = (e: React.MouseEvent) => {
    // Only start drag from header, not from close button
    if ((e.target as HTMLElement).closest('.settings-dialog-close')) return;

    setIsDragging(true);
    const dialog = dialogRef.current;
    if (dialog) {
      const rect = dialog.getBoundingClientRect();
      dragOffset.current = {
        x: e.clientX - rect.left - rect.width / 2,
        y: e.clientY - rect.top - rect.height / 2,
      };
    }
  };

  const handleDragMove = (e: MouseEvent) => {
    if (!isDragging) return;

    // Calculate new position (offset from the centered origin)
    let newX = e.clientX - window.innerWidth / 2 - dragOffset.current.x;
    let newY = e.clientY - window.innerHeight / 2 - dragOffset.current.y;

    // Clamp so the dialog can never be dragged off-screen (otherwise the header
    // — the only drag handle — becomes unreachable and the dialog is stuck).
    const dialog = dialogRef.current;
    if (dialog) {
      const margin = 8;
      const maxX = Math.max(0, (window.innerWidth - dialog.offsetWidth) / 2 - margin);
      const maxY = Math.max(0, (window.innerHeight - dialog.offsetHeight) / 2 - margin);
      newX = Math.max(-maxX, Math.min(maxX, newX));
      newY = Math.max(-maxY, Math.min(maxY, newY));
    }

    setPosition({ x: newX, y: newY });
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  // Add/remove global mouse listeners for drag
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleDragMove);
      window.addEventListener('mouseup', handleDragEnd);
      return () => {
        window.removeEventListener('mousemove', handleDragMove);
        window.removeEventListener('mouseup', handleDragEnd);
      };
    }
  }, [isDragging]);

  // Auto-switch default port when protocol changes (only in create mode)
  useEffect(() => {
    if (!isEditing) {
      setPort(protocol === 'telnet' ? 23 : 22);
    }
  }, [protocol, isEditing]);

  // Inherit defaults from selected profile (create mode only)
  useEffect(() => {
    if (!isEditing && selectedProfileId) {
      const profile = profiles.find((p) => p.id === selectedProfileId);
      if (profile) {
        setAutoReconnect(profile.auto_reconnect);
        setReconnectDelay(profile.reconnect_delay);
        setScrollbackLines(profile.scrollback_lines);
        setLocalEcho(profile.local_echo);
        setCliFlavor((profile.cli_flavor || 'auto') as CliFlavor);
        setAutoCommands(profile.auto_commands || []);
        setTerminalTheme(profile.terminal_theme || null);
        setFontFamily(profile.default_font_family || null);
        setFontSizeOverride(profile.default_font_size || null);
      }
    }
  }, [selectedProfileId, isEditing, profiles]);

  // Reset position when dialog opens
  useEffect(() => {
    if (isOpen) {
      setPosition({ x: 0, y: 0 });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // In create mode, only show General and SSH tabs (others require saved session)
  const tabs: { id: TabName; label: string; requiresSession?: boolean }[] = [
    { id: 'general', label: 'General' },
    { id: 'ssh', label: protocol === 'telnet' ? 'Auth' : 'SSH' },
    { id: 'terminal', label: 'Terminal' },
    ...(hasAITools ? [{ id: 'context' as TabName, label: 'Context', requiresSession: true }] : []),
    ...(hasAITools ? [{ id: 'memory' as TabName, label: 'Device Memory', requiresSession: true }] : []),
  ];

  const availableTabs = tabs.filter(tab => !tab.requiresSession || isEditing);

  return (
    <div className="settings-dialog-overlay" {...backdropProps}>
      <div
        ref={dialogRef}
        className="settings-dialog"
        style={{
          transform: `translate(${position.x}px, ${position.y}px)`,
        }}
        {...contentProps}
      >
        <div
          className="settings-dialog-header"
          onMouseDown={handleDragStart}
        >
          <h2>{isEditing ? `Edit Session: ${session.name}` : 'New Session'}</h2>
          <button className="settings-dialog-close" onClick={handleClose} title="Close">
            {Icons.close}
          </button>
        </div>

        <div className="settings-dialog-tabs">
          {availableTabs.map((tab) => (
            <button
              key={tab.id}
              className={`settings-dialog-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="settings-dialog-content">
          {error && <div className="settings-dialog-error">{error}</div>}

          {/* General Tab */}
          {activeTab === 'general' && (
            <div className="settings-tab-content">
              <div className="form-group">
                <label htmlFor="session-name">Session Name</label>
                <input
                  ref={nameInputRef}
                  id="session-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Server"
                />
              </div>

              <div className="form-group">
                <label htmlFor="session-protocol">Protocol</label>
                <select
                  id="session-protocol"
                  value={protocol}
                  onChange={(e) => setProtocol(e.target.value as Protocol)}
                >
                  {PROTOCOL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-row">
                <div className="form-group flex-grow">
                  <label htmlFor="session-host">Host</label>
                  <input
                    id="session-host"
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.1 or hostname"
                  />
                </div>
                <div className="form-group" style={{ width: '120px' }}>
                  <label htmlFor="session-port">Port</label>
                  <input
                    id="session-port"
                    type="number"
                    value={port}
                    onChange={(e) => setPort(parseInt(e.target.value) || (protocol === 'telnet' ? 23 : 22))}
                    min={1}
                    max={65535}
                  />
                </div>
              </div>

              {folders.length > 0 && (
                <div className="form-group">
                  <label htmlFor="session-folder">Folder</label>
                  <select
                    id="session-folder"
                    value={folderId || ''}
                    onChange={(e) => setFolderId(e.target.value || null)}
                  >
                    <option value="">No folder</option>
                    {folders.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* SSH Tab */}
          {activeTab === 'ssh' && (
            <div className="settings-tab-content">
              {/* Profile Selector (Required) */}
              <div className="form-section profile-section">
                <h3>Credential Profile <span className="required-marker">*</span></h3>
                <div className="form-group">
                  {profiles.length === 0 ? (
                    <div className="profile-warning">
                      <span>No credential profiles configured.</span>
                      <button
                        type="button"
                        className="btn-secondary profile-create-btn"
                        onClick={() => setProfileEditorOpen(true)}
                      >
                        + Create Profile
                      </button>
                    </div>
                  ) : (
                    <>
                      <select
                        id="credential-profile"
                        value={selectedProfileId}
                        onChange={(e) => setSelectedProfileId(e.target.value)}
                        className={!selectedProfileId ? 'error' : ''}
                      >
                        <option value="">Select a profile...</option>
                        {profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                      <span className="form-hint">
                        {selectedProfile
                          ? `Uses: ${selectedProfile.username}@:${selectedProfile.port} (${selectedProfile.auth_type})`
                          : 'All authentication settings come from the selected profile'}
                        {' · '}
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => setProfileEditorOpen(true)}
                        >
                          New profile
                        </button>
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Jump (Bastion) Section — SSH only. Either a JumpHost record
                  or another Session can be selected as the jump endpoint. */}
              {!isEnterprise && protocol === 'ssh' && <div className="form-section">
                <h3>Jump (Bastion)</h3>
                <p className="form-hint">
                  Connect through an intermediary SSH server. You can pick another Session
                  as the jump (one source of truth per machine) or a dedicated Jump Host record.
                </p>

                <div className="form-group">
                  <label htmlFor="jump-host">Jump</label>
                  <select
                    id="jump-host"
                    value={jumpSelection}
                    onChange={(e) => setJumpSelection(e.target.value)}
                  >
                    {(() => {
                      // The "inherit" option label reflects what the profile would
                      // give us — could be a JumpHost OR a Session OR direct.
                      const profile = selectedProfile;
                      let inheritedName = 'direct';
                      if (profile?.jump_host_id) {
                        inheritedName = jumpHosts.find(j => j.id === profile.jump_host_id)?.name ?? '(deleted jump host)';
                      } else if (profile?.jump_session_id) {
                        const sess = jumpSessions.find(s => s.id === profile.jump_session_id);
                        inheritedName = sess ? `session: ${sess.name}` : '(deleted session)';
                      }
                      return (
                        <option value="">{`Inherit from profile (${inheritedName})`}</option>
                      );
                    })()}
                    {jumpSessions.length > 0 && (
                      <optgroup label="Sessions">
                        {jumpSessions
                          // Don't let the user pick THIS session as its own jump.
                          .filter((s) => !session || s.id !== session.id)
                          .map((s) => (
                            <option key={`session:${s.id}`} value={`session:${s.id}`}>
                              {s.name} ({s.host})
                            </option>
                          ))}
                      </optgroup>
                    )}
                    {jumpHosts.length > 0 && (
                      <optgroup label="Jump Hosts">
                        {jumpHosts.map((jh) => {
                          const jumpProfile = profiles.find(p => p.id === jh.profile_id);
                          return (
                            <option key={`host:${jh.id}`} value={`host:${jh.id}`}>
                              {jh.name} ({jumpProfile?.username || '?'}@{jh.host}:{jh.port})
                            </option>
                          );
                        })}
                      </optgroup>
                    )}
                  </select>
                  <span className="form-hint">
                    By default the session inherits the jump configured on its profile.
                    Pick a different one here to override. Manage Jump Host records in
                    Settings &gt; Jump Hosts.
                  </span>
                </div>

                {/* "Used as jump by N" hint — visible when editing an existing
                    session that other artifacts depend on. */}
                {jumpDependents && (jumpDependents.sessions.length > 0
                    || jumpDependents.tunnels.length > 0
                    || jumpDependents.profiles.length > 0) && (
                  <div className="form-hint" style={{ marginTop: '0.5rem' }}>
                    <strong>Used as jump by:</strong>{' '}
                    {[
                      jumpDependents.sessions.length > 0 && `${jumpDependents.sessions.length} session(s)`,
                      jumpDependents.tunnels.length > 0 && `${jumpDependents.tunnels.length} tunnel(s)`,
                      jumpDependents.profiles.length > 0 && `${jumpDependents.profiles.length} profile(s)`,
                    ].filter(Boolean).join(', ')}.
                    {' '}This session must remain a leaf — adding a jump here will be rejected by the agent.
                  </div>
                )}
              </div>}

              {/* Port Forwarding Section (Phase 06.3) - SSH only */}
              {protocol === 'ssh' && <div className="form-section">
                <h3>Port Forwarding</h3>
                <p className="form-hint">
                  Create SSH tunnels to access remote services locally or expose local services to the remote host.
                </p>

                <div className="port-forwards-list">
                  {portForwards.map((fwd) => (
                    <div key={fwd.id} className={`port-forward-item ${!fwd.enabled ? 'disabled' : ''}`}>
                      <label className="toggle toggle-small">
                        <input
                          type="checkbox"
                          checked={fwd.enabled}
                          onChange={() => handleTogglePortForward(fwd.id)}
                        />
                        <span className="toggle-slider" />
                      </label>
                      <span className="port-forward-type">
                        {PORT_FORWARD_TYPE_OPTIONS.find(o => o.value === fwd.forward_type)?.label || fwd.forward_type}
                      </span>
                      <span className="port-forward-spec">{formatPortForward(fwd)}</span>
                      <button
                        className="port-forward-delete"
                        onClick={() => handleDeletePortForward(fwd.id)}
                        title="Delete"
                      >
                        {Icons.trash}
                      </button>
                    </div>
                  ))}
                </div>

                <div className="port-forward-add">
                  <select
                    value={newForwardType}
                    onChange={(e) => setNewForwardType(e.target.value as PortForwardType)}
                    className="port-forward-type-select"
                    title="Forward type"
                  >
                    {PORT_FORWARD_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value} title={opt.description}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    placeholder="Local port"
                    value={newLocalPort}
                    onChange={(e) => setNewLocalPort(e.target.value ? parseInt(e.target.value) : '')}
                    className="port-forward-input port-forward-local"
                    min={1}
                    max={65535}
                  />
                  {newForwardType !== 'dynamic' && (
                    <>
                      <span className="port-forward-arrow">
                        {newForwardType === 'local' ? '->' : '<-'}
                      </span>
                      <input
                        type="text"
                        placeholder="Remote host"
                        value={newRemoteHost}
                        onChange={(e) => setNewRemoteHost(e.target.value)}
                        className="port-forward-input port-forward-host"
                      />
                      <input
                        type="number"
                        placeholder="Port"
                        value={newRemotePort}
                        onChange={(e) => setNewRemotePort(e.target.value ? parseInt(e.target.value) : '')}
                        className="port-forward-input port-forward-remote"
                        min={1}
                        max={65535}
                      />
                    </>
                  )}
                  <button
                    className="btn-icon"
                    onClick={handleAddPortForward}
                    disabled={
                      newLocalPort === '' ||
                      (newForwardType !== 'dynamic' && (!newRemoteHost.trim() || newRemotePort === ''))
                    }
                    title="Add port forward"
                  >
                    {Icons.plus}
                  </button>
                </div>
              </div>}

              {/* Legacy SSH Section - SSH only */}
              {protocol === 'ssh' && <div className="form-section">
                <h3>Compatibility</h3>
                <p className="form-hint">
                  Options for connecting to older or specialized network devices.
                </p>

                <div className="form-group">
                  <div className="setting-row">
                    <div>
                      <label>Legacy SSH Algorithms</label>
                      <span className="form-hint">
                        Enable older, less secure algorithms for compatibility with legacy devices (e.g., older Cisco switches, HP ProCurve, etc.).
                      </span>
                    </div>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={legacySsh}
                        onChange={(e) => setLegacySsh(e.target.checked)}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                </div>
              </div>}

              {/* SFTP Starting Directory - SSH only */}
              {protocol === 'ssh' && <div className="form-group">
                <label htmlFor="sftp-start-path">SFTP Starting Directory</label>
                <input
                  id="sftp-start-path"
                  type="text"
                  value={sftpStartPath}
                  onChange={(e) => setSftpStartPath(e.target.value)}
                  placeholder="e.g. /var/log or disk0:/ (optional)"
                  className="form-input"
                />
                <span className="form-hint">
                  Directory to open when starting SFTP. Leave empty for auto-detect based on device type.
                </span>
              </div>}
            </div>
          )}

          {/* Terminal Tab */}
          {activeTab === 'terminal' && (
            <div className="settings-tab-content">
              <div className="form-group">
                <div className="setting-row">
                  <div>
                    <label>Auto-Reconnect</label>
                    <span className="form-hint">Automatically reconnect when disconnected</span>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={autoReconnect}
                      onChange={(e) => setAutoReconnect(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </div>

              {autoReconnect && (
                <div className="form-group">
                  <label htmlFor="reconnect-delay">Reconnect Delay (seconds)</label>
                  <input
                    id="reconnect-delay"
                    type="number"
                    value={reconnectDelay}
                    onChange={(e) => setReconnectDelay(parseInt(e.target.value) || 5)}
                    min={1}
                    max={60}
                    style={{ width: '100px' }}
                  />
                </div>
              )}

              <div className="form-group">
                <label htmlFor="scrollback-lines">Scrollback Lines</label>
                <input
                  id="scrollback-lines"
                  type="number"
                  value={scrollbackLines}
                  onChange={(e) => setScrollbackLines(parseInt(e.target.value) || 10000)}
                  min={100}
                  max={100000}
                  style={{ width: '120px' }}
                />
                <span className="form-hint">Number of lines to keep in terminal history</span>
              </div>

              <div className="form-group">
                <div className="setting-row">
                  <div>
                    <label>Local Echo</label>
                    <span className="form-hint">Echo typed characters locally</span>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={localEcho}
                      onChange={(e) => setLocalEcho(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </div>

              <div className="form-section">
                <h3>Auto Commands on Connect</h3>
                <p className="form-hint" style={{ marginTop: 0 }}>
                  Commands that run automatically after SSH connection establishes. Useful for "enable", "terminal length 0", etc.
                </p>

                {autoCommands.length > 0 && (
                  <div className="auto-commands-list">
                    {autoCommands.map((cmd, index) => (
                      <div key={index} className="auto-command-item">
                        <code>{cmd}</code>
                        <button
                          type="button"
                          className="btn-icon btn-danger-icon"
                          onClick={() => {
                            setAutoCommands(autoCommands.filter((_, i) => i !== index));
                          }}
                          title="Remove command"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <div className="input-group">
                    <input
                      type="text"
                      value={newAutoCommand}
                      onChange={(e) => setNewAutoCommand(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newAutoCommand.trim()) {
                          e.preventDefault();
                          setAutoCommands([...autoCommands, newAutoCommand.trim()]);
                          setNewAutoCommand('');
                        }
                      }}
                      placeholder="Enter command..."
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        if (newAutoCommand.trim()) {
                          setAutoCommands([...autoCommands, newAutoCommand.trim()]);
                          setNewAutoCommand('');
                        }
                      }}
                      disabled={!newAutoCommand.trim()}
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>

              <div className="form-section">
                <h3>AI Features</h3>
                <div className="form-group">
                  <label htmlFor="cli-flavor">CLI Flavor</label>
                  <select
                    id="cli-flavor"
                    value={cliFlavor}
                    onChange={(e) => setCliFlavor(e.target.value as CliFlavor)}
                  >
                    {CLI_FLAVOR_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="form-hint">
                    Set the device CLI type for AI command suggestions. Auto-detect lets the AI figure it out from context.
                  </span>
                </div>
              </div>

              <div className="form-section">
                <h3>Display</h3>
                <div className="form-group">
                  <label>Terminal Theme</label>
                  <select
                    value={terminalTheme || ''}
                    onChange={(e) => setTerminalTheme(e.target.value || null)}
                  >
                    <option value="">Default</option>
                    {TERMINAL_THEMES.map((theme) => (
                      <option key={theme.id} value={theme.id}>
                        {theme.name}
                      </option>
                    ))}
                  </select>
                  <span className="form-hint">
                    Color theme for this session's terminal. Leave as Default to use the global setting.
                  </span>
                </div>

                <div className="form-group">
                  <label>Font Family</label>
                  <select
                    value={fontFamily || ''}
                    onChange={(e) => handleFontFamilyChange(e.target.value || null)}
                  >
                    {FONT_FAMILY_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="form-hint">
                    Font for this session's terminal. Requires the font to be installed on your system.
                  </span>
                </div>

                <div className="form-group">
                  <label htmlFor="session-font-size">
                    Font Size: {fontSizeOverride ?? 14}px
                  </label>
                  <div className="slider-container">
                    <span className="slider-label">8</span>
                    <input
                      id="session-font-size"
                      type="range"
                      value={fontSizeOverride ?? 14}
                      onChange={(e) => handleFontSizeChange(parseInt(e.target.value))}
                      min={8}
                      max={32}
                      step={1}
                      className="font-size-slider"
                    />
                    <span className="slider-label">32</span>
                  </div>
                  <span className="form-hint">
                    Drag to adjust font size. Changes preview in real-time.
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Context Tab (only for existing sessions) */}
          {activeTab === 'context' && isEditing && session && (
            <div className="settings-tab-content">
              <SessionContextEditor
                sessionId={session.id}
                currentUser={selectedProfile?.username || 'Unknown'}
              />
            </div>
          )}

          {/* Device Memory Tab (only for existing sessions) */}
          {activeTab === 'memory' && isEditing && session && (
            <div className="settings-tab-content">
              <DeviceMemoryEditor
                sessionId={session.id}
                currentUser={selectedProfile?.username || 'Unknown'}
              />
            </div>
          )}
        </div>

        <div className="settings-dialog-actions">
          <button className="btn-secondary" onClick={handleClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>

        {/* Inline profile creation (SSH tab shortcut) */}
        <ProfileEditorDialog
          isOpen={profileEditorOpen}
          profile={null}
          cloneFrom={null}
          profiles={profiles}
          onClose={() => setProfileEditorOpen(false)}
          onSaved={() => {
            setProfileEditorOpen(false);
            const known = new Set(profiles.map((p) => p.id));
            listProfiles()
              .then((next) => {
                setProfiles(next);
                // Auto-select the profile that was just created.
                const created = next.find((p) => !known.has(p.id));
                if (created) setSelectedProfileId(created.id);
              })
              .catch(() => {});
            window.dispatchEvent(new Event('profiles-changed'));
          }}
        />
      </div>
    </div>
  );
}

export default SessionSettingsDialog;
