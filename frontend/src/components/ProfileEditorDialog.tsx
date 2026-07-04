import { useState, useEffect, useMemo, useRef } from 'react';
import { PasswordInput } from './PasswordInput';
import {
  createProfile,
  updateProfile,
  storeProfileCredential,
  getProfileCredentialMeta,
  type CredentialProfile,
  type NewCredentialProfile,
  type AuthType,
} from '../api/profiles';
import { CLI_FLAVOR_OPTIONS, listJumpHosts, listSessions, type CliFlavor, type JumpHost, type Session } from '../api/sessions';
import { TERMINAL_THEMES } from '../lib/terminalThemes';
import { useDirtyGuard } from '../hooks/useDirtyGuard';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import { useMode } from '../hooks/useMode';
import './ProfileEditorDialog.css';

import { getErrorMessage } from '../api/errors'
interface ProfileEditorDialogProps {
  isOpen: boolean;
  profile: CredentialProfile | null; // null = create mode
  cloneFrom: CredentialProfile | null; // non-null = clone mode
  profiles: CredentialProfile[]; // For reference (unused now, kept for API compat)
  onClose: () => void;
  onSaved: () => void;
}

type TabName = 'auth' | 'conn' | 'snmp' | 'terminal';

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
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
};

export default function ProfileEditorDialog({
  isOpen,
  profile,
  cloneFrom,
  profiles: _profiles,
  onClose,
  onSaved,
}: ProfileEditorDialogProps) {
  const [activeTab, setActiveTab] = useState<TabName>('auth');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track the id of the profile we just created so a retry after a
  // credential-storage failure becomes an update rather than another
  // create — without this, the user got a duplicate profile per click.
  // Audit P1-11.
  const [persistedProfileId, setPersistedProfileId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Either the parent gave us a profile to edit, OR we already
  // persisted one this dialog session (e.g. previous save succeeded
  // but credential storage failed). Both paths mean the next save
  // is an update, not a create.
  const isEditing = !!profile || !!persistedProfileId;
  const sourceProfile = cloneFrom || profile;

  // Auth tab state
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [authType, setAuthType] = useState<AuthType>('password');
  const [password, setPassword] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [keyPassphrase, setKeyPassphrase] = useState('');

  // Connection tab state
  const [port, setPort] = useState(22);
  const [keepaliveInterval, setKeepaliveInterval] = useState(30);
  const [connectionTimeout, setConnectionTimeout] = useState(30);

  // SNMP tab state
  const [snmpCommunities, setSnmpCommunities] = useState<string[]>([]);
  const [newCommunity, setNewCommunity] = useState('');
  const [existingCommunityCount, setExistingCommunityCount] = useState(0);

  // Terminal tab state
  const [terminalTheme, setTerminalTheme] = useState<string | null>(null);
  const [defaultFontSize, setDefaultFontSize] = useState<number | null>(null);
  const [defaultFontFamily, setDefaultFontFamily] = useState<string | null>(null);
  const [scrollbackLines, setScrollbackLines] = useState(10000);
  const [localEcho, setLocalEcho] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [reconnectDelay, setReconnectDelay] = useState(5);
  const [cliFlavor, setCliFlavor] = useState<CliFlavor>('auto');
  const [autoCommands, setAutoCommands] = useState<string[]>([]);
  const [newAutoCommand, setNewAutoCommand] = useState('');

  // Jump (default for sessions/tunnels using this profile). Encoded as a
  // single string so a single <select> can offer both kinds in optgroups:
  //   ''             — none / direct
  //   'host:<id>'    — use a JumpHost record
  //   'session:<id>' — use another Session as the jump endpoint
  const [jumpSelection, setJumpSelection] = useState<string>('');
  // Jump hosts are a standalone-mode concept. In enterprise mode the Controller
  // is the egress/jump, so the jump selector is hidden entirely.
  const { isEnterprise } = useMode();
  const [jumpHosts, setJumpHosts] = useState<JumpHost[]>([]);
  const [jumpSessions, setJumpSessions] = useState<Session[]>([]);

  // Load jump hosts AND sessions whenever the dialog opens (so the dropdown is fresh).
  useEffect(() => {
    if (isOpen) {
      listJumpHosts().then(setJumpHosts).catch(() => setJumpHosts([]));
      listSessions().then(setJumpSessions).catch(() => setJumpSessions([]));
    }
  }, [isOpen]);

  // Load profile data when dialog opens
  useEffect(() => {
    if (isOpen) {
      if (sourceProfile) {
        // Edit or clone mode: populate from source profile
        setName(cloneFrom ? `${sourceProfile.name} (copy)` : sourceProfile.name);
        setUsername(sourceProfile.username);
        setAuthType(sourceProfile.auth_type);
        setKeyPath(sourceProfile.key_path || '');
        setPassword(''); // Don't expose stored password
        setKeyPassphrase('');

        // Connection
        setPort(sourceProfile.port);
        setKeepaliveInterval(sourceProfile.keepalive_interval);
        setConnectionTimeout(sourceProfile.connection_timeout);

        // Terminal
        setTerminalTheme(sourceProfile.terminal_theme);
        setDefaultFontSize(sourceProfile.default_font_size);
        setDefaultFontFamily(sourceProfile.default_font_family);
        setScrollbackLines(sourceProfile.scrollback_lines);
        setLocalEcho(sourceProfile.local_echo);
        setAutoReconnect(sourceProfile.auto_reconnect);
        setReconnectDelay(sourceProfile.reconnect_delay);
        setCliFlavor((sourceProfile.cli_flavor || 'auto') as CliFlavor);
        setAutoCommands(sourceProfile.auto_commands || []);
        // Encode existing jump ref (host or session) into the unified selection.
        if (sourceProfile.jump_host_id) {
          setJumpSelection(`host:${sourceProfile.jump_host_id}`);
        } else if (sourceProfile.jump_session_id) {
          setJumpSelection(`session:${sourceProfile.jump_session_id}`);
        } else {
          setJumpSelection('');
        }

        // Load SNMP community count from vault metadata (edit mode only)
        if (profile && !cloneFrom) {
          getProfileCredentialMeta(profile.id).then((meta) => {
            setExistingCommunityCount(meta.snmp_community_count);
          }).catch(() => setExistingCommunityCount(0));
        } else {
          setExistingCommunityCount(0);
        }
      } else {
        // Create mode: reset to defaults
        setName('');
        setUsername('');
        setAuthType('password');
        setPassword('');
        setKeyPath('');
        setKeyPassphrase('');
        setPort(22);
        setKeepaliveInterval(30);
        setConnectionTimeout(30);
        setSnmpCommunities([]);
        setExistingCommunityCount(0);
        setTerminalTheme(null);
        setDefaultFontSize(null);
        setDefaultFontFamily(null);
        setScrollbackLines(10000);
        setLocalEcho(false);
        setAutoReconnect(true);
        setReconnectDelay(5);
        setCliFlavor('auto');
        setAutoCommands([]);
        setJumpSelection('');
      }

      // Reset to first tab and clear errors
      setActiveTab('auth');
      setError(null);
      setNewCommunity('');
      setNewAutoCommand('');
      // Reset retry-tracking — a fresh dialog open is a fresh session.
      // Without this, closing+reopening Create mode after a credential
      // failure would still update-instead-of-create.
      setPersistedProfileId(null);

      // Focus name input after a short delay
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [isOpen, sourceProfile, cloneFrom]);

  // Dirty-state guard — snapshot the loaded profile (or the create-mode
  // defaults) and prompt before discarding edits on close. Includes the
  // user-facing field values; tab state and the in-progress
  // newCommunity/newAutoCommand buffers are deliberately excluded.
  const initialSnapshot = useMemo(
    () =>
      sourceProfile
        ? {
            name: cloneFrom ? `${sourceProfile.name} (copy)` : sourceProfile.name,
            username: sourceProfile.username,
            authType: sourceProfile.auth_type,
            keyPath: sourceProfile.key_path || '',
            password: '',
            keyPassphrase: '',
            port: sourceProfile.port,
            keepaliveInterval: sourceProfile.keepalive_interval,
            connectionTimeout: sourceProfile.connection_timeout,
            terminalTheme: sourceProfile.terminal_theme,
            defaultFontSize: sourceProfile.default_font_size,
            defaultFontFamily: sourceProfile.default_font_family,
            scrollbackLines: sourceProfile.scrollback_lines,
            localEcho: sourceProfile.local_echo,
            autoReconnect: sourceProfile.auto_reconnect,
            reconnectDelay: sourceProfile.reconnect_delay,
            cliFlavor: (sourceProfile.cli_flavor || 'auto') as CliFlavor,
            autoCommands: sourceProfile.auto_commands || [],
            snmpCommunities: [] as string[],
            jumpSelection: sourceProfile.jump_host_id
              ? `host:${sourceProfile.jump_host_id}`
              : sourceProfile.jump_session_id
              ? `session:${sourceProfile.jump_session_id}`
              : '',
          }
        : {
            name: '',
            username: '',
            authType: 'password' as AuthType,
            keyPath: '',
            password: '',
            keyPassphrase: '',
            port: 22,
            keepaliveInterval: 30,
            connectionTimeout: 30,
            terminalTheme: null as string | null,
            defaultFontSize: null as number | null,
            defaultFontFamily: null as string | null,
            scrollbackLines: 10000,
            localEcho: false,
            autoReconnect: true,
            reconnectDelay: 5,
            cliFlavor: 'auto' as CliFlavor,
            autoCommands: [] as string[],
            snmpCommunities: [] as string[],
            jumpSelection: '',
          },
    [sourceProfile, cloneFrom],
  );

  const currentSnapshot = {
    name, username, authType, keyPath, password, keyPassphrase, port,
    keepaliveInterval, connectionTimeout, terminalTheme, defaultFontSize,
    defaultFontFamily, scrollbackLines, localEcho, autoReconnect,
    reconnectDelay, cliFlavor, autoCommands, snmpCommunities, jumpSelection,
  };

  const { confirmDiscard, reset: resetDirty } = useDirtyGuard(currentSnapshot, {
    initial: initialSnapshot,
    resetKey: `${sourceProfile?.id ?? 'new'}:${cloneFrom ? 'clone' : 'edit'}:${isOpen ? '1' : '0'}`,
  });

  const guardedClose = async () => {
    if (await confirmDiscard()) onClose();
  };

  const { backdropProps, contentProps } = useOverlayDismiss({
    onDismiss: guardedClose,
    enabled: isOpen && !saving,
  });

  const handleSave = async () => {
    // Validation
    if (!name.trim()) {
      setError('Name is required');
      setActiveTab('auth');
      return;
    }
    if (!username.trim()) {
      setError('Username is required');
      setActiveTab('auth');
      return;
    }
    if (authType === 'key' && !keyPath.trim()) {
      setError('Key file path is required for public key authentication');
      setActiveTab('auth');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const profileData: NewCredentialProfile = {
        name: name.trim(),
        username: username.trim(),
        auth_type: authType,
        key_path: authType === 'key' && keyPath.trim() ? keyPath.trim() : null,
        port,
        keepalive_interval: keepaliveInterval,
        connection_timeout: connectionTimeout,
        terminal_theme: terminalTheme,
        default_font_size: defaultFontSize,
        default_font_family: defaultFontFamily,
        scrollback_lines: scrollbackLines,
        local_echo: localEcho,
        auto_reconnect: autoReconnect,
        reconnect_delay: reconnectDelay,
        cli_flavor: cliFlavor,
        auto_commands: autoCommands,
        // Decode the unified jump selection into mutually-exclusive fields.
        jump_host_id: jumpSelection.startsWith('host:') ? jumpSelection.slice(5) : null,
        jump_session_id: jumpSelection.startsWith('session:') ? jumpSelection.slice(8) : null,
      };

      let savedProfile: CredentialProfile;
      // Three cases:
      //   • parent passed `profile` → edit that
      //   • we created one earlier this session (persistedProfileId) → edit it
      //   • neither → first-time create
      const updateId = profile?.id ?? persistedProfileId;
      if (updateId) {
        savedProfile = await updateProfile(updateId, profileData);
      } else {
        savedProfile = await createProfile(profileData);
        // Remember the id so a retry after credential-storage failure
        // updates instead of creating a duplicate (audit P1-11).
        setPersistedProfileId(savedProfile.id);
      }

      // Store credentials in vault if provided
      const hasCredential =
        (authType === 'password' && password.trim()) ||
        (authType === 'key' && keyPassphrase.trim()) ||
        snmpCommunities.length > 0;

      if (hasCredential) {
        try {
          await storeProfileCredential(savedProfile.id, {
            password: authType === 'password' && password.trim() ? password.trim() : undefined,
            key_passphrase: authType === 'key' && keyPassphrase.trim() ? keyPassphrase.trim() : undefined,
            snmp_communities: snmpCommunities.length > 0 ? snmpCommunities : undefined,
          });
        } catch (credErr) {
          console.error('Failed to store credentials:', credErr);
          const errMsg = getErrorMessage(credErr, 'Failed to store credentials');
          setError(`Profile saved, but credentials failed: ${errMsg}`);
          setSaving(false);
          return;
        }
      }

      // Mark snapshot clean before invoking onSaved (which usually
      // closes the dialog) so the close path doesn't re-prompt.
      resetDirty();
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err, `Failed to ${isEditing ? 'update' : 'create'} profile`));
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const tabs: { id: TabName; label: string }[] = [
    { id: 'auth', label: 'Auth' },
    { id: 'conn', label: 'Connection' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'snmp', label: 'SNMP' },
  ];

  const dialogTitle = cloneFrom
    ? 'Clone Profile'
    : isEditing
    ? `Edit Profile: ${profile?.name}`
    : 'New Profile';

  return (
    <div className="profile-dialog-overlay" {...backdropProps}>
      <div className="profile-dialog" {...contentProps}>
        <div className="profile-dialog-header">
          <h2>{dialogTitle}</h2>
          <button className="profile-dialog-close" onClick={guardedClose} title="Close" disabled={saving}>
            {Icons.close}
          </button>
        </div>

        <div className="profile-dialog-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`profile-dialog-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="profile-dialog-content">
          {error && <div className="profile-dialog-error">{error}</div>}

          {/* Auth Tab */}
          {activeTab === 'auth' && (
            <div className="profile-tab-content">
              <div className="form-section">
                <h3>Profile Identity</h3>
                <div className="form-group">
                  <label htmlFor="profile-name">Profile Name</label>
                  <input
                    ref={nameInputRef}
                    id="profile-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g., Cisco Production"
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="profile-username">Username</label>
                  <input
                    id="profile-username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                  />
                </div>
              </div>

              <div className="form-section">
                <h3>Authentication</h3>
                <div className="form-group">
                  <label>Auth Type</label>
                  <div className="radio-group">
                    <label className="radio-label">
                      <input
                        type="radio"
                        name="auth-type"
                        value="password"
                        checked={authType === 'password'}
                        onChange={() => setAuthType('password')}
                      />
                      <span>Password</span>
                    </label>
                    <label className="radio-label">
                      <input
                        type="radio"
                        name="auth-type"
                        value="key"
                        checked={authType === 'key'}
                        onChange={() => setAuthType('key')}
                      />
                      <span>Public Key</span>
                    </label>
                  </div>
                </div>

                {authType === 'password' && (
                  <div className="form-group">
                    <label htmlFor="profile-password">Password</label>
                    <PasswordInput
                      id="profile-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={isEditing ? '(leave blank to keep existing)' : 'Enter password'}
                    />
                    <span className="form-hint">Stored securely in the vault</span>
                  </div>
                )}

                {authType === 'key' && (
                  <>
                    <div className="form-group">
                      <label htmlFor="profile-key-path">Key File Path</label>
                      <input
                        id="profile-key-path"
                        type="text"
                        value={keyPath}
                        onChange={(e) => setKeyPath(e.target.value)}
                        placeholder="~/.ssh/id_ed25519"
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="profile-key-passphrase">Key Passphrase (optional)</label>
                      <PasswordInput
                        id="profile-key-passphrase"
                        value={keyPassphrase}
                        onChange={(e) => setKeyPassphrase(e.target.value)}
                        placeholder={isEditing ? '(leave blank to keep existing)' : 'If key is encrypted'}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Connection Tab */}
          {activeTab === 'conn' && (
            <div className="profile-tab-content">
              <div className="form-section">
                <h3>Connection Settings</h3>
                <div className="form-group">
                  <label htmlFor="profile-port">Default Port</label>
                  <input
                    id="profile-port"
                    type="number"
                    value={port}
                    onChange={(e) => setPort(parseInt(e.target.value) || 22)}
                    min={1}
                    max={65535}
                    style={{ width: '100px' }}
                  />
                  <span className="form-hint">SSH port (default: 22)</span>
                </div>

                <div className="form-group">
                  <label htmlFor="keepalive-interval">Keepalive Interval (seconds)</label>
                  <input
                    id="keepalive-interval"
                    type="number"
                    value={keepaliveInterval}
                    onChange={(e) => setKeepaliveInterval(parseInt(e.target.value) || 30)}
                    min={0}
                    max={600}
                    style={{ width: '100px' }}
                  />
                  <span className="form-hint">Seconds between keepalive packets (0 to disable)</span>
                </div>

                <div className="form-group">
                  <label htmlFor="connection-timeout">Connection Timeout (seconds)</label>
                  <input
                    id="connection-timeout"
                    type="number"
                    value={connectionTimeout}
                    onChange={(e) => setConnectionTimeout(parseInt(e.target.value) || 30)}
                    min={1}
                    max={300}
                    style={{ width: '100px' }}
                  />
                  <span className="form-hint">Timeout for establishing connection</span>
                </div>

                {!isEnterprise && (
                <div className="form-group">
                  <label htmlFor="profile-jump-host">Default Jump</label>
                  <select
                    id="profile-jump-host"
                    value={jumpSelection}
                    onChange={(e) => setJumpSelection(e.target.value)}
                  >
                    <option value="">(None — direct connect)</option>
                    {jumpSessions.length > 0 && (
                      <optgroup label="Sessions">
                        {jumpSessions.map((s) => (
                          <option key={`session:${s.id}`} value={`session:${s.id}`}>
                            {s.name} ({s.host})
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {jumpHosts.length > 0 && (
                      <optgroup label="Jump Hosts">
                        {jumpHosts.map((jh) => (
                          <option key={`host:${jh.id}`} value={`host:${jh.id}`}>
                            {jh.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <span className="form-hint">
                    Sessions and tunnels using this profile connect through this jump
                    by default. You can pick another Session as the jump (one source
                    of truth per machine) or use a dedicated Jump Host record.
                    Can be overridden per-session or per-tunnel.
                  </span>
                </div>
                )}
              </div>
            </div>
          )}

          {/* Terminal Tab */}
          {activeTab === 'terminal' && (
            <div className="profile-tab-content">
              <div className="form-section">
                <h3>Behavior</h3>
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
                    <label htmlFor="profile-reconnect-delay">Reconnect Delay (seconds)</label>
                    <input
                      id="profile-reconnect-delay"
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
                  <label htmlFor="profile-scrollback">Scrollback Lines</label>
                  <input
                    id="profile-scrollback"
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

                <div className="form-group">
                  <label htmlFor="profile-cli-flavor">CLI Flavor</label>
                  <select
                    id="profile-cli-flavor"
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
                    Default CLI type for AI command suggestions on sessions using this profile
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
                    Default terminal theme for sessions using this profile
                  </span>
                </div>

                <div className="form-group">
                  <label>Font Family</label>
                  <select
                    value={defaultFontFamily || ''}
                    onChange={(e) => setDefaultFontFamily(e.target.value || null)}
                  >
                    {FONT_FAMILY_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="form-hint">
                    Default font for sessions using this profile
                  </span>
                </div>

                <div className="form-group">
                  <label htmlFor="profile-font-size">
                    Font Size: {defaultFontSize ?? 14}px
                  </label>
                  <div className="slider-container">
                    <span className="slider-label">8</span>
                    <input
                      id="profile-font-size"
                      type="range"
                      value={defaultFontSize ?? 14}
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        setDefaultFontSize(val === 14 ? null : val);
                      }}
                      min={8}
                      max={32}
                      step={1}
                      className="font-size-slider"
                    />
                    <span className="slider-label">32</span>
                  </div>
                  <span className="form-hint">
                    Default font size for sessions using this profile. 14 = system default.
                  </span>
                </div>
              </div>

              <div className="form-section">
                <h3>Auto Commands on Connect</h3>
                <p className="form-hint" style={{ marginTop: 0 }}>
                  Default commands that run automatically after connection. Sessions can override these.
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
            </div>
          )}

          {/* SNMP Tab */}
          {activeTab === 'snmp' && (
            <div className="profile-tab-content">
              <div className="form-section">
                <h3>SNMP Community Strings</h3>
                <div className="form-hint-block">
                  Community strings used for SNMPv2c polling. Multiple communities are tried in order
                  when discovering devices. Stored encrypted in the vault.
                </div>

                {existingCommunityCount > 0 && snmpCommunities.length === 0 && (
                  <div className="snmp-existing-indicator">
                    {existingCommunityCount} community {existingCommunityCount === 1 ? 'string' : 'strings'} configured.
                    Add new ones below to replace them.
                  </div>
                )}

                {snmpCommunities.length > 0 && (
                  <div className="snmp-communities-list">
                    {snmpCommunities.map((community, index) => (
                      <div key={index} className="snmp-community-item">
                        <span className="snmp-community-value">{'•'.repeat(community.length)}</span>
                        <button
                          className="snmp-community-delete"
                          onClick={() => setSnmpCommunities(snmpCommunities.filter((_, i) => i !== index))}
                          title="Remove"
                        >
                          {Icons.trash}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="snmp-community-add">
                  <PasswordInput
                    placeholder="Community string (e.g., public)"
                    value={newCommunity}
                    onChange={(e) => setNewCommunity(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newCommunity.trim()) {
                        setSnmpCommunities([...snmpCommunities, newCommunity.trim()]);
                        setNewCommunity('');
                      }
                    }}
                    className="snmp-community-input"
                  />
                  <button
                    className="btn-icon-small"
                    onClick={() => {
                      if (newCommunity.trim()) {
                        setSnmpCommunities([...snmpCommunities, newCommunity.trim()]);
                        setNewCommunity('');
                      }
                    }}
                    disabled={!newCommunity.trim()}
                    title="Add"
                  >
                    {Icons.plus}
                  </button>
                </div>

                {snmpCommunities.length > 0 && existingCommunityCount > 0 && (
                  <span className="form-hint form-hint-warning">
                    Saving will replace the existing {existingCommunityCount} community {existingCommunityCount === 1 ? 'string' : 'strings'}.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="profile-dialog-actions">
          <button className="btn-secondary" onClick={guardedClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
