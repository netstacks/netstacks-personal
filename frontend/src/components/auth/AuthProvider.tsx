import type { ReactNode } from 'react';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuthStore, connectAuthStoreToClient } from '../../stores/authStore';
import { useMode } from '../../hooks/useMode';
import { useProactiveRefresh } from '../../hooks/useProactiveRefresh';
import { useIdleTimeout } from '../../hooks/useIdleTimeout';
import { restoreSessionState, clearSessionState } from '../../utils/sessionState';
import { LoginScreen } from './LoginScreen';
import { IdleWarningDialog } from './IdleWarningDialog';
import { NetworkStatusBanner } from '../NetworkStatusBanner';
import { logger } from '../../lib/logger'
import { getErrorMessage } from '../../api/errors'
import './LoginScreen.css'; // For auth-loading styles

function isTlsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message || '';
  const code = (error as { code?: string }).code || '';
  return code === 'ERR_NETWORK' || code === 'ERR_CERT_AUTHORITY_INVALID' ||
    code === 'ERR_CERT_COMMON_NAME_INVALID' || msg.includes('certificate') ||
    msg.includes('SSL') || msg.includes('TLS');
}

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Auth provider component that wraps the app.
 * In Enterprise mode, shows login screen if not authenticated.
 * In Personal mode, passes through to children directly.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const { isEnterprise, isInitialized, controllerUrl } = useMode();
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const isLoading = useAuthStore(state => state.isLoading);
  const [isChecking, setIsChecking] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [trustingCert, setTrustingCert] = useState(false);
  const [trustStatus, setTrustStatus] = useState<string | null>(null);

  // AUDIT FIX (AUTH-004): two-step controller-cert trust flow.
  //
  // Stage 1: fetch the controller's CA cert info (with TLS verification
  //          disabled — first-contact bootstrap).
  // Stage 2: show the SHA-256 fingerprint and require the user to either
  //          (a) paste the fingerprint they got out-of-band from the
  //              controller admin (or scan it from a QR), and we
  //              constant-time compare; OR
  //          (b) explicitly confirm "I trust this fingerprint" if they're
  //              comfortable with the risk (e.g. dev environment).
  //
  // Without this, a LAN-positioned attacker on first connect could
  // substitute their own CA, install it as a trust root in the user's
  // login keychain, and MITM all HTTPS from that user account onwards.
  const [pendingCert, setPendingCert] = useState<{ pem: string; fingerprint: string } | null>(null);
  const [expectedFingerprint, setExpectedFingerprint] = useState('');
  const [fingerprintMismatch, setFingerprintMismatch] = useState(false);
  const hasCheckedAuth = useRef(false);
  const hasConnectedClient = useRef(false);
  const hasRestoredState = useRef(false);

  const isTlsCertError = connectionError?.includes('untrusted TLS certificate') ?? false;

  const retryConnection = useCallback(async () => {
    setIsChecking(true);
    setConnectionError(null);
    setTrustStatus(null);
    hasCheckedAuth.current = false;
    try {
      // Probe the controller health endpoint first to detect TLS errors
      // before attempting auth. This catches the case where there's no
      // saved refresh token (first connection) — checkAuth returns early
      // without making a network call, so TLS errors go undetected.
      if (controllerUrl) {
        const { default: axios } = await import('axios');
        await axios.get(`${controllerUrl}/health`, { timeout: 10000 });
      }
      await useAuthStore.getState().checkAuth();
      setConnectionError(null);
    } catch (error) {
      const isNetworkError = error instanceof Error &&
        (error.message.includes('Network Error') ||
         error.message.includes('ECONNREFUSED') ||
         (error as { code?: string }).code?.startsWith('ERR_'));
      if (isNetworkError) {
        const tlsErr = isTlsError(error);
        setConnectionError(
          tlsErr
            ? 'Cannot connect — the Controller has an untrusted TLS certificate.'
            : 'Cannot connect to Controller. Check your Controller URL in Settings.'
        );
      }
    } finally {
      setIsChecking(false);
    }
  }, [controllerUrl]);

  // Stage 1: fetch the cert (TLS verification disabled — bootstrap only)
  // and surface its SHA-256 fingerprint for review. Does NOT install.
  const handleFetchCert = useCallback(async () => {
    if (!controllerUrl) return;
    setTrustingCert(true);
    setTrustStatus('Fetching certificate from controller...');
    setFingerprintMismatch(false);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const certInfo = await invoke<{ ca_certificate_pem?: string; fingerprint?: string }>('fetch_controller_cert', { controllerUrl });

      if (!certInfo.ca_certificate_pem) {
        setTrustStatus('Controller did not return a CA certificate.');
        return;
      }
      if (!certInfo.fingerprint) {
        setTrustStatus('Controller did not return a fingerprint — refusing to install for safety.');
        return;
      }

      setPendingCert({ pem: certInfo.ca_certificate_pem, fingerprint: certInfo.fingerprint });
      setTrustStatus(null);
    } catch (err) {
      setTrustStatus(`Failed: ${getErrorMessage(err, String(err))}`);
    } finally {
      setTrustingCert(false);
    }
  }, [controllerUrl]);

  /** Constant-time-ish compare two fingerprints, normalising whitespace
   *  and case so the user can paste from anywhere (with or without colons,
   *  with or without the `SHA256:` prefix). */
  const fingerprintsMatch = (a: string, b: string): boolean => {
    const norm = (s: string) => s.replace(/^SHA256:/i, '').replace(/[:\s]/g, '').toLowerCase();
    const aa = norm(a);
    const bb = norm(b);
    if (aa.length !== bb.length || aa.length === 0) return false;
    let diff = 0;
    for (let i = 0; i < aa.length; i++) {
      diff |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
    }
    return diff === 0;
  };

  // Stage 2: install only after the user has either pasted the expected
  // fingerprint (and it matches) or explicitly clicked the lower-trust
  // "I trust this fingerprint" path.
  const handleConfirmAndInstall = useCallback(async (mode: 'verified' | 'visual') => {
    if (!pendingCert) return;
    if (mode === 'verified') {
      if (!fingerprintsMatch(expectedFingerprint, pendingCert.fingerprint)) {
        setFingerprintMismatch(true);
        return;
      }
      setFingerprintMismatch(false);
    }
    setTrustingCert(true);
    setTrustStatus('Installing certificate to your keychain...');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<string>('install_ca_certificate', {
        pemContent: pendingCert.pem,
        filename: 'netstacks-controller-ca.pem',
      });
      setTrustStatus(result || 'Certificate installed. Reloading...');
      setPendingCert(null);
      setExpectedFingerprint('');
      // The webview caches its TLS state — a simple retry won't pick up
      // the newly trusted cert. Reload the page to force the webview to
      // re-read the OS trust store.
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (err) {
      setTrustStatus(`Failed: ${getErrorMessage(err, String(err))}`);
    } finally {
      setTrustingCert(false);
    }
  }, [pendingCert, expectedFingerprint]);

  const handleCancelTrust = useCallback(() => {
    setPendingCert(null);
    setExpectedFingerprint('');
    setFingerprintMismatch(false);
    setTrustStatus(null);
  }, []);

  // Proactive JWT refresh (only in enterprise mode when authenticated)
  useProactiveRefresh();

  // Idle timeout with warning dialog
  const { showWarning, secondsRemaining, resetTimer } = useIdleTimeout();

  // Connect auth store to controller client on mount (once only)
  useEffect(() => {
    if (isInitialized && isEnterprise && !hasConnectedClient.current) {
      hasConnectedClient.current = true;
      connectAuthStoreToClient();
    }
  }, [isInitialized, isEnterprise]);

  // Check existing auth on mount (Enterprise mode only, once only)
  useEffect(() => {
    if (!isInitialized) return;

    if (!isEnterprise) {
      setIsChecking(false);
      return;
    }

    if (hasCheckedAuth.current) return;

    retryConnection();
  }, [isInitialized, isEnterprise, retryConnection]);

  // Restore session state after re-authentication
  useEffect(() => {
    if (isEnterprise && isAuthenticated && !hasRestoredState.current) {
      hasRestoredState.current = true;

      const restoredState = restoreSessionState();
      if (restoredState) {
        logger.log('[AuthProvider] Dispatching session-restored event');
        // Dispatch custom event to App.tsx for tab recreation
        window.dispatchEvent(
          new CustomEvent('session-restored', { detail: restoredState })
        );
        // Clear state after successful restoration
        clearSessionState();
      }
    }
  }, [isEnterprise, isAuthenticated]);

  // Not initialized yet - show loading
  if (!isInitialized) {
    return (
      <div className="auth-loading">
        <div className="auth-loading-spinner" />
        <p>Loading...</p>
      </div>
    );
  }

  // Personal mode - no auth required
  if (!isEnterprise) {
    return <>{children}</>;
  }

  // Enterprise mode - checking auth state
  if (isChecking || isLoading) {
    return (
      <div className="auth-loading">
        <div className="auth-loading-spinner" />
        <p>Checking authentication...</p>
      </div>
    );
  }

  // Enterprise mode - connection error
  if (connectionError) {
    return (
      <div className="auth-loading">
        <div className="connection-error-container">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none" style={{ margin: '0 auto 16px' }}>
            <circle
              cx="32"
              cy="32"
              r="28"
              stroke="#d32f2f"
              strokeWidth="4"
              fill="none"
            />
            <path
              d="M32 16V32M32 44V46"
              stroke="#d32f2f"
              strokeWidth="4"
              strokeLinecap="round"
            />
          </svg>
          <h2 style={{ marginBottom: '8px', fontSize: '20px' }}>Cannot Connect</h2>
          <p style={{ marginBottom: '16px', color: '#888' }}>
            {connectionError}
          </p>
          {controllerUrl && (
            <p style={{ marginBottom: '16px', fontSize: '13px', color: '#666' }}>
              <strong>Controller URL:</strong> {controllerUrl}
            </p>
          )}
          <p style={{ marginBottom: '24px', fontSize: '13px', color: '#888' }}>
            {isTlsCertError
              ? 'The Controller uses a self-signed certificate. You can trust it to connect.'
              : 'Check Settings to verify your Controller URL and ensure the Controller is running and accessible.'}
          </p>
          {trustStatus && (
            <p style={{ marginBottom: '16px', fontSize: '12px', color: '#aaa' }}>
              {trustStatus}
            </p>
          )}
          {/* AUDIT FIX (AUTH-004): two-stage trust UI. Stage 1 fetches
              the cert and shows the fingerprint; stage 2 lets the user
              paste an expected fingerprint (out-of-band from the
              controller admin) so a LAN MITM that substituted a rogue CA
              would be caught before install. */}
          {pendingCert ? (
            <div style={{ marginBottom: '16px', textAlign: 'left' }}>
              <p style={{ marginBottom: '8px', fontSize: '13px', color: '#d1d5db' }}>
                <strong>Verify the controller's CA fingerprint.</strong> Compare it
                against the value the controller admin shared out-of-band (run{' '}
                <code>./controller-dev.sh fingerprint</code> on the controller, or
                check the admin UI's TLS settings page).
              </p>
              <div style={{
                fontFamily: 'ui-monospace, monospace',
                fontSize: '12px',
                background: '#111827',
                color: '#f3f4f6',
                padding: '8px 12px',
                borderRadius: 4,
                border: '1px solid #374151',
                marginBottom: 12,
                wordBreak: 'break-all',
              }}>
                {pendingCert.fingerprint}
              </div>
              <input
                type="text"
                placeholder="Paste the expected fingerprint here (recommended)…"
                value={expectedFingerprint}
                onChange={(e) => { setExpectedFingerprint(e.target.value); setFingerprintMismatch(false); }}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '8px',
                  fontFamily: 'ui-monospace, monospace', fontSize: '12px',
                  background: '#1f2937', color: '#f3f4f6',
                  border: fingerprintMismatch ? '1px solid #dc2626' : '1px solid #374151',
                  borderRadius: 4, marginBottom: 8,
                }}
              />
              {fingerprintMismatch && (
                <p style={{ color: '#fca5a5', fontSize: '12px', marginBottom: 8 }}>
                  Pasted fingerprint does NOT match. <strong>Do not install</strong> —
                  this could be a man-in-the-middle attack.
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button onClick={handleCancelTrust} disabled={trustingCert}
                  style={{ padding: '8px 14px', background: 'transparent', color: '#9ca3af',
                           border: '1px solid #4b5563', borderRadius: 4, cursor: 'pointer' }}>
                  Cancel
                </button>
                <button onClick={() => handleConfirmAndInstall('visual')} disabled={trustingCert}
                  style={{ padding: '8px 14px', background: '#374151', color: '#f3f4f6',
                           border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                  Install (visual check only)
                </button>
                <button onClick={() => handleConfirmAndInstall('verified')}
                  disabled={trustingCert || expectedFingerprint.trim().length === 0}
                  style={{ padding: '8px 14px', background: '#16a34a', color: '#fff',
                           border: 'none', borderRadius: 4, cursor: 'pointer',
                           opacity: trustingCert || expectedFingerprint.trim().length === 0 ? 0.6 : 1 }}>
                  {trustingCert ? 'Installing…' : 'Verify & Install'}
                </button>
              </div>
            </div>
          ) : (
            <div className="connection-error-actions">
              {isTlsCertError && (
                <button
                  className="trust-cert-button"
                  onClick={handleFetchCert}
                  disabled={trustingCert}
                >
                  {trustingCert ? 'Fetching…' : 'Trust Certificate…'}
                </button>
              )}
              <button
                className="retry-button"
                onClick={retryConnection}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Enterprise mode - not authenticated
  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  // Enterprise mode - authenticated
  return (
    <>
      <NetworkStatusBanner />
      {children}
      {showWarning && (
        <IdleWarningDialog
          secondsRemaining={secondsRemaining}
          onStaySignedIn={resetTimer}
        />
      )}
    </>
  );
}

export default AuthProvider;
