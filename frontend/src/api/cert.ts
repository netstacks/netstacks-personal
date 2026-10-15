import { getClient } from './client';
import { getCurrentMode } from './client';

export interface CertStatus {
  valid: boolean;
  expires_at: string | null;
  public_key_fingerprint: string | null;
  error: string | null;
}

/**
 * Get cert status from the agent sidecar.
 * In enterprise mode the sidecar is not running — returns a safe default.
 * Certs are managed via the login flow in enterprise mode instead.
 */
export async function getCertStatus(): Promise<CertStatus> {
  if (getCurrentMode() === 'enterprise') {
    return { valid: false, expires_at: null, public_key_fingerprint: null, error: 'Sidecar not available in enterprise mode' };
  }
  const { data } = await getClient().http.get('/cert/status');
  return data;
}
