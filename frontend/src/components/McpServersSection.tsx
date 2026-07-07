import { useState, useEffect } from 'react';
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
import './McpServersSection.css';

// Icons
import { getErrorMessage } from '../api/errors'
const Icons = {
  plug: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <path d="M12 2v6" />
      <path d="M8 2v6" />
      <path d="M16 2v6" />
      <rect x="4" y="8" width="16" height="4" rx="1" />
      <path d="M12 12v4" />
      <path d="M8 16h8" />
      <path d="M10 20h4" />
    </svg>
  ),
  connect: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </svg>
  ),
  disconnect: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  tool: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  chevronDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  chevronRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
};

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
        if (authType !== 'none') {
          req.auth_type = authType;
          if (authToken.trim()) {
            req.auth_token = authToken.trim();
          }
        }
      }

      if (isEditing && onUpdate && editingServer) {
        // For edits, only send auth_token when the user actually typed a
        // new one — otherwise the backend would clear the stored token.
        const updateReq: UpdateMcpServerRequest = { ...req };
        if (!authToken.trim()) {
          delete updateReq.auth_token;
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
    <div className="mcp-dialog-overlay">
      <div className="mcp-dialog" onClick={e => e.stopPropagation()}>
        <h3>{isEditing ? `Edit MCP Server: ${editingServer?.name}` : 'Add MCP Server'}</h3>
        <form className="mcp-dialog-form" onSubmit={handleSubmit}>
          <div className="mcp-form-field">
            <label htmlFor="mcp-name">Name</label>
            <input
              id="mcp-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., Filesystem Server"
              autoFocus
            />
          </div>

          {/* Transport type toggle */}
          <div className="mcp-form-field">
            <label>Transport</label>
            <div className="mcp-transport-toggle">
              <button
                type="button"
                className={`mcp-transport-btn ${transportType === 'stdio' ? 'active' : ''}`}
                onClick={() => setTransportType('stdio')}
              >
                Command (stdio)
              </button>
              <button
                type="button"
                className={`mcp-transport-btn ${transportType === 'sse' ? 'active' : ''}`}
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
                <input
                  id="mcp-command"
                  type="text"
                  value={command}
                  onChange={e => setCommand(e.target.value)}
                  placeholder="e.g., npx"
                />
                <span className="field-hint">The executable to run</span>
              </div>
              <div className="mcp-form-field">
                <label htmlFor="mcp-args">Arguments</label>
                <textarea
                  id="mcp-args"
                  value={argsText}
                  onChange={e => setArgsText(e.target.value)}
                  placeholder={`e.g.,\n-y\n@modelcontextprotocol/server-filesystem\n/tmp`}
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
                <input
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
                <select
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
            <select
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
          <div className="mcp-dialog-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-add-source"
              disabled={saving || !isValid}
            >
              {saving
                ? isEditing ? 'Saving…' : 'Adding…'
                : isEditing ? 'Save' : 'Add Server'}
            </button>
          </div>
        </form>
      </div>
    </div>
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

  const statusClass = server.connected ? 'success' : 'inactive';
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
    <div className={`source-item ${expanded ? 'mcp-server-expanded' : ''}`}>
      <div className="source-status">
        <span className={`status-dot ${statusClass} ${connecting ? 'mcp-connecting' : ''}`} title={statusTitle} />
      </div>
      <div className="source-info">
        <div className="source-header">
          <button
            className="source-action-btn"
            onClick={() => setExpanded(!expanded)}
            style={{ padding: '2px', marginRight: '4px' }}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? Icons.chevronDown : Icons.chevronRight}
          </button>
          <span className="source-icon">{Icons.plug}</span>
          <span className="source-name">{server.name}</span>
          <span className={`mcp-badge mcp-badge-transport`}>
            {server.transport_type === 'sse' ? 'SSE' : 'stdio'}
          </span>
          {server.server_type !== 'custom' && (
            <span className="mcp-badge mcp-badge-type">{server.server_type}</span>
          )}
          {server.tools.length > 0 && (
            <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginLeft: '8px' }}>
              ({toolsCountText})
            </span>
          )}
        </div>
        <div className="source-details">
          <span className="source-url">{connectionInfo}</span>
        </div>
        {error && <div className="mcp-server-error">{error}</div>}

        {/* Expanded tools list */}
        {expanded && server.tools.length > 0 && (
          <div className="mcp-tools-list">
            <div className="mcp-tools-header">Discovered Tools</div>
            {server.tools.map(tool => (
              <div
                key={tool.id}
                className={`mcp-tool-item ${tool.enabled ? 'mcp-tool-enabled' : 'mcp-tool-disabled'}`}
              >
                <button
                  className={`mcp-tool-toggle ${tool.enabled ? 'enabled' : ''}`}
                  onClick={() => handleToolToggle(tool.id, tool.enabled)}
                  disabled={togglingToolId === tool.id}
                  title={tool.enabled ? 'Disable tool for AI agents' : 'Enable tool for AI agents'}
                >
                  {tool.enabled && Icons.check}
                </button>
                <span className="mcp-tool-icon">{Icons.tool}</span>
                <div className="mcp-tool-info">
                  <div className="mcp-tool-name">{tool.name}</div>
                  {tool.description && (
                    <div className="mcp-tool-description">{tool.description}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {expanded && server.connected && server.tools.length === 0 && (
          <div className="mcp-tools-list">
            <div className="mcp-no-tools">No tools discovered from this server</div>
          </div>
        )}

        {expanded && !server.connected && (
          <div className="mcp-tools-list">
            <div className="mcp-no-tools">Connect to discover available tools</div>
          </div>
        )}
      </div>
      <div className="source-actions">
        {server.connected ? (
          <>
            <button
              className="source-action-btn"
              onClick={onRestart}
              disabled={connecting}
              title="Disconnect + reconnect — re-discovers tools"
            >
              <span>Restart</span>
            </button>
            <button
              className="source-action-btn"
              onClick={onDisconnect}
              disabled={connecting}
              title="Disconnect"
            >
              {Icons.disconnect}
              <span>Disconnect</span>
            </button>
          </>
        ) : (
          <>
            <button
              className="source-action-btn"
              onClick={onTest}
              disabled={connecting || testing}
              title="Test connection (does not persist tools)"
            >
              <span>{testing ? 'Testing…' : 'Test'}</span>
            </button>
            <button
              className="source-action-btn"
              onClick={onConnect}
              disabled={connecting || testing}
              title="Connect"
            >
              {Icons.connect}
              <span>{connecting ? 'Connecting...' : 'Connect'}</span>
            </button>
          </>
        )}
        <button
          className="source-action-btn"
          onClick={onEdit}
          disabled={connecting}
          title="Edit — drops the current connection so changes take effect"
        >
          <span>Edit</span>
        </button>
        <button
          className="source-action-btn delete"
          onClick={onDelete}
          disabled={connecting}
          title="Delete"
        >
          {Icons.trash}
        </button>
      </div>
    </div>
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
      <section className="ai-section mcp-servers-section">
        <div className="section-header">
          <h3>MCP SERVERS</h3>
        </div>
        <div className="sources-empty">Loading MCP servers...</div>
      </section>
    );
  }

  return (
    <section className="ai-section mcp-servers-section">
      <div className="section-header">
        <h3>MCP SERVERS</h3>
      </div>

      {error && <div className="mcp-error">{error}</div>}

      <div className="sources-list">
        {servers.length === 0 ? (
          <div className="sources-empty">
            <p>No MCP servers configured.</p>
            <p>Add an MCP server to extend agent capabilities with external tools.</p>
          </div>
        ) : (
          servers.map(server => (
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
          ))
        )}
      </div>

      <div className="section-footer">
        <button className="btn-add-source" onClick={() => setDialogOpen(true)}>
          {Icons.plus}
          <span>Add MCP Server</span>
        </button>
      </div>

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
        <div className="delete-confirm-overlay" onClick={handleDeleteCancel}>
          <div className="delete-confirm-dialog" onClick={e => e.stopPropagation()}>
            <h3>Delete MCP Server</h3>
            <p>Are you sure you want to delete "{deleteConfirm.name}"?</p>
            <p className="delete-confirm-warning">
              This will remove the server configuration and all discovered tools.
            </p>
            <div className="delete-confirm-actions">
              <button className="btn-secondary" onClick={handleDeleteCancel} disabled={deleting}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleDeleteConfirm} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
