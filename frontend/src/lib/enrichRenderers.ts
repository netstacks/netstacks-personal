/**
 * DOM renderers for the enrichment hover popup.
 *
 * All sources go through `renderFromMeta`, which is driven by the
 * `_meta.fields` metadata the agent attaches to each source result.
 * `SOURCE_META` maps source names to display labels and chip colors.
 */

type Blob = Record<string, unknown> | null | undefined;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function row(label: string, value: string | null | undefined): HTMLElement | null {
  if (value === null || value === undefined || value === '') return null;
  const wrap = el('div', 'ns-enrich-row');
  wrap.appendChild(el('span', 'ns-enrich-row-label', label));
  wrap.appendChild(el('span', 'ns-enrich-row-value', value));
  return wrap;
}

function statusPill(text: string, kind: 'up' | 'down' | 'warn' | 'info' = 'info'): HTMLElement {
  const pill = el('span', `ns-enrich-pill ns-enrich-pill-${kind}`, text);
  return pill;
}

function asStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Arrays of scalars (e.g. JSONPath $[*].name multi-match result) — render
  // as a comma-separated list. Drop nulls/undefined and stringify primitives.
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const item of v) {
      if (item === null || item === undefined) continue;
      if (typeof item === 'string') parts.push(item);
      else if (typeof item === 'number' || typeof item === 'boolean') parts.push(String(item));
      // Nested objects in an array get JSON-stringified so the user sees
      // *something* (better than silent drop).
      else parts.push(JSON.stringify(item));
    }
    return parts.length > 0 ? parts.join(', ') : null;
  }
  return null;
}

/// Fallback for any source we don't have a custom renderer for — flat
/// key:value list of the top-level scalar fields.
export function renderGeneric(blob: Blob): HTMLElement | null {
  if (!blob) return null;
  const body = el('div', 'ns-enrich-section-body');
  for (const [k, v] of Object.entries(blob)) {
    const s = asStr(v);
    if (s) body.appendChild(row(k, s)!);
  }
  return body.childElementCount > 0 ? body : null;
}

/// Debug fallback — used when a per-source renderer returns null but the
/// blob is non-empty (upstream gave us data, we just don't know how to
/// display it yet). Shows a one-line snippet with an expandable full-JSON
/// view so the user can see what came back and we know what to render.
export function renderRawDebug(blob: Blob): HTMLElement | null {
  if (!blob || (typeof blob === 'object' && Object.keys(blob).length === 0)) return null;
  const json = JSON.stringify(blob, null, 2);
  const oneLine = JSON.stringify(blob);
  const snippet = oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine;

  const body = el('div', 'ns-enrich-section-body');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.className = 'ns-enrich-raw-summary';
  summary.textContent = snippet;
  summary.title = 'Click to expand the full response';
  details.appendChild(summary);
  const pre = el('pre', 'ns-enrich-raw-full');
  pre.textContent = json;
  details.appendChild(pre);
  body.appendChild(details);
  return body;
}

// ── helpers ───────────────────────────────────────────────────────────────

function formatUptime(v: unknown): string | null {
  if (typeof v !== 'number' || v <= 0) return null;
  const days = Math.floor(v / 86400);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(v / 3600);
  if (hours >= 1) return `${hours}h`;
  const mins = Math.floor(v / 60);
  return `${mins}m`;
}

function formatBytes(v: unknown): string | null {
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : NaN);
  if (!Number.isFinite(n) || n < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = n;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(val < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatRelativeTime(v: unknown): string | null {
  // Accepts ISO 8601 strings, unix seconds, or unix millis.
  let d: Date | null = null;
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    if (!isNaN(parsed)) d = new Date(parsed);
  } else if (typeof v === 'number') {
    d = new Date(v < 10_000_000_000 ? v * 1000 : v);  // < ~year 2286 in seconds
  }
  if (!d || isNaN(d.getTime())) return asStr(v);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} days ago`;
  return d.toLocaleDateString();
}

/// Look up a value by key in the agent's picked-fields response. The agent
/// stores picked values under the FLAT dotted key (e.g. blob["a.b.c"] = ...),
/// not as a nested path — so we read the flat key directly. Fall back to a
/// dotted-walk only if the flat key isn't present (covers built-in source
/// responses like dns_ptr where the field name has no dots).
function walkKey(blob: any, key: string): unknown {
  if (blob == null) return null;
  // 1. Flat key lookup — this is the normal path for agent-picked fields
  if (typeof blob === 'object' && !Array.isArray(blob) && Object.prototype.hasOwnProperty.call(blob, key)) {
    return blob[key];
  }
  // 2. Fallback: walk a dotted path (handles built-in sources or raw blobs
  //    where picked_fields weren't applied)
  let cur: any = blob;
  for (const part of key.split('.')) {
    if (cur == null) return null;
    if (Array.isArray(cur)) {
      const idx = parseInt(part, 10);
      if (Number.isNaN(idx)) return null;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = cur[part];
    } else {
      return null;
    }
  }
  return cur;
}

/// Format a value according to the source's configured format hint. Falls
/// through to a generic string conversion if the format doesn't match.
function formatValue(value: unknown, format: string): string | HTMLElement | null {
  switch (format) {
    case 'datetime': return formatRelativeTime(value);
    case 'uptime':   return formatUptime(value);
    case 'bytes':    return formatBytes(value);
    case 'status_pill': {
      const s = asStr(value);
      if (!s) return null;
      const lower = s.toLowerCase();
      const kind: 'up' | 'down' | 'warn' | 'info' =
        lower.includes('up') || lower === 'active' || lower === 'enabled' ? 'up' :
        lower.includes('down') || lower === 'disabled' || lower === 'failed' ? 'down' :
        lower === 'warning' || lower === 'degraded' ? 'warn' : 'info';
      return statusPill(s, kind);
    }
    case 'string':
    default: return asStr(value);
  }
}

/// Generic renderer driven by the `_meta.fields` metadata the agent attaches
/// to every source result (Phase 5). Each entry is `{key, label, format}`.
/// Walks the dotted-path key, formats the value, emits a row. Falls back to
/// the raw-debug view when no picked_fields are configured for this source
/// (typically: a brand-new custom source the user hasn't field-picked yet).
///
/// When falling back to raw-debug, prefer `_raw` (the agent's snapshot of
/// the actual response, without our `_meta`/`_raw` noise) over the full
/// blob — otherwise the user sees a JSON dump of just the meta schema.
export function renderFromMeta(blob: Blob): HTMLElement | null {
  if (!blob) return null;
  const meta = (blob as any)?._meta?.fields as Array<{ key: string; label: string; format?: string }> | undefined;
  if (!meta || meta.length === 0) return renderRawDebug(rawOf(blob));

  const body = el('div', 'ns-enrich-section-body');
  for (const f of meta) {
    const raw = walkKey(blob, f.key) ?? walkKey((blob as any)._raw, f.key);
    if (raw == null || raw === '') continue;
    const formatted = formatValue(raw, f.format ?? 'string');
    if (formatted == null) continue;
    if (typeof formatted === 'string') {
      body.appendChild(row(f.label, formatted)!);
    } else {
      // formatted is an HTMLElement (e.g. status_pill)
      const wrap = el('div', 'ns-enrich-row');
      wrap.appendChild(el('span', 'ns-enrich-row-label', f.label));
      const valSpan = el('span', 'ns-enrich-row-value');
      valSpan.appendChild(formatted);
      wrap.appendChild(valSpan);
      body.appendChild(wrap);
    }
  }
  return body.childElementCount > 0 ? body : renderRawDebug(rawOf(blob));
}

/// Return the agent-attached `_raw` snapshot if present (the actual API
/// response, no metadata). Falls back to the blob itself for older agents.
function rawOf(blob: Blob): Blob {
  if (blob && typeof blob === 'object' && '_raw' in (blob as any) && (blob as any)._raw != null) {
    return (blob as any)._raw;
  }
  return blob;
}

// ── registry ──────────────────────────────────────────────────────────────

type Renderer = (blob: Blob) => HTMLElement | null;

/// Returns the renderer for a source name. All sources use renderFromMeta,
/// driven by the `_meta.fields` the agent ships with each result.
export function rendererFor(_sourceName: string): Renderer {
  return renderFromMeta;
}

export interface SourceMeta {
  label: string;
  tagClass: string; // CSS class for the source chip
}

export const SOURCE_META: Record<string, SourceMeta> = {
  dns_ptr: { label: 'DNS', tagClass: 'ns-enrich-tag-builtin' },
  oui_vendor: { label: 'OUI', tagClass: 'ns-enrich-tag-builtin' },
  crawler_device: { label: 'Crawler', tagClass: 'ns-enrich-tag-crawler' },
  crawler_mac: { label: 'Crawler', tagClass: 'ns-enrich-tag-crawler' },
  crawler_port: { label: 'Crawler Port', tagClass: 'ns-enrich-tag-crawler' },
  crawler_neighbor: { label: 'CDP/LLDP Neighbor', tagClass: 'ns-enrich-tag-crawler' },
  netbox_ip: { label: 'NetBox IPAM', tagClass: 'ns-enrich-tag-netbox' },
  netbox_interface: { label: 'NetBox Interface', tagClass: 'ns-enrich-tag-netbox' },
};

export function metaFor(source: string): SourceMeta {
  return SOURCE_META[source] || { label: source, tagClass: 'ns-enrich-tag-default' };
}
