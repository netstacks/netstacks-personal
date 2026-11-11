import { useState, useEffect } from 'react';
import { listPlugins, type LspPluginListItem } from '../../lsp/installationApi';
import { LspPluginRow } from './LspPluginRow';
import { AddCustomPluginDialog } from './AddCustomPluginDialog';
import SettingsSection from './SettingsSection';

export function LanguageFeaturesTab() {
  const [plugins, setPlugins] = useState<LspPluginListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listPlugins();
      setPlugins(list);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  // Built-ins first (sorted), then user-added
  const builtIns = plugins.filter((p) => p.source === 'built-in').sort((a, b) => a.displayName.localeCompare(b.displayName));
  const userAdded = plugins.filter((p) => p.source === 'user-added').sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <SettingsSection
      title="Language Servers"
      description="LSP language servers that give the Monaco editors syntax intelligence."
      help={{
        topic: 'language servers',
        prompt: `Help me set up language servers (LSP) for the NetStacks editors. Installed: ${plugins.length ? plugins.map(p => `${p.displayName} (${p.language}, ${p.installStatus})`).join(', ') : 'none'}. Explain what an LSP gives the Monaco editors, built-in vs custom servers, the command/args a custom server needs (stdio), and how to test one — e.g. adding a YAML or Bash language server.`,
      }}
      actions={<button className="ns-btn ns-btn--small" onClick={() => setShowAddDialog(true)}>+ Add language server</button>}
    >
      {loading ? (
        <p className="form-hint">Loading plugins…</p>
      ) : error ? (
        <p className="settings-error">Failed to load: {error}</p>
      ) : plugins.length === 0 ? (
        <p className="form-hint">No language servers yet.</p>
      ) : (
        <div className="settings-group">
          {[...builtIns, ...userAdded].map((p) => (
            <LspPluginRow key={p.id} plugin={p} onChanged={refresh} onEdit={() => setEditingId(p.id)} />
          ))}
        </div>
      )}

      {(showAddDialog || editingId) && (
        <AddCustomPluginDialog
          existing={editingId ? plugins.find((p) => p.id === editingId) : undefined}
          onClose={() => { setShowAddDialog(false); setEditingId(null); }}
          onSaved={() => { setShowAddDialog(false); setEditingId(null); refresh(); }}
        />
      )}
    </SettingsSection>
  );
}
