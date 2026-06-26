/**
 * Network Lookup API Client (Phase 19)
 *
 * Direct API calls for network lookups - no AI needed.
 * Results returned instantly for display in UI.
 *
 * Uses getClient().http which routes to sidecar (Personal mode)
 * or Controller (Enterprise mode) automatically.
 */

import { getClient } from './client';

// ============================================
// Types
// ============================================

export interface OuiLookupResult {
  mac: string;
  vendor: string | null;
  error: string | null;
}

export interface DnsLookupResult {
  query: string;
  query_type: string;
  results: string[];
  error: string | null;
}

export interface WhoisSummary {
  organization: string | null;
  country: string | null;
  network_name: string | null;
  cidr: string | null;
  description: string | null;
}

export interface WhoisLookupResult {
  query: string;
  summary: WhoisSummary | null;
  raw: string | null;
  error: string | null;
}

export interface AsnLookupResult {
  asn: string;
  name: string | null;
  description: string | null;
  country: string | null;
  error: string | null;
}

// ============================================
// API Functions
// ============================================

/**
 * Look up OUI (Organizationally Unique Identifier) for a MAC address
 * Returns vendor/manufacturer name
 */
export async function lookupOui(mac: string): Promise<OuiLookupResult> {
  try {
    const res = await getClient().http.get(`/lookup/oui/${encodeURIComponent(mac)}`);
    return res.data;
  } catch {
    return { mac, vendor: null, error: 'Lookup request failed' };
  }
}

/**
 * DNS lookup - forward (hostname→IP) or reverse (IP→hostname)
 */
export async function lookupDns(query: string): Promise<DnsLookupResult> {
  try {
    const res = await getClient().http.get(`/lookup/dns/${encodeURIComponent(query)}`);
    return res.data;
  } catch {
    return { query, query_type: 'unknown', results: [], error: 'Lookup request failed' };
  }
}

/**
 * WHOIS lookup for IP addresses or domains
 */
export async function lookupWhois(query: string): Promise<WhoisLookupResult> {
  try {
    const res = await getClient().http.get(`/lookup/whois/${encodeURIComponent(query)}`);
    return res.data;
  } catch {
    return { query, summary: null, raw: null, error: 'Lookup request failed' };
  }
}

/**
 * ASN (Autonomous System Number) lookup
 */
export async function lookupAsn(asn: string): Promise<AsnLookupResult> {
  try {
    const res = await getClient().http.get(`/lookup/asn/${encodeURIComponent(asn)}`);
    return res.data;
  } catch {
    return { asn, name: null, description: null, country: null, error: 'Lookup request failed' };
  }
}

// ============================================
// Formatted Display Helpers
// ============================================

/**
 * Format OUI result for display
 */
export function formatOuiResult(result: OuiLookupResult): string {
  if (!result || result.error) {
    return `OUI Lookup failed: ${result?.error || 'Unknown error'}`;
  }
  return result.vendor || 'Unknown vendor';
}

/**
 * Format DNS result for display
 */
export function formatDnsResult(result: DnsLookupResult): string {
  if (!result || result.error) {
    return `DNS Lookup failed: ${result?.error || 'Unknown error'}`;
  }
  if (!result.results || result.results.length === 0) {
    return 'No records found';
  }
  return result.results.join(', ');
}

/**
 * Format WHOIS result for display (summary)
 */
export function formatWhoisResult(result: WhoisLookupResult): string {
  if (!result || result.error) {
    return `WHOIS Lookup failed: ${result?.error || 'Unknown error'}`;
  }
  if (!result.summary) {
    return 'No WHOIS data available';
  }

  const parts: string[] = [];
  if (result.summary.organization) {
    parts.push(result.summary.organization);
  }
  if (result.summary.network_name) {
    parts.push(`(${result.summary.network_name})`);
  }
  if (result.summary.country) {
    parts.push(`[${result.summary.country}]`);
  }
  if (result.summary.cidr) {
    parts.push(`CIDR: ${result.summary.cidr}`);
  }

  return parts.length > 0 ? parts.join(' ') : 'No organization info available';
}

/**
 * Format ASN result for display
 */
export function formatAsnResult(result: AsnLookupResult): string {
  if (!result || result.error) {
    return `ASN Lookup failed: ${result?.error || 'Unknown error'}`;
  }

  const parts: string[] = [result.asn];
  if (result.name) {
    parts.push(result.name);
  }
  if (result.description && result.description !== result.name) {
    parts.push(`- ${result.description}`);
  }
  if (result.country) {
    parts.push(`[${result.country}]`);
  }

  return parts.join(' ');
}
