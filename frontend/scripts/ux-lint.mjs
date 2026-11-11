// Native-UX static lint (docs/NATIVE-UX-SPEC.md §2.4). Counts UX smells and
// fails when any count exceeds ux-lint.budgets.json. `--ratchet` lowers
// budgets to the measured counts (never raises them).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import safeParse from 'postcss-safe-parser'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const BUDGETS_FILE = join(ROOT, 'ux-lint.budgets.json')

const CHROME_STYLESHEETS = new Set([
  'src/index.css',
  'src/App.css',
  'src/components/TopBar.css',
  'src/components/MenuBar.css',
  'src/components/StatusBar.css',
  'src/components/ContextMenu.css',
  'src/components/CommandPalette.css',
  'src/components/dialog.css',
  'src/components/SettingsPanel.css',
])
const CHROME_MAX_DURATION_MS = 250
const PLATFORM_SCOPE = /\[data-platform=(['"]?)(windows|linux)\1\]/
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g
const INLINE_CURSOR_POINTER = /\bcursor:\s*['"]pointer['"]/g

function walk(dir, ext) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full, ext)
    return full.endsWith(ext) ? [full] : []
  })
}

const rel = (file) => relative(ROOT, file).split(sep).join('/')

/** `title=` on native elements (component props named title are headings, not tooltips). */
function nativeTitleCount(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  let count = 0
  const visit = (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /^[a-z]/.test(node.tagName.getText(sf))) {
      if (node.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'title')) count++
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return count
}

const jsxAttr = (open, sf, name) =>
  open.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === name)
const jsxAttrText = (open, sf, name) => {
  const a = jsxAttr(open, sf, name)
  if (!a) return undefined
  if (!a.initializer) return 'true'
  return ts.isStringLiteral(a.initializer) ? a.initializer.text : a.initializer.getText(sf)
}
const hasSpread = (open) => open.attributes.properties.some(ts.isJsxSpreadAttribute)
const openingOf = (node) => (ts.isJsxElement(node) ? node.openingElement : node)
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

// Identifiers/components that render a picture, not words ({Icons.x}, <RefreshIcon />).
const ICONISH = /icon|svg|chevron|spinner|glyph|caret|arrow|dot|logo/i
const INTERACTIVE_ROLES = new Set(['button', 'tab', 'menuitem', 'menuitemcheckbox', 'link', 'option', 'switch', 'checkbox', 'treeitem'])

/** 'text' when the content yields an accessible name; glyphs ("×", "▶") and icons don't. */
function contentKind(nodes, sf) {
  let unknown = false
  for (const n of nodes) {
    const kind = nodeKind(n, sf)
    if (kind === 'text') return 'text'
    if (kind === 'unknown') unknown = true
  }
  return unknown ? 'unknown' : 'none'
}

function exprKind(e, sf) {
  if (!e) return 'none'
  if (ts.isParenthesizedExpression(e)) return exprKind(e.expression, sf)
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return /[A-Za-z0-9]/.test(e.text) ? 'text' : 'none'
  if (ts.isTemplateExpression(e) || ts.isNumericLiteral(e)) return 'text'
  if (ts.isConditionalExpression(e)) return contentKind([e.whenTrue, e.whenFalse], sf)
  if (ts.isBinaryExpression(e)) {
    const and = e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    return and ? exprKind(e.right, sf) : contentKind([e.left, e.right], sf)
  }
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return nodeKind(e, sf)
  const text = e.getText(sf)
  if (text === 'null' || text === 'undefined' || text === 'false' || ICONISH.test(text)) return 'none'
  // {label}, {tab.title}, {t('…')} render words.
  return 'text'
}

function nodeKind(n, sf) {
  if (ts.isJsxText(n)) return /[A-Za-z0-9]/.test(n.text) ? 'text' : 'none'
  if (ts.isJsxExpression(n)) return exprKind(n.expression, sf)
  if (ts.isJsxFragment(n)) return contentKind(n.children, sf)
  if (!ts.isJsxElement(n) && !ts.isJsxSelfClosingElement(n)) return exprKind(n, sf)
  const open = openingOf(n)
  const tag = open.tagName.getText(sf)
  if (tag === 'svg' || tag === 'img') return jsxAttr(open, sf, 'aria-label') || jsxAttr(open, sf, 'alt') ? 'text' : 'none'
  if (/^\{?true\}?$/.test(jsxAttrText(open, sf, 'aria-hidden') ?? '')) return 'none'
  if (jsxAttr(open, sf, 'aria-label')) return 'text'
  if (/^[A-Z]/.test(tag)) {
    if (ICONISH.test(tag)) return 'none'
    // Tooltip only describes its child; other components may render words.
    return tag === 'Tooltip' && ts.isJsxElement(n) ? contentKind(n.children, sf) : 'text'
  }
  return ts.isJsxElement(n) ? contentKind(n.children, sf) : 'none'
}

/**
 * Accessibility names (spec §9.4). unnamedIconButtons: buttons, links and
 * button-like roles whose only content is an icon or glyph and that have no
 * aria-label / aria-labelledby / title — a Tooltip describes, it doesn't name.
 * unlabeledFormControls: select / textarea / input with no aria-label,
 * aria-labelledby, title, wrapping <label>, <label htmlFor> in the same file,
 * caller-supplied id (`id={id}` — the caller's label points at it) or, for
 * text fields, a placeholder. Elements with prop spreads are skipped: their
 * attributes aren't knowable statically.
 */
function accessibleNameCounts(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const labelTargets = new Set()
  const collect = (node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'htmlFor' && node.initializer) {
      labelTargets.add(ts.isStringLiteral(node.initializer) ? node.initializer.text : node.initializer.getText(sf))
    }
    ts.forEachChild(node, collect)
  }
  collect(sf)
  const found = { unnamedIconButtons: [], unlabeledFormControls: [] }
  const named = (open) => ['aria-label', 'aria-labelledby', 'title'].some((a) => jsxAttr(open, sf, a))
  const visit = (node, inLabel) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = openingOf(node)
      const tag = open.tagName.getText(sf)
      if (tag === 'label') inLabel = true
      if (/^[a-z]/.test(tag) && !hasSpread(open) && !named(open)) {
        const role = (jsxAttrText(open, sf, 'role') ?? '').replace(/["'{}]/g, '')
        const interactive = tag === 'button' || (tag === 'a' && jsxAttr(open, sf, 'href')) || INTERACTIVE_ROLES.has(role)
        if (interactive && (ts.isJsxElement(node) ? contentKind(node.children, sf) : 'none') === 'none') {
          found.unnamedIconButtons.push(`${rel(file)}:${lineOf(sf, open)}`)
        }
        const type = jsxAttrText(open, sf, 'type')
        const field = tag === 'select' || tag === 'textarea' || (tag === 'input' && !['hidden', 'submit', 'button', 'reset', 'file'].includes(type))
        if (field && !inLabel) {
          const id = jsxAttr(open, sf, 'id')
          const idText = jsxAttrText(open, sf, 'id')
          const labelled = (idText && labelTargets.has(idText))
            || (id?.initializer && ts.isJsxExpression(id.initializer) && id.initializer.expression && ts.isIdentifier(id.initializer.expression))
            || (tag !== 'select' && jsxAttr(open, sf, 'placeholder'))
          if (!labelled) found.unlabeledFormControls.push(`${rel(file)}:${lineOf(sf, open)}`)
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, inLabel))
  }
  visit(sf, false)
  return found
}

/**
 * aiFillCandidates: free-text <input>/<textarea> that are neither AITabInput
 * (Tab-to-AI fill) nor marked `data-ai-fill="off"`. New free-text fields
 * default to AI fill; a field that must not offer it (secrets, hosts, search,
 * inline rename, chat composers, …) says so on the element. Types that are not
 * free text (password, number, search, email, url, …) and readOnly fields are
 * not candidates.
 */
const NOT_FREE_TEXT = new Set(['password', 'number', 'search', 'email', 'url', 'tel', 'hidden', 'file', 'color', 'date', 'datetime-local', 'time', 'month', 'week', 'checkbox', 'radio', 'range', 'submit', 'button', 'reset', 'image'])
function aiFillCandidates(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const hits = []
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf)
      if ((tag === 'input' || tag === 'textarea') && !jsxAttr(node, sf, 'data-ai-fill') && !jsxAttr(node, sf, 'readOnly')) {
        const type = tag === 'input' ? (jsxAttrText(node, sf, 'type') ?? 'text') : 'textarea'
        if (!NOT_FREE_TEXT.has(type)) hits.push(`${rel(file)}:${lineOf(sf, node)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

function insideRootRule(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'rule' && p.selectors.some((s) => s.trim().startsWith(':root'))) return true
  }
  return false
}

function toMs(token) {
  const m = /^(-?[\d.]+)(ms|s)$/.exec(token)
  if (!m) return null
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1])
}

function durationsOf(prop, value) {
  if (prop === 'transition-duration') return value.split(',').map((v) => toMs(v.trim())).filter((v) => v !== null)
  // Shorthand: the first time value in each comma-separated item is its duration.
  return value.split(',').map((item) => item.trim().split(/\s+/).map(toMs).find((v) => v !== null)).filter((v) => v != null)
}

function measure() {
  const counts = {
    cursorPointer: 0,
    transitionAll: 0,
    componentColorLiterals: 0,
    unscopedWebkitScrollbar: 0,
    titleAttributes: 0,
    unnamedIconButtons: 0,
    unlabeledFormControls: 0,
    aiFillCandidates: 0,
    slowChromeTransitions: 0,
    rootColorScheme: 0,
  }
  const uniqueColors = new Set()

  for (const file of walk(SRC, '.css')) {
    const path = rel(file)
    const isComponent = path.startsWith('src/components/')
    const isChrome = CHROME_STYLESHEETS.has(path)
    const root = safeParse(readFileSync(file, 'utf8'), { from: file })

    root.walkRules((rule) => {
      // Hiding a strip's scrollbar (`display: none`) is layout, not styling.
      const hidesScrollbar = rule.nodes.every((n) => n.type !== 'decl' || (n.prop === 'display' && n.value.trim() === 'none'))
      if (rule.selector.includes('::-webkit-scrollbar') && !PLATFORM_SCOPE.test(rule.selector) && !hidesScrollbar) {
        counts.unscopedWebkitScrollbar++
      }
    })

    root.walkDecls((decl) => {
      const value = decl.value.trim()
      if (decl.prop === 'cursor' && value === 'pointer') counts.cursorPointer++
      if ((decl.prop === 'transition' || decl.prop === 'transition-property') && /(^|,)\s*all\b/.test(value)) counts.transitionAll++
      if (path === 'src/index.css' && decl.prop === 'color-scheme' && decl.parent?.type === 'rule' && decl.parent.selector.trim() === ':root') {
        counts.rootColorScheme++
      }
      if (isComponent && !decl.prop.startsWith('--') && !insideRootRule(decl)) {
        for (const c of value.match(COLOR_LITERAL) ?? []) {
          // rgba(var(--x-rgb), a) is token-derived, not a hardcoded color.
          if (!c.includes('var(')) uniqueColors.add(c.toLowerCase().replace(/\s+/g, ''))
        }
      }
      if (isChrome) {
        const isTransitionToken = decl.prop.startsWith('--transition')
        if (decl.prop === 'transition' || decl.prop === 'transition-duration' || isTransitionToken) {
          const prop = isTransitionToken ? 'transition' : decl.prop
          if (durationsOf(prop, value).some((ms) => ms > CHROME_MAX_DURATION_MS)) counts.slowChromeTransitions++
        }
      }
    })
  }
  counts.componentColorLiterals = uniqueColors.size
  const offenders = []

  for (const file of walk(SRC, '.tsx')) {
    if (file.endsWith('.test.tsx')) continue
    const source = readFileSync(file, 'utf8')
    counts.cursorPointer += (source.match(INLINE_CURSOR_POINTER) ?? []).length
    counts.titleAttributes += nativeTitleCount(file, source)
    for (const [rule, hits] of Object.entries({ ...accessibleNameCounts(file, source), aiFillCandidates: aiFillCandidates(file, source) })) {
      counts[rule] += hits.length
      offenders.push(...hits.map((h) => `${rule}  ${h}`))
    }
  }
  return { counts, offenders }
}

const { counts, offenders } = measure()
const budgets = JSON.parse(readFileSync(BUDGETS_FILE, 'utf8'))
const ratchet = process.argv.includes('--ratchet')
let failed = false

for (const [rule, count] of Object.entries(counts)) {
  if (!(rule in budgets)) {
    console.error(`ux-lint: no budget for "${rule}" in ux-lint.budgets.json`)
    failed = true
    continue
  }
  const over = count > budgets[rule]
  if (over) failed = true
  if (ratchet && count < budgets[rule]) budgets[rule] = count
  console.log(`${over ? 'FAIL' : 'ok  '}  ${rule.padEnd(26)} ${String(count).padStart(5)} / ${budgets[rule]}`)
}
for (const rule of Object.keys(budgets)) {
  if (!(rule in counts)) {
    console.error(`ux-lint: budget "${rule}" has no matching rule`)
    failed = true
  }
}

if (failed) for (const o of offenders) console.error(`  ${o}`)
if (ratchet) writeFileSync(BUDGETS_FILE, JSON.stringify(budgets, null, 2) + '\n')
process.exit(failed ? 1 : 0)
