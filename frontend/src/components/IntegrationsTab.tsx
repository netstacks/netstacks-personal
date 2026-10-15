import AITabInput from './AITabInput'
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
import SettingsSection from './settings/SettingsSection'
import SettingsItem from './settings/SettingsItem'
import SettingRow from './settings/SettingRow';
import NetBoxSourceDialog from './NetBoxSourceDialog';
import NetBoxImportDialog from './NetBoxImportDialog';
import SmtpSettingsSection from './SmtpSettingsSection';
import SecureCRTImportDialog from './SecureCRTImportDialog';
import ApiResourcePicker from './ApiResourcePicker';
import { downloadFile } from '../lib/formatters';
import { importSessions, type ExportData } from '../api/sessions';
import { showToast } from './Toast';
import { confirmDialog } from './ConfirmDialog';
import { useSubmitting } from '../hooks/useSubmitting';
import { exportDb, importDb, resetDb, getDbInfo, setDbPath, clearDbPath, backupSupported, type DbInfo } from '../api/db';
import './IntegrationsTab.css';

// Icons
import { getErrorMessage } from '../api/errors'
import DialogFooter from './DialogFooter';
import Tooltip from './Tooltip';
import ModalFrame from './ModalFrame';
const Icons = {
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

      // The agent's /sessions/import is a JSON endpoint (the same one the
      // session panel's Import uses) — parse the file here and post the body.
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        showToast(`${file.name} is not valid JSON.`, 'error');
        return;
      }
      const exportData = parsed as Partial<ExportData> | null;
      if (!exportData || !Array.isArray(exportData.sessions)) {
        showToast(`${file.name} is not a NetStacks session export (missing "sessions").`, 'error');
        return;
      }

      try {
        const result = await importSessions({
          version: exportData.version ?? '1.0',
          format: exportData.format ?? 'netstacks-sessions',
          exported_at: exportData.exported_at ?? new Date().toISOString(),
          sessions: exportData.sessions,
          folders: Array.isArray(exportData.folders) ? exportData.folders : [],
        });
        const created = result.sessions_created;
        const warnings = result.warnings ?? [];
        if (created > 0 || result.folders_created > 0) {
          window.dispatchEvent(new Event('sessions-changed'));
        }
        if (created === 0 && warnings.length > 0) {
          showToast(`Import failed: ${warnings[0]}`, 'error');
        } else if (created === 0) {
          showToast('Nothing to import — the file contained no new sessions.', 'warning');
        } else if (warnings.length > 0) {
          console.warn('Session import warnings:', warnings);
          showToast(
            `Imported ${created} sessions, ${result.folders_created} folders with ${warnings.length} warning${warnings.length === 1 ? '' : 's'} — see console.`,
            'warning',
          );
        } else {
          showToast(`Imported ${created} sessions, ${result.folders_created} folders.`, 'success');
        }
      } catch (err) {
        console.error('Import error:', err);
        showToast(getErrorMessage(err, 'Failed to import sessions'), 'error');
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

  const syncedOnce = (source: NetBoxSource): boolean => Boolean(source.last_sync_result);

  if (loading) {
    return <p className="form-hint">Loading integrations…</p>;
  }

  return (
    <>
      <p className="form-hint">
        Integrations connect NetStacks to external systems. Each source uses an{' '}
        <strong>API Resource</strong> (Settings&nbsp;→&nbsp;API&nbsp;Resources) for its URL and
        credentials &mdash; set one up first, then add a source here that points at it.
      </p>

      <SettingsSection
        title="NetBox Sources"
        description={<>
          Import your NetBox device inventory as ready-to-connect sessions, with credential
          profiles mapped by site and role. Needs a NetBox API Resource.
        </>}
        help={{
          topic: 'NetBox sources',
          prompt: `Help me set up NetBox in NetStacks. I have ${sources.length} NetBox source(s)${sources.length ? ` (${sources.map(src => src.name).join(', ')})` : ''}. `
            + 'Explain Integrations vs API Resources, then walk me through it: check my API Resources (list_api_resources) or open a pre-filled one (propose_api_resource: NetBox URL, bearer token, test path /api/status/), then add a NetBox source that references it, and explain device filters, profile mappings and CLI-flavor mappings.',
        }}
        actions={
          <button className="ns-btn ns-btn--small" onClick={handleAddSource}>+ Add NetBox source</button>
        }
      >
        {error && <p className="settings-error">{error}</p>}
        {sources.length === 0 ? (
          <p className="form-hint">No NetBox sources yet. Add a NetBox instance to import devices as sessions.</p>
        ) : (
          <div className="settings-group">
            {sources.map((source) => (
              <SettingsItem
                key={source.id}
                leading={<span className={`settings-status-dot${syncedOnce(source) ? ' settings-status-dot--ok' : ''}`} role="img" aria-label={syncedOnce(source) ? 'Synced' : 'Not synced yet'} />}
                title={source.name}
                meta={
                  <>
                    <span>Resource: {source.api_resource_id}</span>
                    <span>{formatLastSync(source.last_sync_at)}</span>
                  </>
                }
                actions={
                  <>
                    <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => handleSync(source)}>Sync</button>
                    <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => handleEditSource(source)}>Edit</button>
                    <button className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" onClick={() => handleDeleteClick(source)}>Delete</button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="LibreNMS Sources"
        description={<>
          Pull devices, CDP/LLDP links, and live interface port-stats from LibreNMS for
          topology maps and link-utilization views. Needs a LibreNMS API Resource.
        </>}
        help={{
          topic: 'LibreNMS sources',
          prompt: `Help me connect LibreNMS to NetStacks. I have ${libreSources.length} LibreNMS source(s)${libreSources.length ? ` (${libreSources.map(src => src.name).join(', ')})` : ''}. `
            + 'Walk me through creating the LibreNMS API Resource (base URL = my LibreNMS URL, auth = api-key header X-Auth-Token, test path /api/v0/system; list_api_resources shows what I have, propose_api_resource can open the form), then adding the source, and what it gives me in topology discovery and link utilization.',
        }}
        actions={libreEditingId === null && (
          <button className="ns-btn ns-btn--small" onClick={openLibreNmsAdd}>+ Add LibreNMS source</button>
        )}
      >
        {libreEditingId !== null && (
          <div className="settings-form">
            <div className="form-group">
              <label htmlFor="librenms-source-name">Name</label>
              <AITabInput
                id="librenms-source-name"
                placeholder="e.g. Prod LibreNMS"
                value={libreForm.name}
                onChange={(e) => setLibreForm({ ...libreForm, name: e.target.value })}
                disabled={libreSubmit.submitting}
                aiField="LibreNMS source name"
                aiPlaceholder="Short name for this LibreNMS instance (environment or region)"
                onAIValue={(v) => setLibreForm({ ...libreForm, name: v })}
              />
            </div>
            <ApiResourcePicker
              value={libreForm.api_resource_id}
              onChange={(id) => setLibreForm({ ...libreForm, api_resource_id: id })}
              label="LibreNMS API Resource"
              required
            />
            <DialogFooter
              primary={{ label: libreSubmit.submitting ? 'Saving…' : libreEditingId === 'new' ? 'Add' : 'Save', onClick: handleLibreNmsSave, disabled: libreSubmit.submitting }}
              onCancel={closeLibreNmsForm}
              cancelDisabled={libreSubmit.submitting}
              inline
            />
          </div>
        )}
        {libreSources.length === 0 ? (
          libreEditingId === null && <p className="form-hint">No LibreNMS sources yet. Add a LibreNMS instance to pull devices and CDP/LLDP links into topology discovery.</p>
        ) : (
          <div className="settings-group">
            {libreSources.map((s) => (
              <SettingsItem
                key={s.id}
                title={s.name}
                meta={<span>Resource: {s.api_resource_id}</span>}
                actions={
                  <>
                    <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => handleLibreTest(s)}>Test</button>
                    <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => openLibreNmsEdit(s)} disabled={libreSubmit.submitting}>Edit</button>
                    <button className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" onClick={() => handleLibreDelete(s)} disabled={libreSubmit.submitting}>Delete</button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="NetStacks-Crawler Sources"
        description={<>
          Pull discovered Layer-2 topology and neighbor data from a Netdisco crawler to build
          topology maps and enrich traceroute hops. Needs a NetStacks-Crawler API Resource.
        </>}
        help={{
          topic: 'NetStacks-Crawler sources',
          prompt: `Help me set up the NetStacks-Crawler integration. I have ${netstacksCrawlerSources.length} Crawler source(s)${netstacksCrawlerSources.length ? ` (${netstacksCrawlerSources.map(src => src.name).join(', ')})` : ''}. `
            + "Explain that it is NetStacks' UI over Netdisco's REST API (/api/v1), then walk me through the API Resource for my Netdisco instance (base URL = Netdisco host, basic or api-key auth, test path api/v1/device; propose_api_resource can open the form) and adding the Crawler source.",
        }}
        actions={netstacksCrawlerEditingId === null && (
          <button className="ns-btn ns-btn--small" onClick={openNetStacksCrawlerAdd}>+ Add Crawler source</button>
        )}
      >
        {netstacksCrawlerEditingId !== null && (
          <div className="settings-form">
            <div className="form-group">
              <label htmlFor="crawler-source-name">Name</label>
              <AITabInput
                id="crawler-source-name"
                placeholder="e.g. Prod NetStacks-Crawler"
                value={netstacksCrawlerForm.name}
                onChange={(e) => setNetStacksCrawlerForm({ ...netstacksCrawlerForm, name: e.target.value })}
                disabled={netstacksCrawlerSubmit.submitting}
                aiField="NetStacks-Crawler source name"
                aiPlaceholder="Short name for this Netdisco crawler instance (environment or region)"
                onAIValue={(v) => setNetStacksCrawlerForm({ ...netstacksCrawlerForm, name: v })}
              />
            </div>
            <ApiResourcePicker
              value={netstacksCrawlerForm.api_resource_id}
              onChange={(id) => setNetStacksCrawlerForm({ ...netstacksCrawlerForm, api_resource_id: id })}
              label="NetStacks-Crawler API Resource"
              required
            />
            <DialogFooter
              primary={{
                label: netstacksCrawlerSubmit.submitting ? 'Saving…' : netstacksCrawlerEditingId === 'new' ? 'Add' : 'Save',
                onClick: handleNetStacksCrawlerSave,
                disabled: netstacksCrawlerSubmit.submitting,
              }}
              onCancel={closeNetStacksCrawlerForm}
              cancelDisabled={netstacksCrawlerSubmit.submitting}
              inline
            />
          </div>
        )}
        {netstacksCrawlerSources.length === 0 ? (
          netstacksCrawlerEditingId === null && <p className="form-hint">No NetStacks-Crawler sources yet. Add a NetStacks-Crawler instance for L2 topology and neighbor discovery.</p>
        ) : (
          <div className="settings-group">
            {netstacksCrawlerSources.map((s) => (
              <SettingsItem
                key={s.id}
                title={s.name}
                meta={<span>Resource: {s.api_resource_id}</span>}
                actions={
                  <>
                    <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => handleNetStacksCrawlerTest(s)}>Test</button>
                    <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => openNetStacksCrawlerEdit(s)} disabled={netstacksCrawlerSubmit.submitting}>Edit</button>
                    <button className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" onClick={() => handleNetStacksCrawlerDelete(s)} disabled={netstacksCrawlerSubmit.submitting}>Delete</button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </SettingsSection>

      <SmtpSettingsSection />

      <SettingsSection title="Import / Export Sessions">
        <div className="settings-group">
          <SettingRow label="Import sessions from a file" description="JSON or CSV exported from NetStacks or another tool.">
            <button className="ns-btn ns-btn--small" onClick={handleImportFromFile}>Import…</button>
          </SettingRow>
          <SettingRow label="Import from SecureCRT" description="Read sessions from a SecureCRT export.">
            <button className="ns-btn ns-btn--small" onClick={() => setSecureCRTDialogOpen(true)}>Import…</button>
          </SettingRow>
          <SettingRow label="Export sessions to a file">
            <button className="ns-btn ns-btn--small" onClick={handleExportToFile}>Export…</button>
          </SettingRow>
        </div>
      </SettingsSection>

      {backupSupported() && (
        <SettingsSection
          title="Backup & Seed"
          description="Back up or migrate your entire NetStacks setup (sessions, profiles, integrations, jump hosts — everything). Choose a save location when you export."
        >
          <div className="settings-group">
            <SettingRow label="Database Location" stacked>
              <div className="integrations-db-path">
                <input data-ai-fill="off"
                  className="ns-input"
                  aria-label="Database Location"
                  type="text"
                  value={dbPathDraft}
                  onChange={e => {
                    setDbPathDraft(e.target.value);
                    setDbPathDirty(e.target.value !== (dbInfo?.path ?? ''));
                  }}
                  placeholder="Database path…"
                  disabled={dbBusy}
                />
                <button className="ns-btn ns-btn--small" onClick={handleDbPathBrowse} disabled={dbBusy}>Browse…</button>
                <Tooltip label="Open folder in file manager"><button
                  className="ns-btn ns-btn--ghost ns-btn--small ns-icon-btn"
                  onClick={handleOpenDbDir}
                  disabled={!dbInfo}
                  aria-label="Open folder in file manager"
                >
                  {Icons.export}
                </button></Tooltip>
                {dbPathDirty && (
                  <button className="ns-btn ns-btn--small ns-btn--primary" onClick={handleDbPathApply} disabled={dbBusy}>
                    {dbBusy ? 'Working…' : 'Apply & restart'}
                  </button>
                )}
              </div>
            </SettingRow>
            <SettingRow label="Export database" stacked>
              <div className="integrations-export-modes" role="radiogroup" aria-label="What to export">
                <label>
                  <input type="radio" checked={exportMode === 'full'} onChange={() => setExportMode('full')} />
                  <span><strong>Full backup</strong> — includes secrets (vault). For your own restore; protected by your master password.</span>
                </label>
                <label>
                  <input type="radio" checked={exportMode === 'seed'} onChange={() => setExportMode('seed')} />
                  <span><strong>Shareable seed</strong> — <em>no</em> secrets. Recipients set a master password and re-enter tokens/passwords in Settings.</span>
                </label>
              </div>
              <div>
                <button className="ns-btn ns-btn--small ns-btn--primary" onClick={handleDbExport} disabled={dbBusy}>
                  {dbBusy ? 'Working…' : 'Export database…'}
                </button>
              </div>
            </SettingRow>
            <SettingRow label="Import database" description="Replaces your current data (backed up first), then restarts the app to apply.">
              <button className="ns-btn ns-btn--small" onClick={handleDbImport} disabled={dbBusy}>Import database…</button>
            </SettingRow>
            <SettingRow label="Factory reset" description="Wipes all data and starts fresh. The current database is backed up first.">
              <button className="ns-btn ns-btn--small ns-btn--danger" onClick={handleDbReset} disabled={dbBusy}>Factory Reset…</button>
            </SettingRow>
          </div>
        </SettingsSection>
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
        <ModalFrame id="integration-delete" resizable={false} className="delete-confirm-dialog" label="Delete source">
          <h3>Delete NetBox Source</h3>
          <p>Are you sure you want to delete "{deleteConfirm.name}"?</p>
          <p className="delete-confirm-warning">
            This will not delete sessions that were imported from this source.
          </p>
          <DialogFooter
            primary={{ label: deleting ? 'Deleting...' : 'Delete', onClick: handleDeleteConfirm, disabled: deleting, danger: true }}
            onCancel={handleDeleteCancel}
            cancelDisabled={deleting}
            inline
          />
        </ModalFrame>
      )}
    </>
  );
}
