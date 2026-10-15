/**
 * AI tool permissions — the one resolver every AI tool-execution path consults
 * before running a tool call (useAIAgent's processToolCalls serves the side
 * panel, floating chat and inline popup).
 *
 * Its only inputs are the user's settings — per-agent-type disabled tools and
 * permission mode, the bash deny list, topology structural edits, AI Terminal
 * Mode, the MCP per-tool toggles — and the server-side AI Config Mode status.
 *
 * Deny rules come first and hold in every mode; then the permission mode:
 *   - Ask:     every call needs approval;
 *   - Auto:    reads run, anything that changes state needs approval;
 *   - Go Nuts: everything runs.
 * Background tasks apply the same rules in the sidecar
 * (agent/src/tasks/permissions.rs) from the settings mirrored by
 * lib/aiSettingsMirror.
 */

import { TOOL_REGISTRY, type ToolEffect } from './agentTools'
import { STRUCTURAL_TOPOLOGY_TOOLS, TOPOLOGY_TOOL_EFFECTS, isTopologyTool } from './topologyAITools'
import { checkDeviceCommand, checkShellCommand, type ReadOnlyVerdict } from './readOnlyFilter'
import { PERMISSION_MODE_SETTING, getModeName, type AgentType, type PermissionMode } from './aiModes'
import type { AppSettings } from '../hooks/useSettings'

export type PermissionVerdict =
  | { decision: 'allow' }
  | { decision: 'ask'; reason: string }
  | { decision: 'deny'; reason: string }

export interface PermissionContext {
  agentType: AgentType
  mode: PermissionMode
  /** `ai.disabledTools.<agentType>` */
  disabledTools: readonly string[]
  /** `ai.bash.deniedCommands` — added to the built-in deny list */
  bashDeniedCommands: readonly string[]
  /** `ai.topology.allowStructuralEdits` */
  allowStructuralTopologyEdits: boolean
  /** AI Terminal Mode — gates write_file / edit_file / patch_file */
  terminalMode: boolean
  /** Server-side AI Config Mode — lets device tools run non-read-only commands */
  configMode: boolean
  /**
   * Enterprise: the Controller's /ai/ssh-execute runs its own CommandFilter, so
   * the local deny rule is skipped for ai_ssh_execute. The typing tools
   * (run_command, run_console_command) write straight into the session's PTY,
   * which the Controller does not filter, so they keep the local rule.
   */
  enterprise: boolean
  /** `mcp:<server>:<tool>` names enabled in Settings → AI → MCP Servers */
  enabledMcpTools: ReadonlySet<string>
}

/** The non-settings half of the context, gathered by the caller at call time. */
export type RuntimePermissionState = Pick<PermissionContext, 'terminalMode' | 'configMode' | 'enterprise' | 'enabledMcpTools'>

export function permissionContext(
  settings: AppSettings,
  agentType: AgentType,
  runtime: RuntimePermissionState,
): PermissionContext {
  return {
    agentType,
    mode: settings[PERMISSION_MODE_SETTING[agentType]],
    disabledTools: settings[`ai.disabledTools.${agentType}`],
    bashDeniedCommands: settings['ai.bash.deniedCommands'],
    allowStructuralTopologyEdits: settings['ai.topology.allowStructuralEdits'],
    ...runtime,
  }
}

/** Tools that run commands on a network device; non-read-only needs AI Config Mode. */
export const DEVICE_COMMAND_TOOLS: ReadonlySet<string> = new Set(['run_command', 'run_console_command', 'ai_ssh_execute'])

/** Device command tools whose commands the backend filters itself in enterprise (see PermissionContext.enterprise). */
const SERVER_FILTERED_IN_ENTERPRISE: ReadonlySet<string> = new Set(['ai_ssh_execute'])

/** Remote file tools; they need AI Terminal Mode. */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'patch_file'])

/**
 * Controller config-backup tools that only read. The graph/knowledge server
 * tools have registry rows; any other unlisted controller tool counts as a write.
 */
const CONTROLLER_READ_TOOLS: ReadonlySet<string> = new Set([
  'search_config_backups', 'get_device_config', 'investigate_config_change',
])

const READ_HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The sidecar's built-in bash deny list (agent/src/tasks/tools/bash_filter.rs),
 * so a command the sidecar will refuse is denied here instead of being put to
 * the user for approval first. The sidecar stays the enforcement point.
 */
const BUILTIN_BASH_DENY: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\r\n]/, 'Multi-line commands are not allowed (newline injection)'],
  [/^\s*rm\b/i, 'rm can delete files and directories'],
  [/^\s*rmdir\b/i, 'rmdir removes directories'],
  [/^\s*shred\b/i, 'shred securely destroys files'],
  [/^\s*mkfs\b/i, 'mkfs formats filesystems'],
  [/^\s*fdisk\b/i, 'fdisk modifies disk partitions'],
  [/^\s*parted\b/i, 'parted modifies disk partitions'],
  [/^\s*dd\b/i, 'dd can overwrite disks and devices'],
  [/^\s*shutdown\b/i, 'shutdown powers off or reboots the system'],
  [/^\s*reboot\b/i, 'reboot restarts the system'],
  [/^\s*poweroff\b/i, 'poweroff shuts down the system'],
  [/^\s*halt\b/i, 'halt stops the system'],
  [/^\s*init\s+[0-6]\b/i, 'init changes system runlevel'],
  [/^\s*kill\b/i, 'kill terminates processes'],
  [/^\s*killall\b/i, 'killall terminates processes by name'],
  [/^\s*pkill\b/i, 'pkill terminates processes by pattern'],
  [/^\s*sudo\b/i, 'sudo runs commands with elevated privileges'],
  [/^\s*su\b/i, 'su switches to another user'],
  [/^\s*doas\b/i, 'doas runs commands with elevated privileges'],
  [/^\s*passwd\b/i, 'passwd changes user passwords'],
  [/^\s*useradd\b/i, 'useradd creates system users'],
  [/^\s*userdel\b/i, 'userdel removes system users'],
  [/^\s*usermod\b/i, 'usermod modifies system users'],
  [/^\s*groupadd\b/i, 'groupadd creates system groups'],
  [/^\s*groupdel\b/i, 'groupdel removes system groups'],
  [/^\s*chmod\b/i, 'chmod changes file permissions'],
  [/^\s*chown\b/i, 'chown changes file ownership'],
  [/^\s*chgrp\b/i, 'chgrp changes file group ownership'],
  [/^\s*mount\b/i, 'mount attaches filesystems'],
  [/^\s*umount\b/i, 'umount detaches filesystems'],
  [/^\s*iptables\b/i, 'iptables modifies firewall rules'],
  [/^\s*ip6tables\b/i, 'ip6tables modifies IPv6 firewall rules'],
  [/^\s*nft\b/i, 'nft modifies nftables firewall rules'],
  [/^\s*firewall-cmd\b/i, 'firewall-cmd modifies firewalld rules'],
  [/^\s*systemctl\s+(stop|disable|mask|unmask|enable|start|restart|reload|kill|reset-failed|set-default)\b/i, 'systemctl service modification commands are not allowed'],
  [/^\s*crontab\s+-(r|e)\b/i, 'crontab -r/-e modifies scheduled tasks'],
]

const REGISTRY = new Map(TOOL_REGISTRY.map(t => [t.name, t]))

/**
 * Resolve a `command` / `commands[]` tool input into a command list.
 * Returns [] when neither is present (the tool itself reports the error).
 */
export function resolveCommandList(input: Record<string, unknown>): string[] {
  const list = input.commands
  if (Array.isArray(list) && list.length > 0) {
    return list.filter((c): c is string => typeof c === 'string')
  }
  const single = input.command
  return typeof single === 'string' && single.length > 0 ? [single] : []
}

/** Effect of a tool call's tool. MCP tools, unlisted controller tools and anything unclassified are writes. */
export function toolEffect(tool: string): ToolEffect {
  const entry = REGISTRY.get(tool)
  if (entry) return entry.effect
  if (isTopologyTool(tool)) return TOPOLOGY_TOOL_EFFECTS[tool] ?? 'write'
  if (CONTROLLER_READ_TOOLS.has(tool)) return 'read'
  return 'write'
}

/** First command the classifier does not consider read-only, with its reason. */
function firstNonReadOnly(commands: string[], check: (command: string) => ReadOnlyVerdict): { command: string; reason: string } | null {
  for (const command of commands) {
    const result = check(command)
    if (!result.allowed) return { command: result.command.trim(), reason: result.reason ?? 'not read-only' }
  }
  return null
}

function bashDenyReason(commands: string[], userDenied: readonly string[]): string | null {
  for (const raw of commands) {
    const command = raw.trim()
    for (const [pattern, reason] of BUILTIN_BASH_DENY) {
      if (pattern.test(command)) return `\`${command}\` is blocked by the bash deny list: ${reason}.`
    }
    const lower = command.toLowerCase()
    for (const entry of userDenied) {
      const denied = entry.trim().toLowerCase()
      if (denied && lower.startsWith(denied)) {
        return `\`${command}\` is blocked by your bash deny rule "${entry}" (Settings → AI → AI Tools).`
      }
    }
  }
  return null
}

/** Why the call may not run at all, in any mode; null when no deny rule applies. */
function denyReason(tool: string, input: Record<string, unknown>, ctx: PermissionContext): string | null {
  if (ctx.disabledTools.includes(tool)) {
    return `${tool} is disabled for ${getModeName(ctx.agentType)} in Settings → AI → AI Tools.`
  }
  if (tool.startsWith('mcp:') && !ctx.enabledMcpTools.has(tool)) {
    return `${tool} is disabled in Settings → AI → MCP Servers.`
  }
  if (STRUCTURAL_TOPOLOGY_TOOLS.has(tool) && !ctx.allowStructuralTopologyEdits) {
    return `${tool} changes the topology's structure; turn on "Allow AI to edit topologies" in Settings → AI to allow it.`
  }
  if (FILE_WRITE_TOOLS.has(tool) && !ctx.terminalMode) {
    return `${tool} needs AI Terminal Mode; turn it on in Settings → AI to let the AI write files.`
  }
  if (tool === 'run_bash') {
    return bashDenyReason(resolveCommandList(input), ctx.bashDeniedCommands)
  }
  if (DEVICE_COMMAND_TOOLS.has(tool) && !ctx.configMode && !(ctx.enterprise && SERVER_FILTERED_IN_ENTERPRISE.has(tool))) {
    const offender = firstNonReadOnly(resolveCommandList(input), checkDeviceCommand)
    if (offender) {
      return `\`${offender.command}\` is not read-only (${offender.reason}). Enable AI Config Mode in Settings → AI to allow configuration commands.`
    }
  }
  return null
}

/** Why the call changes state (needs approval in Auto); null when it only reads. */
function writeReason(tool: string, input: Record<string, unknown>): string | null {
  switch (toolEffect(tool)) {
    case 'read':
      return null
    case 'command': {
      const offender = firstNonReadOnly(resolveCommandList(input), tool === 'run_bash' ? checkShellCommand : checkDeviceCommand)
      return offender ? `Not read-only: \`${offender.command}\` (${offender.reason}).` : null
    }
    case 'http': {
      const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET'
      return READ_HTTP_METHODS.has(method) ? null : `${method} request can change the external system.`
    }
    case 'write': {
      const label = REGISTRY.get(tool)?.shortDescription ?? (tool.startsWith('mcp:') ? 'MCP tool' : tool)
      return `${label} changes state outside this conversation.`
    }
  }
}

/**
 * Decide whether an AI tool call runs, needs the user's approval, or is
 * refused. A denied call is never executed and never put to the user.
 */
export function resolveToolPermission(
  tool: string,
  input: Record<string, unknown>,
  ctx: PermissionContext,
): PermissionVerdict {
  const deny = denyReason(tool, input, ctx)
  if (deny) return { decision: 'deny', reason: deny }
  switch (ctx.mode) {
    case 'yolo':
      return { decision: 'allow' }
    case 'ask':
      return { decision: 'ask', reason: 'Ask mode: every tool call needs your approval.' }
    case 'auto': {
      const write = writeReason(tool, input)
      return write ? { decision: 'ask', reason: write } : { decision: 'allow' }
    }
  }
}
