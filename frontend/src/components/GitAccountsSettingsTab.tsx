import AITabInput from './AITabInput'
import { useState, useEffect, useCallback } from 'react'
import { getClient } from '../api/client'
import { showToast } from './Toast'
import { confirmDialog } from './ConfirmDialog'
import { PasswordInput } from './PasswordInput'
import './GitAccountsSettingsTab.css'
import SettingsSection from './settings/SettingsSection'
import SettingsItem from './settings/SettingsItem'

import { getErrorMessage } from '../api/errors'
import DialogFooter from './DialogFooter'
interface GitAccountView {
  id: string
  name: string
  provider: string
  host: string | null
  auth_method: string
  has_credential: boolean
  is_default: boolean
  created_at: string
  updated_at: string
}

interface FormState {
  id: string | null
  name: string
  provider: string
  host: string
  auth_method: string
  credential: string
  is_default: boolean
}

const PROVIDERS = [
  { value: 'github', label: 'GitHub' },
  { value: 'github-enterprise', label: 'GitHub Enterprise' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'gitlab-selfhosted', label: 'GitLab Self-Hosted' },
  { value: 'gitea', label: 'Gitea' },
  { value: 'bitbucket', label: 'Bitbucket' },
]

const NEEDS_HOST = new Set(['github-enterprise', 'gitlab-selfhosted', 'gitea'])

const emptyForm: FormState = {
  id: null,
  name: '',
  provider: 'github',
  host: '',
  auth_method: 'pat',
  credential: '',
  is_default: false,
}

export default function GitAccountsSettingsTab() {
  const [accounts, setAccounts] = useState<GitAccountView[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ connected: boolean; username?: string; error?: string } | null>(null)

  const fetchAccounts = useCallback(async () => {
    try {
      const { data } = await getClient().http.get('/workspace/git/accounts')
      setAccounts(data.accounts || [])
      setLoadError(null)
    } catch (err) {
      // Keep whatever we had rather than rendering the "no accounts"
      // empty state for what is really a fetch failure.
      const msg = getErrorMessage(err, 'Failed to load Git accounts')
      setLoadError(msg)
      showToast(msg, 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAccounts()
  }, [fetchAccounts])

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) {
      showToast('Name is required', 'error')
      return
    }
    try {
      if (form.id) {
        await getClient().http.post('/workspace/git/accounts/update', {
          id: form.id,
          name: form.name,
          provider: form.provider,
          host: NEEDS_HOST.has(form.provider) ? form.host : null,
          auth_method: form.auth_method,
          credential: form.credential || undefined,
          is_default: form.is_default,
        })
        showToast('Account updated', 'success')
      } else {
        await getClient().http.post('/workspace/git/accounts/create', {
          name: form.name,
          provider: form.provider,
          host: NEEDS_HOST.has(form.provider) ? form.host : null,
          auth_method: form.auth_method,
          credential: form.credential,
          is_default: form.is_default,
        })
        showToast('Account added', 'success')
      }
      setShowForm(false)
      setForm(emptyForm)
      fetchAccounts()
    } catch (err) {
      showToast(`Save failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [form, fetchAccounts])

  const handleDelete = useCallback(async (id: string) => {
    const ok = await confirmDialog({
      title: 'Delete git account?',
      body: 'Remove this git account from NetStacks. Repositories using it will fall back to your global git config.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await getClient().http.post('/workspace/git/accounts/delete', { id })
      showToast('Account deleted', 'success')
      fetchAccounts()
    } catch (err) {
      showToast(`Delete failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [fetchAccounts])

  const handleEdit = useCallback((account: GitAccountView) => {
    setForm({
      id: account.id,
      name: account.name,
      provider: account.provider,
      host: account.host || '',
      auth_method: account.auth_method,
      credential: '',
      is_default: account.is_default,
    })
    setTestResult(null)
    setShowForm(true)
  }, [])

  const handleTestConnection = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const { data } = await getClient().http.post('/workspace/git/accounts/test', {
        provider: form.provider,
        host: NEEDS_HOST.has(form.provider) ? form.host : null,
        credential: form.credential,
      })
      setTestResult(data)
    } catch (err) {
      setTestResult({ connected: false, error: getErrorMessage(err) })
    } finally {
      setTesting(false)
    }
  }, [form])

  const providerLabel = (value: string) => PROVIDERS.find(p => p.value === value)?.label || value

  return (
    <SettingsSection
      title="Git Accounts"
      description="Accounts workspaces use to clone and push. The default account is used unless a workspace picks another."
      help={{
        topic: 'git accounts',
        prompt: `Help me connect git accounts to NetStacks workspaces. I have ${accounts.length} account(s)${accounts.length ? ` (${accounts.map(a => `${a.name}: ${a.provider}`).join(', ')})` : ''}. Explain which providers are supported (GitHub, GitLab, Bitbucket, self-hosted), what token scopes a personal access token needs, how the default account is used for clone/push in a workspace, and how to test the connection.`,
      }}
      actions={!showForm && (
        <button
          type="button"
          className="ns-btn ns-btn--small"
          onClick={() => { setForm(emptyForm); setTestResult(null); setShowForm(true) }}
        >
          + Add account
        </button>
      )}
    >
      {showForm && (
        <div className="settings-form">
          <h4 className="settings-form-title">{form.id ? 'Edit Account' : 'Add Account'}</h4>

          <div className="form-group">
            <label htmlFor="git-account-name">Name</label>
            <AITabInput
              id="git-account-name"
              placeholder="e.g. Personal GitHub"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              aiField="git account name"
              aiPlaceholder="Short label for this git hosting account"
              aiContext={{ provider: form.provider, host: form.host }}
              onAIValue={(v) => setForm(f => ({ ...f, name: v }))}
            />
          </div>

          <div className="form-group">
            <label htmlFor="git-account-provider">Provider</label>
            <select
              id="git-account-provider"
              className="ns-select"
              value={form.provider}
              onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}
            >
              {PROVIDERS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {NEEDS_HOST.has(form.provider) && (
            <div className="form-group">
              <label htmlFor="git-account-host">Host URL</label>
              <input data-ai-fill="off"
                id="git-account-host"
                className="ns-input"
                placeholder="https://ghe.corp.net"
                value={form.host}
                onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="git-account-token">Personal Access Token</label>
            <PasswordInput
              id="git-account-token"
              className="git-accounts-token"
              placeholder={form.id ? '(unchanged)' : 'ghp_...'}
              value={form.credential}
              onChange={e => setForm(f => ({ ...f, credential: e.target.value }))}
            />
          </div>

          <label>
            <input
              type="checkbox"
              checked={form.is_default}
              onChange={e => setForm(f => ({ ...f, is_default: e.target.checked }))}
            />
            Set as default account
          </label>

          {testResult && (
            <p className={testResult.connected ? 'settings-success' : 'settings-error'}>
              {testResult.connected
                ? `Connected as ${testResult.username}`
                : `Connection failed: ${testResult.error}`}
            </p>
          )}

          <DialogFooter
            primary={{ label: form.id ? 'Update' : 'Add', onClick: handleSave, disabled: !form.name.trim() }}
            onCancel={() => { setShowForm(false); setForm(emptyForm); setTestResult(null) }}
            leading={
              <button
                type="button"
                className="ns-btn"
                onClick={handleTestConnection}
                disabled={testing || !form.credential}
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
            }
            inline
          />
        </div>
      )}

      {loading ? (
        <p className="form-hint">Loading…</p>
      ) : loadError && accounts.length === 0 ? (
        <p className="settings-error">
          Couldn't load Git accounts: {loadError}{' '}
          <button
            type="button"
            className="ns-btn ns-btn--small"
            onClick={() => { setLoading(true); void fetchAccounts() }}
          >
            Retry
          </button>
        </p>
      ) : accounts.length === 0 && !showForm ? (
        <p className="form-hint">No git accounts yet.</p>
      ) : accounts.length > 0 && (
        <div className="settings-group">
          {accounts.map(account => (
            <SettingsItem
              key={account.id}
              leading={<span className={`settings-status-dot${account.has_credential ? ' settings-status-dot--ok' : ''}`} role="img" aria-label={account.has_credential ? 'Token stored' : 'No token'} />}
              title={account.name}
              badges={account.is_default && <span className="settings-badge settings-badge--accent">default</span>}
              meta={<span>{providerLabel(account.provider)}{account.host && ` — ${account.host}`}</span>}
              actions={
                <>
                  <button type="button" className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => handleEdit(account)}>Edit</button>
                  <button type="button" className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" onClick={() => handleDelete(account.id)}>Delete</button>
                </>
              }
            />
          ))}
        </div>
      )}
    </SettingsSection>
  )
}
