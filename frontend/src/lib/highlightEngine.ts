import { logger } from './logger'
/**
 * HighlightEngine - High-performance keyword highlighting for xterm.js terminals
 *
 * Uses a diff-based decoration cache to avoid destroy-and-recreate overhead.
 * Three scan paths optimize for different triggers:
 *   - Full scan (rules change): diff all viewport matches against cache
 *   - Incremental scan (new data): scan only new lines, keep existing decorations
 *   - Viewport scan (scroll): scan only newly-visible lines
 *
 * A 50ms trailing-edge throttle ensures highlights appear DURING output,
 * not just after it stops.
 */

import type { Terminal, IDecoration, IMarker } from '@xterm/xterm'
import type { HighlightRule } from '../api/highlightRules'
import { getEffectiveHighlightRules, listHighlightRules } from '../api/highlightRules'

export interface Match {
  rule: HighlightRule
  line: number
  viewportRow: number
  startColumn: number
  endColumn: number
}

interface MatchResult {
  start: number
  end: number
}

export interface DetectionRuleExtras {
  detectionType: string
  borderStyle: string
  cursor: string
  tooltipPrefix: string
}

export interface HighlightEngineOptions {
  maxMatchesPerScan?: number
}

const DEFAULT_OPTIONS: Required<HighlightEngineOptions> = {
  maxMatchesPerScan: 500,
}

// Throttle interval — highlights appear within this many ms of data arriving
const THROTTLE_MS = 50

interface DecorationEntry {
  highlightRule: HighlightRule | null
  detectionRule: HighlightRule | null
  absoluteLine: number
  startColumn: number
  endColumn: number
}

interface CachedDecoration {
  decoration: IDecoration
  marker: IMarker
  absoluteLine: number
  startColumn: number
  endColumn: number
  highlightRuleId: string | null
  detectionRuleId: string | null
}

export class HighlightEngine {
  private terminal: Terminal
  private sessionId: string | undefined
  private rules: HighlightRule[] = []
  private adHocDecorations: IDecoration[] = []
  private styleElement: HTMLStyleElement | null = null
  private options: Required<HighlightEngineOptions>
  private destroyed = false

  private compiledPatterns: Map<string, RegExp> = new Map()

  private detectionExtras: Map<string, DetectionRuleExtras> = new Map()
  private detectionRules: HighlightRule[] = []
  private detectionEnabled = false

  // Decoration cache — single source of truth for active decorations
  private decorationCache: Map<string, CachedDecoration> = new Map()

  // Viewport tracking for scroll-delta optimization
  private lastViewportY: number = -1
  private lastViewportRows: number = 0


  // Rules versioning — forces full rescan when rules change
  private rulesVersion: number = 0
  private lastScannedRulesVersion: number = -1

  // Trailing-edge throttle state
  private throttleTimer: number | null = null
  private throttleLastFired: number = 0
  private pendingScanType: 'full' | 'incremental' | 'viewport' | null = null

  // Line content cache to skip unchanged lines during rescans
  private lineContentCache: Map<number, string> = new Map()

  constructor(
    terminal: Terminal,
    sessionId?: string,
    options?: HighlightEngineOptions
  ) {
    this.terminal = terminal
    this.sessionId = sessionId
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  async loadRules(): Promise<void> {
    if (this.destroyed) return

    try {
      if (this.sessionId) {
        this.rules = await getEffectiveHighlightRules(this.sessionId)
      } else {
        this.rules = (await listHighlightRules()).filter(
          r => r.session_id === null && r.enabled
        )
      }
      this.rules = this.rules
        .filter(r => r.enabled)
        .sort((a, b) => a.priority - b.priority)

      this.compilePatterns()
      this.injectStyles()
      this.rulesVersion++
      this.scanBuffer(true)
    } catch (err) {
      console.error('Failed to load highlight rules:', err)
    }
  }

  setRules(rules: HighlightRule[]): void {
    if (this.destroyed) return

    this.rules = rules
      .filter(r => r.enabled)
      .sort((a, b) => a.priority - b.priority)

    this.compilePatterns()
    this.injectStyles()
    this.rulesVersion++
    this.scanBuffer(true)
  }

  setDetectionRules(rules: HighlightRule[], extras: Map<string, DetectionRuleExtras>): void {
    if (this.destroyed) return

    this.detectionRules = rules
      .filter(r => r.enabled)
      .sort((a, b) => a.priority - b.priority)
    this.detectionExtras = extras
    this.detectionEnabled = true

    this.compilePatterns()
    this.injectStyles()
    this.rulesVersion++
    this.scanBuffer(true)
  }

  clearDetectionRules(): void {
    this.detectionRules = []
    this.detectionExtras.clear()
    this.detectionEnabled = false

    this.compilePatterns()
    this.injectStyles()
    this.rulesVersion++
    this.scanBuffer(true)
  }

  // === Public scan API ===

  /**
   * General scan entry point. Routes to the right scan path internally.
   * Pass force=true when rules changed to trigger a full rescan with diff.
   */
  scanBuffer(force: boolean = false): void {
    if (this.destroyed) return
    const hasRules = this.rules.length > 0 || this.detectionRules.length > 0
    if (!hasRules) {
      this.disposeAllDecorations()
      return
    }

    if (force || this.rulesVersion !== this.lastScannedRulesVersion) {
      this.scheduleThrottledScan('full')
    } else {
      this.scheduleThrottledScan('incremental')
    }
  }

  /**
   * Scroll-optimized scan. Throttled to avoid blocking rapid scrolling.
   */
  scanViewport(): void {
    if (this.destroyed) return
    const hasRules = this.rules.length > 0 || this.detectionRules.length > 0
    if (!hasRules) return

    this.scheduleThrottledScan('viewport')
  }

  /**
   * Called from onWriteParsed — triggers incremental scan via throttle.
   */
  notifyDataWritten(): void {
    if (this.destroyed) return
    const hasRules = this.rules.length > 0 || this.detectionRules.length > 0
    if (!hasRules) return

    this.scheduleThrottledScan('incremental')
  }

  // === Throttle ===

  private scheduleThrottledScan(type: 'full' | 'incremental' | 'viewport'): void {
    // Promote pending scan type: full > incremental > viewport
    if (
      this.pendingScanType === null ||
      type === 'full' ||
      (type === 'incremental' && this.pendingScanType === 'viewport')
    ) {
      this.pendingScanType = type
    }

    if (this.throttleTimer !== null) {
      // Timer already pending — scan type may have been promoted above
      return
    }

    const now = performance.now()
    const elapsed = now - this.throttleLastFired
    const delay = Math.max(0, THROTTLE_MS - elapsed)

    this.throttleTimer = window.setTimeout(() => {
      this.throttleTimer = null
      this.throttleLastFired = performance.now()
      const scanType = this.pendingScanType || 'incremental'
      this.pendingScanType = null
      this.executeScan(scanType)
    }, delay)
  }

  private executeScan(type: 'full' | 'incremental' | 'viewport'): void {
    if (this.destroyed) return

    if (type === 'full' || this.rulesVersion !== this.lastScannedRulesVersion) {
      this.performFullScan()
    } else if (type === 'viewport') {
      this.performViewportScan()
    } else {
      this.performIncrementalScan()
    }
  }

  // === Scan implementations ===

  private performFullScan(): void {
    if (this.destroyed) return

    this.lastScannedRulesVersion = this.rulesVersion

    const buffer = this.terminal.buffer.active
    const viewportY = buffer.viewportY
    const rows = this.terminal.rows
    const allRules = [...this.rules, ...this.detectionRules]

    const newMatchMap = this.buildMatchMap(viewportY, rows, allRules)
    this.applyDiff(newMatchMap, false)

    this.lastViewportY = viewportY
    this.lastViewportRows = rows

  }

  private performIncrementalScan(): void {
    if (this.destroyed) return

    const buffer = this.terminal.buffer.active
    const viewportY = buffer.viewportY
    const rows = this.terminal.rows
    const allRules = [...this.rules, ...this.detectionRules]

    // If viewport scrolled since last scan, use viewport scan instead
    if (this.lastViewportY >= 0 && viewportY !== this.lastViewportY) {
      this.performViewportScan()
      return
    }

    // First scan ever — do a full scan
    if (this.lastViewportY < 0) {
      this.performFullScan()
      return
    }

    // Rescan full viewport with diff — skipUnchanged avoids re-running
    // regex on lines whose text content hasn't changed since last scan.
    const newMatchMap = this.buildMatchMap(viewportY, rows, allRules, true)
    this.purgeOffViewportDecorations(viewportY, rows)
    this.applyDiff(newMatchMap, false)


    this.lastViewportY = viewportY
    this.lastViewportRows = rows
  }

  private performViewportScan(): void {
    if (this.destroyed) return

    const buffer = this.terminal.buffer.active
    const viewportY = buffer.viewportY
    const rows = this.terminal.rows

    // Skip if viewport hasn't moved
    if (viewportY === this.lastViewportY && rows === this.lastViewportRows) {
      return
    }

    const allRules = [...this.rules, ...this.detectionRules]
    const oldViewportY = this.lastViewportY
    const oldRows = this.lastViewportRows

    if (oldViewportY < 0) {
      const newMatches = this.buildMatchMap(viewportY, rows, allRules)
      this.applyDiff(newMatches, false)
    } else {
      const oldEnd = oldViewportY + oldRows
      const newEnd = viewportY + rows

      let scanStart: number
      let scanRows: number

      if (viewportY >= oldEnd || newEnd <= oldViewportY) {
        scanStart = viewportY
        scanRows = rows
      } else if (viewportY < oldViewportY) {
        scanStart = viewportY
        scanRows = oldViewportY - viewportY
      } else {
        scanStart = oldEnd
        scanRows = newEnd - oldEnd
      }

      if (scanRows > 0) {
        const newMatches = this.buildMatchMap(scanStart, Math.min(scanRows, rows), allRules)
        this.applyDiff(newMatches, true)
      }

      // Lazy purge: only clean up off-viewport decorations when we've scrolled
      // far enough that the cache could be growing large (> 2x viewport)
      if (this.decorationCache.size > rows * 2) {
        this.purgeOffViewportDecorations(viewportY, rows)
      }
    }

    this.lastViewportY = viewportY
    this.lastViewportRows = rows

  }

  // === Match building ===

  private buildMatchMap(
    startLine: number,
    numLines: number,
    allRules: HighlightRule[],
    skipUnchanged: boolean = false
  ): Map<string, DecorationEntry> {
    const matchMap = new Map<string, DecorationEntry>()
    const buffer = this.terminal.buffer.active
    let totalMatches = 0

    for (let i = 0; i < numLines && totalMatches < this.options.maxMatchesPerScan; i++) {
      const lineIndex = startLine + i
      const line = buffer.getLine(lineIndex)
      if (!line) continue

      const text = line.translateToString(true)
      if (!text.trim()) continue

      // Skip regex matching for lines whose content hasn't changed
      if (skipUnchanged && this.lineContentCache.get(lineIndex) === text) {
        // Re-add existing cache entries for this line to preserve them in diff
        for (const [, cached] of this.decorationCache) {
          if (cached.absoluteLine === lineIndex) {
            matchMap.set(`${lineIndex}:${cached.startColumn}:${cached.endColumn}`, {
              highlightRule: cached.highlightRuleId ? allRules.find(r => r.id === cached.highlightRuleId) || null : null,
              detectionRule: cached.detectionRuleId ? allRules.find(r => r.id === cached.detectionRuleId) || null : null,
              absoluteLine: lineIndex,
              startColumn: cached.startColumn,
              endColumn: cached.endColumn,
            })
          }
        }
        continue
      }

      this.lineContentCache.set(lineIndex, text)

      for (const rule of allRules) {
        const lineMatches = this.matchPattern(text, rule)
        const isDetectionRule = this.detectionExtras.has(rule.id)

        for (const match of lineMatches) {
          if (totalMatches >= this.options.maxMatchesPerScan) break

          const posKey = `${lineIndex}:${match.start}:${match.end}`
          const existing = matchMap.get(posKey)

          if (existing) {
            if (isDetectionRule && !existing.detectionRule) {
              existing.detectionRule = rule
            } else if (!isDetectionRule && !existing.highlightRule) {
              existing.highlightRule = rule
            }
          } else {
            matchMap.set(posKey, {
              highlightRule: isDetectionRule ? null : rule,
              detectionRule: isDetectionRule ? rule : null,
              absoluteLine: lineIndex,
              startColumn: match.start,
              endColumn: match.end,
            })
            totalMatches++
          }
        }
      }
    }

    return matchMap
  }

  // === Diff and decoration management ===

  private makeCacheKey(entry: DecorationEntry): string {
    const hlId = entry.highlightRule?.id || ''
    const detId = entry.detectionRule?.id || ''
    return `${entry.absoluteLine}:${entry.startColumn}:${entry.endColumn}:${hlId}:${detId}`
  }

  private applyDiff(
    newMatches: Map<string, DecorationEntry>,
    mergeMode: boolean
  ): void {
    if (this.destroyed) return

    const newCacheKeys = new Set<string>()

    for (const [, entry] of newMatches) {
      const cacheKey = this.makeCacheKey(entry)
      newCacheKeys.add(cacheKey)

      if (this.decorationCache.has(cacheKey)) {
        continue
      }

      this.createDecoration(entry, cacheKey)
    }

    if (!mergeMode) {
      for (const [cacheKey, cached] of this.decorationCache) {
        if (!newCacheKeys.has(cacheKey)) {
          try { cached.decoration.dispose() } catch { /* ignore */ }
          this.decorationCache.delete(cacheKey)
        }
      }
    }
  }

  private purgeOffViewportDecorations(viewportY: number, rows: number): void {
    const viewportEnd = viewportY + rows

    for (const [cacheKey, cached] of this.decorationCache) {
      const line = cached.marker.line
      if (line < 0 || line < viewportY || line >= viewportEnd) {
        try { cached.decoration.dispose() } catch { /* ignore */ }
        this.decorationCache.delete(cacheKey)
      }
    }
  }

  private createDecoration(entry: DecorationEntry, cacheKey: string): void {
    try {
      const buffer = this.terminal.buffer.active
      const cursorAbsoluteY = buffer.baseY + buffer.cursorY
      const markerOffset = entry.absoluteLine - cursorAbsoluteY
      const marker = this.terminal.registerMarker(markerOffset)
      if (!marker) return

      const colorRule = entry.highlightRule || entry.detectionRule
      // xterm.js's IDecorationOptions doesn't declare foregroundColor /
      // backgroundColor / overviewRulerOptions in its public types, but
      // the renderer reads them — see xterm-addon-decoration source.
      // Widen the options shape locally to add them safely.
      type ExtendedDecorationOptions = Parameters<typeof this.terminal.registerDecoration>[0] & {
        foregroundColor?: string
        backgroundColor?: string
        overviewRulerOptions?: { color: string }
      }
      const decorationOptions: ExtendedDecorationOptions = {
        marker,
        x: entry.startColumn,
        width: entry.endColumn - entry.startColumn,
      }

      if (colorRule?.foreground) {
        decorationOptions.foregroundColor = colorRule.foreground
      }
      if (colorRule?.background) {
        decorationOptions.backgroundColor = colorRule.background
      }
      if (colorRule?.foreground || colorRule?.background) {
        decorationOptions.overviewRulerOptions = {
          color: colorRule.foreground || colorRule.background || '#ffffff',
        }
      }

      const decoration = this.terminal.registerDecoration(decorationOptions)
      if (!decoration) return

      const detectionExtras = entry.detectionRule
        ? this.detectionExtras.get(entry.detectionRule.id)
        : null

      if (detectionExtras) {
        decoration.onRender((element) => {
          try {
            element.style.borderBottom = detectionExtras.borderStyle
            element.style.cursor = detectionExtras.cursor
            element.style.pointerEvents = 'auto'
            element.title = detectionExtras.tooltipPrefix
            element.dataset.detectionType = detectionExtras.detectionType
          } catch { /* ignore */ }
        })
      }

      this.decorationCache.set(cacheKey, {
        decoration,
        marker,
        absoluteLine: entry.absoluteLine,
        startColumn: entry.startColumn,
        endColumn: entry.endColumn,
        highlightRuleId: entry.highlightRule?.id || null,
        detectionRuleId: entry.detectionRule?.id || null,
      })

      decoration.onDispose(() => {
        this.decorationCache.delete(cacheKey)
      })
    } catch (err) {
      logger.debug('Failed to create decoration:', err)
    }
  }

  private disposeAllDecorations(): void {
    for (const [, cached] of this.decorationCache) {
      try { cached.decoration.dispose() } catch { /* ignore */ }
    }
    this.decorationCache.clear()
    this.lineContentCache.clear()
    this.clearAdHocDecorations()
  }

  // === Pattern matching ===

  private matchPattern(text: string, rule: HighlightRule): MatchResult[] {
    const results: MatchResult[] = []
    const pattern = this.compiledPatterns.get(rule.id)
    if (!pattern) return results

    pattern.lastIndex = 0

    let match
    while ((match = pattern.exec(text)) !== null) {
      results.push({
        start: match.index,
        end: match.index + match[0].length,
      })
      if (match[0].length === 0) {
        pattern.lastIndex++
      }
    }

    return results
  }

  private compilePatterns(): void {
    this.compiledPatterns.clear()

    const allRules = [...this.rules, ...this.detectionRules]

    for (const rule of allRules) {
      if (this.compiledPatterns.has(rule.id)) continue

      try {
        let pattern: string
        let flags = 'g'

        if (!rule.case_sensitive) {
          flags += 'i'
        }

        if (rule.is_regex) {
          pattern = rule.pattern
        } else {
          pattern = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        }

        if (rule.whole_word && !rule.is_regex) {
          pattern = `\\b${pattern}\\b`
        }

        const compiledRegex = new RegExp(pattern, flags)
        this.compiledPatterns.set(rule.id, compiledRegex)
      } catch (err) {
        console.warn(`Invalid pattern for rule ${rule.name}:`, err)
      }
    }
  }

  // === CSS injection ===

  private generateCssRule(rule: HighlightRule): string {
    const styleId = generateStyleId(rule)
    const styles: string[] = []

    if (rule.bold) styles.push('font-weight: bold !important')
    if (rule.italic) styles.push('font-style: italic !important')
    if (rule.underline) styles.push('text-decoration: underline !important')
    if (rule.background) styles.push(`background-color: ${rule.background} !important`)
    if (rule.foreground) styles.push(`color: ${rule.foreground} !important`)

    if (styles.length === 0) return ''

    return `.xterm .xterm-decoration-container .highlight-decoration.${styleId} { ${styles.join('; ')} }`
  }

  private injectStyles(): void {
    this.cleanupStyles()

    const hasRules = this.rules.length > 0 || this.detectionRules.length > 0
    if (!hasRules) return

    this.styleElement = document.createElement('style')
    this.styleElement.setAttribute('data-highlight-engine', 'true')

    const cssRules = this.rules
      .map(rule => this.generateCssRule(rule))
      .filter(css => css.length > 0)

    if (this.detectionEnabled) {
      cssRules.push(
        `.xterm .xterm-decoration-container [data-detection-type]:hover {
          background-color: rgba(100, 180, 255, 0.2);
          border-bottom-color: rgba(100, 180, 255, 1) !important;
          border-bottom-style: solid !important;
        }`
      )
    }

    this.styleElement.textContent = cssRules.join('\n')
    document.head.appendChild(this.styleElement)
  }

  private cleanupStyles(): void {
    if (this.styleElement && this.styleElement.parentNode) {
      this.styleElement.parentNode.removeChild(this.styleElement)
      this.styleElement = null
    }
  }

  // === Ad-hoc highlights (AI) ===

  applyAdHocHighlights(highlights: AdHocHighlight[]): void {
    if (this.destroyed || highlights.length === 0) return

    this.clearAdHocDecorations()

    const buffer = this.terminal.buffer.active
    const viewportY = buffer.viewportY
    const rows = this.terminal.rows
    const cursorAbsoluteY = buffer.baseY + buffer.cursorY

    for (const highlight of highlights) {
      if (highlight.line < viewportY || highlight.line >= viewportY + rows) {
        continue
      }

      try {
        const highlightWidth = highlight.end - highlight.start
        if (highlightWidth <= 0) continue

        const marker = this.terminal.registerMarker(
          highlight.line - cursorAbsoluteY
        )
        if (!marker) continue

        const decoration = this.terminal.registerDecoration({
          marker,
          x: highlight.start,
          width: highlightWidth,
          overviewRulerOptions: {
            color: highlight.background || highlight.foreground || '#ffffff',
          },
        })

        if (decoration) {
          const hl = highlight
          decoration.onRender(element => {
            try {
              element.classList.add('highlight-decoration', 'ai-highlight')
              if (hl.background) {
                element.style.backgroundColor = hl.background
              } else if (hl.foreground) {
                element.style.backgroundColor = hexToRgba(hl.foreground, 0.25)
                element.style.borderBottom = `2px solid ${hl.foreground}`
              }
              if (hl.className) {
                element.classList.add(hl.className)
              }
              element.style.cursor = 'pointer'
              element.style.pointerEvents = 'auto'
              if (hl.tooltip) {
                element.dataset.overlordTooltip = hl.tooltip
              }
            } catch { /* ignore */ }
          })
          this.adHocDecorations.push(decoration)
        }
      } catch (err) {
        logger.debug('Failed to apply AI highlight:', err)
      }
    }
  }

  private clearAdHocDecorations(): void {
    for (const decoration of this.adHocDecorations) {
      try { decoration.dispose() } catch { /* ignore */ }
    }
    this.adHocDecorations = []
  }

  // === Lifecycle ===

  clearDecorations(): void {
    this.disposeAllDecorations()
  }

  destroy(): void {
    this.destroyed = true

    if (this.throttleTimer !== null) {
      window.clearTimeout(this.throttleTimer)
      this.throttleTimer = null
    }

    this.disposeAllDecorations()
    this.cleanupStyles()
    this.rules = []
    this.detectionRules = []
    this.detectionExtras.clear()
    this.compiledPatterns.clear()
  }

  getRules(): HighlightRule[] {
    return [...this.rules]
  }

  isActive(): boolean {
    return !this.destroyed && (this.rules.length > 0 || this.detectionRules.length > 0)
  }
}

export interface AdHocHighlight {
  line: number
  start: number
  end: number
  foreground?: string
  background?: string
  className?: string
  tooltip?: string
  gutterIcon?: string
  onClick?: (highlight: AdHocHighlight) => void
}

export function generateStyleId(rule: HighlightRule): string {
  return `hl-${rule.id.replace(/[^a-zA-Z0-9]/g, '')}`
}

function hexToRgba(hex: string, alpha: number): string {
  let fullHex = hex.replace('#', '')
  if (fullHex.length === 3) {
    fullHex = fullHex.split('').map(c => c + c).join('')
  }

  const r = parseInt(fullHex.substring(0, 2), 16)
  const g = parseInt(fullHex.substring(2, 4), 16)
  const b = parseInt(fullHex.substring(4, 6), 16)

  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    return `rgba(128, 128, 128, ${alpha})`
  }

  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function matchPattern(
  text: string,
  rule: HighlightRule
): MatchResult[] {
  const results: MatchResult[] = []

  try {
    let pattern: string
    let flags = 'g'

    if (!rule.case_sensitive) {
      flags += 'i'
    }

    if (rule.is_regex) {
      pattern = rule.pattern
    } else {
      pattern = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    if (rule.whole_word) {
      pattern = `\\b${pattern}\\b`
    }

    const regex = new RegExp(pattern, flags)
    let match

    while ((match = regex.exec(text)) !== null) {
      results.push({
        start: match.index,
        end: match.index + match[0].length,
      })

      if (match[0].length === 0) {
        regex.lastIndex++
      }
    }
  } catch {
    // Invalid pattern
  }

  return results
}
