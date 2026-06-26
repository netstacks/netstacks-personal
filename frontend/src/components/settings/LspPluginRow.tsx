import { useState } from 'react';
import { installPlugin, deletePlugin, updatePlugin, type LspPluginListItem, type InstallEvent, subscribeToInstallProgress } from '../../lsp/installationApi';
import { showToast } from '../Toast';
import { confirmDialog } from '../ConfirmDialog';

interface Props {
  plugin: LspPluginListItem;
  onChanged: () => void;
  onEdit: () => void;
}

export function LspPluginRow({ plugin, onChanged, onEdit }: Props) {
  const [busy, setBusy] = useState(false);
  const [installPhase, setInstallPhase] = useState<InstallEvent['phase'] | null>(null);

  const isBuiltIn = plugin.source === 'built-in';
  const isInstalled = plugin.installStatus === 'installed';
  const isInstalling = plugin.installStatus === 'installing' || installPhase !== null;
  const isUnavailable = plugin.installStatus === 'unavailable';

  const handleInstall = async () => {
    setBusy(true);
    setInstallPhase('downloading');
    const unsub = subscribeToInstallProgress(
      plugin.id,
      (ev) => {
        setInstallPhase(ev.phase);
        if (ev.phase === 'done' || ev.phase === 'error') {
          unsub();
          setBusy(false);
          setInstallPhase(null);
          onChanged();
        }
      },
      () => { setBusy(false); setInstallPhase(null); }
    );
    try {
      await installPlugin(plugin.id);
    } catch (e) {
      unsub();
      setBusy(false);
      setInstallPhase(null);
      showToast(`Install failed: ${(e as Error).message}`, 'error');
    }
  };

  const handleUninstall = async () => {
    const ok = await confirmDialog({
      title: 'Remove language server?',
      body: (
        <>
          Uninstall <strong>{plugin.displayName}</strong>? The installed files
          will be removed; the plugin entry stays so you can reinstall later.
        </>
      ),
      confirmLabel: 'Uninstall',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deletePlugin(plugin.id);
      onChanged();
      showToast(`Uninstalled ${plugin.displayName}`, 'success');
    } catch (e) {
      showToast(`Uninstall failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleEnabled = async () => {
    setBusy(true);
    try {
      await updatePlugin(plugin.id, { enabled: !plugin.defaultEnabled });
      onChanged();
    } catch (e) {
      showToast(`Toggle failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lsp-plugin-row">
      <div className="lsp-plugin-row__info">
        <strong>{plugin.displayName}</strong>
        <span className="lsp-plugin-row__meta">
          {plugin.language} · {plugin.fileExtensions.join(', ')}
        </span>
      </div>
      <div className="lsp-plugin-row__status">
        {isUnavailable && <span className="status-badge unavailable">Unavailable in Enterprise Mode</span>}
        {isInstalling && <span className="status-badge installing">Installing… {installPhase}</span>}
        {!isUnavailable && !isInstalling && (
          <span className={`status-badge ${plugin.installStatus}`}>{plugin.installStatus}</span>
        )}
      </div>
      <div className="lsp-plugin-row__actions">
        {!isInstalled && !isUnavailable && !isInstalling && plugin.installation.kind === 'on-demand-download' && (
          <button disabled={busy} onClick={handleInstall}>Install</button>
        )}
        {isInstalled && (
          <button disabled={busy} onClick={handleUninstall}>{isBuiltIn ? 'Uninstall' : 'Remove'}</button>
        )}
        <button disabled={busy} onClick={onEdit}>Edit</button>
        <button disabled={busy} onClick={handleToggleEnabled}>
          {plugin.defaultEnabled ? 'Disable' : 'Enable'}
        </button>
      </div>
    </div>
  );
}
