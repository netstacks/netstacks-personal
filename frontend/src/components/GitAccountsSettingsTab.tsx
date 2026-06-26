import { useState, useEffect, useCallback } from 'react'
import { getClient } from '../api/client'
import { showToast } from './Toast'
import { confirmDialog } from './ConfirmDialog'
import { PasswordInput } from './PasswordInput'

import { getErrorMessage } from '../api/errors'
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
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ connected: boolean; username?: string; error?: string } | null>(null)

  const fetchAccounts = useCallback(async () => {
    try {
      const { data } = await getClient().http.get('/workspace/git/accounts')
      setAccounts(data.accounts || [])
    } catch {
      setAccounts([])
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
    <div className="settings-tab-content" style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Git Accounts</h3>
        {!showForm && (
          <button
            style={{
              padding: '4px 12px',
              background: 'var(--color-accent)',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'var(--font-family)',
            }}
            onClick={() => { setForm(emptyForm); setTestResult(null); setShowForm(true) }}
          >
            + Add Account
          </button>
        )}
      </div>

      {showForm && (
        <div style={{
          background: 'var(--color-bg-secondary)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: 16,
          marginBottom: 16,
        }}>
          <h4 style={{ margin: '0 0 12px', fontSize: 13 }}>{form.id ? 'Edit Account' : 'Add Account'}</h4>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Name</label>
              <input
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  background: 'var(--color-bg-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 4,
                  color: 'var(--color-text-primary)',
                  fontSize: 13,
                  fontFamily: 'var(--font-family)',
                }}
                placeholder="e.g. Personal GitHub"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div>
              <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Provider</label>
              <select
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  background: 'var(--color-bg-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 4,
                  color: 'var(--color-text-primary)',
                  fontSize: 13,
                  fontFamily: 'var(--font-family)',
                }}
                value={form.provider}
                onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}
              >
                {PROVIDERS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            {NEEDS_HOST.has(form.provider) && (
              <div>
                <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Host URL</label>
                <input
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    background: 'var(--color-bg-primary)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 4,
                    color: 'var(--color-text-primary)',
                    fontSize: 13,
                    fontFamily: 'var(--font-family)',
                  }}
                  placeholder="https://ghe.corp.net"
                  value={form.host}
                  onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
                />
              </div>
            )}

            <div>
              <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>
                Personal Access Token
              </label>
              <PasswordInput
                style={{
                  padding: '6px 8px',
                  background: 'var(--color-bg-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 4,
                  color: 'var(--color-text-primary)',
                  fontSize: 13,
                  fontFamily: 'var(--font-family-mono)',
                }}
                placeholder={form.id ? '(unchanged)' : 'ghp_...'}
                value={form.credential}
                onChange={e => setForm(f => ({ ...f, credential: e.target.value }))}
              />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <input
                type="checkbox"
                checked={form.is_default}
                onChange={e => setForm(f => ({ ...f, is_default: e.target.checked }))}
              />
              Set as default account
            </label>

            {testResult && (
              <div style={{
                padding: '6px 10px',
                borderRadius: 4,
                fontSize: 12,
                background: testResult.connected ? 'rgba(46,160,67,0.1)' : 'rgba(248,81,73,0.1)',
                color: testResult.connected ? 'var(--color-success)' : 'var(--color-error)',
                border: `1px solid ${testResult.connected ? 'var(--color-success)' : 'var(--color-error)'}`,
              }}>
                {testResult.connected
                  ? `Connected as ${testResult.username}`
                  : `Connection failed: ${testResult.error}`}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                style={{
                  padding: '6px 12px',
                  background: 'none',
                  border: '1px solid var(--color-border)',
                  borderRadius: 4,
                  color: 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontFamily: 'var(--font-family)',
                }}
                onClick={handleTestConnection}
                disabled={testing || !form.credential}
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              <div style={{ flex: 1 }} />
              <button
                style={{
                  padding: '6px 12px',
                  background: 'none',
                  border: '1px solid var(--color-border)',
                  borderRadius: 4,
                  color: 'var(--color-text-primary)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontFamily: 'var(--font-family)',
                }}
                onClick={() => { setShowForm(false); setForm(emptyForm); setTestResult(null) }}
              >
                Cancel
              </button>
              <button
                style={{
                  padding: '6px 12px',
                  background: 'var(--color-accent)',
                  border: 'none',
                  borderRadius: 4,
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontFamily: 'var(--font-family)',
                }}
                onClick={handleSave}
                disabled={!form.name.trim()}
              >
                {form.id ? 'Update' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>Loading...</div>
      ) : accounts.length === 0 && !showForm ? (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: 12, textAlign: 'center', padding: 32 }}>
          No git accounts configured. Click "+ Add Account" to get started.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {accounts.map(account => (
            <div
              key={account.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 12px',
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: account.has_credential ? 'var(--color-success)' : 'var(--color-text-secondary)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {account.name}
                  {account.is_default && (
                    <span style={{ fontSize: 10, color: 'var(--color-accent)', marginLeft: 6 }}>DEFAULT</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  {providerLabel(account.provider)}
                  {account.host && ` — ${account.host}`}
                </div>
              </div>
              <button
                style={{
                  padding: '2px 8px',
                  background: 'none',
                  border: '1px solid var(--color-border)',
                  borderRadius: 4,
                  color: 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontFamily: 'var(--font-family)',
                }}
                onClick={() => handleEdit(account)}
              >
                Edit
              </button>
              <button
                style={{
                  padding: '2px 8px',
                  background: 'none',
                  border: '1px solid var(--color-error)',
                  borderRadius: 4,
                  color: 'var(--color-error)',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontFamily: 'var(--font-family)',
                }}
                onClick={() => handleDelete(account.id)}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
