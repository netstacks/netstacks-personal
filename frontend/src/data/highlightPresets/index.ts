// Highlight rule preset libraries
// Bundled presets for common platforms and network environments

import type { NewHighlightRule } from '../../api/highlightRules';
import { networkPreset } from './network';
import { ciscoPreset } from './cisco';
import { juniperPreset } from './juniper';
import { linuxPreset } from './linux';

/**
 * A preset library containing highlight rules for a specific platform/category
 */
export interface PresetLibrary {
  /** Unique identifier for the preset */
  id: string;
  /** Display name */
  name: string;
  /** Description of what the preset covers */
  description: string;
  /** The rules in this preset */
  rules: NewHighlightRule[];
  /** Optional: suggested CLI flavor for auto-suggestion */
  cliFlavor?: string;
}

/**
 * All available preset libraries
 */
export const presetLibraries: PresetLibrary[] = [
  {
    id: 'network',
    name: 'Network Fundamentals',
    description: 'IP addresses, MAC addresses, interface names, VLAN IDs, and other network basics',
    rules: networkPreset,
  },
  {
    id: 'cisco',
    name: 'Cisco IOS',
    description: 'Interface states, BGP/OSPF neighbors, syslog messages, and Cisco-specific patterns',
    rules: ciscoPreset,
    cliFlavor: 'cisco',
  },
  {
    id: 'juniper',
    name: 'Juniper Junos',
    description: 'Commit status, interface states, BGP states, and Junos-specific error patterns',
    rules: juniperPreset,
    cliFlavor: 'juniper',
  },
  {
    id: 'linux',
    name: 'Linux / Unix',
    description: 'Systemd states, log levels, process states, and common Unix error messages',
    rules: linuxPreset,
    cliFlavor: 'linux',
  },
];

/**
 * Get a preset library by ID
 */
export function getPresetLibrary(id: string): PresetLibrary | undefined {
  return presetLibraries.find((p) => p.id === id);
}

/**
 * Get preset libraries that match a CLI flavor
 */
export function getPresetsForCliFlavor(flavor: string): PresetLibrary[] {
  return presetLibraries.filter((p) => p.cliFlavor === flavor);
}

// Re-export individual presets for direct access
export { networkPreset, ciscoPreset, juniperPreset, linuxPreset };
