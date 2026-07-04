// Agent Tool definitions for AI troubleshooting agent
// Follows Claude's tool-use pattern for structured function calling

/**
 * Tool definition for AI model (Claude tool-use schema)
 */
export interface AgentTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      /** For array-typed properties: schema of each element. */
      items?: { type: string };
    }>;
    required: string[];
  };
}

/**
 * Result of tool execution returned to the AI
 */
export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Agent's available tools
 * These define what actions the troubleshooting agent can take
 */
export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'list_sessions',
    description: 'Get ALL saved sessions organized by folder, with their connection status. Shows the complete session library including folder hierarchy (sites, datacenters, etc). Use this to find sessions by name, folder, host, or location.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Optional filter: "connected" for currently open sessions only, "all" for all saved sessions (default)',
          enum: ['connected', 'all']
        },
        search: {
          type: 'string',
          description: 'Optional search term to filter sessions by name, host, or folder name'
        }
      },
      required: []
    }
  },
  {
    name: 'open_session',
    description: 'Open and connect to a saved session. Use list_sessions first to find the session ID. This opens a new terminal tab and initiates SSH connection.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The session ID to open (from list_sessions)'
        }
      },
      required: ['session_id']
    }
  },
  {
    name: 'run_command',
    description: 'Execute one or more READ-ONLY commands on an OPEN terminal session. Pass either `command` (single) or `commands` (array, max 10). Only show/display/get commands are allowed; configuration commands are rejected. BATCH MODE runs each command sequentially through the same open terminal — strongly preferred when you have several commands for the same session, both because it avoids per-command tool-turn round trips (each AI tool call = an extra LLM API request and OAuth refresh) and because output stays in temporal order with clear per-command separators.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The session ID to run the command on'
        },
        command: {
          type: 'string',
          description: 'Single command to execute (must be read-only). Use this OR `commands`, not both.'
        },
        commands: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of read-only commands to run sequentially in the open terminal (max 10). Output is concatenated with `=== [N] command ===` headers so you can read it as one stream.'
        }
      },
      required: ['session_id']
    }
  },
  {
    name: 'ai_ssh_execute',
    description: 'Execute one or more READ-ONLY commands on a device by SSH-ing directly using its saved session credentials. Use this when no terminal tab is open. Pass either `command` (single) or `commands` (array, max 10). BATCH MODE keeps a single SSH connection open and runs every command sequentially through it — strongly preferred over calling this tool N times when you have several commands for the same device, both because it is ~10x faster (avoids per-command SSH handshake/auth) and because it is one AI turn instead of N (saves API tokens and OAuth refreshes).',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The session ID of the device to connect to (from list_sessions)'
        },
        command: {
          type: 'string',
          description: 'Single command to execute (must be read-only). Use this OR `commands`, not both.'
        },
        commands: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of read-only commands to run sequentially over a single SSH connection (max 10). Use this when you need to gather multiple pieces of information from the same device. Returns a `results` array with per-command success/output plus an aggregated `output` string with `=== [N] command ===` headers for easy reading.',
        },
        stop_on_error: {
          type: 'boolean',
          description: 'In batch mode, stop running remaining commands when one fails. Default false.'
        },
        timeout_secs: {
          type: 'number',
          description: 'Per-command timeout in seconds (default: 30, max: 300)'
        }
      },
      required: ['session_id']
    }
  },
  {
    name: 'get_ssh_output',
    description: 'Fetch additional pages of a truncated SSH command output. Use the request_id from a previous ai_ssh_execute response that included a truncation message. Outputs expire after 5 minutes.',
    parameters: {
      type: 'object',
      properties: {
        request_id: {
          type: 'string',
          description: 'The request_id from the truncated ai_ssh_execute response'
        },
        offset: {
          type: 'number',
          description: 'Byte offset to start reading from (default: 0)'
        },
        limit: {
          type: 'number',
          description: 'Maximum bytes to return (default: 8000, max: 32000)'
        }
      },
      required: ['request_id']
    }
  },
  {
    name: 'run_bash',
    description: 'Execute a bash/shell command on the local system (or jumpbox in enterprise mode). Use for file operations, system queries, running scripts, network diagnostics (ping, dig, curl), and data processing (jq, grep, awk). Pipes and redirects are supported. Dangerous commands (rm, sudo, kill, etc.) are blocked by a server-side deny list. Pass `command` (single) or `commands` (array, max 10) for batch execution.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Bash command to execute'
        },
        commands: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of commands to run sequentially (max 10). Returns output with per-command headers.'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory for command execution (defaults to home directory)'
        },
      },
      required: []
    }
  },
  {
    name: 'update_topology_device',
    description: 'Update a topology device with enrichment data (device_type, platform, version, model, serial, etc.). Use this AFTER gathering device information to persist the details to the topology. IMPORTANT: Always set device_type based on the device role: "router" for PE/P/CE/RR routers, "switch" for switches, "firewall" for firewalls.',
    parameters: {
      type: 'object',
      properties: {
        topology_id: {
          type: 'string',
          description: 'The topology ID containing the device'
        },
        device_id: {
          type: 'string',
          description: 'The device ID to update'
        },
        device_type: {
          type: 'string',
          description: 'Device type for icon display. Use "router" for PE/P/CE/RR/core routers, "switch" for switches, "firewall" for firewalls',
          enum: ['router', 'switch', 'firewall', 'server', 'cloud', 'access-point', 'unknown']
        },
        platform: {
          type: 'string',
          description: 'Platform/OS (e.g., "Arista EOS", "Cisco IOS-XE", "Juniper Junos")'
        },
        version: {
          type: 'string',
          description: 'Software version (e.g., "4.28.0F", "17.3.4")'
        },
        model: {
          type: 'string',
          description: 'Hardware model (e.g., "cEOSLab", "C9300-48P")'
        },
        serial: {
          type: 'string',
          description: 'Serial number'
        },
        vendor: {
          type: 'string',
          description: 'Vendor (e.g., "Arista", "Cisco", "Juniper")'
        },
        primary_ip: {
          type: 'string',
          description: 'Primary/management IP address'
        },
        uptime: {
          type: 'string',
          description: 'Device uptime string'
        },
        status: {
          type: 'string',
          description: 'Device status',
          enum: ['online', 'offline', 'warning', 'unknown']
        },
        site: {
          type: 'string',
          description: 'Site/location'
        },
        role: {
          type: 'string',
          description: 'Device role'
        },
        notes: {
          type: 'string',
          description: 'Free-form notes'
        }
      },
      required: ['topology_id', 'device_id']
    }
  },
  {
    name: 'get_terminal_context',
    description: 'Get recent terminal output and detected device info from a session. Use since_offset for efficient delta reads — only returns lines added since your last call.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The session ID to get context from'
        },
        lines: {
          type: 'number',
          description: 'Number of recent lines to retrieve (default: 50). Ignored if since_offset is provided.'
        },
        since_offset: {
          type: 'number',
          description: 'Return only lines added since this offset. The offset value is returned in previous get_terminal_context responses.'
        }
      },
      required: ['session_id']
    }
  },
  {
    name: 'set_session_cli_flavor',
    description: `Record the detected CLI flavor for a session. Call this after probing a device (e.g. running 'show version' or 'uname -a') and identifying what platform it runs. Once set, subsequent run_command calls will use the right paging-disable strategy automatically — Linux env-var prefixes for Linux, '| no-more' for Juniper, nothing for Cisco/Arista/etc. (where the AI issues 'terminal length 0' itself). ONLY call this for sessions where cli_flavor is currently 'auto' or wrong; do not change it on every command.`,
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The session ID whose CLI flavor you have detected.'
        },
        flavor: {
          type: 'string',
          description: 'The detected CLI flavor. Choose the closest match.',
          enum: ['linux', 'cisco-ios', 'cisco-ios-xr', 'cisco-nxos', 'juniper', 'arista', 'paloalto', 'fortinet']
        }
      },
      required: ['session_id', 'flavor']
    }
  },
  {
    name: 'recommend_config',
    description: 'Generate a configuration recommendation. DOES NOT execute - only provides the recommendation for user review.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The session ID the recommendation is for'
        },
        issue: {
          type: 'string',
          description: 'Description of the issue being addressed'
        },
        config_snippet: {
          type: 'string',
          description: 'The recommended configuration commands'
        },
        explanation: {
          type: 'string',
          description: 'Why this configuration resolves the issue'
        }
      },
      required: ['session_id', 'issue', 'config_snippet', 'explanation']
    }
  },
  // Document access tools
  {
    name: 'list_documents',
    description: 'List available documents from the workspace document store, optionally filtered by category. Categories: outputs (saved command outputs), templates (Jinja configuration templates), notes (user notes — encrypted Secure Notes, unreadable while the vault is locked), backups (config backups / topology snapshots), history (command/session history), troubleshooting (troubleshooting reports and captured sessions), mops (Methods of Procedure / change plans).',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Optional category filter',
          enum: ['outputs', 'templates', 'notes', 'backups', 'history', 'troubleshooting', 'mops']
        }
      },
      required: []
    }
  },
  {
    name: 'read_document',
    description: 'Read the full content of a document. Provide either document_id (from list_documents/search_documents) OR name (the human-readable document name — the newest match is returned). Prefer name when the user refers to a document by title.',
    parameters: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'The document ID to read (provide this OR name)'
        },
        name: {
          type: 'string',
          description: 'The document name to read, resolved to the newest match (provide this OR document_id)'
        }
      },
      required: []
    }
  },
  {
    name: 'search_documents',
    description: 'Search documents by name or content. Returns matching documents with their ID, name, and category.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (matches document name or content)'
        },
        category: {
          type: 'string',
          description: 'Optional category filter',
          enum: ['outputs', 'templates', 'notes', 'backups', 'history', 'troubleshooting', 'mops']
        }
      },
      required: ['query']
    }
  },
  {
    name: 'save_document',
    description: 'Save content to a new document or update an existing one. Use this to save command outputs, configs, or notes for future reference. The path can include folders like "configs/router1-config" which will create the folder structure.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Document path/name, can include folders (e.g., "configs/router1-config", "notes/troubleshooting-log")'
        },
        content: {
          type: 'string',
          description: 'The content to save in the document'
        },
        category: {
          type: 'string',
          description: 'Document category for organization',
          enum: ['outputs', 'templates', 'notes', 'backups', 'history', 'troubleshooting', 'mops']
        },
        mode: {
          type: 'string',
          description: 'Save mode: "overwrite" replaces content, "append" adds to existing',
          enum: ['overwrite', 'append']
        },
        session_id: {
          type: 'string',
          description: 'Optional session ID to associate the document with a terminal session'
        }
      },
      required: ['path', 'content']
    }
  },
  // Generic API access — call any configured API Resource (no bash needed)
  {
    name: 'list_api_resources',
    description: 'List the configured API Resources (reusable external HTTP endpoints: base URL + auth). Use this to discover which external systems you can call before using call_api_resource.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'call_api_resource',
    description: 'Call a configured API Resource (by name or id) and return the response. Use this to check or query any external API the user has set up — CMDBs, IPAM, monitoring, ticketing — WITHOUT needing bash. Read-only usage (GET, or POST for search/query endpoints). For anything that changes remote state, confirm with the user first.',
    parameters: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: 'API Resource name or id (from list_api_resources)' },
        method: { type: 'string', description: 'HTTP method (default GET)', enum: ['GET', 'POST'] },
        path: { type: 'string', description: 'Path appended to the resource base URL, e.g. /api/devices?limit=50' },
        body: { type: 'string', description: 'Optional request body (JSON string) for POST' }
      },
      required: ['resource', 'path']
    }
  },
  {
    name: 'propose_api_resource',
    description: 'Open the API Resource creation dialog PRE-FILLED with a configuration you assembled (from a Swagger/OpenAPI spec + the user\'s auth description). The user enters the secret token and clicks Test/Save — secrets never pass through you. Use this to help a user connect a generic CMDB/API before onboarding devices. After the user saves, use list_api_resources / call_api_resource to proceed.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Friendly name, e.g. "Acme CMDB"' },
        base_url: { type: 'string', description: 'Base URL, e.g. https://cmdb.example.com' },
        auth_type: { type: 'string', description: 'Auth type', enum: ['none', 'bearer_token', 'basic', 'api_key_header', 'custom_header'] },
        auth_header_name: { type: 'string', description: 'Header name for api_key_header/custom_header (e.g. X-API-Key)' },
        test_path: { type: 'string', description: 'A path that requires auth to verify the connection, e.g. /api/devices' }
      },
      required: ['name', 'base_url', 'auth_type']
    }
  },
  {
    name: 'onboard_devices',
    description: 'Collect devices from a configured API Resource (e.g. a CMDB) and onboard them as ready-to-connect sessions, assigning a default credential profile. Fetches the endpoint, maps fields you specify to session name + host, shows the user a preview, and creates the sessions ONLY after the user confirms. Use call_api_resource first to inspect the response shape and pick the right field names.',
    parameters: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: 'API Resource name or id to fetch devices from' },
        path: { type: 'string', description: 'Endpoint path returning the device list, e.g. /api/devices?limit=500' },
        method: { type: 'string', description: 'HTTP method (default GET)', enum: ['GET', 'POST'] },
        list_path: { type: 'string', description: 'Dot-path to the device array in the response (e.g. "results" or "data.devices"). Omit if the response is already an array.' },
        name_field: { type: 'string', description: 'Field on each row to use as the session name (e.g. "name" or "hostname")' },
        host_field: { type: 'string', description: 'Field on each row to use as the host/IP (e.g. "primary_ip" or "mgmt_address")' },
        profile: { type: 'string', description: 'Credential profile name or id to assign to every onboarded session (all auth comes from the profile)' },
        folder: { type: 'string', description: 'Optional folder name to create/place the sessions under' },
        cli_flavor: { type: 'string', description: 'Optional default CLI flavor (default "auto")' },
        limit: { type: 'number', description: 'Optional safety cap on how many devices to onboard (default 500)' }
      },
      required: ['resource', 'path', 'name_field', 'host_field', 'profile']
    }
  },
  // NetStacks bundled usage docs (how the app itself works)
  {
    name: 'search_netstacks_docs',
    description: 'Search the bundled NetStacks usage documentation — how the APP itself works: API Resources vs Integrations, NetBox setup, Crawler/Netdisco, Enrichment sources and token matchers, AI provider setup, and the Documents store. Use this to answer "how do I set up / configure X in NetStacks" questions. Returns matching topics (slug + title + snippet).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "netbox api token" or "enrichment token matcher"' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_netstacks_doc',
    description: 'Read the full content of a bundled NetStacks documentation topic by slug (from search_netstacks_docs). Known slugs: concepts, netbox, crawler-netdisco, enrichment, ai-and-documents.',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Doc slug, e.g. "concepts"' }
      },
      required: ['slug']
    }
  },
  // AI Memory tools
  {
    name: 'save_memory',
    description: 'Save an important fact or piece of knowledge to persistent memory. Use this when you learn something important about the user\'s network, preferences, or environment that would be useful in future conversations. Examples: network architecture details, IP addressing schemes, device roles, change windows, naming conventions, common issues.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The fact or knowledge to remember. Be concise and specific.',
        },
        category: {
          type: 'string',
          description: 'Category of the memory. network=topology/architecture, device=specific device info, procedure=workflows/change windows, preference=user preferences, general=other.',
          enum: ['network', 'device', 'procedure', 'preference', 'general'],
        },
      },
      required: ['content', 'category'],
    },
  },
  {
    name: 'recall_memories',
    description: 'Search persistent memories for relevant context. Use this when the user references something from a previous conversation or when you need context about their network that might have been saved before.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Optional category filter. Omit to search all categories.',
          enum: ['network', 'device', 'procedure', 'preference', 'general'],
        },
      },
      required: [],
    },
  },
  {
    name: 'list_agent_definitions',
    description: 'List available AI agent definitions. Use this BEFORE spawn_agent_task to find a specialized agent for the task. Agent definitions are preconfigured with domain-specific system prompts and settings that make them better at specific tasks.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'spawn_agent_task',
    description: `Spawn a background AI agent task for complex or multi-device operations. Use this when the user asks you to:
- Run commands across multiple devices
- Do long-running analysis or validation
- Tasks that should continue independently
- Operations like "check all routers", "validate BGP on core devices"

IMPORTANT workflow:
1. FIRST call list_agent_definitions to check for a specialized agent
2. If a matching agent exists, use its agent_id — it has domain-specific expertise
3. If no matching agent exists, omit agent_id to create a generic task

The task appears in the user's Agents panel immediately for monitoring.
Only spawn tasks for genuinely complex multi-step operations.`,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed instructions for the background agent. Be specific about what to check, which devices, and what output format to use.',
        },
        agent_id: {
          type: 'string',
          description: 'ID of an existing agent definition to use. Get this from list_agent_definitions. Omit to create a generic task.',
        },
        timeout_seconds: {
          type: 'string',
          description: 'Maximum time to wait for results (default: 300 = 5 minutes).',
        },
      },
      required: ['prompt'],
    },
  },
];

// ============================================
// Session Context Tools (Phase 14)
// ============================================

/**
 * Tool for saving tribal knowledge about a device
 * Used when engineers share troubleshooting findings, root causes, or helpful information
 */
export const addSessionContextTool: AgentTool = {
  name: 'add_session_context',
  description: 'Save context/knowledge about a device for the team. Use this when the user shares troubleshooting findings, root causes, or helpful information about a device.',
  parameters: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'The session/device ID to attach this context to',
      },
      issue: {
        type: 'string',
        description: 'Brief description of the issue or topic',
      },
      root_cause: {
        type: 'string',
        description: 'What caused the issue (if known)',
      },
      resolution: {
        type: 'string',
        description: 'How it was fixed or addressed',
      },
      commands: {
        type: 'string',
        description: 'Helpful commands for this issue (one per line)',
      },
      ticket_ref: {
        type: 'string',
        description: 'Related ticket number if mentioned',
      },
    },
    required: ['session_id', 'issue'],
  },
};

/**
 * Tool for retrieving saved tribal knowledge about a device
 * Shows past troubleshooting notes, known issues, and team knowledge
 */
export const listSessionContextTool: AgentTool = {
  name: 'list_session_context',
  description: 'Get all saved context/knowledge for a device. Shows past troubleshooting notes, known issues, and team knowledge.',
  parameters: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'The session/device ID to get context for',
      },
    },
    required: ['session_id'],
  },
};

/**
 * Collection of session context tools
 */
export const SESSION_CONTEXT_TOOLS: AgentTool[] = [
  addSessionContextTool,
  listSessionContextTool,
];

// ============================================
// Change Control Tools (Phase 15)
// ============================================

/**
 * Tool for analyzing before/after configuration snapshots
 */
export const analyzeChangeToolDefinition: AgentTool = {
  name: 'analyze_change_diff',
  description: 'Analyze before/after configuration snapshots from a network change. Identifies what changed, whether changes match expectations, and flags any concerns.',
  parameters: {
    type: 'object',
    properties: {
      before_output: {
        type: 'string',
        description: 'The pre-change command output (device state before)',
      },
      after_output: {
        type: 'string',
        description: 'The post-change command output (device state after)',
      },
      change_description: {
        type: 'string',
        description: 'Description of what the change was supposed to accomplish',
      },
      device_type: {
        type: 'string',
        description: 'Device type/vendor (e.g., cisco-ios, juniper, linux)',
      },
    },
    required: ['before_output', 'after_output', 'change_description'],
  },
};

/**
 * Tool for suggesting pre-check commands based on change type
 */
export const suggestPreChecksToolDefinition: AgentTool = {
  name: 'suggest_pre_checks',
  description: 'Suggest appropriate pre-check commands based on the type of change being made. Returns recommended show/verification commands.',
  parameters: {
    type: 'object',
    properties: {
      change_type: {
        type: 'string',
        description: 'Type of change (e.g., ospf-cost, bgp-config, interface-shutdown, acl-update)',
      },
      device_type: {
        type: 'string',
        description: 'Device type/vendor (e.g., cisco-ios, juniper, linux)',
      },
      affected_interface: {
        type: 'string',
        description: 'Interface or resource being modified (optional)',
      },
    },
    required: ['change_type', 'device_type'],
  },
};

/**
 * Tool for validating change results against expected outcomes
 */
export const validateChangeResultToolDefinition: AgentTool = {
  name: 'validate_change_result',
  description: 'Validate that a change completed successfully based on expected outcomes and actual results.',
  parameters: {
    type: 'object',
    properties: {
      expected_outcome: {
        type: 'string',
        description: 'What was supposed to happen (e.g., "OSPF neighbor should reform within 30 seconds")',
      },
      actual_output: {
        type: 'string',
        description: 'The actual command output after the change',
      },
      elapsed_time_seconds: {
        type: 'number',
        description: 'How long since the change was applied (for timing-based validations)',
      },
    },
    required: ['expected_outcome', 'actual_output'],
  },
};

/**
 * Collection of change control tools
 */
export const CHANGE_CONTROL_TOOLS: AgentTool[] = [
  analyzeChangeToolDefinition,
  suggestPreChecksToolDefinition,
  validateChangeResultToolDefinition,
];

// ============================================
// Network Lookup Tools (Phase 19)
// ============================================

/**
 * Tool for OUI (MAC address vendor) lookup
 */
export const lookupOuiToolDefinition: AgentTool = {
  name: 'lookup_oui',
  description: 'Look up the vendor/manufacturer for a MAC address using the OUI (Organizationally Unique Identifier) database. Returns the company that manufactured the network interface.',
  parameters: {
    type: 'object',
    properties: {
      mac_address: {
        type: 'string',
        description: 'The MAC address to look up (any format: aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff, or aabbccddeeff)',
      },
    },
    required: ['mac_address'],
  },
};

/**
 * Tool for DNS lookup (forward or reverse)
 */
export const lookupDnsToolDefinition: AgentTool = {
  name: 'lookup_dns',
  description: 'Perform a DNS lookup. For an IP address, returns the hostname (reverse DNS). For a hostname, returns the IP address(es) (forward DNS).',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The IP address or hostname to look up',
      },
    },
    required: ['query'],
  },
};

/**
 * Tool for WHOIS lookup
 */
export const lookupWhoisToolDefinition: AgentTool = {
  name: 'lookup_whois',
  description: 'Look up WHOIS registration information for an IP address or domain. Returns organization, country, network name, and CIDR allocation details.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The IP address or domain name to look up',
      },
    },
    required: ['query'],
  },
};

/**
 * Tool for ASN (Autonomous System Number) lookup
 */
export const lookupAsnToolDefinition: AgentTool = {
  name: 'lookup_asn',
  description: 'Look up information about an Autonomous System Number (ASN). Returns the AS name, description, and country.',
  parameters: {
    type: 'object',
    properties: {
      asn: {
        type: 'string',
        description: 'The ASN to look up (with or without "AS" prefix, e.g., "AS15169" or "15169")',
      },
    },
    required: ['asn'],
  },
};

/**
 * Collection of network lookup tools
 */
export const NETWORK_LOOKUP_TOOLS: AgentTool[] = [
  lookupOuiToolDefinition,
  lookupDnsToolDefinition,
  lookupWhoisToolDefinition,
  lookupAsnToolDefinition,
];

// ============================================
// Neighbor Discovery Tools (Phase 22)
// ============================================

/**
 * Tool for discovering network neighbors via CDP/LLDP
 */
export const discoverNeighborsToolDefinition: AgentTool = {
  name: 'discover_neighbors',
  description: 'Discover directly connected network devices using CDP/LLDP. Returns parsed neighbor information including device names, interfaces, and IPs. Use this to understand network topology around a device.',
  parameters: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'The session ID to run discovery on',
      },
      protocol: {
        type: 'string',
        description: 'Protocol to use. "auto" tries CDP first, then LLDP. Default: auto',
        enum: ['cdp', 'lldp', 'auto'],
      },
    },
    required: ['session_id'],
  },
};

/**
 * Tool for adding a discovered neighbor to the topology
 */
export const addNeighborToTopologyToolDefinition: AgentTool = {
  name: 'add_neighbor_to_topology',
  description: 'Add a discovered neighbor device to the current topology and create a connection. Use after discover_neighbors to build out the topology map.',
  parameters: {
    type: 'object',
    properties: {
      topology_id: {
        type: 'string',
        description: 'The topology ID to add the neighbor to',
      },
      source_device_id: {
        type: 'string',
        description: 'The device ID that discovered this neighbor',
      },
      neighbor_name: {
        type: 'string',
        description: 'Name/hostname of the neighbor device',
      },
      neighbor_ip: {
        type: 'string',
        description: 'Management IP of the neighbor (optional)',
      },
      local_interface: {
        type: 'string',
        description: 'Local interface connecting to neighbor',
      },
      remote_interface: {
        type: 'string',
        description: 'Remote interface on the neighbor (optional)',
      },
      device_type: {
        type: 'string',
        description: 'Type of device to determine icon. Default: unknown',
        enum: ['router', 'switch', 'firewall', 'server', 'unknown'],
      },
    },
    required: ['topology_id', 'source_device_id', 'neighbor_name', 'local_interface'],
  },
};

/**
 * Collection of neighbor discovery tools
 */
export const NEIGHBOR_DISCOVERY_TOOLS: AgentTool[] = [
  discoverNeighborsToolDefinition,
  addNeighborToTopologyToolDefinition,
];

// ============================================
// NetBox Topology Tools (Phase 22)
// ============================================

/**
 * Tool for querying NetBox neighbors for a device
 */
export const netboxGetNeighborsToolDefinition: AgentTool = {
  name: 'netbox_get_neighbors',
  description: 'Query NetBox for devices connected to a specific device via cables/interfaces. Returns neighbor devices with interface mappings. Requires the device to have a NetBox ID.',
  parameters: {
    type: 'object',
    properties: {
      netbox_source_id: {
        type: 'string',
        description: 'The NetBox source ID (from Settings > Integrations)',
      },
      netbox_device_id: {
        type: 'number',
        description: 'The NetBox device ID to query neighbors for',
      },
    },
    required: ['netbox_source_id', 'netbox_device_id'],
  },
};

/**
 * Tool for importing topology from NetBox
 */
export const netboxImportTopologyToolDefinition: AgentTool = {
  name: 'netbox_import_topology',
  description: 'Import all devices and connections from a NetBox site into the current topology. Creates devices for each NetBox device and connections based on cable data.',
  parameters: {
    type: 'object',
    properties: {
      netbox_source_id: {
        type: 'string',
        description: 'The NetBox source ID',
      },
      topology_id: {
        type: 'string',
        description: 'The topology ID to import into',
      },
      site_slug: {
        type: 'string',
        description: 'NetBox site slug to import (optional - imports all if not specified)',
      },
      include_connections: {
        type: 'boolean',
        description: 'Whether to also import cable connections. Default: true',
      },
    },
    required: ['netbox_source_id', 'topology_id'],
  },
};

/**
 * Collection of NetBox topology tools
 */
export const NETBOX_TOPOLOGY_TOOLS: AgentTool[] = [
  netboxGetNeighborsToolDefinition,
  netboxImportTopologyToolDefinition,
];

// ============================================
// LibreNMS Tools
// ============================================

/**
 * List all devices known to a LibreNMS source
 */
export const librenmsListDevicesToolDefinition: AgentTool = {
  name: 'librenms_list_devices',
  description: 'List all devices known to a LibreNMS source. Returns hostname, IP, hardware model, OS, and status for each. Use list_integration_sources first to find the source_id.',
  parameters: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'The LibreNMS source ID (from Settings > Integrations or list_integration_sources)',
      },
    },
    required: ['source_id'],
  },
};

/**
 * Get L2 neighbor links for a specific LibreNMS device
 */
export const librenmsGetDeviceLinksToolDefinition: AgentTool = {
  name: 'librenms_get_device_links',
  description: 'Get L2 neighbor links for a specific LibreNMS device. Returns local_port, remote_hostname, remote_port, protocol (cdp/lldp).',
  parameters: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'The LibreNMS source ID',
      },
      hostname: {
        type: 'string',
        description: 'The device hostname as known to LibreNMS',
      },
    },
    required: ['source_id', 'hostname'],
  },
};

/**
 * Get the entire L2 topology from a LibreNMS source
 */
export const librenmsGetAllLinksToolDefinition: AgentTool = {
  name: 'librenms_get_all_links',
  description: 'Get the entire L2 topology from a LibreNMS source — every device link in one call. Use for bulk topology questions instead of looping per-device.',
  parameters: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'The LibreNMS source ID',
      },
    },
    required: ['source_id'],
  },
};

/**
 * Find a LibreNMS device by IP address (client-side filter over list_devices)
 */
export const librenmsSearchDeviceByIpToolDefinition: AgentTool = {
  name: 'librenms_search_device_by_ip',
  description: 'Find a LibreNMS device by IP address. Returns the device record if found, or null if not present. Matches on the ip field.',
  parameters: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'The LibreNMS source ID',
      },
      ip: {
        type: 'string',
        description: 'The IP address to search for (e.g. 10.0.0.1)',
      },
    },
    required: ['source_id', 'ip'],
  },
};

/**
 * Get L2 links for a device WITH per-port utilization, errors, speed and
 * oper status. Slower than librenms_get_device_links because the backend
 * fans out to /api/v0/ports/{id} for every link — use when the user is
 * specifically asking about congestion/errors, not for generic topology.
 */
export const librenmsGetDeviceLinkStatsToolDefinition: AgentTool = {
  name: 'librenms_get_device_link_stats',
  description: 'Get L2 links for a LibreNMS device enriched with per-port statistics (in/out rate in bps, configured speed, in/out error counts, operStatus). Use this when investigating link congestion or errors. Prefer librenms_get_device_links for plain topology queries — this call fans out to the ports endpoint per link.',
  parameters: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'The LibreNMS source ID',
      },
      hostname: {
        type: 'string',
        description: 'The device hostname as known to LibreNMS',
      },
    },
    required: ['source_id', 'hostname'],
  },
};

/**
 * Bulk-import devices + L2 links from a LibreNMS source into a topology.
 */
export const librenmsImportTopologyToolDefinition: AgentTool = {
  name: 'librenms_import_topology',
  description: 'Import all devices and L2 links from a LibreNMS source into the current topology. Creates devices for each known device and connections from CDP/LLDP neighbor data. Returns counts of created/skipped items. Use this for bulk topology population.',
  parameters: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'The LibreNMS source ID',
      },
      topology_id: {
        type: 'string',
        description: 'The topology ID to import into',
      },
      include_connections: {
        type: 'boolean',
        description: 'Whether to also import L2 connections. Default: true',
      },
    },
    required: ['source_id', 'topology_id'],
  },
};

/**
 * Collection of LibreNMS tools
 */
export const LIBRENMS_TOOLS: AgentTool[] = [
  librenmsListDevicesToolDefinition,
  librenmsGetDeviceLinksToolDefinition,
  librenmsGetAllLinksToolDefinition,
  librenmsSearchDeviceByIpToolDefinition,
  librenmsGetDeviceLinkStatsToolDefinition,
  librenmsImportTopologyToolDefinition,
];

// ============================================
// NetStacks-Crawler Tools
// ============================================

/**
 * List all devices known to a NetStacks-Crawler source
 */
export const netstacksCrawlerListDevicesToolDefinition: AgentTool = {
  name: 'netstacks_crawler_list_devices',
  description: 'List all devices known to a NetStacks-Crawler source. Returns IP, name, model, vendor, OS, and discovery metadata.',
  parameters: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'The NetStacks-Crawler source ID (from Settings > Integrations or list_integration_sources)',
      },
    },
    required: ['source_id'],
  },
};

/**
 * Get CDP/LLDP neighbors for a specific NetStacks-Crawler device
 */
export const netstacksCrawlerGetNeighborsToolDefinition: AgentTool = {
  name: 'netstacks_crawler_get_neighbors',
  description: 'Get CDP/LLDP neighbors for a specific device IP from NetStacks-Crawler. Returns neighbor IP, port, protocol.',
  parameters: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'The NetStacks-Crawler source ID',
      },
      device_ip: {
        type: 'string',
        description: 'IP address of the device whose neighbors to retrieve',
      },
    },
    required: ['source_id', 'device_ip'],
  },
};

/**
 * Get global device-to-device link report from NetStacks-Crawler
 */
export const netstacksCrawlerGetDeviceLinksToolDefinition: AgentTool = {
  name: 'netstacks_crawler_get_device_links',
  description: 'Get the global L2 topology report — every device-to-device link the NetStacks-Crawler has discovered. Use for bulk topology questions.',
  parameters: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'The NetStacks-Crawler source ID',
      },
    },
    required: ['source_id'],
  },
};

/**
 * Search NetStacks-Crawler devices by hostname, IP, or MAC
 */
export const netstacksCrawlerSearchToolDefinition: AgentTool = {
  name: 'netstacks_crawler_search',
  description: 'Search NetStacks-Crawler devices by hostname, IP, or MAC. The query is passed straight to the crawler search engine.',
  parameters: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'The NetStacks-Crawler source ID',
      },
      query: {
        type: 'string',
        description: 'Search query — hostname fragment, IP address, or MAC address',
      },
    },
    required: ['source_id', 'query'],
  },
};

/**
 * Bulk-import devices + L2 links from a NetStacks-Crawler source into a topology.
 */
export const netstacksCrawlerImportTopologyToolDefinition: AgentTool = {
  name: 'netstacks_crawler_import_topology',
  description: 'Import all devices and L2 links from a NetStacks-Crawler source into the current topology. Creates devices for each known device and connections from the global devicelinks report. Returns counts of created/skipped items. Use this for bulk topology population.',
  parameters: {
    type: 'object',
    properties: {
      source_id: {
        type: 'string',
        description: 'The NetStacks-Crawler source ID',
      },
      topology_id: {
        type: 'string',
        description: 'The topology ID to import into',
      },
      include_connections: {
        type: 'boolean',
        description: 'Whether to also import L2 connections. Default: true',
      },
    },
    required: ['source_id', 'topology_id'],
  },
};

/**
 * Collection of NetStacks-Crawler tools
 */
export const NETSTACKS_CRAWLER_TOOLS: AgentTool[] = [
  netstacksCrawlerListDevicesToolDefinition,
  netstacksCrawlerGetNeighborsToolDefinition,
  netstacksCrawlerGetDeviceLinksToolDefinition,
  netstacksCrawlerSearchToolDefinition,
  netstacksCrawlerImportTopologyToolDefinition,
];

// ============================================
// Remote File Tools (AI Terminal Mode)
// ============================================

/**
 * Tool for writing a file on a remote server via SSH
 */
export const writeFileToolDefinition: AgentTool = {
  name: 'write_file',
  description: 'Create or overwrite a file on a remote server. Content is transferred via base64 encoding for safety. Uses atomic writes (temp file + mv) to prevent corruption.',
  parameters: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'The session ID of the target device',
      },
      filepath: {
        type: 'string',
        description: 'Absolute path of the file to create or overwrite',
      },
      content: {
        type: 'string',
        description: 'The file content to write',
      },
    },
    required: ['session_id', 'filepath', 'content'],
  },
};

/**
 * Tool for editing a file on a remote server via SSH
 */
export const editFileToolDefinition: AgentTool = {
  name: 'edit_file',
  description: 'Replace specific text in an existing file on a remote server. Reads the file, validates old_text appears exactly once, replaces it, and writes back atomically. Max file size: 1MB.',
  parameters: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'The session ID of the target device',
      },
      filepath: {
        type: 'string',
        description: 'Absolute path of the file to edit',
      },
      old_text: {
        type: 'string',
        description: 'Exact text to find and replace (must appear exactly once)',
      },
      new_text: {
        type: 'string',
        description: 'Replacement text',
      },
    },
    required: ['session_id', 'filepath', 'old_text', 'new_text'],
  },
};

/**
 * Tool for applying sed substitution to a file on a remote server via SSH
 */
export const patchFileToolDefinition: AgentTool = {
  name: 'patch_file',
  description: 'Apply a sed substitution to a file on a remote server. Uses GNU sed -i for in-place editing. Best for simple line-by-line text replacements.',
  parameters: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'The session ID of the target device',
      },
      filepath: {
        type: 'string',
        description: 'Absolute path of the file to patch',
      },
      sed_expression: {
        type: 'string',
        description: "sed expression to apply (e.g., 's/old/new/g'). Must not contain single quotes.",
      },
    },
    required: ['session_id', 'filepath', 'sed_expression'],
  },
};

// =============================================================================
// Config Backup Tools
// =============================================================================

const searchConfigBackupsToolDefinition: AgentTool = {
  name: 'search_config_backups',
  description: 'Search for a configuration element (route-policy, interface, BGP neighbor, ACL, etc.) across ALL config backups for a device. Shows when the element was first seen, changed, or removed. Use for "when did X change?" questions.',
  parameters: {
    type: 'object',
    properties: {
      device_id: { type: 'string', description: 'Device UUID' },
      search_text: { type: 'string', description: 'Config text to search for (e.g., "ROUTE_POLICY1", "interface Ethernet1", "neighbor 10.0.0.1")' },
    },
    required: ['device_id', 'search_text'],
  },
}

const getDeviceConfigToolDefinition: AgentTool = {
  name: 'get_device_config',
  description: 'Get the latest running configuration backup for a device. Can filter to a specific section. Use to check current config state or analyze configuration.',
  parameters: {
    type: 'object',
    properties: {
      device_id: { type: 'string', description: 'Device UUID' },
      section: { type: 'string', description: 'Optional: filter to config section (e.g., "bgp", "interface", "route-policy", "acl")' },
    },
    required: ['device_id'],
  },
}

const collectDeviceBackupToolDefinition: AgentTool = {
  name: 'collect_device_backup',
  description: 'SSH into a device and collect a live running configuration backup. Use when you need a fresh config or no backup exists yet.',
  parameters: {
    type: 'object',
    properties: {
      device_id: { type: 'string', description: 'Device UUID to collect config from' },
    },
    required: ['device_id'],
  },
}

const investigateConfigChangeToolDefinition: AgentTool = {
  name: 'investigate_config_change',
  description: 'Investigate when and why a configuration element changed. Cross-references config backups with audit logs, MOPs, and sessions. Use for "when did this change?", "why was this changed?", "was there a MOP for this?"',
  parameters: {
    type: 'object',
    properties: {
      device_id: { type: 'string', description: 'Device UUID' },
      config_element: { type: 'string', description: 'Config element to investigate (e.g., "route-policy CUSTOMER-IN", "interface Ethernet1")' },
      time_range_days: { type: 'integer', description: 'How far back to look in days (default: 30)' },
    },
    required: ['device_id', 'config_element'],
  },
}

/**
 * Collection of config backup analysis tools
 */
export const BACKUP_TOOLS: AgentTool[] = [
  searchConfigBackupsToolDefinition,
  getDeviceConfigToolDefinition,
  collectDeviceBackupToolDefinition,
  investigateConfigChangeToolDefinition,
]

// =============================================================================
// UI Navigation Tools (frontend-only, executed in React)
// =============================================================================

const navigateToBackupToolDefinition: AgentTool = {
  name: 'navigate_to_backup',
  description: 'Open the backup history tab for a device in the UI. Optionally select a specific backup and search for text. Use this to SHOW the user the evidence you found.',
  parameters: {
    type: 'object',
    properties: {
      device_id: { type: 'string', description: 'Device UUID' },
      device_name: { type: 'string', description: 'Device name (for tab title)' },
      search_text: { type: 'string', description: 'Optional: auto-search for this text in the config' },
    },
    required: ['device_id', 'device_name'],
  },
}

const navigateToDeviceToolDefinition: AgentTool = {
  name: 'navigate_to_device',
  description: 'Open a device detail tab in the UI.',
  parameters: {
    type: 'object',
    properties: {
      device_id: { type: 'string', description: 'Device UUID' },
      device_name: { type: 'string', description: 'Device name' },
    },
    required: ['device_id', 'device_name'],
  },
}

const openTerminalSessionToolDefinition: AgentTool = {
  name: 'open_terminal_session',
  description: 'Open or focus a terminal SSH session to a device.',
  parameters: {
    type: 'object',
    properties: {
      device_name: { type: 'string', description: 'Device name to connect to' },
    },
    required: ['device_name'],
  },
}

const navigateToMopToolDefinition: AgentTool = {
  name: 'navigate_to_mop',
  description: 'Open a Method of Procedure (MOP) in a new tab in the UI.',
  parameters: {
    type: 'object',
    properties: {
      mop_id: { type: 'string', description: 'MOP UUID' },
      mop_name: { type: 'string', description: 'MOP name (for tab title)' },
    },
    required: ['mop_id', 'mop_name'],
  },
}

const navigateToTopologyToolDefinition: AgentTool = {
  name: 'navigate_to_topology',
  description: 'Open a network topology view in the UI.',
  parameters: {
    type: 'object',
    properties: {
      topology_name: { type: 'string', description: 'Topology name to open or focus' },
    },
    required: ['topology_name'],
  },
}

const navigateToSettingsToolDefinition: AgentTool = {
  name: 'navigate_to_settings',
  description: 'Open the Settings panel in the UI, optionally to a specific tab. Available tabs: general, ai, aiEngineer, prompts, snippets, customCommands, keyboard, mappedKeys, profiles, jumpHosts, tunnels, highlighting, security, integrations, apiResources, troubleshooting, connection',
  parameters: {
    type: 'object',
    properties: {
      tab: { type: 'string', description: 'Settings tab to open (e.g., "customCommands", "integrations", "aiEngineer", "tunnels", "profiles")' },
    },
    required: [],
  },
}

// navigate_to_backup is intentionally NOT here — the config-backup tab it opens
// is Controller-only (enterprise). It is pushed separately, enterprise-gated, in
// getAvailableTools so standalone keeps device/mop/topology/settings navigation.
export const UI_NAVIGATION_TOOLS: AgentTool[] = [
  navigateToDeviceToolDefinition,
  openTerminalSessionToolDefinition,
  navigateToMopToolDefinition,
  navigateToTopologyToolDefinition,
  navigateToSettingsToolDefinition,
]

/**
 * Collection of remote file tools
 */
export const REMOTE_FILE_TOOLS: AgentTool[] = [
  writeFileToolDefinition,
  editFileToolDefinition,
  patchFileToolDefinition,
];

// ============================================
// MOP (Method of Procedure) Tools
// ============================================

/**
 * Tool for creating a new MOP (Method of Procedure)
 * Allows AI to create structured change procedures with pre-checks, changes, post-checks, and rollback steps
 */
export const createMopToolDefinition: AgentTool = {
  name: 'create_mop',
  description: 'Create a new MOP (Method of Procedure) for a network change. A MOP contains structured steps: pre_check commands to verify state before changes, change commands to execute, post_check commands to verify the change worked, and optional rollback commands. Use this when the user asks to create a change plan, MOP, or maintenance procedure.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name/title of the MOP (e.g., "Configure TACACS and DNS on NAW03 Juniper devices")',
      },
      description: {
        type: 'string',
        description: 'Detailed description of what this change accomplishes',
      },
      session_ids: {
        type: 'string',
        description: 'Comma-separated list of session IDs to target. Use list_sessions first to find device IDs.',
      },
      pre_checks: {
        type: 'string',
        description: 'Pre-check commands in JSON array format. Each object has: command (string), description (optional string), expected_output (optional string). Example: [{"command": "show configuration | display set | match tacacs", "description": "Verify current TACACS config"}]',
      },
      changes: {
        type: 'string',
        description: 'Change commands in JSON array format. Each object has: command (string), description (optional string). Example: [{"command": "set system tacplus-server 10.0.0.1", "description": "Add TACACS server"}]',
      },
      post_checks: {
        type: 'string',
        description: 'Post-check commands in JSON array format. Same format as pre_checks. These verify the change was successful.',
      },
      rollback: {
        type: 'string',
        description: 'Optional rollback commands in JSON array format. Same format as changes. Used to undo the change if needed.',
      },
    },
    required: ['name', 'session_ids', 'pre_checks', 'changes', 'post_checks'],
  },
};

/**
 * Tool for listing existing MOPs
 */
export const listMopsToolDefinition: AgentTool = {
  name: 'list_mops',
  description: 'List all MOP (Method of Procedure) plans. Returns MOP IDs, names, statuses, step counts, and creation dates. Use this to find existing MOPs before getting details or exporting.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/**
 * Tool for getting MOP details
 */
export const getMopToolDefinition: AgentTool = {
  name: 'get_mop',
  description: 'Get full details of a specific MOP by ID, including all steps (pre-checks, changes, post-checks, rollback), device overrides, status, and metadata. Use list_mops first to find the MOP ID.',
  parameters: {
    type: 'object',
    properties: {
      mop_id: {
        type: 'string',
        description: 'The MOP/change ID to retrieve',
      },
    },
    required: ['mop_id'],
  },
};

/**
 * Tool for exporting a MOP as JSON package
 */
export const exportMopToolDefinition: AgentTool = {
  name: 'export_mop',
  description: 'Export a MOP as a portable JSON package (.mop.json format). The package includes all steps, device overrides, metadata, and can be shared or imported into another NetStacks instance. Returns the full JSON package.',
  parameters: {
    type: 'object',
    properties: {
      mop_id: {
        type: 'string',
        description: 'The MOP/change ID to export',
      },
    },
    required: ['mop_id'],
  },
};

/**
 * Tool for importing a MOP from JSON package
 */
export const importMopToolDefinition: AgentTool = {
  name: 'import_mop',
  description: 'Import a MOP from a JSON package (netstacks-mop format). Creates a new MOP with all steps from the package. The package must have format "netstacks-mop", version 1.x, and at least one step.',
  parameters: {
    type: 'object',
    properties: {
      package_json: {
        type: 'string',
        description: 'The full MOP package as a JSON string. Must follow the netstacks-mop format with format, version, mop (name, steps), and metadata fields.',
      },
    },
    required: ['package_json'],
  },
};

/**
 * Collection of MOP tools
 */
export const MOP_TOOLS: AgentTool[] = [
  createMopToolDefinition,
  listMopsToolDefinition,
  getMopToolDefinition,
  exportMopToolDefinition,
  importMopToolDefinition,
];

// ============================================
// Integration Sources Discovery Tool
// ============================================

/**
 * Tool for listing configured integration sources (NetStacksCrawler, LibreNMS, NetBox)
 * so the AI can discover valid source IDs to use with other tools.
 */
export const listIntegrationSourcesToolDefinition: AgentTool = {
  name: 'list_integration_sources',
  description: 'List all configured integration sources (NetStacks-Crawler, LibreNMS, NetBox) and connected MCP servers. Returns source IDs for built-in integration tools AND lists MCP server tools you can call directly. Call this FIRST to discover what network management tools are available.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/**
 * Get a tool definition by name
 */
export function getToolByName(name: string): AgentTool | undefined {
  // Check all tool collections
  return AGENT_TOOLS.find(tool => tool.name === name) ||
    SESSION_CONTEXT_TOOLS.find(tool => tool.name === name) ||
    CHANGE_CONTROL_TOOLS.find(tool => tool.name === name) ||
    NETWORK_LOOKUP_TOOLS.find(tool => tool.name === name) ||
    NEIGHBOR_DISCOVERY_TOOLS.find(tool => tool.name === name) ||
    NETBOX_TOPOLOGY_TOOLS.find(tool => tool.name === name) ||
    LIBRENMS_TOOLS.find(tool => tool.name === name) ||
    NETSTACKS_CRAWLER_TOOLS.find(tool => tool.name === name) ||
    MOP_TOOLS.find(tool => tool.name === name) ||
    REMOTE_FILE_TOOLS.find(tool => tool.name === name);
}

// ============================================
// Tool Registry for Settings UI
// ============================================

/**
 * Tool category for grouping in the UI
 */
export type ToolCategory =
  | 'core'
  | 'documents'
  | 'session-context'
  | 'change-control'
  | 'network-lookup'
  | 'neighbor-discovery'
  | 'topology-enrichment'
  | 'netbox'
  | 'librenms'
  | 'netstacks-crawler'
  | 'mop'
  | 'memory'
  | 'agent'
  | 'integrations'
  | 'remote-files'
  | 'bash';

/**
 * Tool registry entry with metadata for UI
 */
export interface ToolRegistryEntry {
  name: string;
  category: ToolCategory;
  description: string;
  shortDescription: string;
}

/**
 * Category metadata for UI display
 */
export const TOOL_CATEGORIES: Record<ToolCategory, { label: string; description: string }> = {
  'core': {
    label: 'Core Session Tools',
    description: 'Essential tools for session management and command execution',
  },
  'documents': {
    label: 'Document Tools',
    description: 'Read, write, and search saved documents and outputs',
  },
  'session-context': {
    label: 'Session Context',
    description: 'Save and retrieve tribal knowledge about devices',
  },
  'change-control': {
    label: 'Change Control',
    description: 'Analyze diffs, suggest pre-checks, and validate changes',
  },
  'network-lookup': {
    label: 'Network Lookups',
    description: 'OUI, DNS, WHOIS, and ASN lookups',
  },
  'neighbor-discovery': {
    label: 'Neighbor Discovery',
    description: 'Discover CDP/LLDP neighbors and add to topology',
  },
  'topology-enrichment': {
    label: 'Topology Enrichment',
    description: 'Enrich topology devices with version, model, and status',
  },
  'netbox': {
    label: 'NetBox Integration',
    description: 'Query NetBox for device data and topology',
  },
  'librenms': {
    label: 'LibreNMS Integration',
    description: 'Query LibreNMS for devices and L2 neighbor links',
  },
  'netstacks-crawler': {
    label: 'NetStacks-Crawler Integration',
    description: 'Query the NetStacks-Crawler for discovered devices and L2 topology',
  },
  'mop': {
    label: 'MOP Management',
    description: 'Create, list, get, export, and import Method of Procedure change plans',
  },
  'memory': {
    label: 'AI Memory',
    description: 'Save and recall facts across conversations',
  },
  'agent': {
    label: 'Background Agents',
    description: 'Spawn autonomous background agents for complex multi-device operations',
  },
  'integrations': {
    label: 'Integrations',
    description: 'Tools for external service integration (email, MCP servers)',
  },
  'remote-files': {
    label: 'Remote File Operations',
    description: 'Write, edit, and patch files on remote servers via SSH',
  },
  'bash': {
    label: 'Bash / Shell',
    description: 'Execute bash commands on the local system (or jumpbox in enterprise mode). Dangerous commands are blocked by a configurable deny list.',
  },
};

/**
 * Complete tool registry with all tools and their metadata
 */
export const TOOL_REGISTRY: ToolRegistryEntry[] = [
  // Core Session Tools
  { name: 'list_sessions', category: 'core', description: 'List all saved sessions with folder hierarchy', shortDescription: 'List sessions' },
  { name: 'open_session', category: 'core', description: 'Open and connect to a saved session', shortDescription: 'Open session' },
  { name: 'run_command', category: 'core', description: 'Execute read-only commands on open terminals', shortDescription: 'Run command' },
  { name: 'get_terminal_context', category: 'core', description: 'Get recent terminal output and device info', shortDescription: 'Get context' },
  { name: 'set_session_cli_flavor', category: 'core', description: 'Record detected CLI platform (Cisco/Juniper/Linux/etc.) so subsequent commands use the right paging strategy', shortDescription: 'Set CLI flavor' },
  { name: 'recommend_config', category: 'core', description: 'Generate configuration recommendations', shortDescription: 'Recommend config' },

  // Bash Tools
  { name: 'run_bash', category: 'bash', description: 'Execute bash commands on the local system', shortDescription: 'Run bash' },

  // Document Tools
  { name: 'list_documents', category: 'documents', description: 'List documents by category', shortDescription: 'List docs' },
  { name: 'read_document', category: 'documents', description: 'Read document content by ID', shortDescription: 'Read doc' },
  { name: 'search_documents', category: 'documents', description: 'Search documents by name or content', shortDescription: 'Search docs' },
  { name: 'save_document', category: 'documents', description: 'Save content to a document', shortDescription: 'Save doc' },

  // Session Context Tools
  { name: 'add_session_context', category: 'session-context', description: 'Save troubleshooting knowledge about a device', shortDescription: 'Add context' },
  { name: 'list_session_context', category: 'session-context', description: 'Retrieve saved knowledge for a device', shortDescription: 'List context' },

  // Change Control Tools
  { name: 'analyze_change_diff', category: 'change-control', description: 'Analyze before/after config snapshots', shortDescription: 'Analyze diff' },
  { name: 'suggest_pre_checks', category: 'change-control', description: 'Suggest pre-check commands for a change', shortDescription: 'Suggest checks' },
  { name: 'validate_change_result', category: 'change-control', description: 'Validate change against expected outcomes', shortDescription: 'Validate change' },

  // Network Lookup Tools
  { name: 'lookup_oui', category: 'network-lookup', description: 'Look up MAC address vendor', shortDescription: 'OUI lookup' },
  { name: 'lookup_dns', category: 'network-lookup', description: 'Forward/reverse DNS lookup', shortDescription: 'DNS lookup' },
  { name: 'lookup_whois', category: 'network-lookup', description: 'WHOIS lookup for IP/domain', shortDescription: 'WHOIS lookup' },
  { name: 'lookup_asn', category: 'network-lookup', description: 'ASN information lookup', shortDescription: 'ASN lookup' },

  // Neighbor Discovery Tools
  { name: 'discover_neighbors', category: 'neighbor-discovery', description: 'Discover CDP/LLDP neighbors', shortDescription: 'Discover neighbors' },
  { name: 'add_neighbor_to_topology', category: 'neighbor-discovery', description: 'Add discovered neighbor to topology', shortDescription: 'Add neighbor' },

  // Topology Enrichment Tools
  { name: 'ai_ssh_execute', category: 'topology-enrichment', description: 'SSH to device and run command for background enrichment', shortDescription: 'Background SSH' },
  { name: 'update_topology_device', category: 'topology-enrichment', description: 'Update device with enrichment data', shortDescription: 'Update device' },

  // NetBox Tools
  { name: 'netbox_get_neighbors', category: 'netbox', description: 'Query NetBox for device neighbors', shortDescription: 'Get neighbors' },
  { name: 'netbox_import_topology', category: 'netbox', description: 'Import topology from NetBox', shortDescription: 'Import topology' },

  // LibreNMS Tools
  { name: 'librenms_list_devices', category: 'librenms', description: 'List all LibreNMS devices', shortDescription: 'List devices' },
  { name: 'librenms_get_device_links', category: 'librenms', description: 'Get L2 neighbor links for a LibreNMS device', shortDescription: 'Device links' },
  { name: 'librenms_get_all_links', category: 'librenms', description: 'Get the full LibreNMS L2 topology', shortDescription: 'All links' },
  { name: 'librenms_search_device_by_ip', category: 'librenms', description: 'Find a LibreNMS device by IP address', shortDescription: 'Search by IP' },
  { name: 'librenms_get_device_link_stats', category: 'librenms', description: 'Get L2 links for a device WITH per-port utilization, errors, speed, oper status', shortDescription: 'Link port stats' },
  { name: 'librenms_import_topology', category: 'librenms', description: 'Bulk-import devices + L2 links from LibreNMS into a topology', shortDescription: 'Import topology' },

  // NetStacks-Crawler Tools
  { name: 'netstacks_crawler_list_devices', category: 'netstacks-crawler', description: 'List all NetStacks-Crawler devices', shortDescription: 'List devices' },
  { name: 'netstacks_crawler_get_neighbors', category: 'netstacks-crawler', description: 'Get CDP/LLDP neighbors for a device IP', shortDescription: 'Get neighbors' },
  { name: 'netstacks_crawler_get_device_links', category: 'netstacks-crawler', description: 'Get the global L2 link report', shortDescription: 'Device links' },
  { name: 'netstacks_crawler_search', category: 'netstacks-crawler', description: 'Search NetStacks-Crawler devices', shortDescription: 'Search devices' },
  { name: 'netstacks_crawler_import_topology', category: 'netstacks-crawler', description: 'Bulk-import devices + L2 links from NetStacks-Crawler into a topology', shortDescription: 'Import topology' },

  // MOP Tools
  { name: 'create_mop', category: 'mop', description: 'Create a Method of Procedure change plan', shortDescription: 'Create MOP' },
  { name: 'list_mops', category: 'mop', description: 'List all MOPs with status and step counts', shortDescription: 'List MOPs' },
  { name: 'get_mop', category: 'mop', description: 'Get full MOP details including all steps', shortDescription: 'Get MOP' },
  { name: 'export_mop', category: 'mop', description: 'Export MOP as portable JSON package', shortDescription: 'Export MOP' },
  { name: 'import_mop', category: 'mop', description: 'Import MOP from JSON package', shortDescription: 'Import MOP' },

  // AI Memory Tools
  { name: 'save_memory', category: 'memory', description: 'Save important facts to persistent memory', shortDescription: 'Save memory' },
  { name: 'recall_memories', category: 'memory', description: 'Search persistent memories for context', shortDescription: 'Recall memories' },

  // Agent Task Tools
  { name: 'list_agent_definitions', category: 'agent', description: 'List available specialized AI agents', shortDescription: 'List agents' },
  { name: 'spawn_agent_task', category: 'agent', description: 'Spawn background agent for complex multi-device operations', shortDescription: 'Spawn agent' },

  // Integration Tools
  { name: 'send_email', category: 'integrations', description: 'Send email notifications and reports via SMTP', shortDescription: 'Send email' },

  // Remote File Tools (AI Terminal Mode)
  { name: 'write_file', category: 'remote-files', description: 'Create or overwrite a file on a remote server', shortDescription: 'Write file' },
  { name: 'edit_file', category: 'remote-files', description: 'Find and replace text in a remote file', shortDescription: 'Edit file' },
  { name: 'patch_file', category: 'remote-files', description: 'Apply sed substitution to a remote file', shortDescription: 'Patch file' },
];

/**
 * Get all tools grouped by category
 */
export function getToolsByCategory(): Map<ToolCategory, ToolRegistryEntry[]> {
  const map = new Map<ToolCategory, ToolRegistryEntry[]>();
  for (const tool of TOOL_REGISTRY) {
    const list = map.get(tool.category) || [];
    list.push(tool);
    map.set(tool.category, list);
  }
  return map;
}

/**
 * Get all tool names
 */
export function getAllToolNames(): string[] {
  return TOOL_REGISTRY.map(t => t.name);
}

/**
 * Get all tool names
 */
export function getToolNames(): string[] {
  return AGENT_TOOLS.map(tool => tool.name);
}

/**
 * Tool availability configuration for dynamic tool building
 * Used by useAIAgent to include only tools that have callbacks
 */
export interface ToolAvailability {
  hasSessions?: boolean;       // list_sessions
  hasExecuteCommand?: boolean; // run_command
  hasTerminalContext?: boolean; // get_terminal_context
  hasDocuments?: boolean;      // all document tools
  // Session context tools (Phase 14)
  hasSessionContext?: boolean; // add_session_context, list_session_context
  // Change control tools (Phase 15)
  hasChangeControl?: boolean;  // analyze_change_diff, suggest_pre_checks, validate_change_result
  // Neighbor discovery tools (Phase 22)
  hasNeighborDiscovery?: boolean; // discover_neighbors, add_neighbor_to_topology
  // NetBox topology tools (Phase 22)
  hasNetBoxTopology?: boolean; // netbox_get_neighbors, netbox_import_topology
  // LibreNMS integration tools
  hasLibreNms?: boolean; // librenms_* tools
  // NetStacks-Crawler integration tools
  hasNetStacksCrawler?: boolean; // netstacks_crawler_* tools
  // MOP creation tools
  hasMopCreation?: boolean; // create_mop
  // MCP servers connected — enables list_integration_sources when no built-in integrations
  hasMcpServers?: boolean;
  // Remote file write tools (AI Terminal Mode) — requires ai.terminal_mode setting
  hasRemoteFiles?: boolean;
  hasBackupAnalysis?: boolean;
  hasUINavigation?: boolean;
  // Bash/shell tool — available in Auto Pilot mode
  hasBash?: boolean;
  // Enterprise mode flag — disables tools that require the local sidecar
  isEnterprise?: boolean;
}

/**
 * Get available tools based on what callbacks are provided
 *
 * IMPORTANT: We always include session/command tools so the AI knows
 * about them. If a tool is used but the callback isn't available,
 * the hook will return an appropriate error message.
 *
 * @param availability - Object indicating which callbacks are available
 * @param disabledTools - Array of tool names that are disabled by user settings
 * @returns Array of AgentTool definitions to send to the AI
 */
export function getAvailableTools(availability: ToolAvailability, disabledTools: string[] = []): AgentTool[] {
  const disabledSet = new Set(disabledTools);
  const tools: AgentTool[] = [];

  // Always include session tools - AI should know about them
  // If callbacks aren't available, the hook will return appropriate errors
  const sessionTools = ['list_sessions', 'open_session', 'run_command', 'get_terminal_context', 'update_topology_device', 'ai_ssh_execute', 'get_ssh_output', 'set_session_cli_flavor'];
  for (const name of sessionTools) {
    const tool = AGENT_TOOLS.find(t => t.name === name);
    if (tool) tools.push(tool);
  }

  // Always include recommend_config - it just displays recommendations to user
  const recommendTool = AGENT_TOOLS.find(t => t.name === 'recommend_config');
  if (recommendTool) tools.push(recommendTool);

  // Bash tool — gated on hasBash flag (Auto Pilot: on, Co Pilot: off by default)
  if (availability.hasBash) {
    const bashTool = AGENT_TOOLS.find(t => t.name === 'run_bash');
    if (bashTool) tools.push(bashTool);
  }

  // Always include document tools (read and write)
  const docTools = ['list_documents', 'read_document', 'search_documents', 'save_document'];
  for (const name of docTools) {
    const tool = AGENT_TOOLS.find(t => t.name === name);
    if (tool) tools.push(tool);
  }

  // Always include the generic API-access tools (call any configured API Resource)
  const apiResourceTools = ['list_api_resources', 'call_api_resource', 'propose_api_resource', 'onboard_devices'];
  for (const name of apiResourceTools) {
    const tool = AGENT_TOOLS.find(t => t.name === name);
    if (tool) tools.push(tool);
  }

  // Always include the bundled NetStacks usage-docs tools (how the app works)
  const netstacksDocTools = ['search_netstacks_docs', 'read_netstacks_doc'];
  for (const name of netstacksDocTools) {
    const tool = AGENT_TOOLS.find(t => t.name === name);
    if (tool) tools.push(tool);
  }

  // Always include AI memory tools
  const memoryTools = ['save_memory', 'recall_memories'];
  for (const name of memoryTools) {
    const tool = AGENT_TOOLS.find(t => t.name === name);
    if (tool) tools.push(tool);
  }

  // Always include background agent task tools
  const agentTaskTools = ['list_agent_definitions', 'spawn_agent_task'];
  for (const name of agentTaskTools) {
    const tool = AGENT_TOOLS.find(t => t.name === name);
    if (tool) tools.push(tool);
  }

  // Include session context tools when available (Phase 14)
  if (availability.hasSessionContext) {
    tools.push(...SESSION_CONTEXT_TOOLS);
  }

  // Include change control tools when available (Phase 15)
  if (availability.hasChangeControl) {
    tools.push(...CHANGE_CONTROL_TOOLS);
  }

  // Always include network lookup tools (Phase 19)
  // These use backend API calls, no callbacks needed
  tools.push(...NETWORK_LOOKUP_TOOLS);

  // Include neighbor discovery tools when available (Phase 22)
  if (availability.hasNeighborDiscovery) {
    tools.push(...NEIGHBOR_DISCOVERY_TOOLS);
  }

  // Include NetBox topology tools when available (Phase 22)
  if (availability.hasNetBoxTopology) {
    tools.push(...NETBOX_TOPOLOGY_TOOLS);
  }

  // Include LibreNMS tools when a LibreNMS source is configured
  if (availability.hasLibreNms) {
    tools.push(...LIBRENMS_TOOLS);
  }

  // Include NetStacks-Crawler tools when a Crawler source is configured
  if (availability.hasNetStacksCrawler) {
    tools.push(...NETSTACKS_CRAWLER_TOOLS);
  }

  // Include integration sources discovery tool when any integration or MCP servers are available
  if (availability.hasNetBoxTopology || availability.hasLibreNms || availability.hasNetStacksCrawler || availability.hasMcpServers) {
    tools.push(listIntegrationSourcesToolDefinition);
  }

  // Include MOP creation tools when available
  if (availability.hasMopCreation) {
    tools.push(...MOP_TOOLS);
  }

  // Include remote file tools when AI terminal mode is enabled
  if (availability.hasRemoteFiles) {
    tools.push(...REMOTE_FILE_TOOLS);
  }

  if (availability.hasBackupAnalysis) {
    tools.push(...BACKUP_TOOLS);
  }

  if (availability.hasUINavigation) {
    tools.push(...UI_NAVIGATION_TOOLS);
    // navigate_to_backup opens the config-backup tab, which is served only by
    // the Controller (enterprise). Standalone has no agent config-backup
    // endpoints, so only expose it in enterprise mode.
    if (availability.isEnterprise) {
      tools.push(navigateToBackupToolDefinition);
    }
  }

  // Filter out disabled tools
  if (disabledSet.size > 0) {
    return tools.filter(t => !disabledSet.has(t.name));
  }

  return tools;
}
