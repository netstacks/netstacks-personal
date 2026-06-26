import { useState, useEffect, useCallback, useRef } from 'react'
import './StackDetailTab.css'
import {
  getConfigStack,
  createConfigStack,
  updateConfigStack,
  deleteConfigStack,
  listConfigTemplates,
  listStackInstances,
  listConfigDeployments,
  type ConfigStackInstance,
  type ConfigDeployment,
} from '../../api/configManagement'
import type { ConfigStack, ConfigTemplate, ConfigStackService } from '../../api/configManagement'
import { listApiResources, executeInlineQuickAction } from '../../api/quickActions'
import type { ApiResource } from '../../types/quickAction'
import AITabInput from '../AITabInput'

import { getErrorMessage } from '../../api/errors'
interface StackDetailTabProps {
  stackId: string
  onOpenInstanceTab?: (instanceId: string, instanceName: string, stackId?: string) => void
  onOpenDeploymentTab?: (deploymentId: string, deploymentName: string) => void
  onTitleChange?: (title: string) => void
  onDeleted?: () => void
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString()
  } catch {
    return dateStr
  }
}

export default function StackDetailTab({
  stackId,
  onOpenInstanceTab,
  onOpenDeploymentTab,
  onTitleChange,
  onDeleted,
}: StackDetailTabProps) {
  const [stack, setStack] = useState<ConfigStack | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Editing state (always in edit mode)
  const [editServices, setEditServices] = useState<ConfigStackService[]>([])
  const [editDescription, setEditDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Resizable right panel
  const [rightPanelWidth, setRightPanelWidth] = useState(400)
  const [draggingPanel, setDraggingPanel] = useState(false)

  // Available templates for adding services
  const [availableTemplates, setAvailableTemplates] = useState<ConfigTemplate[]>([])
  const [addTemplateOpen, setAddTemplateOpen] = useState(false)
  const [collapsedServices, setCollapsedServices] = useState<Record<number, boolean>>({})

  // Variable config editing
  const [variableScopes, setVariableScopes] = useState<Record<string, 'shared' | 'per_device'>>({})
  const [variableApiConfig, setVariableApiConfig] = useState<Record<string, { resource_id: string; path: string; json_path: string } | null>>({})
  const [apiConfigVar, setApiConfigVar] = useState<string | null>(null)
  const [apiResources, setApiResources] = useState<ApiResource[]>([])
  const [apiTestResult, setApiTestResult] = useState<{ varName: string; loading: boolean; result?: any; error?: string } | null>(null)

  // Deployment procedure
  const [requireMop, setRequireMop] = useState(false)

  // Instances
  const [instances, setInstances] = useState<ConfigStackInstance[]>([])
  const [instancesLoading, setInstancesLoading] = useState(false)

  // Right panel: instances + deployments
  const [deployments, setDeployments] = useState<ConfigDeployment[]>([])
  const [deploymentsLoading, setDeploymentsLoading] = useState(false)

  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange

  // Template name lookup
  const [templateMap, setTemplateMap] = useState<Record<string, string>>({})

  const isCreate = !stackId
  const [editName, setEditName] = useState('')
  const [editAtomic, setEditAtomic] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (!stackId) {
        // Create mode — just load templates and API resources
        const [templates, apiRes] = await Promise.all([
          listConfigTemplates(),
          listApiResources().catch(() => [] as ApiResource[]),
        ])
        setAvailableTemplates(templates)
        setApiResources(apiRes)
        setTemplateMap(Object.fromEntries(templates.map(t => [t.id, t.name])))
        onTitleChangeRef.current?.('New Stack')
        setLoading(false)
        return
      }
      const [s, templates, apiRes] = await Promise.all([
        getConfigStack(stackId),
        listConfigTemplates(),
        listApiResources().catch(() => [] as ApiResource[]),
      ])
      setStack(s)
      setAvailableTemplates(templates)
      setApiResources(apiRes)
      setTemplateMap(Object.fromEntries(templates.map(t => [t.id, t.name])))
      onTitleChangeRef.current?.(`Stack: ${s.name}`)

      // Initialize edit state from loaded data
      setEditServices([...s.services].sort((a, b) => a.order - b.order))
      setEditDescription(s.description || '')
      setEditAtomic(s.atomic)
      const vc = (s.variable_config || {}) as Record<string, any>
      const scopes: Record<string, 'shared' | 'per_device'> = {}
      const apiCfg: Record<string, { resource_id: string; path: string; json_path: string } | null> = {}
      for (const [varName, cfg] of Object.entries(vc)) {
        scopes[varName] = cfg?.scope === 'per_device' ? 'per_device' : 'shared'
        if (cfg?.resource_id) {
          apiCfg[varName] = { resource_id: cfg.resource_id, path: cfg.path || '', json_path: cfg.json_path || '' }
        }
      }
      setVariableScopes(scopes)
      setVariableApiConfig(apiCfg)

      // Initialize deployment settings
      setRequireMop(s.deployment_procedure?.require_mop ?? false)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load stack'))
    } finally {
      setLoading(false)
    }
  }, [stackId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Fetch instances
  useEffect(() => {
    if (!stackId) return
    let cancelled = false
    setInstancesLoading(true)
    listStackInstances(stackId)
      .then(data => { if (!cancelled) setInstances(data) })
      .catch(err => { console.warn(`[StackDetailTab] failed to load instances for ${stackId}:`, err) })
      .finally(() => { if (!cancelled) setInstancesLoading(false) })
    return () => { cancelled = true }
  }, [stackId])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      // Build variable_config from scopes + API config
      const varConfig: Record<string, any> = {}
      for (const [varName, scope] of Object.entries(variableScopes)) {
        const apiCfg = variableApiConfig[varName]
        varConfig[varName] = {
          scope,
          ...(apiCfg?.resource_id ? { resource_id: apiCfg.resource_id, path: apiCfg.path, json_path: apiCfg.json_path } : {}),
        }
      }

      // Build deployment_procedure (simplified — pre/post checks moved to MOP layer)
      const deploymentProcedure = { require_mop: requireMop }

      if (isCreate && !stack) {
        if (!editName.trim()) { setSaving(false); return }
        const created = await createConfigStack({
          name: editName.trim(),
          description: editDescription,
          atomic: editAtomic,
          services: editServices.map((s, i) => ({
            template_id: s.template_id,
            name: s.name,
            order: i,
          })),
          variable_config: varConfig,
          deployment_procedure: deploymentProcedure,
        })
        setStack(created)
        setEditServices([...created.services].sort((a, b) => a.order - b.order))
        setEditDescription(created.description || '')
        setEditName(created.name)
        onTitleChangeRef.current?.(`Stack: ${created.name}`)
        setSaving(false)
        return
      }

      if (!stack) { setSaving(false); return }
      const updated = await updateConfigStack(stack.id, {
        name: stack.name,
        description: editDescription,
        atomic: editAtomic,
        services: editServices.map((s, i) => ({
          template_id: s.template_id,
          name: s.name,
          order: i,
        })),
        variable_config: varConfig,
        deployment_procedure: deploymentProcedure,
      })
      setStack(updated)
      // Re-initialize edit state from saved data
      setEditServices([...updated.services].sort((a, b) => a.order - b.order))
      setEditDescription(updated.description || '')
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save stack'))
    } finally {
      setSaving(false)
    }
  }, [
    stack,
    editServices,
    editDescription,
    editAtomic,
    editName,
    isCreate,
    variableScopes,
    variableApiConfig,
    requireMop,
  ])

  const handleDelete = useCallback(async () => {
    if (!stack) return
    try {
      await deleteConfigStack(stack.id)
      onDeleted?.()
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete stack'))
    }
  }, [stack, onDeleted])

  // Service reorder
  const moveService = useCallback((index: number, direction: 'up' | 'down') => {
    setEditServices(prev => {
      const next = [...prev]
      const targetIndex = direction === 'up' ? index - 1 : index + 1
      if (targetIndex < 0 || targetIndex >= next.length) return prev
      ;[next[index], next[targetIndex]] = [next[targetIndex], next[index]]
      return next
    })
  }, [])

  const removeService = useCallback((index: number) => {
    setEditServices(prev => prev.filter((_, i) => i !== index))
  }, [])

  const addService = useCallback((t: ConfigTemplate) => {
    setEditServices(prev => [
      ...prev,
      { template_id: t.id, name: t.name, order: prev.length },
    ])
    setAddTemplateOpen(false)
  }, [])

  // Fetch deployments for this stack
  useEffect(() => {
    if (!stackId) return
    let cancelled = false
    setDeploymentsLoading(true)
    listConfigDeployments()
      .then(data => {
        if (!cancelled) setDeployments(data.filter(d => d.stack_id === stackId))
      })
      .catch(err => { console.warn(`[StackDetailTab] failed to load deployments for ${stackId}:`, err) })
      .finally(() => { if (!cancelled) setDeploymentsLoading(false) })
    return () => { cancelled = true }
  }, [stackId])

  // Resizable panel divider
  const handlePanelDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDraggingPanel(true)
    const startX = e.clientX
    const startWidth = rightPanelWidth

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.min(800, Math.max(250, startWidth - (ev.clientX - startX)))
      setRightPanelWidth(newWidth)
    }
    const onMouseUp = () => {
      setDraggingPanel(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [rightPanelWidth])

  // All unique variables from templates used by edit services
  // Variables per service (for inline display)
  const getServiceVariables = useCallback((templateId: string): string[] => {
    const tmpl = availableTemplates.find(t => t.id === templateId)
    return tmpl?.variables?.map(v => v.name) || []
  }, [availableTemplates])

  if (loading) {
    return (
      <div className="stack-detail-container">
        <div className="stack-detail-loading">
          <div className="stack-detail-spinner" />
          <span>Loading config details...</span>
        </div>
      </div>
    )
  }

  if (error && !stack) {
    return (
      <div className="stack-detail-container">
        <div className="stack-detail-error">
          <span>{error}</span>
          <button className="stack-detail-btn" onClick={fetchData}>Retry</button>
        </div>
      </div>
    )
  }

  if (!stack && !isCreate) {
    return (
      <div className="stack-detail-container">
        <div className="stack-detail-not-found">
          <span>Stack not found</span>
        </div>
      </div>
    )
  }

  return (
    <div className="stack-detail-container">
      {/* Header */}
      <div className="stack-detail-header">
        <div className="stack-detail-header-info">
          {isCreate && !stack ? (
            <input
              className="instance-detail-name-input"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              placeholder="Stack name..."
              autoFocus
            />
          ) : (
            <h2 className="stack-detail-title">{stack!.name}</h2>
          )}
          <span
            className={`stack-detail-badge ${editAtomic ? 'state-active' : 'state-created'}`}
            style={{ cursor: 'pointer' }}
            onClick={() => setEditAtomic(prev => !prev)}
            title="Click to toggle atomic mode"
          >
            {editAtomic ? 'atomic' : 'non-atomic'}
          </span>
          <span className="stack-detail-badge state-created">
            {editServices.length} service{editServices.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="stack-detail-header-actions">
          <button className="stack-detail-btn primary" onClick={handleSave} disabled={saving || (isCreate && !editName.trim())}>
            {saving ? 'Saving...' : isCreate && !stack ? 'Create' : 'Save'}
          </button>
          {stack && (
            confirmDelete ? (
              <>
                <button className="stack-detail-btn" style={{ background: 'rgba(244, 71, 71, 0.2)', borderColor: '#f44747', color: '#f44747' }} onClick={handleDelete}>
                  Confirm Delete
                </button>
                <button className="stack-detail-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </>
            ) : (
              <button className="stack-detail-btn" onClick={() => setConfirmDelete(true)}>Delete</button>
            )
          )}
        </div>
      </div>

      {error && (
        <div style={{ padding: '6px 16px', background: 'rgba(244, 71, 71, 0.15)', color: '#f44747', fontSize: 12, borderBottom: '1px solid rgba(244, 71, 71, 0.3)' }}>
          {error}
        </div>
      )}

      {stack && (
      <div className="stack-detail-meta-row">
        <div className="stack-detail-meta-field">
          <span className="stack-detail-meta-label">Services</span>
          <span className="stack-detail-meta-value">{stack.services.length}</span>
        </div>
        <div className="stack-detail-meta-field">
          <span className="stack-detail-meta-label">Atomic</span>
          <span
            className="stack-detail-meta-value"
            style={{ cursor: 'pointer', color: editAtomic ? '#4bb44b' : undefined }}
            onClick={() => setEditAtomic(prev => !prev)}
          >
            {editAtomic ? 'Yes' : 'No'}
          </span>
        </div>
        <div className="stack-detail-meta-field">
          <span className="stack-detail-meta-label">Created</span>
          <span className="stack-detail-meta-value">{formatDate(stack.created_at)}</span>
        </div>
        <div className="stack-detail-meta-field">
          <span className="stack-detail-meta-label">Updated</span>
          <span className="stack-detail-meta-value">{formatDate(stack.updated_at)}</span>
        </div>
      </div>
      )}

      <div className="stack-detail-columns">
      <div className="stack-detail-columns-inner">
      <div className="stack-detail-content">
        <div className="stack-detail-section">
          <div className="stack-detail-section-header">Description</div>
          <AITabInput
            as="textarea"
            className="stack-detail-description-edit"
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            placeholder="Stack description..."
            rows={3}
            aiField="stack_description"
            aiPlaceholder="Description of this config stack"
            aiContext={{ name: stack?.name || editName, serviceCount: editServices.length }}
            onAIValue={(v) => setEditDescription(v)}
          />
        </div>

        {/* Services as collapsible panels with inline variables */}
        <div className="stack-detail-section">
          <div className="stack-detail-section-header">
            Services ({editServices.length})
            <button
              className="stack-detail-btn"
              style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 11 }}
              onClick={() => setAddTemplateOpen(!addTemplateOpen)}
            >
              + Add
            </button>
          </div>

          {addTemplateOpen && (
            <div className="stack-detail-add-template">
              {availableTemplates.length === 0 ? (
                <div className="stack-detail-empty-text">No templates available</div>
              ) : (
                availableTemplates.map(t => (
                  <div key={t.id} className="stack-detail-add-template-item" onClick={() => addService(t)}>
                    <span>{t.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary, #858585)' }}>{t.platform}</span>
                  </div>
                ))
              )}
            </div>
          )}

          <div className="stack-detail-services">
            {editServices.map((service, index) => {
              const isCollapsed = collapsedServices[index] ?? true
              const svcVars = getServiceVariables(service.template_id)
              return (
                <div key={`${service.template_id}-${index}`} className="stack-detail-service-panel">
                  <div
                    className="stack-detail-service-panel-header"
                    onClick={() => setCollapsedServices(prev => ({ ...prev, [index]: !isCollapsed }))}
                  >
                    <span className="stack-detail-service-toggle">{isCollapsed ? '▸' : '▾'}</span>
                    <span className="stack-detail-service-order">{index + 1}</span>
                    <span className="stack-detail-service-name">{service.name || templateMap[service.template_id] || 'Unnamed'}</span>
                    <span className="stack-detail-service-var-count">{svcVars.length} var{svcVars.length !== 1 ? 's' : ''}</span>
                    <div className="stack-detail-service-actions">
                      <button className="stack-detail-svc-btn" onClick={(e) => { e.stopPropagation(); moveService(index, 'up') }} disabled={index === 0} title="Move up">&#9650;</button>
                      <button className="stack-detail-svc-btn" onClick={(e) => { e.stopPropagation(); moveService(index, 'down') }} disabled={index === editServices.length - 1} title="Move down">&#9660;</button>
                      <button className="stack-detail-svc-btn stack-detail-svc-btn-remove" onClick={(e) => { e.stopPropagation(); removeService(index) }} title="Remove">&#10005;</button>
                    </div>
                  </div>
                  {!isCollapsed && (
                    <div className="stack-detail-service-panel-body">
                      {svcVars.length === 0 ? (
                        <div className="stack-detail-empty-text">No variables in this template</div>
                      ) : (
                        <div className="stack-detail-variables">
                          {svcVars.map(varName => {
                            const scope = variableScopes[varName] || 'shared'
                            const apiCfg = variableApiConfig[varName]
                            const hasApi = !!apiCfg?.resource_id && !!apiCfg?.path
                            return (
                              <div key={varName} className="stack-detail-var-item">
                                <div className="stack-detail-var-row">
                                  <span className="stack-detail-var-name">{varName}</span>
                                  <select
                                    className="stack-detail-var-scope"
                                    value={scope}
                                    onChange={(e) => setVariableScopes(prev => ({ ...prev, [varName]: e.target.value as 'shared' | 'per_device' }))}
                                  >
                                    <option value="shared">Shared</option>
                                    <option value="per_device">Per Device</option>
                                  </select>
                                  <button
                                    className={`stack-detail-btn ${hasApi ? 'primary' : ''}`}
                                    style={{ padding: '2px 8px', fontSize: 11 }}
                                    onClick={() => setApiConfigVar(apiConfigVar === varName ? null : varName)}
                                  >
                                    {hasApi ? 'API Configured' : 'Configure API'}
                                  </button>
                                </div>
                                {apiConfigVar === varName && (
                                  <div className="stack-detail-api-config">
                                    <div className="stack-detail-api-field">
                                      <label>API Resource</label>
                                      <select className="stack-detail-api-select" value={apiCfg?.resource_id || ''} onChange={(e) => setVariableApiConfig(prev => ({ ...prev, [varName]: { ...prev[varName] || { path: '', json_path: '' }, resource_id: e.target.value } }))}>
                                        <option value="">Select API resource...</option>
                                        {apiResources.map(r => (<option key={r.id} value={r.id}>{r.name}</option>))}
                                      </select>
                                    </div>
                                    <div className="stack-detail-api-field">
                                      <label>API Path</label>
                                      <input type="text" value={apiCfg?.path || ''} onChange={(e) => setVariableApiConfig(prev => ({ ...prev, [varName]: { ...prev[varName] || { resource_id: '', json_path: '' }, path: e.target.value } }))} placeholder="/api/dcim/devices/?name={{ device.name }}" />
                                    </div>
                                    <div className="stack-detail-api-field">
                                      <label>JSON Path</label>
                                      <input type="text" value={apiCfg?.json_path || ''} onChange={(e) => setVariableApiConfig(prev => ({ ...prev, [varName]: { ...prev[varName] || { resource_id: '', path: '' }, json_path: e.target.value } }))} placeholder="$.results[0].primary_ip4.address" />
                                    </div>
                                    <button
                                      className="stack-detail-btn"
                                      style={{ alignSelf: 'flex-start', marginTop: 4 }}
                                      disabled={!apiCfg?.resource_id || !apiCfg?.path || (apiTestResult?.varName === varName && apiTestResult?.loading)}
                                      onClick={async () => {
                                        if (!apiCfg?.resource_id || !apiCfg?.path) return
                                        setApiTestResult({ varName, loading: true })
                                        try {
                                          const result = await executeInlineQuickAction({
                                            api_resource_id: apiCfg.resource_id,
                                            method: 'GET',
                                            path: apiCfg.path,
                                            json_extract_path: apiCfg.json_path || undefined,
                                          })
                                          setApiTestResult({
                                            varName,
                                            loading: false,
                                            result: result.extracted_value ?? result.raw_body,
                                            error: result.error || undefined,
                                          })
                                        } catch (err) {
                                          setApiTestResult({
                                            varName,
                                            loading: false,
                                            error: getErrorMessage(err, 'Test failed'),
                                          })
                                        }
                                      }}
                                    >
                                      {apiTestResult?.varName === varName && apiTestResult?.loading ? 'Testing...' : 'Test'}
                                    </button>
                                    {apiTestResult?.varName === varName && !apiTestResult.loading && (
                                      <div className="stack-detail-api-test-result">
                                        {apiTestResult.error ? (
                                          <span style={{ color: '#f44747' }}>{apiTestResult.error}</span>
                                        ) : (
                                          <pre>{typeof apiTestResult.result === 'string' ? apiTestResult.result : JSON.stringify(apiTestResult.result, null, 2)}</pre>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {editServices.length === 0 && (
              <div className="stack-detail-empty-text">No services. Click "+ Add" to add a template.</div>
            )}
          </div>
        </div>

        {/* Deployment Settings */}
        <div className="stack-detail-section">
          <div className="stack-detail-section-header">
            Deployment Settings
          </div>
          <div className="stack-detail-section-body" style={{ padding: '8px 0' }}>
            <label className="proc-checkbox">
              <input
                type="checkbox"
                checked={requireMop}
                onChange={e => setRequireMop(e.target.checked)}
              />
              Require MOP for deployment
            </label>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4, paddingLeft: 22 }}>
              When enabled, deploying this stack will create a linked MOP for change control and approval.
              Pre-checks, post-checks, and execution settings are configured in the MOP.
            </div>
          </div>
        </div>

      </div>

      {/* Resizable divider */}
      <div
        className={`stack-detail-panel-divider ${draggingPanel ? 'active' : ''}`}
        onMouseDown={handlePanelDividerMouseDown}
      />

      {/* Right panel: Instances + Deployments */}
      <div className="stack-detail-right-panel" style={{ width: rightPanelWidth }}>
        {/* Instances */}
        <div className="stack-detail-section">
          <div className="stack-detail-section-header">
            Instances ({instances.length})
            <button
              className="stack-detail-btn"
              style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 11 }}
              onClick={() => onOpenInstanceTab?.('', `New Instance: ${stack?.name || editName}`, stackId)}
            >
              + New
            </button>
          </div>
          {instancesLoading ? (
            <div className="stack-detail-empty-text">Loading...</div>
          ) : instances.length === 0 ? (
            <div className="stack-detail-empty-text">No instances yet.</div>
          ) : (
            <div className="stack-detail-deployments">
              {instances.map(inst => (
                <div
                  key={inst.id}
                  className="stack-detail-deployment-item"
                  style={{ cursor: 'pointer' }}
                  onClick={() => onOpenInstanceTab?.(inst.id, inst.name, stackId)}
                >
                  <div className="stack-detail-deployment-info">
                    <span className="stack-detail-deployment-name">{inst.name}</span>
                    <span className={`stack-detail-deployment-status status-${inst.state || 'draft'}`}>
                      {inst.state || 'draft'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Deployments (of instances) */}
        <div className="stack-detail-section">
          <div className="stack-detail-section-header">
            Deployments ({deployments.length})
          </div>
          {deploymentsLoading ? (
            <div className="stack-detail-empty-text">Loading...</div>
          ) : deployments.length === 0 ? (
            <div className="stack-detail-empty-text">No deployments yet. Deploy an instance to see history.</div>
          ) : (
            <div className="stack-detail-deployments">
              {deployments.map(dep => (
                <div
                  key={dep.id}
                  className="stack-detail-deployment-item"
                  style={{ cursor: 'pointer' }}
                  onClick={() => onOpenDeploymentTab?.(dep.id, dep.name)}
                >
                  <div className="stack-detail-deployment-info">
                    <span className="stack-detail-deployment-name">{dep.name}</span>
                    <span className={`stack-detail-deployment-status status-${dep.status}`}>{dep.status.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="stack-detail-deployment-meta">
                    <span>{dep.total_devices} device{dep.total_devices !== 1 ? 's' : ''}</span>
                    <span>{dep.succeeded_count} ok</span>
                    <span>{dep.failed_count} failed</span>
                    <span>{formatDate(dep.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      </div>
      </div>
    </div>
  )
}
