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
import { loadAppConfig, saveAppConfig } from '../lib/appConfig'
import { useMode } from '../hooks/useMode'
import { fetchCaCertificateInfo, installCaCertificate, type CaCertificateInfo } from '../api/tlsTrust'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'
import { confirmDialog } from './ConfirmDialog'

export default function SettingsConnection() {
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
      const newUrl = urlInput.trim() || null
      await saveAppConfig({ controllerUrl: newUrl })
      setUrlSuccess(newUrl
        ? 'Controller URL saved. Restart the app to apply changes.'
        : 'Controller URL cleared. Restart the app to switch to standalone mode.'
      )
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
      await saveAppConfig({ controllerUrl: null })
      setDeenrollMessage('Switched to standalone mode. Restart the app to apply.')
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
    <div className="settings-content">
      {/* Controller URL */}
      <div className="settings-category">
        <h3 className="settings-category-title">Controller Connection</h3>

        <div className="setting-item">
          <div className="setting-label">Controller URL</div>
          <div className="setting-description">
            {isEnterprise
              ? 'Connected to a NetStacks Controller. Change the URL and restart to switch controllers, or clear it to switch to standalone mode.'
              : 'Enter a Controller URL to connect in enterprise mode. Leave empty for standalone mode (local agent).'}
          </div>
          <div className="setting-control-block" style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' }}>
            <input
              type="text"
              className="setting-input"
              value={urlInput}
              onChange={(e) => {
                setUrlInput(e.target.value)
                setUrlSuccess(null)
                setUrlError(null)
              }}
              placeholder="https://controller.example.com:3000"
              style={{ flex: 1 }}
            />
            <button
              className="settings-btn settings-btn-primary"
              onClick={handleSaveUrl}
              disabled={urlSaving || urlInput === (controllerUrl || '')}
              style={{ whiteSpace: 'nowrap' }}
            >
              {urlSaving ? 'Saving...' : 'Save & Restart'}
            </button>
          </div>
          {urlSuccess && <div className="settings-success" style={{ marginTop: '8px' }}>{urlSuccess}</div>}
          {urlError && <div className="settings-error" style={{ marginTop: '8px' }}>{urlError}</div>}

          {/* Current mode indicator */}
          <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
            Current mode: <strong style={{ color: 'var(--text-secondary)' }}>
              {isEnterprise ? 'Enterprise' : 'Standalone'}
            </strong>
            {isEnterprise && controllerUrl && (
              <span> — {controllerUrl}</span>
            )}
          </div>
        </div>
      </div>

      {/* TLS Certificate Trust */}
      <div className="settings-category">
        <h3 className="settings-category-title">TLS Certificate</h3>

        {!controllerUrl && !urlInput ? (
          <div className="setting-item">
            <div style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>
              Configure a Controller URL above to manage TLS certificates.
            </div>
          </div>
        ) : caLoading ? (
          <div className="setting-item">
            <div style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>
              Checking TLS configuration...
            </div>
          </div>
        ) : caInfo?.tls_enabled ? (
          <>
            <div className="setting-item">
              <div className="setting-label">Status</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                <span style={{ color: '#4caf50', fontSize: '14px' }}>●</span>
                <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                  TLS enabled on Controller
                </span>
              </div>
            </div>

            {caInfo.fingerprint && (
              <div className="setting-item">
                <div className="setting-label">CA Fingerprint (SHA-256)</div>
                <div style={{
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  color: 'var(--text-secondary)',
                  backgroundColor: 'var(--bg-tertiary)',
                  padding: '8px 12px',
                  borderRadius: '4px',
                  wordBreak: 'break-all',
                  marginTop: '4px',
                  userSelect: 'all',
                }}>
                  {caInfo.fingerprint}
                </div>
                <div className="setting-description" style={{ marginTop: '4px' }}>
                  Verify this fingerprint matches what your administrator provided before trusting this certificate.
                </div>
              </div>
            )}

            <div className="setting-item">
              <div className="setting-label">Install CA Certificate</div>
              <div className="setting-description">
                Install the Controller's CA certificate to trust HTTPS connections without browser warnings.
                {!isTauri && ' Download the certificate and install it manually in your OS trust store.'}
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                {isTauri && (
                  <button
                    className="settings-btn settings-btn-primary"
                    onClick={handleInstallCa}
                    disabled={caInstalling || !caInfo.ca_certificate_pem}
                  >
                    {caInstalling ? 'Installing...' : 'Install to Trust Store'}
                  </button>
                )}
                <button
                  className="settings-btn"
                  onClick={handleDownloadCa}
                  disabled={!caInfo.ca_certificate_pem}
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                >
                  Download CA Certificate
                </button>
                <button
                  className="settings-btn"
                  onClick={fetchTlsInfo}
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                >
                  Refresh
                </button>
              </div>
              {caMessage && <div className="settings-success" style={{ marginTop: '8px' }}>{caMessage}</div>}
              {caError && <div className="settings-error" style={{ marginTop: '8px' }}>{caError}</div>}
            </div>
          </>
        ) : (
          <div className="setting-item">
            <div style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>
              {caInfo === null
                ? 'Unable to reach Controller. Check the URL and ensure the Controller is running.'
                : 'TLS is not enabled on this Controller. Contact your administrator to enable HTTPS.'}
            </div>
            <button
              className="settings-btn"
              onClick={fetchTlsInfo}
              style={{ marginTop: '8px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            >
              Check Again
            </button>
          </div>
        )}
      </div>

      {/* De-enroll from enterprise mode */}
      {isEnterprise && hasFeature('terminal_deenrollment') && (
        <div className="settings-category">
          <h3 className="settings-category-title">Switch to Standalone</h3>
          <div className="setting-item">
            <div className="setting-description">
              Disconnect from the Enterprise Controller and return to local agent mode. The app will restart in standalone mode.
            </div>
            <div style={{ marginTop: '12px' }}>
              <button
                className="settings-btn"
                onClick={handleDeenroll}
                disabled={deenrolling || !!deenrollMessage}
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--error, #e57373)',
                  border: '1px solid var(--error, #e57373)',
                }}
              >
                {deenrolling ? 'Switching...' : 'Switch to Standalone Mode'}
              </button>
            </div>
            {deenrollMessage && (
              <div className="settings-success" style={{ marginTop: '8px' }}>{deenrollMessage}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
