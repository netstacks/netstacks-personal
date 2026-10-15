import { useState, useEffect, useCallback } from 'react'
import {
  getAiProfile,
  updateAiProfile,
  resetAiProfile,
  type AiEngineerProfile,
  type UpdateAiEngineerProfile,
} from '../api/aiEngineerProfile'
import { useAssistantNameStore } from '../stores/assistantName'
import { confirmDialog } from './ConfirmDialog'
import AITabInput from './AITabInput'
import Tooltip from './Tooltip'
import SettingsSection from './settings/SettingsSection'
import SettingRow from './settings/SettingRow'
import SettingsItem from './settings/SettingsItem'
import './AIEngineerSettingsTab.css'

const PACK_LABELS: Record<string, string> = {
  cisco: 'Cisco IOS / IOS-XE / NX-OS',
  juniper: 'Juniper Junos',
  arista: 'Arista EOS',
  palo_alto: 'Palo Alto PAN-OS',
  fortinet: 'Fortinet FortiOS',
  nokia: 'Nokia SR OS',
  huawei: 'Huawei VRP',
  mikrotik: 'MikroTik RouterOS',
  routing: 'Routing & Protocols',
  switching: 'Switching & VLANs',
  datacenter: 'Datacenter & VXLAN',
  security: 'Security & ACLs',
  wireless: 'Wireless',
  cloud: 'Cloud Networking',
  mpls: 'MPLS & Segment Routing',
  wan: 'WAN & SD-WAN',
  voip: 'VoIP & UC',
}

const BEHAVIOR_MODES = [
  { value: 'assistant', label: 'Assistant — answers questions, follows instructions' },
  { value: 'coworker', label: 'Coworker — proactive, takes ownership' },
  { value: 'mentor', label: 'Mentor — explains the why, teaches as you go' },
  { value: 'silent', label: 'Silent — speaks only when spoken to' },
]

const AUTONOMY_LEVELS = [
  { value: 'inform', label: 'Inform — report findings only' },
  { value: 'suggest', label: 'Suggest — suggest fixes and wait for approval' },
  { value: 'act', label: 'Act — fix issues and report back' },
]

const VERBOSITY_OPTIONS = [
  { value: 'terse', label: 'Terse — direct and minimal' },
  { value: 'balanced', label: 'Balanced — moderate detail' },
  { value: 'detailed', label: 'Detailed — thorough explanations' },
]

const RISK_TOLERANCE_OPTIONS = [
  { value: 'conservative', label: 'Conservative — always verify first' },
  { value: 'moderate', label: 'Moderate — balance speed and caution' },
  { value: 'aggressive', label: 'Aggressive — move fast when safe' },
]

const TROUBLESHOOTING_OPTIONS = [
  { value: 'top-down', label: 'Top-down' },
  { value: 'bottom-up', label: 'Bottom-up' },
  { value: 'divide-and-conquer', label: 'Divide and conquer' },
]

const CERT_PERSPECTIVES = [
  { value: 'vendor-neutral', label: 'Vendor-neutral' },
  { value: 'ccie', label: 'CCIE (Cisco)' },
  { value: 'jncie', label: 'JNCIE (Juniper)' },
]

const EXPERIENCE_LEVELS = [
  { value: 'junior', label: 'Junior' },
  { value: 'mid', label: 'Mid-level' },
  { value: 'senior', label: 'Senior' },
  { value: 'expert', label: 'Expert' },
]

const ENVIRONMENT_TYPES = [
  { value: 'lab', label: 'Lab' },
  { value: 'production', label: 'Production' },
  { value: 'msp', label: 'MSP / Multi-tenant' },
  { value: 'mixed', label: 'Mixed' },
]

const SYNTAX_STYLES = [
  { value: 'full', label: 'Full commands' },
  { value: 'shorthand', label: 'Shorthand / abbreviated' },
]


interface PackSize {
  category: string
  name: string
  size: number
}

interface PackBudgetInfo {
  total_budget: number
  core_size: number
  available_budget: number
  packs: PackSize[]
}

export default function AIEngineerSettingsTab() {
  const [profile, setProfile] = useState<AiEngineerProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [packBudget, setPackBudget] = useState<PackBudgetInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const loadProfile = useCallback(async () => {
    setLoading(true)
    try {
      const p = await getAiProfile()
      setProfile(p)
      // Load pack sizes for budget visualization
      try {
        const { getClient } = await import('../api/client')
        const { data } = await getClient().http.get('/ai/knowledge-pack-sizes')
        setPackBudget(data)
      } catch {
        // Non-fatal — budget visualization just won't show
      }
    } catch {
      setError('Failed to load AI engineer profile')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadProfile()
  }, [loadProfile])

  const saveField = async (update: UpdateAiEngineerProfile) => {
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      // Always mark onboarding complete — editing profile in Settings IS onboarding
      const updated = await updateAiProfile({ ...update, onboarding_completed: true })
      setProfile(updated)
      setSuccess('Saved')
      setTimeout(() => setSuccess(null), 2000)
    } catch {
      setError('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    const ok = await confirmDialog({
      title: 'Reset AI engineer profile?',
      body: 'This clears all settings and restarts onboarding the next time you open AI chat.',
      confirmLabel: 'Reset',
      destructive: true,
    })
    if (!ok) return
    try {
      await resetAiProfile()
      setProfile(null)
      setSuccess('Profile reset. Onboarding will start on next AI chat.')
    } catch {
      setError('Failed to reset profile')
    }
  }

  if (loading) {
    return <p className="form-hint">Loading AI engineer profile…</p>
  }

  if (!profile) {
    return (
      <SettingsSection
        title="AI Engineer Profile"
        description="No profile configured yet. Open the AI assistant to start the onboarding conversation, or create one manually."
        actions={
          <button className="ns-btn ns-btn--small" onClick={() => {
            updateAiProfile({ name: 'NetBot', behavior_mode: 'assistant', autonomy_level: 'suggest', onboarding_completed: true }).then(p => setProfile(p)).catch(() => setError('Failed to create profile'))
          }}>
            + Create profile
          </button>
        }
      >
        {error && <p className="settings-error">{error}</p>}
      </SettingsSection>
    )
  }

  const selectRow = (
    label: string,
    value: string,
    options: { value: string; label: string }[],
    field: keyof UpdateAiEngineerProfile,
    description?: string,
  ) => (
    <SettingRow label={label} description={description}>
      <select aria-label={label}
        className="ns-select setting-select-field"
        value={value}
        onChange={(e) => {
          setProfile({ ...profile, [field]: e.target.value })
          saveField({ [field]: e.target.value })
        }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </SettingRow>
  )

  return (
    <>
      {(error || success || saving) && (
        <div>
          {error && <p className="settings-error">{error}</p>}
          {success && <p className="settings-success">{success}</p>}
          {saving && <p className="form-hint">Saving…</p>}
        </div>
      )}

      <SettingsSection title="Identity">
        <div className="settings-group">
          <SettingRow label="AI Name" description="What your AI engineer goes by" stacked>
            <AITabInput
              aria-label="AI Name"
              value={profile.name || ''}
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
              aiField="AI engineer name"
              aiPlaceholder="A short, friendly name for the user's AI network engineer"
              aiContext={{ workingStyle: profile.behavior_mode, autonomy: profile.autonomy_level }}
              onAIValue={(v) => { setProfile({ ...profile, name: v }); saveField({ name: v }); useAssistantNameStore.getState().setName(v); }}
              onBlur={() => { saveField({ name: profile.name }); useAssistantNameStore.getState().setName(profile.name); }}
              placeholder="e.g. Atlas, NetBot"
            />
          </SettingRow>
          {selectRow('Working Style', profile.behavior_mode || 'assistant', BEHAVIOR_MODES, 'behavior_mode', 'How your AI engineer interacts with you')}
          {selectRow('Autonomy Level', profile.autonomy_level || 'suggest', AUTONOMY_LEVELS, 'autonomy_level', 'What happens when the AI finds a problem')}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Knowledge Packs"
        description="Knowledge areas loaded into the AI's context, each adding vendor or domain expertise. Packs load in the order shown until the budget is full."
      >
        {packBudget ? (() => {
          const budget = packBudget.available_budget
          const allPacks = packBudget.packs.filter(p => p.category !== 'core')
          const selected = allPacks.filter(p =>
            (profile.vendor_weights[p.name] ?? 0) > 0 || (profile.domain_focus[p.name] ?? 0) > 0
          )
          let used = 0
          const loaded: string[] = []
          for (const p of selected) {
            if (used + p.size <= budget) {
              used += p.size
              loaded.push(p.name)
            }
          }
          const pct = Math.round((used / budget) * 100)
          const level = pct > 95 ? 'full' : pct > 75 ? 'high' : 'ok'

          return (
            <>
              <div className="ai-pack-budget">
                <div className="ai-pack-budget-labels">
                  <span>{(used / 1000).toFixed(1)}k / {(budget / 1000).toFixed(1)}k used</span>
                  <span>{((budget - used) / 1000).toFixed(1)}k remaining</span>
                </div>
                <div className="ai-pack-budget-track">
                  <div className={`ai-pack-budget-fill ai-pack-budget-fill--${level}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                </div>
              </div>
              <div className="settings-group">
                {allPacks.map(pack => {
                  const isVendor = pack.category === 'vendor'
                  const isEnabled = isVendor
                    ? (profile.vendor_weights[pack.name] ?? 0) > 0
                    : (profile.domain_focus[pack.name] ?? 0) > 0
                  const isLoaded = loaded.includes(pack.name)
                  const wouldFit = !isEnabled ? (used + pack.size <= budget) : true
                  const label = PACK_LABELS[pack.name] || pack.name

                  const toggle = () => {
                    const key = isVendor ? 'vendor_weights' : 'domain_focus'
                    const next = { ...profile[key] }
                    if (isEnabled) {
                      delete next[pack.name]
                    } else {
                      next[pack.name] = 1.0
                    }
                    setProfile({ ...profile, [key]: next })
                    saveField({ [key]: next })
                  }

                  return (
                    <SettingsItem
                      key={pack.name}
                      leading={
                        <input
                          type="checkbox"
                          aria-label={label}
                          checked={isEnabled}
                          disabled={!isEnabled && !wouldFit}
                          onChange={toggle}
                        />
                      }
                      title={label}
                      badges={isEnabled && !isLoaded && <span className="settings-badge settings-badge--danger">over budget</span>}
                      actions={<span className="form-hint">{(pack.size / 1000).toFixed(1)}k</span>}
                    />
                  )
                })}
              </div>
            </>
          )
        })() : (
          <p className="form-hint">Loading knowledge pack information…</p>
        )}
      </SettingsSection>

      <SettingsSection title="Expertise">
        <div className="settings-group">
          {selectRow('Certification Perspective', profile.cert_perspective || 'vendor-neutral', CERT_PERSPECTIVES, 'cert_perspective')}
          {selectRow('Environment Type', profile.environment_type || 'production', ENVIRONMENT_TYPES, 'environment_type')}
        </div>
      </SettingsSection>

      <SettingsSection title="Behavior">
        <div className="settings-group">
          {selectRow('Verbosity', profile.verbosity || 'balanced', VERBOSITY_OPTIONS, 'verbosity')}
          {selectRow('Risk Tolerance', profile.risk_tolerance || 'conservative', RISK_TOLERANCE_OPTIONS, 'risk_tolerance')}
          {selectRow('Troubleshooting Method', profile.troubleshooting_method || 'top-down', TROUBLESHOOTING_OPTIONS, 'troubleshooting_method')}
          {selectRow('Experience Level', profile.user_experience_level || 'mid', EXPERIENCE_LEVELS, 'user_experience_level', 'Calibrates explanation depth')}
          {selectRow('Syntax Style', profile.syntax_style || 'full', SYNTAX_STYLES, 'syntax_style')}
          <SettingRow
            label="Communication Style"
            description="Free-text personality notes (e.g. &quot;Be direct and technical, skip pleasantries&quot;)"
            stacked
          >
            <AITabInput
              as="textarea"
              aria-label="Communication Style"
              rows={3}
              value={profile.communication_style || ''}
              onChange={(e) => setProfile({ ...profile, communication_style: e.target.value })}
              onAIValue={(v) => setProfile({ ...profile, communication_style: v })}
              onBlur={() => saveField({ communication_style: profile.communication_style })}
              aiField="communication_style"
              aiPlaceholder="Free-text personality/communication notes for the AI engineer"
              aiContext={{ behavior_mode: profile.behavior_mode, verbosity: profile.verbosity, experience_level: profile.user_experience_level }}
              placeholder="e.g. Be direct and technical, skip pleasantries"
            />
          </SettingRow>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Custom Safety Rules"
        description="Additional safety rules on top of the non-negotiable built-in rules. The AI always follows them."
        actions={
          <button
            className="ns-btn ns-btn--small"
            onClick={() => setProfile({ ...profile, safety_rules: [...profile.safety_rules, ''] })}
          >
            + Add rule
          </button>
        }
      >
        {profile.safety_rules.length === 0 ? (
          <p className="form-hint">No custom safety rules yet.</p>
        ) : (
          <div className="settings-group">
            {profile.safety_rules.map((rule, idx) => (
              <div key={idx} className="ai-safety-rule">
                <AITabInput aria-label={`Safety rule ${idx + 1}`}
                  value={rule}
                  aiField="AI safety rule"
                  aiPlaceholder="One rule the AI network engineer must always follow"
                  aiContext={{ otherRules: profile.safety_rules.filter((_, i) => i !== idx).join('; ') }}
                  onAIValue={(v) => {
                    const newRules = [...profile.safety_rules]
                    newRules[idx] = v
                    setProfile({ ...profile, safety_rules: newRules })
                    saveField({ safety_rules: newRules })
                  }}
                  onChange={(e) => {
                    const newRules = [...profile.safety_rules]
                    newRules[idx] = e.target.value
                    setProfile({ ...profile, safety_rules: newRules })
                  }}
                  onBlur={() => saveField({ safety_rules: profile.safety_rules })}
                />
                <Tooltip label="Remove rule"><button
                  aria-label="Remove rule"
                  className="ns-btn ns-btn--ghost ns-btn--danger ns-btn--small ns-icon-btn"
                  onClick={() => {
                    const newRules = profile.safety_rules.filter((_, i) => i !== idx)
                    setProfile({ ...profile, safety_rules: newRules })
                    saveField({ safety_rules: newRules })
                  }}
                >
                  &times;
                </button></Tooltip>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="Reset Profile"
        description="Clears all profile settings. The onboarding conversation starts the next time you open AI chat."
        actions={
          <button className="ns-btn ns-btn--small ns-btn--danger" onClick={handleReset}>
            Reset &amp; Re-onboard
          </button>
        }
      />
    </>
  )
}
