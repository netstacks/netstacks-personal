// API client for SMTP configuration management

import { getClient, getCurrentMode } from './client';

// SMTP configuration (without password)
export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  use_tls: boolean;
  from_email: string;
  from_name: string | null;
  has_password: boolean;
}

// Request to save SMTP configuration
export interface SaveSmtpConfigRequest {
  host: string;
  port: number;
  username: string;
  password?: string;
  use_tls: boolean;
  from_email: string;
  from_name?: string | null;
}

// Request to test SMTP connection
export interface TestSmtpRequest {
  host: string;
  port: number;
  username: string;
  password: string;
  use_tls: boolean;
  from_email: string;
  from_name?: string | null;
}

// Response from SMTP test
export interface TestSmtpResponse {
  success: boolean;
  error: string | null;
}

// Get SMTP configuration
export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  if (getCurrentMode() === 'enterprise') return null;
  const { data } = await getClient().http.get('/smtp/config');
  return data;
}

// Save SMTP configuration
export async function saveSmtpConfig(config: SaveSmtpConfigRequest): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('SMTP configuration is not available in enterprise mode');
  try {
    await getClient().http.post('/smtp/config', config);
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { code?: string; error?: string } } };
    const responseData = axiosErr.response?.data;
    if (responseData?.code === 'VAULT_LOCKED') {
      throw new Error('Vault is locked. Go to Settings > Security to unlock with your master password.');
    }
    throw new Error(responseData?.error || 'Failed to save SMTP configuration');
  }
}

// Delete SMTP configuration
export async function deleteSmtpConfig(): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('SMTP configuration is not available in enterprise mode');
  await getClient().http.delete('/smtp/config');
}

// Test SMTP connection
export async function testSmtpConnection(config: TestSmtpRequest): Promise<TestSmtpResponse> {
  if (getCurrentMode() === 'enterprise') return { success: false, error: 'Not available in enterprise mode' };
  const { data } = await getClient().http.post('/smtp/test', config);
  return data;
}
