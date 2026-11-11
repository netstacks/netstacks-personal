import { type FC, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useLspClient } from './useLspClient'
import { LspInstallBanner } from './LspInstallBanner'
import { EnterpriseUnavailableBanner } from './EnterpriseUnavailableBanner'

interface LspBridgeProps {
  monaco: typeof Monaco
  editor: MonacoEditor.IStandaloneCodeEditor
  model: MonacoEditor.ITextModel
  language: string
  workspace: string | null
}

/**
 * Component that registers an LSP client for the given Monaco editor + model
 * and conditionally renders an install banner when an LSP plugin is available
 * but not yet installed.
 *
 * Phase 4: adds Pyrefly (Python LSP).
 * Phase 5: adds Settings UI for custom plugins.
 */
export const LspBridge: FC<LspBridgeProps> = (props) => {
  const { plugin, needsInstall, isEnterpriseUnavailable, refresh } = useLspClient(props)
  const [bannerDismissed, setBannerDismissed] = useState(false)

  // Enterprise unavailable takes precedence over install banner
  if (isEnterpriseUnavailable && plugin) {
    return <EnterpriseUnavailableBanner plugin={plugin} />
  }

  // Show install banner if plugin needs install and user hasn't dismissed it
  const showInstallBanner = needsInstall && !bannerDismissed && plugin

  return showInstallBanner ? (
    <LspInstallBanner
      plugin={plugin}
      onInstalled={() => {
        setBannerDismissed(true)
        refresh()
      }}
      onDismiss={() => setBannerDismissed(true)}
    />
  ) : null
}
