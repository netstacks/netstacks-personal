import AITabInput from './AITabInput'
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
import SettingsSection from './settings/SettingsSection';

import { getErrorMessage } from '../api/errors'

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

  const busy = testing || saving || deleting;

  return (
    <SettingsSection
      title="Email Notifications"
      description="SMTP server used to send email notifications and reports. Common providers: Gmail (smtp.gmail.com:587), Office 365 (smtp.office365.com:587), SendGrid (smtp.sendgrid.net:587)."
      actions={
        <span className={hasExistingConfig ? 'settings-badge settings-badge--success' : 'settings-badge'}>
          {hasExistingConfig ? 'Configured' : 'Not configured'}
        </span>
      }
    >
      {testResult && <p className={testResult.success ? 'settings-success' : 'settings-error'}>{testResult.message}</p>}
      {saveError && <p className="settings-error">{saveError}</p>}
      {saveSuccess && <p className="settings-success">SMTP configuration saved.</p>}

      <div className="settings-form">
        <div className="settings-form-row">
          <div className="form-group">
            <label htmlFor="smtp-host">SMTP Host</label>
            <input data-ai-fill="off" className="ns-input"
              id="smtp-host"
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.example.com"
            />
          </div>
          <div className="form-group smtp-port">
            <label htmlFor="smtp-port">Port</label>
            <input className="ns-input"
              id="smtp-port"
              type="number"
              value={port}
              onChange={(e) => setPort(parseInt(e.target.value) || 587)}
              min={1}
              max={65535}
            />
            <div className="smtp-port-presets">
              <button type="button" className="ns-btn ns-btn--ghost ns-btn--small" onClick={() => setPortPreset(587, true)}>587</button>
              <button type="button" className="ns-btn ns-btn--ghost ns-btn--small" onClick={() => setPortPreset(465, true)}>465</button>
              <button type="button" className="ns-btn ns-btn--ghost ns-btn--small" onClick={() => setPortPreset(25, false)}>25</button>
            </div>
          </div>
        </div>

        <div className="settings-form-row">
          <div className="form-group">
            <label htmlFor="smtp-username">Username</label>
            <input data-ai-fill="off" className="ns-input"
              id="smtp-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="user@example.com"
            />
          </div>
          <div className="form-group">
            <label htmlFor="smtp-password">Password</label>
            <PasswordInput
              id="smtp-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasExistingPassword ? '(unchanged)' : 'Enter password'}
            />
            {hasExistingPassword && !password && (
              <p className="form-hint">Leave blank to keep the existing password</p>
            )}
          </div>
        </div>

        <div className="settings-form-row">
          <div className="form-group">
            <label htmlFor="smtp-from-email">From Email</label>
            <input className="ns-input"
              id="smtp-from-email"
              type="email"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder="noreply@example.com"
            />
          </div>
          <div className="form-group">
            <label htmlFor="smtp-from-name">From Name (optional)</label>
            <AITabInput
              id="smtp-from-name"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="NetStacks"
              aiField="email sender display name"
              aiPlaceholder="Display name shown as the sender of NetStacks notification emails"
              onAIValue={setFromName}
            />
          </div>
        </div>

        <label>
          <input
            type="checkbox"
            checked={useTls}
            onChange={(e) => setUseTls(e.target.checked)}
          />
          Use TLS (recommended)
        </label>

        <div className="settings-form-actions">
          {hasExistingConfig && (
            <button className="ns-btn ns-btn--ghost ns-btn--danger" onClick={handleDelete} disabled={busy}>
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          )}
          <button className="ns-btn" onClick={handleTest} disabled={busy}>
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          <button className="ns-btn ns-btn--primary" onClick={handleSave} disabled={busy}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </SettingsSection>
  );
}
