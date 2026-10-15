// Read-only classification for AI tool calls (lib/aiPermissions).
//
// Device commands: an exact port of the sidecar's CommandFilter
// (agent/src/tasks/tools/filter.rs), which the sidecar enforces on run_command
// (/ai/command-check) and ai_ssh_execute while AI Config Mode is off. Both
// sides run the shared fixture agent/src/tasks/tools/read_only_commands.json
// in their tests, so a rule changed on one side fails the other's suite.
//
// Local shell (run_bash): a read-only allow-list that only decides whether a
// call needs approval in Auto. The sidecar's BashCommandFilter is the deny gate.

export interface ReadOnlyVerdict {
  allowed: boolean
  reason?: string
  command: string
}

const DEVICE_BLOCKED: ReadonlyArray<readonly [RegExp, string]> = [
  [/[;&|`]|\$\(|>\s*[^=]|<\s*\(|\\\n|&&|\|\|/, 'Shell metacharacters and command chaining are not allowed'],
  [/[\r\n]/, 'Multi-line commands are not allowed'],
  [/^\s*(start\s+shell|bash|run\s+(?:start\s+)?shell|run\s+bash|enable\s+shell|shell|cli|cgi|kshell)\b/m, 'Shell escapes drop into a vendor shell with full command access'],
  [/^\s*do\s+(reload|reset|delete|erase|clear|copy|format|write|debug|enable)\b/m, '`do` invokes privileged commands from config mode'],
  [/^\s*conf(?:ig(?:ure)?)?(?:\s+t(?:erminal)?)?\b/m, 'Configuration mode commands are not allowed'],
  [/^\s*write(?:\s+(?:mem(?:ory)?|erase|file|terminal))?\b/m, 'Write commands modify device configuration'],
  [/^\s*copy\s+(?:run(?:ning)?|start(?:up)?|tftp|ftp|http|scp|usb|flash|disk|nvram)\b/m, 'Copy commands can overwrite configuration or move files'],
  [/^\s*reload\b/m, 'Reload commands restart the device'],
  [/^\s*request\s+(?:system\s+(?:reboot|halt|power-off|zeroize)|chassis\s+(?:cb|routing-engine)|firmware|software)\b/m, '`request` commands trigger administrative actions on Juniper devices'],
  [/^\s*system\s+(?:reset|reboot|halt|shutdown)\b/m, 'System commands restart or halt the device'],
  [/^\s*factory-reset\b/m, 'Factory-reset wipes the device configuration'],
  [/^\s*format\s+(?:flash|disk|bootflash|nvram|usb)/m, 'Format erases device storage'],
  [/^\s*boot\s+system\b/m, 'Boot system changes the boot image'],
  [/^\s*(?:archive|software)\s+(?:download|install|commit|activate)/m, 'Archive/software install changes device firmware'],
  [/^\s*install\s+(?:commit|activate|add|remove)\b/m, 'Install commands modify the active firmware'],
  [/^\s*no\s+\S+/m, 'No commands delete configuration'],
  [/^\s*(?:delete|erase|destroy|wipe)\b/m, 'Delete/erase commands remove files or configurations'],
  [/^\s*clear\s+(?:line|logging|ip|ipv6|arp|mac|counters?|interface|configuration|crypto|isis|ospf|bgp|mpls|route|nd)\b/m, 'Clear commands remove operational data'],
  [/^\s*clear\s+configuration\b/m, 'Clear configuration is a Juniper factory-reset equivalent'],
  [/^\s*set\s+\S+/m, 'Set commands modify Juniper configuration'],
  [/^\s*commit(?:\s+(?:confirmed|check|and-quit|synchronize))?\b/m, 'Commit applies configuration changes'],
  [/^\s*(?:edit|top|exit|update|annotate)\b/m, 'Configuration-mode navigation commands are not allowed'],
  [/^\s*rollback\b/m, 'Rollback reverts configuration changes'],
  [/^\s*(?:load|replace)\s+(?:merge|override|set|patch|update|pattern|terminal)/m, 'Load/replace commands inject configuration'],
  [/^\s*verify\s+(?:md5|sha)/m, 'verify md5/sha can be combined with copy/install workflows'],
  [/^\s*hw-module\s+(?:reset|reload)/m, 'hw-module reset reboots a line card'],
]

const DEVICE_ALLOWED_FIRST_TOKENS: ReadonlySet<string> = new Set([
  'show', 'display', 'get', 'list', 'ping', 'traceroute', 'trace',
])

/** Whether a command may run on a network device while AI Config Mode is off. */
export function checkDeviceCommand(command: string): ReadOnlyVerdict {
  const normalized = command.trim().toLowerCase()
  for (const [pattern, reason] of DEVICE_BLOCKED) {
    if (pattern.test(normalized)) return { allowed: false, reason, command }
  }
  const firstToken = normalized.split(/\s+/)[0] ?? ''
  if (DEVICE_ALLOWED_FIRST_TOKENS.has(firstToken)) return { allowed: true, command }
  return {
    allowed: false,
    reason: `Only commands starting with ${[...DEVICE_ALLOWED_FIRST_TOKENS].join(', ')} are read-only`,
    command,
  }
}

/** Shell constructs that can change state whatever the command. */
const SHELL_BLOCKED: ReadonlyArray<RegExp> = [
  /[;&`$]/,          // chaining / substitution (pipes stay allowed for filtering)
  />\s*\S/,          // redirection to a file
  /\b(?:sudo|su|rm|mv|cp|chmod|chown|tee|dd)\b/i,
]

const SHELL_READ_ONLY = /^(cat|less|more|head|tail|grep|egrep|find|ls|pwd|df|du|uptime|date|hostname|who|w|whoami|ps|top|free|vmstat|iostat|ip\s+(route|addr|link|neigh)(\s+show)?|ss|netstat|arp|ping|traceroute|tracepath|mtr|dig|nslookup|host|whois|lscpu|lshw|lsblk|lspci|lsusb|lsmod|lsof|uname|arch|nproc|getconf|dmidecode|hwinfo|inxi|blkid|ethtool|ifconfig|route|brctl\s+show|tc\s+(qdisc|class|filter)\s+show|systemctl\s+(status|list-\S+|is-\S+)|journalctl|dmesg|last|lastlog|id|groups|getent|file|stat|wc|md5sum|sha256sum|strings|hexdump|xxd|readlink|echo|printenv|env|which|type|docker\s+(ps|images|inspect|logs|stats|top|port|network\s+ls|volume\s+ls|info|version)|kubectl\s+(get|describe|logs|top))\b/i

/** Whether a local shell command only reads (decides approval in Auto). */
export function checkShellCommand(command: string): ReadOnlyVerdict {
  const trimmed = command.trim()
  if (SHELL_BLOCKED.some((pattern) => pattern.test(trimmed))) {
    return { allowed: false, reason: 'can change files or processes', command }
  }
  if (SHELL_READ_ONLY.test(trimmed)) return { allowed: true, command }
  return { allowed: false, reason: 'not a known read-only command', command }
}
