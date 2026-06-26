/**
 * Unified parser entry point for device enrichment
 * Combines version, resources, and interfaces parsers
 */

import type {
  CliFlavor,
  DeviceEnrichment,
  InterfaceEnrichment,
  ParsedEnrichment,
} from '../../types/enrichment';

import {
  parseVersionOutput,
  parseUptimeToSeconds,
  formatUptime,
  detectCliFlavorFromVersion,
} from './versionParser';

import { parseResourcesOutput } from './resourcesParser';

import {
  parseInterfacesOutput,
  findInterfaceByName,
  normalizeInterfaceName,
  determineInterfaceStatus,
} from './interfacesParser';

// Re-export individual parsers for direct use
export {
  // Version parser
  parseVersionOutput,
  parseUptimeToSeconds,
  formatUptime,
  detectCliFlavorFromVersion,
  // Resources parser
  parseResourcesOutput,
  // Interfaces parser
  parseInterfacesOutput,
  findInterfaceByName,
  normalizeInterfaceName,
  determineInterfaceStatus,
};

// Re-export types
export type {
  CliFlavor,
  DeviceEnrichment,
  InterfaceEnrichment,
  ParsedEnrichment,
} from '../../types/enrichment';

/**
 * Command key patterns for identifying output types
 */
const VERSION_COMMANDS = ['show version', 'uname'];
const RESOURCES_COMMANDS = [
  'show processes cpu',
  'show processes memory',
  'show system resources',
  'show chassis routing-engine',
  'show system uptime',
  'show processes top',
  'uptime',
  'free',
  'top',
];
const INTERFACES_COMMANDS = ['show interfaces', 'show interface', 'ip link', 'ip -s link'];

/**
 * Check if a command key matches any pattern
 */
function matchesCommand(key: string, patterns: string[]): boolean {
  const keyLower = key.toLowerCase();
  return patterns.some(p => keyLower.includes(p.toLowerCase()));
}

/**
 * Parse all enrichment data from command outputs
 *
 * @param outputs - Record of command outputs keyed by command string
 *                  e.g., { 'show version': '...output...', 'show interfaces': '...output...' }
 * @param flavor - CLI flavor for parsing rules
 * @returns ParsedEnrichment with device data and interfaces array
 *
 * @example
 * ```typescript
 * const outputs = {
 *   'show version': '... Cisco IOS ... Version 17.6.3 ...',
 *   'show processes cpu | include CPU': '... CPU utilization: 23% ...',
 *   'show interfaces': '... GigabitEthernet0/1 is up ...',
 * };
 *
 * const result = parseEnrichmentData(outputs, 'cisco-ios');
 * // result.device.osVersion === '17.6.3'
 * // result.device.cpuPercent === 23
 * // result.interfaces[0].name === 'GigabitEthernet0/1'
 * ```
 */
export function parseEnrichmentData(
  outputs: Record<string, string>,
  flavor: CliFlavor
): ParsedEnrichment {
  const device: Partial<DeviceEnrichment> = {
    collectedAt: new Date().toISOString(),
    cliFlavor: flavor,
    rawOutputs: outputs,
  };

  let interfaces: InterfaceEnrichment[] = [];

  // Categorize outputs by command type
  const versionOutputs: string[] = [];
  const resourcesOutputs: string[] = [];
  const interfacesOutputs: string[] = [];

  for (const [cmd, output] of Object.entries(outputs)) {
    if (!output || output.trim().length === 0) continue;

    if (matchesCommand(cmd, VERSION_COMMANDS)) {
      versionOutputs.push(output);
    }
    if (matchesCommand(cmd, RESOURCES_COMMANDS)) {
      resourcesOutputs.push(output);
    }
    if (matchesCommand(cmd, INTERFACES_COMMANDS)) {
      interfacesOutputs.push(output);
    }
  }

  // Parse version output
  for (const output of versionOutputs) {
    const versionData = parseVersionOutput(output, flavor);
    Object.assign(device, versionData);
  }

  // Parse resources output
  if (resourcesOutputs.length > 0) {
    const resourcesData = parseResourcesOutput(resourcesOutputs, flavor);
    Object.assign(device, resourcesData);
  }

  // Parse interfaces output
  for (const output of interfacesOutputs) {
    const parsedInterfaces = parseInterfacesOutput(output, flavor);
    interfaces = interfaces.concat(parsedInterfaces);
  }

  // Deduplicate interfaces by name (keep first occurrence)
  const seenNames = new Set<string>();
  interfaces = interfaces.filter(iface => {
    const normalizedName = iface.name.toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });

  return {
    device,
    interfaces,
  };
}

/**
 * Auto-detect CLI flavor and parse enrichment data
 * Uses the version output to detect the flavor
 *
 * @param outputs - Record of command outputs
 * @returns ParsedEnrichment with detected flavor
 */
export function parseEnrichmentDataAutoDetect(
  outputs: Record<string, string>
): ParsedEnrichment {
  // Try to detect flavor from version output
  let detectedFlavor: CliFlavor | undefined;

  for (const [cmd, output] of Object.entries(outputs)) {
    if (matchesCommand(cmd, VERSION_COMMANDS)) {
      detectedFlavor = detectCliFlavorFromVersion(output);
      if (detectedFlavor) break;
    }
  }

  // Default to cisco-ios if detection fails
  const flavor = detectedFlavor || 'cisco-ios';

  return parseEnrichmentData(outputs, flavor);
}

/**
 * Parse a single command output and add to existing enrichment
 * Useful for incremental updates
 *
 * @param existing - Existing parsed enrichment to update
 * @param command - Command that produced the output
 * @param output - Command output
 * @param flavor - CLI flavor
 * @returns Updated ParsedEnrichment
 */
export function updateEnrichmentData(
  existing: ParsedEnrichment,
  command: string,
  output: string,
  flavor: CliFlavor
): ParsedEnrichment {
  const device = { ...existing.device };
  let interfaces = [...existing.interfaces];

  // Update raw outputs
  if (!device.rawOutputs) {
    device.rawOutputs = {};
  }
  device.rawOutputs[command] = output;

  // Parse based on command type
  if (matchesCommand(command, VERSION_COMMANDS)) {
    const versionData = parseVersionOutput(output, flavor);
    Object.assign(device, versionData);
  }

  if (matchesCommand(command, RESOURCES_COMMANDS)) {
    const resourcesData = parseResourcesOutput([output], flavor);
    Object.assign(device, resourcesData);
  }

  if (matchesCommand(command, INTERFACES_COMMANDS)) {
    const parsedInterfaces = parseInterfacesOutput(output, flavor);
    // Merge interfaces, updating existing by name
    for (const iface of parsedInterfaces) {
      const existingIdx = interfaces.findIndex(
        i => i.name.toLowerCase() === iface.name.toLowerCase()
      );
      if (existingIdx >= 0) {
        interfaces[existingIdx] = iface;
      } else {
        interfaces.push(iface);
      }
    }
  }

  return {
    device,
    interfaces,
  };
}

/**
 * Create an empty ParsedEnrichment object
 */
export function createEmptyEnrichment(sessionId?: string): ParsedEnrichment {
  return {
    device: {
      sessionId,
      collectedAt: new Date().toISOString(),
    },
    interfaces: [],
  };
}

/**
 * Check if enrichment data is complete enough for display
 * Requires at least vendor/model or some resource data
 */
export function isEnrichmentComplete(enrichment: ParsedEnrichment): boolean {
  const { device, interfaces } = enrichment;

  const hasDeviceInfo = !!(device.vendor || device.model || device.osVersion);
  const hasResourceInfo = !!(device.cpuPercent !== undefined || device.memoryPercent !== undefined);
  const hasInterfaceInfo = interfaces.length > 0;

  return hasDeviceInfo || hasResourceInfo || hasInterfaceInfo;
}
