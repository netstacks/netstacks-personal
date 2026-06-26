// Utilities for extracting and managing template variables in Quick Actions

/** Built-in variable names that are resolved by the backend (never prompted for) */
const BUILT_IN_VARS = new Set(['username', 'password'])

/**
 * Scan path, headers, and body for {{variable}} placeholders.
 * Returns deduplicated list excluding built-in vars and auth flow store_as names.
 */
export function extractActionVariables(
  path: string,
  headers: Record<string, string>,
  body?: string | null,
  authFlowStoreAs?: string[],
): string[] {
  const exclude = new Set([...BUILT_IN_VARS, ...(authFlowStoreAs ?? [])])
  const found = new Set<string>()
  const re = /\{\{(\w+)\}\}/g

  const scan = (text: string) => {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (!exclude.has(m[1])) found.add(m[1])
    }
  }

  scan(path)
  for (const v of Object.values(headers)) scan(v)
  if (body) scan(body)

  return [...found]
}

const STORAGE_KEY_PREFIX = 'qa-vars-'

/** Get last-used variable values for an action */
export function getRememberedValues(actionId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${actionId}`)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Save variable values for an action */
export function rememberValues(actionId: string, values: Record<string, string>): void {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${actionId}`, JSON.stringify(values))
  } catch {
    // ignore quota errors
  }
}
