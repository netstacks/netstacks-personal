/**
 * Enrichment-based hover popup for xterm.js (Tauri port).
 *
 * Registers one xterm link provider per active matcher pattern. On hover over a
 * matched token it calls the agent's /enrich/match then /enrich/source endpoints
 * directly over HTTP (no extension-host relay), streaming each source into the
 * popup as it returns. An optional AI Digest button swaps the sections for a
 * short LM summary.
 *
 * Ported from netstacks-vsce/src/webview/enrichPopup.ts — the DOM/UX is
 * preserved; the postMessage transport is replaced with direct api calls.
 */

import type { Terminal, IDisposable, ILinkProvider, ILink, IBufferRange } from '@xterm/xterm'
import {
  getActiveMatchers,
  enrichMatch,
  enrichSource,
  type ActiveMatcher,
  type EnrichmentClientSettings,
} from '../api/enrichment'
import { rendererFor, metaFor, renderRawDebug } from './enrichRenderers'
import { sendChatMessage } from '../api/ai'
import { logger } from './logger'
import { compileRegex } from './compileRegex'

/** Aggregated result for one token — cached + fed to the AI digest. */
interface EnrichResult {
  token: string
  matcher_name: string | null
  sources: Record<string, unknown>
  errors: Record<string, string>
}

interface CacheEntry {
  result?: EnrichResult
  digest?: string
}

export interface EnrichPopupOptions {
  /** Session id for source context (host/name resolution server-side). */
  sessionId?: string | null
  /** Live CLI flavor accessor — matchers gate on it. */
  getCliFlavor?: () => string | null
  /** Live settings accessor (hoverEnabled / aiDigestEnabled / disabledSources). */
  getSettings: () => EnrichmentClientSettings
}

export interface EnrichPopupAPI {
  /** Re-fetch matchers and rebuild link providers (call after settings change). */
  refresh(): void
  hide(): void
  dispose(): void
}

export function installEnrichPopup(
  term: Terminal,
  host: HTMLElement,
  opts: EnrichPopupOptions,
): EnrichPopupAPI {
  let providers: IDisposable[] = []
  let activeMatchers: ActiveMatcher[] = []
  const cache = new Map<string, CacheEntry>()
  // Monotonic hover generation — bumped on every new hover so stale async
  // responses (match/source/digest) from a previous token are dropped.
  let hoverGen = 0
  let disposed = false

  // ── Popup DOM ──────────────────────────────────────────────────────────

  const popup = document.createElement('div')
  // `popover-card` provides the shared frosted-glass skin; `ns-enrich-popup`
  // adds enrich-specific positioning/sizing.
  popup.className = 'ns-enrich-popup popover-card'
  popup.style.display = 'none'
  host.appendChild(popup)

  // Track whether the user has manually dragged the popup. While dragged we
  // don't auto-reposition on content changes and don't auto-hide on leave.
  let userPositioned = false

  function hidePopup() {
    // Invalidate any in-flight async work for the current hover.
    hoverGen++
    popup.style.display = 'none'
    popup.innerHTML = ''
    userPositioned = false
  }

  /** Clamp the popup so it stays within the terminal host area. */
  function clampToHost() {
    if (userPositioned) return
    const rect = popup.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    let top = parseFloat(popup.style.top || '0')
    let left = parseFloat(popup.style.left || '0')
    if (rect.bottom > hostRect.bottom - 4) {
      top = Math.max(4, top - (rect.bottom - hostRect.bottom + 4))
    }
    if (rect.right > hostRect.right - 4) {
      left = Math.max(4, left - (rect.right - hostRect.right + 4))
    }
    popup.style.top = `${top}px`
    popup.style.left = `${left}px`
  }

  // <details> expand/collapse inside the popup grows/shrinks it — reposition.
  popup.addEventListener('toggle', () => {
    requestAnimationFrame(clampToHost)
  }, true)

  // ── Drag-to-move ───────────────────────────────────────────────────────
  let dragState: { mouseStartX: number; mouseStartY: number; popupStartLeft: number; popupStartTop: number } | null = null

  function makeHeaderDraggable(header: HTMLElement) {
    header.classList.add('ns-enrich-header-draggable')
    header.title = 'Drag to move'
    header.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      const rect = popup.getBoundingClientRect()
      const hostRect = host.getBoundingClientRect()
      dragState = {
        mouseStartX: e.clientX,
        mouseStartY: e.clientY,
        popupStartLeft: rect.left - hostRect.left,
        popupStartTop: rect.top - hostRect.top,
      }
      e.preventDefault()
    })
  }

  function addCloseButton(header: HTMLElement) {
    const closeBtn = el('button', 'ns-enrich-close-btn', '×')
    closeBtn.title = 'Close'
    closeBtn.onclick = (e) => { e.stopPropagation(); e.preventDefault(); hidePopup() }
    header.appendChild(closeBtn)
  }

  const onDocMouseMove = (e: MouseEvent) => {
    if (!dragState) return
    const dx = e.clientX - dragState.mouseStartX
    const dy = e.clientY - dragState.mouseStartY
    // Clamp within the host so the popup can't be dragged off-screen and lost.
    const margin = 4
    const maxLeft = Math.max(margin, host.clientWidth - popup.offsetWidth - margin)
    const maxTop = Math.max(margin, host.clientHeight - popup.offsetHeight - margin)
    popup.style.left = `${Math.min(maxLeft, Math.max(margin, dragState.popupStartLeft + dx))}px`
    popup.style.top = `${Math.min(maxTop, Math.max(margin, dragState.popupStartTop + dy))}px`
    userPositioned = true
  }
  const onDocMouseUp = () => { dragState = null }
  document.addEventListener('mousemove', onDocMouseMove)
  document.addEventListener('mouseup', onDocMouseUp)

  function showPopupAt(event: MouseEvent) {
    popup.style.visibility = 'hidden'
    popup.style.display = 'block'
    const rect = popup.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    const mouseX = event.clientX - hostRect.left
    const mouseY = event.clientY - hostRect.top
    const SIDE_OFFSET = 20

    let left = mouseX + SIDE_OFFSET
    if (left + rect.width > hostRect.width - 4) {
      left = mouseX - rect.width - SIDE_OFFSET
    }
    if (left < 4) left = 4

    let top = mouseY - rect.height / 2
    if (top < 4) top = 4
    if (top + rect.height > hostRect.height - 4) {
      top = hostRect.height - rect.height - 4
    }

    popup.style.top = `${top}px`
    popup.style.left = `${left}px`
    popup.style.visibility = ''
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  function renderLoading(token: string) {
    popup.innerHTML = ''
    const header = el('div', 'ns-enrich-header')
    makeHeaderDraggable(header)
    addCloseButton(header)
    header.appendChild(el('span', 'ns-enrich-title', token))
    popup.appendChild(header)
    const loading = el('div', 'ns-enrich-loading')
    for (let i = 0; i < 3; i++) loading.appendChild(el('span', 'ns-enrich-dot'))
    popup.appendChild(loading)
  }

  /** Build the popup header (title + type badge + optional AI digest button). */
  function buildHeader(token: string, matcherName: string | null, resultForDigest: EnrichResult | null) {
    const header = el('div', 'ns-enrich-header')
    makeHeaderDraggable(header)
    addCloseButton(header)
    header.appendChild(el('span', 'ns-enrich-title', token))
    if (matcherName) {
      header.appendChild(el('span', 'ns-enrich-type-badge', matcherName))
    }
    if (opts.getSettings().aiDigestEnabled && resultForDigest && Object.keys(resultForDigest.sources).length > 0) {
      const btn = el('button', 'ns-enrich-digest-btn', '✦')
      btn.title = 'AI Digest'
      btn.onclick = (e) => {
        e.stopPropagation(); e.preventDefault()
        const cached = cache.get(token)
        if (cached?.digest) renderDigest(resultForDigest, cached.digest)
        else void requestDigest(resultForDigest)
      }
      header.appendChild(btn)
    }
    popup.appendChild(header)
  }

  function renderResult(result: EnrichResult) {
    popup.innerHTML = ''
    buildHeader(result.token, result.matcher_name, result)

    const sourceNames = Object.keys(result.sources)
    const errorNames = Object.keys(result.errors)

    if (sourceNames.length === 0 && errorNames.length === 0) {
      popup.appendChild(el('div', 'ns-enrich-empty', 'No enrichment data available.'))
      return
    }

    for (const sourceName of sourceNames) {
      const blob = result.sources[sourceName] as Record<string, unknown> | null
      if (!blob) continue
      const section = el('div', 'ns-enrich-section')
      section.dataset.source = sourceName
      patchSection(section, sourceName, blob, null)
      popup.appendChild(section)
    }

    if (errorNames.length > 0) {
      const section = el('div', 'ns-enrich-section ns-enrich-errors')
      const sectionHeader = el('div', 'ns-enrich-section-header')
      sectionHeader.appendChild(el('span', 'ns-enrich-section-tag ns-enrich-tag-error', 'errors'))
      section.appendChild(sectionHeader)
      const body = el('div', 'ns-enrich-section-body')
      for (const name of errorNames) {
        const r = el('div', 'ns-enrich-row')
        r.appendChild(el('span', 'ns-enrich-row-label', metaFor(name).label))
        r.appendChild(el('span', 'ns-enrich-row-value ns-enrich-error-text', result.errors[name]))
        body.appendChild(r)
      }
      section.appendChild(body)
      popup.appendChild(section)
    }
  }

  /** Build a single source section in skeleton state (placeholder + spinner). */
  function buildSkeletonSection(sourceName: string): HTMLElement {
    const section = el('div', 'ns-enrich-section')
    section.dataset.source = sourceName
    const sectionHeader = el('div', 'ns-enrich-section-header')
    const meta = metaFor(sourceName)
    sectionHeader.appendChild(el('span', `ns-enrich-section-tag ${meta.tagClass}`, meta.label))
    const spinner = el('span', 'ns-enrich-section-spinner')
    for (let i = 0; i < 3; i++) spinner.appendChild(el('span', 'ns-enrich-dot'))
    sectionHeader.appendChild(spinner)
    section.appendChild(sectionHeader)
    return section
  }

  /** Patch a section with its actual data (or an error row), in place. */
  function patchSection(section: HTMLElement, sourceName: string, data: unknown | null, error: string | null) {
    section.innerHTML = ''
    const sectionHeader = el('div', 'ns-enrich-section-header')
    const meta = metaFor(sourceName)
    sectionHeader.appendChild(el('span', `ns-enrich-section-tag ${meta.tagClass}`, meta.label))

    if (error) {
      section.appendChild(sectionHeader)
      const errRow = el('div', 'ns-enrich-row')
      errRow.appendChild(el('span', 'ns-enrich-row-value ns-enrich-error-text', error))
      section.appendChild(errRow)
      return
    }
    if (data === null || data === undefined) {
      section.style.display = 'none'
      return
    }

    const blob = data as Record<string, unknown>
    const renderer = rendererFor(sourceName)
    const body = renderer(blob) ?? renderRawDebug(blob)

    // {} raw-data toggle when the agent included `_raw`
    const rawData = (blob as Record<string, unknown>)?._raw
    if (rawData !== undefined && rawData !== null) {
      const rawBtn = document.createElement('button')
      rawBtn.className = 'ns-enrich-raw-toggle'
      rawBtn.textContent = '{}'
      rawBtn.title = 'View full response'
      rawBtn.style.marginLeft = 'auto'
      let rawPanel: HTMLElement | null = null
      rawBtn.onclick = (e) => {
        e.stopPropagation(); e.preventDefault()
        if (rawPanel) {
          rawPanel.remove(); rawPanel = null; rawBtn.classList.remove('active')
        } else {
          rawPanel = renderRawDebug(rawData as Record<string, unknown>)
          if (rawPanel) { section.appendChild(rawPanel); rawBtn.classList.add('active') }
        }
      }
      sectionHeader.appendChild(rawBtn)
    }
    section.appendChild(sectionHeader)
    if (body) section.appendChild(body)
  }

  // ── AI Digest ──────────────────────────────────────────────────────────

  function renderDigest(result: EnrichResult, text: string, streaming = false) {
    popup.innerHTML = ''
    const header = el('div', 'ns-enrich-header')
    makeHeaderDraggable(header)
    addCloseButton(header)
    header.appendChild(el('span', 'ns-enrich-title', result.token))
    const backBtn = el('button', 'ns-enrich-digest-btn', '←')
    backBtn.title = 'Back to sections'
    backBtn.onclick = (e) => { e.stopPropagation(); e.preventDefault(); renderResult(result) }
    header.appendChild(backBtn)
    popup.appendChild(header)

    const digest = el('div', 'ns-enrich-digest')
    digest.textContent = text || (streaming ? '…' : '')
    popup.appendChild(digest)
    popup.appendChild(el('div', 'ns-enrich-digest-footer', '✦ AI Summary'))
  }

  async function requestDigest(result: EnrichResult) {
    renderDigest(result, '', true)
    const prompt =
      `You are a network engineer's assistant. In 2-3 sentences, summarize what this ` +
      `enrichment data tells us about "${result.token}". Be concise and factual.\n\n` +
      JSON.stringify(result.sources, null, 2)
    try {
      const full = await sendChatMessage([{ role: 'user', content: prompt }])
      cache.set(result.token, { ...cache.get(result.token), digest: full })
      renderDigest(result, full, false)
    } catch (e) {
      renderDigest(result, `Error: ${e instanceof Error ? e.message : String(e)}`, false)
    }
  }

  // ── Hover handler ──────────────────────────────────────────────────────

  async function handleHover(token: string, event: MouseEvent) {
    const settings = opts.getSettings()
    if (!settings.hoverEnabled) return

    // Cache hit — render instantly, no requests.
    const cached = cache.get(token)
    if (cached?.result) {
      renderResult(cached.result)
      showPopupAt(event)
      return
    }

    const gen = ++hoverGen
    renderLoading(token)
    showPopupAt(event)

    let match
    try {
      match = await enrichMatch(token, opts.sessionId, opts.getCliFlavor?.() ?? null)
    } catch (e) {
      if (gen !== hoverGen) return
      popup.innerHTML = ''
      buildHeader(token, null, null)
      popup.appendChild(el('div', 'ns-enrich-empty', `Error: ${e instanceof Error ? e.message : String(e)}`))
      return
    }
    if (gen !== hoverGen) return

    const enabledSources = match.source_names.filter((s) => !settings.disabledSources.includes(s))

    popup.innerHTML = ''
    buildHeader(token, match.matcher_name, null)

    if (enabledSources.length === 0) {
      const flavor = opts.getCliFlavor?.() ?? 'auto'
      const isAuto = flavor === 'auto' && !match.matcher_name
      popup.appendChild(el('div', 'ns-enrich-empty', isAuto
        ? 'No matcher fired. This session’s CLI Flavor is "auto" — interface and MAC matchers require a specific flavor (juniper, cisco-ios, etc). Set it in Session Settings.'
        : 'No enrichment data available.'))
      return
    }

    const sections = new Map<string, HTMLElement>()
    for (const name of enabledSources) {
      const s = buildSkeletonSection(name)
      sections.set(name, s)
      popup.appendChild(s)
    }
    showPopupAt(event)

    const collected: Record<string, unknown> = {}
    const errors: Record<string, string> = {}

    await Promise.all(enabledSources.map(async (name) => {
      try {
        const res = await enrichSource(match.token_normalized, name, opts.sessionId)
        if (gen !== hoverGen) return
        if (res.data !== null && res.data !== undefined) collected[name] = res.data
        if (res.error) errors[name] = res.error
        const sec = sections.get(name)
        if (sec) patchSection(sec, name, res.data ?? null, res.error)
        requestAnimationFrame(clampToHost)
      } catch (e) {
        if (gen !== hoverGen) return
        const msg = e instanceof Error ? e.message : String(e)
        errors[name] = msg
        const sec = sections.get(name)
        if (sec) patchSection(sec, name, null, msg)
      }
    }))
    if (gen !== hoverGen) return

    // Drop sections that finished empty so the popup has no ghost rows.
    let visible = 0
    for (const sec of sections.values()) {
      if (sec.style.display !== 'none') visible++
    }
    if (visible === 0 && Object.keys(errors).length === 0) {
      popup.appendChild(el('div', 'ns-enrich-empty', 'No enrichment data available.'))
    }

    const result: EnrichResult = { token, matcher_name: match.matcher_name, sources: collected, errors }
    cache.set(token, { result })

    // Re-render the header now that we know whether to show the digest button.
    if (opts.getSettings().aiDigestEnabled && Object.keys(collected).length > 0) {
      const oldHeader = popup.querySelector('.ns-enrich-header')
      if (oldHeader) {
        const tmp = document.createElement('div')
        oldHeader.replaceWith(tmp)
        buildHeader(token, match.matcher_name, result)
        // buildHeader appends to popup end; move it back to the top.
        const newHeader = popup.lastElementChild
        if (newHeader) popup.insertBefore(newHeader, popup.firstChild)
        tmp.remove()
      }
    }
    requestAnimationFrame(clampToHost)
  }

  // ── Link providers (one per active matcher pattern) ─────────────────────

  function disposeProviders() {
    for (const p of providers) {
      try { p.dispose() } catch { /* ignore */ }
    }
    providers = []
  }

  function rebuildProviders() {
    disposeProviders()
    if (disposed || !opts.getSettings().hoverEnabled) return
    for (const matcher of activeMatchers) {
      for (const patternStr of matcher.patterns) {
        try {
          const re = compileRegex(patternStr, 'g')
          providers.push(term.registerLinkProvider(makeLinkProvider(re)))
        } catch (e) {
          logger.warn(`[enrichPopup] bad pattern in matcher ${matcher.name}:`, e)
        }
      }
    }
  }

  function makeLinkProvider(pattern: RegExp): ILinkProvider {
    return {
      provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1)
        if (!line) { callback(undefined); return }
        const text = line.translateToString(true)
        const links: ILink[] = []
        pattern.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = pattern.exec(text)) !== null) {
          if (m[0].length === 0) { pattern.lastIndex++; continue }
          const matchText = m[0]
          const startCol = m.index + 1
          const endCol = startCol + matchText.length
          const range: IBufferRange = {
            start: { x: startCol, y: bufferLineNumber },
            end: { x: endCol - 1, y: bufferLineNumber },
          }
          links.push({
            text: matchText,
            range,
            activate: () => { /* hover-only; no click action */ },
            hover: (event) => { void handleHover(matchText, event) },
            leave: () => {
              // Small delay so the cursor can travel into the popup. A user-
              // positioned (dragged) popup stays open until explicitly closed.
              setTimeout(() => {
                if (userPositioned) return
                if (!popup.matches(':hover')) hidePopup()
              }, 150)
            },
            decorations: { underline: false, pointerCursor: false },
          })
        }
        callback(links.length > 0 ? links : undefined)
      },
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────

  function refresh() {
    if (disposed) return
    getActiveMatchers()
      .then((result) => {
        activeMatchers = result.matchers
        rebuildProviders()
      })
      .catch((err) => {
        logger.warn('[enrichPopup] failed to load matchers:', err)
        activeMatchers = []
        disposeProviders()
      })
  }

  // Slight delay so the WS terminal init doesn't race the first fetch.
  const initTimer = window.setTimeout(refresh, 500)

  // Hide on click outside the popup.
  const onDocMouseDown = (e: MouseEvent) => {
    if (popup.contains(e.target as Node)) return
    hidePopup()
  }
  document.addEventListener('mousedown', onDocMouseDown)

  return {
    refresh,
    hide: hidePopup,
    dispose() {
      disposed = true
      window.clearTimeout(initTimer)
      disposeProviders()
      document.removeEventListener('mousemove', onDocMouseMove)
      document.removeEventListener('mouseup', onDocMouseUp)
      document.removeEventListener('mousedown', onDocMouseDown)
      hidePopup()
      popup.remove()
    },
  }
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}
