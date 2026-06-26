import { useState, useCallback } from 'react'
import './JsonTreeViewer.css'

interface JsonTreeViewerProps {
  data: any
  initialExpanded?: boolean
  maxDepth?: number
}

function JsonValue({ value, depth, maxDepth, initialExpanded }: {
  value: any
  depth: number
  maxDepth: number
  initialExpanded: boolean
}) {
  if (value === null) {
    return <span className="jtv-null">null</span>
  }
  if (typeof value === 'boolean') {
    return <span className="jtv-boolean">{value ? 'true' : 'false'}</span>
  }
  if (typeof value === 'number') {
    return <span className="jtv-number">{value}</span>
  }
  if (typeof value === 'string') {
    return <span className="jtv-string">"{value}"</span>
  }
  if (Array.isArray(value)) {
    return (
      <JsonArray
        data={value}
        depth={depth}
        maxDepth={maxDepth}
        initialExpanded={initialExpanded}
      />
    )
  }
  if (typeof value === 'object') {
    return (
      <JsonObject
        data={value}
        depth={depth}
        maxDepth={maxDepth}
        initialExpanded={initialExpanded}
      />
    )
  }
  return <span className="jtv-string">{String(value)}</span>
}

function JsonArray({ data, depth, maxDepth, initialExpanded }: {
  data: any[]
  depth: number
  maxDepth: number
  initialExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(initialExpanded && depth < maxDepth)

  if (data.length === 0) {
    return <span className="jtv-bracket">[]</span>
  }

  if (!expanded) {
    return (
      <span className="jtv-collapsed" onClick={() => setExpanded(true)}>
        <span className="jtv-toggle">&#9654;</span>
        <span className="jtv-bracket">array</span>
        <span className="jtv-count">[{data.length}]</span>
      </span>
    )
  }

  return (
    <span className="jtv-expanded">
      <span className="jtv-toggle-open" onClick={() => setExpanded(false)}>
        &#9660;
      </span>
      <span className="jtv-bracket">array</span>
      <span className="jtv-count">[{data.length}]</span>
      <div className="jtv-children">
        {data.map((item, i) => (
          <div className="jtv-entry" key={i}>
            <span className="jtv-index">{i}:</span>{' '}
            <JsonValue
              value={item}
              depth={depth + 1}
              maxDepth={maxDepth}
              initialExpanded={initialExpanded}
            />
          </div>
        ))}
      </div>
    </span>
  )
}

function JsonObject({ data, depth, maxDepth, initialExpanded }: {
  data: Record<string, any>
  depth: number
  maxDepth: number
  initialExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(initialExpanded && depth < maxDepth)
  const keys = Object.keys(data)

  if (keys.length === 0) {
    return <span className="jtv-bracket">{'{}'}</span>
  }

  if (!expanded) {
    return (
      <span className="jtv-collapsed" onClick={() => setExpanded(true)}>
        <span className="jtv-toggle">&#9654;</span>
        <span className="jtv-bracket">object</span>
        <span className="jtv-count">{'{' + keys.length + '}'}</span>
      </span>
    )
  }

  return (
    <span className="jtv-expanded">
      <span className="jtv-toggle-open" onClick={() => setExpanded(false)}>
        &#9660;
      </span>
      <span className="jtv-bracket">object</span>
      <span className="jtv-count">{'{' + keys.length + '}'}</span>
      <div className="jtv-children">
        {keys.map((key) => (
          <div className="jtv-entry" key={key}>
            <span className="jtv-key">{key}:</span>{' '}
            <JsonValue
              value={data[key]}
              depth={depth + 1}
              maxDepth={maxDepth}
              initialExpanded={initialExpanded}
            />
          </div>
        ))}
      </div>
    </span>
  )
}

export default function JsonTreeViewer({
  data,
  initialExpanded = false,
  maxDepth = 10,
}: JsonTreeViewerProps) {
  const handleCopy = useCallback(() => {
    try {
      navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    } catch {
      // ignore
    }
  }, [data])

  return (
    <div className="jtv-root">
      <div className="jtv-toolbar">
        <button className="jtv-copy-btn" onClick={handleCopy} title="Copy JSON">
          Copy
        </button>
      </div>
      <div className="jtv-tree">
        <JsonValue
          value={data}
          depth={0}
          maxDepth={maxDepth}
          initialExpanded={initialExpanded}
        />
      </div>
    </div>
  )
}
