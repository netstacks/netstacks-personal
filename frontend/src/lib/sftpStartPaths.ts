import type { CliFlavor } from '../api/sessions'

/**
 * Default SFTP starting paths by CLI flavor.
 * Used when no per-session override is set.
 */
const CLI_FLAVOR_PATHS: Record<string, string> = {
  'cisco-ios': 'flash:/',
  'cisco-ios-xr': 'harddisk:/',
  'cisco-nxos': 'bootflash:/',
  'juniper': '/var/',
  'arista': 'flash:/',
  'paloalto': '/',
  'fortinet': '/',
}

/**
 * Resolve the SFTP starting path for a session.
 *
 * Priority: session override > cli_flavor default > home dir from pwd()
 */
export function resolveSftpStartPath(
  sftpStartPath: string | null,
  cliFlavor: CliFlavor,
  homeDir: string | null
): string {
  if (sftpStartPath) return sftpStartPath
  const flavorPath = CLI_FLAVOR_PATHS[cliFlavor]
  if (flavorPath) return flavorPath
  return homeDir || '/'
}

/**
 * Known text file extensions for SFTP editor.
 */
const TEXT_EXTENSIONS = new Set([
  '.conf', '.cfg', '.txt', '.log', '.xml', '.json', '.yaml', '.yml',
  '.sh', '.py', '.rb', '.pl', '.js', '.ts', '.css', '.html', '.htm',
  '.ini', '.toml', '.env', '.csv', '.md', '.rst', '.bat', '.ps1',
  '.rules', '.service', '.timer', '.socket', '.network', '.netdev',
])

const MAX_TEXT_FILE_SIZE = 64 * 1024 // 64KB for extensionless files

/**
 * Check if a file is likely a text file based on extension and size.
 */
export function isTextFile(name: string, size: number): boolean {
  const lastDot = name.lastIndexOf('.')
  if (lastDot === -1 || lastDot === 0) {
    // No extension or dotfile — treat as text if small enough
    return size <= MAX_TEXT_FILE_SIZE
  }
  const ext = name.substring(lastDot).toLowerCase()
  return TEXT_EXTENSIONS.has(ext)
}
