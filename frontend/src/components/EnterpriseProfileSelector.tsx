import { useState, useEffect, useCallback } from 'react'
import {
  getAvailableProfiles,
  getActiveProfile,
  setActiveProfile,
  type EnterpriseAiProfile,
} from '../api/aiEngineerProfile'

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
    return <div className="settings-content"><div className="settings-empty">Loading profiles...</div></div>
  }

  return (
    <div className="settings-content">
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-category">
        <h3 className="settings-category-title">AI Engineer Profile</h3>
        <div className="setting-description" style={{ marginBottom: 12 }}>
          Your organization&apos;s admin manages AI engineer profiles. Select which profile to use for all AI features.
        </div>

        <div className="setting-item">
          <div className="setting-header">
            <span className="setting-label">Active Profile</span>
            <div className="setting-control">
              <select
                className="setting-select"
                value={activeProfileId || ''}
                onChange={(e) => handleSelect(e.target.value || null)}
                disabled={saving}
              >
                <option value="">None (use default AI)</option>
                {profiles.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="setting-description">
            {profiles.length === 0
              ? 'No profiles available. Ask your admin to create AI engineer profiles.'
              : `${profiles.length} profile${profiles.length !== 1 ? 's' : ''} available`}
          </div>
        </div>
      </div>

      {/* Show detail of selected profile */}
      {activeProfileDetail && (
        <div className="settings-category">
          <h3 className="settings-category-title">Profile Details: {activeProfileDetail.name}</h3>
          {activeProfileDetail.description && (
            <div className="setting-description" style={{ marginBottom: 8 }}>{activeProfileDetail.description}</div>
          )}
          <div className="setting-item">
            <div className="setting-label">Working Style</div>
            <div className="setting-description" style={{ textTransform: 'capitalize' }}>{activeProfileDetail.behavior_mode}</div>
          </div>
          <div className="setting-item">
            <div className="setting-label">Autonomy</div>
            <div className="setting-description" style={{ textTransform: 'capitalize' }}>{activeProfileDetail.autonomy_level}</div>
          </div>
          {Object.keys(activeProfileDetail.vendor_weights).length > 0 && (
            <div className="setting-item">
              <div className="setting-label">Vendor Focus</div>
              <div className="setting-description">
                {Object.entries(activeProfileDetail.vendor_weights)
                  .sort(([,a], [,b]) => b - a)
                  .map(([vendor, weight]) => `${vendor} (${Math.round(weight * 100)}%)`)
                  .join(', ')}
              </div>
            </div>
          )}
          {Object.keys(activeProfileDetail.domain_focus).length > 0 && (
            <div className="setting-item">
              <div className="setting-label">Domain Focus</div>
              <div className="setting-description">
                {Object.entries(activeProfileDetail.domain_focus)
                  .sort(([,a], [,b]) => b - a)
                  .map(([domain]) => domain.replace('_', ' '))
                  .join(', ')}
              </div>
            </div>
          )}
          {activeProfileDetail.verbosity && (
            <div className="setting-item">
              <div className="setting-label">Verbosity</div>
              <div className="setting-description" style={{ textTransform: 'capitalize' }}>{activeProfileDetail.verbosity}</div>
            </div>
          )}
          {activeProfileDetail.risk_tolerance && (
            <div className="setting-item">
              <div className="setting-label">Risk Tolerance</div>
              <div className="setting-description" style={{ textTransform: 'capitalize' }}>{activeProfileDetail.risk_tolerance}</div>
            </div>
          )}
        </div>
      )}

      {saving && <div className="settings-saving-indicator">Saving...</div>}
    </div>
  )
}
