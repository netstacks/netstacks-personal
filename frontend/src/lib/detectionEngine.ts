/**
 * DetectionEngine - Smart detection of network identifiers in terminal output
 *
 * Provides type-aware pattern matching for IPs, MACs, hostnames, interfaces, etc.
 * Reuses regex patterns from highlightPresets/network.ts to avoid duplication.
 */

import type { Terminal } from '@xterm/xterm';
import { networkPreset } from '../data/highlightPresets/network';
import { compileRegex } from './compileRegex';
import type {
  Detection,
  DetectionType,
  DetectionMetadata,
  IPv4Metadata,
  IPv6Metadata,
  MACMetadata,
  InterfaceMetadata,
  VLANMetadata,
  CIDRMetadata,
  ASNMetadata,
  RegexMetadata,
  MACFormat,
  InterfaceVendor,
} from '../types/detection';

/**
 * Map preset rule names to DetectionType
 */
const PRESET_TYPE_MAP: Record<string, DetectionType> = {
  'IPv4 Address': 'ipv4',
  'IPv6 Address': 'ipv6',
  'MAC Address (colon)': 'mac',
  'MAC Address (dash)': 'mac',
  'MAC Address (dot)': 'mac',
  'Cisco Interface': 'interface',
  'Linux Interface': 'interface',
  'VLAN ID': 'vlan',
  'CIDR Notation': 'cidr',
  'AS Number': 'asn',
};

/**
 * Extract patterns from network preset and compile them
 */
function buildPatternMap(): Map<string, { regex: RegExp; name: string }[]> {
  const map = new Map<string, { regex: RegExp; name: string }[]>();

  // Initialize built-in types
  const types: DetectionType[] = ['ipv4', 'ipv6', 'mac', 'interface', 'vlan', 'cidr', 'asn'];
  for (const type of types) {
    map.set(type, []);
  }

  // Extract patterns from network preset
  for (const rule of networkPreset) {
    const detectionType = PRESET_TYPE_MAP[rule.name];
    if (detectionType && rule.is_regex) {
      try {
        // Compile pattern with global flag for multiple matches
        const flags = rule.case_sensitive ? 'g' : 'gi';
        const regex = compileRegex(rule.pattern, flags);
        map.get(detectionType)!.push({ regex, name: rule.name });
      } catch (err) {
        console.warn(`Failed to compile pattern for ${rule.name}:`, err);
      }
    }
  }

  return map;
}

/**
 * Generate a unique ID for a detection
 */
function generateId(type: string, line: number, startColumn: number): string {
  return `${type}-${line}-${startColumn}-${Date.now().toString(36)}`;
}

/**
 * Check if an IPv4 address is private (RFC 1918)
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;

  // 10.0.0.0/8
  if (parts[0] === 10) return true;

  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;

  return false;
}

/**
 * Check if an IPv4 address is multicast (224.0.0.0/4)
 */
function isMulticastIPv4(ip: string): boolean {
  const firstOctet = parseInt(ip.split('.')[0], 10);
  return firstOctet >= 224 && firstOctet <= 239;
}

/**
 * Check if an IPv4 address is loopback (127.0.0.0/8)
 */
function isLoopbackIPv4(ip: string): boolean {
  return ip.startsWith('127.');
}

/**
 * Detect MAC address format from the value
 */
function detectMACFormat(mac: string): MACFormat {
  if (mac.includes(':')) return 'colon';
  if (mac.includes('-')) return 'dash';
  return 'dot';
}

/**
 * Detect interface vendor from naming convention
 */
function detectInterfaceVendor(iface: string): InterfaceVendor {
  const lower = iface.toLowerCase();

  // Cisco: Gi, Fa, Te, Eth, Et, Se, Po, Vl, Lo, Tu
  if (/^(gi|fa|te|eth|et|se|po|vl|lo|tu)/i.test(lower)) {
    return 'cisco';
  }

  // Juniper: ge-, xe-, et-, ae-
  if (/^(ge-|xe-|et-|ae-)/i.test(lower)) {
    return 'juniper';
  }

  // Linux: eth, ens, enp, eno, enx, wlan, wlp, bond, br, veth, docker, virbr
  if (/^(eth|ens|enp|eno|enx|wlan|wlp|bond|br|veth|docker|virbr)/i.test(lower)) {
    return 'linux';
  }

  return 'unknown';
}

/**
 * Detect interface type from the name
 */
function detectInterfaceType(iface: string): string {
  const lower = iface.toLowerCase();

  if (/^(gi|gigabit)/i.test(lower)) return 'gigabit';
  if (/^(fa|fast)/i.test(lower)) return 'fastethernet';
  if (/^(te|ten)/i.test(lower)) return 'tengigabit';
  if (/^(eth|ens|enp)/i.test(lower)) return 'ethernet';
  if (/^lo/i.test(lower)) return 'loopback';
  if (/^po/i.test(lower)) return 'port-channel';
  if (/^vl/i.test(lower)) return 'vlan';
  if (/^tu/i.test(lower)) return 'tunnel';
  if (/^(wlan|wlp)/i.test(lower)) return 'wireless';
  if (/^(bond)/i.test(lower)) return 'bond';
  if (/^(br|virbr)/i.test(lower)) return 'bridge';
  if (/^(veth|docker)/i.test(lower)) return 'virtual';

  return 'unknown';
}

/**
 * Extract VLAN ID from a VLAN string
 */
function extractVlanId(vlanStr: string): number {
  const match = vlanStr.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

/**
 * Extract ASN number from an ASN string
 */
function extractAsnNumber(asnStr: string): number {
  const match = asnStr.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

/**
 * DetectionEngine class for scanning terminal buffer
 */
export class DetectionEngine {
  private terminal: Terminal;
  private patterns: Map<string, { regex: RegExp; name: string }[]>;
  private destroyed = false;

  constructor(terminal: Terminal) {
    this.terminal = terminal;
    this.patterns = buildPatternMap();
  }

  /**
   * Register a custom regex pattern as a detection type.
   * The type key is stored as "regex:<pattern>" for matching with custom commands.
   */
  addCustomRegex(typeKey: string, pattern: string, name: string): void {
    try {
      const regex = compileRegex(pattern, 'gi');
      if (!this.patterns.has(typeKey)) {
        this.patterns.set(typeKey, []);
      }
      this.patterns.get(typeKey)!.push({ regex, name });
    } catch (err) {
      console.warn(`Failed to compile custom regex "${pattern}":`, err);
    }
  }

  /**
   * Remove all custom regex detection patterns.
   */
  clearCustomRegex(): void {
    for (const key of [...this.patterns.keys()]) {
      if (key.startsWith('regex:')) {
        this.patterns.delete(key);
      }
    }
  }

  /**
   * Scan a single line for detections
   */
  scanLine(lineIndex: number): Detection[] {
    if (this.destroyed) return [];

    const buffer = this.terminal.buffer.active;
    const line = buffer.getLine(lineIndex);
    if (!line) return [];

    const text = line.translateToString(true);
    if (!text.trim()) return [];

    const detections: Detection[] = [];
    const seenRanges: Set<string> = new Set();

    // Scan for each detection type
    for (const [type, patterns] of this.patterns) {
      for (const { regex, name } of patterns) {
        // Reset regex state
        regex.lastIndex = 0;

        let match;
        while ((match = regex.exec(text)) !== null) {
          const value = match[0];
          const startColumn = match.index;
          const endColumn = match.index + value.length;

          // Deduplicate by range
          const rangeKey = `${startColumn}-${endColumn}`;
          if (seenRanges.has(rangeKey)) continue;
          seenRanges.add(rangeKey);

          const detectionType: DetectionType = type.startsWith('regex:') ? 'regex' : type as DetectionType;
          const metadata = this.getMetadata(type, value, name);
          const detection: Detection = {
            id: generateId(type, lineIndex, startColumn),
            type: detectionType,
            value,
            normalizedValue: this.normalizeValue(detectionType, value),
            line: lineIndex,
            startColumn,
            endColumn,
            metadata,
          };

          detections.push(detection);

          // Prevent infinite loop on zero-length matches
          if (value.length === 0) {
            regex.lastIndex++;
          }
        }
      }
    }

    // Sort by column position
    detections.sort((a, b) => a.startColumn - b.startColumn);

    return detections;
  }

  /**
   * Scan a range of lines in the buffer
   */
  scanBuffer(startLine?: number, endLine?: number): Detection[] {
    if (this.destroyed) return [];

    const buffer = this.terminal.buffer.active;
    const viewportY = buffer.viewportY;
    const rows = this.terminal.rows;

    // Default to visible buffer
    const start = startLine ?? viewportY;
    const end = endLine ?? viewportY + rows;

    const detections: Detection[] = [];

    for (let i = start; i < end; i++) {
      const lineDetections = this.scanLine(i);
      detections.push(...lineDetections);
    }

    // Sort by line, then column
    detections.sort((a, b) => {
      if (a.line !== b.line) return a.line - b.line;
      return a.startColumn - b.startColumn;
    });

    return detections;
  }

  /**
   * Get type-specific metadata for a detection
   */
  getMetadata(type: string, value: string, _ruleName?: string): DetectionMetadata {
    switch (type) {
      case 'ipv4':
        return {
          type: 'ipv4',
          isPrivate: isPrivateIPv4(value),
          isMulticast: isMulticastIPv4(value),
          isLoopback: isLoopbackIPv4(value),
        } as IPv4Metadata;

      case 'ipv6':
        return {
          type: 'ipv6',
          isLinkLocal: value.toLowerCase().startsWith('fe80'),
          isLoopback: value === '::1',
        } as IPv6Metadata;

      case 'mac':
        return {
          type: 'mac',
          format: detectMACFormat(value),
          oui: undefined, // OUI lookup would require external database
        } as MACMetadata;

      case 'interface':
        return {
          type: 'interface',
          vendor: detectInterfaceVendor(value),
          interfaceType: detectInterfaceType(value),
        } as InterfaceMetadata;

      case 'vlan':
        return {
          type: 'vlan',
          vlanId: extractVlanId(value),
        } as VLANMetadata;

      case 'cidr': {
        // CIDR pattern only captures /prefix, need to reconstruct
        const prefixMatch = value.match(/\/(\d+)/);
        return {
          type: 'cidr',
          networkAddress: '', // Would need IP context to determine
          prefixLength: prefixMatch ? parseInt(prefixMatch[1], 10) : 0,
        } as CIDRMetadata;
      }

      case 'asn':
        return {
          type: 'asn',
          asnNumber: extractAsnNumber(value),
        } as ASNMetadata;

      default:
        // Custom regex detections (type starts with "regex:")
        if (typeof type === 'string' && type.startsWith('regex:')) {
          return {
            type: 'regex',
            pattern: type.slice(6),
          } as RegexMetadata;
        }
        return { type: 'ipv4', isPrivate: false, isMulticast: false, isLoopback: false } as IPv4Metadata;
    }
  }

  /**
   * Normalize a detection value to canonical form
   */
  private normalizeValue(type: DetectionType, value: string): string {
    switch (type) {
      case 'mac':
        // Normalize MAC to lowercase colon-separated
        return value
          .toLowerCase()
          .replace(/[-.]/g, ':')
          .replace(/([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})/g, (_, a, b, c) => {
            // Convert Cisco dot notation to colon
            return `${a.slice(0, 2)}:${a.slice(2)}:${b.slice(0, 2)}:${b.slice(2)}:${c.slice(0, 2)}:${c.slice(2)}`;
          });

      case 'ipv6':
        // Normalize IPv6 to lowercase
        return value.toLowerCase();

      case 'interface':
        // Keep interface names as-is (case matters for some vendors)
        return value;

      default:
        return value;
    }
  }

  /**
   * Dispose of the engine and clean up
   */
  dispose(): void {
    this.destroyed = true;
    this.patterns.clear();
  }
}
