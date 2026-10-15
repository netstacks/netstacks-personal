import { useState, useEffect, useCallback } from 'react'
import {
  getAvailableProfiles,
  getActiveProfile,
  setActiveProfile,
  type EnterpriseAiProfile,
} from '../api/aiEngineerProfile'
import SettingsSection from './settings/SettingsSection'
import SettingRow from './settings/SettingRow'
import './EnterpriseProfileSelector.css'

export default function EnterpriseProfileSelector() {
  const [profiles, setProfiles] = useState<EnterpriseAiProfile[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  const [activeProfileDetail, setActiveProfileDetail] = useState<EnterpriseAiProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [available, active] = await Promise.all([getAvailableProfiles(), getActiveProfile()])
      setProfiles(available)
      setActiveProfileId(active.profile_id)
      setActiveProfileDetail(active.profile ?? null)
    } catch {
      setError('Failed to load AI profiles from controller')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleSelect = async (profileId: string | null) => {
    setSaving(true)
    setError(null)
    try {
      await setActiveProfile(profileId)
      setActiveProfileId(profileId)
      setActiveProfileDetail(profiles.find(p => p.id === profileId) ?? null)
    } catch {
      setError('Failed to set active profile')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <p className="form-hint">Loading profiles…</p>
  }

  const detail = (label: string, value: string) => (
    <SettingRow label={label}><span className="enterprise-ai-profile-value">{value}</span></SettingRow>
  )

  return (
    <>
      <SettingsSection
        title="AI Engineer Profile"
        description="Your organization's admin manages AI engineer profiles. Select which profile to use for all AI features."
      >
        {error && <p className="settings-error">{error}</p>}
        <div className="settings-group">
          <SettingRow
            label="Active Profile"
            description={profiles.length === 0
              ? 'No profiles available. Ask your admin to create AI engineer profiles.'
              : `${profiles.length} profile${profiles.length !== 1 ? 's' : ''} available`}
          >
            <select aria-label="Active Profile"
              className="ns-select setting-select-field"
              value={activeProfileId || ''}
              onChange={(e) => handleSelect(e.target.value || null)}
              disabled={saving}
            >
              <option value="">None (use default AI)</option>
              {profiles.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </SettingRow>
        </div>
        {saving && <p className="form-hint">Saving…</p>}
      </SettingsSection>

      {activeProfileDetail && (
        <SettingsSection title={`Profile Details: ${activeProfileDetail.name}`} description={activeProfileDetail.description || undefined}>
          <div className="settings-group">
            {detail('Working Style', activeProfileDetail.behavior_mode)}
            {detail('Autonomy', activeProfileDetail.autonomy_level)}
            {Object.keys(activeProfileDetail.vendor_weights).length > 0 && detail(
              'Vendor Focus',
              Object.entries(activeProfileDetail.vendor_weights)
                .sort(([,a], [,b]) => b - a)
                .map(([vendor, weight]) => `${vendor} (${Math.round(weight * 100)}%)`)
                .join(', '),
            )}
            {Object.keys(activeProfileDetail.domain_focus).length > 0 && detail(
              'Domain Focus',
              Object.entries(activeProfileDetail.domain_focus)
                .sort(([,a], [,b]) => b - a)
                .map(([domain]) => domain.replace('_', ' '))
                .join(', '),
            )}
            {activeProfileDetail.verbosity && detail('Verbosity', activeProfileDetail.verbosity)}
            {activeProfileDetail.risk_tolerance && detail('Risk Tolerance', activeProfileDetail.risk_tolerance)}
          </div>
        </SettingsSection>
      )}
    </>
  )
}
