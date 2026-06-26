/**
 * VersionParser - Parse "show version" output to extract device information
 */

/**
 * Device information extracted from show version
 */
export interface DeviceInfo {
  /** Vendor (Arista, Cisco, Juniper, etc.) */
  vendor?: string;
  /** Platform/OS type */
  platform?: string;
  /** Software version */
  version?: string;
  /** Hardware model */
  model?: string;
  /** Serial number */
  serial?: string;
  /** Uptime string */
  uptime?: string;
  /** System MAC address */
  macAddress?: string;
}

/**
 * Regex patterns for different vendors
 */
const PATTERNS = {
  // Arista EOS
  arista: {
    detect: /Arista\s+\w+/i,
    platform: /^(Arista\s+\S+)/im,
    version: /Software image version:\s*(\S+)/im,
    model: /^(Arista\s+\S+)/im,
    serial: /^Serial number:\s*(\S+)/im,
    uptime: /^Uptime:\s*(.+?)$/im,
    mac: /^System MAC address:\s*(\S+)/im,
  },

  // Cisco IOS/IOS-XE
  ciscoIos: {
    detect: /Cisco IOS|IOS-XE/i,
    platform: /^Cisco\s+(.+?)\s+(?:Software|processor)/im,
    version: /Version\s+([\d.]+(?:\([^)]+\))?)/im,
    model: /^(?:cisco|Cisco)\s+(\S+)/im,
    serial: /^Processor board ID\s+(\S+)/im,
    uptime: /uptime is\s+(.+?)$/im,
    mac: /Base ethernet MAC Address\s*:\s*(\S+)/im,
  },

  // Cisco NX-OS
  ciscoNxos: {
    detect: /NX-OS|Nexus/i,
    platform: /^(Nexus\s+\S+)/im,
    version: /NXOS:\s+version\s+(\S+)/im,
    model: /^(?:cisco|Cisco)\s+(Nexus\s+\S+)/im,
    serial: /^Processor Board ID\s+(\S+)/im,
    uptime: /Kernel uptime is\s+(.+?)$/im,
    mac: /Device name:\s*(\S+)/im,
  },

  // Juniper Junos
  juniper: {
    detect: /JUNOS|Juniper/i,
    platform: /^Model:\s*(\S+)/im,
    version: /JUNOS.*\[(\S+)\]/im,
    model: /^Model:\s*(\S+)/im,
    serial: /^Chassis\s+(\S+)/im,
    uptime: /^System booted:\s*(.+?)$/im,
    mac: /Current address:\s*(\S+)/im,
  },

  // Palo Alto
  paloalto: {
    detect: /PAN-OS|Palo Alto/i,
    platform: /^model:\s*(\S+)/im,
    version: /^sw-version:\s*(\S+)/im,
    model: /^model:\s*(\S+)/im,
    serial: /^serial:\s*(\S+)/im,
    uptime: /^uptime:\s*(.+?)$/im,
    mac: /^mac-address:\s*(\S+)/im,
  },

  // Fortinet FortiOS
  fortinet: {
    detect: /FortiGate|FortiOS/i,
    platform: /^Platform Full Name\s*:\s*(.+?)$/im,
    version: /^Version:\s*(.+?)$/im,
    model: /^Version:\s*\w+-(\S+)/im,
    serial: /^Serial-Number:\s*(\S+)/im,
    uptime: /^System time:\s*(.+?)$/im,
    mac: /^MAC Address:\s*(\S+)/im,
  },
};

/**
 * VersionParser class for parsing show version output
 */
export class VersionParser {
  /**
   * Parse show version output and extract device information
   */
  static parse(output: string): DeviceInfo {
    if (!output || output.trim().length === 0) {
      return {};
    }

    // Detect vendor and use appropriate patterns
    if (PATTERNS.arista.detect.test(output)) {
      return this.parseWithPatterns(output, PATTERNS.arista, 'Arista');
    }

    if (PATTERNS.ciscoNxos.detect.test(output)) {
      return this.parseWithPatterns(output, PATTERNS.ciscoNxos, 'Cisco');
    }

    if (PATTERNS.ciscoIos.detect.test(output)) {
      return this.parseWithPatterns(output, PATTERNS.ciscoIos, 'Cisco');
    }

    if (PATTERNS.juniper.detect.test(output)) {
      return this.parseWithPatterns(output, PATTERNS.juniper, 'Juniper');
    }

    if (PATTERNS.paloalto.detect.test(output)) {
      return this.parseWithPatterns(output, PATTERNS.paloalto, 'Palo Alto');
    }

    if (PATTERNS.fortinet.detect.test(output)) {
      return this.parseWithPatterns(output, PATTERNS.fortinet, 'Fortinet');
    }

    // Unknown vendor - try generic extraction
    return this.parseGeneric(output);
  }

  /**
   * Parse output using vendor-specific patterns
   */
  private static parseWithPatterns(
    output: string,
    patterns: typeof PATTERNS.arista,
    vendor: string
  ): DeviceInfo {
    const info: DeviceInfo = { vendor };

    const platformMatch = output.match(patterns.platform);
    if (platformMatch) {
      info.platform = platformMatch[1].trim();
    }

    const versionMatch = output.match(patterns.version);
    if (versionMatch) {
      info.version = versionMatch[1].trim();
    }

    const modelMatch = output.match(patterns.model);
    if (modelMatch) {
      info.model = modelMatch[1].trim();
    }

    const serialMatch = output.match(patterns.serial);
    if (serialMatch) {
      info.serial = serialMatch[1].trim();
    }

    const uptimeMatch = output.match(patterns.uptime);
    if (uptimeMatch) {
      info.uptime = uptimeMatch[1].trim();
    }

    const macMatch = output.match(patterns.mac);
    if (macMatch) {
      info.macAddress = macMatch[1].trim();
    }

    return info;
  }

  /**
   * Generic parsing for unknown vendors
   */
  private static parseGeneric(output: string): DeviceInfo {
    const info: DeviceInfo = {};

    // Try to find version
    const versionMatch = output.match(/[Vv]ersion[:\s]+(\S+)/);
    if (versionMatch) {
      info.version = versionMatch[1].trim();
    }

    // Try to find serial
    const serialMatch = output.match(/[Ss]erial(?:\s+[Nn]umber)?[:\s]+(\S+)/);
    if (serialMatch) {
      info.serial = serialMatch[1].trim();
    }

    // Try to find uptime
    const uptimeMatch = output.match(/[Uu]ptime[:\s]+(.+?)$/m);
    if (uptimeMatch) {
      info.uptime = uptimeMatch[1].trim();
    }

    return info;
  }

  /**
   * Infer vendor from output text
   */
  static inferVendor(output: string): string | undefined {
    if (!output) return undefined;

    const lower = output.toLowerCase();

    if (lower.includes('arista')) return 'Arista';
    if (lower.includes('cisco') || lower.includes('ios')) return 'Cisco';
    if (lower.includes('juniper') || lower.includes('junos')) return 'Juniper';
    if (lower.includes('palo alto') || lower.includes('pan-os')) return 'Palo Alto';
    if (lower.includes('fortinet') || lower.includes('fortigate')) return 'Fortinet';
    if (lower.includes('huawei')) return 'Huawei';
    if (lower.includes('nokia') || lower.includes('alcatel')) return 'Nokia';

    return undefined;
  }
}
