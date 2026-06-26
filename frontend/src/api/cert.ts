import { getClient } from './client';
import { getCurrentMode } from './client';
import type { SignedCertInfo } from '../types/auth';

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

/**
 * Get the agent's SSH public key for certificate signing.
 * This goes to the local agent sidecar since the key is generated locally.
 * In enterprise mode, the key is generated during login and stored in authStore.
 */
export async function getCertPublicKey(): Promise<string> {
  if (getCurrentMode() === 'enterprise') throw new Error('Cert public key not available — sidecar not running in enterprise mode');
  const { data } = await getClient().http.get('/cert/public-key');
  return data;
}

/**
 * Store a signed certificate on the local agent sidecar.
 * Not available in enterprise mode (sidecar not running).
 */
export async function storeCertificate(certInfo: SignedCertInfo): Promise<CertStatus> {
  if (getCurrentMode() === 'enterprise') throw new Error('Cert storage not available in enterprise mode');
  const { data } = await getClient().http.post('/cert/store', certInfo);
  return data;
}
