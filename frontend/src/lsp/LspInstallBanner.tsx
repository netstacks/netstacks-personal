import { useState, useEffect, type FC } from 'react';
import type { LspPluginListItem } from './types';
import { installPlugin, subscribeToInstallProgress, type InstallEvent } from './installationApi';

interface Props {
  plugin: LspPluginListItem;
  /** Called when install succeeds; parent should re-fetch plugin list. */
  onInstalled: () => void;
  /** Called when user dismisses the banner. */
  onDismiss: () => void;
}

type BannerState =
  | { kind: 'offer' }
  | { kind: 'installing'; phase: InstallEvent['phase']; pct?: number }
  | { kind: 'error'; message: string };

const DONT_ASK_KEY = (pluginId: string) => `lsp-banner-dismissed-${pluginId}`;

export const LspInstallBanner: FC<Props> = ({ plugin, onInstalled, onDismiss }) => {
  const [state, setState] = useState<BannerState>({ kind: 'offer' });

  // Hook declaration must come before any early return so React sees the
  // same hook count + order on every render of this fiber. The effect is
  // self-gated on `state.kind === 'installing'`, so it's a cheap no-op
  // when the banner is dismissed or showing the offer / error UI.
  useEffect(() => {
    if (state.kind !== 'installing') return;
    let unsub: (() => void) | null = null;
    unsub = subscribeToInstallProgress(
      plugin.id,
      (ev) => {
        if (ev.phase === 'done') {
          onInstalled();
          unsub?.();
          return;
        }
        if (ev.phase === 'error') {
          setState({ kind: 'error', message: ev.error ?? 'Install failed' });
          unsub?.();
          return;
        }
        const pct =
          ev.totalBytes && ev.bytesDownloaded
            ? Math.round((ev.bytesDownloaded / ev.totalBytes) * 100)
            : undefined;
        setState({ kind: 'installing', phase: ev.phase, pct });
      },
      (err) => {
        setState({ kind: 'error', message: err.message });
      }
    );
    return () => {
      unsub?.();
    };
  }, [state.kind, plugin.id, onInstalled]);

  // Don't render if user previously checked "Don't ask again". Done AFTER
  // all hooks for Rules-of-Hooks compliance.
  const dismissed = typeof window !== 'undefined' && localStorage.getItem(DONT_ASK_KEY(plugin.id)) === 'true';
  if (dismissed) return null;

  const handleInstall = async () => {
    setState({ kind: 'installing', phase: 'downloading' });
    try {
      await installPlugin(plugin.id);
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message });
    }
  };

  const handleDontAskAgain = () => {
    localStorage.setItem(DONT_ASK_KEY(plugin.id), 'true');
    onDismiss();
  };

  return (
    <div className="lsp-install-banner">
      {state.kind === 'offer' && (
        <>
          <span className="lsp-install-banner__icon">🐍</span>
          <div className="lsp-install-banner__body">
            <strong>Get rich {plugin.displayName} language features?</strong>
            <span>Install {plugin.displayName} for diagnostics, autocomplete, hover docs, and go-to-definition.</span>
          </div>
          <div className="lsp-install-banner__actions">
            <button className="primary" onClick={handleInstall}>Install</button>
            <button onClick={onDismiss}>Skip</button>
            <button onClick={handleDontAskAgain}>Don't ask again</button>
          </div>
        </>
      )}
      {state.kind === 'installing' && (
        <>
          <span className="lsp-install-banner__icon">⏳</span>
          <div className="lsp-install-banner__body">
            <strong>Installing {plugin.displayName}…</strong>
            <span>
              {phaseLabel(state.phase)}
              {state.pct !== undefined ? ` (${state.pct}%)` : ''}
            </span>
          </div>
        </>
      )}
      {state.kind === 'error' && (
        <>
          <span className="lsp-install-banner__icon">⚠️</span>
          <div className="lsp-install-banner__body">
            <strong>{plugin.displayName} install failed</strong>
            <span>{state.message}</span>
          </div>
          <div className="lsp-install-banner__actions">
            <button onClick={handleInstall}>Retry</button>
            <button onClick={onDismiss}>Dismiss</button>
          </div>
        </>
      )}
    </div>
  );
};

function phaseLabel(phase: InstallEvent['phase']): string {
  switch (phase) {
    case 'downloading': return 'Downloading';
    case 'verifying': return 'Verifying';
    case 'extracting': return 'Extracting';
    case 'smoke-testing': return 'Verifying binary';
    case 'done': return 'Done';
    case 'error': return 'Error';
  }
}
