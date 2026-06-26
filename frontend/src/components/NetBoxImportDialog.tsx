import { useState, useEffect, useCallback } from 'react';
import './NetBoxImportDialog.css';
import {
  checkNetBoxConnection,
  fetchSites,
  fetchRoles,
  importDevicesAsSessions,
  type NetBoxSite,
  type NetBoxRole,
  type SessionImportResult,
  type ImportSourceConfig,
} from '../api/netbox';
import type { NetBoxConfig } from '../types/topology';
import { createSession, createFolder, listFolders, listSessions } from '../api/sessions';
import {
  listNetBoxSources,
  getNetBoxSourceConnection,
  markSyncComplete,
  type NetBoxSource,
  type DeviceFilters,
} from '../api/netboxSources';
import { listProfiles, type CredentialProfile } from '../api/profiles';
import { PasswordInput } from './PasswordInput';
import { copyToClipboard } from '../lib/clipboard';

// Helper to format device filters for display
import { getErrorMessage } from '../api/errors'
function formatDeviceFilters(filters: DeviceFilters): string {
  const parts: string[] = [];
  if (filters.sites?.length) parts.push(`Sites: ${filters.sites.join(', ')}`);
  if (filters.roles?.length) parts.push(`Roles: ${filters.roles.join(', ')}`);
  if (filters.manufacturers?.length) parts.push(`Vendors: ${filters.manufacturers.join(', ')}`);
  if (filters.platforms?.length) parts.push(`Platforms: ${filters.platforms.join(', ')}`);
  if (filters.statuses?.length) parts.push(`Statuses: ${filters.statuses.join(', ')}`);
  if (filters.tags?.length) parts.push(`Tags: ${filters.tags.join(', ')}`);
  return parts.length > 0 ? parts.join(' | ') : 'No filters';
}

// Categories the import warnings get bucketed into for the report panel.
type WarningCategory =
  | 'already_exists'
  | 'no_primary_ip'
  | 'no_profile'
  | 'folder_failed'
  | 'create_failed'
  | 'other';

const WARNING_CATEGORY_LABELS: Record<WarningCategory, string> = {
  already_exists: 'Already imported (session exists)',
  no_primary_ip: 'No primary IP in NetBox',
  no_profile: 'No credential profile mapped',
  folder_failed: 'Folder creation failed',
  create_failed: 'Backend rejected session',
  other: 'Other',
};

function classifyWarning(w: string): WarningCategory {
  if (w.startsWith('Skipped ') && w.endsWith(': session already exists')) return 'already_exists';
  if (w.startsWith('Skipped ') && w.endsWith(': no primary IP')) return 'no_primary_ip';
  if (w.startsWith('Skipped ') && w.endsWith(': no credential profile configured')) return 'no_profile';
  if (w.startsWith('Failed to create folder ')) return 'folder_failed';
  if (w.startsWith('Failed to create session for ')) return 'create_failed';
  return 'other';
}

function groupWarnings(warnings: string[]): Record<WarningCategory, string[]> {
  const groups: Record<WarningCategory, string[]> = {
    already_exists: [],
    no_primary_ip: [],
    no_profile: [],
    folder_failed: [],
    create_failed: [],
    other: [],
  };
  for (const w of warnings) groups[classifyWarning(w)].push(w);
  return groups;
}

// Build a plain-text version of the report for the copy-to-clipboard button.
function buildReportText(result: SessionImportResult): string {
  const c = result.counts;
  const lines: string[] = ['NetBox Import Report', ''];
  if (c) {
    lines.push(`  Fetched from NetBox:  ${c.fetched}`);
    lines.push(`  With primary IP:      ${c.with_primary_ip}`);
    lines.push(`  Created:              ${c.created}`);
    lines.push(`  Folders created:      ${result.folders_created}`);
    lines.push(`  Already imported:     ${c.already_exists}`);
    lines.push(`  No primary IP:        ${c.no_primary_ip}`);
    lines.push(`  No profile mapped:    ${c.no_profile}`);
    lines.push(`  Folder creation failed: ${c.folder_failed}`);
    lines.push(`  Backend rejected:     ${c.create_failed}`);
    lines.push(`  Existing sessions in DB: ${c.existing_sessions}`);
  } else {
    lines.push(`  Created: ${result.sessions_created}`);
    lines.push(`  Folders: ${result.folders_created}`);
    lines.push(`  Skipped: ${result.skipped}`);
  }
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings & errors:');
    const groups = groupWarnings(result.warnings);
    for (const cat of Object.keys(groups) as WarningCategory[]) {
      const items = groups[cat];
      if (items.length === 0) continue;
      lines.push('', `[${WARNING_CATEGORY_LABELS[cat]}] (${items.length})`);
      for (const w of items) lines.push(`  - ${w}`);
    }
  }
  return lines.join('\n');
}

interface ImportReportProps {
  result: SessionImportResult;
}

function ImportReport({ result }: ImportReportProps) {
  const c = result.counts;
  const groups = groupWarnings(result.warnings);
  const [openCategories, setOpenCategories] = useState<Set<WarningCategory>>(new Set());
  const [copied, setCopied] = useState(false);

  const toggleCategory = (cat: WarningCategory) => {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const handleCopy = async () => {
    if (await copyToClipboard(buildReportText(result))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  // Top-line totals (created / skipped-total / errored-total).
  const skippedTotal = c
    ? c.already_exists + c.no_primary_ip + c.no_profile
    : result.skipped;
  const erroredTotal = c
    ? c.folder_failed + c.create_failed
    : 0;

  // Category visibility: only show non-empty categories so a clean import
  // doesn't get a wall of "0" rows.
  const visibleCategories: WarningCategory[] = (
    ['already_exists', 'no_primary_ip', 'no_profile', 'folder_failed', 'create_failed', 'other'] as const
  ).filter((cat) => groups[cat].length > 0);

  return (
    <div className="netbox-import-result">
      <div className="result-summary">
        <div className="result-stat success">
          <span className="stat-value">{result.sessions_created}</span>
          <span className="stat-label">Created</span>
        </div>
        <div className="result-stat warning">
          <span className="stat-value">{skippedTotal}</span>
          <span className="stat-label">Skipped</span>
        </div>
        <div className={`result-stat ${erroredTotal > 0 ? 'error' : 'info'}`}>
          <span className="stat-value">{erroredTotal}</span>
          <span className="stat-label">Errored</span>
        </div>
      </div>

      {c && (
        <div className="result-breakdown">
          <div className="result-breakdown-row">
            <span>Fetched from NetBox</span><span>{c.fetched}</span>
          </div>
          <div className="result-breakdown-row">
            <span>With primary IP</span><span>{c.with_primary_ip}</span>
          </div>
          <div className="result-breakdown-row">
            <span>Folders created</span><span>{result.folders_created}</span>
          </div>
          <div className="result-breakdown-row">
            <span>Existing sessions in DB</span><span>{c.existing_sessions}</span>
          </div>
        </div>
      )}

      {visibleCategories.length > 0 && (
        <div className="result-categories">
          <div className="result-categories-header">
            <label>Details</label>
            <button className="result-copy-btn" onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy report'}
            </button>
          </div>
          {visibleCategories.map((cat) => {
            const items = groups[cat];
            const isOpen = openCategories.has(cat);
            const isError = cat === 'folder_failed' || cat === 'create_failed';
            return (
              <div key={cat} className={`result-category ${isError ? 'error' : ''}`}>
                <button
                  className="result-category-header"
                  onClick={() => toggleCategory(cat)}
                  type="button"
                >
                  <span className="result-category-arrow">{isOpen ? '▼' : '▶'}</span>
                  <span className="result-category-label">{WARNING_CATEGORY_LABELS[cat]}</span>
                  <span className="result-category-count">{items.length}</span>
                </button>
                {isOpen && (
                  <ul className="result-category-list">
                    {items.slice(0, 200).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                    {items.length > 200 && (
                      <li className="more-warnings">
                        +{items.length - 200} more (use "Copy report" to see all)
                      </li>
                    )}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {result.sessions_created === 0 && skippedTotal === 0 && erroredTotal === 0 && (
        <div className="result-note">No devices matched the filter.</div>
      )}
    </div>
  );
}

// Helper to check if device filters are set
function hasDeviceFilters(filters: DeviceFilters | null | undefined): boolean {
  if (!filters) return false;
  return !!(
    filters.sites?.length || filters.roles?.length || filters.manufacturers?.length ||
    filters.platforms?.length || filters.statuses?.length || filters.tags?.length
  );
}

interface NetBoxImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete: () => void;
  preSelectedSourceId?: string; // Optional: pre-select a source when opened from Integrations tab
}

type Step = 'source' | 'filter' | 'import';
type SourceMode = 'saved' | 'manual';

// Icons for the dialog
const Icons = {
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  cloud: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
};

function NetBoxImportDialog({
  isOpen,
  onClose,
  onImportComplete,
  preSelectedSourceId,
}: NetBoxImportDialogProps) {
  // Source selection state
  const [sourceMode, setSourceMode] = useState<SourceMode>('saved');
  const [sources, setSources] = useState<NetBoxSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>('');
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);

  // Form state (for manual mode)
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [selectedSite, setSelectedSite] = useState<string>('');
  const [selectedRole, setSelectedRole] = useState<string>('');
  const [manualProfileId, setManualProfileId] = useState('');

  // UI state
  const [step, setStep] = useState<Step>('source');
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Data state
  const [sites, setSites] = useState<NetBoxSite[]>([]);
  const [roles, setRoles] = useState<NetBoxRole[]>([]);
  const [importResult, setImportResult] = useState<SessionImportResult | null>(null);

  // Get selected source object
  const selectedSource = sources.find(s => s.id === selectedSourceId);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setStep('source');
      setIsConnected(false);
      setError(null);
      setSites([]);
      setRoles([]);
      setImportResult(null);
      setSelectedSourceId('');
      // Load sources and profiles
      loadSourcesAndProfiles();
    }
  }, [isOpen]);

  // Load available sources and profiles
  const loadSourcesAndProfiles = async () => {
    try {
      const [sourcesData, profilesData] = await Promise.all([
        listNetBoxSources(),
        listProfiles(),
      ]);
      setSources(sourcesData);
      setProfiles(profilesData);
      // Use preSelectedSourceId if provided, otherwise auto-select first source
      if (preSelectedSourceId && sourcesData.some(s => s.id === preSelectedSourceId)) {
        setSelectedSourceId(preSelectedSourceId);
      } else if (sourcesData.length > 0) {
        setSelectedSourceId(sourcesData[0].id);
      }
    } catch (err) {
      console.error('Failed to load sources:', err);
    }
  };

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Get NetBox config from form values or selected source
  const getConfig = useCallback(async (): Promise<NetBoxConfig | null> => {
    if (sourceMode === 'manual') {
      return {
        url: url.trim(),
        token: token.trim(),
      };
    } else if (selectedSource) {
      try {
        const conn = await getNetBoxSourceConnection(selectedSource.id);
        if (!conn) {
          setError('No API token is stored for this source. Add the token to its API Resource, then try again.');
          return null;
        }
        return {
          url: conn.base_url,
          token: conn.token,
        };
      } catch (err) {
        setError('Failed to retrieve API token. Please unlock the vault first.');
        return null;
      }
    }
    return null;
  }, [sourceMode, url, token, selectedSource]);

  // Test connection handler
  const handleTestConnection = async () => {
    if (sourceMode === 'manual' && (!url.trim() || !token.trim())) {
      setError('Please enter NetBox URL and API token');
      return;
    }

    if (sourceMode === 'saved' && !selectedSourceId) {
      setError('Please select a NetBox source');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const config = await getConfig();
      if (!config) {
        setIsLoading(false);
        return;
      }

      const connected = await checkNetBoxConnection(config);

      if (connected) {
        setIsConnected(true);
        // Load sites and roles
        const [sitesData, rolesData] = await Promise.all([
          fetchSites(config),
          fetchRoles(config),
        ]);
        setSites(sitesData);
        setRoles(rolesData);
        setStep('filter');
      } else {
        setError('Connection failed. Check URL and API token.');
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Connection failed'));
    } finally {
      setIsLoading(false);
    }
  };

  // Get profile name by ID
  const getProfileName = (profileId: string | null): string => {
    if (!profileId) return '-';
    const profile = profiles.find(p => p.id === profileId);
    return profile?.name ?? 'Unknown';
  };

  // Import devices handler
  const handleImport = async () => {
    // Require a profile for all imports
    const profileId = sourceMode === 'saved'
      ? selectedSource?.default_profile_id
      : manualProfileId;

    if (!profileId) {
      if (sourceMode === 'saved') {
        setError('No default profile configured. Configure a profile in Settings → Integrations → NetBox Sources.');
      } else {
        setError('Please select a credential profile');
      }
      return;
    }

    setIsLoading(true);
    setError(null);
    setStep('import');

    try {
      const config = await getConfig();
      if (!config) {
        setIsLoading(false);
        return;
      }

      // Build source config for profile resolution
      // For saved sources, use the source's profile configuration
      // For manual mode, create a simple config with the selected profile
      const sourceConfig: ImportSourceConfig = selectedSource
        ? {
            sourceId: selectedSource.id,
            defaultProfileId: selectedSource.default_profile_id,
            profileMappings: selectedSource.profile_mappings,
            cliFlavorMappings: selectedSource.cli_flavor_mappings ?? {
              by_manufacturer: {},
              by_platform: {},
            },
          }
        : {
            sourceId: 'manual-import',
            defaultProfileId: manualProfileId,
            profileMappings: { by_site: {}, by_role: {} },
            cliFlavorMappings: { by_manufacturer: {}, by_platform: {} },
          };

      // Build filters - use saved device_filters if available, otherwise use manual selection
      const filters = hasDeviceFilters(selectedSource?.device_filters)
        ? {
            // Use saved device filters from source
            sites: selectedSource?.device_filters?.sites,
            roles: selectedSource?.device_filters?.roles,
            manufacturers: selectedSource?.device_filters?.manufacturers,
            platforms: selectedSource?.device_filters?.platforms,
            statuses: selectedSource?.device_filters?.statuses,
            tags: selectedSource?.device_filters?.tags,
          }
        : {
            // Use manual site/role selection (legacy/manual mode)
            site: selectedSite || undefined,
            role: selectedRole || undefined,
          };

      const result = await importDevicesAsSessions(
        config,
        filters,
        createSession,
        createFolder,
        listFolders,
        sourceConfig,
        listSessions, // Pass listSessions for duplicate detection
      );

      setImportResult(result);

      // Mark sync complete if using a saved source
      if (selectedSource) {
        try {
          // Convert multi-value filters to single-value for sync metadata
          const deviceFilters = selectedSource?.device_filters;
          const syncFilters = hasDeviceFilters(deviceFilters)
            ? {
                site: deviceFilters?.sites?.[0],
                role: deviceFilters?.roles?.[0],
              }
            : {
                site: selectedSite || undefined,
                role: selectedRole || undefined,
              };
          await markSyncComplete(selectedSource.id, {
            filters: syncFilters,
            result: {
              sessions_created: result.sessions_created,
              sessions_updated: 0, // Not tracking updates yet
              skipped: result.skipped,
            },
          });
        } catch (err) {
          console.error('Failed to update sync metadata:', err);
        }
      }

      if (result.sessions_created > 0) {
        // Notify parent to refresh
        onImportComplete();
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Import failed'));
    } finally {
      setIsLoading(false);
    }
  };

  // Reset and import more
  const handleImportMore = () => {
    setStep('filter');
    setImportResult(null);
    setError(null);
  };

  if (!isOpen) return null;

  return (
    <div className="netbox-dialog-overlay" onClick={onClose}>
      <div className="netbox-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="netbox-dialog-header">
          <h2>
            {Icons.cloud}
            <span>Import from NetBox</span>
          </h2>
          <button className="netbox-dialog-close" onClick={onClose} title="Close">
            {Icons.close}
          </button>
        </div>

        {/* Step indicator */}
        <div className="netbox-steps">
          <div className={`netbox-step ${step === 'source' ? 'active' : ''} ${isConnected ? 'complete' : ''}`}>
            <span className="step-number">{isConnected ? Icons.check : '1'}</span>
            <span className="step-label">Source</span>
          </div>
          <div className="step-divider" />
          <div className={`netbox-step ${step === 'filter' ? 'active' : ''} ${(step === 'import' || importResult) ? 'complete' : ''}`}>
            <span className="step-number">{(step === 'import' || importResult) ? Icons.check : '2'}</span>
            <span className="step-label">Filter</span>
          </div>
          <div className="step-divider" />
          <div className={`netbox-step ${step === 'import' ? 'active' : ''}`}>
            <span className="step-number">3</span>
            <span className="step-label">Import</span>
          </div>
        </div>

        <div className="netbox-dialog-content">
          {/* Step 1: Select Source */}
          {step === 'source' && (
            <div className="netbox-form">
              {/* Source mode toggle */}
              <div className="netbox-source-mode">
                <label>
                  <input
                    type="radio"
                    name="sourceMode"
                    value="saved"
                    checked={sourceMode === 'saved'}
                    onChange={() => setSourceMode('saved')}
                    disabled={isLoading}
                  />
                  <span>Use Saved Source</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="sourceMode"
                    value="manual"
                    checked={sourceMode === 'manual'}
                    onChange={() => setSourceMode('manual')}
                    disabled={isLoading}
                  />
                  <span>Enter Manually</span>
                </label>
              </div>

              {sourceMode === 'saved' && (
                <>
                  <div className="netbox-field">
                    <label htmlFor="netbox-source">NetBox Source</label>
                    <select
                      id="netbox-source"
                      value={selectedSourceId}
                      onChange={(e) => setSelectedSourceId(e.target.value)}
                      disabled={isLoading || sources.length === 0}
                    >
                      {sources.length === 0 && (
                        <option value="">No sources configured</option>
                      )}
                      {sources.map(source => (
                        <option key={source.id} value={source.id}>
                          {source.name}
                        </option>
                      ))}
                    </select>
                    {sources.length === 0 && (
                      <span className="netbox-hint">
                        Configure sources in Settings - Integrations
                      </span>
                    )}
                  </div>

                  {selectedSource && (
                    <div className="netbox-source-info">
                      <div className="source-info-row">
                        <span className="info-label">Default Profile:</span>
                        <span className="info-value">
                          {getProfileName(selectedSource.default_profile_id)}
                        </span>
                      </div>
                      {Object.keys(selectedSource.profile_mappings.by_role).length > 0 && (
                        <div className="source-info-row">
                          <span className="info-label">Role Mappings:</span>
                          <span className="info-value">
                            {Object.entries(selectedSource.profile_mappings.by_role)
                              .map(([role, profileId]) => `${role}: ${getProfileName(profileId)}`)
                              .join(', ')}
                          </span>
                        </div>
                      )}
                      {Object.keys(selectedSource.profile_mappings.by_site).length > 0 && (
                        <div className="source-info-row">
                          <span className="info-label">Site Mappings:</span>
                          <span className="info-value">
                            {Object.entries(selectedSource.profile_mappings.by_site)
                              .map(([site, profileId]) => `${site}: ${getProfileName(profileId)}`)
                              .join(', ')}
                          </span>
                        </div>
                      )}
                      {selectedSource.device_filters && (
                        <div className="source-info-row">
                          <span className="info-label">Device Filters:</span>
                          <span className="info-value">
                            {formatDeviceFilters(selectedSource.device_filters)}
                          </span>
                        </div>
                      )}
                      {selectedSource.last_sync_at && (
                        <div className="source-info-row">
                          <span className="info-label">Last Sync:</span>
                          <span className="info-value">
                            {new Date(selectedSource.last_sync_at).toLocaleString()}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {sourceMode === 'manual' && (
                <>
                  <div className="netbox-field">
                    <label htmlFor="netbox-url">NetBox URL</label>
                    <input
                      id="netbox-url"
                      type="url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://netbox.example.com"
                      disabled={isLoading}
                    />
                  </div>
                  <div className="netbox-field">
                    <label htmlFor="netbox-token">API Token</label>
                    <PasswordInput
                      id="netbox-token"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="Enter your NetBox API token"
                      disabled={isLoading}
                    />
                    <span className="netbox-hint">
                      Generate a token in NetBox: Admin - API Tokens
                    </span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 2: Filter */}
          {step === 'filter' && (
            <div className="netbox-form">
              <div className="netbox-connection-status">
                <span className="status-icon success">{Icons.check}</span>
                <span>Connected to {sourceMode === 'saved' && selectedSource ? selectedSource.name : url}</span>
              </div>

              {/* Show saved device filters if present */}
              {sourceMode === 'saved' && hasDeviceFilters(selectedSource?.device_filters) && (
                <div className="netbox-saved-filters">
                  <label>Device Filters (from source settings)</label>
                  <div className="saved-filters-display">
                    {formatDeviceFilters(selectedSource!.device_filters!)}
                  </div>
                  <span className="netbox-hint">
                    Edit filters in Settings → Integrations → NetBox Sources
                  </span>
                </div>
              )}

              {/* Show manual filter options only when no saved filters */}
              {!(sourceMode === 'saved' && hasDeviceFilters(selectedSource?.device_filters)) && (
                <>
                  <div className="netbox-field">
                    <label htmlFor="netbox-site">Site (optional)</label>
                    <select
                      id="netbox-site"
                      value={selectedSite}
                      onChange={(e) => setSelectedSite(e.target.value)}
                      disabled={isLoading}
                    >
                      <option value="">All Sites</option>
                      {sites.map(site => (
                        <option key={site.id} value={site.slug}>{site.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="netbox-field">
                    <label htmlFor="netbox-role">Device Role (optional)</label>
                    <select
                      id="netbox-role"
                      value={selectedRole}
                      onChange={(e) => setSelectedRole(e.target.value)}
                      disabled={isLoading}
                    >
                      <option value="">All Roles</option>
                      {roles.map(role => (
                        <option key={role.id} value={role.slug}>{role.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {/* Profile selector for manual mode */}
              {sourceMode === 'manual' && (
                <div className="netbox-field">
                  <label htmlFor="netbox-profile">Credential Profile <span className="required-marker">*</span></label>
                  {profiles.length === 0 ? (
                    <div className="profile-warning">
                      <span>No credential profiles configured.</span>
                      <span className="netbox-hint">Create a profile in Settings → Profiles first.</span>
                    </div>
                  ) : (
                    <>
                      <select
                        id="netbox-profile"
                        value={manualProfileId}
                        onChange={(e) => setManualProfileId(e.target.value)}
                        disabled={isLoading}
                      >
                        <option value="">Select a profile...</option>
                        {profiles.map(profile => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name} ({profile.username})
                          </option>
                        ))}
                      </select>
                      <span className="netbox-hint">
                        All imported sessions will use this profile for authentication
                      </span>
                    </>
                  )}
                </div>
              )}

              {/* Profile mapping info for saved source */}
              {sourceMode === 'saved' && (
                <div className="netbox-profile-info">
                  <span className="profile-info-label">Profile Assignment:</span>
                  {selectedSource?.default_profile_id ? (
                    <span className="profile-info-text">
                      Sessions will be assigned profiles based on the source&apos;s role and site mappings.
                      Default: <strong>{getProfileName(selectedSource.default_profile_id)}</strong>
                    </span>
                  ) : (
                    <span className="profile-info-text" style={{ color: 'var(--color-warning)' }}>
                      No default profile configured. Please configure a profile in Settings → Integrations → NetBox Sources.
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Import Results */}
          {step === 'import' && (
            <div className="netbox-results">
              {isLoading && (
                <div className="netbox-loading">
                  <div className="netbox-spinner" />
                  <span>Importing devices from NetBox...</span>
                </div>
              )}

              {importResult && (
                <ImportReport result={importResult} />
              )}
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="netbox-error">
              {error}
              <button onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}
        </div>

        <div className="netbox-dialog-actions">
          {step === 'source' && (
            <>
              <button className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handleTestConnection}
                disabled={
                  isLoading ||
                  (sourceMode === 'manual' && (!url.trim() || !token.trim())) ||
                  (sourceMode === 'saved' && !selectedSourceId)
                }
              >
                {isLoading ? 'Testing...' : 'Test Connection'}
              </button>
            </>
          )}

          {step === 'filter' && (
            <>
              <button
                className="btn-secondary"
                onClick={() => {
                  setStep('source');
                  setIsConnected(false);
                }}
              >
                Back
              </button>
              <button
                className="btn-primary"
                onClick={handleImport}
                disabled={
                  isLoading ||
                  (sourceMode === 'saved' && !selectedSource?.default_profile_id) ||
                  (sourceMode === 'manual' && !manualProfileId)
                }
              >
                {Icons.download}
                <span>Import Devices</span>
              </button>
            </>
          )}

          {step === 'import' && importResult && (
            <>
              <button className="btn-secondary" onClick={handleImportMore}>
                Import More
              </button>
              <button className="btn-primary" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default NetBoxImportDialog;
