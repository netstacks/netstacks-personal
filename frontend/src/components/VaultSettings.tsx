import { useState, useEffect, useCallback, useRef } from 'react'
import { getVaultStatus, setMasterPassword, unlockVault } from '../api/sessions'
import {
  lockVault,
  getBiometricStatus,
  enableBiometric,
  disableBiometric,
  type BiometricStatus,
  changeMasterPassword,
  wipeVault,
} from '../api/vault'
import { confirmDialog } from './ConfirmDialog'
import { useSubmitting } from '../hooks/useSubmitting'
import { PasswordInput } from './PasswordInput'

import DialogFooter from './DialogFooter'
import SettingsSection from './settings/SettingsSection'
export default function VaultSettings() {
  const changeFormRef = useRef<HTMLFormElement>(null)
  const wipeFormRef = useRef<HTMLFormElement>(null)
  const biometricFormRef = useRef<HTMLFormElement>(null)
  const [status, setStatus] = useState<{ unlocked: boolean; has_master_password: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Form states
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')

  // Change-password form (visible only when unlocked)
  const [changeMode, setChangeMode] = useState(false)
  const [changeOldPassword, setChangeOldPassword] = useState('')
  const [changeNewPassword, setChangeNewPassword] = useState('')
  const [changeConfirmPassword, setChangeConfirmPassword] = useState('')

  // Wipe-vault form (visible only when unlocked)
  const [wipeMode, setWipeMode] = useState(false)
  const [wipeConfirmPassword, setWipeConfirmPassword] = useState('')

  // Touch ID state
  const [biometric, setBiometric] = useState<BiometricStatus | null>(null)
  const [biometricBusy, setBiometricBusy] = useState(false)
  const [biometricEnableMode, setBiometricEnableMode] = useState(false)
  const [biometricPassword, setBiometricPassword] = useState('')

  // Fetch vault status on mount
  useEffect(() => {
    fetchStatus()
  }, [])

  const fetchStatus = async () => {
    try {
      const s = await getVaultStatus()
      setStatus(s)
      setError(null)
    } catch (err) {
      setError('Failed to fetch vault status')
    } finally {
      setLoading(false)
    }
  }

  // Single submitting flag covering set/unlock/lock and API-key save/delete.
  // The vault is small enough that multiple concurrent submits don't add
  // value — disabling the whole form during any one is fine.
  const { submitting, run } = useSubmitting()

  const handleSetMasterPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    await run(async () => {
      try {
        await setMasterPassword(newPassword)
        setSuccess('Master password set successfully')
        setNewPassword('')
        setConfirmPassword('')
        await fetchStatus()
      } catch (err) {
        setError('Failed to set master password')
      }
    })
  }

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (!unlockPassword) {
      setError('Please enter your password')
      return
    }

    await run(async () => {
      try {
        await unlockVault(unlockPassword)
        setSuccess('Vault unlocked successfully')
        setUnlockPassword('')
        await fetchStatus()
      } catch (err) {
        setError('Incorrect password')
      }
    })
  }

  const handleLockVault = async () => {
    setError(null)
    setSuccess(null)

    await run(async () => {
      try {
        await lockVault()
        setSuccess('Vault locked successfully')
        await fetchStatus()
      } catch (err) {
        setError('Failed to lock vault')
      }
    })
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (changeNewPassword.length < 8) {
      setError('New password must be at least 8 characters')
      return
    }
    if (changeNewPassword !== changeConfirmPassword) {
      setError('New passwords do not match')
      return
    }
    if (changeOldPassword === changeNewPassword) {
      setError('New password must differ from the old one')
      return
    }

    await run(async () => {
      try {
        await changeMasterPassword(changeOldPassword, changeNewPassword)
        setSuccess('Master password rotated. All stored credentials re-encrypted.')
        setChangeOldPassword('')
        setChangeNewPassword('')
        setChangeConfirmPassword('')
        setChangeMode(false)
      } catch (err: unknown) {
        const e = err as { response?: { data?: { error?: string } } }
        setError(e?.response?.data?.error || 'Failed to change master password')
      }
    })
  }

  const handleWipeVault = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (!wipeConfirmPassword) {
      setError('Enter your master password to confirm wipe')
      return
    }

    const ok = await confirmDialog({
      title: 'Wipe the vault?',
      body: (
        <>
          This <strong>permanently deletes</strong> every stored credential,
          API token, NetBox/LibreNMS token, secure-note body, and quick-action
          private key. The master password is also cleared so you can set a
          new one. Sessions referencing wiped credentials will fail to
          connect until re-provisioned.
        </>
      ),
      confirmLabel: 'Wipe everything',
      destructive: true,
    })
    if (!ok) return

    await run(async () => {
      try {
        await wipeVault(wipeConfirmPassword)
        setSuccess('Vault wiped. Set a new master password to continue.')
        setWipeConfirmPassword('')
        setWipeMode(false)
        await fetchStatus()
      } catch (err: unknown) {
        const e = err as { response?: { data?: { error?: string } } }
        setError(e?.response?.data?.error || 'Failed to wipe vault')
      }
    })
  }

  // Touch ID
  const fetchBiometric = useCallback(async () => {
    try {
      const s = await getBiometricStatus()
      setBiometric(s)
    } catch {
      setBiometric({ supported: false, enrolled: false, enabled: false })
    }
  }, [])

  useEffect(() => {
    if (status?.unlocked) fetchBiometric()
  }, [status?.unlocked, fetchBiometric])

  const handleEnableBiometric = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    if (!biometricPassword) {
      setError('Enter your master password to confirm enrollment')
      return
    }
    setBiometricBusy(true)
    try {
      await enableBiometric(biometricPassword)
      setSuccess('Touch ID is now enabled for vault unlock')
      setBiometricPassword('')
      setBiometricEnableMode(false)
      await fetchBiometric()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      setError(e?.response?.data?.error || 'Failed to enable Touch ID')
    } finally {
      setBiometricBusy(false)
    }
  }

  const handleDisableBiometric = async () => {
    setError(null)
    setSuccess(null)
    setBiometricBusy(true)
    try {
      await disableBiometric()
      setSuccess('Touch ID disabled — keychain entry removed')
      await fetchBiometric()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      setError(e?.response?.data?.error || 'Failed to disable Touch ID')
    } finally {
      setBiometricBusy(false)
    }
  }

  if (loading) {
    return <p className="form-hint">Loading vault status…</p>
  }

  return (
    <>
      <SettingsSection
        title="Credential Vault"
        description="The credential vault securely stores your SSH passwords and key passphrases using AES-256-GCM encryption."
        actions={
          <>
            <span className={`settings-badge settings-badge--${status?.unlocked ? 'success' : 'danger'}`}>
              {status?.unlocked ? 'Unlocked' : 'Locked'}
            </span>
            {status?.unlocked && (
              <button className="ns-btn ns-btn--small" onClick={handleLockVault} disabled={submitting}>
                {submitting ? 'Locking…' : 'Lock Vault'}
              </button>
            )}
          </>
        }
      >
        {error && <p className="settings-error">{error}</p>}
        {success && <p className="settings-success">{success}</p>}

        {/* No master password set yet */}
        {!status?.has_master_password && (
          <form className="settings-form" onSubmit={handleSetMasterPassword}>
            <p className="form-hint">
              Set a master password to enable the credential vault. This password will be used to encrypt your stored credentials.
            </p>
            <div className="form-group">
              <label htmlFor="new-password">Master Password</label>
              <PasswordInput
                id="new-password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Enter master password (min 8 characters)"
                autoComplete="new-password"
              />
            </div>
            <div className="form-group">
              <label htmlFor="confirm-password">Confirm Password</label>
              <PasswordInput
                id="confirm-password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Confirm master password"
                autoComplete="new-password"
              />
            </div>
            <div className="settings-form-actions">
              <button type="submit" className="ns-btn ns-btn--primary" disabled={submitting}>
                {submitting ? 'Setting…' : 'Set Master Password'}
              </button>
            </div>
          </form>
        )}

        {/* Has master password but vault is locked */}
        {status?.has_master_password && !status?.unlocked && (
          <form className="settings-form" onSubmit={handleUnlock}>
            <p className="form-hint">
              Enter your master password to unlock the vault and access your stored credentials.
            </p>
            <div className="form-group">
              <label htmlFor="unlock-password">Master Password</label>
              <PasswordInput
                id="unlock-password"
                value={unlockPassword}
                onChange={e => setUnlockPassword(e.target.value)}
                placeholder="Enter master password"
                autoComplete="current-password"
                autoFocus
              />
            </div>
            <div className="settings-form-actions">
              <button type="submit" className="ns-btn ns-btn--primary" disabled={submitting}>
                {submitting ? 'Unlocking…' : 'Unlock Vault'}
              </button>
            </div>
          </form>
        )}

        {status?.unlocked && (
          <p className="form-hint">
            Your credential vault is unlocked. Passwords can be stored and retrieved for SSH connections.
            The vault will lock automatically when the application restarts.
          </p>
        )}
      </SettingsSection>

      {status?.unlocked && (
        <>
          <SettingsSection
            title="Change Master Password"
            description="Rotate your master password. Every stored credential, API token, and secure-note body is re-encrypted under the new key in a single transaction."
            actions={!changeMode && (
              <button
                className="ns-btn ns-btn--small"
                onClick={() => { setChangeMode(true); setError(null); setSuccess(null) }}
                disabled={submitting}
              >
                Change Master Password
              </button>
            )}
          >
            {changeMode && (
              <form ref={changeFormRef} className="settings-form" onSubmit={handleChangePassword}>
                <div className="form-group">
                  <label htmlFor="change-old-password">Current Master Password</label>
                  <PasswordInput
                    id="change-old-password"
                    value={changeOldPassword}
                    onChange={e => setChangeOldPassword(e.target.value)}
                    autoComplete="current-password"
                    autoFocus
                    disabled={submitting}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="change-new-password">New Master Password</label>
                  <PasswordInput
                    id="change-new-password"
                    value={changeNewPassword}
                    onChange={e => setChangeNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    disabled={submitting}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="change-confirm-password">Confirm New Password</label>
                  <PasswordInput
                    id="change-confirm-password"
                    value={changeConfirmPassword}
                    onChange={e => setChangeConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    disabled={submitting}
                  />
                </div>
                <DialogFooter
                  primary={{ label: submitting ? 'Rotating…' : 'Change Password', onClick: () => changeFormRef.current?.requestSubmit(), disabled: submitting }}
                  onCancel={() => {
                    setChangeMode(false)
                    setChangeOldPassword('')
                    setChangeNewPassword('')
                    setChangeConfirmPassword('')
                    setError(null)
                  }}
                  cancelDisabled={submitting}
                  inline
                />
              </form>
            )}
          </SettingsSection>

          {/* Touch ID — macOS only */}
          {biometric?.supported && (
            <SettingsSection
              title="Touch ID Unlock"
              description={biometric.enabled && biometric.enrolled
                ? 'You can use Touch ID on the unlock screen.'
                : 'Use your fingerprint instead of typing the master password.'}
              actions={biometric.enabled && biometric.enrolled ? (
                <>
                  <span className="settings-badge settings-badge--success">Enabled</span>
                  <button className="ns-btn ns-btn--small" onClick={handleDisableBiometric} disabled={biometricBusy}>
                    {biometricBusy ? 'Removing…' : 'Disable Touch ID'}
                  </button>
                </>
              ) : !biometricEnableMode && (
                <button className="ns-btn ns-btn--small" onClick={() => setBiometricEnableMode(true)}>
                  Enable Touch ID
                </button>
              )}
            >
              {!(biometric.enabled && biometric.enrolled) && biometricEnableMode && (
                <form ref={biometricFormRef} onSubmit={handleEnableBiometric} className="settings-form">
                  <p className="form-hint form-hint-warning">
                    Anyone with a registered fingerprint on this Mac will be able to unlock NetStacks.
                    Your master password remains the recovery method.
                  </p>
                  <div className="form-group">
                    <label htmlFor="biometric-confirm-password">Confirm master password</label>
                    <PasswordInput
                      id="biometric-confirm-password"
                      value={biometricPassword}
                      onChange={(e) => setBiometricPassword(e.target.value)}
                      autoFocus
                      disabled={biometricBusy}
                      autoComplete="current-password"
                    />
                  </div>
                  <DialogFooter
                    primary={{ label: biometricBusy ? 'Enabling…' : 'Enable', onClick: () => biometricFormRef.current?.requestSubmit(), disabled: biometricBusy }}
                    onCancel={() => {
                      setBiometricEnableMode(false)
                      setBiometricPassword('')
                    }}
                    cancelDisabled={biometricBusy}
                    inline
                  />
                </form>
              )}
            </SettingsSection>
          )}

          <SettingsSection
            title="Wipe Vault"
            description="Permanently delete every credential, token, and secure note encrypted by this vault, and clear the master password so a fresh one can be set. Use this if you've forgotten your password and accept losing access to stored data."
            actions={!wipeMode && (
              <button
                className="ns-btn ns-btn--small ns-btn--danger"
                onClick={() => { setWipeMode(true); setError(null); setSuccess(null) }}
                disabled={submitting}
              >
                Wipe Vault…
              </button>
            )}
          >
            {wipeMode && (
              <form ref={wipeFormRef} className="settings-form" onSubmit={handleWipeVault}>
                <div className="form-group">
                  <label htmlFor="wipe-confirm-password">
                    Confirm with current master password
                  </label>
                  <PasswordInput
                    id="wipe-confirm-password"
                    value={wipeConfirmPassword}
                    onChange={e => setWipeConfirmPassword(e.target.value)}
                    autoComplete="current-password"
                    autoFocus
                    disabled={submitting}
                  />
                </div>
                <DialogFooter
                  primary={{ label: submitting ? 'Wiping…' : 'Wipe Vault', onClick: () => wipeFormRef.current?.requestSubmit(), disabled: submitting, danger: true }}
                  onCancel={() => {
                    setWipeMode(false)
                    setWipeConfirmPassword('')
                    setError(null)
                  }}
                  cancelDisabled={submitting}
                  inline
                />
              </form>
            )}
          </SettingsSection>
        </>
      )}
    </>
  )
}
