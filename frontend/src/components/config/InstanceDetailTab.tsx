import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import './InstanceDetailTab.css'
import {
  getStackInstance,
  getConfigStack,
  createStackInstance,
  updateStackInstance,
  deleteStackInstance,
  deployStackInstance,
  deployInstanceWithMop,
  resolveStackVariables,
  renderConfigStack,
  listConfigDeployments,
  getConfigDeploymentDetail,
  getDeploymentLogs,
  rollbackDeployment,
  listConfigTemplates,
} from '../../api/configManagement'
import type {
  ConfigStack,
  ConfigStackInstance,
  ConfigDeployment,
  ConfigTemplate,
  DeploymentLog,
} from '../../api/configManagement'
import { listEnterpriseDevices } from '../../api/enterpriseDevices'

import { getErrorMessage } from '../../api/errors'
interface InstanceDetailTabProps {
  instanceId?: string
  stackId?: string
  onTitleChange?: (title: string) => void
  onDeleted?: () => void
  onOpenDeploymentTab?: (deploymentId: string, deploymentName: string) => void
  onOpenMopTab?: (executionId: string, name: string) => void
}

/** Local shape of the `renderConfigStack` response — derived from how
 * the preview UI actually reads it (see the `previewResult` JSX below).
 * The backend API itself is typed as `Promise<any>` in configManagement.ts;
 * narrowing here gives the consumer type safety without committing to a
 * full backend contract change. */
interface PreviewJob {
  device_name?: string
  device_id?: string
  template_name?: string
  config_format?: string
  rendered_config?: string
}
type PreviewResult =
  | { error: string; jobs?: undefined }
  | { error?: undefined; jobs?: PreviewJob[] }

interface ServiceConfig {
  devices: string[]
  sharedVars: Record<string, string>
  deviceVars: Record<string, Record<string, string>>
}

interface DeviceOption {
  id: string
  name: string
  host: string
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString()
  } catch {
    return dateStr
  }
}

function stateClass(state: string): string {
  switch (state) {
    case 'deployed': return 'state-deployed'
    case 'failed': return 'state-failed'
    case 'deploying': return 'state-pending'
    case 'draft': return 'state-draft'
    default: return 'state-created'
  }
}

export default function InstanceDetailTab({
  instanceId,
  stackId,
  onTitleChange,
  onDeleted,
  onOpenDeploymentTab,
  onOpenMopTab,
}: InstanceDetailTabProps) {
  const [instance, setInstance] = useState<ConfigStackInstance | null>(null)
  const [stack, setStack] = useState<ConfigStack | null>(null)
  const [templates, setTemplates] = useState<ConfigTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [serviceConfigs, setServiceConfigs] = useState<Record<string, ServiceConfig>>({})
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Device picker
  const [allDevices, setAllDevices] = useState<DeviceOption[]>([])
  const [devicePickerOpen, setDevicePickerOpen] = useState<string | null>(null)
  const [deviceSearch, setDeviceSearch] = useState('')

  // Render preview
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // Deployment history
  const [deployments, setDeployments] = useState<ConfigDeployment[]>([])
  const [deploymentsLoaded, setDeploymentsLoaded] = useState(false)
  const [deploying, setDeploying] = useState(false)

  // Deploy dialog
  const [deployDialogOpen, setDeployDialogOpen] = useState(false)
  const [deployControlMode, setDeployControlMode] = useState('auto_run')

  // Deployment detail (expanded inline)
  const [expandedDeploymentId, setExpandedDeploymentId] = useState<string | null>(null)
  // (Previously a `_deploymentDetail` useState<any> lived here. It was
  // written by loadDeploymentDetail but never read by any JSX or callback,
  // so it was dead state with a stale `any` type. Removed; the visible
  // deployment-row UI reads from the per-deployment `deployments` list.)
  const [deploymentLogs, setDeploymentLogs] = useState<DeploymentLog[]>([])
  const [logFilter, setLogFilter] = useState<'all' | 'info' | 'debug' | 'warning' | 'error'>('all')
  const [rollingBack, setRollingBack] = useState<string | null>(null)

  // Resolving
  const [resolving, setResolving] = useState(false)

  // Collapsible service panels
  const [collapsedServices, setCollapsedServices] = useState<Record<string, boolean>>({})

  const isCreate = !instanceId
  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange

  const getVariableScope = useCallback((varName: string): 'shared' | 'per_device' => {
    const vc = stack?.variable_config as Record<string, any> | undefined
    return vc?.[varName]?.scope === 'per_device' ? 'per_device' : 'shared'
  }, [stack])

  const hasApiVariables = useMemo(() => {
    if (!stack?.variable_config) return false
    return Object.values(stack.variable_config as Record<string, any>)
      .some((cfg: any) => cfg?.resource_id)
  }, [stack])

  // Build service configs from instance data
  const buildServiceConfigs = useCallback((
    inst: ConfigStackInstance | null,
    stk: ConfigStack,
    tmpls: ConfigTemplate[],
  ): Record<string, ServiceConfig> => {
    const configs: Record<string, ServiceConfig> = {}
    const sortedServices = [...stk.services].sort((a, b) => a.order - b.order)

    sortedServices.forEach((svc, idx) => {
      const key = String(idx)
      const tmpl = tmpls.find(t => t.id === svc.template_id)
      const existingDevices = inst?.target_devices?.[key] || []
      const existingShared = inst?.variable_values?.[key] || {}
      const existingDeviceVars = inst?.device_overrides?.[key] || {}

      // Initialize all template variables with empty strings
      const sharedVars: Record<string, string> = {}
      const deviceVars: Record<string, Record<string, string>> = {}

      if (tmpl) {
        for (const v of tmpl.variables) {
          if (getVariableScope(v.name) === 'shared') {
            sharedVars[v.name] = existingShared[v.name] || ''
          }
        }
      }
      // Merge existing shared values
      for (const [k, v] of Object.entries(existingShared)) {
        if (!(k in sharedVars)) sharedVars[k] = String(v)
      }

      // Build per-device vars
      for (const deviceId of existingDevices) {
        deviceVars[deviceId] = {}
        if (tmpl) {
          for (const v of tmpl.variables) {
            if (getVariableScope(v.name) === 'per_device') {
              deviceVars[deviceId][v.name] = existingDeviceVars[deviceId]?.[v.name] || ''
            }
          }
        }
        // Merge existing device overrides
        if (existingDeviceVars[deviceId]) {
          for (const [k, val] of Object.entries(existingDeviceVars[deviceId])) {
            if (!(k in deviceVars[deviceId])) deviceVars[deviceId][k] = String(val)
          }
        }
      }

      configs[key] = { devices: existingDevices, sharedVars, deviceVars }
    })

    return configs
  }, [getVariableScope])

  // Load data
  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let inst: ConfigStackInstance | null = null
      let stk: ConfigStack | null = null

      if (instanceId) {
        inst = await getStackInstance(instanceId)
        stk = await getConfigStack(inst.stack_id)
        setName(inst.name)
        onTitleChangeRef.current?.(`Instance: ${inst.name}`)
      } else if (stackId) {
        stk = await getConfigStack(stackId)
        setName('')
        onTitleChangeRef.current?.('New Instance')
      }

      if (!stk) {
        setError('No stack found')
        setLoading(false)
        return
      }

      // Fetch templates for variable info
      const tmpls = await listConfigTemplates()
      setTemplates(tmpls)
      setInstance(inst)
      setStack(stk)

      // Build service configs
      setServiceConfigs(buildServiceConfigs(inst, stk, tmpls))

      // Load devices
      try {
        const devs = await listEnterpriseDevices({ limit: 500 })
        const items = devs.items || []
        setAllDevices(items.map(d => ({ id: d.id, name: d.name, host: d.host })))
      } catch {
        // Devices not available
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load instance'))
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- buildServiceConfigs takes explicit args, including it causes infinite loop via stack→getVariableScope→buildServiceConfigs→fetchData chain
  }, [instanceId, stackId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Load deployment history
  const loadDeployments = useCallback(async () => {
    if (!instance || deploymentsLoaded) return
    try {
      const all = await listConfigDeployments()
      setDeployments(all.filter(d => d.stack_id === instance.stack_id))
      setDeploymentsLoaded(true)
    } catch {
      // ignore
    }
  }, [instance, deploymentsLoaded])

  // Auto-load deployments when instance is available
  useEffect(() => {
    if (instance && !deploymentsLoaded) loadDeployments()
  }, [instance, deploymentsLoaded, loadDeployments])

  // Load deployment detail (logs + detail)
  const loadDeploymentDetail = useCallback(async (deploymentId: string) => {
    try {
      const [detail, logs] = await Promise.all([
        getConfigDeploymentDetail(deploymentId),
        getDeploymentLogs(deploymentId),
      ])
      // _detail was previously stored in unused state; we keep loading it
      // because the call also exercises the backend (404 surfaces in the
      // catch below). Drop the result on the floor — JSX doesn't read it.
      void detail
      setDeploymentLogs(Array.isArray(logs) ? logs : [])
    } catch {
      setDeploymentLogs([])
    }
  }, [])

  // Expand/collapse deployment
  const handleExpandDeployment = useCallback(async (deployment: ConfigDeployment) => {
    if (expandedDeploymentId === deployment.id) {
      setExpandedDeploymentId(null)
      setDeploymentLogs([])
      setLogFilter('all')
    } else {
      setExpandedDeploymentId(deployment.id)
      await loadDeploymentDetail(deployment.id)
    }
  }, [expandedDeploymentId, loadDeploymentDetail])

  // Rollback deployment
  const handleRollback = useCallback(async (deploymentId: string) => {
    setRollingBack(deploymentId)
    try {
      await rollbackDeployment(deploymentId)
      setDeploymentsLoaded(false)
      if (expandedDeploymentId === deploymentId) {
        await loadDeploymentDetail(deploymentId)
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Rollback failed'))
    } finally {
      setRollingBack(null)
    }
  }, [expandedDeploymentId, loadDeploymentDetail])

  // Deployment progress timeline from logs
  const getStatusTimeline = useCallback((logs: DeploymentLog[], deploymentStatus?: string) => {
    const stages = ['render', 'backup', 'push', 'validate', 'confirm', 'sync']
    const stageStatus: Record<string, 'completed' | 'current' | 'failed' | 'pending' | 'skipped'> = {}
    for (const stage of stages) stageStatus[stage] = 'pending'
    for (const log of logs) {
      const msg = log.message.toLowerCase()
      for (const stage of stages) {
        if (msg.includes(stage)) {
          if (log.level === 'error') stageStatus[stage] = 'failed'
          else if (msg.includes('completed') || msg.includes('success')) stageStatus[stage] = 'completed'
          else stageStatus[stage] = 'current'
        }
      }
    }
    for (let i = 1; i < stages.length; i++) {
      if (stageStatus[stages[i]] !== 'pending') {
        for (let j = 0; j < i; j++) {
          if (stageStatus[stages[j]] === 'current') stageStatus[stages[j]] = 'completed'
        }
      }
    }
    if (deploymentStatus === 'completed') {
      for (const stage of stages) {
        if (stageStatus[stage] === 'current') stageStatus[stage] = 'completed'
      }
    } else if (deploymentStatus === 'failed') {
      let lastCurrent = -1
      for (let i = stages.length - 1; i >= 0; i--) {
        if (stageStatus[stages[i]] === 'current') { lastCurrent = i; break }
      }
      if (lastCurrent >= 0) stageStatus[stages[lastCurrent]] = 'failed'
    }
    let sawFailure = false
    for (const stage of stages) {
      if (sawFailure && stageStatus[stage] === 'pending') stageStatus[stage] = 'skipped'
      if (stageStatus[stage] === 'failed') sawFailure = true
    }
    return stages.map(stage => ({ stage, status: stageStatus[stage] }))
  }, [])

  // Filtered logs
  const filteredLogs = useMemo(() => {
    if (logFilter === 'all') return deploymentLogs
    return deploymentLogs.filter(log => log.level === logFilter)
  }, [deploymentLogs, logFilter])

  // Auto-refresh active deployments
  useEffect(() => {
    const hasActive = deployments.some(d => ['pending', 'in_progress', 'rolling_back'].includes(d.status))
    if (!hasActive || !deploymentsLoaded) return
    const interval = setInterval(async () => {
      try {
        const all = await listConfigDeployments()
        const filtered = instance ? all.filter(d => d.stack_id === instance.stack_id) : all
        setDeployments(filtered)
        if (expandedDeploymentId) {
          const dep = filtered.find(d => d.id === expandedDeploymentId)
          if (dep && ['pending', 'in_progress', 'rolling_back'].includes(dep.status)) {
            await loadDeploymentDetail(expandedDeploymentId)
          }
        }
      } catch { /* ignore */ }
    }, 3000)
    return () => clearInterval(interval)
  }, [deployments, deploymentsLoaded, expandedDeploymentId, instance, loadDeploymentDetail])

  // Update service config helper
  const updateServiceConfig = useCallback((serviceKey: string, updater: (prev: ServiceConfig) => ServiceConfig) => {
    setServiceConfigs(prev => ({
      ...prev,
      [serviceKey]: updater(prev[serviceKey] || { devices: [], sharedVars: {}, deviceVars: {} }),
    }))
    setDirty(true)
  }, [])

  // Add device to service
  const addDevice = useCallback((serviceKey: string, deviceId: string) => {
    updateServiceConfig(serviceKey, prev => {
      if (prev.devices.includes(deviceId)) return prev
      const deviceVars: Record<string, string> = {}
      // Initialize per-device variables
      const svcIdx = parseInt(serviceKey)
      const svc = stack?.services.sort((a, b) => a.order - b.order)[svcIdx]
      const tmpl = svc ? templates.find(t => t.id === svc.template_id) : null
      if (tmpl) {
        for (const v of tmpl.variables) {
          if (getVariableScope(v.name) === 'per_device') {
            deviceVars[v.name] = ''
          }
        }
      }
      return {
        ...prev,
        devices: [...prev.devices, deviceId],
        deviceVars: { ...prev.deviceVars, [deviceId]: deviceVars },
      }
    })
    setDevicePickerOpen(null)
    setDeviceSearch('')
  }, [updateServiceConfig, stack, templates, getVariableScope])

  // Remove device from service
  const removeDevice = useCallback((serviceKey: string, deviceId: string) => {
    updateServiceConfig(serviceKey, prev => {
      const newDeviceVars = { ...prev.deviceVars }
      delete newDeviceVars[deviceId]
      return {
        ...prev,
        devices: prev.devices.filter(d => d !== deviceId),
        deviceVars: newDeviceVars,
      }
    })
  }, [updateServiceConfig])

  // Update shared variable
  const updateSharedVar = useCallback((serviceKey: string, varName: string, value: string) => {
    updateServiceConfig(serviceKey, prev => ({
      ...prev,
      sharedVars: { ...prev.sharedVars, [varName]: value },
    }))
  }, [updateServiceConfig])

  // Update device variable
  const updateDeviceVar = useCallback((serviceKey: string, deviceId: string, varName: string, value: string) => {
    updateServiceConfig(serviceKey, prev => ({
      ...prev,
      deviceVars: {
        ...prev.deviceVars,
        [deviceId]: { ...prev.deviceVars[deviceId], [varName]: value },
      },
    }))
  }, [updateServiceConfig])

  // Save / Create
  const handleSave = useCallback(async () => {
    if (!stack || !name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const body = {
        stack_id: stack.id,
        name: name.trim(),
        target_devices: Object.fromEntries(
          Object.entries(serviceConfigs).map(([idx, svc]) => [idx, svc.devices])
        ),
        variable_values: Object.fromEntries(
          Object.entries(serviceConfigs).map(([idx, svc]) => [idx, svc.sharedVars])
        ),
        device_overrides: Object.fromEntries(
          Object.entries(serviceConfigs).map(([idx, svc]) => [idx, svc.deviceVars])
        ),
      }

      if (isCreate) {
        const created = await createStackInstance(body)
        setInstance(created)
        onTitleChangeRef.current?.(`Instance: ${created.name}`)
      } else if (instance) {
        const updated = await updateStackInstance(instance.id, body)
        setInstance(updated)
        onTitleChangeRef.current?.(`Instance: ${updated.name}`)
      }
      setDirty(false)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save instance'))
    } finally {
      setSaving(false)
    }
  }, [stack, name, serviceConfigs, isCreate, instance])

  // Deploy
  const handleDeploy = useCallback(async () => {
    if (!instance) return
    setDeploying(true)
    setError(null)
    try {
      await deployStackInstance(instance.id)
      // Refresh instance to get new state
      const updated = await getStackInstance(instance.id)
      setInstance(updated)
      setDeploymentsLoaded(false)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to deploy instance'))
    } finally {
      setDeploying(false)
    }
  }, [instance])

  // Deploy with MOP
  const handleDeployWithMop = useCallback(async () => {
    if (!instance || !stack) return
    setDeploying(true)
    setError(null)
    try {
      const result = await deployInstanceWithMop(instance.id, {
        control_mode: deployControlMode,
        name: `Deploy: ${instance.name}`,
      })
      setDeployDialogOpen(false)
      onOpenMopTab?.(result.mop_execution_id, `Deploy: ${instance.name}`)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to create deployment MOP'))
    } finally {
      setDeploying(false)
    }
  }, [instance, stack, deployControlMode, onOpenMopTab])

  // Delete
  const handleDelete = useCallback(async () => {
    if (!instance) return
    try {
      await deleteStackInstance(instance.id)
      onDeleted?.()
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete instance'))
    }
  }, [instance, onDeleted])

  // Resolve from API
  const handleResolve = useCallback(async () => {
    if (!stack) return
    setResolving(true)
    setError(null)
    try {
      // Collect all devices across services
      const allTargetDevices: string[] = []
      for (const svc of Object.values(serviceConfigs)) {
        for (const d of svc.devices) {
          if (!allTargetDevices.includes(d)) allTargetDevices.push(d)
        }
      }

      const result = await resolveStackVariables(stack.id, {
        target_devices: allTargetDevices.map(d => ({ device_id: d })),
      })

      // Merge resolved values into service configs
      if (result && typeof result === 'object') {
        setServiceConfigs(prev => {
          const next = { ...prev }
          for (const [svcKey, svcCfg] of Object.entries(next)) {
            const cfg = svcCfg as ServiceConfig
            // Merge shared vars from result
            if (result.shared) {
              for (const [k, v] of Object.entries(result.shared as Record<string, any>)) {
                if (k in cfg.sharedVars) {
                  cfg.sharedVars[k] = String(v)
                }
              }
            }
            // Merge per-device vars from result
            if (result.per_device) {
              for (const deviceId of cfg.devices) {
                const deviceResult = (result.per_device as Record<string, any>)[deviceId]
                if (deviceResult && cfg.deviceVars[deviceId]) {
                  for (const [k, v] of Object.entries(deviceResult as Record<string, any>)) {
                    if (k in cfg.deviceVars[deviceId]) {
                      cfg.deviceVars[deviceId][k] = String(v)
                    }
                  }
                }
              }
            }
            next[svcKey] = { ...cfg }
          }
          return next
        })
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to resolve variables'))
    } finally {
      setResolving(false)
    }
  }, [stack, serviceConfigs])

  // Render preview
  const handleRender = useCallback(async () => {
    if (!stack) return
    setPreviewLoading(true)
    setPreviewResult(null)
    try {
      // Controller expects: { variable_values: { "0": { devices: [...], shared_vars: {...}, device_vars: {...} } } }
      const body = {
        variable_values: Object.fromEntries(
          Object.entries(serviceConfigs).map(([idx, svc]) => [idx, {
            devices: svc.devices,
            shared_vars: svc.sharedVars,
            device_vars: svc.deviceVars,
          }])
        ),
      }
      const result = await renderConfigStack(stack.id, body)
      setPreviewResult(result)
    } catch (err) {
      setPreviewResult({ error: getErrorMessage(err, 'Render failed') })
    } finally {
      setPreviewLoading(false)
    }
  }, [stack, serviceConfigs])

  // Toggle service panel
  const toggleService = useCallback((key: string) => {
    setCollapsedServices(prev => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // Device name lookup
  const getDeviceName = useCallback((deviceId: string): string => {
    const dev = allDevices.find(d => d.id === deviceId)
    return dev ? dev.name : deviceId.slice(0, 8)
  }, [allDevices])

  // Filtered devices for picker
  const filteredDevices = useMemo(() => {
    if (!deviceSearch.trim()) return allDevices
    const q = deviceSearch.toLowerCase()
    return allDevices.filter(d =>
      d.name.toLowerCase().includes(q) || d.host.toLowerCase().includes(q)
    )
  }, [allDevices, deviceSearch])

  // Deployment procedure checks
  const procedure = stack?.deployment_procedure
  const hasProcedure = !!procedure
  const procedureRequiresMop = !!procedure?.require_mop

  if (loading) {
    return (
      <div className="instance-detail-container">
        <div className="instance-detail-loading">
          <div className="instance-detail-spinner" />
          <span>Loading instance...</span>
        </div>
      </div>
    )
  }

  if (error && !stack) {
    return (
      <div className="instance-detail-container">
        <div className="instance-detail-error">
          <span>{error}</span>
          <button className="instance-detail-btn" onClick={fetchData}>Retry</button>
        </div>
      </div>
    )
  }

  if (!stack) {
    return (
      <div className="instance-detail-container">
        <div className="instance-detail-not-found">
          <span>Instance not found</span>
        </div>
      </div>
    )
  }

  const sortedServices = [...stack.services].sort((a, b) => a.order - b.order)

  return (
    <div className="instance-detail-container">
      {/* Header */}
      <div className="instance-detail-header">
        <div className="instance-detail-header-info">
          {isCreate ? (
            <input
              className="instance-detail-name-input"
              value={name}
              onChange={e => { setName(e.target.value); setDirty(true) }}
              placeholder="Instance name..."
              autoFocus
            />
          ) : (
            <h2 className="instance-detail-title">{instance?.name || name}</h2>
          )}
          {instance && (
            <span className={`instance-detail-badge ${stateClass(instance.state)}`}>
              {instance.state}
            </span>
          )}
          <span className="instance-detail-badge state-created">
            {stack.name}
          </span>
        </div>
        <div className="instance-detail-header-actions">
          <button
            className="instance-detail-btn primary"
            onClick={handleSave}
            disabled={saving || !name.trim() || (!isCreate && !dirty)}
          >
            {saving ? 'Saving...' : isCreate ? 'Create' : 'Save'}
          </button>
          {instance && !confirmDelete && (
            <button className="instance-detail-btn danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
          {instance && confirmDelete && (
            <>
              <button
                className="instance-detail-btn danger-confirm"
                onClick={handleDelete}
              >
                Confirm
              </button>
              <button className="instance-detail-btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="instance-detail-error-bar">
          {error}
        </div>
      )}

      {/* Meta row */}
      {instance && (
        <div className="instance-detail-meta-row">
          <div className="instance-detail-meta-field">
            <span className="instance-detail-meta-label">State</span>
            <span className="instance-detail-meta-value">{instance.state}</span>
          </div>
          <div className="instance-detail-meta-field">
            <span className="instance-detail-meta-label">Stack</span>
            <span className="instance-detail-meta-value">{stack.name}</span>
          </div>
          <div className="instance-detail-meta-field">
            <span className="instance-detail-meta-label">Created</span>
            <span className="instance-detail-meta-value">{formatDate(instance.created_at)}</span>
          </div>
          <div className="instance-detail-meta-field">
            <span className="instance-detail-meta-label">Updated</span>
            <span className="instance-detail-meta-value">{formatDate(instance.updated_at)}</span>
          </div>
        </div>
      )}

      <div className="instance-detail-content">
        {/* Resolve from API button */}
        {hasApiVariables && (
          <button
            className="instance-detail-btn"
            onClick={handleResolve}
            disabled={resolving}
            style={{ alignSelf: 'flex-start' }}
          >
            {resolving ? 'Resolving...' : 'Resolve from API'}
          </button>
        )}

        {/* Service Panels */}
        {sortedServices.map((svc, idx) => {
          const key = String(idx)
          const svcConfig = serviceConfigs[key] || { devices: [], sharedVars: {}, deviceVars: {} }
          const tmpl = templates.find(t => t.id === svc.template_id)
          const isCollapsed = collapsedServices[key]

          const sharedVarNames = tmpl
            ? tmpl.variables.filter(v => getVariableScope(v.name) === 'shared').map(v => v.name)
            : Object.keys(svcConfig.sharedVars)

          const perDeviceVarNames = tmpl
            ? tmpl.variables.filter(v => getVariableScope(v.name) === 'per_device').map(v => v.name)
            : []

          return (
            <div key={key} className="instance-service-panel">
              <div
                className="instance-service-panel-header"
                onClick={() => toggleService(key)}
              >
                <span className="instance-service-panel-chevron">
                  {isCollapsed ? '\u25B6' : '\u25BC'}
                </span>
                <span className="instance-service-panel-order">{idx + 1}</span>
                <span className="instance-service-panel-name">{svc.name || tmpl?.name || 'Unnamed Service'}</span>
                <span className="instance-service-panel-devices-count">
                  {svcConfig.devices.length} device{svcConfig.devices.length !== 1 ? 's' : ''}
                </span>
              </div>

              {!isCollapsed && (
                <div className="instance-service-panel-body">
                  {/* Device Assignment */}
                  <div className="instance-service-section">
                    <div className="instance-service-section-label">Devices</div>
                    <div className="instance-device-chips">
                      {svcConfig.devices.map(deviceId => (
                        <span key={deviceId} className="instance-device-chip">
                          {getDeviceName(deviceId)}
                          <button
                            className="instance-device-chip-remove"
                            onClick={() => removeDevice(key, deviceId)}
                          >
                            &times;
                          </button>
                        </span>
                      ))}
                      <div className="instance-device-picker-wrapper">
                        <button
                          className="instance-device-add-btn"
                          onClick={() => {
                            setDevicePickerOpen(devicePickerOpen === key ? null : key)
                            setDeviceSearch('')
                          }}
                        >
                          + Add
                        </button>
                        {devicePickerOpen === key && (
                          <div className="instance-device-picker">
                            <input
                              className="instance-device-picker-search"
                              value={deviceSearch}
                              onChange={e => setDeviceSearch(e.target.value)}
                              placeholder="Search devices..."
                              autoFocus
                            />
                            <div className="instance-device-picker-list">
                              {filteredDevices
                                .filter(d => !svcConfig.devices.includes(d.id))
                                .slice(0, 50)
                                .map(d => (
                                  <div
                                    key={d.id}
                                    className="instance-device-picker-item"
                                    onClick={() => addDevice(key, d.id)}
                                  >
                                    <span className="instance-device-picker-item-name">{d.name}</span>
                                    <span className="instance-device-picker-item-host">{d.host}</span>
                                  </div>
                                ))
                              }
                              {filteredDevices.filter(d => !svcConfig.devices.includes(d.id)).length === 0 && (
                                <div className="instance-detail-empty-text">No devices found</div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Shared Variables */}
                  {sharedVarNames.length > 0 && (
                    <div className="instance-service-section">
                      <div className="instance-service-section-label">Shared Variables</div>
                      <div className="instance-var-grid">
                        {sharedVarNames.map(varName => (
                          <div key={varName} className="instance-var-row">
                            <label className="instance-var-label">{varName}</label>
                            <input
                              className="instance-var-input"
                              value={svcConfig.sharedVars[varName] || ''}
                              onChange={e => updateSharedVar(key, varName, e.target.value)}
                              placeholder={`Enter ${varName}...`}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Per-Device Variables */}
                  {perDeviceVarNames.length > 0 && svcConfig.devices.length > 0 && (
                    <div className="instance-service-section">
                      <div className="instance-service-section-label">Per-Device Variables</div>
                      {svcConfig.devices.map(deviceId => (
                        <div key={deviceId} className="instance-device-var-group">
                          <div className="instance-device-var-group-header">
                            {getDeviceName(deviceId)}
                          </div>
                          <div className="instance-var-grid">
                            {perDeviceVarNames.map(varName => (
                              <div key={varName} className="instance-var-row">
                                <label className="instance-var-label">{varName}</label>
                                <input
                                  className="instance-var-input"
                                  value={svcConfig.deviceVars[deviceId]?.[varName] || ''}
                                  onChange={e => updateDeviceVar(key, deviceId, varName, e.target.value)}
                                  placeholder={`Enter ${varName}...`}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {sortedServices.length === 0 && (
          <div className="instance-detail-empty-text">
            This stack has no services configured.
          </div>
        )}

        {/* Render Preview */}
        <div className="instance-detail-section">
          <div
            className="instance-detail-section-header instance-detail-section-toggle"
            onClick={() => setPreviewOpen(!previewOpen)}
          >
            <span>{previewOpen ? '\u25BC' : '\u25B6'}</span>
            <span>Render Preview</span>
          </div>
          {previewOpen && (
            <div className="instance-detail-section-body">
              <button
                className="instance-detail-btn"
                onClick={handleRender}
                disabled={previewLoading}
                style={{ marginBottom: 10 }}
              >
                {previewLoading ? 'Rendering...' : 'Render'}
              </button>
              {previewResult && (
                <div className="instance-render-preview">
                  {previewResult.error ? (
                    <span style={{ color: '#f44747' }}>{previewResult.error}</span>
                  ) : previewResult.jobs && previewResult.jobs.length > 0 ? (
                    previewResult.jobs.map((job, i) => (
                      <div key={i} className="instance-render-job">
                        <div className="instance-render-job-header">
                          <span className="instance-render-job-device">{job.device_name || job.device_id?.slice(0, 8)}</span>
                          <span className="instance-render-job-template">{job.template_name}</span>
                          {job.config_format && <span className="instance-render-job-format">{job.config_format}</span>}
                        </div>
                        <pre>{job.rendered_config || '(empty)'}</pre>
                      </div>
                    ))
                  ) : (
                    <span style={{ color: '#888' }}>No render jobs produced. Assign devices and fill variables first.</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Deployments */}
        {instance && (
          <div className="instance-detail-section">
            <div className="instance-detail-section-header" style={{ justifyContent: 'space-between' }}>
              <span>Deployments</span>
              <button
                className="instance-detail-btn primary"
                onClick={() => {
                  if (hasProcedure) {
                    setDeployDialogOpen(true)
                  } else {
                    handleDeploy()
                  }
                }}
                disabled={deploying}
                style={{ padding: '2px 10px', fontSize: 11 }}
              >
                {deploying ? 'Deploying...' : 'Deploy Now'}
              </button>
            </div>
            {!deploymentsLoaded ? (
              <div className="instance-detail-empty-text">Loading deployments...</div>
            ) : deployments.length === 0 ? (
              <div className="instance-detail-empty-text">No deployments yet. Click "Deploy Now" to create the first deployment.</div>
            ) : (
              <div className="instance-deployments-list">
                {deployments.map(dep => {
                  const isExpanded = expandedDeploymentId === dep.id
                  return (
                    <div key={dep.id} className={`instance-deployment-item ${isExpanded ? 'expanded' : ''}`}>
                      <div
                        className="instance-deployment-item-header"
                        onClick={() => handleExpandDeployment(dep)}
                      >
                        <div className="instance-deployment-header-left">
                          <span className="instance-deployment-chevron">{isExpanded ? '\u25BC' : '\u25B6'}</span>
                          <span className="instance-deployment-name">{dep.name}</span>
                        </div>
                        <div className="instance-deployment-header-right">
                          <span className={`instance-deployment-status-badge status-${dep.status}`}>
                            {dep.status.replace(/_/g, ' ')}
                          </span>
                          <span className="instance-deployment-meta-text">
                            {dep.total_devices} device{dep.total_devices !== 1 ? 's' : ''}
                          </span>
                          <span className="instance-deployment-meta-text">
                            {formatDate(dep.created_at)}
                          </span>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="instance-deployment-detail">
                          {/* Actions row */}
                          <div className="instance-deployment-actions">
                            {(dep.status === 'completed' || dep.status === 'failed') && (
                              <button
                                className="instance-detail-btn"
                                onClick={() => handleRollback(dep.id)}
                                disabled={rollingBack === dep.id}
                              >
                                {rollingBack === dep.id ? 'Rolling back...' : '\u21A9 Rollback'}
                              </button>
                            )}
                            <button
                              className="instance-detail-btn"
                              onClick={(e) => { e.stopPropagation(); onOpenDeploymentTab?.(dep.id, dep.name) }}
                            >
                              Open Full Details ↗
                            </button>
                          </div>

                          {/* Progress Pipeline */}
                          {deploymentLogs.length > 0 && (
                            <div className="instance-deployment-progress">
                              <div className="instance-deployment-progress-label">Deployment Progress</div>
                              <div className="instance-deployment-pipeline">
                                {getStatusTimeline(deploymentLogs, dep.status).map(({ stage, status }, idx) => (
                                  <div key={stage} className="instance-pipeline-stage-wrapper">
                                    <div className="instance-pipeline-stage">
                                      <div className={`instance-pipeline-circle stage-${status}`}>
                                        {status === 'completed' ? '\u2713'
                                          : status === 'failed' ? '\u2717'
                                          : status === 'current' ? '\u25CB'
                                          : status === 'skipped' ? '\u2014'
                                          : '\u25CB'}
                                      </div>
                                      <span className="instance-pipeline-stage-label">{stage.charAt(0).toUpperCase() + stage.slice(1)}</span>
                                    </div>
                                    {idx < 5 && (
                                      <div className={`instance-pipeline-line ${status === 'completed' ? 'completed' : ''}`} />
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Deployment Logs */}
                          {deploymentLogs.length > 0 && (
                            <div className="instance-deployment-logs-section">
                              <div className="instance-deployment-logs-header">
                                <span className="instance-deployment-progress-label">Deployment Logs</span>
                                <div className="instance-deployment-log-filters">
                                  {(['all', 'info', 'debug', 'warning', 'error'] as const).map(level => (
                                    <button
                                      key={level}
                                      className={`instance-log-filter-btn ${logFilter === level ? 'active' : ''}`}
                                      onClick={() => setLogFilter(level)}
                                    >
                                      {level.charAt(0).toUpperCase() + level.slice(1)}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <div className="instance-deployment-logs-container">
                                {filteredLogs.map((log, idx) => (
                                  <div key={`${log.id}-${idx}`} className="instance-deployment-log-entry">
                                    <span className="instance-log-time">{new Date(log.created_at).toLocaleTimeString()}</span>
                                    <span className={`instance-log-level level-${log.level}`}>{log.level.toUpperCase()}</span>
                                    <span className="instance-log-message">{log.message}</span>
                                    {log.device_id && (
                                      <span className="instance-log-device">{log.device_id}</span>
                                    )}
                                  </div>
                                ))}
                                {filteredLogs.length === 0 && (
                                  <div className="instance-detail-empty-text">No {logFilter} logs</div>
                                )}
                              </div>
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

      {/* Deploy Dialog */}
      {deployDialogOpen && stack && (
        <div className="instance-deploy-overlay" onClick={() => setDeployDialogOpen(false)}>
          <div className="instance-deploy-dialog" onClick={e => e.stopPropagation()}>
            <div className="instance-deploy-dialog-header">
              <h3>Deploy Instance: {instance?.name}</h3>
              <button className="instance-detail-btn" onClick={() => setDeployDialogOpen(false)}>{'\u2715'}</button>
            </div>
            <div className="instance-deploy-dialog-body">
              <p className="instance-deploy-dialog-summary">
                This stack has a deployment procedure with{' '}
                {stack.deployment_procedure?.pre_checks?.length || 0} pre-checks,{' '}
                {stack.deployment_procedure?.post_checks?.length || 0} post-checks.
                On failure: {stack.deployment_procedure?.on_post_check_failure || 'pause'}.
              </p>
              <div className="instance-deploy-dialog-field">
                <label>Control Mode</label>
                <select value={deployControlMode} onChange={e => setDeployControlMode(e.target.value)}>
                  <option value="manual">Manual</option>
                  <option value="auto_run">Auto-run</option>
                  <option value="ai_pilot">AI Pilot</option>
                </select>
              </div>
            </div>
            <div className="instance-deploy-dialog-actions">
              <button
                className="instance-detail-btn primary"
                onClick={handleDeployWithMop}
                disabled={deploying}
              >
                {deploying ? 'Creating...' : 'Deploy with Procedure'}
              </button>
              {!procedureRequiresMop && (
                <button
                  className="instance-detail-btn"
                  onClick={() => { setDeployDialogOpen(false); handleDeploy() }}
                  disabled={deploying}
                >
                  Quick Deploy
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
