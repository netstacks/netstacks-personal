/**
 * NetStacks AI Agent System
 *
 * Defines agent types and permission modes for the AI assistant:
 *
 * Agent Types:
 *   - Auto Pilot: All tools + bash, runs autonomously by default
 *   - Overlord: All tools (no bash by default), asks before acting
 *
 * Permission Modes (mirrors Claude Code):
 *   - Ask: User approves every tool call
 *   - Auto: Read-only auto-executes, writes need approval
 *   - YOLO: Everything auto-executes
 *
 * System prompts are part of the product — not user-editable.
 * User AI Engineer Profiles (editable) are appended on top.
 */

import { getSettings, type AppSettings } from '../hooks/useSettings'

export type AgentType = 'autopilot' | 'overlord'
export type PermissionMode = 'ask' | 'auto' | 'yolo'

export interface AgentTypeConfig {
  id: AgentType
  label: string
  description: string
  enabledFlags: string[]
  allowsCommands: boolean
  allowsBash: boolean
  defaultPermissionMode: PermissionMode
}

export const AGENT_TYPES: Record<AgentType, AgentTypeConfig> = {
  autopilot: {
    id: 'autopilot',
    label: 'Auto Pilot',
    description: 'Full access — all tools + bash, runs autonomously',
    enabledFlags: [
      'hasSessions', 'hasExecuteCommand', 'hasTerminalContext',
      'hasDocuments', 'hasSessionContext', 'hasChangeControl',
      'hasNeighborDiscovery', 'hasNetBoxTopology',
      'hasLibreNms', 'hasNetStacksCrawler',
      'hasMopCreation',
      'hasMcpServers', 'hasBackupAnalysis', 'hasUINavigation',
      'hasBash',
    ],
    allowsCommands: true,
    allowsBash: true,
    defaultPermissionMode: 'auto',
  },
  overlord: {
    id: 'overlord',
    label: 'Overlord',
    description: 'Full access — all tools, asks before acting',
    // run_bash is included here so it can be allocated per-mode via the
    // per-mode tool settings; it is disabled by default for this mode via
    // `ai.disabledTools.overlord` = ['run_bash'].
    enabledFlags: [
      'hasSessions', 'hasExecuteCommand', 'hasTerminalContext',
      'hasDocuments', 'hasSessionContext', 'hasChangeControl',
      'hasNeighborDiscovery', 'hasNetBoxTopology',
      'hasLibreNms', 'hasNetStacksCrawler',
      'hasMopCreation',
      'hasMcpServers', 'hasBackupAnalysis', 'hasUINavigation',
      'hasBash',
    ],
    allowsCommands: true,
    allowsBash: true,
    defaultPermissionMode: 'ask',
  },
}

/** Settings keys holding each mode's user-customizable display name. */
const MODE_NAME_SETTING: Record<AgentType, string> = {
  autopilot: 'ai.modes.autopilot.name',
  overlord: 'ai.modes.overlord.name',
}

/**
 * The user-customizable display name for a mode. Falls back to the built-in
 * label. Non-reactive (reads the settings singleton) — use the useModeNames()
 * hook in React components so labels update live on rename.
 */
export function getModeName(agentType: AgentType): string {
  try {
    const key = MODE_NAME_SETTING[agentType]
    if (key) {
      const val = getSettings()[key as keyof AppSettings] as string | undefined
      if (val && val.trim()) return val.trim()
    }
  } catch { /* fall back to default label */ }
  return AGENT_TYPES[agentType]?.label ?? String(agentType)
}

/** Whether run_bash is effectively enabled for a mode (allowed + not disabled). */
function bashEnabledFor(agentType: AgentType): boolean {
  if (!AGENT_TYPES[agentType].allowsBash) return false
  try {
    const disabled = getSettings()[`ai.disabledTools.${agentType}` as keyof AppSettings] as string[] | undefined
    return !(disabled || []).includes('run_bash')
  } catch {
    return AGENT_TYPES[agentType].allowsBash
  }
}

export const PERMISSION_MODES: Record<PermissionMode, { label: string; description: string }> = {
  ask: {
    label: 'Ask',
    description: 'Approve every tool call before execution',
  },
  auto: {
    label: 'Auto',
    description: 'Read-only commands auto-execute, writes need approval',
  },
  yolo: {
    label: 'Go Nuts',
    description: 'Everything auto-executes — no approval needed',
  },
}

// =============================================================================
// System Prompts — NetStacks IP, not user-editable
// =============================================================================

const NETSTACKS_IDENTITY = `## NetStacks Platform Knowledge

You are an expert on the NetStacks network operations platform and networking in general.

NetStacks is a platform for network engineers that provides:
- SSH/Telnet terminal access to network devices (routers, switches, firewalls)
- Configuration backup and change tracking across all devices
- Topology visualization and discovery (LLDP/CDP, SNMP)
- AI-powered troubleshooting and analysis
- Methods of Procedure (MOPs) for structured change management
- Knowledge base with documentation and runbooks
- Device inventory management (manual + NetBox integration)
- Credential vault with role-based access control
- Script execution (Python/Jinja2 templates)
- Alert ingestion and incident management (enterprise)
- Stack templates for multi-service deployments (enterprise)

You understand network protocols (BGP, OSPF, IS-IS, MPLS, VXLAN, EVPN), vendor configurations (Cisco IOS/IOS-XR/NX-OS, Arista EOS, Juniper Junos, Palo Alto, Fortinet), and common network operations workflows.

## NetStacks Concepts & Setup (help users who are new to APIs)
- **API Resource** — the ONE reusable HTTP-endpoint primitive: base URL + auth (none / bearer token / basic / api-key header / custom header / multi-step login) + TLS/timeout. Credentials are stored in the encrypted vault (the vault must be unlocked). Configured in Settings → API Resources. Everything that talks to an external system is built on this.
- **Integrations** — named "sources" that WRAP an API Resource and add typed behavior + import: **NetBox** (device→session sync, device filters, credential/CLI-flavor mappings), **LibreNMS**, and **Crawler**. Configured in Settings → Integrations. The URL + token live on the wrapped API Resource; the integration layers behavior on top.
- **Crawler = Netdisco** — "NetStacks-Crawler" is just NetStacks' UI over Netdisco's REST API (\`/api/v1\`). Point a Crawler source at a Netdisco instance: the API Resource base URL = the Netdisco host, auth = basic or api-key, test path \`api/v1/device\`.
- **Enrichment** — hover lookups on highlighted terminal tokens. Sources are either **builtin** (dns_ptr, oui_vendor, mac_address_type — no HTTP) or **api_resource** (reference ANY API Resource via a \`path_template\` like \`/api/search?q={token}\`, with response-unwrap + picked fields). **Token matchers** decide which token types (IP, MAC, hostname, …) trigger which sources. Configured in Settings → Enrichment.
- **Why Integrations differ from API Resources** — an API Resource is a generic endpoint; an Integration adds typed proxies + import into app objects. An app that is NOT a first-class integration (SolarWinds, PRTG, a CMDB, any REST API) still integrates: create an API Resource for it, then use it via a **Quick Call**, an **Enrichment source**, or a **MOP step**.
- **NetBox setup** — create an API Resource (base URL = NetBox URL, auth = bearer token = the NetBox API token, test path \`/api/status/\`), then add a NetBox source that references it.

When a user asks "how do I integrate <app>?", answer with the pattern above (create an API Resource → use it via Quick Call / Enrichment / Integration), and offer to open the relevant Settings tab (use navigate_to_settings).

To CHECK or QUERY an already-configured external API (a CMDB, IPAM, monitoring, ticketing, etc.), you do NOT need bash — call **list_api_resources** to see what's configured, then **call_api_resource** with the resource name + path. Use this for read-only checks and to collect data (e.g. pulling a device inventory) from any API Resource.

Device onboarding from a generic source (not just NetBox): if a user has a CMDB or inventory API that isn't a built-in integration, proactively offer to onboard from it. Say something like: "If you can give me a Swagger/OpenAPI spec and the auth details, I can create an API Resource for it, then collect your devices and onboard them as sessions with a default credential profile." Flow: **propose_api_resource** (assemble the config from their spec/auth; the user enters the secret and saves) → **call_api_resource** to inspect the response shape and pick the name/host fields → **onboard_devices** (maps fields, shows the user a preview, and creates the sessions only after they confirm). Always let the user pick the default credential profile.

For detailed, authoritative how-tos on NetStacks itself (setup, API Resources, integrations, enrichment/token matchers, NetBox, Crawler/Netdisco, AI setup, Documents), call **search_netstacks_docs** then **read_netstacks_doc** — these read documentation bundled into the app. Prefer them over guessing when explaining how to use NetStacks.

When referencing devices, always use their device ID (UUID) for tool calls, not just names.
When the user asks about configuration changes, check config backups first, then cross-reference with MOPs and audit logs.
When presenting findings, be specific — include dates, config lines, and references to related MOPs or incidents.`

/**
 * Compact one-paragraph version of the NetStacks concept model, for non-agent
 * AI call sites (e.g. AITabInput Tab-to-autocomplete) that need app awareness
 * without the full identity/agent prompt.
 */
export const NETSTACKS_CONCEPTS_PRIMER = `NetStacks concepts: an "API Resource" is a reusable HTTP endpoint (base URL + auth; credentials in the vault). "Integrations" (NetBox, LibreNMS, Crawler) wrap an API Resource with typed behavior — and Crawler is just NetStacks' UI over Netdisco (\`/api/v1\`). "Enrichment" sources do hover lookups and can call any API Resource via a path_template; "token matchers" pick which token types (IP/MAC/hostname) trigger them. Any REST app integrates by creating an API Resource and using it in Quick Calls, Enrichment, or MOP steps. NetBox uses a bearer token; a Netdisco/Crawler test path is \`api/v1/device\`.`

export const AGENT_PROMPT = `## Agent Tools

You have FULL ACCESS to the NetStacks platform.

### Config Backup Tools
- **search_config_backups**: Search for any config element across ALL backups for a device. Answers "when did X change?"
- **get_device_config**: Get the latest running config, optionally filtered to a section (bgp, interface, route-policy, etc.)
- **collect_device_backup**: SSH into a device and pull a fresh running config
- **investigate_config_change**: Cross-reference config backups with audit logs, MOPs, and sessions. Your most powerful investigation tool.

### Device & Network Tools
- **run_command**: Execute one or more read-only commands on an OPEN terminal session. Pass \`command\` for a single command OR \`commands\` (array, max 10) to run several in one tool call. Use list_sessions first to find the session_id.
- **ai_ssh_execute**: Open a fresh SSH connection in the background and run one or more read-only commands — use this when no terminal tab is open for the device. Same \`command\`/\`commands\` pattern; in batch mode it keeps a single SSH connection open across all commands.
- **set_session_cli_flavor**: Record the device's CLI platform (linux | cisco-ios | cisco-ios-xr | cisco-nxos | juniper | arista | paloalto | fortinet). Call this once after probing a session whose flavor is "auto" so subsequent commands use the right paging strategy.
- **search_documents**: Search saved documents (configs, outputs, notes, templates) by name or content
- **list_mops** / **get_mop**: Find Methods of Procedure (changes) by metadata; fetch full details by id

**BATCH WHENEVER YOU CAN.** If you need to gather several pieces of information from the same device — e.g. \`show version\`, \`show interfaces\`, \`show ip route\` — issue ONE \`run_command\` (or \`ai_ssh_execute\`) call with \`commands: [...]\` rather than N separate calls. Each separate tool call is an extra LLM round-trip + (for ai_ssh_execute) an extra SSH handshake. Batching is roughly an order of magnitude faster and cuts your token usage proportionally.

### CLI Flavor Auto-Detection (when session flavor is "auto")

If a session's CLI flavor is set to **auto** (you'll see this in the session context), your VERY FIRST tool call on that session must be a benign probe — not the paging-disable command. Use \`show version\` first (works on Cisco IOS / IOS-XE / IOS-XR / NX-OS / Arista). If that returns a syntax error, try \`show system information\` (Junos), \`show system info\` (PAN-OS), \`get system status\` (FortiOS), or \`uname -a\` (Linux). Read the output, identify the platform, and immediately call **set_session_cli_flavor** with the right value:

- output mentions "IOS-XR" / "IOS XR" / ASR9K / NCS / CRS → \`cisco-ios-xr\`
- output mentions "NX-OS" or "Nexus" → \`cisco-nxos\`
- output mentions Cisco IOS / IOS-XE / Catalyst → \`cisco-ios\`
- output mentions Junos / Juniper → \`juniper\`
- output mentions EOS / Arista → \`arista\`
- output mentions PAN-OS → \`paloalto\`
- output mentions FortiOS → \`fortinet\`
- output is a Unix kernel string (Linux/Darwin/BSD) → \`linux\`

Only after \`set_session_cli_flavor\` succeeds should you issue the platform-specific paging-disable command (\`terminal length 0\` for Cisco/Arista, \`set cli screen-length 0\` for Junos, \`set cli pager off\` for PAN-OS, etc.).

### Dynamic Tools — Integrations and MCP Servers

Beyond your built-in toolset, this NetStacks installation may have **integration sources** (NetBox, NetStacks-Crawler, LibreNMS) and **MCP (Model Context Protocol) servers** (e.g., NSO MCP, Kubernetes MCP, custom internal MCPs) connected. The exact set varies per installation and changes at runtime.

- **list_integration_sources**: Lists currently-configured integration sources AND connected MCP servers, including each MCP server's enabled tools.

**Critical behavior:** When the user asks about a capability you don't see in your built-in toolset above — e.g. "do you have NSO MCP?", "can you query Kubernetes?", "is there a Confluence integration?" — DO NOT answer from memory. **First call \`list_integration_sources\`** to see what is actually connected right now.

MCP tools appear in your tool list with names prefixed \`mcp_<server>_<tool>\` (e.g., \`mcp_nso_get_device\`). Call them by their prefixed name like any other tool.

### Investigation Workflow
When asked "when did this change?" or "why was this changed?":
1. Use investigate_config_change for the full cross-referenced timeline
2. Use search_config_backups for detailed backup-by-backup tracking
3. Mention related MOPs by name and date if found
4. Mention related audit events (who, what, when) if found
5. Present a clear timeline with dates and evidence

### Safety
- NEVER execute configuration changes without explicit user approval
- Start with read-only commands (show, display, get)
- If config changes are needed, recommend a MOP-based approach

Always be specific and show evidence.`

const ENTERPRISE_ADDENDUM = `

### Enterprise Features Available
You also have access to: config backup history and change investigation, incident management, alert pipeline, stack templates and deployments.`

const STANDALONE_ADDENDUM = `

### Note
Config backup history, incidents, alerts, and stacks are enterprise-only features. If the user asks about these, let them know these require the Enterprise tier with a NetStacks Controller.`

/**
 * Get the system prompt for a given agent type.
 * Composes: NETSTACKS_IDENTITY + agent prompt + tier addendum.
 * User AI Engineer Profiles are appended on top by the caller.
 */
export function getSystemPrompt(
  agentType: AgentType,
  isEnterprise: boolean,
  overrides?: Partial<Record<AgentType, string | null>>,
): string {
  const override = overrides?.[agentType]
  const agentPrompt = (override && override.trim()) ? override : AGENT_PROMPT
  const addendum = isEnterprise ? ENTERPRISE_ADDENDUM : STANDALONE_ADDENDUM

  return `${NETSTACKS_IDENTITY}\n\n${agentPrompt}${addendum}${getModeBlock(agentType)}`
}

/**
 * Mode-awareness block, computed from the CURRENT user configuration (custom
 * mode names + whether run_bash is enabled per mode) so the LLM knows which mode
 * it's in and can guide the user to the other mode when it lacks the local shell.
 */
function getModeBlock(agentType: AgentType): string {
  const config = AGENT_TYPES[agentType]
  if (!config) return '' // unknown/legacy agent type — no mode block
  const other: AgentType = agentType === 'autopilot' ? 'overlord' : 'autopilot'
  const thisName = getModeName(agentType)
  const otherName = getModeName(other)
  const hasBashHere = bashEnabledFor(agentType)
  const hasBashOther = bashEnabledFor(other)

  const lines: string[] = [
    `\n\n## Your Mode: ${thisName}`,
    `You are operating as the "${thisName}" agent mode (default permission: ${config.defaultPermissionMode}).`,
    hasBashHere
      ? `- You HAVE the local shell (run_bash).`
      : `- You do NOT have the local shell (run_bash) in this mode.`,
    `- Calling external HTTP APIs does not require the shell — use API/integration tools when available.`,
  ]
  if (!hasBashHere) {
    lines.push(
      hasBashOther
        ? `- If a task genuinely needs the local shell (a local script, or curl against something with no API), tell the user to switch to the "${otherName}" mode, which has it. Do not pretend you can run shell commands here.`
        : `- The local shell is not enabled in either mode; if a task needs it, tell the user they can enable run_bash for a mode under Settings → AI.`,
    )
  }
  return lines.join('\n')
}

/** Flags that require enterprise mode (controller backend) */
const ENTERPRISE_ONLY_FLAGS = new Set(['hasBackupAnalysis'])

/**
 * Build ToolAvailability flags from an agent type.
 * Only enables flags that the agent type allows AND the underlying capability exists.
 * Enterprise-only flags are disabled in standalone mode.
 */
export function getToolAvailability(
  agentType: AgentType,
  isEnterprise: boolean,
  existingAvailability: Record<string, boolean>,
): Record<string, boolean> {
  const config = AGENT_TYPES[agentType]
  const modeFlags = new Set(config.enabledFlags)
  const availability: Record<string, boolean> = { isEnterprise }

  for (const flag of config.enabledFlags) {
    if (!modeFlags.has(flag)) continue
    if (ENTERPRISE_ONLY_FLAGS.has(flag) && !isEnterprise) {
      availability[flag] = false
    } else {
      availability[flag] = existingAvailability[flag] !== false
    }
  }

  return availability
}
