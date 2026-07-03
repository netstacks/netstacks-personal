import { useState, useEffect } from 'react';
import { getClient } from '../api/client';
import {
  listNetBoxSources,
  deleteNetBoxSource,
  type NetBoxSource,
} from '../api/netboxSources';
import {
  listLibreNmsSources,
  createLibreNmsSource,
  updateLibreNmsSource,
  deleteLibreNmsSource,
  testLibreNmsConnection,
  type LibreNmsSource,
} from '../api/librenms';
import {
  listNetStacksCrawlerSources,
  createNetStacksCrawlerSource,
  updateNetStacksCrawlerSource,
  deleteNetStacksCrawlerSource,
  testNetStacksCrawlerSource,
  type NetStacksCrawlerSource,
} from '../api/netstacksCrawler';
import AskAiHelp from './AskAiHelp';
import NetBoxSourceDialog from './NetBoxSourceDialog';
import NetBoxImportDialog from './NetBoxImportDialog';
import SmtpSettingsSection from './SmtpSettingsSection';
import SecureCRTImportDialog from './SecureCRTImportDialog';
import ApiResourcePicker from './ApiResourcePicker';
import { downloadFile } from '../lib/formatters';
import { showToast } from './Toast';
import { confirmDialog } from './ConfirmDialog';
import { useSubmitting } from '../hooks/useSubmitting';
import { exportDb, importDb, resetDb, getDbInfo, setDbPath, clearDbPath, backupSupported, type DbInfo } from '../api/db';
import './IntegrationsTab.css';

// Icons
import { getErrorMessage } from '../api/errors'
const Icons = {
  netbox: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="7" y1="8" x2="17" y2="8" />
      <line x1="7" y1="12" x2="17" y2="12" />
      <line x1="7" y1="16" x2="12" y2="16" />
    </svg>
  ),
  sync: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
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
  import: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  export: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  ),
};

export default function IntegrationsTab() {
  // NetBox state
  const [sources, setSources] = useState<NetBoxSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // NetBox dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSource, setEditingSource] = useState<NetBoxSource | null>(null);

  // NetBox delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<NetBoxSource | null>(null);
  const [deleting, setDeleting] = useState(false);

  // NetBox import dialog state
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [syncSourceId, setSyncSourceId] = useState<string | undefined>(undefined);

  // SecureCRT import dialog state
  const [secureCRTDialogOpen, setSecureCRTDialogOpen] = useState(false);

  // LibreNMS state — full CRUD
  const [libreSources, setLibreSources] = useState<LibreNmsSource[]>([]);
  const [libreEditingId, setLibreEditingId] = useState<string | 'new' | null>(null);
  const [libreForm, setLibreForm] = useState({ name: '', api_resource_id: '' });
  const libreSubmit = useSubmitting();

  // NetStacksCrawler state — full CRUD (backend supports PUT)
  const [netstacksCrawlerSources, setNetStacksCrawlerSources] = useState<NetStacksCrawlerSource[]>([]);
  const [netstacksCrawlerEditingId, setNetStacksCrawlerEditingId] = useState<string | 'new' | null>(null);
  const [netstacksCrawlerForm, setNetStacksCrawlerForm] = useState<{
    name: string;
    api_resource_id: string;
  }>({ name: '', api_resource_id: '' });
  const netstacksCrawlerSubmit = useSubmitting();

  // Backup & Seed state
  const [exportMode, setExportMode] = useState<'full' | 'seed'>('full');
  const [dbBusy, setDbBusy] = useState(false);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [dbPathDraft, setDbPathDraft] = useState<string>('');
  const [dbPathDirty, setDbPathDirty] = useState(false);

  // Fetch sources on mount
  useEffect(() => {
    void Promise.all([fetchSources(), fetchLibreSources(), fetchNetStacksCrawlerSources()]);
    if (backupSupported()) {
      void getDbInfo().then(info => {
        setDbInfo(info);
        setDbPathDraft(info.path);
      }).catch(() => {/* non-fatal */});
    }
  }, []);

  const fetchSources = async () => {
    try {
      setLoading(true);
      const data = await listNetBoxSources();
      setSources(data);
      setError(null);
    } catch (err) {
      setError('Failed to load NetBox sources');
      console.error('Failed to fetch NetBox sources:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchLibreSources = async () => {
    try {
      setLibreSources(await listLibreNmsSources());
    } catch (err) {
      console.error('Failed to fetch LibreNMS sources:', err);
    }
  };

  const fetchNetStacksCrawlerSources = async () => {
    try {
      setNetStacksCrawlerSources(await listNetStacksCrawlerSources());
    } catch (err) {
      console.error('Failed to fetch NetStacksCrawler sources:', err);
    }
  };

  // === Backup & Seed handlers (whole-database) ===

  const handleDbExport = async () => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const includeVault = exportMode === 'full';
      const suggested = includeVault ? 'netstacks-backup.db' : 'netstacks-seed.db';
      const path = await save({
        title: includeVault ? 'Save full backup' : 'Save shareable seed',
        defaultPath: suggested,
        filters: [{ name: 'NetStacks Database', extensions: ['db'] }],
      });
      if (!path) return; // user cancelled
      setDbBusy(true);
      await exportDb(path, includeVault);
      showToast(includeVault ? 'Full backup saved' : 'Shareable seed saved (no secrets)', 'success');
    } catch (e) {
      showToast(`Export failed: ${getErrorMessage(e)}`, 'error');
    } finally {
      setDbBusy(false);
    }
  };

  const handleDbImport = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        title: 'Import NetStacks database',
        multiple: false,
        filters: [{ name: 'NetStacks Database', extensions: ['db'] }],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return; // cancelled
      const ok = await confirmDialog({
        title: 'Import database?',
        body: <>This replaces your current NetStacks data with the selected database. Your current data is backed up first, then the app restarts to apply the import.</>,
        confirmLabel: 'Import & restart',
        destructive: true,
      });
      if (!ok) return;
      setDbBusy(true);
      await importDb(path);
      setDbBusy(false);
      await confirmDialog({
        title: 'Import staged — restart required',
        body: <>The database import is ready. <strong>Quit NetStacks and reopen it</strong> to apply the import.</>,
        confirmLabel: 'OK',
        destructive: false,
      });
    } catch (e) {
      setDbBusy(false);
      showToast(`Import failed: ${getErrorMessage(e)}`, 'error');
    }
  };

  const handleDbReset = async () => {
    const ok = await confirmDialog({
      title: 'Factory reset?',
      body: <>This wipes <strong>all</strong> NetStacks data — sessions, profiles, integrations, everything. Your current database is backed up first (timestamped, in the same folder). The app must restart to apply.</>,
      confirmLabel: 'Reset & restart',
      destructive: true,
    });
    if (!ok) return;
    try {
      setDbBusy(true);
      await resetDb();
      setDbBusy(false);
      await confirmDialog({
        title: 'Reset staged — restart required',
        body: <>Factory reset is staged. <strong>Quit NetStacks and reopen it</strong> to apply.</>,
        confirmLabel: 'OK',
        destructive: false,
      });
    } catch (e) {
      setDbBusy(false);
      showToast(`Reset failed: ${getErrorMessage(e)}`, 'error');
    }
  };

  const handleDbPathBrowse = async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      title: 'Choose new database location',
      defaultPath: dbPathDraft || 'netstacks.db',
      filters: [{ name: 'NetStacks Database', extensions: ['db'] }],
    });
    if (!path) return;
    setDbPathDraft(path);
    setDbPathDirty(path !== (dbInfo?.path ?? ''));
  };

  const handleDbPathApply = async () => {
    if (!dbPathDirty || !dbPathDraft) return;
    const isDefault = dbPathDraft === (dbInfo?.path ?? '');
    const ok = await confirmDialog({
      title: 'Move database?',
      body: <>Your current database will be copied to <strong>{dbPathDraft}</strong> and NetStacks will use that location from now on. The app must restart to apply.</>,
      confirmLabel: 'Apply & restart',
      destructive: false,
    });
    if (!ok) return;
    try {
      setDbBusy(true);
      if (isDefault) {
        await clearDbPath();
      } else {
        await setDbPath(dbPathDraft);
      }
      setDbBusy(false);
      setDbPathDirty(false);
      await confirmDialog({
        title: 'Location saved — restart required',
        body: <>Database copied to the new location. <strong>Quit NetStacks and reopen it</strong> to apply.</>,
        confirmLabel: 'OK',
        destructive: false,
      });
    } catch (e) {
      setDbBusy(false);
      showToast(`Failed to move database: ${getErrorMessage(e)}`, 'error');
    }
  };

  const handleOpenDbDir = async () => {
    const dir = dbInfo?.dir;
    if (!dir) return;
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(dir);
    } catch {
      showToast('Could not open folder in file manager', 'error');
    }
  };

  // === LibreNMS handlers ===

  const openLibreNmsAdd = () => {
    setLibreForm({ name: '', api_resource_id: '' });
    setLibreEditingId('new');
  };

  const openLibreNmsEdit = (s: LibreNmsSource) => {
    setLibreForm({
      name: s.name,
      api_resource_id: s.api_resource_id,
    });
    setLibreEditingId(s.id);
  };

  const closeLibreNmsForm = () => {
    setLibreEditingId(null);
  };

  const handleLibreNmsSave = async () => {
    if (!libreForm.name.trim() || !libreForm.api_resource_id) {
      showToast('Name and API resource are required', 'warning');
      return;
    }
    const isNew = libreEditingId === 'new';
    await libreSubmit.run(async () => {
      try {
        if (isNew) {
          await createLibreNmsSource(libreForm.name.trim(), libreForm.api_resource_id);
        } else if (libreEditingId) {
          await updateLibreNmsSource(libreEditingId, {
            name: libreForm.name.trim(),
            api_resource_id: libreForm.api_resource_id,
          });
        }
        await fetchLibreSources();
        closeLibreNmsForm();
        showToast(`LibreNMS source ${isNew ? 'added' : 'updated'}`, 'success');
      } catch (err) {
        showToast(getErrorMessage(err, 'Save failed'), 'error');
      }
    });
  };

  const handleLibreTest = async (s: LibreNmsSource) => {
    showToast(`Testing ${s.name}…`, 'info');
    try {
      const result = await testLibreNmsConnection(s.id);
      if (result.success) {
        showToast(`${s.name}: ${result.message}${result.version ? ` (v${result.version})` : ''}`, 'success');
      } else {
        showToast(`${s.name}: ${result.message}`, 'error');
      }
    } catch (err) {
      showToast(getErrorMessage(err, 'Test failed'), 'error');
    }
  };

  const handleLibreDelete = async (s: LibreNmsSource) => {
    const ok = await confirmDialog({
      title: 'Delete LibreNMS source?',
      body: <>Remove <strong>{s.name}</strong>? Topologies already discovered through it stay intact.</>,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await libreSubmit.run(async () => {
      try {
        await deleteLibreNmsSource(s.id);
        await fetchLibreSources();
        showToast('LibreNMS source deleted', 'success');
      } catch (err) {
        showToast(getErrorMessage(err, 'Delete failed'), 'error');
      }
    });
  };

  // === NetStacksCrawler handlers ===

  const openNetStacksCrawlerAdd = () => {
    setNetStacksCrawlerForm({ name: '', api_resource_id: '' });
    setNetStacksCrawlerEditingId('new');
  };

  const openNetStacksCrawlerEdit = (s: NetStacksCrawlerSource) => {
    setNetStacksCrawlerForm({
      name: s.name,
      api_resource_id: s.api_resource_id,
    });
    setNetStacksCrawlerEditingId(s.id);
  };

  const closeNetStacksCrawlerForm = () => {
    setNetStacksCrawlerEditingId(null);
  };

  const handleNetStacksCrawlerSave = async () => {
    if (!netstacksCrawlerForm.name.trim() || !netstacksCrawlerForm.api_resource_id) {
      showToast('Name and API resource are required', 'warning');
      return;
    }
    const isNew = netstacksCrawlerEditingId === 'new';
    await netstacksCrawlerSubmit.run(async () => {
      try {
        if (isNew) {
          await createNetStacksCrawlerSource({
            name: netstacksCrawlerForm.name.trim(),
            api_resource_id: netstacksCrawlerForm.api_resource_id,
          });
        } else if (netstacksCrawlerEditingId) {
          await updateNetStacksCrawlerSource(netstacksCrawlerEditingId, {
            name: netstacksCrawlerForm.name.trim(),
            api_resource_id: netstacksCrawlerForm.api_resource_id,
          });
        }
        await fetchNetStacksCrawlerSources();
        closeNetStacksCrawlerForm();
        showToast(`NetStacks-Crawler source ${isNew ? 'added' : 'updated'}`, 'success');
      } catch (err) {
        showToast(getErrorMessage(err, 'Save failed'), 'error');
      }
    });
  };

  const handleNetStacksCrawlerTest = async (s: NetStacksCrawlerSource) => {
    showToast(`Testing ${s.name}…`, 'info');
    try {
      const result = await testNetStacksCrawlerSource(s.id);
      showToast(`${s.name}: ${result.message}`, result.success ? 'success' : 'error');
    } catch (err) {
      showToast(getErrorMessage(err, 'Test failed'), 'error');
    }
  };

  const handleNetStacksCrawlerDelete = async (s: NetStacksCrawlerSource) => {
    const ok = await confirmDialog({
      title: 'Delete NetStacks-Crawler source?',
      body: <>Remove <strong>{s.name}</strong>? Topologies already discovered through it stay intact.</>,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await netstacksCrawlerSubmit.run(async () => {
      try {
        await deleteNetStacksCrawlerSource(s.id);
        await fetchNetStacksCrawlerSources();
        showToast('NetStacks-Crawler source deleted', 'success');
      } catch (err) {
        showToast(getErrorMessage(err, 'Delete failed'), 'error');
      }
    });
  };

  const handleAddSource = () => {
    setEditingSource(null);
    setDialogOpen(true);
  };

  const handleEditSource = (source: NetBoxSource) => {
    setEditingSource(source);
    setDialogOpen(true);
  };

  const handleDialogClose = () => {
    setDialogOpen(false);
    setEditingSource(null);
  };

  const handleDialogSaved = () => {
    setDialogOpen(false);
    setEditingSource(null);
    fetchSources();
  };

  const handleDeleteClick = (source: NetBoxSource) => {
    setDeleteConfirm(source);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return;

    try {
      setDeleting(true);
      await deleteNetBoxSource(deleteConfirm.id);
      setDeleteConfirm(null);
      fetchSources();
    } catch (err) {
      console.error('Failed to delete NetBox source:', err);
      setError('Failed to delete NetBox source');
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteConfirm(null);
  };

  const handleSync = (source: NetBoxSource) => {
    setSyncSourceId(source.id);
    setImportDialogOpen(true);
  };

  const handleImportDialogClose = () => {
    setImportDialogOpen(false);
    setSyncSourceId(undefined);
  };

  const handleImportComplete = () => {
    // Refresh the source list (last_sync_at, etc.) but leave the import dialog
    // open. The dialog shows a per-import report that the user dismisses with
    // "Done" or "Import More" — auto-closing here would hide it.
    fetchSources();
  };

  const handleImportFromFile = () => {
    // Trigger file input for session import
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const formData = new FormData();
        formData.append('file', file);
        const { data: result } = await getClient().http.post('/sessions/import', formData);
        // Audit P1-12: previous code blindly toasted "Imported 0
        // sessions successfully." for empty JSON, all-duplicates, and
        // {success: false, errors: [...]} responses. Inspect the
        // response shape before deciding success / warning / error.
        const created = result.sessions_created ?? result.imported ?? 0;
        const errors: unknown[] = Array.isArray(result.errors) ? result.errors : [];
        if (result.success === false || (created === 0 && errors.length > 0)) {
          showToast(
            `Import failed: ${errors[0] ?? 'no sessions were created'}`,
            'error',
          );
        } else if (created === 0) {
          showToast('Nothing to import — the file contained no new sessions.', 'warning');
        } else if (errors.length > 0) {
          showToast(
            `Imported ${created} sessions with ${errors.length} error${errors.length === 1 ? '' : 's'}.`,
            'warning',
          );
        } else {
          showToast(`Imported ${created} sessions successfully.`, 'success');
        }
      } catch (err) {
        console.error('Import error:', err);
        showToast('Failed to import sessions. Please check the file format.', 'error');
      }
    };
    input.click();
  };

  const handleExportToFile = async () => {
    try {
      const { data } = await getClient().http.get('/sessions/export');
      downloadFile(JSON.stringify(data, null, 2), `netstacks-sessions-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    } catch (err) {
      console.error('Export error:', err);
      showToast('Failed to export sessions.', 'error');
    }
  };

  const formatLastSync = (syncAt: string | null): string => {
    if (!syncAt) return 'Never synced';
    const date = new Date(syncAt);
    return date.toLocaleString();
  };

  const getStatusClass = (source: NetBoxSource): string => {
    if (source.last_sync_result) {
      return 'success';
    }
    return 'inactive';
  };

  if (loading) {
    return <div className="integrations-tab"><div className="integrations-loading">Loading integrations...</div></div>;
  }

  return (
    <div className="integrations-tab">
      <p className="integrations-intro">
        Integrations connect NetStacks to external systems. Each source uses an{' '}
        <strong>API Resource</strong> (Settings&nbsp;→&nbsp;API&nbsp;Resources) for its URL and
        credentials &mdash; set one up first, then add a source here that points at it.
      </p>

      {/* NetBox Sources Section */}
      <section className="integrations-section">
        <div className="section-header">
          <h3>NETBOX SOURCES</h3>
          <AskAiHelp prompt="Explain NetStacks Integrations vs API Resources, and walk me through adding a NetBox integration: create an API Resource (NetBox URL + API token), then a NetBox source that references it, and what device filters / profile mappings do." />
        </div>
        <p className="section-description">
          Import your NetBox device inventory as ready-to-connect sessions, with credential
          profiles mapped by site and role.{' '}
          <span className="section-description-req">Needs a NetBox API Resource.</span>
        </p>

        {error && <div className="integrations-error">{error}</div>}

        <div className="sources-list">
          {sources.length === 0 ? (
            <div className="sources-empty">
              <p>No NetBox sources configured.</p>
              <p>Add a NetBox instance to import devices as sessions.</p>
            </div>
          ) : (
            sources.map((source) => (
              <div key={source.id} className="source-item">
                <div className="source-status">
                  <span className={`status-dot ${getStatusClass(source)}`} />
                </div>
                <div className="source-info">
                  <div className="source-header">
                    <span className="source-icon">{Icons.netbox}</span>
                    <span className="source-name">{source.name}</span>
                  </div>
                  <div className="source-details">
                    <span className="source-url">Resource: {source.api_resource_id}</span>
                    <span className="source-separator">|</span>
                    <span className="source-sync">{formatLastSync(source.last_sync_at)}</span>
                  </div>
                </div>
                <div className="source-actions">
                  <button
                    className="source-action-btn"
                    onClick={() => handleSync(source)}
                    title="Sync"
                  >
                    {Icons.sync}
                    <span>Sync</span>
                  </button>
                  <button
                    className="source-action-btn"
                    onClick={() => handleEditSource(source)}
                    title="Edit"
                  >
                    {Icons.edit}
                    <span>Edit</span>
                  </button>
                  <button
                    className="source-action-btn delete"
                    onClick={() => handleDeleteClick(source)}
                    title="Delete"
                  >
                    {Icons.trash}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="section-footer">
          <button className="btn-add-source" onClick={handleAddSource}>
            {Icons.plus}
            <span>Add NetBox Source</span>
          </button>
        </div>
      </section>

      {/* LibreNMS Sources Section */}
      <section className="integrations-section">
        <div className="section-header">
          <h3>LIBRENMS SOURCES</h3>
        </div>
        <p className="section-description">
          Pull devices, CDP/LLDP links, and live interface port-stats from LibreNMS for
          topology maps and link-utilization views.{' '}
          <span className="section-description-req">Needs a LibreNMS API Resource.</span>
        </p>

        <div className="sources-list">
          {libreSources.length === 0 && libreEditingId === null ? (
            <div className="sources-empty">
              <p>No LibreNMS sources configured.</p>
              <p>Add a LibreNMS instance to pull devices and CDP/LLDP links into topology discovery.</p>
            </div>
          ) : (
            libreSources.map((s) => (
              <div key={s.id} className="source-item">
                <div className="source-status"><span className="status-dot inactive" /></div>
                <div className="source-info">
                  <div className="source-header">
                    <span className="source-name">{s.name}</span>
                  </div>
                  <div className="source-details">
                    <span className="source-url">Resource: {s.api_resource_id}</span>
                  </div>
                </div>
                <div className="source-actions">
                  <button className="source-action-btn" onClick={() => handleLibreTest(s)} title="Test connection">
                    <span>Test</span>
                  </button>
                  <button
                    className="source-action-btn"
                    onClick={() => openLibreNmsEdit(s)}
                    title="Edit"
                    disabled={libreSubmit.submitting}
                  >
                    {Icons.edit}
                    <span>Edit</span>
                  </button>
                  <button
                    className="source-action-btn delete"
                    onClick={() => handleLibreDelete(s)}
                    title="Delete"
                    disabled={libreSubmit.submitting}
                  >
                    {Icons.trash}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {libreEditingId !== null && (
          <div className="source-inline-form">
            <input
              type="text"
              placeholder="Name (e.g. Prod LibreNMS)"
              value={libreForm.name}
              onChange={(e) => setLibreForm({ ...libreForm, name: e.target.value })}
              disabled={libreSubmit.submitting}
            />
            <ApiResourcePicker
              value={libreForm.api_resource_id}
              onChange={(id) => setLibreForm({ ...libreForm, api_resource_id: id })}
              label="LibreNMS API Resource"
              required
            />
            <div className="source-inline-form-actions">
              <button className="btn-secondary" onClick={closeLibreNmsForm} disabled={libreSubmit.submitting}>
                Cancel
              </button>
              <button className="btn-primary" onClick={handleLibreNmsSave} disabled={libreSubmit.submitting}>
                {libreSubmit.submitting ? 'Saving…' : libreEditingId === 'new' ? 'Add' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {libreEditingId === null && (
          <div className="section-footer">
            <button className="btn-add-source" onClick={openLibreNmsAdd}>
              {Icons.plus}
              <span>Add LibreNMS Source</span>
            </button>
          </div>
        )}
      </section>

      {/* NetStacksCrawler Sources Section */}
      <section className="integrations-section">
        <div className="section-header">
          <h3>NETSTACKS-CRAWLER SOURCES</h3>
          <AskAiHelp prompt="What is the NetStacks-Crawler integration? Explain that it's just NetStacks' UI over Netdisco's REST API (/api/v1), and walk me through pointing a Crawler source at my existing Netdisco instance (API Resource base URL, auth, test path api/v1/device)." />
        </div>
        <p className="section-description">
          Pull discovered Layer-2 topology and neighbor data from a Netdisco crawler to build
          topology maps and enrich traceroute hops.{' '}
          <span className="section-description-req">Needs a NetStacks-Crawler API Resource.</span>
        </p>

        <div className="sources-list">
          {netstacksCrawlerSources.length === 0 && netstacksCrawlerEditingId === null ? (
            <div className="sources-empty">
              <p>No NetStacks-Crawler sources configured.</p>
              <p>Add a NetStacks-Crawler instance for L2 topology and neighbor discovery.</p>
            </div>
          ) : (
            netstacksCrawlerSources.map((s) => (
              <div key={s.id} className="source-item">
                <div className="source-status"><span className="status-dot inactive" /></div>
                <div className="source-info">
                  <div className="source-header">
                    <span className="source-name">{s.name}</span>
                  </div>
                  <div className="source-details">
                    <span className="source-url">Resource: {s.api_resource_id}</span>
                  </div>
                </div>
                <div className="source-actions">
                  <button className="source-action-btn" onClick={() => handleNetStacksCrawlerTest(s)} title="Test connection">
                    <span>Test</span>
                  </button>
                  <button
                    className="source-action-btn"
                    onClick={() => openNetStacksCrawlerEdit(s)}
                    title="Edit"
                    disabled={netstacksCrawlerSubmit.submitting}
                  >
                    {Icons.edit}
                    <span>Edit</span>
                  </button>
                  <button
                    className="source-action-btn delete"
                    onClick={() => handleNetStacksCrawlerDelete(s)}
                    title="Delete"
                    disabled={netstacksCrawlerSubmit.submitting}
                  >
                    {Icons.trash}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {netstacksCrawlerEditingId !== null && (
          <div className="source-inline-form">
            <input
              type="text"
              placeholder="Name (e.g. Prod NetStacks-Crawler)"
              value={netstacksCrawlerForm.name}
              onChange={(e) => setNetStacksCrawlerForm({ ...netstacksCrawlerForm, name: e.target.value })}
              disabled={netstacksCrawlerSubmit.submitting}
            />
            <ApiResourcePicker
              value={netstacksCrawlerForm.api_resource_id}
              onChange={(id) => setNetStacksCrawlerForm({ ...netstacksCrawlerForm, api_resource_id: id })}
              label="NetStacks-Crawler API Resource"
              required
            />
            <div className="source-inline-form-actions">
              <button className="btn-secondary" onClick={closeNetStacksCrawlerForm} disabled={netstacksCrawlerSubmit.submitting}>
                Cancel
              </button>
              <button className="btn-primary" onClick={handleNetStacksCrawlerSave} disabled={netstacksCrawlerSubmit.submitting}>
                {netstacksCrawlerSubmit.submitting
                  ? 'Saving…'
                  : netstacksCrawlerEditingId === 'new'
                  ? 'Add'
                  : 'Save'}
              </button>
            </div>
          </div>
        )}

        {netstacksCrawlerEditingId === null && (
          <div className="section-footer">
            <button className="btn-add-source" onClick={openNetStacksCrawlerAdd}>
              {Icons.plus}
              <span>Add NetStacks-Crawler Source</span>
            </button>
          </div>
        )}
      </section>

      {/* SMTP Email Settings Section */}
      <section className="integrations-section">
        <div className="section-header">
          <h3>EMAIL NOTIFICATIONS</h3>
        </div>
        <SmtpSettingsSection />
      </section>

      {/* Import/Export Section */}
      <section className="integrations-section">
        <div className="section-header">
          <h3>IMPORT / EXPORT</h3>
        </div>

        <div className="import-export-actions">
          <button className="btn-import-export" onClick={handleImportFromFile}>
            {Icons.import}
            <span>Import Sessions from File</span>
          </button>
          <button className="btn-import-export" onClick={() => setSecureCRTDialogOpen(true)}>
            {Icons.import}
            <span>Import from SecureCRT</span>
          </button>
          <button className="btn-import-export" onClick={handleExportToFile}>
            {Icons.export}
            <span>Export Sessions to File</span>
          </button>
        </div>
      </section>

      {/* Backup & Seed Section — whole-database export/import */}
      {backupSupported() && (
        <section className="integrations-section">
          <div className="section-header">
            <h3>BACKUP &amp; SEED</h3>
          </div>
          <p className="section-description">
            Back up or migrate your entire NetStacks setup (sessions, profiles, integrations,
            jump hosts — everything). Choose a save location when you export.
          </p>

          {/* Database Location */}
          <div className="db-location-row">
            <label className="db-location-label">Database Location</label>
            <div className="db-location-field">
              <input
                className="db-location-input"
                type="text"
                value={dbPathDraft}
                onChange={e => {
                  setDbPathDraft(e.target.value);
                  setDbPathDirty(e.target.value !== (dbInfo?.path ?? ''));
                }}
                placeholder="Database path…"
                disabled={dbBusy}
              />
              <button
                className="db-location-browse"
                onClick={handleDbPathBrowse}
                disabled={dbBusy}
                title="Browse…"
              >
                …
              </button>
              <button
                className="db-location-open"
                onClick={handleOpenDbDir}
                disabled={!dbInfo}
                title="Open folder in file manager"
              >
                {Icons.export}
              </button>
            </div>
            {dbPathDirty && (
              <button className="btn-primary" style={{ marginTop: '0.5rem', alignSelf: 'flex-start' }} onClick={handleDbPathApply} disabled={dbBusy}>
                {dbBusy ? 'Working…' : 'Apply & restart'}
              </button>
            )}
          </div>

          {/* Export */}
          <div className="seed-export" style={{ marginBottom: '1.25rem', marginTop: '1rem' }}>
            <fieldset style={{ border: '1px solid var(--border-color)', borderRadius: '4px', padding: '0.75rem', marginBottom: '0.75rem' }}>
              <legend style={{ padding: '0 0.5rem', fontWeight: 500 }}>What to export</legend>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <input type="radio" checked={exportMode === 'full'} onChange={() => setExportMode('full')} />
                <span><strong>Full backup</strong> — includes secrets (vault). For your own restore; protected by your master password.</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="radio" checked={exportMode === 'seed'} onChange={() => setExportMode('seed')} />
                <span><strong>Shareable seed</strong> — <em>no</em> secrets. Recipients set a master password and re-enter tokens/passwords in Settings.</span>
              </label>
            </fieldset>
            <button className="btn-add-source" onClick={handleDbExport} disabled={dbBusy}>
              {Icons.export}
              <span>{dbBusy ? 'Working…' : 'Export database…'}</span>
            </button>
          </div>

          {/* Import */}
          <div className="seed-import" style={{ marginBottom: '1rem' }}>
            <button className="btn-import-export" onClick={handleDbImport} disabled={dbBusy}>
              {Icons.import}
              <span>Import database…</span>
            </button>
            <p className="section-description" style={{ marginTop: '0.5rem' }}>
              Replaces your current data (backed up first), then restarts the app to apply.
            </p>
          </div>

          {/* Factory Reset */}
          <div className="seed-reset">
            <button className="btn-danger" onClick={handleDbReset} disabled={dbBusy} style={{ fontSize: '0.8rem' }}>
              Factory Reset…
            </button>
            <p className="section-description" style={{ marginTop: '0.5rem' }}>
              Wipes all data and starts fresh. Current database is backed up first.
            </p>
          </div>
        </section>
      )}

      {/* NetBox Source Dialog */}
      <NetBoxSourceDialog
        isOpen={dialogOpen}
        source={editingSource}
        onClose={handleDialogClose}
        onSaved={handleDialogSaved}
      />

      {/* NetBox Import Dialog (for Sync) */}
      <NetBoxImportDialog
        isOpen={importDialogOpen}
        onClose={handleImportDialogClose}
        onImportComplete={handleImportComplete}
        preSelectedSourceId={syncSourceId}
      />

      {/* SecureCRT Import Dialog */}
      <SecureCRTImportDialog
        isOpen={secureCRTDialogOpen}
        onClose={() => setSecureCRTDialogOpen(false)}
        onImportComplete={() => setSecureCRTDialogOpen(false)}
      />

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div className="delete-confirm-overlay" onClick={handleDeleteCancel}>
          <div className="delete-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete NetBox Source</h3>
            <p>Are you sure you want to delete "{deleteConfirm.name}"?</p>
            <p className="delete-confirm-warning">
              This will not delete sessions that were imported from this source.
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
    </div>
  );
}
