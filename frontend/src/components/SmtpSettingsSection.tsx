import { useState, useEffect, useCallback } from 'react';
import {
  getSmtpConfig,
  saveSmtpConfig,
  deleteSmtpConfig,
  testSmtpConnection,
  type SaveSmtpConfigRequest,
  type TestSmtpRequest,
} from '../api/smtp';
import { confirmDialog } from './ConfirmDialog';
import { PasswordInput } from './PasswordInput';
import './SmtpSettingsSection.css';

// Icons
import { getErrorMessage } from '../api/errors'
const Icons = {
  mail: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  ),
  loader: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" className="smtp-spin">
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
      <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
      <line x1="2" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
      <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
    </svg>
  ),
};

interface SmtpSettingsSectionProps {
  onSaved?: () => void;
}

export default function SmtpSettingsSection({ onSaved }: SmtpSettingsSectionProps) {
  // Form state
  const [host, setHost] = useState('');
  const [port, setPort] = useState(587);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [useTls, setUseTls] = useState(true);
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');

  // UI state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [hasExistingConfig, setHasExistingConfig] = useState(false);
  const [hasExistingPassword, setHasExistingPassword] = useState(false);

  // Status messages
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Load existing configuration
  const loadConfig = useCallback(async () => {
    try {
      setLoading(true);
      const config = await getSmtpConfig();
      if (config) {
        setHost(config.host);
        setPort(config.port);
        setUsername(config.username);
        setUseTls(config.use_tls);
        setFromEmail(config.from_email);
        setFromName(config.from_name || '');
        setHasExistingConfig(true);
        setHasExistingPassword(config.has_password);
        setPassword(''); // Don't show existing password
      } else {
        setHasExistingConfig(false);
        setHasExistingPassword(false);
      }
    } catch (err) {
      console.error('Failed to load SMTP config:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Test connection
  const handleTest = async () => {
    // Validate required fields for test
    if (!host || !username || !fromEmail) {
      setTestResult({ success: false, message: 'Host, username, and from email are required' });
      return;
    }
    if (!password && !hasExistingPassword) {
      setTestResult({ success: false, message: 'Password is required for testing' });
      return;
    }

    setTesting(true);
    setTestResult(null);

    try {
      const request: TestSmtpRequest = {
        host,
        port,
        username,
        password: password || '', // Use empty string if using existing password (won't work)
        use_tls: useTls,
        from_email: fromEmail,
        from_name: fromName || undefined,
      };

      // If no new password provided, warn user
      if (!password && hasExistingPassword) {
        setTestResult({
          success: false,
          message: 'Enter your password to test the connection. Saved passwords cannot be retrieved.',
        });
        setTesting(false);
        return;
      }

      const result = await testSmtpConnection(request);
      setTestResult({
        success: result.success,
        message: result.success ? 'Connection successful!' : result.error || 'Connection failed',
      });
    } catch (err) {
      setTestResult({
        success: false,
        message: getErrorMessage(err, 'Test failed'),
      });
    } finally {
      setTesting(false);
    }
  };

  // Save configuration
  const handleSave = async () => {
    // Validate required fields
    if (!host || !username || !fromEmail) {
      setSaveError('Host, username, and from email are required');
      return;
    }
    if (!password && !hasExistingPassword) {
      setSaveError('Password is required');
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    setTestResult(null);

    try {
      const request: SaveSmtpConfigRequest = {
        host,
        port,
        username,
        password: password || undefined, // Only send if changed
        use_tls: useTls,
        from_email: fromEmail,
        from_name: fromName || null,
      };

      await saveSmtpConfig(request);
      setSaveSuccess(true);
      setHasExistingConfig(true);
      if (password) {
        setHasExistingPassword(true);
        setPassword(''); // Clear password field after save
      }
      onSaved?.();

      // Clear success message after 3 seconds
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setSaveError(getErrorMessage(err, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  // Delete configuration
  const handleDelete = async () => {
    const ok = await confirmDialog({
      title: 'Delete SMTP configuration?',
      body: 'Email notifications will stop until a new SMTP config is added.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;

    setDeleting(true);
    setSaveError(null);
    setTestResult(null);

    try {
      await deleteSmtpConfig();
      // Reset form
      setHost('');
      setPort(587);
      setUsername('');
      setPassword('');
      setUseTls(true);
      setFromEmail('');
      setFromName('');
      setHasExistingConfig(false);
      setHasExistingPassword(false);
      onSaved?.();
    } catch (err) {
      setSaveError(getErrorMessage(err, 'Failed to delete'));
    } finally {
      setDeleting(false);
    }
  };

  // Port presets
  const setPortPreset = (newPort: number, tls: boolean) => {
    setPort(newPort);
    setUseTls(tls);
  };

  if (loading) {
    return (
      <div className="smtp-settings-section">
        <div className="smtp-loading">Loading SMTP configuration...</div>
      </div>
    );
  }

  return (
    <div className="smtp-settings-section">
      {/* Section Header */}
      <div className="smtp-section-header">
        <div className="smtp-section-title">
          {Icons.mail}
          <h3>SMTP Email Settings</h3>
        </div>
        <div className="smtp-config-status">
          <span className={`status-dot ${hasExistingConfig ? 'configured' : 'not-configured'}`} />
          <span>{hasExistingConfig ? 'Configured' : 'Not configured'}</span>
        </div>
      </div>

      {/* Status Messages */}
      {testResult && (
        <div className={`smtp-status ${testResult.success ? 'success' : 'error'}`}>
          <span className="smtp-status-icon">
            {testResult.success ? Icons.check : Icons.x}
          </span>
          <span>{testResult.message}</span>
        </div>
      )}

      {saveError && (
        <div className="smtp-status error">
          <span className="smtp-status-icon">{Icons.x}</span>
          <span>{saveError}</span>
        </div>
      )}

      {saveSuccess && (
        <div className="smtp-status success">
          <span className="smtp-status-icon">{Icons.check}</span>
          <span>SMTP configuration saved successfully</span>
        </div>
      )}

      {/* Form */}
      <div className="smtp-settings-form">
        {/* Server Settings Row */}
        <div className="smtp-form-row">
          <div className="smtp-form-group">
            <label htmlFor="smtp-host">SMTP Host</label>
            <input
              id="smtp-host"
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.example.com"
            />
          </div>
          <div className="smtp-form-group" style={{ flex: '0 0 120px' }}>
            <label htmlFor="smtp-port">Port</label>
            <input
              id="smtp-port"
              type="number"
              value={port}
              onChange={(e) => setPort(parseInt(e.target.value) || 587)}
              min={1}
              max={65535}
            />
            <div className="smtp-port-presets">
              <span className="smtp-port-preset" onClick={() => setPortPreset(587, true)}>587</span>
              <span className="smtp-port-preset" onClick={() => setPortPreset(465, true)}>465</span>
              <span className="smtp-port-preset" onClick={() => setPortPreset(25, false)}>25</span>
            </div>
          </div>
        </div>

        {/* Auth Settings Row */}
        <div className="smtp-form-row">
          <div className="smtp-form-group">
            <label htmlFor="smtp-username">Username</label>
            <input
              id="smtp-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="user@example.com"
            />
          </div>
          <div className="smtp-form-group">
            <label htmlFor="smtp-password">Password</label>
            <PasswordInput
              id="smtp-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasExistingPassword ? '(unchanged)' : 'Enter password'}
            />
            {hasExistingPassword && !password && (
              <span className="smtp-password-hint">Leave blank to keep existing password</span>
            )}
          </div>
        </div>

        {/* From Settings Row */}
        <div className="smtp-form-row">
          <div className="smtp-form-group">
            <label htmlFor="smtp-from-email">From Email</label>
            <input
              id="smtp-from-email"
              type="email"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder="noreply@example.com"
            />
          </div>
          <div className="smtp-form-group">
            <label htmlFor="smtp-from-name">From Name (optional)</label>
            <input
              id="smtp-from-name"
              type="text"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="NetStacks"
            />
          </div>
        </div>

        {/* TLS Checkbox */}
        <div className="smtp-checkbox-group">
          <input
            id="smtp-use-tls"
            type="checkbox"
            checked={useTls}
            onChange={(e) => setUseTls(e.target.checked)}
          />
          <label htmlFor="smtp-use-tls">Use TLS (recommended)</label>
        </div>

        {/* Actions */}
        <div className="smtp-form-actions">
          <button
            className="smtp-btn smtp-btn-secondary"
            onClick={handleTest}
            disabled={testing || saving || deleting}
          >
            {testing ? Icons.loader : Icons.check}
            <span>{testing ? 'Testing...' : 'Test Connection'}</span>
          </button>
          <button
            className="smtp-btn smtp-btn-primary"
            onClick={handleSave}
            disabled={testing || saving || deleting}
          >
            {saving ? Icons.loader : Icons.check}
            <span>{saving ? 'Saving...' : 'Save'}</span>
          </button>
          {hasExistingConfig && (
            <button
              className="smtp-btn smtp-btn-danger"
              onClick={handleDelete}
              disabled={testing || saving || deleting}
            >
              {deleting ? Icons.loader : Icons.x}
              <span>{deleting ? 'Deleting...' : 'Delete'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Info */}
      <div className="smtp-status info">
        <span className="smtp-status-icon">{Icons.info}</span>
        <span>
          SMTP settings are used to send email notifications and reports.
          Common providers: Gmail (smtp.gmail.com:587), Office 365 (smtp.office365.com:587),
          SendGrid (smtp.sendgrid.net:587)
        </span>
      </div>
    </div>
  );
}
