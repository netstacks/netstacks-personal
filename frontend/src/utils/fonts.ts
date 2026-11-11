/** The platform monospace stack from the --font-family-mono token, for canvas/Monaco consumers that can't use var(). */
export function platformMonoFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-family-mono').trim()
}
