/** Pure helpers for the paste preview (kept out of the component file for fast refresh). */

/** Make control characters visible: ␍ for CR, → for tab, · for trailing spaces. */
export function visualize(line: string): string {
  return line
    .replace(/\r/g, '␍')
    .replace(/\t/g, '→')
    .replace(/ +$/, (m) => '·'.repeat(m.length))
}

/** Indices of result lines that do not appear in the original (multiset difference). */
export function addedLines(original: string[], result: string[]): Set<number> {
  const remaining = new Map<string, number>()
  for (const l of original) remaining.set(l, (remaining.get(l) ?? 0) + 1)
  const added = new Set<number>()
  result.forEach((l, i) => {
    const n = remaining.get(l) ?? 0
    if (n > 0) remaining.set(l, n - 1)
    else added.add(i)
  })
  return added
}
