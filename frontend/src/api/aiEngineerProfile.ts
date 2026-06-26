// API client for AI Engineer Profile (standalone + enterprise modes)

import { getClient } from './client';

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

export async function getAiProfile(): Promise<AiEngineerProfile | null> {
  try {
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
  await getClient().http.delete('/ai/profile');
}

export async function isOnboarded(): Promise<boolean> {
  try {
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
