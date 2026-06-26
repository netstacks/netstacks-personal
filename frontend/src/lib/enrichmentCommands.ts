/**
 * CLI command sets per vendor flavor for device enrichment
 * These commands are executed to gather version, resource, and interface data
 */

import type { CliFlavor } from '../types/enrichment';

/**
 * Command set structure for each CLI flavor
 */
export interface CommandSet {
  /** Commands to get version/device info */
  version: string[];
  /** Commands to get CPU/memory resources */
  resources: string[];
  /** Commands to get interface details */
  interfaces: string[];
}

/**
 * Command sets for each supported CLI flavor
 */
export const COMMAND_SETS: Record<CliFlavor, CommandSet> = {
  auto: {
    version: [],
    resources: [],
    interfaces: [],
  },
  'cisco-ios': {
    version: ['show version'],
    resources: ['show processes cpu | include CPU', 'show processes memory | include Processor'],
    interfaces: ['show interfaces'],
  },
  'cisco-ios-xr': {
    version: ['show version'],
    resources: ['show processes cpu | include CPU', 'show memory summary'],
    interfaces: ['show interfaces'],
  },
  'cisco-nxos': {
    version: ['show version'],
    resources: ['show system resources'],
    interfaces: ['show interface'],
  },
  'juniper': {
    version: ['show version'],
    resources: ['show system uptime', 'show chassis routing-engine'],
    interfaces: ['show interfaces extensive'],
  },
  'arista': {
    version: ['show version'],
    resources: ['show processes top once'],
    interfaces: ['show interfaces'],
  },
  paloalto: {
    version: [],
    resources: [],
    interfaces: [],
  },
  fortinet: {
    version: [],
    resources: [],
    interfaces: [],
  },
  linux: {
    version: ['uname -a'],
    resources: ['uptime', 'free -h', 'top -bn1 | head -5'],
    interfaces: ['ip -s link'],
  },
};

/**
 * Get all commands for a CLI flavor flattened into a single array
 * @param flavor - The CLI flavor to get commands for
 * @returns Array of all commands for the flavor
 */
export function getCommandsForFlavor(flavor: CliFlavor): string[] {
  const commandSet = COMMAND_SETS[flavor];
  if (!commandSet) {
    return [];
  }
  return [...commandSet.version, ...commandSet.resources, ...commandSet.interfaces];
}

/**
 * Get commands by category for a CLI flavor
 * @param flavor - The CLI flavor
 * @param category - The command category
 * @returns Array of commands for the specified category
 */
export function getCommandsByCategory(
  flavor: CliFlavor,
  category: keyof CommandSet
): string[] {
  const commandSet = COMMAND_SETS[flavor];
  if (!commandSet) {
    return [];
  }
  return commandSet[category];
}

/**
 * Get all supported CLI flavors
 * @returns Array of supported CLI flavor identifiers
 */
export function getSupportedFlavors(): CliFlavor[] {
  return Object.keys(COMMAND_SETS) as CliFlavor[];
}

/**
 * Check if a CLI flavor is supported
 * @param flavor - The CLI flavor to check
 * @returns True if the flavor is supported
 */
export function isFlavorSupported(flavor: string): flavor is CliFlavor {
  return flavor in COMMAND_SETS;
}
