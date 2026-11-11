// API client for API Resources and Quick Actions

import { getClient } from './client'
import { getApiErrorMessage, isApiErrorCode } from './errors'
import type {
  ApiResource,
  ApiResourceAuthType,
  AuthFlowStep,
  CreateApiResourceRequest,
  UpdateApiResourceRequest,
  QuickAction,
  CreateQuickActionRequest,
  UpdateQuickActionRequest,
  QuickActionResult,
  ExecuteInlineRequest,
} from '../types/quickAction'

// Re-export types for convenience
export type { QuickAction, QuickActionResult } from '../types/quickAction'

// === API Resources ===

export async function listApiResources(): Promise<ApiResource[]> {
  const { data } = await getClient().http.get('/api-resources')
  return data
}

export async function getApiResource(id: string): Promise<ApiResource> {
  const { data } = await getClient().http.get(`/api-resources/${id}`)
  return data
}

export async function createApiResource(req: CreateApiResourceRequest): Promise<ApiResource> {
  try {
    const { data } = await getClient().http.post('/api-resources', req)
    return data
  } catch (err: unknown) {
    if (isApiErrorCode(err, 'VAULT_LOCKED')) {
      throw new Error('Vault is locked. Go to Settings → Security to unlock with your master password.')
    }
    throw new Error(getApiErrorMessage(err, 'Failed to create API resource'))
  }
}

export async function updateApiResource(id: string, req: UpdateApiResourceRequest): Promise<void> {
  await getClient().http.put(`/api-resources/${id}`, req)
}

export async function deleteApiResource(id: string): Promise<void> {
  await getClient().http.delete(`/api-resources/${id}`)
}

export async function testApiResource(id: string): Promise<QuickActionResult> {
  const { data } = await getClient().http.post(`/api-resources/${id}/test`)
  return data
}

/**
 * Test an API resource using in-progress form state — no save required.
 * Backend reconstructs an ephemeral client from the supplied resource +
 * credentials and hits resource.test_path (defaults to /).
 */
export async function testApiResourceInline(
  resource: ApiResource,
  credentials?: { token?: string; username?: string; password?: string }
): Promise<QuickActionResult> {
  const { data } = await getClient().http.post('/api-resources/test-inline', {
    resource,
    credentials: credentials ?? null,
  })
  return data
}

export interface AuthStepTestResult {
  success: boolean
  status_code: number
  url: string
  response_preview?: string | null
  extracted_value?: string | null
  store_as: string
  error?: string | null
  duration_ms: number
}

/**
 * Run a single auth-flow step in isolation against a saved resource. Returns
 * the request URL, response preview, extracted value, and any error so the
 * user can debug each step independently.
 */
export async function testAuthFlowStep(
  resourceId: string,
  stepIndex: number,
  variables: Record<string, string> = {},
): Promise<AuthStepTestResult> {
  const { data } = await getClient().http.post(
    `/api-resources/${resourceId}/auth-flow/${stepIndex}/test`,
    { variables },
  )
  return data
}

/** Shape sent to the inline test endpoint when the resource hasn't been saved
 *  yet (or has unsaved edits). The backend rebuilds an in-memory resource
 *  from this and runs the chosen step against it. */
export interface InlineApiResourceForTest {
  id?: string
  name: string
  base_url: string
  auth_type: ApiResourceAuthType
  auth_header_name?: string | null
  auth_header_prefix?: string | null
  auth_flow?: AuthFlowStep[] | null
  default_headers?: Record<string, string>
  custom_headers?: Array<{ name: string; value: string }>
  verify_ssl?: boolean
  timeout_secs?: number
  has_credentials?: boolean
}

/**
 * Run a single auth-flow step against an in-flight (unsaved or edited)
 * resource configuration. Lets the user debug the flow without first
 * saving + reopening the dialog.
 */
export async function testAuthFlowStepInline(
  resource: InlineApiResourceForTest,
  stepIndex: number,
  credentials?: { token?: string; username?: string; password?: string },
  variables: Record<string, string> = {},
): Promise<AuthStepTestResult> {
  const now = new Date().toISOString()
  const { data } = await getClient().http.post('/api-resources/test-step-inline', {
    resource: {
      id: resource.id || 'inline-test',
      name: resource.name,
      base_url: resource.base_url,
      auth_type: resource.auth_type,
      auth_header_name: resource.auth_header_name ?? null,
      auth_header_prefix: resource.auth_header_prefix ?? null,
      auth_flow: resource.auth_flow ?? null,
      default_headers: resource.default_headers ?? {},
      custom_headers: resource.custom_headers ?? [],
      verify_ssl: resource.verify_ssl ?? true,
      timeout_secs: resource.timeout_secs ?? 30,
      has_credentials: !!credentials,
      created_at: now,
      updated_at: now,
    },
    credentials: credentials ?? null,
    step_index: stepIndex,
    variables,
  })
  return data
}

// === Quick Actions ===

export async function listQuickActions(): Promise<QuickAction[]> {
  const { data } = await getClient().http.get('/quick-actions')
  return data
}

export async function getQuickAction(id: string): Promise<QuickAction> {
  const { data } = await getClient().http.get(`/quick-actions/${id}`)
  return data
}

export async function createQuickAction(req: CreateQuickActionRequest): Promise<QuickAction> {
  const { data } = await getClient().http.post('/quick-actions', req)
  return data
}

export async function updateQuickAction(id: string, req: UpdateQuickActionRequest): Promise<void> {
  await getClient().http.put(`/quick-actions/${id}`, req)
}

export async function deleteQuickAction(id: string): Promise<void> {
  await getClient().http.delete(`/quick-actions/${id}`)
}

export async function executeQuickAction(
  id: string,
  variables?: Record<string, string>,
): Promise<QuickActionResult> {
  const body = { variables: variables && Object.keys(variables).length > 0 ? variables : {} }
  const { data } = await getClient().http.post(`/quick-actions/${id}/execute`, body)
  return data
}

export async function executeInlineQuickAction(req: ExecuteInlineRequest): Promise<QuickActionResult> {
  const { data } = await getClient().http.post('/quick-actions/execute-inline', req)
  return data
}
