// API client for NetBox source management

import { getClient, getCurrentMode } from './client';
import type { CliFlavor } from '../types/enrichment';

// Profile mappings for NetBox source (maps site/role slugs to profile IDs)
export interface ProfileMappings {
  by_site: Record<string, string>;
  by_role: Record<string, string>;
}

// CLI flavor mappings for NetBox source (maps manufacturer/platform slugs to CliFlavor)
// Precedence at import time: by_platform > by_manufacturer > 'auto'
export interface CliFlavorMappings {
  by_manufacturer: Record<string, CliFlavor>;
  by_platform: Record<string, CliFlavor>;
}

// Legacy sync filters (single value, used for last_sync_filters)
export interface SyncFilters {
  site?: string;
  role?: string;
}

// Device filters for NetBox import (multi-select, stored on source)
export interface DeviceFilters {
  sites?: string[];        // Site slugs
  roles?: string[];        // Device role slugs
  manufacturers?: string[]; // Manufacturer slugs (vendor)
  platforms?: string[];    // Platform slugs
  statuses?: string[];     // Status values (active, planned, etc.)
  tags?: string[];         // Tag slugs
}

// Result of a NetBox sync operation
export interface SyncResult {
  sessions_created: number;
  sessions_updated: number;
  skipped: number;
}

// NetBox source configuration
export interface NetBoxSource {
  id: string;
  name: string;
  api_resource_id: string;
  default_profile_id: string | null;
  profile_mappings: ProfileMappings;
  cli_flavor_mappings: CliFlavorMappings;
  device_filters: DeviceFilters | null;  // Multi-select filters for import
  last_sync_at: string | null;
  last_sync_filters: SyncFilters | null;
  last_sync_result: SyncResult | null;
  created_at: string;
  updated_at: string;
}

// Request to create a new NetBox source
export interface NewNetBoxSource {
  name: string;
  api_resource_id: string;
  default_profile_id?: string | null;
  profile_mappings?: ProfileMappings;
  cli_flavor_mappings?: CliFlavorMappings;
  device_filters?: DeviceFilters | null;
}

// Request to update a NetBox source (all fields optional for partial updates)
export interface UpdateNetBoxSource {
  name?: string;
  api_resource_id?: string;
  default_profile_id?: string | null;
  profile_mappings?: ProfileMappings;
  cli_flavor_mappings?: CliFlavorMappings;
  device_filters?: DeviceFilters | null;
}

// List all NetBox sources
export async function listNetBoxSources(): Promise<NetBoxSource[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get('/netbox-sources');
  return data;
}

// Get a single NetBox source by ID
export async function getNetBoxSource(id: string): Promise<NetBoxSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('NetBox sources are not available in enterprise mode');
  const { data } = await getClient().http.get(`/netbox-sources/${id}`);
  return data;
}

// Create a new NetBox source
export async function createNetBoxSource(source: NewNetBoxSource): Promise<NetBoxSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('NetBox sources are not available in enterprise mode');
  try {
    const { data } = await getClient().http.post('/netbox-sources', source);
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { code?: string; error?: string } } };
    const responseData = axiosErr.response?.data;
    if (responseData?.code === 'VAULT_LOCKED') {
      throw new Error('Vault is locked. Go to Settings → Security to unlock with your master password.');
    }
    throw new Error(responseData?.error || 'Failed to create NetBox source');
  }
}

// Update an existing NetBox source
export async function updateNetBoxSource(id: string, update: UpdateNetBoxSource): Promise<NetBoxSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('NetBox sources are not available in enterprise mode');
  const { data } = await getClient().http.put(`/netbox-sources/${id}`, update);
  return data;
}

// Delete a NetBox source
export async function deleteNetBoxSource(id: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('NetBox sources are not available in enterprise mode');
  await getClient().http.delete(`/netbox-sources/${id}`);
}

// Test connection to a NetBox source
export async function testNetBoxSource(id: string): Promise<boolean> {
  if (getCurrentMode() === 'enterprise') return false;
  try {
    const { data } = await getClient().http.post(`/netbox-sources/${id}/test`);
    return data.success === true;
  } catch {
    return false;
  }
}

// Test connection with URL and token (for new sources before creation)
export async function testNetBoxConnection(url: string, token: string): Promise<boolean> {
  if (getCurrentMode() === 'enterprise') return false;
  try {
    const { data } = await getClient().http.post('/netbox/test', { url, token });
    return data.success === true;
  } catch {
    return false;
  }
}

// Get API token for a NetBox source (requires vault to be unlocked)
export async function getNetBoxToken(id: string): Promise<string | null> {
  if (getCurrentMode() === 'enterprise') return null;
  const { data } = await getClient().http.get(`/netbox-sources/${id}/token`);
  return data.token;
}

/**
 * Get connection details (base URL + token) for a NetBox source by joining
 * source → api_resource → credentials.
 * Returns null if source or resource not found.
 */
export async function getNetBoxSourceConnection(id: string): Promise<{ base_url: string; token: string } | null> {
  if (getCurrentMode() === 'enterprise') return null;
  try {
    const source = await getNetBoxSource(id);
    if (!source) return null;

    // Dynamic import to avoid circular dependency
    const { getApiResource } = await import('./quickActions');
    const resource = await getApiResource(source.api_resource_id);
    if (!resource) return null;

    const token = await getNetBoxToken(id);
    return { base_url: resource.base_url, token: token || '' };
  } catch (err) {
    console.error('Failed to get NetBox source connection:', err);
    return null;
  }
}

// Request body for sync-complete
export interface SyncCompleteRequest {
  filters: SyncFilters;
  result: SyncResult;
}

// Mark a NetBox source sync as complete
export async function markSyncComplete(id: string, request: SyncCompleteRequest): Promise<NetBoxSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('NetBox sources are not available in enterprise mode');
  const { data } = await getClient().http.post(`/netbox-sources/${id}/sync-complete`, request);
  return data.source;
}
