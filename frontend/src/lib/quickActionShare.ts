/**
 * Share / import of saved API requests (Quick Actions) as a JSON file.
 *
 * The file carries the requests plus the *shape* of the API resources they
 * belong to (name, base URL, auth type, headers) so the receiver can rebuild
 * them, but never credentials: those stay in the sender's vault, and the
 * importer adds their own.
 */
import type { ApiResource, ApiResourceAuthType, AuthFlowStep, CreateApiResourceRequest, CreateQuickActionRequest, QuickAction } from '../types/quickAction'

export const SHARE_FORMAT = 'netstacks-api-requests'
export const SHARE_VERSION = 1

export interface SharedResource {
  /** Stable key requests refer to; the resource name at export time. */
  key: string
  name: string
  base_url: string
  auth_type: ApiResourceAuthType
  auth_header_name?: string | null
  auth_header_prefix?: string | null
  /** Auth flow steps are templates (no secrets); `{{vars}}` are filled at run time. */
  auth_flow?: AuthFlowStep[] | null
  default_headers?: Record<string, string>
  custom_headers?: Array<{ name: string; value: string }>
  verify_ssl?: boolean
  timeout_secs?: number
  test_path?: string | null
}

export interface SharedRequest {
  resource: string
  name: string
  description?: string | null
  method: string
  path: string
  headers: Record<string, string>
  body?: string | null
  json_extract_path?: string | null
  icon?: string | null
  color?: string | null
  category?: string | null
}

export interface ShareFile {
  format: typeof SHARE_FORMAT
  version: number
  exported_at: string
  resources: SharedResource[]
  requests: SharedRequest[]
}

/** Header names whose values are secrets and must never leave the machine. */
const SECRET_HEADER_RE = /^(authorization|x-api-key|api-key|x-auth-token|cookie|proxy-authorization)$/i

function scrubHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    // keep templated values ({{token}}), drop literal secrets
    out[k] = SECRET_HEADER_RE.test(k) && !/\{\{.+\}\}/.test(v) ? '' : v
  }
  return out
}

export function buildShareFile(actions: QuickAction[], resources: ApiResource[]): ShareFile {
  const used = new Map<string, ApiResource>()
  for (const a of actions) {
    const r = resources.find((x) => x.id === a.api_resource_id)
    if (r) used.set(r.id, r)
  }
  const keyOf = (id: string) => used.get(id)?.name ?? id
  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    exported_at: new Date().toISOString(),
    resources: [...used.values()].map((r) => ({
      key: r.name,
      name: r.name,
      base_url: r.base_url,
      auth_type: r.auth_type,
      auth_header_name: r.auth_header_name ?? null,
      auth_header_prefix: r.auth_header_prefix ?? null,
      auth_flow: r.auth_flow ?? null,
      default_headers: scrubHeaders(r.default_headers),
      custom_headers: (r.custom_headers ?? []).map((h) => ({ name: h.name, value: SECRET_HEADER_RE.test(h.name) ? '' : h.value })),
      verify_ssl: r.verify_ssl,
      timeout_secs: r.timeout_secs,
      test_path: r.test_path ?? null,
    })),
    requests: actions.map((a) => ({
      resource: keyOf(a.api_resource_id),
      name: a.name,
      description: a.description ?? null,
      method: a.method,
      path: a.path,
      headers: scrubHeaders(a.headers),
      body: a.body ?? null,
      json_extract_path: a.json_extract_path ?? null,
      icon: a.icon ?? null,
      color: a.color ?? null,
      category: a.category ?? null,
    })),
  }
}

export function serializeShareFile(file: ShareFile): string {
  return JSON.stringify(file, null, 2)
}

export function shareFileName(actions: QuickAction[]): string {
  const stamp = new Date().toISOString().slice(0, 10)
  const base = actions.length === 1 ? actions[0].name.replace(/[^\w.-]+/g, '_').slice(0, 40) : `${actions.length}-requests`
  return `netstacks-api-${base}-${stamp}.json`
}

/** Parse and validate a share file; throws with a readable message. */
export function parseShareFile(text: string): ShareFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Not valid JSON')
  }
  if (!raw || typeof raw !== 'object') throw new Error('Not a NetStacks API request file')
  const obj = raw as Record<string, unknown>
  if (obj.format !== SHARE_FORMAT) throw new Error('Not a NetStacks API request file (wrong format)')
  if (typeof obj.version !== 'number' || obj.version > SHARE_VERSION) {
    throw new Error(`Unsupported file version ${String(obj.version)}; update NetStacks to import it`)
  }
  const resources = Array.isArray(obj.resources) ? (obj.resources as SharedResource[]) : []
  const requests = Array.isArray(obj.requests) ? (obj.requests as SharedRequest[]) : []
  for (const r of resources) {
    if (typeof r.key !== 'string' || typeof r.name !== 'string' || typeof r.base_url !== 'string') {
      throw new Error('A resource entry is missing key, name or base_url')
    }
  }
  for (const q of requests) {
    if (typeof q.name !== 'string' || typeof q.method !== 'string' || typeof q.path !== 'string' || typeof q.resource !== 'string') {
      throw new Error(`Request "${String(q.name ?? '?')}" is missing name, method, path or resource`)
    }
  }
  if (requests.length === 0) throw new Error('The file contains no requests')
  return { format: SHARE_FORMAT, version: obj.version, exported_at: String(obj.exported_at ?? ''), resources, requests }
}

export interface ImportPlan {
  /** Resources to create (not matched by name or base URL). */
  createResources: Array<{ key: string; request: CreateApiResourceRequest }>
  /** For every request: which existing resource id (or `create:<key>`) it lands on. */
  requests: Array<{ shared: SharedRequest; resourceRef: string; name: string; skipped?: string }>
  matchedResources: Array<{ key: string; resourceId: string; how: 'name' | 'base_url' }>
}

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * Decide where each shared request goes. Resources are matched by name, then
 * by base URL; anything else is created (without credentials). Requests that
 * already exist with the same name under the target resource and the same
 * method+path are skipped; a same-name request with different content is
 * imported under "<name> (imported)".
 */
export function planImport(file: ShareFile, existingResources: ApiResource[], existingActions: QuickAction[]): ImportPlan {
  const plan: ImportPlan = { createResources: [], requests: [], matchedResources: [] }
  const refByKey = new Map<string, string>()
  const byName = new Map(existingResources.map((r) => [r.name.trim().toLowerCase(), r]))
  const byUrl = new Map(existingResources.map((r) => [normalizeUrl(r.base_url), r]))

  for (const sr of file.resources) {
    const m = byName.get(sr.name.trim().toLowerCase()) ?? byUrl.get(normalizeUrl(sr.base_url))
    if (m) {
      refByKey.set(sr.key, m.id)
      plan.matchedResources.push({ key: sr.key, resourceId: m.id, how: byName.has(sr.name.trim().toLowerCase()) ? 'name' : 'base_url' })
    } else {
      const ref = `create:${sr.key}`
      refByKey.set(sr.key, ref)
      plan.createResources.push({
        key: sr.key,
        request: {
          name: sr.name,
          base_url: sr.base_url,
          auth_type: sr.auth_type ?? 'none',
          auth_header_name: sr.auth_header_name ?? undefined,
          auth_header_prefix: sr.auth_header_prefix ?? undefined,
          auth_flow: sr.auth_flow ?? undefined,
          default_headers: sr.default_headers ?? {},
          custom_headers: sr.custom_headers ?? [],
          verify_ssl: sr.verify_ssl ?? true,
          timeout_secs: sr.timeout_secs ?? 30,
          test_path: sr.test_path ?? undefined,
        },
      })
    }
  }

  for (const q of file.requests) {
    const ref = refByKey.get(q.resource)
    if (!ref) {
      plan.requests.push({ shared: q, resourceRef: '', name: q.name, skipped: `unknown resource "${q.resource}"` })
      continue
    }
    const siblings = ref.startsWith('create:') ? [] : existingActions.filter((a) => a.api_resource_id === ref)
    const sameName = siblings.filter((a) => a.name.trim().toLowerCase() === q.name.trim().toLowerCase())
    const identical = sameName.some((a) => a.method === q.method && a.path === q.path && (a.body ?? '') === (q.body ?? ''))
    if (identical) {
      plan.requests.push({ shared: q, resourceRef: ref, name: q.name, skipped: 'already exists' })
      continue
    }
    plan.requests.push({ shared: q, resourceRef: ref, name: sameName.length ? `${q.name} (imported)` : q.name })
  }
  return plan
}

export function toCreateRequest(item: ImportPlan['requests'][number], resourceId: string): CreateQuickActionRequest {
  const q = item.shared
  return {
    name: item.name,
    description: q.description ?? undefined,
    api_resource_id: resourceId,
    method: q.method,
    path: q.path,
    headers: q.headers ?? {},
    body: q.body ?? undefined,
    json_extract_path: q.json_extract_path ?? undefined,
    icon: q.icon ?? undefined,
    color: q.color ?? undefined,
    category: q.category ?? undefined,
  }
}
