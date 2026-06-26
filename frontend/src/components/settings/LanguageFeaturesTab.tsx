import { useState, useEffect } from 'react';
import { listPlugins, type LspPluginListItem } from '../../lsp/installationApi';
import { LspPluginRow } from './LspPluginRow';
import { AddCustomPluginDialog } from './AddCustomPluginDialog';

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

  if (loading) return <div>Loading plugins…</div>;
  if (error) return <div style={{ color: 'red' }}>Failed to load: {error}</div>;

  // Built-ins first (sorted), then user-added
  const builtIns = plugins.filter((p) => p.source === 'built-in').sort((a, b) => a.displayName.localeCompare(b.displayName));
  const userAdded = plugins.filter((p) => p.source === 'user-added').sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <div className="language-features-tab">
      <p className="settings-description">
        Configure LSP language servers for syntax intelligence in Monaco editors.
      </p>
      <div className="lsp-plugin-list">
        {builtIns.length > 0 && (
          <>
            <h4>Built-in</h4>
            {builtIns.map((p) => (
              <LspPluginRow key={p.id} plugin={p} onChanged={refresh} onEdit={() => setEditingId(p.id)} />
            ))}
          </>
        )}
        {userAdded.length > 0 && (
          <>
            <h4>Custom</h4>
            {userAdded.map((p) => (
              <LspPluginRow key={p.id} plugin={p} onChanged={refresh} onEdit={() => setEditingId(p.id)} />
            ))}
          </>
        )}
        <div className="lsp-plugin-list__add">
          <button onClick={() => setShowAddDialog(true)}>+ Add Language Server</button>
        </div>
      </div>

      {(showAddDialog || editingId) && (
        <AddCustomPluginDialog
          existing={editingId ? plugins.find((p) => p.id === editingId) : undefined}
          onClose={() => { setShowAddDialog(false); setEditingId(null); }}
          onSaved={() => { setShowAddDialog(false); setEditingId(null); refresh(); }}
        />
      )}
    </div>
  );
}
