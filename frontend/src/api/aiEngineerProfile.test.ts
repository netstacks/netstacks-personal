import { describe, it, expect, vi, beforeEach } from 'vitest';

const http = {
  get: vi.fn(),
  put: vi.fn(),
};

vi.mock('./client', () => ({
  getClient: () => ({ http }),
  getCurrentMode: () => 'standalone',
}));

import { updateAiProfile } from './aiEngineerProfile';

describe('updateAiProfile (NS-API-22)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses to write when the pre-read fails (would wipe the profile)', async () => {
    http.get.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(updateAiProfile({ verbosity: 'terse' })).rejects.toThrow(/Could not read/);
    expect(http.put).not.toHaveBeenCalled();
  });

  it('merges onto the existing profile when the read succeeds', async () => {
    const existing = {
      id: 1, name: 'Chris', behavior_mode: 'assistant', autonomy_level: 'suggest',
      vendor_weights: { cisco: 1 }, domain_focus: {}, cert_perspective: 'ccie',
      verbosity: 'balanced', risk_tolerance: 'conservative', troubleshooting_method: 'top-down',
      syntax_style: 'full', user_experience_level: 'senior', environment_type: 'production',
      safety_rules: ['no reload'], communication_style: null, onboarding_completed: true,
    };
    http.get.mockResolvedValueOnce({ data: { profile: existing } });
    http.put.mockResolvedValueOnce({ data: { success: true } });
    http.get.mockResolvedValueOnce({ data: { profile: { ...existing, verbosity: 'terse' } } });
    const saved = await updateAiProfile({ verbosity: 'terse' });
    expect(http.put).toHaveBeenCalledWith('/ai/profile', { ...existing, verbosity: 'terse' });
    expect(saved.name).toBe('Chris');
  });

  it('starts from defaults only when the backend reports no profile', async () => {
    http.get.mockResolvedValueOnce({ data: { profile: null } });
    http.put.mockResolvedValueOnce({ data: { success: true } });
    http.get.mockResolvedValueOnce({ data: { profile: { id: 1, name: 'New', onboarding_completed: false } } });
    await updateAiProfile({ name: 'New' });
    const body = http.put.mock.calls[0][1] as { name: string; onboarding_completed: boolean };
    expect(body.name).toBe('New');
    expect(body.onboarding_completed).toBe(false);
  });
});
