import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { getVaultStatus, setMasterPassword, unlockVault } from '../api/sessions';
import { getBiometricStatus, unlockVaultWithBiometric, type BiometricStatus } from '../api/vault';
import { useMode } from '../hooks/useMode';
import { PasswordInput } from './PasswordInput';
import './VaultUnlockGate.css';

import { getErrorMessage } from '../api/errors'
import { logger } from '../lib/logger'
import { switchToEnterprise } from '../lib/switchMode'
interface VaultUnlockGateProps {
  children: ReactNode;
}

type GateState = 'loading' | 'setup' | 'unlock' | 'unlocked';

/**
 * Gate component that requires vault to be unlocked before showing the app.
 * Similar to SecureCRT's master password prompt on startup.
 */
export default function VaultUnlockGate({ children }: VaultUnlockGateProps) {
  const { isEnterprise } = useMode();
  const [state, setState] = useState<GateState>('loading');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [biometric, setBiometric] = useState<BiometricStatus | null>(null);
  const [biometricLoading, setBiometricLoading] = useState(false);
  // Tracks whether we've auto-fired the Touch ID prompt this mount, so a
  // cancel doesn't loop us back into another prompt on the next render.
  const autoPromptedRef = useRef(false);

  // Which sign-in mode the user is looking at. The two views are
  // mutually exclusive at the same level of UI prominence — the
  // controller form fully replaces the vault form when chosen, rather
  // than being a disclosed footer block. Both directions are reachable
  // via the prominent "Sign in to a Controller instead" / "Back to
  // local vault" buttons at the bottom of each view.
  const [gateView, setGateView] = useState<'vault' | 'controller'>('vault');
  const [enterpriseUrl, setEnterpriseUrl] = useState('');
  const [enterpriseSwitching, setEnterpriseSwitching] = useState(false);
  const [enterpriseSwitchError, setEnterpriseSwitchError] = useState<string | null>(null);

  const checkVaultStatus = useCallback(async () => {
    try {
      logger.log('Checking vault status...');
      const status = await getVaultStatus();
      logger.log('Vault status:', status);
      if (status.unlocked) {
        setState('unlocked');
      } else if (!status.has_master_password) {
        setState('setup');
      } else {
        setState('unlock');
      }
    } catch (err) {
      console.error('Failed to check vault status:', err);
      // Show error and allow retry instead of assuming unlock
      setError('Cannot connect to backend. Please ensure the app is running correctly.');
      setState('unlock');
    }
  }, []);

  useEffect(() => {
    // Only check vault status in Personal mode
    if (!isEnterprise) {
      checkVaultStatus();
    }
  }, [checkVaultStatus, isEnterprise]);

  // Check biometric availability whenever the unlock screen is shown.
  useEffect(() => {
    if (state !== 'unlock') return;
    let cancelled = false;
    getBiometricStatus().then((status) => {
      if (!cancelled) setBiometric(status);
    });
    return () => {
      cancelled = true;
    };
  }, [state]);

  const handleBiometricUnlock = useCallback(async () => {
    setError(null);
    setBiometricLoading(true);
    try {
      await unlockVaultWithBiometric();
      setState('unlocked');
    } catch (err: unknown) {
      // Map known backend codes to friendly messages; otherwise show the raw message.
      const e = err as { response?: { data?: { code?: string; error?: string } } };
      const code = e?.response?.data?.code;
      const apiMsg = e?.response?.data?.error;
      if (code === 'BIOMETRIC_CANCELLED') {
        // User dismissed the prompt — no error message needed, just leave the
        // password field for fallback.
      } else if (code === 'BIOMETRIC_NOT_ENROLLED') {
        setError('Touch ID enrollment was removed. Please re-enable it after unlocking.');
        setBiometric((prev) => (prev ? { ...prev, enrolled: false, enabled: false } : prev));
      } else {
        setError(apiMsg || 'Touch ID unlock failed — please use your master password.');
      }
    } finally {
      setBiometricLoading(false);
    }
  }, []);

  // Auto-fire the Touch ID prompt as soon as the unlock screen has biometric
  // available. The ref guard ensures cancelling the prompt doesn't spawn
  // another one — the user falls through to the password field instead.
  useEffect(() => {
    if (state !== 'unlock') return;
    if (autoPromptedRef.current) return;
    if (!biometric?.supported || !biometric.enrolled || !biometric.enabled) return;
    autoPromptedRef.current = true;
    handleBiometricUnlock();
  }, [state, biometric, handleBiometricUnlock]);

  // In Enterprise mode, vault is managed by Controller - skip local vault gate
  if (isEnterprise) {
    return <>{children}</>;
  }

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Backend enforces a 12-character minimum (AUDIT FIX CRYPTO-009).
    if (password.length < 12) {
      setError('Password must be at least 12 characters');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      // Re-check vault status to prevent creating duplicate passwords
      const currentStatus = await getVaultStatus();
      if (currentStatus.has_master_password) {
        // Password already exists - switch to unlock mode
        setState('unlock');
        setError('A master password already exists. Please unlock instead.');
        setPassword('');
        setConfirmPassword('');
        setLoading(false);
        return;
      }

      await setMasterPassword(password);
      await unlockVault(password);
      setState('unlocked');
    } catch (err) {
      // Check if the error is because password already exists
      const errorMsg = getErrorMessage(err, 'Failed to set master password');
      if (errorMsg.includes('already')) {
        setState('unlock');
        setError('A master password already exists. Please unlock instead.');
        setPassword('');
        setConfirmPassword('');
      } else {
        setError(errorMsg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchToEnterprise = async (e: React.FormEvent) => {
    e.preventDefault();
    setEnterpriseSwitchError(null);
    setEnterpriseSwitching(true);
    try {
      // switchToEnterprise validates, writes app-config.json, and
      // (in the Tauri shell) calls relaunch(). On success the process
      // is exiting; if we ever return synchronously it's because we're
      // running in the dev browser — show a manual-restart hint.
      const msg = await switchToEnterprise(enterpriseUrl);
      setEnterpriseSwitchError(msg);
    } catch (err) {
      setEnterpriseSwitchError(getErrorMessage(err, 'Failed to switch to enterprise mode'));
    } finally {
      setEnterpriseSwitching(false);
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!password) {
      setError('Please enter your master password');
      return;
    }

    setLoading(true);
    try {
      await unlockVault(password);
      setState('unlocked');
    } catch (err) {
      // Re-check vault status - maybe no password is set
      try {
        const status = await getVaultStatus();
        if (!status.has_master_password) {
          setState('setup');
          setError(null);
          return;
        }
      } catch {
        // Ignore re-check errors
      }
      setError('Invalid password');
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  // Show loading state
  if (state === 'loading') {
    return (
      <div className="vault-gate">
        <div className="vault-gate-container">
          <div className="vault-gate-loading">
            <div className="vault-spinner" />
            <span>Loading...</span>
          </div>
        </div>
      </div>
    );
  }

  // Show main app when unlocked
  if (state === 'unlocked') {
    return <>{children}</>;
  }

  // Build the header subtitle from the active view so it reads naturally
  // in both modes — the rest of the chrome (logo, container, dark theme)
  // stays identical so switching views feels like a panel swap, not a
  // separate screen.
  const subtitle = gateView === 'controller'
    ? "Enter your organization's Controller URL"
    : state === 'setup'
      ? 'Create a master password to protect your credentials'
      : 'Enter your master password to unlock';

  return (
    <div className="vault-gate">
      <div className="vault-gate-container">
        <div className="vault-gate-header">
          <div className="vault-logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48">
              {gateView === 'controller' ? (
                <>
                  {/* Controller icon: stacked panels — visually distinct
                      from the lock icon so the user knows they've switched
                      modes at a glance. */}
                  <rect x="3" y="4" width="18" height="6" rx="1" />
                  <rect x="3" y="14" width="18" height="6" rx="1" />
                  <path d="M7 7h.01M7 17h.01" />
                </>
              ) : (
                <>
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  <circle cx="12" cy="16" r="1" />
                </>
              )}
            </svg>
          </div>
          <h1>NetStacks</h1>
          <p className="vault-subtitle">{subtitle}</p>
        </div>

        {gateView === 'vault' ? (
          <>
            {error && (
              <div className="vault-error">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {state === 'unlock' && biometric?.enabled && biometric.supported && biometric.enrolled && (
              <>
                <button
                  type="button"
                  className="vault-submit vault-biometric-btn"
                  onClick={handleBiometricUnlock}
                  disabled={biometricLoading || loading}
                >
                  {biometricLoading ? (
                    <>
                      <div className="vault-spinner small" />
                      <span>Waiting for Touch ID…</span>
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                        <path d="M12 11v6M9 14h6" />
                        <circle cx="12" cy="12" r="10" />
                      </svg>
                      <span>Unlock with Touch ID</span>
                    </>
                  )}
                </button>
                <div className="vault-divider"><span>or</span></div>
              </>
            )}

            <form onSubmit={state === 'setup' ? handleSetup : handleUnlock} className="vault-form">
              <div className="vault-field">
                <label htmlFor="vault-password">
                  {state === 'setup' ? 'Master Password' : 'Password'}
                </label>
                <PasswordInput
                  id="vault-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={state === 'setup' ? 'Create a strong password' : 'Enter your password'}
                  autoFocus
                  disabled={loading}
                  autoComplete={state === 'setup' ? 'new-password' : 'current-password'}
                />
              </div>

              {state === 'setup' && (
                <div className="vault-field">
                  <label htmlFor="vault-confirm">Confirm Password</label>
                  <PasswordInput
                    id="vault-confirm"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm your password"
                    disabled={loading}
                    autoComplete="new-password"
                  />
                </div>
              )}

              <button type="submit" className="vault-submit" disabled={loading}>
                {loading ? (
                  <>
                    <div className="vault-spinner small" />
                    <span>{state === 'setup' ? 'Setting up...' : 'Unlocking...'}</span>
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                      {state === 'setup' ? (
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      ) : (
                        <rect x="3" y="11" width="18" height="11" rx="2" />
                      )}
                    </svg>
                    <span>{state === 'setup' ? 'Create Vault' : 'Unlock'}</span>
                  </>
                )}
              </button>
            </form>

            {state === 'setup' && (
              <p className="vault-hint">
                This password encrypts all stored credentials. Choose something memorable but secure.
              </p>
            )}

            {state === 'unlock' && (
              <p className="vault-hint">
                Enter your master password to access stored credentials.
              </p>
            )}

            <div className="vault-mode-switch">
              <button
                type="button"
                className="vault-mode-switch-btn"
                onClick={() => {
                  setGateView('controller');
                  setError(null);
                  setEnterpriseSwitchError(null);
                }}
                disabled={loading || biometricLoading}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <rect x="3" y="4" width="18" height="6" rx="1" />
                  <rect x="3" y="14" width="18" height="6" rx="1" />
                  <path d="M7 7h.01M7 17h.01" />
                </svg>
                <span>Sign in to a Controller instead</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <form onSubmit={handleSwitchToEnterprise} className="vault-form">
              <div className="vault-field">
                <label htmlFor="vault-controller-url">Controller URL</label>
                <input
                  id="vault-controller-url"
                  type="url"
                  value={enterpriseUrl}
                  onChange={(e) => setEnterpriseUrl(e.target.value)}
                  placeholder="https://controller.example.com:3000"
                  autoComplete="url"
                  autoFocus
                  disabled={enterpriseSwitching}
                  className="vault-input"
                />
              </div>

              {enterpriseSwitchError && (
                <div className="vault-error">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span>{enterpriseSwitchError}</span>
                </div>
              )}

              <button
                type="submit"
                className="vault-submit"
                disabled={enterpriseSwitching || !enterpriseUrl.trim()}
              >
                {enterpriseSwitching ? (
                  <>
                    <div className="vault-spinner small" />
                    <span>Saving…</span>
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                    <span>Save &amp; restart</span>
                  </>
                )}
              </button>
            </form>

            <p className="vault-hint">
              Saves the URL and restarts the app. You&apos;ll be asked to trust the Controller&apos;s
              TLS certificate on the next launch.
            </p>

            <div className="vault-mode-switch">
              <button
                type="button"
                className="vault-mode-switch-btn"
                onClick={() => {
                  setGateView('vault');
                  setEnterpriseSwitchError(null);
                }}
                disabled={enterpriseSwitching}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M19 12H5M11 18l-6-6 6-6" />
                </svg>
                <span>Back to local vault</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
