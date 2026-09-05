/**
 * Pure helpers over clip text: line-ending classification and size stats.
 * Kept free of React/network so they are trivially unit-tested.
 */
import type { LineEnding } from '../types/clip'
import { formatBytes } from './enrichmentHelpers'

export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length
  const bareCr = (text.match(/\r(?!\n)/g) ?? []).length
  const kinds = [crlf > 0, bareLf > 0, bareCr > 0].filter(Boolean).length
  if (kinds === 0) return 'none'
  if (kinds > 1) return 'mixed'
  if (crlf > 0) return 'crlf'
  if (bareCr > 0) return 'cr'
  return 'lf'
}

/** Number of lines as a terminal would paste them (a trailing newline does not add a line). */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  const normalized = text.replace(/\r\n|\r/g, '\n')
  const parts = normalized.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** First non-empty line, trimmed, for list rows and tab titles. */
export function firstLine(text: string, max = 120): string {
  const line = text.replace(/\r\n|\r/g, '\n').split('\n').find((l) => l.trim().length > 0) ?? ''
  const t = line.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function formatClipSize(bytes: number, lines: number): string {
  return `${lines} ${lines === 1 ? 'line' : 'lines'} · ${formatBytes(bytes)}`
}
