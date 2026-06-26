// Read-only command filter for AI troubleshooting agent
// CRITICAL SAFETY CODE: This prevents the agent from executing configuration commands

import type { CliFlavor } from '../types/enrichment';

/**
 * Commands that are ALWAYS safe (universal across platforms)
 * These prefixes are allowed regardless of CLI flavor
 */
const UNIVERSAL_SAFE_PREFIXES = [
  'show ', 'display ', 'get ', 'list ', 'ping ', 'traceroute ',
  'tracert ', 'nslookup ', 'dig ', 'host ', 'whois ', 'arp ',
  'netstat ', 'ss ', 'ip route', 'ip addr', 'ip link', 'ip neigh',
  'cat ', 'less ', 'more ', 'head ', 'tail ', 'grep ', 'find ',
  'ls ', 'pwd', 'df ', 'du ', 'uptime', 'date', 'hostname',
  'who', 'w ', 'ps ', 'top', 'free ', 'vmstat', 'iostat',
  // Linux hardware/system info (read-only)
  'lscpu', 'lshw', 'lsblk', 'lspci', 'lsusb', 'lsmod', 'lsof ',
  'uname', 'arch', 'nproc', 'getconf ', 'sysctl ',
  'dmidecode', 'hwinfo', 'inxi',
  'fdisk -l', 'blkid', 'mount', 'lsns',
  // Linux networking (read-only)
  'ethtool ', 'ifconfig', 'route ', 'brctl show', 'bridge ',
  'tc qdisc show', 'tc class show', 'tc filter show',
  'iptables -L', 'iptables -S', 'ip6tables -L', 'ip6tables -S',
  'nft list', 'conntrack -L', 'ss -',
  // Linux process/service info (read-only)
  'systemctl status', 'systemctl list', 'systemctl is-',
  'journalctl', 'dmesg', 'last ', 'lastlog',
  'id ', 'groups ', 'getent ',
  // Linux file inspection (read-only)
  'file ', 'stat ', 'wc ', 'md5sum ', 'sha256sum ', 'strings ',
  'hexdump ', 'xxd ', 'readlink ',
  // Docker/container inspection (read-only)
  'docker ps', 'docker images', 'docker inspect', 'docker logs',
  'docker stats', 'docker top', 'docker port', 'docker network ls',
  'docker volume ls', 'docker info', 'docker version',
  'kubectl get', 'kubectl describe', 'kubectl logs', 'kubectl top',
  // Paging control commands (safe - only affect terminal display)
  'terminal length ', 'terminal width ', 'term len ', 'term wid ',
  'terminal pager ', // Arista/Cisco
  // Juniper CLI session settings (not configuration)
  'set cli screen-length ', 'set cli screen-width ',
  'set cli terminal ', 'set cli timestamp ',
  // Palo Alto CLI session settings
  'set cli pager ',
  'set cli config-output-format ',
];

/**
 * Vendor-specific safe command patterns
 * Each vendor has additional commands that are safe in their context
 */
const VENDOR_SAFE_PATTERNS: Record<CliFlavor, RegExp[]> = {
  'auto': [],  // Use universal only
  'linux': [
    /^(show|display|get|list|cat|less|more|head|tail|grep|find|ls|pwd|df|du|uptime|date|hostname|who|w|ps|top|free|vmstat|iostat|ip\s+(route|addr|link|neigh)|ss|netstat|arp|ping|traceroute|dig|nslookup|host|lscpu|lshw|lsblk|lspci|lsusb|lsmod|lsof|uname|arch|nproc|getconf|sysctl|dmidecode|hwinfo|inxi|fdisk|blkid|mount|ethtool|ifconfig|route|brctl|bridge|tc|iptables|ip6tables|nft|conntrack|systemctl|journalctl|dmesg|last|lastlog|id|groups|getent|file|stat|wc|md5sum|sha256sum|strings|hexdump|xxd|readlink|docker|kubectl)\b/i,
  ],
  'cisco-ios': [
    /^show\s+/i,
    /^ping\s+/i,
    /^traceroute\s+/i,
    /^debug\s+/i,  // debug is read-only observation
    /^terminal\s+length\s+\d+/i,  // Pagination control
    /^more\s+/i,
  ],
  'cisco-ios-xr': [
    /^show\s+/i,
    /^ping\s+/i,
    /^traceroute\s+/i,
    /^terminal\s+length\s+\d+/i,
    /^terminal\s+exec\s+prompt\s+/i,  // IOS-XR terminal display tweaks
    /^admin\s+show\s+/i,  // IOS-XR admin-mode read-only show commands
    /^more\s+/i,
  ],
  'cisco-nxos': [
    /^show\s+/i,
    /^ping\s+/i,
    /^traceroute\s+/i,
    /^debug\s+/i,
    /^terminal\s+length\s+\d+/i,
  ],
  'juniper': [
    /^show\s+/i,
    /^ping\s+/i,
    /^traceroute\s+/i,
    /^monitor\s+/i,  // Read-only monitoring
    /^set\s+cli\s+screen-(length|width)\s+\d+/i,  // CLI display only
  ],
  'arista': [
    /^show\s+/i,
    /^ping\s+/i,
    /^traceroute\s+/i,
    /^terminal\s+length\s+\d+/i,
    /^watch\s+/i,  // Read-only watching
  ],
  'paloalto': [
    /^show\s+/i,
    /^ping\s+/i,
    /^traceroute\s+/i,
    /^debug\s+/i,
    /^less\s+/i,
    /^tail\s+/i,
  ],
  'fortinet': [
    /^get\s+/i,
    /^diagnose\s+/i,
    /^execute\s+ping\s+/i,
    /^execute\s+traceroute\s+/i,
  ],
};

/**
 * Commands that are NEVER allowed (blocklist)
 * These patterns are checked FIRST and will always block the command
 *
 * NOTE: Pipes (|) are ALLOWED because they're used for output filtering in network CLIs:
 *   - Juniper: show route | no-more, show log | last 50, show config | match interface
 *   - Cisco: show run | include interface, show log | begin ERROR
 *   - Linux: grep, awk, etc. via pipes
 */
const BLOCKED_PATTERNS = [
  /\bconfig(ure)?\b/i,       // Configuration mode
  /\bedit\b/i,               // Juniper edit mode
  /\bset\s+(?!cli)/i,        // Set commands (except CLI display settings)
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bno\s+/i,                // Negation commands
  /\bclear\s+(?!screen|counters)/i,   // Clear (except screen/counters which are safe)
  /\breset\b/i,
  /\breload\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bformat\b/i,
  /\bwrite\b/i,
  /\bcopy\b/i,
  /\bsave\b/i,
  /\bcommit\b/i,
  /\brequest\s+system/i,     // Juniper system requests
  /\brm\s+/i,                // Linux rm
  /\bmv\s+/i,                // Linux mv
  /\bcp\s+/i,                // Linux cp (could overwrite)
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /[;&`$]/,                  // Command chaining/injection (but NOT pipes!)
  />\s*\S/,                  // Output redirection (to file)
  /\bexec\b/i,
  /\benable\b/i,             // Privilege escalation
];

/**
 * Result of command validation
 */
export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  command: string;
}

/**
 * Validate if a command is read-only (safe to execute)
 *
 * Validation order:
 * 1. Check blocklist first (highest priority - always deny)
 * 2. Check universal safe prefixes
 * 3. Check vendor-specific patterns
 * 4. Default deny (if not explicitly allowed)
 *
 * @param command The command to validate
 * @param cliFlavor The CLI flavor for vendor-specific rules
 * @returns Validation result with allowed status and reason if blocked
 */
export function validateReadOnlyCommand(
  command: string,
  cliFlavor: CliFlavor = 'auto'
): ValidationResult {
  const trimmed = command.trim();

  // Empty commands are not allowed
  if (!trimmed) {
    return {
      allowed: false,
      reason: 'Empty command',
      command: trimmed,
    };
  }

  // Check blocklist first (highest priority)
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: `Command contains blocked pattern: ${pattern.source}`,
        command: trimmed,
      };
    }
  }

  // Check universal safe prefixes
  const lowerCommand = trimmed.toLowerCase();
  for (const prefix of UNIVERSAL_SAFE_PREFIXES) {
    if (lowerCommand.startsWith(prefix)) {
      return { allowed: true, command: trimmed };
    }
  }

  // Check vendor-specific patterns
  const vendorPatterns = VENDOR_SAFE_PATTERNS[cliFlavor] || [];
  for (const pattern of vendorPatterns) {
    if (pattern.test(trimmed)) {
      return { allowed: true, command: trimmed };
    }
  }

  // Default deny - command not recognized as read-only
  return {
    allowed: false,
    reason: 'Command not recognized as read-only. Only show/display/get commands are allowed.',
    command: trimmed,
  };
}

/**
 * Simple boolean check if a command is read-only
 * @param command The command to check
 * @param cliFlavor Optional CLI flavor for vendor-specific rules
 * @returns true if the command is read-only and safe to execute
 */
export function isReadOnlyCommand(command: string, cliFlavor?: CliFlavor): boolean {
  return validateReadOnlyCommand(command, cliFlavor).allowed;
}

/**
 * Get a human-readable explanation of why a command was blocked
 * @param result The validation result
 * @returns User-friendly message explaining the block
 */
export function getBlockReason(result: ValidationResult): string {
  if (result.allowed) {
    return 'Command is allowed';
  }

  if (result.reason?.includes('blocked pattern')) {
    return 'This command could modify device configuration and is not allowed in troubleshooting mode.';
  }

  return 'Only read-only commands (show, display, get, ping, traceroute) are allowed. Configuration commands are blocked for safety.';
}
