import { useState } from 'react'
import {
  createApiResource,
  updateApiResource,
  testApiResourceInline,
  testAuthFlowStep,
  testAuthFlowStepInline,
  type AuthStepTestResult,
} from '../api/quickActions'
import type {
  ApiResource,
  CreateApiResourceRequest,
  ApiResourceAuthType,
  AuthFlowStep,
  QuickActionResult,
} from '../types/quickAction'
import { PasswordInput } from './PasswordInput'
import AskAiHelp from './AskAiHelp'
import AITabInput from './AITabInput'
import './ApiResourceDialog.css'

// Icons
import { getErrorMessage } from '../api/errors'
const Icons = {
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
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
  warning: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
}

export const AUTH_TYPE_LABELS: Record<ApiResourceAuthType, string> = {
  none: 'No Auth',
  bearer_token: 'Bearer Token',
  basic: 'Basic Auth',
  api_key_header: 'API Key Header',
  custom_header: 'Custom Header',
  multi_step: 'Multi-Step Auth',
}

export interface ApiResourceDialogProps {
  resource: ApiResource | null
  mode?: 'create' | 'edit'
  onClose: () => void
  onSave?: () => void
  onSaved?: (resource: ApiResource) => void
}

// === HeadersTable sub-component for K=V editing ===

interface HeadersTableProps {
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}

function HeadersTable({ value, onChange }: HeadersTableProps) {
  // Use a local stable row list so we can have multiple draft rows with
  // empty header names without them collapsing into a single map entry.
  const [rows, setRows] = useState<Array<{ id: string; k: string; v: string }>>(
    () => Object.entries(value).map(([k, v]) => ({ id: crypto.randomUUID(), k, v }))
  )

  const commit = (next: Array<{ id: string; k: string; v: string }>) => {
    setRows(next)
    const map: Record<string, string> = {}
    for (const r of next) {
      if (r.k) map[r.k] = r.v
    }
    onChange(map)
  }

  return (
    <div className="headers-table">
      {rows.map((row, i) => (
        <div key={row.id} className="headers-row">
          <input
            type="text"
            placeholder="Header"
            value={row.k}
            onChange={(e) => {
              const next = rows.slice()
              next[i] = { ...row, k: e.target.value }
              commit(next)
            }}
          />
          <input
            type="text"
            placeholder="Value"
            value={row.v}
            onChange={(e) => {
              const next = rows.slice()
              next[i] = { ...row, v: e.target.value }
              commit(next)
            }}
          />
          <button
            type="button"
            className="btn-icon-small"
            onClick={() => commit(rows.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-small"
        onClick={() =>
          commit([...rows, { id: crypto.randomUUID(), k: '', v: '' }])
        }
      >
        {Icons.plus} Header
      </button>
    </div>
  )
}

export default function ApiResourceDialog({
  resource,
  mode = resource ? 'edit' : 'create',
  onClose,
  onSave,
  onSaved,
}: ApiResourceDialogProps) {
  const isEdit = mode === 'edit' && resource !== null
  const [name, setName] = useState(resource?.name || '')
  const [baseUrl, setBaseUrl] = useState(resource?.base_url || '')
  const [testPath, setTestPath] = useState(resource?.test_path || '')
  const [authType, setAuthType] = useState<ApiResourceAuthType>(resource?.auth_type || 'none')
  const [authToken, setAuthToken] = useState('')
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authHeaderName, setAuthHeaderName] = useState(resource?.auth_header_name || '')
  const [authHeaderPrefix] = useState(resource?.auth_header_prefix || '')
  const [authFlow, setAuthFlow] = useState<AuthFlowStep[]>(resource?.auth_flow || [])
  const [stepRids, setStepRids] = useState<string[]>(
    () => (resource?.auth_flow || []).map(() => crypto.randomUUID()),
  )
  const [defaultHeaders, setDefaultHeaders] = useState<Record<string, string>>(
    resource?.default_headers || {}
  )
  const [customHeaders, setCustomHeaders] = useState<Record<string, string>>(
    () => Object.fromEntries((resource?.custom_headers || []).map(h => [h.name, h.value]))
  )
  const [verifySsl, setVerifySsl] = useState(resource?.verify_ssl ?? true)
  const [timeoutSecs, setTimeoutSecs] = useState(resource?.timeout_secs ?? 30)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<QuickActionResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [stepResults, setStepResults] = useState<Record<number, AuthStepTestResult>>({})
  const [stepTesting, setStepTesting] = useState<number | null>(null)

  const handleSave = async () => {
    if (!name.trim() || !baseUrl.trim()) {
      setError('Name and Base URL are required')
      return
    }

    setSaving(true)
    setError(null)

    try {
      let createdResource: ApiResource | undefined
      const payload: CreateApiResourceRequest = {
        name: name.trim(),
        base_url: baseUrl.trim(),
        auth_type: authType,
        default_headers: defaultHeaders,
        custom_headers: Object.entries(customHeaders).map(([name, value]) => ({ name, value })),
        verify_ssl: verifySsl,
        timeout_secs: timeoutSecs,
        test_path: testPath.trim() || null,
      }
      if (authToken) payload.auth_token = authToken
      if (authUsername) payload.auth_username = authUsername
      if (authPassword) payload.auth_password = authPassword
      if (authHeaderName) payload.auth_header_name = authHeaderName
      if (authHeaderPrefix) payload.auth_header_prefix = authHeaderPrefix
      if (authType === 'multi_step' && authFlow.length > 0) payload.auth_flow = authFlow
      if (isEdit) {
        await updateApiResource(resource!.id, payload)
      } else {
        createdResource = await createApiResource(payload)
      }
      onSave?.()
      if (createdResource) {
        onSaved?.(createdResource)
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save'))
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (!name.trim() || !baseUrl.trim()) {
      setError('Name and Base URL are required to test')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      // Always run against current form state — no save required.
      // Use the inline endpoint with the in-progress configuration so
      // users can iterate on test_path / auth / headers without a
      // save-close-reopen cycle.
      const inlineResource: ApiResource = {
        id: resource?.id ?? 'inline-test',
        name: name.trim(),
        base_url: baseUrl.trim(),
        auth_type: authType,
        auth_header_name: authHeaderName || null,
        auth_header_prefix: authHeaderPrefix || null,
        auth_flow: authType === 'multi_step' ? authFlow : null,
        default_headers: defaultHeaders,
        custom_headers: Object.entries(customHeaders).map(([n, v]) => ({ name: n, value: v })),
        verify_ssl: verifySsl,
        timeout_secs: timeoutSecs,
        has_credentials: !!(authToken || authUsername || authPassword) || (resource?.has_credentials ?? false),
        test_path: testPath.trim() || null,
        created_at: resource?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      const inlineCreds =
        authToken || authUsername || authPassword
          ? {
              token: authToken || undefined,
              username: authUsername || undefined,
              password: authPassword || undefined,
            }
          : undefined
      const result = await testApiResourceInline(inlineResource, inlineCreds)
      setTestResult(result)
    } catch (err) {
      const e = err as { message?: string }
      setTestResult({
        success: false,
        status_code: 0,
        duration_ms: 0,
        error: e?.message || 'Test failed',
      })
    } finally {
      setTesting(false)
    }
  }

  const addAuthFlowStep = () => {
    setAuthFlow([...authFlow, { method: 'POST', path: '', body: '', extract_path: '', store_as: '' }])
    setStepRids((prev) => [...prev, crypto.randomUUID()])
  }

  const updateAuthFlowStep = (index: number, field: keyof AuthFlowStep, value: string) => {
    const updated = [...authFlow]
    updated[index] = { ...updated[index], [field]: value }
    setAuthFlow(updated)
  }

  const updateAuthFlowStepPartial = (index: number, updates: Partial<AuthFlowStep>) => {
    const updated = [...authFlow]
    updated[index] = { ...updated[index], ...updates }
    setAuthFlow(updated)
  }

  const toggleStepBasicAuth = (index: number, checked: boolean) => {
    const updated = [...authFlow]
    updated[index] = { ...updated[index], use_basic_auth: checked }
    setAuthFlow(updated)
  }

  const removeAuthFlowStep = (index: number) => {
    setAuthFlow(authFlow.filter((_, i) => i !== index))
    setStepRids((prev) => prev.filter((_, i) => i !== index))
    setStepResults((prev) => {
      const next = { ...prev }
      delete next[index]
      return next
    })
  }

  const handleTestStep = async (index: number) => {
    setStepTesting(index)
    try {
      let result: AuthStepTestResult
      if (resource?.id) {
        // Saved resource: hit the per-id endpoint (uses stored creds + config)
        result = await testAuthFlowStep(resource.id, index)
      } else {
        // Unsaved / in-progress edit: send the current form state inline so
        // the user can iterate on a step without first saving the resource.
        const credsPayload =
          authUsername || authPassword || authToken
            ? {
                username: authUsername || undefined,
                password: authPassword || undefined,
                token: authToken || undefined,
              }
            : undefined
        result = await testAuthFlowStepInline(
          {
            name: name || 'inline-test',
            base_url: baseUrl,
            auth_type: authType,
            auth_header_name: authHeaderName || null,
            auth_header_prefix: authHeaderPrefix || null,
            auth_flow: authFlow,
            default_headers: defaultHeaders,
            custom_headers: Object.entries(customHeaders).map(([n, v]) => ({ name: n, value: v })),
            verify_ssl: verifySsl,
            timeout_secs: timeoutSecs,
          },
          index,
          credsPayload,
        )
      }
      setStepResults((prev) => ({ ...prev, [index]: result }))
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } }; message?: string }
      setStepResults((prev) => ({
        ...prev,
        [index]: {
          success: false,
          status_code: 0,
          url: '',
          response_preview: null,
          extracted_value: null,
          store_as: authFlow[index]?.store_as || '',
          error: e?.response?.data?.error || e?.message || 'Step test failed',
          duration_ms: 0,
        },
      }))
    } finally {
      setStepTesting(null)
    }
  }

  return (
    <div className="api-resource-dialog-overlay">
      <div className="api-resource-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="api-resource-dialog-header">
          <h2>{isEdit ? 'Edit API Resource' : 'Add API Resource'}</h2>
          <AskAiHelp prompt="Help me fill out this API Resource form. Explain Base URL, Test Path, and which Authentication type to pick (none / bearer token / basic / api-key header / custom header / multi-step), and how to set it up for the external API I'm integrating." />
          <button className="api-resource-dialog-close" onClick={onClose} title="Close">{Icons.x}</button>
        </div>

        <div className="api-resource-dialog-content">
          {error && <div className="api-resource-dialog-error">{error}</div>}

          <div className="form-section">
            <h3>Basic Info</h3>
            <div className="form-group">
              <label>Name</label>
              <AITabInput
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onAIValue={(v) => setName(v)}
                aiField="api_resource_name"
                aiPlaceholder="Friendly name for this API resource"
                aiContext={{ baseUrl }}
                placeholder="e.g., SolarWinds Production"
              />
            </div>

            <div className="form-group">
              <label>Base URL</label>
              <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" />
            </div>

            <div className="form-group">
              <label>Test Path (optional)</label>
              <input type="text" value={testPath} onChange={(e) => setTestPath(e.target.value)} placeholder="/api/v1/swagger.json" />
              <small className="form-hint">Path the Test Connection button hits. Defaults to / if blank.</small>
            </div>
          </div>

          <div className="form-section">
            <h3>Authentication</h3>
            <div className="form-group">
              <label>Type</label>
              <select value={authType} onChange={(e) => setAuthType(e.target.value as ApiResourceAuthType)}>
                {Object.entries(AUTH_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            {authType === 'bearer_token' && (
              <div className="form-group">
                <label>Bearer Token</label>
                <PasswordInput value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder={isEdit ? '(unchanged if blank)' : 'Token'} />
              </div>
            )}

            {authType === 'basic' && (
              <>
                <div className="form-group">
                  <label>Username</label>
                  <input type="text" value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} placeholder={isEdit ? '(unchanged if blank)' : ''} />
                </div>
                <div className="form-group">
                  <label>Password</label>
                  <PasswordInput value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} placeholder={isEdit ? '(unchanged if blank)' : ''} />
                </div>
              </>
            )}

            {authType === 'api_key_header' && (
              <>
                <div className="form-group">
                  <label>Header Name</label>
                  <input type="text" value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} placeholder="X-API-Key" />
                </div>
                <div className="form-group">
                  <label>API Key</label>
                  <PasswordInput value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder={isEdit ? '(unchanged if blank)' : 'Key value'} />
                </div>
              </>
            )}

            {authType === 'custom_header' && (
              <div className="form-group">
                <label>Credential / Token</label>
                <PasswordInput value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder={isEdit ? '(unchanged if blank)' : 'Token value'} />
                <span className="form-hint">Available as <code>{`{{token}}`}</code> in Post-Auth Headers below.</span>
              </div>
            )}
          </div>

          {authType === 'multi_step' && (
            <div className="form-section auth-flow-section">
              <div className="auth-flow-header">
                <label>Authentication Flow</label>
                <button className="btn-small" onClick={addAuthFlowStep}>{Icons.plus} Add Step</button>
              </div>
              <div className="form-group">
                <label>Username</label>
                <input type="text" value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} placeholder={isEdit ? '(unchanged if blank)' : 'For {{username}} variable'} />
              </div>
              <div className="form-group">
                <label>Password</label>
                <PasswordInput value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} placeholder={isEdit ? '(unchanged)' : 'For {{password}} variable'} />
              </div>
              {authFlow.map((step, index) => (
                <div key={stepRids[index] ?? index} className="auth-flow-step">
                  <div className="auth-flow-step-header">
                    <span>Step {index + 1}</span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        className="btn-small"
                        onClick={() => handleTestStep(index)}
                        disabled={stepTesting === index}
                        title={
                          resource?.id
                            ? `Run step ${index + 1} against the saved resource`
                            : `Run step ${index + 1} against the in-progress configuration`
                        }
                      >
                        {stepTesting === index ? 'Testing…' : '▶ Test'}
                      </button>
                      <button className="btn-icon-small" onClick={() => removeAuthFlowStep(index)}>{Icons.trash}</button>
                    </div>
                  </div>
                  <div className="auth-flow-step-fields">
                    <select value={step.method} onChange={(e) => updateAuthFlowStep(index, 'method', e.target.value)}>
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                    </select>
                    <input type="text" value={step.path} onChange={(e) => updateAuthFlowStep(index, 'path', e.target.value)} placeholder="/api/v1/login" />
                  </div>
                  <div className="form-group">
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={!!step.use_basic_auth}
                        onChange={(e) => toggleStepBasicAuth(index, e.target.checked)}
                      />
                      Send HTTP Basic Auth using the resource's username/password
                    </label>
                  </div>
                  <div className="form-group">
                    <label>Headers (optional)</label>
                    <HeadersTable
                      value={step.headers ?? {}}
                      onChange={(next) => updateAuthFlowStepPartial(index, { headers: next })}
                    />
                  </div>
                  <div className="form-group">
                    <label>Body Template (optional)</label>
                    <textarea value={step.body || ''} onChange={(e) => updateAuthFlowStep(index, 'body', e.target.value)} placeholder='{"username":"{{username}}","password":"{{password}}"}' rows={2} />
                  </div>
                  <div className="auth-flow-step-fields">
                    <input type="text" value={step.extract_path} onChange={(e) => updateAuthFlowStep(index, 'extract_path', e.target.value)} placeholder="Extract path (e.g., api_key)" />
                    <input type="text" value={step.store_as} onChange={(e) => updateAuthFlowStep(index, 'store_as', e.target.value)} placeholder="Store as (e.g., api_key)" />
                  </div>

                  {stepResults[index] && (
                    <div className={`step-test-result ${stepResults[index].success ? 'ok' : 'err'}`}>
                      <div className="step-test-result-row">
                        <strong>{stepResults[index].success ? '✓ Success' : '✗ Failed'}</strong>
                        <span className="step-test-meta">
                          HTTP {stepResults[index].status_code} · {stepResults[index].duration_ms}ms
                        </span>
                      </div>
                      {stepResults[index].url && (
                        <div className="step-test-meta-row">
                          <span className="step-test-label">URL</span>
                          <code>{stepResults[index].url}</code>
                        </div>
                      )}
                      {stepResults[index].extracted_value && (
                        <div className="step-test-meta-row">
                          <span className="step-test-label">
                            Captured <code>{`{{${stepResults[index].store_as}}}`}</code>
                          </span>
                          <code className="step-test-value">{stepResults[index].extracted_value}</code>
                        </div>
                      )}
                      {stepResults[index].error && (
                        <div className="step-test-error">{stepResults[index].error}</div>
                      )}
                      {stepResults[index].response_preview && (
                        <details className="step-test-body">
                          <summary>Response body (first 1000 chars)</summary>
                          <pre>{stepResults[index].response_preview}</pre>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="form-section">
            <h3>Post-Auth Headers</h3>
            <HeadersTable value={customHeaders} onChange={setCustomHeaders} />
            <span className="form-hint">
              Headers applied to every request, after any built-in auth.
              Templates: <code>{`{{token}}`}</code> for the vault credential,
              plus any variables extracted by the multi-step auth flow above (e.g.{' '}
              <code>{`{{api_key}}`}</code>).
            </span>
          </div>

          <div className="form-section">
            <h3>Default Headers</h3>
            <HeadersTable value={defaultHeaders} onChange={setDefaultHeaders} />
          </div>

          <div className="form-section">
            <h3>Advanced</h3>
            <div className="form-row">
              <label className="checkbox-label">
                <input type="checkbox" checked={verifySsl} onChange={(e) => setVerifySsl(e.target.checked)} />
                Verify SSL
              </label>
              <div className="form-group inline">
                <label>Timeout (sec)</label>
                <input type="number" value={timeoutSecs} onChange={(e) => setTimeoutSecs(parseInt(e.target.value) || 30)} min={1} max={300} style={{ width: 70 }} />
              </div>
            </div>
          </div>

          {testResult && (() => {
            let resultClass: string;
            let icon: React.ReactNode;
            let message: string;
            if (!testResult.success) {
              resultClass = 'failure';
              icon = Icons.x;
              message = `Failed: ${testResult.error}`;
            } else if (testResult.warning) {
              resultClass = 'warning';
              icon = Icons.warning;
              message = testResult.warning;
            } else {
              resultClass = 'success';
              icon = Icons.check;
              message = `Connected (${testResult.duration_ms}ms)`;
            }
            return (
            <div className={`test-result ${resultClass}`}>
              <div className="test-result-row">
                {icon}
                <span>{message}</span>
              </div>
              {testResult.sent_url && (
                <div className="test-result-meta">
                  <span className="test-result-label">URL</span>
                  <code>{testResult.sent_url}</code>
                </div>
              )}
              {testResult.sent_headers && testResult.sent_headers.length > 0 && (
                <div className="test-result-meta">
                  <span className="test-result-label">Sent headers</span>
                  <code className="test-result-headers">
                    {testResult.sent_headers.map(([k, v]) => `${k}: ${v}`).join('\n')}
                  </code>
                </div>
              )}
            </div>
            );
          })()}
        </div>

        <div className="api-resource-dialog-footer">
          <button className="btn-secondary" onClick={handleTest} disabled={testing}>
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          <div className="api-resource-dialog-footer-right">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
