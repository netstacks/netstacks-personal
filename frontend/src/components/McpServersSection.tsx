import AITabInput from './AITabInput'
import { useState, useEffect, useRef } from 'react';
import {
  listMcpServers,
  addMcpServer,
  updateMcpServer,
  deleteMcpServer,
  connectMcpServer,
  disconnectMcpServer,
  restartMcpServer,
  testMcpServer,
  setMcpToolEnabled,
  type McpServer,
  type AddMcpServerRequest,
  type UpdateMcpServerRequest,
} from '../api/mcp';
import { showToast } from './Toast';
import { PasswordInput } from './PasswordInput';
import Switch from './Switch';
import './McpServersSection.css';

import { getErrorMessage } from '../api/errors'
import DialogFooter from './DialogFooter';
import Tooltip from './Tooltip';
import SettingsSection from './settings/SettingsSection';
import SettingsItem from './settings/SettingsItem';
import ModalFrame from './ModalFrame';
const SERVER_TYPE_OPTIONS = [
  { value: 'custom', label: 'Custom' },
  { value: 'search', label: 'Search' },
  { value: 'database', label: 'Database' },
  { value: 'filesystem', label: 'Filesystem' },
  { value: 'code', label: 'Code' },
  { value: 'monitoring', label: 'Monitoring' },
  { value: 'knowledge', label: 'Knowledge' },
];

interface AddServerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (req: AddMcpServerRequest) => Promise<void>;
  /** When present, dialog is in edit mode: form pre-fills from this
   *  server and submit calls onUpdate instead of onAdd. */
  editingServer?: McpServer | null;
  onUpdate?: (id: string, req: UpdateMcpServerRequest) => Promise<void>;
}

function AddServerDialog({ isOpen, onClose, onAdd, editingServer, onUpdate }: AddServerDialogProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const isEditing = !!editingServer;
  const [name, setName] = useState('');
  const [transportType, setTransportType] = useState<'stdio' | 'sse'>('stdio');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'api-key'>('none');
  const [authToken, setAuthToken] = useState('');
  const [serverType, setServerType] = useState('custom');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill form when entering edit mode (or reset to defaults on add).
  useEffect(() => {
    if (!isOpen) return;
    if (editingServer) {
      setName(editingServer.name);
      setTransportType(editingServer.transport_type);
      setCommand(editingServer.command);
      setArgsText(editingServer.args.join('\n'));
      setUrl(editingServer.url || '');
      setAuthType(editingServer.auth_type);
      setAuthToken(''); // never echoed — empty means "keep existing"
      setServerType(editingServer.server_type || 'custom');
      setError(null);
    } else {
      setName('');
      setTransportType('stdio');
      setCommand('');
      setArgsText('');
      setUrl('');
      setAuthType('none');
      setAuthToken('');
      setServerType('custom');
      setError(null);
    }
  }, [isOpen, editingServer]);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    if (transportType === 'stdio' && !command.trim()) return;
    if (transportType === 'sse' && !url.trim()) return;

    setSaving(true);
    setError(null);

    try {
      const req: AddMcpServerRequest = {
        name: name.trim(),
        transport_type: transportType,
        server_type: serverType,
      };

      if (transportType === 'stdio') {
        req.command = command.trim();
        // Parse args - support both JSON array and newline/comma separated
        let args: string[] = [];
        const trimmedArgs = argsText.trim();
        if (trimmedArgs) {
          if (trimmedArgs.startsWith('[')) {
            try {
              args = JSON.parse(trimmedArgs);
            } catch {
              args = trimmedArgs.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
            }
          } else {
            args = trimmedArgs.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
          }
        }
        req.args = args;
      } else {
        req.url = url.trim();
        // Always send auth_type so switching back to "None" is persisted
        // (the backend keeps the existing value when the field is absent).
        req.auth_type = authType;
        if (authType !== 'none' && authToken.trim()) {
          req.auth_token = authToken.trim();
        }
      }

      if (isEditing && onUpdate && editingServer) {
        // For edits, only send auth_token when the user actually typed a
        // new one — otherwise the backend would clear the stored token.
        // Exception: switching Auth → None must clear the stored token
        // (empty string = clear), but only if one could exist.
        const updateReq: UpdateMcpServerRequest = { ...req };
        if (!authToken.trim()) {
          delete updateReq.auth_token;
        }
        if (transportType !== 'stdio' && authType === 'none' && editingServer.auth_type !== 'none') {
          updateReq.auth_token = '';
        }
        await onUpdate(editingServer.id, updateReq);
      } else {
        await onAdd(req);
      }
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, `Failed to ${isEditing ? 'update' : 'add'} server`));
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const isValid = name.trim() && (
    (transportType === 'stdio' && command.trim()) ||
    (transportType === 'sse' && url.trim())
  );

  return (
    <ModalFrame id="mcp-server" onDismiss={onClose} dismissEnabled={!saving} className="mcp-dialog" label="MCP Server">
      <h3>{isEditing ? `Edit MCP Server: ${editingServer?.name}` : 'Add MCP Server'}</h3>
      <form ref={formRef} className="mcp-dialog-form" onSubmit={handleSubmit}>
        <div className="mcp-form-field">
          <label htmlFor="mcp-name">Name</label>
          <AITabInput
            id="mcp-name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g., Filesystem Server"
            autoFocus
            aiField="MCP server name"
            aiPlaceholder="Short name for this Model Context Protocol server"
            aiContext={{ transport: transportType, command, args: argsText, url }}
            onAIValue={setName}
          />
        </div>

        {/* Transport type toggle */}
        <div className="mcp-form-field">
          <label>Transport</label>
          <div className="ns-segmented mcp-transport-toggle">
            <button
              type="button"
              className={`ns-segment mcp-transport-btn ${transportType === 'stdio' ? 'active' : ''}`}
              onClick={() => setTransportType('stdio')}
            >
              Command (stdio)
            </button>
            <button
              type="button"
              className={`ns-segment mcp-transport-btn ${transportType === 'sse' ? 'active' : ''}`}
              onClick={() => setTransportType('sse')}
            >
              URL (SSE)
            </button>
          </div>
        </div>

        {/* stdio fields */}
        {transportType === 'stdio' && (
          <>
            <div className="mcp-form-field">
              <label htmlFor="mcp-command">Command</label>
              <AITabInput
                id="mcp-command"
                value={command}
                onChange={e => setCommand(e.target.value)}
                placeholder="e.g., npx"
                aiField="MCP server command"
                aiPlaceholder="Executable that starts this stdio MCP server (e.g. npx, uvx, a binary path)"
                aiContext={{ name, args: argsText }}
                onAIValue={setCommand}
              />
              <span className="field-hint">The executable to run</span>
            </div>
            <div className="mcp-form-field">
              <label htmlFor="mcp-args">Arguments</label>
              <AITabInput
                as="textarea"
                id="mcp-args"
                value={argsText}
                onChange={e => setArgsText(e.target.value)}
                placeholder={`e.g.,\n-y\n@modelcontextprotocol/server-filesystem\n/tmp`}
                aiField="MCP server arguments"
                aiPlaceholder="Command-line arguments for the MCP server, one per line"
                aiContext={{ name, command }}
                onAIValue={setArgsText}
              />
              <span className="field-hint">One argument per line, or JSON array</span>
            </div>
          </>
        )}

        {/* SSE fields */}
        {transportType === 'sse' && (
          <>
            <div className="mcp-form-field">
              <label htmlFor="mcp-url">URL</label>
              <input data-ai-fill="off" className="ns-input"
                id="mcp-url"
                type="text"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="e.g., https://mcp.example.com/sse"
              />
              <span className="field-hint">SSE/Streamable HTTP endpoint URL</span>
            </div>
            <div className="mcp-form-field">
              <label htmlFor="mcp-auth-type">Authentication</label>
              <select className="ns-select"
                id="mcp-auth-type"
                value={authType}
                onChange={e => setAuthType(e.target.value as 'none' | 'bearer' | 'api-key')}
              >
                <option value="none">None</option>
                <option value="bearer">Bearer Token</option>
                <option value="api-key">API Key</option>
              </select>
            </div>
            {authType !== 'none' && (
              <div className="mcp-form-field">
                <label htmlFor="mcp-auth-token">
                  {authType === 'bearer' ? 'Bearer Token' : 'API Key'}
                </label>
                <PasswordInput
                  id="mcp-auth-token"
                  value={authToken}
                  onChange={e => setAuthToken(e.target.value)}
                  placeholder={
                    isEditing
                      ? 'Leave blank to keep stored token'
                      : authType === 'bearer'
                      ? 'Enter bearer token'
                      : 'Enter API key'
                  }
                />
              </div>
            )}
          </>
        )}

        {/* Server type */}
        <div className="mcp-form-field">
          <label htmlFor="mcp-server-type">Server Type</label>
          <select className="ns-select"
            id="mcp-server-type"
            value={serverType}
            onChange={e => setServerType(e.target.value)}
          >
            {SERVER_TYPE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <span className="field-hint">Helps AI understand what this server provides</span>
        </div>

        {error && <div className="mcp-error">{error}</div>}
        <DialogFooter
          primary={{
            label: saving ? (isEditing ? 'Saving…' : 'Adding…') : (isEditing ? 'Save' : 'Add Server'),
            onClick: () => formRef.current?.requestSubmit(),
            disabled: saving || !isValid,
          }}
          onCancel={onClose}
          cancelDisabled={saving}
          inline
        />
      </form>
    </ModalFrame>
  );
}

interface ServerItemProps {
  server: McpServer;
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onTest: () => void;
  onRestart: () => void;
  onDelete: () => void;
  onToolToggle: (toolId: string, enabled: boolean) => void;
  connecting: boolean;
  testing: boolean;
  error: string | null;
}

function ServerItem({ server, onConnect, onDisconnect, onEdit, onTest, onRestart, onDelete, onToolToggle, connecting, testing, error }: ServerItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [togglingToolId, setTogglingToolId] = useState<string | null>(null);

  const statusTitle = server.connected ? 'Connected' : 'Disconnected';

  // Count enabled tools
  const enabledCount = server.tools.filter(t => t.enabled).length;
  const toolsCountText = server.tools.length > 0
    ? `${enabledCount}/${server.tools.length} tools enabled`
    : '';

  const handleToolToggle = async (toolId: string, currentEnabled: boolean) => {
    setTogglingToolId(toolId);
    try {
      await onToolToggle(toolId, !currentEnabled);
    } finally {
      setTogglingToolId(null);
    }
  };

  // Display info: URL for SSE, command+args for stdio
  const connectionInfo = server.transport_type === 'sse'
    ? server.url || ''
    : `${server.command} ${server.args.join(' ')}`;

  return (
    <SettingsItem
      leading={<span className={`settings-status-dot${server.connected ? ' settings-status-dot--ok' : ''}${connecting ? ' settings-status-dot--busy mcp-connecting' : ''}`} role="img" aria-label={statusTitle} />}
      title={server.name}
      badges={
        <>
          <span className="settings-badge">{server.transport_type === 'sse' ? 'SSE' : 'stdio'}</span>
          {server.server_type !== 'custom' && <span className="settings-badge">{server.server_type}</span>}
        </>
      }
      meta={
        <>
          <code>{connectionInfo}</code>
          {toolsCountText && <span>{toolsCountText}</span>}
        </>
      }
      actions={
        <>
          <button
            className="ns-btn ns-btn--ghost ns-btn--small"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            Tools
          </button>
          {server.connected ? (
            <>
              <Tooltip label="Disconnect + reconnect — re-discovers tools"><button
                className="ns-btn ns-btn--ghost ns-btn--small"
                onClick={onRestart}
                disabled={connecting}
              >
                Restart
              </button></Tooltip>
              <button className="ns-btn ns-btn--ghost ns-btn--small" onClick={onDisconnect} disabled={connecting}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              <Tooltip label="Test connection (does not persist tools)"><button
                className="ns-btn ns-btn--ghost ns-btn--small"
                onClick={onTest}
                disabled={connecting || testing}
              >
                {testing ? 'Testing…' : 'Test'}
              </button></Tooltip>
              <button className="ns-btn ns-btn--ghost ns-btn--small" onClick={onConnect} disabled={connecting || testing}>
                {connecting ? 'Connecting...' : 'Connect'}
              </button>
            </>
          )}
          <Tooltip label="Edit — drops the current connection so changes take effect"><button
            className="ns-btn ns-btn--ghost ns-btn--small"
            onClick={onEdit}
            disabled={connecting}
          >
            Edit
          </button></Tooltip>
          <button className="ns-btn ns-btn--ghost ns-btn--danger ns-btn--small" onClick={onDelete} disabled={connecting}>
            Delete
          </button>
        </>
      }
    >
      {error && <p className="settings-error">{error}</p>}
      {expanded && (
        server.tools.length > 0 ? (
          <div className="mcp-tools-list">
            {server.tools.map(tool => (
              <div key={tool.id} className={`mcp-tool-item ${tool.enabled ? '' : 'mcp-tool-disabled'}`}>
                <Switch
                  size="sm"
                  checked={tool.enabled}
                  onChange={() => handleToolToggle(tool.id, tool.enabled)}
                  disabled={togglingToolId === tool.id}
                  tooltip={tool.enabled ? 'Disable tool for AI agents' : 'Enable tool for AI agents'}
                  label={`Enable ${tool.name} for AI agents`}
                />
                <div className="mcp-tool-info">
                  <div className="mcp-tool-name">{tool.name}</div>
                  {tool.description && <div className="mcp-tool-description">{tool.description}</div>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="form-hint">{server.connected ? 'No tools discovered from this server.' : 'Connect to discover available tools.'}</p>
        )
      )}
    </SettingsItem>
  );
}

export default function McpServersSection() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string | null>>({});
  const [deleteConfirm, setDeleteConfirm] = useState<McpServer | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetchServers();
  }, []);

  const fetchServers = async () => {
    try {
      setLoading(true);
      const data = await listMcpServers();
      setServers(data);
      setError(null);
    } catch (err) {
      setError('Failed to load MCP servers');
      console.error('Failed to fetch MCP servers:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddServer = async (req: AddMcpServerRequest) => {
    await addMcpServer(req);
    await fetchServers();
  };

  const handleUpdateServer = async (id: string, req: UpdateMcpServerRequest) => {
    await updateMcpServer(id, req);
    setEditingServer(null);
    await fetchServers();
    showToast('Server updated — reconnect to apply', 'success');
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setServerErrors((prev) => ({ ...prev, [id]: null }));
    try {
      const result = await testMcpServer(id);
      showToast(result.message, result.success ? 'success' : 'error');
      if (!result.success) {
        setServerErrors((prev) => ({ ...prev, [id]: result.message }));
      }
    } catch (err) {
      const message = getErrorMessage(err, 'Test failed');
      showToast(message, 'error');
      setServerErrors((prev) => ({ ...prev, [id]: message }));
    } finally {
      setTestingId(null);
    }
  };

  const handleRestart = async (id: string) => {
    setConnectingId(id);
    setServerErrors((prev) => ({ ...prev, [id]: null }));
    try {
      const updated = await restartMcpServer(id);
      setServers((prev) => prev.map((s) => (s.id === id ? updated : s)));
      showToast(`Restarted '${updated.name}'`, 'success');
    } catch (err) {
      const message = getErrorMessage(err, 'Restart failed');
      setServerErrors((prev) => ({ ...prev, [id]: message }));
    } finally {
      setConnectingId(null);
    }
  };

  const handleConnect = async (id: string) => {
    setConnectingId(id);
    setServerErrors(prev => ({ ...prev, [id]: null }));

    try {
      const updated = await connectMcpServer(id);
      setServers(prev => prev.map(s => s.id === id ? updated : s));
    } catch (err) {
      setServerErrors(prev => ({
        ...prev,
        [id]: getErrorMessage(err, 'Connection failed'),
      }));
    } finally {
      setConnectingId(null);
    }
  };

  const handleDisconnect = async (id: string) => {
    setConnectingId(id);
    setServerErrors(prev => ({ ...prev, [id]: null }));

    try {
      await disconnectMcpServer(id);
      setServers(prev => prev.map(s => s.id === id ? { ...s, connected: false } : s));
    } catch (err) {
      setServerErrors(prev => ({
        ...prev,
        [id]: getErrorMessage(err, 'Disconnect failed'),
      }));
    } finally {
      setConnectingId(null);
    }
  };

  const handleDeleteClick = (server: McpServer) => {
    setDeleteConfirm(server);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return;

    try {
      setDeleting(true);
      setError(null);
      await deleteMcpServer(deleteConfirm.id);
      setDeleteConfirm(null);
      await fetchServers();
    } catch (err) {
      console.error('Failed to delete MCP server:', err);
      setError('Failed to delete MCP server');
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteConfirm(null);
  };

  const handleToolToggle = async (toolId: string, enabled: boolean) => {
    // Clear a stale banner from a previous failed toggle/delete.
    setError(null);
    try {
      await setMcpToolEnabled(toolId, enabled);
      // Update local state to reflect the change
      setServers(prev => prev.map(s => ({
        ...s,
        tools: s.tools.map(t =>
          t.id === toolId ? { ...t, enabled } : t
        ),
      })));
    } catch (err) {
      console.error('Failed to toggle tool:', err);
      setError('Failed to update tool status');
    }
  };

  if (loading) {
    return (
      <SettingsSection title="MCP Servers">
        <p className="form-hint">Loading MCP servers…</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="MCP Servers"
      help={{
        topic: 'MCP servers',
        prompt: `Help me use MCP servers with the NetStacks AI. I have ${servers.length} MCP server(s)${servers.length ? ` (${servers.map(sv => sv.name).join(', ')})` : ''}. `
          + 'Explain what an MCP server adds (its tools appear to the AI as mcp_<server>_<tool>), how to add one (stdio command vs URL), how per-tool enable works, and that MCP tool calls are treated as writes by the permission mode (Ask/Auto prompt for them).',
      }}
      actions={
        <button className="ns-btn ns-btn--small" onClick={() => setDialogOpen(true)}>+ Add MCP server</button>
      }
    >

      {error && (
        <p className="settings-error">
          {error}{' '}
          <button type="button" className="ns-btn ns-btn--small" onClick={() => setError(null)}>Dismiss</button>
        </p>
      )}

      {servers.length === 0 ? (
        <p className="form-hint">No MCP servers yet. Add one to extend the AI with external tools.</p>
      ) : (
        <div className="settings-group">
          {servers.map(server => (
            <ServerItem
              key={server.id}
              server={server}
              onConnect={() => handleConnect(server.id)}
              onDisconnect={() => handleDisconnect(server.id)}
              onEdit={() => setEditingServer(server)}
              onTest={() => handleTest(server.id)}
              onRestart={() => handleRestart(server.id)}
              onDelete={() => handleDeleteClick(server)}
              onToolToggle={handleToolToggle}
              connecting={connectingId === server.id}
              testing={testingId === server.id}
              error={serverErrors[server.id] || null}
            />
          ))}
        </div>
      )}

      {/* Add Server Dialog */}
      <AddServerDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onAdd={handleAddServer}
      />

      {/* Edit Server Dialog — same component, edit mode */}
      <AddServerDialog
        isOpen={!!editingServer}
        onClose={() => setEditingServer(null)}
        onAdd={handleAddServer}
        editingServer={editingServer}
        onUpdate={handleUpdateServer}
      />

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <ModalFrame id="mcp-delete" onDismiss={handleDeleteCancel} resizable={false} className="delete-confirm-dialog" label="Delete MCP server">
          <h3>Delete MCP Server</h3>
          <p>Are you sure you want to delete "{deleteConfirm.name}"?</p>
          <p className="delete-confirm-warning">
            This will remove the server configuration and all discovered tools.
          </p>
          <DialogFooter
            primary={{ label: deleting ? 'Deleting...' : 'Delete', onClick: handleDeleteConfirm, disabled: deleting, danger: true }}
            onCancel={handleDeleteCancel}
            cancelDisabled={deleting}
            inline
          />
        </ModalFrame>
      )}
    </SettingsSection>
  );
}
