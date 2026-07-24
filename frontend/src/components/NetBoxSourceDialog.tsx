import { useState, useEffect, useRef } from 'react';
import { getErrorMessage } from '../api/errors';
import {
  createNetBoxSource,
  updateNetBoxSource,
  testNetBoxConnection,
  getNetBoxToken,
  type NetBoxSource,
  type ProfileMappings,
  type CliFlavorMappings,
  type DeviceFilters,
} from '../api/netboxSources';
import { getApiResource } from '../api/quickActions';
import type { ApiResource } from '../types/quickAction';
import { listProfiles, type CredentialProfile } from '../api/profiles';
import AskAiHelp from './AskAiHelp';
import AITabInput from './AITabInput';
import { CLI_FLAVOR_OPTIONS, type CliFlavor } from '../api/sessions';
import {
  fetchSites,
  fetchRoles,
  fetchManufacturers,
  fetchPlatforms,
  fetchTags,
  countDevices,
  NETBOX_DEVICE_STATUSES,
  type NetBoxSite,
  type NetBoxRole,
  type NetBoxManufacturer,
  type NetBoxPlatform,
  type NetBoxTag,
} from '../api/netbox';
import { useDirtyGuard } from '../hooks/useDirtyGuard';
import ApiResourcePicker from './ApiResourcePicker';
import './NetBoxSourceDialog.css';

interface NetBoxSourceDialogProps {
  isOpen: boolean;
  source: NetBoxSource | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

// Icons
const Icons = {
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
};

interface MappingRow {
  /** Stable per-row id for React keys — assigned on add, never reused
   * after a row is deleted. Without this, swapping/inserting/deleting
   * rows shuffles the controlled input values because React reuses the
   * DOM node at the same index. Not persisted (server only stores
   * key+value pairs). */
  rid: string;
  key: string;
  profileId: string;
}

interface FlavorMappingRow {
  rid: string;
  key: string;
  flavor: CliFlavor;
}

interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectDropdownProps {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder: string;
}

function MultiSelectDropdown({ options, selected, onChange, placeholder }: MultiSelectDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const toggleOption = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter(v => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const clearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  const displayText = selected.length === 0
    ? placeholder
    : selected.length === 1
      ? options.find(o => o.value === selected[0])?.label || selected[0]
      : `${selected.length} selected`;

  return (
    <div className="multi-select" ref={dropdownRef}>
      <div
        className={`multi-select-trigger ${isOpen ? 'open' : ''} ${selected.length > 0 ? 'has-selection' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="multi-select-text">{displayText}</span>
        {selected.length > 0 && (
          <button className="multi-select-clear" onClick={clearAll} title="Clear">
            ×
          </button>
        )}
        <svg className="multi-select-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
      {isOpen && (
        <div className="multi-select-dropdown">
          {options.length === 0 ? (
            <div className="multi-select-empty">No options available</div>
          ) : (
            options.map(option => (
              <label key={option.value} className="multi-select-option">
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={() => toggleOption(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function NetBoxSourceDialog({
  isOpen,
  source,
  onClose,
  onSaved,
}: NetBoxSourceDialogProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const isEditing = !!source;

  // Form state
  const [name, setName] = useState('');
  const [apiResourceId, setApiResourceId] = useState('');
  const [selectedResource, setSelectedResource] = useState<ApiResource | null>(null);
  const [defaultProfileId, setDefaultProfileId] = useState<string>('');

  // Profile mappings
  const [siteMappings, setSiteMappings] = useState<MappingRow[]>([]);
  const [roleMappings, setRoleMappings] = useState<MappingRow[]>([]);

  // CLI flavor mappings (manufacturer/platform slug → CliFlavor)
  const [manufacturerFlavorMappings, setManufacturerFlavorMappings] = useState<FlavorMappingRow[]>([]);
  const [platformFlavorMappings, setPlatformFlavorMappings] = useState<FlavorMappingRow[]>([]);

  // Test connection state
  const [testing, setTesting] = useState(false);
  const [testSuccess, setTestSuccess] = useState<boolean | null>(null);

  // Available profiles
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);

  // NetBox sites/roles (fetched after connection test)
  const [sites, setSites] = useState<NetBoxSite[]>([]);
  const [roles, setRoles] = useState<NetBoxRole[]>([]);
  const [sitesLoaded, setSitesLoaded] = useState(false);

  // Device filter options (fetched after connection test)
  const [manufacturers, setManufacturers] = useState<NetBoxManufacturer[]>([]);
  const [platforms, setPlatforms] = useState<NetBoxPlatform[]>([]);
  const [tags, setTags] = useState<NetBoxTag[]>([]);

  // Device filter selections (stored on source)
  const [filterSites, setFilterSites] = useState<string[]>([]);
  const [filterRoles, setFilterRoles] = useState<string[]>([]);
  const [filterManufacturers, setFilterManufacturers] = useState<string[]>([]);
  const [filterPlatforms, setFilterPlatforms] = useState<string[]>([]);
  const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
  const [filterTags, setFilterTags] = useState<string[]>([]);

  // Device count preview
  const [deviceCount, setDeviceCount] = useState<number | null>(null);
  const [totalDeviceCount, setTotalDeviceCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);

  // Dirty guard — NetBox source dialogs collect a lot of mapping +
  // filter state, so silently dropping it on a stray backdrop click was
  // painful. confirmDiscard prompts before tearing down the form.
  const dirtySnapshot = {
    name, apiResourceId, defaultProfileId,
    siteMappings, roleMappings,
    manufacturerFlavorMappings, platformFlavorMappings,
    filterSites, filterRoles, filterManufacturers, filterPlatforms,
    filterStatuses, filterTags,
  };
  const { confirmDiscard, reset: resetDirty } = useDirtyGuard(dirtySnapshot, {
    resetKey: `${source?.id ?? 'new'}:${isOpen ? '1' : '0'}`,
  });
  const handleCloseGuarded = async () => {
    if (!(await confirmDiscard())) return;
    onClose();
  };

  // Load profiles on mount
  useEffect(() => {
    listProfiles()
      .then(setProfiles)
      .catch((err) => console.error('Failed to load profiles:', err));
  }, []);

  // Fetch selected API resource details when apiResourceId changes
  useEffect(() => {
    if (!apiResourceId) {
      setSelectedResource(null);
      return;
    }
    getApiResource(apiResourceId)
      .then(setSelectedResource)
      .catch((err) => {
        console.error('Failed to load API resource:', err);
        setSelectedResource(null);
      });
  }, [apiResourceId]);

  // Load form data when dialog opens
  useEffect(() => {
    if (isOpen) {
      if (source) {
        // Edit mode
        setName(source.name);
        setApiResourceId(source.api_resource_id);
        setDefaultProfileId(source.default_profile_id || '');

        // Convert mappings to rows — assign a rid per row so React's
        // reconciler can track them across add/remove/reorder without
        // shuffling the controlled input values.
        const siteRows = Object.entries(source.profile_mappings?.by_site || {}).map(([key, profileId]) => ({
          rid: crypto.randomUUID(),
          key,
          profileId,
        }));
        const roleRows = Object.entries(source.profile_mappings?.by_role || {}).map(([key, profileId]) => ({
          rid: crypto.randomUUID(),
          key,
          profileId,
        }));
        setSiteMappings(siteRows);
        setRoleMappings(roleRows);

        // Load CLI flavor mappings
        const mfrFlavorRows = Object.entries(source.cli_flavor_mappings?.by_manufacturer || {}).map(
          ([key, flavor]) => ({ rid: crypto.randomUUID(), key, flavor })
        );
        const platformFlavorRows = Object.entries(source.cli_flavor_mappings?.by_platform || {}).map(
          ([key, flavor]) => ({ rid: crypto.randomUUID(), key, flavor })
        );
        setManufacturerFlavorMappings(mfrFlavorRows);
        setPlatformFlavorMappings(platformFlavorRows);

        // Load device filters
        const filters = source.device_filters;
        setFilterSites(filters?.sites || []);
        setFilterRoles(filters?.roles || []);
        setFilterManufacturers(filters?.manufacturers || []);
        setFilterPlatforms(filters?.platforms || []);
        setFilterStatuses(filters?.statuses || []);
        setFilterTags(filters?.tags || []);

        // Reset test state
        setTestSuccess(null);
        setSitesLoaded(false);
        setSites([]);
        setRoles([]);
        setManufacturers([]);
        setPlatforms([]);
        setTags([]);
        setDeviceCount(null);
        setTotalDeviceCount(null);
      } else {
        // Create mode - reset to defaults
        setName('');
        setApiResourceId('');
        setDefaultProfileId('');
        setSiteMappings([]);
        setRoleMappings([]);
        setManufacturerFlavorMappings([]);
        setPlatformFlavorMappings([]);
        setFilterSites([]);
        setFilterRoles([]);
        setFilterManufacturers([]);
        setFilterPlatforms([]);
        setFilterStatuses([]);
        setFilterTags([]);
        setTestSuccess(null);
        setSitesLoaded(false);
        setSites([]);
        setRoles([]);
        setManufacturers([]);
        setPlatforms([]);
        setTags([]);
        setDeviceCount(null);
        setTotalDeviceCount(null);
      }

      setError(null);

      // Re-snapshot the dirty baseline after the form fields have been
      // populated from `source`, so edit mode doesn't open as "dirty".
      // Microtask delay (Promise.resolve) lets the setX calls above flush
      // before we take the new baseline.
      Promise.resolve().then(() => resetDirty());

      // Focus name input after delay
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, source]);

  // Auto-load filter options when editing an existing source
  useEffect(() => {
    if (!isOpen || !isEditing || !source || sitesLoaded || !selectedResource) return;

    const loadFilterOptions = async () => {
      try {
        const token = await getNetBoxToken(source.id);
        if (!token) {
          console.error('Failed to retrieve token from vault');
          return;
        }

        const config = { url: selectedResource.base_url, token };
        const [fetchedSites, fetchedRoles, fetchedManufacturers, fetchedPlatforms, fetchedTags, total] = await Promise.all([
          fetchSites(config),
          fetchRoles(config),
          fetchManufacturers(config),
          fetchPlatforms(config),
          fetchTags(config),
          countDevices(config),
        ]);
        setSites(fetchedSites);
        setRoles(fetchedRoles);
        setManufacturers(fetchedManufacturers);
        setPlatforms(fetchedPlatforms);
        setTags(fetchedTags);
        setTotalDeviceCount(total);
        setDeviceCount(total);
        setSitesLoaded(true);
        setTestSuccess(true); // Mark as connected since we fetched successfully
      } catch (err) {
        console.error('Failed to load filter options:', err);
        // Don't set error - user can still click Test Connection manually
      }
    };

    loadFilterOptions();
  }, [isOpen, isEditing, source, sitesLoaded, selectedResource]);

  // Handle escape key — route through the dirty guard so a half-typed
  // form isn't dropped silently.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        void handleCloseGuarded();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Update device count when filters change
  useEffect(() => {
    if (!sitesLoaded || !selectedResource || !source) return;

    const hasFilters = filterSites.length > 0 || filterRoles.length > 0 ||
      filterManufacturers.length > 0 || filterPlatforms.length > 0 ||
      filterStatuses.length > 0 || filterTags.length > 0;

    if (!hasFilters) {
      setDeviceCount(totalDeviceCount);
      return;
    }

    const fetchCount = async () => {
      const token = await getNetBoxToken(source.id);
      if (!token) return;
      const config = { url: selectedResource.base_url, token };

      setCountLoading(true);
      countDevices(config, {
        sites: filterSites.length > 0 ? filterSites : undefined,
        roles: filterRoles.length > 0 ? filterRoles : undefined,
        manufacturers: filterManufacturers.length > 0 ? filterManufacturers : undefined,
        platforms: filterPlatforms.length > 0 ? filterPlatforms : undefined,
        statuses: filterStatuses.length > 0 ? filterStatuses : undefined,
        tags: filterTags.length > 0 ? filterTags : undefined,
      })
        .then((count) => setDeviceCount(count))
        .catch((err) => console.error('Failed to count devices:', err))
        .finally(() => setCountLoading(false));
    };

    fetchCount();
  }, [sitesLoaded, selectedResource, source, filterSites, filterRoles, filterManufacturers, filterPlatforms, filterStatuses, filterTags, totalDeviceCount]);

  const handleTestConnection = async () => {
    if (!selectedResource) {
      setError('Please select an API resource');
      return;
    }

    if (!source) {
      setError('Please save the source first, then test the connection');
      return;
    }

    setTesting(true);
    setTestSuccess(null);
    setError(null);

    try {
      const token = await getNetBoxToken(source.id);
      if (!token) {
        // The token endpoint succeeded but returned nothing → no credential is
        // stored for this API resource (a locked vault throws and is handled in
        // the catch below). Tell the user what to actually do.
        setError('No API token is stored for this resource. Open its API Resource (above) and add the token, then test again.');
        setTesting(false);
        return;
      }

      const success = await testNetBoxConnection(selectedResource.base_url, token);
      setTestSuccess(success);

      if (success) {
        // Fetch sites, roles, manufacturers, platforms, tags
        try {
          const config = { url: selectedResource.base_url, token };
          const [fetchedSites, fetchedRoles, fetchedManufacturers, fetchedPlatforms, fetchedTags, total] = await Promise.all([
            fetchSites(config),
            fetchRoles(config),
            fetchManufacturers(config),
            fetchPlatforms(config),
            fetchTags(config),
            countDevices(config),
          ]);
          setSites(fetchedSites);
          setRoles(fetchedRoles);
          setManufacturers(fetchedManufacturers);
          setPlatforms(fetchedPlatforms);
          setTags(fetchedTags);
          setTotalDeviceCount(total);
          setDeviceCount(total); // Start with all devices matching
          setSitesLoaded(true);
        } catch (err) {
          console.error('Failed to fetch NetBox metadata:', err);
          // Connection works but couldn't fetch metadata - still allow save
          setSitesLoaded(true);
        }
      } else {
        setError('Connection test failed. Please check the API resource configuration.');
      }
    } catch (err) {
      setTestSuccess(false);
      setError('Connection test failed. Please check the URL and API token.');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    // Validation
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!apiResourceId) {
      setError('API Resource is required');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // Build profile mappings
      const profileMappings: ProfileMappings = {
        by_site: {},
        by_role: {},
      };
      for (const row of siteMappings) {
        if (row.key && row.profileId) {
          profileMappings.by_site[row.key] = row.profileId;
        }
      }
      for (const row of roleMappings) {
        if (row.key && row.profileId) {
          profileMappings.by_role[row.key] = row.profileId;
        }
      }

      // Build CLI flavor mappings
      const cliFlavorMappings: CliFlavorMappings = {
        by_manufacturer: {},
        by_platform: {},
      };
      for (const row of manufacturerFlavorMappings) {
        if (row.key && row.flavor) {
          cliFlavorMappings.by_manufacturer[row.key] = row.flavor;
        }
      }
      for (const row of platformFlavorMappings) {
        if (row.key && row.flavor) {
          cliFlavorMappings.by_platform[row.key] = row.flavor;
        }
      }

      // Build device filters
      const deviceFilters: DeviceFilters = {
        sites: filterSites,
        roles: filterRoles,
        manufacturers: filterManufacturers,
        platforms: filterPlatforms,
        statuses: filterStatuses,
        tags: filterTags,
      };

      // Only include device_filters if any filters are set
      const hasDeviceFilters = filterSites.length > 0 || filterRoles.length > 0 ||
        filterManufacturers.length > 0 || filterPlatforms.length > 0 ||
        filterStatuses.length > 0 || filterTags.length > 0;

      if (isEditing && source) {
        // Update existing source
        await updateNetBoxSource(source.id, {
          name: name.trim(),
          api_resource_id: apiResourceId,
          default_profile_id: defaultProfileId || null,
          profile_mappings: profileMappings,
          cli_flavor_mappings: cliFlavorMappings,
          device_filters: hasDeviceFilters ? deviceFilters : null,
        });
      } else {
        // Create new source
        await createNetBoxSource({
          name: name.trim(),
          api_resource_id: apiResourceId,
          default_profile_id: defaultProfileId || null,
          profile_mappings: profileMappings,
          cli_flavor_mappings: cliFlavorMappings,
          device_filters: hasDeviceFilters ? deviceFilters : null,
        });
      }

      onSaved();
    } catch (err) {
      setError(getErrorMessage(err, `Failed to ${isEditing ? 'update' : 'create'} NetBox source`));
    } finally {
      setSaving(false);
    }
  };

  const handleAddSiteMapping = () => {
    setSiteMappings([...siteMappings, { rid: crypto.randomUUID(), key: '', profileId: '' }]);
  };

  const handleRemoveSiteMapping = (index: number) => {
    setSiteMappings(siteMappings.filter((_, i) => i !== index));
  };

  const handleUpdateSiteMapping = (index: number, field: 'key' | 'profileId', value: string) => {
    const updated = [...siteMappings];
    updated[index] = { ...updated[index], [field]: value };
    setSiteMappings(updated);
  };

  const handleAddRoleMapping = () => {
    setRoleMappings([...roleMappings, { rid: crypto.randomUUID(), key: '', profileId: '' }]);
  };

  const handleRemoveRoleMapping = (index: number) => {
    setRoleMappings(roleMappings.filter((_, i) => i !== index));
  };

  const handleUpdateRoleMapping = (index: number, field: 'key' | 'profileId', value: string) => {
    const updated = [...roleMappings];
    updated[index] = { ...updated[index], [field]: value };
    setRoleMappings(updated);
  };

  // CLI flavor mapping handlers
  const handleAddManufacturerFlavorMapping = () => {
    setManufacturerFlavorMappings([...manufacturerFlavorMappings, { rid: crypto.randomUUID(), key: '', flavor: 'auto' }]);
  };
  const handleRemoveManufacturerFlavorMapping = (index: number) => {
    setManufacturerFlavorMappings(manufacturerFlavorMappings.filter((_, i) => i !== index));
  };
  const handleUpdateManufacturerFlavorMapping = (
    index: number,
    field: 'key' | 'flavor',
    value: string,
  ) => {
    const updated = [...manufacturerFlavorMappings];
    updated[index] = {
      ...updated[index],
      ...(field === 'key' ? { key: value } : { flavor: value as CliFlavor }),
    };
    setManufacturerFlavorMappings(updated);
  };

  const handleAddPlatformFlavorMapping = () => {
    setPlatformFlavorMappings([...platformFlavorMappings, { rid: crypto.randomUUID(), key: '', flavor: 'auto' }]);
  };
  const handleRemovePlatformFlavorMapping = (index: number) => {
    setPlatformFlavorMappings(platformFlavorMappings.filter((_, i) => i !== index));
  };
  const handleUpdatePlatformFlavorMapping = (
    index: number,
    field: 'key' | 'flavor',
    value: string,
  ) => {
    const updated = [...platformFlavorMappings];
    updated[index] = {
      ...updated[index],
      ...(field === 'key' ? { key: value } : { flavor: value as CliFlavor }),
    };
    setPlatformFlavorMappings(updated);
  };

  if (!isOpen) return null;

  const dialogTitle = isEditing ? `Edit NetBox Source: ${source?.name}` : 'Add NetBox Source';

  return (
    <div className="netbox-dialog-overlay">
      <div className="netbox-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="netbox-dialog-header">
          <h2>{dialogTitle}</h2>
          <AskAiHelp prompt="Walk me through setting up a NetBox source in NetStacks: creating the API Resource (base URL = NetBox URL, auth = bearer token = my NetBox API token, test path /api/status/), then the source's profile mappings, CLI-flavor mappings, and device filters." />
          <button className="netbox-dialog-close" onClick={handleCloseGuarded} title="Close">
            {Icons.close}
          </button>
        </div>

        <div className="netbox-dialog-content">
          {error && <div className="netbox-dialog-error">{error}</div>}

          {/* Connection Settings */}
          <div className="form-section">
            <h3>Connection</h3>

            <div className="form-group">
              <label htmlFor="source-name">Name</label>
              <AITabInput
                ref={nameInputRef}
                id="source-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onAIValue={(v) => setName(v)}
                aiField="netbox_source_name"
                aiPlaceholder="Name for this NetBox source"
                aiContext={{ apiResource: selectedResource?.name }}
                placeholder="e.g., Production NetBox"
              />
            </div>

            <ApiResourcePicker
              value={apiResourceId}
              onChange={setApiResourceId}
              label="NetBox API Resource"
              required
            />

            <div className="test-connection-row">
              <button
                className={`btn-test-connection ${testSuccess === true ? 'success' : testSuccess === false ? 'error' : ''}`}
                onClick={handleTestConnection}
                disabled={testing}
              >
                {testing ? 'Testing...' : testSuccess === true ? (
                  <>
                    {Icons.check}
                    <span>Connected</span>
                  </>
                ) : (
                  'Test Connection'
                )}
              </button>
            </div>
          </div>

          {/* Profile Settings */}
          <div className="form-section">
            <h3>Default Profile</h3>
            <div className="form-hint-block">
              Imported devices will use this profile unless a site or role mapping applies.
            </div>

            <div className="form-group">
              <label htmlFor="default-profile">Default Profile</label>
              <select
                id="default-profile"
                value={defaultProfileId}
                onChange={(e) => setDefaultProfileId(e.target.value)}
              >
                <option value="">No default profile</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Profile Mappings */}
          <div className="form-section">
            <h3>Profile Mappings</h3>
            <div className="form-hint-block">
              Map sites or device roles to specific credential profiles. More specific mappings take priority.
            </div>

            {/* Site Mappings */}
            <div className="mapping-group">
              <div className="mapping-header">
                <span>By Site</span>
                <button className="btn-icon-small" onClick={handleAddSiteMapping} title="Add site mapping">
                  {Icons.plus}
                </button>
              </div>

              {siteMappings.length === 0 ? (
                <div className="mapping-empty">No site mappings configured.</div>
              ) : (
                <div className="mapping-list">
                  {siteMappings.map((row, index) => (
                    <div key={row.rid} className="mapping-row">
                      {sitesLoaded && sites.length > 0 ? (
                        <select
                          value={row.key}
                          onChange={(e) => handleUpdateSiteMapping(index, 'key', e.target.value)}
                          className="mapping-key-select"
                        >
                          <option value="">Select site...</option>
                          {sites.map((s) => (
                            <option key={s.slug} value={s.slug}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={row.key}
                          onChange={(e) => handleUpdateSiteMapping(index, 'key', e.target.value)}
                          placeholder="Site slug"
                          className="mapping-key-input"
                        />
                      )}
                      <span className="mapping-arrow">→</span>
                      <select
                        value={row.profileId}
                        onChange={(e) => handleUpdateSiteMapping(index, 'profileId', e.target.value)}
                        className="mapping-profile-select"
                      >
                        <option value="">Select profile...</option>
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="mapping-delete"
                        onClick={() => handleRemoveSiteMapping(index)}
                        title="Remove"
                      >
                        {Icons.trash}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Role Mappings */}
            <div className="mapping-group">
              <div className="mapping-header">
                <span>By Role</span>
                <button className="btn-icon-small" onClick={handleAddRoleMapping} title="Add role mapping">
                  {Icons.plus}
                </button>
              </div>

              {roleMappings.length === 0 ? (
                <div className="mapping-empty">No role mappings configured.</div>
              ) : (
                <div className="mapping-list">
                  {roleMappings.map((row, index) => (
                    <div key={row.rid} className="mapping-row">
                      {sitesLoaded && roles.length > 0 ? (
                        <select
                          value={row.key}
                          onChange={(e) => handleUpdateRoleMapping(index, 'key', e.target.value)}
                          className="mapping-key-select"
                        >
                          <option value="">Select role...</option>
                          {roles.map((r) => (
                            <option key={r.slug} value={r.slug}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={row.key}
                          onChange={(e) => handleUpdateRoleMapping(index, 'key', e.target.value)}
                          placeholder="Role slug"
                          className="mapping-key-input"
                        />
                      )}
                      <span className="mapping-arrow">→</span>
                      <select
                        value={row.profileId}
                        onChange={(e) => handleUpdateRoleMapping(index, 'profileId', e.target.value)}
                        className="mapping-profile-select"
                      >
                        <option value="">Select profile...</option>
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="mapping-delete"
                        onClick={() => handleRemoveRoleMapping(index)}
                        title="Remove"
                      >
                        {Icons.trash}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* CLI Flavor Mappings */}
          <div className="form-section">
            <h3>CLI Flavor Mappings</h3>
            <div className="form-hint-block">
              Map NetBox manufacturer or platform slugs to a CLI flavor. Platform mappings take priority over manufacturer mappings. Devices with no match are imported as <code>auto</code> and detected at connect time.
            </div>

            {/* By Manufacturer */}
            <div className="mapping-group">
              <div className="mapping-header">
                <span>By Manufacturer</span>
                <button
                  className="btn-icon-small"
                  onClick={handleAddManufacturerFlavorMapping}
                  title="Add manufacturer mapping"
                >
                  {Icons.plus}
                </button>
              </div>

              {manufacturerFlavorMappings.length === 0 ? (
                <div className="mapping-empty">No manufacturer mappings configured.</div>
              ) : (
                <div className="mapping-list">
                  {manufacturerFlavorMappings.map((row, index) => (
                    <div key={row.rid} className="mapping-row">
                      {sitesLoaded && manufacturers.length > 0 ? (
                        <select
                          value={row.key}
                          onChange={(e) =>
                            handleUpdateManufacturerFlavorMapping(index, 'key', e.target.value)
                          }
                          className="mapping-key-select"
                        >
                          <option value="">Select manufacturer...</option>
                          {manufacturers.map((m) => (
                            <option key={m.slug} value={m.slug}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={row.key}
                          onChange={(e) =>
                            handleUpdateManufacturerFlavorMapping(index, 'key', e.target.value)
                          }
                          placeholder="Manufacturer slug"
                          className="mapping-key-input"
                        />
                      )}
                      <span className="mapping-arrow">→</span>
                      <select
                        value={row.flavor}
                        onChange={(e) =>
                          handleUpdateManufacturerFlavorMapping(index, 'flavor', e.target.value)
                        }
                        className="mapping-profile-select"
                      >
                        {CLI_FLAVOR_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <button
                        className="mapping-delete"
                        onClick={() => handleRemoveManufacturerFlavorMapping(index)}
                        title="Remove"
                      >
                        {Icons.trash}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* By Platform */}
            <div className="mapping-group">
              <div className="mapping-header">
                <span>By Platform</span>
                <button
                  className="btn-icon-small"
                  onClick={handleAddPlatformFlavorMapping}
                  title="Add platform mapping"
                >
                  {Icons.plus}
                </button>
              </div>

              {platformFlavorMappings.length === 0 ? (
                <div className="mapping-empty">No platform mappings configured.</div>
              ) : (
                <div className="mapping-list">
                  {platformFlavorMappings.map((row, index) => (
                    <div key={row.rid} className="mapping-row">
                      {sitesLoaded && platforms.length > 0 ? (
                        <select
                          value={row.key}
                          onChange={(e) =>
                            handleUpdatePlatformFlavorMapping(index, 'key', e.target.value)
                          }
                          className="mapping-key-select"
                        >
                          <option value="">Select platform...</option>
                          {platforms.map((p) => (
                            <option key={p.slug} value={p.slug}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={row.key}
                          onChange={(e) =>
                            handleUpdatePlatformFlavorMapping(index, 'key', e.target.value)
                          }
                          placeholder="Platform slug"
                          className="mapping-key-input"
                        />
                      )}
                      <span className="mapping-arrow">→</span>
                      <select
                        value={row.flavor}
                        onChange={(e) =>
                          handleUpdatePlatformFlavorMapping(index, 'flavor', e.target.value)
                        }
                        className="mapping-profile-select"
                      >
                        {CLI_FLAVOR_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <button
                        className="mapping-delete"
                        onClick={() => handleRemovePlatformFlavorMapping(index)}
                        title="Remove"
                      >
                        {Icons.trash}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Device Filters */}
          <div className="form-section">
            <h3>Device Filters</h3>
            <div className="form-hint-block">
              Filter which devices are imported from NetBox. Filters use AND between categories, OR within each category.
              {sitesLoaded && deviceCount !== null && totalDeviceCount !== null && (
                <span className="device-count-badge">
                  {countLoading ? 'Counting...' : `${deviceCount} of ${totalDeviceCount} devices match`}
                </span>
              )}
            </div>

            {!sitesLoaded ? (
              <div className="filter-hint">
                Test connection to load available filter options.
              </div>
            ) : (
              <div className="filter-grid">
                {/* Site Filter */}
                <div className="filter-group">
                  <label>Sites</label>
                  <MultiSelectDropdown
                    options={sites.map(s => ({ value: s.slug, label: s.name }))}
                    selected={filterSites}
                    onChange={setFilterSites}
                    placeholder="All sites"
                  />
                </div>

                {/* Role Filter */}
                <div className="filter-group">
                  <label>Roles</label>
                  <MultiSelectDropdown
                    options={roles.map(r => ({ value: r.slug, label: r.name }))}
                    selected={filterRoles}
                    onChange={setFilterRoles}
                    placeholder="All roles"
                  />
                </div>

                {/* Manufacturer/Vendor Filter */}
                <div className="filter-group">
                  <label>Vendors</label>
                  <MultiSelectDropdown
                    options={manufacturers.map(m => ({ value: m.slug, label: m.name }))}
                    selected={filterManufacturers}
                    onChange={setFilterManufacturers}
                    placeholder="All vendors"
                  />
                </div>

                {/* Platform Filter */}
                <div className="filter-group">
                  <label>Platforms</label>
                  <MultiSelectDropdown
                    options={platforms.map(p => ({ value: p.slug, label: p.name }))}
                    selected={filterPlatforms}
                    onChange={setFilterPlatforms}
                    placeholder="All platforms"
                  />
                </div>

                {/* Status Filter */}
                <div className="filter-group">
                  <label>Statuses</label>
                  <MultiSelectDropdown
                    options={NETBOX_DEVICE_STATUSES.map(s => ({ value: s.value, label: s.label }))}
                    selected={filterStatuses}
                    onChange={setFilterStatuses}
                    placeholder="All statuses"
                  />
                </div>

                {/* Tag Filter */}
                <div className="filter-group">
                  <label>Tags</label>
                  <MultiSelectDropdown
                    options={tags.map(t => ({ value: t.slug, label: t.name }))}
                    selected={filterTags}
                    onChange={setFilterTags}
                    placeholder="All tags"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="netbox-dialog-actions">
          <button className="btn-secondary" onClick={handleCloseGuarded}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={
              saving ||
              !name.trim() ||
              !apiResourceId
            }
            title={
              !name.trim() ? 'Name is required'
              : !apiResourceId ? 'API Resource is required'
              : undefined
            }
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
