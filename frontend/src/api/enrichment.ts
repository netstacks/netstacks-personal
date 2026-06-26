// API client for hover enrichment — matchers, sources, and the runtime
// /enrich/* lookup endpoints consumed by the terminal hover popover.
//
// Unlike highlightRules, enrichment is always agent-backed (matchers/sources
// live in the agent DB and the lookups call out to integrations), so there is
// no localStorage fallback. All calls go through getClient().http.

import { getClient } from './client';

// === Runtime lookup types (mirror agent enrich responses) ===

export interface PickedField {
  key: string;
  label: string;
  /** "string" | "datetime" | "uptime" | "bytes" | "status_pill" */
  format: string;
}

/** GET /enrich/active-matchers */
export interface ActiveMatcher {
  name: string;
  patterns: string[];
  cli_flavors: string[];
  priority: number;
}

export interface ActiveMatchersResult {
  matchers: ActiveMatcher[];
  crawler_available: boolean;
  netbox_available: boolean;
}

/** POST /enrich/match */
export interface EnrichMatchResponse {
  token: string;
  token_normalized: string;
  matcher_name: string | null;
  source_names: string[];
}

/** POST /enrich/source */
export interface EnrichSourceResponse {
  source: string;
  data: unknown | null;
  error: string | null;
}

/** Per-feature client settings (drives popup gating + source filtering). */
export interface EnrichmentClientSettings {
  hoverEnabled: boolean;
  aiDigestEnabled: boolean;
  disabledSources: string[];
}

// === Matcher / Source management types ===

export interface EnrichmentMatcher {
  id: string;
  name: string;
  description: string;
  patterns: string[];
  cli_flavors: string[];
  priority: number;
  is_builtin: boolean;
  source_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface CreateEnrichmentMatcherRequest {
  name: string;
  description?: string;
  patterns: string[];
  cli_flavors?: string[];
  priority?: number;
}

export interface UpdateEnrichmentMatcherRequest {
  name?: string;
  description?: string;
  patterns?: string[];
  cli_flavors?: string[];
  priority?: number;
}

export interface EnrichmentSource {
  id: string;
  name: string;
  description: string;
  /** "api_resource" | "builtin" */
  kind: string;
  api_resource_id: string | null;
  method: string;
  path_template: string;
  response_unwrap: string;
  picked_fields: PickedField[];
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateEnrichmentSourceRequest {
  name: string;
  description?: string;
  kind?: string;
  api_resource_id?: string | null;
  method?: string;
  path_template?: string;
  response_unwrap?: string;
  picked_fields?: PickedField[];
}

export interface UpdateEnrichmentSourceRequest {
  name?: string;
  description?: string;
  api_resource_id?: string | null;
  method?: string;
  path_template?: string;
  response_unwrap?: string;
  picked_fields?: PickedField[];
}

export interface MatcherTestMatchRange {
  start: number;
  end: number;
  text: string;
}

export interface MatcherTestMatch {
  pattern: string;
  matches: MatcherTestMatchRange[];
  error: string | null;
}

export interface EnrichmentSourceTestResult {
  success: boolean;
  status_code: number | null;
  duration_ms: number;
  url: string;
  raw_response: unknown | null;
  unwrapped: unknown | null;
  flattened_keys: string[];
  error: string | null;
}

// =============================================================================
// Runtime lookups (used by the hover popover)
// =============================================================================

export async function getActiveMatchers(): Promise<ActiveMatchersResult> {
  const { data } = await getClient().http.get('/enrich/active-matchers');
  return data;
}

export async function enrichMatch(
  token: string,
  sessionId?: string | null,
  cliFlavor?: string | null
): Promise<EnrichMatchResponse> {
  const { data } = await getClient().http.post('/enrich/match', {
    token,
    session_id: sessionId ?? null,
    cli_flavor: cliFlavor ?? null,
  });
  return data;
}

export async function enrichSource(
  token: string,
  source: string,
  sessionId?: string | null
): Promise<EnrichSourceResponse> {
  const { data } = await getClient().http.post('/enrich/source', {
    token,
    source,
    session_id: sessionId ?? null,
  });
  return data;
}

// =============================================================================
// Matcher CRUD
// =============================================================================

export async function listMatchers(): Promise<EnrichmentMatcher[]> {
  const { data } = await getClient().http.get('/enrichment-matchers');
  return data;
}

export async function getMatcher(id: string): Promise<EnrichmentMatcher> {
  const { data } = await getClient().http.get(`/enrichment-matchers/${encodeURIComponent(id)}`);
  return data;
}

export async function createMatcher(req: CreateEnrichmentMatcherRequest): Promise<EnrichmentMatcher> {
  const { data } = await getClient().http.post('/enrichment-matchers', req);
  return data;
}

export async function updateMatcher(id: string, req: UpdateEnrichmentMatcherRequest): Promise<void> {
  await getClient().http.put(`/enrichment-matchers/${encodeURIComponent(id)}`, req);
}

export async function deleteMatcher(id: string): Promise<void> {
  await getClient().http.delete(`/enrichment-matchers/${encodeURIComponent(id)}`);
}

export async function testMatcher(patterns: string[], sampleText: string): Promise<MatcherTestMatch[]> {
  const { data } = await getClient().http.post('/enrichment-matchers/test', {
    patterns,
    sample_text: sampleText,
  });
  return data;
}

export async function replaceMatcherSources(matcherId: string, sourceIds: string[]): Promise<void> {
  await getClient().http.put(`/enrichment-matchers/${encodeURIComponent(matcherId)}/sources`, {
    source_ids: sourceIds,
  });
}

// =============================================================================
// Source CRUD
// =============================================================================

export async function listSources(): Promise<EnrichmentSource[]> {
  const { data } = await getClient().http.get('/enrichment-sources');
  return data;
}

export async function getSource(id: string): Promise<EnrichmentSource> {
  const { data } = await getClient().http.get(`/enrichment-sources/${encodeURIComponent(id)}`);
  return data;
}

export async function createSource(req: CreateEnrichmentSourceRequest): Promise<EnrichmentSource> {
  const { data } = await getClient().http.post('/enrichment-sources', req);
  return data;
}

export async function updateSource(id: string, req: UpdateEnrichmentSourceRequest): Promise<void> {
  await getClient().http.put(`/enrichment-sources/${encodeURIComponent(id)}`, req);
}

export async function deleteSource(id: string): Promise<void> {
  await getClient().http.delete(`/enrichment-sources/${encodeURIComponent(id)}`);
}

export interface TestSourceRequest {
  api_resource_id?: string | null;
  method?: string;
  path_template: string;
  response_unwrap?: string;
  sample_token: string;
  sample_session_host?: string | null;
  sample_session_name?: string | null;
}

export async function testSource(req: TestSourceRequest): Promise<EnrichmentSourceTestResult> {
  const { data } = await getClient().http.post('/enrichment-sources/test', req);
  return data;
}

// =============================================================================
// Lifecycle
// =============================================================================

/** Reload the agent's in-memory matcher/source registry after any CRUD edit. */
export async function reloadEnrichment(): Promise<void> {
  await getClient().http.post('/enrichment/reload', {});
}

export async function exportEnrichment(): Promise<string> {
  const { data } = await getClient().http.post('/enrichment/export', {});
  return typeof data === 'string' ? data : (data?.toml ?? '');
}

export interface EnrichmentImportResult {
  matchers_added: number;
  matchers_updated: number;
  sources_added: number;
  sources_updated: number;
  assignments_updated: number;
}

/** Import matchers/sources from a TOML blob. `overwrite` replaces existing
 *  rows by name; otherwise only new rows are added (safe append). */
export async function importEnrichment(toml: string, overwrite: boolean): Promise<EnrichmentImportResult> {
  const { data } = await getClient().http.post('/enrichment/import', { toml, overwrite });
  return data;
}
