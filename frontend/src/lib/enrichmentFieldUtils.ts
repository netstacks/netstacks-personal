/**
 * Parsing/formatting helpers for the enrichment source editor's test explorer.
 * Ported from netstacks-vsce/src/webview/settings.ts — these power the JSON
 * tree, field auto-detection, live preview, and JSONPath tester.
 */

import { JSONPath } from 'jsonpath-plus'

export const ENRICHMENT_FIELD_FORMATS = ['string', 'datetime', 'uptime', 'bytes', 'status_pill'] as const

/** Humanize a snake_case / camelCase / dotted key into a Title Case label. */
export function humanizeKey(key: string): string {
  const last = key.split(/[.[\]]/).filter(Boolean).pop() ?? key
  return last
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Auto-detect the best format for a leaf value. Returns one of the field
 * formats, plus an optional `badge` (ip / mac / url) for the tree display
 * (those collapse to 'string' for the actual format dropdown).
 */
export function detectFormat(value: unknown): { fmt: string; badge?: string } {
  if (value === null || value === undefined) return { fmt: 'string' }
  if (typeof value === 'number') {
    if (value > 1_000_000_000 && value < 4_000_000_000) return { fmt: 'datetime', badge: 'datetime' } // unix seconds
    if (value > 1_000_000) return { fmt: 'bytes', badge: 'bytes' }
    return { fmt: 'string' }
  }
  if (typeof value !== 'string') return { fmt: 'string' }
  const s = value.trim()
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return { fmt: 'datetime', badge: 'datetime' }
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(s)) return { fmt: 'string', badge: 'ip' }
  if (/^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,}/i.test(s) && s.includes(':') && !s.startsWith('http')) return { fmt: 'string', badge: 'ip' }
  if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(s)) return { fmt: 'string', badge: 'mac' }
  if (/^([0-9a-f]{4}\.){2}[0-9a-f]{4}$/i.test(s)) return { fmt: 'string', badge: 'mac' }
  if (/^https?:\/\//i.test(s)) return { fmt: 'string', badge: 'url' }
  if (/^\d+d\s*\d+h/i.test(s) || /^P\d+/.test(s)) return { fmt: 'uptime', badge: 'uptime' }
  return { fmt: 'string' }
}

/**
 * Walk a JSON value by either a dotted path (`ips.0.name`, `ips[0].name`) OR a
 * JSONPath expression (`$.ips[?(@.router_name=='X')].name`). Auto-detects by
 * the leading `$`. Returns the single matched value (or first match for array
 * results) — matching the hover popup's "first hit" semantics.
 */
export function walkJsonPath(value: unknown, path: string): unknown {
  if (!path) return value
  if (path.trim().startsWith('$')) {
    try {
      const result = JSONPath({ path, json: value as object, wrap: true }) as unknown[]
      if (!Array.isArray(result) || result.length === 0) return undefined
      return result.length === 1 ? result[0] : result
    } catch {
      return undefined
    }
  }
  const normalized = path
    .replace(/\[/g, '.')
    .replace(/\]/g, '')
    .split('.')
    .filter((s) => s.length > 0)
  let cur: unknown = value
  for (const p of normalized) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const i = parseInt(p, 10)
      if (Number.isNaN(i)) return undefined
      cur = cur[i]
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return cur
}

/**
 * Substitute placeholders, mirroring the agent's substitute_template:
 *   {token}, {token_url}, {session_host}, {sessions_host} (alias),
 *   {session_host_ip}, {session_name}.
 */
export function substituteTemplateVars(input: string, vars: Record<string, string>): string {
  return input.replace(
    /\{(token_url|token|session_host_ip|session_host|sessions_host|session_name)\}/g,
    (_m, k) => {
      if (k === 'sessions_host') return vars.session_host ?? ''
      return vars[k] ?? ''
    },
  )
}

/**
 * Format a value the way the hover popup would — used by the live preview.
 * Arrays (JSONPath multi-match) render as a comma-joined list.
 */
export function formatPreviewValue(raw: unknown, fmt: string): string {
  if (raw === null || raw === undefined) return '—'
  if (Array.isArray(raw)) {
    if (raw.length === 0) return '—'
    return raw.map((v) => formatPreviewValue(v, fmt)).filter((s) => s !== '—').join(', ') || '—'
  }
  if (fmt === 'datetime') {
    const d = new Date(raw as string | number)
    if (!isNaN(d.getTime())) {
      const diff = (Date.now() - d.getTime()) / 1000
      if (diff < 60) return `${Math.round(diff)}s ago`
      if (diff < 3600) return `${Math.round(diff / 60)}m ago`
      if (diff < 86400) return `${Math.round(diff / 3600)}h ago`
      return `${Math.round(diff / 86400)}d ago`
    }
  }
  if (fmt === 'bytes' && typeof raw === 'number') {
    if (raw < 1024) return `${raw} B`
    if (raw < 1048576) return `${(raw / 1024).toFixed(1)} KB`
    if (raw < 1073741824) return `${(raw / 1048576).toFixed(1)} MB`
    return `${(raw / 1073741824).toFixed(1)} GB`
  }
  if (typeof raw === 'object') return JSON.stringify(raw)
  return String(raw)
}
