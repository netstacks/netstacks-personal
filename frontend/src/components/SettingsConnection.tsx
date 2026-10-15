import { getErrorMessage } from '../api/errors'
/**
 * SettingsConnection — Controller URL configuration and TLS trust management
 *
 * Allows users to:
 * - View/edit the Controller URL (switches between standalone and enterprise mode)
 * - Download and install the Controller's TLS CA certificate
 * - View TLS connection status and CA fingerprint
 */

import { useState, useEffect, useCallback } from 'react'
import { loadAppConfig } from '../lib/appConfig'
import { switchToEnterprise, switchToStandalone } from '../lib/switchMode'
import { useMode } from '../hooks/useMode'
import { fetchCaCertificateInfo, installCaCertificate, type CaCertificateInfo } from '../api/tlsTrust'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'
import { confirmDialog } from './ConfirmDialog'
import SettingsSection from './settings/SettingsSection'
import SettingRow from './settings/SettingRow'
import './SettingsConnection.css'

interface SettingsConnectionProps {
  /** Contextual "Ask AI" help on the connection section. */
  help?: { topic: string; prompt: string }
}

export default function SettingsConnection({ help }: SettingsConnectionProps) {
  const { controllerUrl, isEnterprise } = useMode()
  const hasFeature = useCapabilitiesStore((s) => s.hasFeature)

  // Controller URL editing
  const [urlInput, setUrlInput] = useState(controllerUrl || '')
  const [urlSaving, setUrlSaving] = useState(false)
  const [urlSuccess, setUrlSuccess] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)

  // TLS CA certificate state
  const [caInfo, setCaInfo] = useState<CaCertificateInfo | null>(null)
  const [caLoading, setCaLoading] = useState(false)
  const [caInstalling, setCaInstalling] = useState(false)
  const [caMessage, setCaMessage] = useState<string | null>(null)
  const [caError, setCaError] = useState<string | null>(null)

  // Load current config on mount
  useEffect(() => {
    loadAppConfig().then(config => {
      setUrlInput(config.controllerUrl || '')
    })
  }, [])

  // Fetch TLS CA info when we have a controller URL
  const fetchTlsInfo = useCallback(async () => {
    const url = controllerUrl || urlInput
    if (!url) return

    setCaLoading(true)
    setCaError(null)
    try {
      const info = await fetchCaCertificateInfo(url)
      setCaInfo(info)
    } catch {
      setCaInfo(null)
    } finally {
      setCaLoading(false)
    }
  }, [controllerUrl, urlInput])

  useEffect(() => {
    if (controllerUrl) {
      fetchTlsInfo()
    }
  }, [controllerUrl, fetchTlsInfo])

  // Save Controller URL
  const handleSaveUrl = async () => {
    setUrlSaving(true)
    setUrlError(null)
    setUrlSuccess(null)

    try {
      // Save + relaunch (NS-SET-7). Outside Tauri the helpers can't
      // relaunch and return a "restart the app" instruction instead.
      const newUrl = urlInput.trim()
      const message = newUrl ? await switchToEnterprise(newUrl) : await switchToStandalone()
      setUrlSuccess(message)
    } catch (err) {
      setUrlError(getErrorMessage(err, 'Failed to save'))
    } finally {
      setUrlSaving(false)
    }
  }

  // Install CA certificate
  const handleInstallCa = async () => {
    if (!caInfo?.ca_certificate_pem) return

    setCaInstalling(true)
    setCaMessage(null)
    setCaError(null)

    try {
      const message = await installCaCertificate(caInfo.ca_certificate_pem)
      setCaMessage(message)
    } catch (err) {
      setCaError(getErrorMessage(err, 'Failed to install certificate'))
    } finally {
      setCaInstalling(false)
    }
  }

  // De-enroll from enterprise mode
  const [deenrolling, setDeenrolling] = useState(false)
  const [deenrollMessage, setDeenrollMessage] = useState<string | null>(null)

  const handleDeenroll = async () => {
    const ok = await confirmDialog({
      title: 'Switch to standalone mode?',
      body: 'You will lose access to controller-side sessions, MOPs, and shared resources until you re-enroll. The app will need to restart.',
      confirmLabel: 'Switch to standalone',
      destructive: true,
    })
    if (!ok) return
    setDeenrolling(true)
    setDeenrollMessage(null)
    try {
      setDeenrollMessage(await switchToStandalone())
    } catch {
      setDeenrollMessage('Failed to de-enroll. Try clearing the URL above.')
    } finally {
      setDeenrolling(false)
    }
  }

  // Download CA cert as file (for manual install / browsers)
  const handleDownloadCa = () => {
    if (!caInfo?.ca_certificate_pem) return
    const blob = new Blob([caInfo.ca_certificate_pem], { type: 'application/x-pem-file' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'netstacks-ca.pem'
    a.click()
    URL.revokeObjectURL(url)
  }

  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  return (
    <>
      <SettingsSection
        title="Controller Connection"
        description={isEnterprise
          ? 'Connected to a NetStacks Controller. Your team\'s devices, credentials and configurations are managed centrally. Change the URL and restart to switch controllers, or clear it to switch to standalone mode.'
          : 'If your team has a NetStacks Controller, enter its URL and the app restarts in enterprise mode. Leave it empty for standalone mode (local agent).'}
        help={help}
        actions={<span className={isEnterprise ? 'settings-badge settings-badge--success' : 'settings-badge'}>{isEnterprise ? 'Enterprise' : 'Standalone'}</span>}
      >
        <div className="settings-group">
          <SettingRow
            label="Controller URL"
            description={isEnterprise && controllerUrl ? `Current: ${controllerUrl}` : undefined}
            stacked
          >
            <div className="settings-connection-url">
              <input data-ai-fill="off"
                type="text"
                aria-label="Controller URL"
                className="ns-input"
                value={urlInput}
                onChange={(e) => {
                  setUrlInput(e.target.value)
                  setUrlSuccess(null)
                  setUrlError(null)
                }}
                placeholder="https://controller.example.com:3000"
              />
              <button
                className="ns-btn ns-btn--primary"
                onClick={handleSaveUrl}
                disabled={urlSaving || urlInput === (controllerUrl || '')}
              >
                {urlSaving ? 'Saving...' : 'Save & Restart'}
              </button>
            </div>
            {urlSuccess && <p className="settings-success">{urlSuccess}</p>}
            {urlError && <p className="settings-error">{urlError}</p>}
          </SettingRow>
        </div>
      </SettingsSection>

      <SettingsSection
        title="TLS Certificate"
        actions={(controllerUrl || urlInput) && !caLoading && (
          <button className="ns-btn ns-btn--small" onClick={fetchTlsInfo}>
            {caInfo?.tls_enabled ? 'Refresh' : 'Check Again'}
          </button>
        )}
      >
        {!controllerUrl && !urlInput ? (
          <p className="form-hint">Configure a Controller URL above to manage TLS certificates.</p>
        ) : caLoading ? (
          <p className="form-hint">Checking TLS configuration…</p>
        ) : caInfo?.tls_enabled ? (
          <div className="settings-group">
            <SettingRow label="Status">
              <span className="settings-badge settings-badge--success">TLS enabled</span>
            </SettingRow>
            {caInfo.fingerprint && (
              <SettingRow
                label="CA Fingerprint (SHA-256)"
                description="Verify this fingerprint matches what your administrator provided before trusting this certificate."
                stacked
              >
                <code className="settings-connection-fingerprint">{caInfo.fingerprint}</code>
              </SettingRow>
            )}
            <SettingRow
              label="Install CA Certificate"
              description={`Install the Controller's CA certificate to trust HTTPS connections without browser warnings.${!isTauri ? ' Download the certificate and install it manually in your OS trust store.' : ''}`}
              stacked
            >
              <div className="settings-connection-actions">
                {isTauri && (
                  <button
                    className="ns-btn ns-btn--primary"
                    onClick={handleInstallCa}
                    disabled={caInstalling || !caInfo.ca_certificate_pem}
                  >
                    {caInstalling ? 'Installing...' : 'Install to Trust Store'}
                  </button>
                )}
                <button
                  className="ns-btn"
                  onClick={handleDownloadCa}
                  disabled={!caInfo.ca_certificate_pem}
                >
                  Download CA Certificate
                </button>
              </div>
              {caMessage && <p className="settings-success">{caMessage}</p>}
              {caError && <p className="settings-error">{caError}</p>}
            </SettingRow>
          </div>
        ) : (
          <p className="form-hint">
            {caInfo === null
              ? 'Unable to reach Controller. Check the URL and ensure the Controller is running.'
              : 'TLS is not enabled on this Controller. Contact your administrator to enable HTTPS.'}
          </p>
        )}
      </SettingsSection>

      {isEnterprise && hasFeature('terminal_deenrollment') && (
        <SettingsSection
          title="Switch to Standalone"
          description="Disconnect from the Enterprise Controller and return to local agent mode. The app restarts in standalone mode."
          actions={
            <button
              className="ns-btn ns-btn--small ns-btn--danger"
              onClick={handleDeenroll}
              disabled={deenrolling || !!deenrollMessage}
            >
              {deenrolling ? 'Switching...' : 'Switch to Standalone'}
            </button>
          }
        >
          {deenrollMessage && <p className="settings-success">{deenrollMessage}</p>}
        </SettingsSection>
      )}
    </>
  )
}
