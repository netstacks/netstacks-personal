/**
 * TLS Trust Bootstrapping API
 *
 * Handles fetching the Controller's CA certificate and installing it
 * in the OS trust store via Tauri commands.
 */

import axios from 'axios';

/** CA certificate info from the Controller */
export interface CaCertificateInfo {
  tls_enabled: boolean;
  fingerprint: string | null;
  ca_certificate_pem: string | null;
}

/**
 * Fetch CA certificate info from the Controller.
 * Uses a plain HTTP request (not the authenticated client) since
 * this is needed before TLS trust is established.
 *
 * Tries HTTPS first, falls back to HTTP if TLS fails.
 */
export async function fetchCaCertificateInfo(controllerUrl: string): Promise<CaCertificateInfo | null> {
  // Try HTTPS version of the URL first
  const httpsUrl = controllerUrl.replace(/^http:/, 'https:');
  const httpUrl = controllerUrl.replace(/^https:/, 'http:');

  // Try fetching from HTTP (works when TLS isn't trusted yet)
  for (const baseUrl of [httpUrl, httpsUrl]) {
    try {
      const res = await axios.get(`${baseUrl}/api/tls/ca-certificate/info`, {
        timeout: 5000,
        // Skip TLS verification for this bootstrap request
        httpsAgent: undefined,
      });
      return res.data as CaCertificateInfo;
    } catch {
      // Try next URL
    }
  }

  return null;
}

/**
 * Install a CA certificate into the OS trust store via Tauri command.
 * Only available in Tauri desktop app (not in browser).
 *
 * @returns Success message or throws with error message
 */
export async function installCaCertificate(pemContent: string): Promise<string> {
  // Check if Tauri is available
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error(
      'CA certificate installation requires the NetStacks desktop app. ' +
      'Download the CA certificate and install it manually in your OS trust store.'
    );
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('install_ca_certificate', {
    pemContent,
    filename: 'netstacks-controller-ca.pem',
  });
}

/**
 * Check if the Controller URL uses HTTPS.
 */
export function isHttps(controllerUrl: string): boolean {
  return controllerUrl.startsWith('https://');
}

/**
 * Convert an HTTP controller URL to HTTPS.
 */
export function toHttps(controllerUrl: string): string {
  return controllerUrl.replace(/^http:/, 'https:');
}
