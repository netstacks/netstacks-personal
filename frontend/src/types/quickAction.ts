// Types for API Resources and Quick Actions

export type ApiResourceAuthType = 'none' | 'bearer_token' | 'basic' | 'api_key_header' | 'custom_header' | 'multi_step'

export interface AuthFlowStep {
  method: string
  path: string
  body?: string
  /** Per-step request headers (templated). */
  headers?: Record<string, string>
  /** When true, sends `Authorization: Basic base64(user:pass)` from resource creds. */
  use_basic_auth?: boolean
  extract_path: string
  store_as: string
}

export interface ApiResource {
  id: string
  name: string
  base_url: string
  auth_type: ApiResourceAuthType
  auth_header_name?: string | null
  auth_header_prefix?: string | null
  auth_flow?: AuthFlowStep[] | null
  default_headers: Record<string, string>
  custom_headers?: Array<{name: string, value: string}>
  verify_ssl: boolean
  timeout_secs: number
  has_credentials: boolean
  test_path?: string | null
  created_at: string
  updated_at: string
}

export interface CreateApiResourceRequest {
  name: string
  base_url: string
  auth_type?: ApiResourceAuthType
  auth_token?: string
  auth_username?: string
  auth_password?: string
  auth_header_name?: string
  auth_header_prefix?: string
  auth_flow?: AuthFlowStep[]
  default_headers?: Record<string, string>
  custom_headers?: Array<{name: string, value: string}>
  verify_ssl?: boolean
  timeout_secs?: number
  test_path?: string | null
}

export interface UpdateApiResourceRequest {
  name?: string
  base_url?: string
  auth_type?: ApiResourceAuthType
  auth_token?: string
  auth_username?: string
  auth_password?: string
  auth_header_name?: string
  auth_header_prefix?: string
  auth_flow?: AuthFlowStep[]
  default_headers?: Record<string, string>
  custom_headers?: Array<{name: string, value: string}>
  verify_ssl?: boolean
  timeout_secs?: number
  test_path?: string | null
}

export interface QuickAction {
  id: string
  name: string
  description?: string | null
  api_resource_id: string
  method: string
  path: string
  headers: Record<string, string>
  body?: string | null
  json_extract_path?: string | null
  icon?: string | null
  color?: string | null
  sort_order: number
  category?: string | null
  created_at: string
  updated_at: string
}

export interface CreateQuickActionRequest {
  name: string
  description?: string
  api_resource_id: string
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string
  json_extract_path?: string
  icon?: string
  color?: string
  sort_order?: number
  category?: string
}

export interface UpdateQuickActionRequest {
  name?: string
  description?: string
  api_resource_id?: string
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string
  json_extract_path?: string
  icon?: string
  color?: string
  sort_order?: number
  category?: string
}

export interface QuickActionResult {
  success: boolean
  status_code: number
  extracted_value?: unknown
  raw_body?: unknown
  error?: string | null
  duration_ms: number
  /** Final URL the request was sent to (after variable substitution). */
  sent_url?: string | null
  /** Headers actually sent on the wire; sensitive values redacted to last 4 chars. */
  sent_headers?: Array<[string, string]> | null
  /** Non-fatal advisory: the call succeeded but didn't validate a real endpoint
   *  (e.g. only the base URL was reached because no Test Path is set). Rendered
   *  as a warning (amber) instead of success (green). */
  warning?: string | null
}

export interface ExecuteInlineRequest {
  api_resource_id: string
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
  json_extract_path?: string
  /** Test-time template variables — backend uses these for any {{var}} that
      isn't already substituted client-side (e.g. inside resource headers). */
  variables?: Record<string, string>
}
