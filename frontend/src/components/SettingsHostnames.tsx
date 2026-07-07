import { useState, useCallback, useMemo } from 'react'
import { useSettings } from '../hooks/useSettings'
import { compileStripPatterns, stripHostname } from '../lib/hostnameStrip'
import './SettingsHostnames.css'

export default function SettingsHostnames() {
  const { settings, updateSetting } = useSettings()
  const enabled = settings['hostname.stripEnabled'] ?? false
  const patterns = (settings['hostname.stripPatterns'] ?? []) as string[]

  const [sampleInput, setSampleInput] = useState('dcar01-cdev.nae05.gi-nw.viasat.io')

  const setEnabled = useCallback((v: boolean) => {
    updateSetting('hostname.stripEnabled', v)
  }, [updateSetting])

  const setPatterns = useCallback((next: string[]) => {
    updateSetting('hostname.stripPatterns', next)
  }, [updateSetting])

  const addPattern = useCallback(() => {
    setPatterns([...patterns, ''])
  }, [patterns, setPatterns])

  const removePattern = useCallback((i: number) => {
    setPatterns(patterns.filter((_, idx) => idx !== i))
  }, [patterns, setPatterns])

  const editPattern = useCallback((i: number, val: string) => {
    setPatterns(patterns.map((p, idx) => (idx === i ? val : p)))
  }, [patterns, setPatterns])

  const movePattern = useCallback((i: number, dir: number) => {
    const next = [...patterns]
    const target = i + dir
    if (target < 0 || target >= next.length) return
    ;[next[i], next[target]] = [next[target], next[i]]
    setPatterns(next)
  }, [patterns, setPatterns])

  const liveOutput = useMemo(() => {
    return stripHostname(sampleInput, patterns, true)
  }, [sampleInput, patterns])

  return (
    <div className="settings-hostnames">
      <div className="sh-header">
        <h2>Hostname Display</h2>
        <p className="sh-description">
          Strip repetitive domain suffixes from hostnames throughout the app (sessions, topology, device lists).
          Purely display-only — connections use the full hostname.
        </p>
      </div>

      <label className="sh-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Enable hostname stripping</span>
      </label>

      <div className="sh-patterns">
        <div className="sh-patterns-header">
          <span>Strip patterns (regex, case-insensitive, applied in order)</span>
          <button className="sh-btn" onClick={addPattern}>+ Add pattern</button>
        </div>
        {patterns.length === 0 && (
          <div className="sh-empty">No patterns configured. Add one to start stripping hostnames.</div>
        )}
        <div className="sh-pattern-list">
          {patterns.map((p, i) => {
            const validation = compileStripPatterns([p])
            const hasError = validation.invalid.length > 0
            const errorMsg = hasError ? validation.invalid[0].error : null
            return (
              <div key={i} className="sh-pattern-row">
                <div className="sh-pattern-controls">
                  <button
                    className="sh-btn-sm"
                    disabled={i === 0}
                    onClick={() => movePattern(i, -1)}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    className="sh-btn-sm"
                    disabled={i === patterns.length - 1}
                    onClick={() => movePattern(i, 1)}
                    title="Move down"
                  >
                    ↓
                  </button>
                </div>
                <input
                  className={`sh-pattern-input ${hasError ? 'sh-pattern-error' : ''}`}
                  value={p}
                  placeholder="e.g. \\.gi-nw\\.viasat\\.io$"
                  onChange={(e) => editPattern(i, e.target.value)}
                />
                <button className="sh-btn-danger" onClick={() => removePattern(i)} title="Remove">
                  ×
                </button>
                {hasError && <div className="sh-error-msg">{errorMsg}</div>}
              </div>
            )
          })}
        </div>
      </div>

      <div className="sh-test">
        <div className="sh-test-header">Live test</div>
        <p className="sh-test-note">
          Type a hostname to see the result using your current patterns (updates in real-time, no save needed).
        </p>
        <div className="sh-test-row">
          <label className="sh-test-label">Sample hostname:</label>
          <input
            className="sh-test-input"
            value={sampleInput}
            onChange={(e) => setSampleInput(e.target.value)}
            placeholder="e.g. dcar01-cdev.nae05.gi-nw.viasat.io"
          />
        </div>
        <div className="sh-test-result">
          <span className="sh-result-arrow">→</span>
          <span className="sh-result-value">{liveOutput}</span>
        </div>
        <div className="sh-test-example">
          Example: <code>dcar01-cdev.nae05.gi-nw.viasat.io</code> with pattern{' '}
          <code>\.gi-nw\.viasat\.io$</code> → <code>dcar01-cdev.nae05</code>
        </div>
      </div>
    </div>
  )
}
