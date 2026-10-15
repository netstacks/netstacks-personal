import AITabInput from './AITabInput'
import { useState, useCallback, useMemo } from 'react'
import { useSettings } from '../hooks/useSettings'
import { compileStripPatterns, stripHostname } from '../lib/hostnameStrip'
import './SettingsHostnames.css'
import Tooltip from './Tooltip'
import Switch from './Switch'
import SettingsSection from './settings/SettingsSection'
import SettingRow from './settings/SettingRow'

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
    <SettingsSection
      title="Hostname Display"
      description="Strip repetitive domain suffixes from hostnames throughout the app (sessions, topology, device lists). Display-only: connections use the full hostname."
      actions={<button className="ns-btn ns-btn--small" onClick={addPattern}>+ Add pattern</button>}
    >
      <div className="settings-group">
        <SettingRow label="Enable hostname stripping">
          <Switch checked={enabled} onChange={setEnabled} label="Enable hostname stripping" />
        </SettingRow>
        <SettingRow
          label="Strip patterns"
          description="Regular expressions, case-insensitive, applied in order."
          stacked
        >
          {patterns.length === 0 ? (
            <p className="form-hint">No patterns yet. Add one to start stripping hostnames.</p>
          ) : (
            <div className="sh-pattern-list">
              {patterns.map((p, i) => {
                const validation = compileStripPatterns([p])
                const errorMsg = validation.invalid.length > 0 ? validation.invalid[0].error : null
                return (
                  <div key={i} className="sh-pattern">
                    <div className="sh-pattern-row">
                      <Tooltip label="Move up"><button aria-label="Move up"
                        className="ns-btn ns-btn--ghost ns-btn--small ns-icon-btn"
                        disabled={i === 0}
                        onClick={() => movePattern(i, -1)}
                      >
                        ↑
                      </button></Tooltip>
                      <Tooltip label="Move down"><button aria-label="Move down"
                        className="ns-btn ns-btn--ghost ns-btn--small ns-icon-btn"
                        disabled={i === patterns.length - 1}
                        onClick={() => movePattern(i, 1)}
                      >
                        ↓
                      </button></Tooltip>
                      <AITabInput
                        className="settings-code"
                        aria-label={`Strip pattern ${i + 1}`}
                        aria-invalid={errorMsg !== null}
                        value={p}
                        placeholder="e.g. \\.gi-nw\\.viasat\\.io$"
                        onChange={(e) => editPattern(i, e.target.value)}
                        aiField="hostname strip regex"
                        aiPlaceholder="Regex for the domain suffix to strip from device hostnames for display"
                        aiContext={{ sampleHostname: sampleInput, otherPatterns: patterns.filter((_, j) => j !== i).join(' ') }}
                        onAIValue={(v) => editPattern(i, v)}
                      />
                      <Tooltip label="Remove"><button aria-label="Remove pattern" className="ns-btn ns-btn--ghost ns-btn--danger ns-btn--small ns-icon-btn" onClick={() => removePattern(i)}>
                        ×
                      </button></Tooltip>
                    </div>
                    {errorMsg && <p className="form-hint sh-error">{errorMsg}</p>}
                  </div>
                )
              })}
            </div>
          )}
        </SettingRow>
        <SettingRow
          label="Live test"
          description="Type a hostname to see the result with your current patterns."
          stacked
        >
          <input data-ai-fill="off"
            className="ns-input settings-code"
            aria-label="Sample hostname"
            value={sampleInput}
            onChange={(e) => setSampleInput(e.target.value)}
            placeholder="e.g. dcar01-cdev.nae05.gi-nw.viasat.io"
          />
          <div className="sh-result">→ <span>{liveOutput}</span></div>
        </SettingRow>
      </div>
    </SettingsSection>
  )
}
