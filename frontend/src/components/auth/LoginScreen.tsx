import type { FormEvent } from 'react';
import { useState } from 'react';
import { PasswordInput } from '../PasswordInput';
import { useAuth } from '../../hooks/useAuth';
import { switchToStandalone } from '../../lib/switchMode';
import { confirmDialog } from '../ConfirmDialog';
import { getErrorMessage } from '../../api/errors';
import './LoginScreen.css';

/**
 * Enterprise login screen component.
 * Displays when user is not authenticated in Enterprise mode.
 */
export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login, isLoading, error, clearError } = useAuth();
  const [standaloneSwitching, setStandaloneSwitching] = useState(false);
  const [standaloneError, setStandaloneError] = useState<string | null>(null);

  // Map internal errors to user-friendly messages
  const displayError = (() => {
    if (!error) return null;
    if (error.startsWith('seat_limit_reached:'))
      return 'All license seats are in use. Please try again later or contact your administrator.';
    if (error === 'No refresh token available' || error === 'No token after refresh')
      return 'Invalid credentials. Please check your username and password.';
    return error;
  })();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    try {
      await login(email, password);
      // On success, AuthProvider will show main app
    } catch {
      // Error handled by store, displayed below
    }
  };

  // Escape hatch from the controller login: clears `controllerUrl` from
  // app-config.json and restarts the app into standalone mode. Mirrors
  // handleDeenroll in SettingsConnection but reachable without a working
  // controller — useful when the user mistyped the URL, the controller
  // is down, or they just want to fall back to local-only.
  const handleSwitchToStandalone = async () => {
    const ok = await confirmDialog({
      title: 'Switch to standalone mode?',
      body: 'The app will restart and connect to the local agent instead of the controller. You can switch back from Settings → Enterprise once standalone is up.',
      confirmLabel: 'Switch to standalone',
      destructive: true,
    });
    if (!ok) return;
    setStandaloneError(null);
    setStandaloneSwitching(true);
    try {
      // switchToStandalone clears controllerUrl and calls relaunch()
      // when running inside Tauri; the function returns before exit.
      // If we ever stay mounted it's because we're running in the dev
      // browser — the returned string is a manual-restart hint.
      const msg = await switchToStandalone();
      setStandaloneError(msg);
    } catch (err) {
      setStandaloneError(getErrorMessage(err, 'Failed to switch to standalone mode'));
    } finally {
      setStandaloneSwitching(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-container">
        <div className="login-header">
          <div className="login-logo">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M7 7h.01M7 12h.01M7 17h.01M12 7h5M12 12h5M12 17h5" />
            </svg>
          </div>
          <h1>NetStacks Enterprise</h1>
          <p className="login-subtitle">Sign in to your organization</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          {displayError && (
            <div className="login-error">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{displayError}</span>
            </div>
          )}
          {displayError?.includes('untrusted TLS certificate') && (
            <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px', textAlign: 'center' }}>
              Open <strong>Settings → Enterprise</strong> to trust the controller's certificate,
              or check the connection tab in the bottom panel.
            </p>
          )}

          <div className="form-field">
            <label htmlFor="email">Username</label>
            <input
              id="email"
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin"
              required
              autoComplete="username"
              autoFocus
            />
          </div>

          <div className="form-field">
            <label htmlFor="password">Password</label>
            <PasswordInput
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            className="login-button"
            disabled={isLoading || !email || !password}
          >
            {isLoading ? (
              <span className="login-loading">
                <span className="spinner" />
                Signing in...
              </span>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        <div className="login-footer">
          <p>Having trouble signing in?</p>
          <p className="login-help">Contact your IT administrator</p>
          {/* Escape hatch — most useful when the controller is unreachable,
              the URL is wrong, or the user just wants local-only mode.
              Confirmation lives in the click handler so a misclick on the
              link doesn't restart the app. */}
          <button
            type="button"
            className="login-link"
            onClick={handleSwitchToStandalone}
            disabled={standaloneSwitching || isLoading}
          >
            {standaloneSwitching ? 'Switching…' : 'Use standalone mode instead'}
          </button>
          {standaloneError && (
            <p className="login-link-error">{standaloneError}</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default LoginScreen;
