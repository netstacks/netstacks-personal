/**
 * Settings → Clipboard (docs/clipboard-history-plan.md §3.5, §4.1).
 * History retention plus the paste-hygiene presets applied per CLI flavor.
 */
import AITabInput from './AITabInput'
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
import SettingsSection from './settings/SettingsSection'
import SettingRow from './settings/SettingRow'
import { useShortcut } from '../hooks/useKeyboard'
import { confirmDialog } from './ConfirmDialog'
import './ClipboardSettingsTab.css'
import Tooltip from './Tooltip'

/** Presets map onto real CLI flavors; 'auto' always pastes raw. */
const FLAVORS = CLI_FLAVOR_OPTIONS.filter((o) => o.value !== 'auto')

type IntSettingKey = 'clipboard.expiryHours' | 'clipboard.maxClips' | 'clipboard.confirmPasteLines'

/**
 * Numeric setting input with the same rules as the General tab: the field can
 * be emptied while typing, commits as soon as the text is a valid in-range
 * integer, and clamps on blur (NS-SET-8).
 */
function IntSetting({ settingKey, label, min, max, suffix, disabled }: { settingKey: IntSettingKey; label: string; min: number; max: number; suffix?: string; disabled?: boolean }) {
  const { settings, updateSetting } = useSettings()
  const [draft, setDraft] = useState<string | null>(null)
  const clamp = (raw: string): number | null => {
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null
  }
  return (
    <span className="clipboard-int-setting">
      <input aria-label={label}
        type="number"
        min={min}
        max={max}
        disabled={disabled}
        className="ns-input setting-input-number"
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
      {suffix}
    </span>
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
    <>
      <SettingsSection
        title="Clipboard History"
        description={
          <>
            Everything copied inside NetStacks is recorded with where it came from (session, device, CLI flavor).
            Open it with <kbd>{historyChord}</kbd> or <em>Clipboard: History…</em> in the command palette.
            {isEnterprise
              ? ' In enterprise mode history is kept in memory for this window only.'
              : ' Credential patterns (passwords, secrets, keys, SNMP communities) are scrubbed from stored text; the OS clipboard still gets what you copied.'}
          </>
        }
      >
        <div className="settings-group">
          <SettingRow label="Record copies in history">
            <Switch
              checked={settings['clipboard.historyEnabled'] !== false}
              onChange={(v) => updateSetting('clipboard.historyEnabled', v)}
              label="Record copies in history"
            />
          </SettingRow>
          <SettingRow label="Keep unpinned clips for" description="Pinned clips never expire.">
            <IntSetting settingKey="clipboard.expiryHours" label="Keep unpinned clips for" min={1} max={720} suffix="hours" />
          </SettingRow>
          <SettingRow label="Maximum unpinned clips">
            <IntSetting settingKey="clipboard.maxClips" label="Maximum unpinned clips" min={10} max={5000} />
          </SettingRow>
          <SettingRow label="Clear history">
            <button
              type="button"
              className="ns-btn ns-btn--small ns-btn--danger"
              disabled={unpinnedCount === 0}
              onClick={() => void clearUnpinned()}
            >
              Delete {unpinnedCount} unpinned {unpinnedCount === 1 ? 'clip' : 'clips'}
            </button>
          </SettingRow>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Advanced Paste"
        description={
          <>
            <kbd>{pasteChord}</kbd> pastes through the flavor's preset and opens the editable paste dialog for multi-line text;{' '}
            <kbd>{passthroughChord}</kbd> pastes exactly what the clipboard holds, no dialog. Both chords (and Copy Selection)
            are rebindable in Settings → Keyboard; <kbd>Shift+Insert</kbd> / <kbd>Ctrl+Insert</kbd> stay as fixed aliases.
          </>
        }
        help={{
          topic: 'paste hygiene',
          prompt: `Explain NetStacks advanced paste and help me tune it. Advanced paste is ${advanced ? 'on' : 'off'}, auto-transform is ${settings['clipboard.autoTransform'] !== false ? 'on' : 'off'}, multi-line confirm is ${settings['clipboard.confirmMultilinePaste'] ? `on from ${settings['clipboard.confirmPasteLines']} lines` : 'off'}, and there are ${presets.length} transform preset(s). `
            + 'Cover the two paste chords, what each transform does (strip prompts, line endings, tabs, trailing spaces, …), how a preset is chosen per CLI flavor, and safe settings for pasting configuration into Cisco/Juniper/Arista devices.',
        }}
      >
        <div className="settings-group">
          <SettingRow
            label="Enable advanced paste"
            description="Off: every paste chord is a plain paste — no preset, no confirm dialog. Clipboard history is unaffected."
          >
            <Switch
              checked={advanced}
              onChange={(v) => updateSetting('clipboard.advancedPaste', v)}
              label="Enable advanced paste"
            />
          </SettingRow>
          <SettingRow
            label="Confirm multi-line pastes"
            description="Open the paste dialog before sending, so the text can be edited and the result checked (SecureCRT-style)."
          >
            <Switch
              checked={settings['clipboard.confirmMultilinePaste'] !== false}
              onChange={(v) => updateSetting('clipboard.confirmMultilinePaste', v)}
              disabled={!advanced}
              label="Confirm multi-line pastes"
            />
          </SettingRow>
          <SettingRow
            label="Confirm when the paste has at least"
            description="2 means every multi-line paste; 1 confirms single-line pastes too."
          >
            <IntSetting
              settingKey="clipboard.confirmPasteLines"
              label="Confirm when the paste has at least"
              min={1}
              max={1000}
              suffix="lines"
              disabled={!advanced || settings['clipboard.confirmMultilinePaste'] === false}
            />
          </SettingRow>
          <SettingRow label="Apply the flavor's preset on paste">
            <Switch
              checked={settings['clipboard.autoTransform'] !== false}
              onChange={(v) => updateSetting('clipboard.autoTransform', v)}
              disabled={!advanced}
              label="Apply the flavor's preset on paste"
            />
          </SettingRow>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Paste Presets"
        description="Transform steps applied to pasted text, chosen automatically by the session's CLI flavor."
        actions={
          <>
            <Tooltip label={`Restore the ${BUILTIN_PRESETS.length} built-in presets`}><button
              type="button"
              className="ns-btn ns-btn--small ns-btn--ghost"
              onClick={() => void resetPresets()}
              disabled={(settings['clipboard.presets'] ?? []).length === 0}
            >
              Reset to built-ins
            </button></Tooltip>
            <button type="button" className="ns-btn ns-btn--small" onClick={addPreset}>+ Add preset</button>
          </>
        }
      >
        <div className="settings-group">
          {presets.map((preset) => {
            const isRaw = preset.id === RAW_PRESET_ID
            return (
              <div key={preset.id} className="clipboard-preset">
                <div className="clipboard-preset-head">
                  <AITabInput
                    className="clipboard-preset-name"
                    value={preset.name}
                    disabled={isRaw}
                    onChange={(e) => patchPreset(preset.id, { name: e.target.value })}
                    aria-label="Preset name"
                    aiField="paste preset name"
                    aiPlaceholder="Short name describing what this paste-transform chain does"
                    aiContext={{ transforms: preset.chain.join(' → '), cliFlavors: preset.cliFlavors.join(', ') }}
                    onAIValue={(v) => patchPreset(preset.id, { name: v })}
                  />
                  {!isRaw && (
                    <button type="button" className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" onClick={() => removePreset(preset.id)}>
                      Delete
                    </button>
                  )}
                </div>
                {isRaw ? (
                  <p className="form-hint">Pastes text exactly as copied. Used for sessions whose flavor is "auto" or has no preset.</p>
                ) : (
                  <>
                    <div className="clipboard-preset-row">
                      <span className="clipboard-preset-row-label">Auto for</span>
                      <div className="clipboard-chips">
                        {FLAVORS.map((f) => (
                          <Tooltip key={f.value} label={f.value}><button
                            type="button"
                            className={`clipboard-chip${preset.cliFlavors.includes(f.value) ? ' active' : ''}`}
                            aria-pressed={preset.cliFlavors.includes(f.value)}
                            onClick={() => toggleFlavor(preset, f.value)}
                          >
                            {f.label}
                          </button></Tooltip>
                        ))}
                      </div>
                    </div>
                    <div className="clipboard-preset-row">
                      <span className="clipboard-preset-row-label">Steps (applied in this order)</span>
                      <div className="clipboard-transforms">
                        {TRANSFORM_IDS.map((t) => (
                          <Tooltip key={t} label={TRANSFORMS[t].description}><label className="clipboard-transform">
                            <input type="checkbox" checked={preset.chain.includes(t)} onChange={() => toggleTransform(preset, t)} />
                            {TRANSFORMS[t].label}
                          </label></Tooltip>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </SettingsSection>
    </>
  )
}
