/**
 * Compiles hostname strip patterns into RegExp objects.
 * @param patterns - Array of regex pattern strings
 * @returns Object with valid RegExp array and invalid pattern details
 */
export function compileStripPatterns(patterns: string[]): {
  valid: RegExp[]
  invalid: { pattern: string; error: string }[]
} {
  const valid: RegExp[] = []
  const invalid: { pattern: string; error: string }[] = []

  for (const p of patterns) {
    try {
      valid.push(new RegExp(p, 'gi'))
    } catch (e) {
      invalid.push({
        pattern: p,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }

  return { valid, invalid }
}

/**
 * Strips hostname patterns from a name.
 * @param name - The hostname to strip
 * @param patterns - Array of regex patterns (strings or RegExp objects)
 * @param enabled - Whether stripping is enabled
 * @returns Stripped hostname, or original if result would be empty
 */
export function stripHostname(
  name: string,
  patterns: string[] | RegExp[],
  enabled: boolean
): string {
  if (!enabled || !name.trim()) {
    return name
  }

  let result = name

  // Compile string patterns, skip invalid ones
  const regexes: RegExp[] = []
  for (const p of patterns) {
    if (p instanceof RegExp) {
      regexes.push(p)
    } else {
      try {
        regexes.push(new RegExp(p, 'gi'))
      } catch {
        // Skip invalid patterns without throwing
      }
    }
  }

  // Apply each regex in order
  for (const re of regexes) {
    result = result.replace(re, '')
  }

  // Trim: collapse repeated dots, strip leading/trailing dots and whitespace
  result = result
    .replace(/\.{2,}/g, '.')
    .replace(/^\.*/, '')
    .replace(/\.*$/, '')
    .trim()

  // If result is empty/whitespace, return original
  return result.trim() ? result : name
}

/**
 * Resolves a hostname input to its full form from a list of candidates.
 * @param input - The hostname to resolve (may be stripped or full)
 * @param candidates - Array of full hostnames to search
 * @param patterns - Strip patterns to apply when matching
 * @param enabled - Whether stripping is enabled
 * @returns Full hostname if match found, undefined otherwise
 */
export function resolveFullHostname(
  input: string,
  candidates: string[],
  patterns: string[] | RegExp[],
  enabled: boolean
): string | undefined {
  const inputLower = input.toLowerCase()

  for (const candidate of candidates) {
    // Exact match (case-insensitive)
    if (candidate.toLowerCase() === inputLower) {
      return candidate
    }

    // Stripped match
    const stripped = stripHostname(candidate, patterns, enabled)
    if (stripped.toLowerCase() === inputLower) {
      return candidate
    }
  }

  return undefined
}
