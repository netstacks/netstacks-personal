/**
 * Version output parser for device enrichment
 * Parses "show version" and equivalent commands across vendors
 */

import type { CliFlavor, DeviceEnrichment } from '../../types/enrichment';

/**
 * Parse uptime string to seconds
 * Handles formats like:
 * - "1 day, 2 hours, 30 minutes"
 * - "1d 2h 30m"
 * - "45 days, 12:30:45"
 * - "1 week, 2 days, 3 hours, 4 minutes"
 */
export function parseUptimeToSeconds(uptimeStr: string): number {
  if (!uptimeStr) return 0;

  let totalSeconds = 0;

  // Match weeks
  const weeksMatch = uptimeStr.match(/(\d+)\s*w(?:eek)?s?/i);
  if (weeksMatch) {
    totalSeconds += parseInt(weeksMatch[1], 10) * 7 * 24 * 60 * 60;
  }

  // Match days
  const daysMatch = uptimeStr.match(/(\d+)\s*d(?:ay)?s?/i);
  if (daysMatch) {
    totalSeconds += parseInt(daysMatch[1], 10) * 24 * 60 * 60;
  }

  // Match hours
  const hoursMatch = uptimeStr.match(/(\d+)\s*h(?:our)?s?/i);
  if (hoursMatch) {
    totalSeconds += parseInt(hoursMatch[1], 10) * 60 * 60;
  }

  // Match minutes
  const minutesMatch = uptimeStr.match(/(\d+)\s*m(?:inute)?s?/i);
  if (minutesMatch) {
    totalSeconds += parseInt(minutesMatch[1], 10) * 60;
  }

  // Match seconds
  const secondsMatch = uptimeStr.match(/(\d+)\s*s(?:econd)?s?/i);
  if (secondsMatch) {
    totalSeconds += parseInt(secondsMatch[1], 10);
  }

  // Handle HH:MM:SS format (e.g., "12:30:45")
  const timeMatch = uptimeStr.match(/(\d+):(\d+):(\d+)/);
  if (timeMatch) {
    totalSeconds += parseInt(timeMatch[1], 10) * 60 * 60;
    totalSeconds += parseInt(timeMatch[2], 10) * 60;
    totalSeconds += parseInt(timeMatch[3], 10);
  }

  return totalSeconds;
}

// Re-export formatUptime from canonical source (verbose mode matches original behavior)
// parsers/index.ts re-exports this, so callers using the verbose format still work
export { formatUptime } from '../formatters';

/**
 * Parse Cisco IOS show version output
 */
function parseCiscoIos(output: string): Partial<DeviceEnrichment> {
  const result: Partial<DeviceEnrichment> = {
    vendor: 'Cisco',
    cliFlavor: 'cisco-ios',
  };

  // Model: "cisco ISR4451-X/K9 (2RU) processor" or "Cisco IOS-XE"
  const modelMatch = output.match(/(?:cisco|Cisco)\s+(\S+)\s+.*?processor/i) ||
                     output.match(/^cisco\s+(\S+)/im);
  if (modelMatch) {
    result.model = modelMatch[1];
  }

  // Version: "Version 17.6.3" or "Version 15.2(4)M3"
  const versionMatch = output.match(/Version\s+([\d.]+(?:\([^)]+\))?(?:\S*)?)/i);
  if (versionMatch) {
    result.osVersion = versionMatch[1];
  }

  // Uptime: "router uptime is 45 days, 12 hours, 30 minutes"
  const uptimeMatch = output.match(/uptime is\s+(.+?)$/im);
  if (uptimeMatch) {
    const uptimeStr = uptimeMatch[1].trim();
    result.uptimeFormatted = uptimeStr;
    result.uptimeSeconds = parseUptimeToSeconds(uptimeStr);
  }

  // Serial: "Processor board ID FTX1234ABC"
  const serialMatch = output.match(/Processor board ID\s+(\S+)/i);
  if (serialMatch) {
    result.serialNumber = serialMatch[1];
  }

  // Hostname: first line often contains hostname (e.g., "router#show version" or "Cisco IOS Software...")
  // Look for prompt pattern
  const hostnameMatch = output.match(/^(\S+)[>#]/m);
  if (hostnameMatch) {
    result.hostname = hostnameMatch[1];
  }

  return result;
}

/**
 * Parse Cisco NX-OS show version output
 */
function parseCiscoNxos(output: string): Partial<DeviceEnrichment> {
  const result: Partial<DeviceEnrichment> = {
    vendor: 'Cisco',
    cliFlavor: 'cisco-nxos',
  };

  // Model: "Hardware\n  cisco Nexus9000 C93180YC-EX Chassis"
  const modelMatch = output.match(/Hardware\s+.*?\s+([\w-]+)\s+(?:Chassis|Switch)/i) ||
                     output.match(/cisco\s+(Nexus\S*)/i);
  if (modelMatch) {
    result.model = modelMatch[1];
  }

  // Version: "NXOS: version 9.3(8)" or "system:    version 9.3(8)"
  const versionMatch = output.match(/NXOS:\s+version\s+(\S+)/i) ||
                       output.match(/system:\s+version\s+(\S+)/i);
  if (versionMatch) {
    result.osVersion = versionMatch[1];
  }

  // Uptime: "Kernel uptime is 45 day(s), 12 hour(s), 30 minute(s)"
  const uptimeMatch = output.match(/kernel uptime is\s+(.+?)$/im);
  if (uptimeMatch) {
    const uptimeStr = uptimeMatch[1].trim();
    result.uptimeFormatted = uptimeStr;
    result.uptimeSeconds = parseUptimeToSeconds(uptimeStr);
  }

  // Serial: "Processor Board ID SAL12345678"
  const serialMatch = output.match(/Processor\s+Board\s+ID\s+(\S+)/i);
  if (serialMatch) {
    result.serialNumber = serialMatch[1];
  }

  // Device name: "Device name: n9k-spine01"
  const hostnameMatch = output.match(/Device name:\s*(\S+)/i);
  if (hostnameMatch) {
    result.hostname = hostnameMatch[1];
  }

  return result;
}

/**
 * Parse Juniper Junos show version output
 */
function parseJuniperJunos(output: string): Partial<DeviceEnrichment> {
  const result: Partial<DeviceEnrichment> = {
    vendor: 'Juniper',
    cliFlavor: 'juniper',
  };

  // Model: "Model: mx240"
  const modelMatch = output.match(/Model:\s+(\S+)/i);
  if (modelMatch) {
    result.model = modelMatch[1];
  }

  // Version: "Junos: 21.4R3.15" or "JUNOS Base OS boot [21.4R3.15]"
  const versionMatch = output.match(/Junos:\s+(\S+)/i) ||
                       output.match(/JUNOS.*\[(\S+)\]/i);
  if (versionMatch) {
    result.osVersion = versionMatch[1];
  }

  // Hostname: "Hostname: router01"
  const hostnameMatch = output.match(/Hostname:\s+(\S+)/i);
  if (hostnameMatch) {
    result.hostname = hostnameMatch[1];
  }

  // Serial - Juniper often shows serial in chassis section
  const serialMatch = output.match(/Chassis\s+(\S+)\s+/i) ||
                      output.match(/Serial\s+Number\s*:\s*(\S+)/i);
  if (serialMatch) {
    result.serialNumber = serialMatch[1];
  }

  return result;
}

/**
 * Parse Arista EOS show version output
 */
function parseAristaEos(output: string): Partial<DeviceEnrichment> {
  const result: Partial<DeviceEnrichment> = {
    vendor: 'Arista',
    cliFlavor: 'arista',
  };

  // Model: "Arista DCS-7280SR-48C6"
  const modelMatch = output.match(/Arista\s+(\S+)/i);
  if (modelMatch) {
    result.model = modelMatch[1];
  }

  // Version: "Software image version: 4.28.3M"
  const versionMatch = output.match(/Software image version:\s+(\S+)/i);
  if (versionMatch) {
    result.osVersion = versionMatch[1];
  }

  // Uptime: "Uptime: 45 days, 12 hours, 30 minutes"
  const uptimeMatch = output.match(/Uptime:\s+(.+?)$/im);
  if (uptimeMatch) {
    const uptimeStr = uptimeMatch[1].trim();
    result.uptimeFormatted = uptimeStr;
    result.uptimeSeconds = parseUptimeToSeconds(uptimeStr);
  }

  // Serial: "Serial number: SSJ12345678"
  const serialMatch = output.match(/Serial number:\s*(\S+)/i);
  if (serialMatch) {
    result.serialNumber = serialMatch[1];
  }

  // Hostname from prompt or system hostname
  const hostnameMatch = output.match(/^(\S+)[>#]/m);
  if (hostnameMatch) {
    result.hostname = hostnameMatch[1];
  }

  return result;
}

/**
 * Parse Linux uname -a output
 */
function parseLinux(output: string): Partial<DeviceEnrichment> {
  const result: Partial<DeviceEnrichment> = {
    vendor: 'Linux',
    cliFlavor: 'linux',
  };

  // uname -a: "Linux hostname 5.4.0-generic #1 SMP Wed Jan 15 12:00:00 UTC 2025 x86_64"
  const unameMatch = output.match(/^Linux\s+(\S+)\s+(\S+)/m);
  if (unameMatch) {
    result.hostname = unameMatch[1];
    result.osVersion = unameMatch[2]; // kernel version
  }

  // Model from uname - usually the architecture/platform
  const archMatch = output.match(/\s(x86_64|aarch64|armv\d+\w*|i686)\s*$/m);
  if (archMatch) {
    result.model = archMatch[1];
  }

  return result;
}

/**
 * Parse version output based on CLI flavor
 * @param output - Raw command output
 * @param flavor - CLI flavor identifier
 * @returns Partial DeviceEnrichment with extracted data
 */
export function parseVersionOutput(
  output: string,
  flavor: CliFlavor
): Partial<DeviceEnrichment> {
  if (!output || output.trim().length === 0) {
    return {};
  }

  switch (flavor) {
    case 'cisco-ios':
      return parseCiscoIos(output);
    case 'cisco-nxos':
      return parseCiscoNxos(output);
    case 'juniper':
      return parseJuniperJunos(output);
    case 'arista':
      return parseAristaEos(output);
    case 'linux':
      return parseLinux(output);
    default:
      return {};
  }
}

/**
 * Auto-detect CLI flavor from show version output
 * @param output - Raw command output
 * @returns Detected CLI flavor or undefined
 */
export function detectCliFlavorFromVersion(output: string): CliFlavor | undefined {
  if (!output) return undefined;

  const lower = output.toLowerCase();

  // Check NX-OS first (before generic Cisco check)
  if (lower.includes('nx-os') || lower.includes('nexus')) {
    return 'cisco-nxos';
  }

  // Cisco IOS/IOS-XE
  if (lower.includes('cisco ios') || lower.includes('ios-xe') ||
      (lower.includes('cisco') && lower.includes('version'))) {
    return 'cisco-ios';
  }

  // Juniper
  if (lower.includes('junos') || lower.includes('juniper')) {
    return 'juniper';
  }

  // Arista
  if (lower.includes('arista') || lower.includes('eos')) {
    return 'arista';
  }

  // Linux
  if (output.match(/^Linux\s+\S+\s+\d+\.\d+/m)) {
    return 'linux';
  }

  return undefined;
}
