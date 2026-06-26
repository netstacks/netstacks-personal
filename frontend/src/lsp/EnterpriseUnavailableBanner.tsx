import { useState, type FC } from 'react';
import type { LspPluginListItem } from './types';

interface Props {
  plugin: LspPluginListItem;
}

const DISMISS_KEY = (pluginId: string) => `lsp-enterprise-banner-dismissed-${pluginId}`;

export const EnterpriseUnavailableBanner: FC<Props> = ({ plugin }) => {
  const [dismissed, setDismissed] = useState<boolean>(
    typeof window !== 'undefined' && localStorage.getItem(DISMISS_KEY(plugin.id)) === 'true'
  );

  if (dismissed) return null;

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY(plugin.id), 'true');
    setDismissed(true);
  };

  return (
    <div className="lsp-enterprise-banner">
      <span className="lsp-enterprise-banner__icon">ℹ️</span>
      <div className="lsp-enterprise-banner__body">
        <strong>{plugin.displayName} isn't available in Enterprise Mode yet</strong>
        <span>
          Language servers run via the local agent, which isn't part of Enterprise deployments.
          Basic syntax highlighting still works.
        </span>
      </div>
      <button onClick={handleDismiss}>Dismiss</button>
    </div>
  );
};
