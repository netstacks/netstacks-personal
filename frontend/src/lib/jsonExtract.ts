/**
 * Client-side twin of the agent's `quick_actions::json_extract`.
 *
 * Used to preview an extract path against the last response while the user
 * types, without another API call. Keep the grammar identical to the Rust
 * side: dot keys, `[n]` indexes, `["key"]` quoted keys and `[*]` fan-out over
 * arrays. Whitespace around the path and around keys is ignored.
 */

type PathSegment =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'all' }

export function parsePathSegments(path: string): PathSegment[] {
  const segments: PathSegment[] = []
  let current = ''
  const pushKey = () => {
    const key = current.trim()
    if (key) segments.push({ kind: 'key', key })
    current = ''
  }
  const chars = path.trim()
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]
    if (ch === '.') {
      pushKey()
      i++
    } else if (ch === '[') {
      pushKey()
      i++
      let inner = ''
      while (i < chars.length && chars[i] !== ']') {
        inner += chars[i]
        i++
      }
      i++ // consume ']'
      const trimmed = inner.trim()
      if (trimmed === '*') {
        segments.push({ kind: 'all' })
      } else if (/^\d+$/.test(trimmed)) {
        segments.push({ kind: 'index', index: Number(trimmed) })
      } else {
        const key = trimmed.replace(/^["']|["']$/g, '')
        if (key) segments.push({ kind: 'key', key })
      }
    } else {
      current += ch
      i++
    }
  }
  pushKey()
  return segments
}

function walk(value: unknown, segments: PathSegment[]): unknown {
  if (segments.length === 0) return value
  const [head, ...rest] = segments
  if (head.kind === 'key') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const obj = value as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(obj, head.key)) return undefined
    return walk(obj[head.key], rest)
  }
  if (head.kind === 'index') {
    if (!Array.isArray(value) || head.index >= value.length) return undefined
    return walk(value[head.index], rest)
  }
  if (!Array.isArray(value)) return undefined
  return value.map((el) => walk(el, rest)).filter((v) => v !== undefined)
}

/** Returns `undefined` when the path does not resolve (a JSON `null` is a hit). */
export function jsonExtract(value: unknown, path: string): unknown {
  if (!path.trim()) return undefined
  return walk(value, parsePathSegments(path))
}

/** Human-readable form of an extracted value for the preview row. */
export function formatExtracted(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
