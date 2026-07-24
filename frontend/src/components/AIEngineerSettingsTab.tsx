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
    return <div className="settings-content"><div className="settings-empty">Loading AI engineer profile...</div></div>
  }

  if (!profile) {
    return (
      <div className="settings-content">
        <div className="settings-category">
          <h3 className="settings-category-title">AI Engineer Profile</h3>
          <div className="settings-empty">
            No profile configured yet. Open AI Assistant to start the onboarding conversation, or configure manually below.
          </div>
          <button className="settings-btn settings-btn-primary" style={{ marginTop: 12 }} onClick={() => {
            updateAiProfile({ name: 'NetBot', behavior_mode: 'assistant', autonomy_level: 'suggest', onboarding_completed: true }).then(p => setProfile(p)).catch(() => setError('Failed to create profile'))
          }}>
            Create Profile Manually
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-content">
      {error && <div className="settings-error">{error}</div>}
      {success && <div className="settings-success">{success}</div>}

      {/* Identity */}
      <div className="settings-category">
        <h3 className="settings-category-title">Identity</h3>
        <div className="setting-item">
          <div className="setting-label">AI Name</div>
          <div className="setting-description">What your AI engineer goes by</div>
          <div className="setting-control-block">
            <input
              type="text"
              className="setting-input"
              value={profile.name || ''}
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
              onBlur={() => { saveField({ name: profile.name }); useAssistantNameStore.getState().setName(profile.name); }}
              placeholder="e.g. Atlas, NetBot"
            />
          </div>
        </div>
        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Working Style</span>
            <div className="setting-control">
              <select
                className="setting-select"
                value={profile.behavior_mode || 'assistant'}
                onChange={(e) => {
                  setProfile({ ...profile, behavior_mode: e.target.value })
                  saveField({ behavior_mode: e.target.value })
                }}
              >
                {BEHAVIOR_MODES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="setting-description">How your AI engineer interacts with you</div>
        </div>
        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Autonomy Level</span>
            <div className="setting-control">
              <select
                className="setting-select"
                value={profile.autonomy_level || 'suggest'}
                onChange={(e) => {
                  setProfile({ ...profile, autonomy_level: e.target.value })
                  saveField({ autonomy_level: e.target.value })
                }}
              >
                {AUTONOMY_LEVELS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="setting-description">What happens when the AI finds a problem</div>
        </div>
      </div>

      {/* Expertise */}
      <div className="settings-category">
        <h3 className="settings-category-title">Expertise</h3>

        {/* Unified Knowledge Pack Selector */}
        <div className="setting-item">
          <div className="setting-label">AI Knowledge Packs</div>
          <div className="setting-description">
            Select which knowledge areas to load into AI context. Each pack adds vendor or domain expertise.
            Packs are loaded in the order shown until the budget is full.
          </div>

          {/* Budget bar */}
          {packBudget && (() => {
            const budget = packBudget.available_budget
            // Calculate what's selected
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

            return (
              <div style={{ margin: '12px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                  <span>{(used / 1000).toFixed(1)}k / {(budget / 1000).toFixed(1)}k used</span>
                  <span>{((budget - used) / 1000).toFixed(1)}k remaining</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'var(--color-bg-tertiary, #45475a)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 3, transition: 'width 0.2s',
                    width: `${Math.min(pct, 100)}%`,
                    background: pct > 95 ? '#f38ba8' : pct > 75 ? '#f9e2af' : '#a6e3a1',
                  }} />
                </div>

                {/* Pack toggles */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 12 }}>
                  {allPacks.map(pack => {
                    const isVendor = pack.category === 'vendor'
                    const isEnabled = isVendor
                      ? (profile.vendor_weights[pack.name] ?? 0) > 0
                      : (profile.domain_focus[pack.name] ?? 0) > 0
                    const isLoaded = loaded.includes(pack.name)
                    const wouldFit = !isEnabled ? (used + pack.size <= budget) : true

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

                    const toggle = () => {
                      if (isVendor) {
                        const newWeights = { ...profile.vendor_weights }
                        if (isEnabled) {
                          delete newWeights[pack.name]
                        } else {
                          newWeights[pack.name] = 1.0
                        }
                        setProfile({ ...profile, vendor_weights: newWeights })
                        saveField({ vendor_weights: newWeights })
                      } else {
                        const newFocus = { ...profile.domain_focus }
                        if (isEnabled) {
                          delete newFocus[pack.name]
                        } else {
                          newFocus[pack.name] = 1.0
                        }
                        setProfile({ ...profile, domain_focus: newFocus })
                        saveField({ domain_focus: newFocus })
                      }
                    }

                    return (
                      <div
                        key={pack.name}
                        onClick={wouldFit || isEnabled ? toggle : undefined}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '8px 12px', borderRadius: 6, cursor: wouldFit || isEnabled ? 'pointer' : 'default',
                          background: isEnabled ? 'rgba(137, 180, 250, 0.1)' : 'transparent',
                          border: isEnabled ? '1px solid rgba(137, 180, 250, 0.3)' : '1px solid transparent',
                          opacity: !isEnabled && !wouldFit ? 0.4 : 1,
                          transition: 'all 0.15s',
                        }}
                      >
                        <div style={{
                          width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                          border: isEnabled ? '2px solid #89b4fa' : '2px solid var(--color-border, #45475a)',
                          background: isEnabled ? '#89b4fa' : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 11, color: '#1e1e2e', fontWeight: 700,
                        }}>
                          {isEnabled ? '✓' : ''}
                        </div>
                        <span style={{ flex: 1, fontSize: 13 }}>
                          {PACK_LABELS[pack.name] || pack.name}
                        </span>
                        <span style={{
                          fontSize: 11, fontFamily: 'var(--font-mono, monospace)',
                          color: isEnabled && !isLoaded ? '#f38ba8' : 'var(--color-text-secondary)',
                        }}>
                          {(pack.size / 1000).toFixed(1)}k
                          {isEnabled && !isLoaded && ' · over budget'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}

          {!packBudget && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {/* Fallback: original sliders when pack sizes unavailable */}
              <div className="setting-description" style={{ fontStyle: 'italic' }}>
                Loading knowledge pack information...
              </div>
            </div>
          )}
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Certification Perspective</span>
            <div className="setting-control">
              <select
                className="setting-select"
                value={profile.cert_perspective || 'vendor-neutral'}
                onChange={(e) => {
                  setProfile({ ...profile, cert_perspective: e.target.value })
                  saveField({ cert_perspective: e.target.value })
                }}
              >
                {CERT_PERSPECTIVES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Environment Type</span>
            <div className="setting-control">
              <select
                className="setting-select"
                value={profile.environment_type || 'production'}
                onChange={(e) => {
                  setProfile({ ...profile, environment_type: e.target.value })
                  saveField({ environment_type: e.target.value })
                }}
              >
                {ENVIRONMENT_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Behavior */}
      <div className="settings-category">
        <h3 className="settings-category-title">Behavior</h3>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Verbosity</span>
            <div className="setting-control">
              <select className="setting-select" value={profile.verbosity || 'balanced'}
                onChange={(e) => { setProfile({ ...profile, verbosity: e.target.value }); saveField({ verbosity: e.target.value }) }}>
                {VERBOSITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Risk Tolerance</span>
            <div className="setting-control">
              <select className="setting-select" value={profile.risk_tolerance || 'conservative'}
                onChange={(e) => { setProfile({ ...profile, risk_tolerance: e.target.value }); saveField({ risk_tolerance: e.target.value }) }}>
                {RISK_TOLERANCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Troubleshooting Method</span>
            <div className="setting-control">
              <select className="setting-select" value={profile.troubleshooting_method || 'top-down'}
                onChange={(e) => { setProfile({ ...profile, troubleshooting_method: e.target.value }); saveField({ troubleshooting_method: e.target.value }) }}>
                {TROUBLESHOOTING_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Experience Level</span>
            <div className="setting-control">
              <select className="setting-select" value={profile.user_experience_level || 'mid'}
                onChange={(e) => { setProfile({ ...profile, user_experience_level: e.target.value }); saveField({ user_experience_level: e.target.value }) }}>
                {EXPERIENCE_LEVELS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="setting-description">Calibrates explanation depth</div>
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Syntax Style</span>
            <div className="setting-control">
              <select className="setting-select" value={profile.syntax_style || 'full'}
                onChange={(e) => { setProfile({ ...profile, syntax_style: e.target.value }); saveField({ syntax_style: e.target.value }) }}>
                {SYNTAX_STYLES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-label">Communication Style</div>
          <div className="setting-description">Free-text personality notes (e.g. &quot;Be direct and technical, skip pleasantries&quot;)</div>
          <div className="setting-control-block">
            <AITabInput
              as="textarea"
              className="setting-input"
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
          </div>
        </div>
      </div>

      {/* Safety */}
      <div className="settings-category">
        <h3 className="settings-category-title">Custom Safety Rules</h3>
        <div className="setting-description" style={{ marginBottom: 8 }}>
          Additional safety rules on top of the non-negotiable built-in rules. These are instructions the AI will always follow.
        </div>
        {profile.safety_rules.map((rule, idx) => (
          <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
            <input
              type="text"
              className="setting-input"
              style={{ flex: 1 }}
              value={rule}
              onChange={(e) => {
                const newRules = [...profile.safety_rules]
                newRules[idx] = e.target.value
                setProfile({ ...profile, safety_rules: newRules })
              }}
              onBlur={() => saveField({ safety_rules: profile.safety_rules })}
            />
            <button
              className="settings-btn"
              onClick={() => {
                const newRules = profile.safety_rules.filter((_, i) => i !== idx)
                setProfile({ ...profile, safety_rules: newRules })
                saveField({ safety_rules: newRules })
              }}
              title="Remove rule"
            >
              &times;
            </button>
          </div>
        ))}
        <button
          className="settings-btn"
          style={{ marginTop: 4 }}
          onClick={() => setProfile({ ...profile, safety_rules: [...profile.safety_rules, ''] })}
        >
          + Add Rule
        </button>
      </div>

      {/* Actions */}
      <div className="settings-category">
        <h3 className="settings-category-title">Actions</h3>
        <button className="settings-btn settings-btn-danger" onClick={handleReset}>
          Reset Profile &amp; Re-onboard
        </button>
        <div className="setting-description" style={{ marginTop: 4 }}>
          Clears all profile settings. The onboarding conversation will start next time you open AI chat.
        </div>
      </div>

      {saving && <div className="settings-saving-indicator">Saving...</div>}
    </div>
  )
}
