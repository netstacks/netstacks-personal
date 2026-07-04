-- NetStacks Database Schema
-- Version: 1

-- Folders for organizing items (sessions, topologies, etc.)
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0,
    scope TEXT NOT NULL DEFAULT 'session',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- SSH sessions
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'key')),
    key_path TEXT,
    color TEXT,
    icon TEXT DEFAULT 'server',
    sort_order INTEGER DEFAULT 0,
    last_connected_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Session-specific settings
    auto_reconnect INTEGER DEFAULT 1,
    reconnect_delay INTEGER DEFAULT 5,
    scrollback_lines INTEGER DEFAULT 10000,
    local_echo INTEGER DEFAULT 0,
    font_size_override INTEGER,
    font_family TEXT,
    -- Profile integration (Phase 04.2)
    profile_id TEXT REFERENCES credential_profiles(id) ON DELETE SET NULL,
    profile_overrides TEXT,  -- JSON blob for per-field overrides
    netbox_device_id INTEGER,
    netbox_source_id TEXT REFERENCES netbox_sources(id) ON DELETE SET NULL,
    -- AI features
    cli_flavor TEXT DEFAULT 'auto',  -- auto, linux, cisco-ios, cisco-nxos, juniper, arista, paloalto, fortinet
    -- Terminal appearance
    terminal_theme TEXT,  -- null = use default theme
    -- Jump host reference (global jump hosts)
    jump_host_id TEXT REFERENCES jump_hosts(id) ON DELETE SET NULL,
    -- Alternative jump: another Session used as the jump endpoint
    -- (mutually exclusive with jump_host_id; enforced in provider).
    jump_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    -- Port forwarding (Phase 06.3)
    port_forwards TEXT,  -- JSON array of port forward configurations
    -- Auto commands on connect
    auto_commands TEXT,  -- JSON array of commands to run on connect
    -- SFTP starting directory override
    sftp_start_path TEXT
);

-- Encrypted credential vault
CREATE TABLE IF NOT EXISTS credentials (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    encrypted_data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Master password verification (stores encrypted known value)
CREATE TABLE IF NOT EXISTS vault_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    verification_data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Connection history (session_id NULL for quick connects)
CREATE TABLE IF NOT EXISTS connection_history (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    connected_at TEXT NOT NULL,
    disconnected_at TEXT,
    duration_seconds INTEGER,
    bytes_sent INTEGER DEFAULT 0,
    bytes_received INTEGER DEFAULT 0
);

-- Settings
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mapped keys (global keyboard shortcuts to commands)
CREATE TABLE IF NOT EXISTS mapped_keys (
    id TEXT PRIMARY KEY,
    key_combo TEXT NOT NULL UNIQUE,
    command TEXT NOT NULL,
    description TEXT,
    is_secret INTEGER NOT NULL DEFAULT 0,
    command_encrypted BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Snippets (command snippets, session-specific or global)
CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scripts (Python automation scripts)
CREATE TABLE IF NOT EXISTS scripts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    is_template INTEGER DEFAULT 0,
    last_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Credential profiles (reusable auth and connection settings)
CREATE TABLE IF NOT EXISTS credential_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL,
    auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'key')),
    key_path TEXT,
    port INTEGER NOT NULL DEFAULT 22,
    keepalive_interval INTEGER NOT NULL DEFAULT 30,
    connection_timeout INTEGER NOT NULL DEFAULT 30,
    terminal_theme TEXT,
    default_font_size INTEGER,
    default_font_family TEXT,
    scrollback_lines INTEGER NOT NULL DEFAULT 10000,
    local_echo INTEGER NOT NULL DEFAULT 0,
    auto_reconnect INTEGER NOT NULL DEFAULT 1,
    reconnect_delay INTEGER NOT NULL DEFAULT 5,
    cli_flavor TEXT NOT NULL DEFAULT 'auto',
    auto_commands TEXT,
    jump_host_id TEXT REFERENCES jump_hosts(id) ON DELETE SET NULL,
    -- Alternative jump: a Session used as the jump endpoint
    -- (mutually exclusive with jump_host_id; enforced in provider).
    jump_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Global jump hosts (proxy configuration for SSH connections)
CREATE TABLE IF NOT EXISTS jump_hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    profile_id TEXT NOT NULL REFERENCES credential_profiles(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Profile credentials (encrypted in vault, keyed by profile:{id})
CREATE TABLE IF NOT EXISTS profile_credentials (
    profile_id TEXT PRIMARY KEY REFERENCES credential_profiles(id) ON DELETE CASCADE,
    encrypted_data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Documents (outputs, templates, notes, backups, history, troubleshooting, mops)
-- encrypted_content is non-NULL only for Secure Notes; when set, `content`
-- is the empty string and the encrypted blob is decrypted via the vault.
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('outputs', 'templates', 'notes', 'backups', 'history', 'troubleshooting', 'mops')),
    content_type TEXT NOT NULL CHECK (content_type IN ('csv', 'json', 'jinja', 'config', 'text', 'markdown', 'recording')),
    content TEXT NOT NULL,
    encrypted_content BLOB,
    parent_folder TEXT,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Document versions (version history for documents)
CREATE TABLE IF NOT EXISTS document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    encrypted_content BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- NetBox sources (external NetBox instances for device import)
-- API URL + credentials live on the linked api_resources row.
CREATE TABLE IF NOT EXISTS netbox_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_resource_id TEXT NOT NULL REFERENCES api_resources(id) ON DELETE RESTRICT,
    default_profile_id TEXT REFERENCES credential_profiles(id) ON DELETE SET NULL,
    profile_mappings TEXT,  -- JSON: { by_site: {slug: profile_id}, by_role: {slug: profile_id} }
    cli_flavor_mappings TEXT,  -- JSON: { by_manufacturer: {slug: flavor}, by_platform: {slug: flavor} }
    device_filters TEXT,    -- JSON: { sites: [], roles: [], manufacturers: [], platforms: [], statuses: [], tags: [] }
    last_sync_at TEXT,
    last_sync_filters TEXT,  -- JSON: { site: string?, role: string? }
    last_sync_result TEXT,   -- JSON: { sessions_created: i32, sessions_updated: i32, skipped: i32 }
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- LibreNMS sources (Phase 22 - AI Neighbor Discovery)
-- API URL + credentials live on the linked api_resources row.
CREATE TABLE IF NOT EXISTS librenms_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_resource_id TEXT NOT NULL REFERENCES api_resources(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_librenms_sources_name ON librenms_sources(name);

-- API keys vault (for AI providers, integrations, etc.)
-- key_type examples: "ai.anthropic", "ai.openai", "integration.slack"
CREATE TABLE IF NOT EXISTS api_keys (
    key_type TEXT PRIMARY KEY,
    encrypted_data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_folder ON sessions(folder_id);
CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_id);
CREATE INDEX IF NOT EXISTS idx_sessions_netbox_source ON sessions(netbox_source_id);
CREATE INDEX IF NOT EXISTS idx_sessions_netbox_device ON sessions(netbox_device_id);
CREATE INDEX IF NOT EXISTS idx_history_session ON connection_history(session_id);
CREATE INDEX IF NOT EXISTS idx_history_connected ON connection_history(connected_at);
CREATE INDEX IF NOT EXISTS idx_snippets_session ON snippets(session_id);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
CREATE INDEX IF NOT EXISTS idx_documents_parent_folder ON documents(parent_folder);
CREATE INDEX IF NOT EXISTS idx_document_versions_document ON document_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_credential_profiles_name ON credential_profiles(name);
-- Note: idx_jump_hosts_name and idx_sessions_jump_host are created in migrations
CREATE INDEX IF NOT EXISTS idx_netbox_sources_name ON netbox_sources(name);

-- Terminal session recordings
CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    terminal_cols INTEGER NOT NULL DEFAULT 80,
    terminal_rows INTEGER NOT NULL DEFAULT 24,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    file_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings(session_id);
CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at);

-- Highlight rules for keyword highlighting in terminal output (Phase 11)
CREATE TABLE IF NOT EXISTS highlight_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pattern TEXT NOT NULL,
    is_regex INTEGER NOT NULL DEFAULT 0,
    case_sensitive INTEGER NOT NULL DEFAULT 0,
    whole_word INTEGER NOT NULL DEFAULT 0,
    foreground TEXT,  -- Hex color #RRGGBB
    background TEXT,  -- Hex color #RRGGBB
    bold INTEGER NOT NULL DEFAULT 0,
    italic INTEGER NOT NULL DEFAULT 0,
    underline INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'Custom',  -- Network, Status, Security, Custom
    priority INTEGER NOT NULL DEFAULT 0,  -- Lower = higher priority
    enabled INTEGER NOT NULL DEFAULT 1,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,  -- NULL = global rule
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_highlight_rules_session ON highlight_rules(session_id);
CREATE INDEX IF NOT EXISTS idx_highlight_rules_enabled ON highlight_rules(enabled);
CREATE INDEX IF NOT EXISTS idx_highlight_rules_priority ON highlight_rules(priority);

-- Change Control (Phase 15)
CREATE TABLE IF NOT EXISTS changes (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    mop_steps TEXT NOT NULL DEFAULT '[]',
    pre_snapshot_id TEXT,
    post_snapshot_id TEXT,
    ai_analysis TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    executed_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_changes_session_id ON changes(session_id);
CREATE INDEX IF NOT EXISTS idx_changes_status ON changes(status);
CREATE INDEX IF NOT EXISTS idx_changes_created_at ON changes(created_at);

CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    change_id TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    snapshot_type TEXT NOT NULL,
    commands TEXT NOT NULL DEFAULT '[]',
    output TEXT NOT NULL DEFAULT '',
    captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_change_id ON snapshots(change_id);

-- Saved topologies (Phase 20.1)
CREATE TABLE IF NOT EXISTS topologies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    sort_order REAL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Devices in a topology (Phase 20.1)
CREATE TABLE IF NOT EXISTS topology_devices (
    id TEXT PRIMARY KEY,
    topology_id TEXT NOT NULL REFERENCES topologies(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    x REAL NOT NULL DEFAULT 500.0,
    y REAL NOT NULL DEFAULT 500.0,
    device_type TEXT NOT NULL DEFAULT 'unknown',
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Enrichment fields (AI Discovery)
    platform TEXT,
    version TEXT,
    model TEXT,
    serial TEXT,
    vendor TEXT,
    primary_ip TEXT,
    uptime TEXT,
    status TEXT,
    site TEXT,
    role TEXT,
    notes TEXT,
    profile_id TEXT REFERENCES credential_profiles(id) ON DELETE SET NULL,
    snmp_profile_id TEXT REFERENCES credential_profiles(id) ON DELETE SET NULL
);

-- Note: Enrichment columns (platform, version, model, serial, vendor, primary_ip, uptime, status, site, role, notes)
-- and profile_id are included in the CREATE TABLE above. Legacy databases will need manual migration if columns are missing.

-- Connections between devices (Phase 20.1, enhanced 27-02)
CREATE TABLE IF NOT EXISTS topology_connections (
    id TEXT PRIMARY KEY,
    topology_id TEXT NOT NULL REFERENCES topologies(id) ON DELETE CASCADE,
    source_device_id TEXT NOT NULL REFERENCES topology_devices(id) ON DELETE CASCADE,
    target_device_id TEXT NOT NULL REFERENCES topology_devices(id) ON DELETE CASCADE,
    source_interface TEXT,
    target_interface TEXT,
    protocol TEXT NOT NULL DEFAULT 'manual',
    label TEXT,
    created_at TEXT NOT NULL,
    -- Enhanced routing and styling (Phase 27-02)
    waypoints TEXT,           -- JSON array of {x, y} bend points
    curve_style TEXT DEFAULT 'straight', -- straight, curved, orthogonal
    bundle_id TEXT,           -- Groups multiple connections for parallel rendering
    bundle_index INTEGER,     -- Position in bundle for offset calculation
    color TEXT,               -- Custom color (overrides status color)
    line_style TEXT DEFAULT 'solid', -- solid, dashed, dotted
    line_width INTEGER DEFAULT 2,    -- Stroke width in pixels
    notes TEXT                -- Embedded documentation
);

CREATE INDEX IF NOT EXISTS idx_topology_devices_topology ON topology_devices(topology_id);
CREATE INDEX IF NOT EXISTS idx_topology_connections_topology ON topology_connections(topology_id);

-- NetStacks-Crawler sources (Phase 22) - L2 topology discovery
-- API URL + credentials live on the linked api_resources row.
CREATE TABLE IF NOT EXISTS netstacks_crawler_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_resource_id TEXT NOT NULL REFERENCES api_resources(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_netstacks_crawler_sources_name ON netstacks_crawler_sources(name);

-- Saved tab layouts (Phase 25)
CREATE TABLE IF NOT EXISTS layouts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    session_ids TEXT NOT NULL,        -- JSON array of session IDs (legacy, for terminals only)
    tabs TEXT,                         -- JSON array of tab objects (new: supports mixed types)
    orientation TEXT NOT NULL DEFAULT 'horizontal',
    sizes TEXT,                        -- JSON array of percentages [50, 50]
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_layouts_name ON layouts(name);

-- Quick Prompts (user-saved AI prompts)
CREATE TABLE IF NOT EXISTS quick_prompts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quick_prompts_favorite ON quick_prompts(is_favorite DESC, name);

-- Topology annotations (Phase 27 - visual documentation overlay)
CREATE TABLE IF NOT EXISTS topology_annotations (
    id TEXT PRIMARY KEY,
    topology_id TEXT NOT NULL REFERENCES topologies(id) ON DELETE CASCADE,
    annotation_type TEXT NOT NULL,  -- 'text', 'shape', 'line', 'group'
    element_data TEXT NOT NULL,     -- JSON blob with type-specific fields
    z_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_annotations_topology ON topology_annotations(topology_id);
CREATE INDEX IF NOT EXISTS idx_annotations_z_index ON topology_annotations(z_index);

-- MOP Plans (v4.0 - reusable procedure definitions)
CREATE TABLE IF NOT EXISTS mop_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',  -- draft, pending_review, approved, rejected, archived
    revision INTEGER NOT NULL DEFAULT 1,

    -- Metadata
    risk_level TEXT,              -- low, medium, high, critical
    change_ticket TEXT,
    tags TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings

    -- Step source
    source_type TEXT NOT NULL DEFAULT 'manual',  -- manual, config_template, stack_template
    source_id TEXT,               -- template/stack ID if generated
    source_variables TEXT,        -- JSON: per-device/role variables

    -- Steps (the actual procedure)
    steps TEXT NOT NULL DEFAULT '[]',   -- JSON array of MopStep objects
    device_overrides TEXT,              -- JSON: Record<deviceId, MopStep[]>

    -- Enterprise sync
    controller_id TEXT,           -- ID on controller (enterprise mode)

    created_by TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mop_plans_name ON mop_plans(name);
CREATE INDEX IF NOT EXISTS idx_mop_plans_status ON mop_plans(status);

-- MOP Templates (Phase 30 - reusable MOP definitions)
CREATE TABLE IF NOT EXISTS mop_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    mop_steps TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mop_templates_name ON mop_templates(name);

-- MOP Executions (Phase 30 - instances of template execution)
CREATE TABLE IF NOT EXISTS mop_executions (
    id TEXT PRIMARY KEY,
    template_id TEXT REFERENCES mop_templates(id) ON DELETE SET NULL,
    plan_id TEXT,
    plan_revision INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    description TEXT,
    execution_strategy TEXT NOT NULL DEFAULT 'sequential',
    control_mode TEXT NOT NULL DEFAULT 'phase_based',
    status TEXT NOT NULL DEFAULT 'pending',
    current_phase TEXT,
    ai_analysis TEXT,
    ai_autonomy_level INTEGER,
    pause_after_pre_checks INTEGER NOT NULL DEFAULT 1,
    pause_after_changes INTEGER NOT NULL DEFAULT 1,
    pause_after_post_checks INTEGER NOT NULL DEFAULT 1,
    on_failure TEXT NOT NULL DEFAULT 'pause',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    last_checkpoint TEXT
);

CREATE INDEX IF NOT EXISTS idx_mop_executions_status ON mop_executions(status);
CREATE INDEX IF NOT EXISTS idx_mop_executions_template ON mop_executions(template_id);

-- MOP Execution Devices (Phase 30 - per-device execution state)
CREATE TABLE IF NOT EXISTS mop_execution_devices (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES mop_executions(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,  -- NULL in enterprise mode (use device_id instead)
    device_id TEXT,               -- enterprise device inventory ID
    credential_id TEXT,           -- enterprise credential ID
    device_name TEXT,
    device_host TEXT,
    role TEXT,                    -- stack role
    device_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    current_step_id TEXT,
    pre_snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
    post_snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
    ai_analysis TEXT,
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT,
    UNIQUE(execution_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_mop_exec_devices_execution ON mop_execution_devices(execution_id);
CREATE INDEX IF NOT EXISTS idx_mop_exec_devices_session ON mop_execution_devices(session_id);

-- MOP Execution Steps (Phase 30 - per-step, per-device with mock support)
CREATE TABLE IF NOT EXISTS mop_execution_steps (
    id TEXT PRIMARY KEY,
    execution_device_id TEXT NOT NULL REFERENCES mop_execution_devices(id) ON DELETE CASCADE,
    step_order INTEGER NOT NULL,
    step_type TEXT NOT NULL,
    command TEXT NOT NULL,
    description TEXT,
    expected_output TEXT,
    mock_enabled INTEGER NOT NULL DEFAULT 0,
    mock_output TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    output TEXT,
    ai_feedback TEXT,
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,
    execution_source TEXT NOT NULL DEFAULT 'cli',
    quick_action_id TEXT,
    quick_action_variables TEXT,
    script_id TEXT,
    script_args TEXT,
    paired_step_id TEXT,
    output_format TEXT
);

CREATE INDEX IF NOT EXISTS idx_mop_exec_steps_device ON mop_execution_steps(execution_device_id);
CREATE INDEX IF NOT EXISTS idx_mop_exec_steps_type ON mop_execution_steps(step_type);

-- Custom right-click commands (static quick tests and dynamic detection commands)
CREATE TABLE IF NOT EXISTS custom_commands (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    detection_types TEXT,  -- JSON array of detection types, NULL = static/always show
    sort_order INTEGER DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    action_type TEXT NOT NULL DEFAULT 'terminal',  -- 'terminal' | 'quick_action' | 'script'
    quick_action_id TEXT,                          -- FK to quick_actions.id
    quick_action_variable TEXT,                    -- which {{var}} gets the detected value
    script_id TEXT,                                -- FK to scripts.id (for action_type='script')
    show_in_force_click INTEGER NOT NULL DEFAULT 0 -- also surface in the macOS Force Touch popover
);

-- AI chat conversations (side-panel history). Messages are stored as an opaque
-- JSON blob (the frontend AgentMessage[] shape) so the backend stays agnostic.
CREATE TABLE IF NOT EXISTS ai_conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New chat',
    messages TEXT NOT NULL DEFAULT '[]',           -- JSON array of frontend messages
    agent_type TEXT,                               -- which agent produced it (assistant/overlord/...)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_updated ON ai_conversations(updated_at DESC);

-- AI Agent Tasks (Phase 02 - Task Foundation)
CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    progress_pct INTEGER NOT NULL DEFAULT 0 CHECK (progress_pct >= 0 AND progress_pct <= 100),
    result_json TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created_at ON agent_tasks(created_at);

-- AI Agent Task Messages (Feature A - glass-box transcript)
-- One row per ReAct step event: thought / command-before-exec / tool_result / error.
-- seq is a per-task monotonic counter used by the /messages?since_seq=N catch-up endpoint.
CREATE TABLE IF NOT EXISTS task_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL CHECK (kind IN ('thought', 'command', 'tool_result', 'error', 'status')),
    tool_name TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_messages_task_seq ON task_messages(task_id, seq);

-- AI Agent Task Interactions (Feature B - durable two-way human channel)
-- One row per parked human interaction (approval / clarifying question).
-- Persisted before the task parks; a restart sweep marks stale 'pending' rows
-- 'expired' (fail-closed) so the UI never shows a phantom prompt.
CREATE TABLE IF NOT EXISTS task_interactions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('approval', 'question', 'plan', 'checkpoint')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'expired')),
    prompt TEXT NOT NULL,
    choices_json TEXT,
    tool_name TEXT,
    tool_input_json TEXT,
    diff TEXT,
    response_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_interactions_task ON task_interactions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_interactions_status ON task_interactions(status);

-- AI Agent Definitions (named agent configurations)
CREATE TABLE IF NOT EXISTS agent_definitions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    system_prompt TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    temperature REAL,
    max_iterations INTEGER NOT NULL DEFAULT 15,
    max_tokens INTEGER NOT NULL DEFAULT 4096,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_definitions_name ON agent_definitions(name);
CREATE INDEX IF NOT EXISTS idx_agent_definitions_enabled ON agent_definitions(enabled);

-- API Resources (external API endpoints with auth)
CREATE TABLE IF NOT EXISTS api_resources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'none',  -- none|bearer_token|basic|api_key_header|custom_header|multi_step
    auth_header_name TEXT,
    auth_header_prefix TEXT,     -- prefix for custom_header auth (e.g. "Token ")
    auth_flow TEXT,              -- JSON array of AuthFlowStep for multi_step auth
    default_headers TEXT NOT NULL DEFAULT '{}',
    custom_headers TEXT NOT NULL DEFAULT '[]',
    verify_ssl INTEGER NOT NULL DEFAULT 1,
    timeout_secs INTEGER NOT NULL DEFAULT 30,
    test_path TEXT,              -- optional test path for Test Connection button (defaults to /)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_api_resources_name ON api_resources(name);

-- API Resource credentials (encrypted in vault)
-- Stores: auth_token, auth_username, auth_password as encrypted JSON blob
CREATE TABLE IF NOT EXISTS api_resource_credentials (
    api_resource_id TEXT PRIMARY KEY REFERENCES api_resources(id) ON DELETE CASCADE,
    encrypted_data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Quick Actions (saved one-click HTTP calls)
CREATE TABLE IF NOT EXISTS quick_actions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    api_resource_id TEXT NOT NULL REFERENCES api_resources(id) ON DELETE CASCADE,
    method TEXT NOT NULL DEFAULT 'GET',
    path TEXT NOT NULL DEFAULT '/',
    headers TEXT NOT NULL DEFAULT '{}',
    body TEXT,
    json_extract_path TEXT,     -- e.g. "result[0].name.interface.txrate"
    icon TEXT DEFAULT 'zap',
    color TEXT,
    sort_order INTEGER DEFAULT 0,
    category TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quick_actions_resource ON quick_actions(api_resource_id);
CREATE INDEX IF NOT EXISTS idx_quick_actions_sort ON quick_actions(sort_order, name);

-- SSH certificate authentication state (singleton row)
CREATE TABLE IF NOT EXISTS cert_auth_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    private_key_encrypted BLOB NOT NULL,
    public_key_openssh TEXT NOT NULL,
    certificate_openssh TEXT,
    cert_expiry TEXT,
    ca_public_key TEXT,
    ca_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Persistent SSH tunnels (Tunnel Manager)
CREATE TABLE IF NOT EXISTS tunnels (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    profile_id TEXT NOT NULL REFERENCES credential_profiles(id) ON DELETE CASCADE,
    jump_host_id TEXT REFERENCES jump_hosts(id) ON DELETE SET NULL,
    -- Alternative jump: a Session used as the jump endpoint
    -- (mutually exclusive with jump_host_id; enforced in provider).
    jump_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    forward_type TEXT NOT NULL DEFAULT 'local',
    local_port INTEGER NOT NULL,
    bind_address TEXT NOT NULL DEFAULT '127.0.0.1',
    remote_host TEXT,
    remote_port INTEGER,
    auto_start INTEGER NOT NULL DEFAULT 0,
    auto_reconnect INTEGER NOT NULL DEFAULT 1,
    max_retries INTEGER NOT NULL DEFAULT 10,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AI Engineer Profile
CREATE TABLE IF NOT EXISTS ai_engineer_profile (
    id INTEGER PRIMARY KEY,
    name TEXT,
    behavior_mode TEXT DEFAULT 'assistant',
    autonomy_level TEXT DEFAULT 'suggest',
    vendor_weights TEXT DEFAULT '{}',
    domain_focus TEXT DEFAULT '{}',
    cert_perspective TEXT DEFAULT 'vendor-neutral',
    verbosity TEXT DEFAULT 'balanced',
    risk_tolerance TEXT DEFAULT 'conservative',
    troubleshooting_method TEXT DEFAULT 'top-down',
    syntax_style TEXT DEFAULT 'full',
    user_experience_level TEXT DEFAULT 'mid',
    environment_type TEXT DEFAULT 'production',
    safety_rules TEXT DEFAULT '[]',
    communication_style TEXT,
    onboarding_completed BOOLEAN DEFAULT 0,
    compiled_segments TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tab Groups (Plan 1: Tab Groups Redesign)
CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tabs TEXT NOT NULL,                   -- JSON array of GroupTab
    topology_id TEXT,
    default_launch_action TEXT,           -- 'alongside' | 'replace' | 'new_window' | 'ask' | NULL
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_groups_updated_at ON groups(updated_at DESC);
