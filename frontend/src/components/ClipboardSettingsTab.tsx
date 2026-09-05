/**
 * Settings → Clipboard (docs/clipboard-history-plan.md §3.5, §4.1).
 * History retention plus the paste-hygiene presets applied per CLI flavor.
 */
import { useState } from 'react'
import { useSettings } from '../hooks/useSettings'
import { useClipStore } from '../stores/clipStore'
import { useMode } from '../hooks/useMode'
import {
  BUILTIN_PRESETS, RAW_PRESET_ID, TRANSFORMS, TRANSFORM_IDS, presetsFrom, type TransformId, type TransformPreset,
} from '../lib/clipTransforms'
import type { CliFlavor } from '../types/enrichment'
import { CLI_FLAVOR_OPTIONS } from '../api/sessions'
import Switch from './Switch'
import { useShortcut } from '../hooks/useKeyboard'
import { confirmDialog } from './ConfirmDialog'
import './ClipboardSettingsTab.css'

/** Presets map onto real CLI flavors; 'auto' always pastes raw. */
const FLAVORS = CLI_FLAVOR_OPTIONS.filter((o) => o.value !== 'auto')

type IntSettingKey = 'clipboard.expiryHours' | 'clipboard.maxClips' | 'clipboard.confirmPasteLines'

/**
 * Numeric setting input with the same rules as the General tab: the field can
 * be emptied while typing, commits as soon as the text is a valid in-range
 * integer, and clamps on blur (NS-SET-8).
 */
function IntSetting({ settingKey, min, max, suffix, disabled }: { settingKey: IntSettingKey; min: number; max: number; suffix?: string; disabled?: boolean }) {
  const { settings, updateSetting } = useSettings()
  const [draft, setDraft] = useState<string | null>(null)
  const clamp = (raw: string): number | null => {
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null
  }
  return (
    <div className="settings-input-group">
      <input
        type="number"
        min={min}
        max={max}
        disabled={disabled}
        className="setting-input setting-input-number"
        value={draft ?? String(settings[settingKey])}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = clamp(e.target.value)
          if (n !== null && String(n) === e.target.value.trim()) updateSetting(settingKey, n)
        }}
        onBlur={() => {
          if (draft !== null) {
            const n = clamp(draft)
            if (n !== null) updateSetting(settingKey, n)
          }
          setDraft(null)
        }}
      />
      {suffix && <span className="settings-input-suffix">{suffix}</span>}
    </div>
  )
}

export default function ClipboardSettingsTab() {
  const { settings, updateSetting } = useSettings()
  const { isEnterprise } = useMode()
  const clips = useClipStore((s) => s.clips)
  const clearUnpinned = useClipStore((s) => s.clearUnpinned)
  // Derived from hook state (not getSettings()) so render stays pure.
  const presets = presetsFrom(settings['clipboard.presets'])
  const advanced = settings['clipboard.advancedPaste'] !== false
  const pasteChord = useShortcut('terminalPaste')
  const passthroughChord = useShortcut('terminalPastePassthrough')
  const historyChord = useShortcut('clipboardHistory')

  const savePresets = (next: TransformPreset[]) => updateSetting('clipboard.presets', next)
  const patchPreset = (id: string, patch: Partial<TransformPreset>) =>
    savePresets(presets.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  const toggleTransform = (preset: TransformPreset, t: TransformId) => {
    // Chain order follows TRANSFORM_IDS so toggling never reorders existing steps.
    const on = preset.chain.includes(t)
    const chain = TRANSFORM_IDS.filter((id) => (id === t ? !on : preset.chain.includes(id)))
    patchPreset(preset.id, { chain })
  }

  const toggleFlavor = (preset: TransformPreset, f: CliFlavor) => {
    const has = preset.cliFlavors.includes(f)
    // A flavor maps to exactly one preset: claiming it releases it elsewhere.
    savePresets(presets.map((p) => {
      if (p.id === preset.id) return { ...p, cliFlavors: has ? p.cliFlavors.filter((x) => x !== f) : [...p.cliFlavors, f] }
      return has ? p : { ...p, cliFlavors: p.cliFlavors.filter((x) => x !== f) }
    }))
  }

  const addPreset = () => {
    // Deterministic id: one above the highest existing user-preset number.
    const next = presets.reduce((max, p) => {
      const m = /^preset-(\d+)$/.exec(p.id)
      return m ? Math.max(max, Number(m[1])) : max
    }, 0) + 1
    const id = `preset-${next}`
    savePresets([...presets.filter((p) => p.id !== RAW_PRESET_ID), { id, name: 'New preset', chain: ['normalize-lf'], cliFlavors: [] }, ...presets.filter((p) => p.id === RAW_PRESET_ID)])
  }

  const removePreset = (id: string) => savePresets(presets.filter((p) => p.id !== id))

  const resetPresets = async () => {
    const ok = await confirmDialog({
      title: 'Reset paste presets?',
      body: 'Your edited presets will be replaced by the built-in IOS / Junos / PAN-OS / Linux / Raw set.',
      confirmLabel: 'Reset',
      destructive: true,
    })
    if (ok) savePresets([])
  }

  const unpinnedCount = clips.filter((c) => !c.pinned).length

  return (
    <div className="settings-content clipboard-settings">
      <div className="settings-category">
        <h3 className="settings-category-title">Clipboard History</h3>
        <p className="setting-description">
          Everything copied inside NetStacks is recorded with where it came from (session, device, CLI flavor).
          Open it with <kbd>{historyChord}</kbd> or <em>Clipboard: History…</em> in the command palette.
          {isEnterprise
            ? ' In enterprise mode history is kept in memory for this window only.'
            : ' Credential patterns (passwords, secrets, keys, SNMP communities) are scrubbed from stored text; the OS clipboard still gets what you copied.'}
        </p>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Record copies in history</span>
            <div className="setting-control">
              <Switch
                checked={settings['clipboard.historyEnabled'] !== false}
                onChange={(v) => updateSetting('clipboard.historyEnabled', v)}
                label="Record copies in history"
              />
            </div>
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Keep unpinned clips for</span>
            <div className="setting-control">
              <IntSetting settingKey="clipboard.expiryHours" min={1} max={720} suffix="hours" />
            </div>
          </div>
          <div className="setting-description">Pinned clips never expire.</div>
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Maximum unpinned clips</span>
            <div className="setting-control">
              <IntSetting settingKey="clipboard.maxClips" min={10} max={5000} />
            </div>
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Clear history</span>
            <div className="setting-control">
              <button
                type="button"
                className="clipboard-settings-btn danger"
                disabled={unpinnedCount === 0}
                onClick={() => void clearUnpinned()}
              >
                Delete {unpinnedCount} unpinned {unpinnedCount === 1 ? 'clip' : 'clips'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-category">
        <h3 className="settings-category-title">Advanced Paste</h3>
        <p className="setting-description">
          <kbd>{pasteChord}</kbd> pastes through the flavor's preset and opens the editable paste dialog for multi-line text;
          <kbd>{passthroughChord}</kbd> pastes exactly what the clipboard holds, no dialog. Both chords (and Copy Selection)
          are rebindable in Settings → Keyboard; <kbd>Shift+Insert</kbd> / <kbd>Ctrl+Insert</kbd> stay as fixed aliases.
        </p>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Enable advanced paste</span>
            <div className="setting-control">
              <Switch
                checked={advanced}
                onChange={(v) => updateSetting('clipboard.advancedPaste', v)}
                label="Enable advanced paste"
              />
            </div>
          </div>
          <div className="setting-description">
            Off: every paste chord is a plain paste — no preset, no confirm dialog. Clipboard history is unaffected.
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Confirm multi-line pastes</span>
            <div className="setting-control">
              <Switch
                checked={settings['clipboard.confirmMultilinePaste'] !== false}
                onChange={(v) => updateSetting('clipboard.confirmMultilinePaste', v)}
                disabled={!advanced}
                label="Confirm multi-line pastes"
              />
            </div>
          </div>
          <div className="setting-description">
            Open the paste dialog before sending, so the text can be edited and the result checked (SecureCRT-style).
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Confirm when the paste has at least</span>
            <div className="setting-control">
              <IntSetting
                settingKey="clipboard.confirmPasteLines"
                min={1}
                max={1000}
                suffix="lines"
                disabled={!advanced || settings['clipboard.confirmMultilinePaste'] === false}
              />
            </div>
          </div>
          <div className="setting-description">2 means every multi-line paste; 1 confirms single-line pastes too.</div>
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Apply the flavor's preset on paste</span>
            <div className="setting-control">
              <Switch
                checked={settings['clipboard.autoTransform'] !== false}
                onChange={(v) => updateSetting('clipboard.autoTransform', v)}
                disabled={!advanced}
                label="Apply the flavor's preset on paste"
              />
            </div>
          </div>
        </div>

        <div className="clipboard-presets">
          {presets.map((preset) => {
            const isRaw = preset.id === RAW_PRESET_ID
            return (
              <div key={preset.id} className="clipboard-preset">
                <div className="clipboard-preset-head">
                  <input
                    className="setting-input clipboard-preset-name"
                    value={preset.name}
                    disabled={isRaw}
                    onChange={(e) => patchPreset(preset.id, { name: e.target.value })}
                    aria-label="Preset name"
                  />
                  {!isRaw && (
                    <button type="button" className="clipboard-settings-btn" onClick={() => removePreset(preset.id)} title="Delete preset">
                      Delete
                    </button>
                  )}
                </div>
                {isRaw ? (
                  <div className="setting-description">Pastes text exactly as copied. Used for sessions whose flavor is "auto" or has no preset.</div>
                ) : (
                  <>
                    <div className="clipboard-preset-row">
                      <span className="clipboard-preset-row-label">Auto for</span>
                      <div className="clipboard-chips">
                        {FLAVORS.map((f) => (
                          <button
                            key={f.value}
                            type="button"
                            className={`clipboard-chip${preset.cliFlavors.includes(f.value) ? ' active' : ''}`}
                            onClick={() => toggleFlavor(preset, f.value)}
                            title={f.value}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="clipboard-preset-row">
                      <span className="clipboard-preset-row-label">Steps (applied in this order)</span>
                      <div className="clipboard-transforms">
                        {TRANSFORM_IDS.map((t) => (
                          <label key={t} className="clipboard-transform" title={TRANSFORMS[t].description}>
                            <input type="checkbox" checked={preset.chain.includes(t)} onChange={() => toggleTransform(preset, t)} />
                            {TRANSFORMS[t].label}
                          </label>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>

        <div className="clipboard-preset-actions">
          <button type="button" className="clipboard-settings-btn" onClick={addPreset}>+ Add preset</button>
          <button
            type="button"
            className="clipboard-settings-btn"
            onClick={() => void resetPresets()}
            disabled={(settings['clipboard.presets'] ?? []).length === 0}
            title={`Restore the ${BUILTIN_PRESETS.length} built-in presets`}
          >
            Reset to built-ins
          </button>
        </div>
      </div>
    </div>
  )
}
