import { useState } from 'react';
import { installPlugin, deletePlugin, updatePlugin, type LspPluginListItem, type InstallEvent, subscribeToInstallProgress } from '../../lsp/installationApi';
import { showToast } from '../Toast';
import { confirmDialog } from '../ConfirmDialog';
import SettingsItem from './SettingsItem';

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
    // The progress stream only exists once the agent has accepted the
    // install POST — subscribing first 404s and the row never flips.
    try {
      await installPlugin(plugin.id);
    } catch (e) {
      setBusy(false);
      setInstallPhase(null);
      showToast(`Install failed: ${(e as Error).message}`, 'error');
      return;
    }
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

  const status = isUnavailable
    ? <span className="settings-badge settings-badge--danger">Unavailable in Enterprise Mode</span>
    : isInstalling
      ? <span className="settings-badge settings-badge--accent">Installing… {installPhase}</span>
      : <span className={plugin.installStatus === 'installed' ? 'settings-badge settings-badge--success' : 'settings-badge'}>{plugin.installStatus}</span>;

  return (
    <SettingsItem
      title={plugin.displayName}
      badges={
        <>
          {!isBuiltIn && <span className="settings-badge">custom</span>}
          {status}
        </>
      }
      meta={<span>{plugin.language} · {plugin.fileExtensions.join(', ')}</span>}
      actions={
        <>
          {!isInstalled && !isUnavailable && !isInstalling && plugin.installation.kind === 'on-demand-download' && (
            <button className="ns-btn ns-btn--small ns-btn--primary" disabled={busy} onClick={handleInstall}>Install</button>
          )}
          {isInstalled && (
            <button className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" disabled={busy} onClick={handleUninstall}>{isBuiltIn ? 'Uninstall' : 'Remove'}</button>
          )}
          <button className="ns-btn ns-btn--small ns-btn--ghost" disabled={busy} onClick={onEdit}>Edit</button>
          <button className="ns-btn ns-btn--small ns-btn--ghost" disabled={busy} onClick={handleToggleEnabled}>
            {plugin.defaultEnabled ? 'Disable' : 'Enable'}
          </button>
        </>
      }
    />
  );
}
