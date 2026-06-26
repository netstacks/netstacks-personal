import { useState, useEffect } from 'react'
import { listApiResources } from '../api/quickActions'
import type { ApiResource } from '../types/quickAction'
import ApiResourceDialog from './ApiResourceDialog'
import './ApiResourcePicker.css'

export interface ApiResourcePickerProps {
  value: string | null
  onChange: (id: string) => void
  label?: string
  required?: boolean
}

const describeAuth = (resource: ApiResource): string => {
  switch (resource.auth_type) {
    case 'none': return 'No Auth'
    case 'bearer_token': return 'Bearer Token'
    case 'basic': return 'Basic Auth'
    case 'api_key_header': return `API Key Header (${resource.auth_header_name || 'X-API-Key'})`
    case 'multi_step': return `Multi-Step Auth (${resource.auth_flow?.length || 0} steps)`
    default: return resource.auth_type
  }
}

export default function ApiResourcePicker({ value, onChange, label = 'API Resource', required = false }: ApiResourcePickerProps) {
  const [resources, setResources] = useState<ApiResource[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)

  const fetchResources = async () => {
    setLoading(true)
    try {
      const data = await listApiResources()
      setResources(data)
    } catch (err) {
      console.error('Failed to load API resources:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchResources()
  }, [])

  const handleDialogSaved = (newResource: ApiResource) => {
    setDialogOpen(false)
    fetchResources().then(() => {
      onChange(newResource.id)
    })
  }

  const selectedResource = resources.find(r => r.id === value)

  return (
    <div className="api-resource-picker">
      <div className="form-group">
        <label>{label} {required && <span className="required">*</span>}</label>
        <div className="picker-control">
          <select
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            required={required}
            disabled={loading}
          >
            <option value="">
              {loading ? 'Loading...' : '— Select API Resource —'}
            </option>
            {resources.map(resource => (
              <option key={resource.id} value={resource.id}>
                {resource.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-secondary btn-small"
            onClick={() => setDialogOpen(true)}
            title="Create new API resource"
          >
            + Create new
          </button>
        </div>
      </div>

      {selectedResource && (
        <div className="resource-preview">
          <span className="preview-label">Base URL:</span> <code>{selectedResource.base_url}</code>
          <span className="preview-separator">·</span>
          <span className="preview-label">Auth:</span> <span>{describeAuth(selectedResource)}</span>
        </div>
      )}

      {dialogOpen && (
        <ApiResourceDialog
          resource={null}
          mode="create"
          onClose={() => setDialogOpen(false)}
          onSaved={handleDialogSaved}
        />
      )}
    </div>
  )
}
