import { useState } from 'react'
import type { PickedField, EnrichmentSourceTestResult } from '../api/enrichment'
import { detectFormat, humanizeKey } from '../lib/enrichmentFieldUtils'

/**
 * Interactive explorer for a source-test response. Renders the JSON as a
 * collapsible tree where leaf checkboxes pick fields and container "↳ unwrap"
 * chips set the response unwrap path — ported from the vsce source editor.
 */
export function EnrichmentSourceExplorer({
  result, responseUnwrap, setResponseUnwrap, fields, setFields,
}: {
  result: EnrichmentSourceTestResult
  responseUnwrap: string
  setResponseUnwrap: (s: string) => void
  fields: PickedField[]
  setFields: (f: PickedField[]) => void
}) {
  const [view, setView] = useState<'tree' | 'json'>('tree')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggleCollapse = (path: string) => {
    const next = new Set(collapsed)
    if (next.has(path)) next.delete(path); else next.add(path)
    setCollapsed(next)
  }

  // Field keys are stored relative to the unwrap path (matching the agent).
  const relativize = (path: string): string => {
    if (!responseUnwrap) return path
    if (path.startsWith(responseUnwrap + '.')) return path.slice(responseUnwrap.length + 1)
    if (path === responseUnwrap) return ''
    return path
  }

  const togglePick = (path: string, value: unknown) => {
    const leafPath = relativize(path)
    if (fields.some((f) => f.key === leafPath)) {
      setFields(fields.filter((f) => f.key !== leafPath))
    } else {
      const det = detectFormat(value)
      const last = leafPath.split(/[.[\]]/).filter(Boolean).pop() ?? leafPath
      setFields([...fields, { key: leafPath, label: humanizeKey(last), format: det.fmt }])
    }
  }

  const isPicked = (path: string) => fields.some((f) => f.key === relativize(path))

  const ok = result.success
  const root = result.raw_response

  return (
    <div className="se-explorer">
      <div className="se-test-status">
        <span className={`se-pill ${ok ? 'ok' : 'err'}`}>{ok ? `${result.status_code ?? 200} OK` : `${result.status_code ?? 'ERR'}`}</span>
        {result.url && <span className="se-test-url" title={result.url}>{result.url}</span>}
        <span className="se-test-timing">{result.duration_ms}ms</span>
        <span className="se-view-toggle">
          {(['tree', 'json'] as const).map((v) => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>{v.toUpperCase()}</button>
          ))}
        </span>
      </div>

      {result.error && <div className="se-test-error">{result.error}</div>}

      {view === 'json' ? (
        <pre className="se-tree">{JSON.stringify(root, null, 2)}</pre>
      ) : root === null || root === undefined ? (
        <div className="se-tree-empty">No response — try Run Test</div>
      ) : (
        <div className="se-tree">
          <JsonNode
            value={root}
            path=""
            collapsed={collapsed}
            toggleCollapse={toggleCollapse}
            responseUnwrap={responseUnwrap}
            setResponseUnwrap={setResponseUnwrap}
            isPicked={isPicked}
            togglePick={togglePick}
          />
        </div>
      )}
    </div>
  )
}

function JsonNode({
  value, path, collapsed, toggleCollapse, responseUnwrap, setResponseUnwrap, isPicked, togglePick,
}: {
  value: unknown
  path: string
  collapsed: Set<string>
  toggleCollapse: (p: string) => void
  responseUnwrap: string
  setResponseUnwrap: (s: string) => void
  isPicked: (p: string) => boolean
  togglePick: (p: string, v: unknown) => void
}) {
  const isObj = value !== null && typeof value === 'object' && !Array.isArray(value)
  const isArr = Array.isArray(value)
  const isContainer = isObj || isArr
  const isOpen = !collapsed.has(path)
  const keyPart = path.split('.').pop() ?? ''
  const arrayIndex = /^\d+$/.test(keyPart)

  const meta = isArr
    ? `[ ${(value as unknown[]).length} items ]`
    : isObj
      ? `{ ${Object.keys(value as object).length} keys }`
      : ''

  return (
    <div className="se-tree-node">
      <div className="se-tree-row">
        <span
          className={`se-tree-toggle${isContainer ? '' : ' empty'}`}
          onClick={isContainer ? () => toggleCollapse(path) : undefined}
        >
          {isContainer ? (isOpen ? '▼' : '▶') : '·'}
        </span>

        {!isContainer ? (
          <input
            type="checkbox"
            className="se-tree-check"
            checked={isPicked(path)}
            onChange={() => togglePick(path, value)}
          />
        ) : (
          <span className="se-tree-check-spacer" />
        )}

        <span className="se-tree-content">
          {path === '' ? (
            <span className="se-tree-meta">root {meta}</span>
          ) : arrayIndex ? (
            isContainer
              ? <span className="se-tree-meta">[{keyPart}] {meta}</span>
              : <><span className="se-tree-meta">[{keyPart}]:</span> <LeafValue value={value} /></>
          ) : isContainer ? (
            <><span className="se-tree-key">{keyPart}</span> <span className="se-tree-meta">{meta}</span></>
          ) : (
            <><span className="se-tree-key">{keyPart}</span>: <LeafValue value={value} /></>
          )}
        </span>

        {isContainer && path !== '' && (
          <span
            className={`se-badge-unwrap${responseUnwrap === path ? ' active' : ''}`}
            title={`Set Response Unwrap to ${path}`}
            onClick={(e) => {
              e.stopPropagation()
              setResponseUnwrap(responseUnwrap === path ? '' : path)
            }}
          >
            {responseUnwrap === path ? '✓ unwrap' : '↳ unwrap'}
          </span>
        )}
      </div>

      {isContainer && isOpen && (
        <div className="se-tree-children">
          {isArr
            ? (() => {
                const arr = value as unknown[]
                const limit = Math.min(arr.length, 5)
                const nodes = []
                for (let i = 0; i < limit; i++) {
                  nodes.push(
                    <JsonNode
                      key={i}
                      value={arr[i]}
                      path={path ? `${path}.${i}` : String(i)}
                      collapsed={collapsed}
                      toggleCollapse={toggleCollapse}
                      responseUnwrap={responseUnwrap}
                      setResponseUnwrap={setResponseUnwrap}
                      isPicked={isPicked}
                      togglePick={togglePick}
                    />,
                  )
                }
                if (arr.length > limit) {
                  nodes.push(<div key="more" className="se-tree-meta se-tree-more">… {arr.length - limit} more items</div>)
                }
                return nodes
              })()
            : Object.keys(value as object).map((k) => (
                <JsonNode
                  key={k}
                  value={(value as Record<string, unknown>)[k]}
                  path={path ? `${path}.${k}` : k}
                  collapsed={collapsed}
                  toggleCollapse={toggleCollapse}
                  responseUnwrap={responseUnwrap}
                  setResponseUnwrap={setResponseUnwrap}
                  isPicked={isPicked}
                  togglePick={togglePick}
                />
              ))}
        </div>
      )}
    </div>
  )
}

function LeafValue({ value }: { value: unknown }) {
  const det = detectFormat(value)
  let cls = 'se-tree-val'
  let text: string
  if (value === null) { cls += ' null'; text = 'null' }
  else if (typeof value === 'boolean') { cls += ' bool'; text = String(value) }
  else if (typeof value === 'number') { cls += ' number'; text = String(value) }
  else if (typeof value === 'string') { cls += ' string'; text = `"${value.length > 80 ? value.slice(0, 80) + '…' : value}"` }
  else { text = String(value) }
  return (
    <>
      <span className={cls}>{text}</span>
      {det.badge && <span className={`se-badge-detect ${det.badge}`}>{det.badge}</span>}
    </>
  )
}
