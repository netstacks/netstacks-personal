// API client for AI Engineer Profile (standalone + enterprise modes)

import { getClient, getCurrentMode } from './client';

export interface AiEngineerProfile {
  id: number;
  name: string | null;
  behavior_mode: string | null;
  autonomy_level: string | null;
  vendor_weights: Record<string, number>;
  domain_focus: Record<string, number>;
  cert_perspective: string | null;
  verbosity: string | null;
  risk_tolerance: string | null;
  troubleshooting_method: string | null;
  syntax_style: string | null;
  user_experience_level: string | null;
  environment_type: string | null;
  safety_rules: string[];
  communication_style: string | null;
  onboarding_completed: boolean;
}

export interface UpdateAiEngineerProfile {
  name?: string | null;
  behavior_mode?: string | null;
  autonomy_level?: string | null;
  vendor_weights?: Record<string, number>;
  domain_focus?: Record<string, number>;
  cert_perspective?: string | null;
  verbosity?: string | null;
  risk_tolerance?: string | null;
  troubleshooting_method?: string | null;
  syntax_style?: string | null;
  user_experience_level?: string | null;
  environment_type?: string | null;
  safety_rules?: string[];
  communication_style?: string | null;
  onboarding_completed?: boolean;
}

// Enterprise-mode profile types (from Controller API)
export interface EnterpriseAiProfile {
  id: string;
  name: string;
  description: string | null;
  behavior_mode: string;
  autonomy_level: string;
  vendor_weights: Record<string, number>;
  domain_focus: Record<string, number>;
  cert_perspective: string | null;
  verbosity: string | null;
  risk_tolerance: string | null;
  troubleshooting_method: string | null;
  syntax_style: string | null;
  user_experience_level: string | null;
  environment_type: string | null;
  enabled: boolean;
}

export interface ActiveProfileResponse {
  profile_id: string | null;
  profile: EnterpriseAiProfile | null;
}

// === Standalone mode (agent sidecar) ===

/** Map the controller's enterprise AI profile shape onto the standalone
 *  AiEngineerProfile shape so shared consumers (assistant name, settings)
 *  keep working. The controller is the source of truth for these fields;
 *  standalone-only fields (safety_rules/communication_style) default empty. */
function enterpriseToAiEngineerProfile(p: EnterpriseAiProfile): AiEngineerProfile {
  return {
    id: 1,
    name: p.name,
    behavior_mode: p.behavior_mode,
    autonomy_level: p.autonomy_level,
    vendor_weights: p.vendor_weights ?? {},
    domain_focus: p.domain_focus ?? {},
    cert_perspective: p.cert_perspective,
    verbosity: p.verbosity,
    risk_tolerance: p.risk_tolerance,
    troubleshooting_method: p.troubleshooting_method,
    syntax_style: p.syntax_style,
    user_experience_level: p.user_experience_level,
    environment_type: p.environment_type,
    safety_rules: [],
    communication_style: null,
    onboarding_completed: true,
  };
}

export async function getAiProfile(): Promise<AiEngineerProfile | null> {
  try {
    // Enterprise: there is no /ai/profile — the controller exposes the user's
    // active AI profile at /ai-profiles/active. Adapt its shape for callers.
    if (getCurrentMode() === 'enterprise') {
      const { data } = await getClient().http.get('/ai-profiles/active');
      const active = (data as ActiveProfileResponse).profile;
      return active ? enterpriseToAiEngineerProfile(active) : null;
    }
    const { data } = await getClient().http.get('/ai/profile');
    return data.profile ?? null;
  } catch {
    return null;
  }
}

const DEFAULT_PROFILE: AiEngineerProfile = {
  id: 1,
  name: null,
  behavior_mode: 'assistant',
  autonomy_level: 'suggest',
  vendor_weights: {},
  domain_focus: {},
  cert_perspective: 'vendor-neutral',
  verbosity: 'balanced',
  risk_tolerance: 'conservative',
  troubleshooting_method: 'top-down',
  syntax_style: 'full',
  user_experience_level: 'mid',
  environment_type: 'production',
  safety_rules: [],
  communication_style: null,
  onboarding_completed: false,
};

export async function updateAiProfile(update: UpdateAiEngineerProfile): Promise<AiEngineerProfile> {
  // Enterprise AI profiles are org-managed (Admin → AI Profiles); users only
  // *select* an active profile (see setActiveProfile) — they can't edit fields.
  // The standalone editor tab isn't rendered in enterprise, so this shouldn't
  // fire, but guard against a 404 just in case.
  if (getCurrentMode() === 'enterprise') {
    throw new Error('AI engineer profile editing is not available in enterprise mode');
  }
  // Backend expects full AiEngineerProfile, so merge with existing or defaults.
  const existing = await getAiProfile();
  const merged = { ...(existing ?? DEFAULT_PROFILE), ...update };
  // Once onboarding is complete, never accidentally revert it.
  // Only an explicit resetAiProfile() should clear onboarding state.
  if (existing?.onboarding_completed) {
    merged.onboarding_completed = true;
  }
  await getClient().http.put('/ai/profile', merged);
  // Re-fetch to get the saved state
  const saved = await getAiProfile();
  if (!saved) throw new Error('Failed to save profile');
  return saved;
}

export async function resetAiProfile(): Promise<void> {
  // TODO: controller has no clear-active route; DELETE /ai/profile is standalone-only.
  // No-op in enterprise so this never hits a 404.
  if (getCurrentMode() === 'enterprise') return;
  await getClient().http.delete('/ai/profile');
}

export async function isOnboarded(): Promise<boolean> {
  try {
    // Enterprise has no /ai/profile/status — derive onboarding state from
    // whether the user currently has an active profile selected.
    if (getCurrentMode() === 'enterprise') {
      const { data } = await getClient().http.get('/ai-profiles/active');
      return !!(data as ActiveProfileResponse).profile;
    }
    const { data } = await getClient().http.get('/ai/profile/status');
    return data.onboarded ?? false;
  } catch {
    return false;
  }
}

// === Enterprise mode (controller) ===

export async function getAvailableProfiles(): Promise<EnterpriseAiProfile[]> {
  const { data } = await getClient().http.get('/ai-profiles');
  return data.profiles ?? data;
}

export async function getActiveProfile(): Promise<ActiveProfileResponse> {
  const { data } = await getClient().http.get('/ai-profiles/active');
  return data;
}

export async function setActiveProfile(profileId: string | null): Promise<void> {
  await getClient().http.put('/ai-profiles/active', { profile_id: profileId });
}
