/**
 * NeighborParser - Parse CDP and LLDP neighbor output
 * for network topology discovery
 */

/**
 * Neighbor entry from CDP/LLDP output
 */
export interface NeighborEntry {
  /** Local interface, e.g., "GigabitEthernet0/1" */
  localInterface: string;
  /** Neighbor device name/hostname */
  neighborName: string;
  /** Management IP address if available */
  neighborIp?: string;
  /** Remote port/interface, e.g., "Gi0/2" */
  neighborInterface?: string;
  /** Platform/device type, e.g., "Cisco IOS", "Juniper" */
  neighborPlatform?: string;
  /** Discovery protocol used */
  protocol: 'cdp' | 'lldp';
}

/**
 * Result from neighbor parsing
 */
export interface NeighborParseResult {
  /** Protocol detected */
  protocol: 'cdp' | 'lldp';
  /** Discovered neighbors */
  neighbors: NeighborEntry[];
  /** Local device hostname if detected */
  deviceName?: string;
}

/**
 * Regex patterns for CDP and LLDP output parsing
 */
const PATTERNS = {
  // CDP Detection - "show cdp neighbors detail" header indicators
  cdpHeader: /^Device ID:/im,
  cdpDetailSection: /CDP\s+neighbor/i,

  // LLDP Detection - "show lldp neighbors detail" header indicators
  lldpHeader: /^Chassis id:/im,
  lldpDetailSection: /LLDP\s+neighbor/i,
  lldpLocal: /^Local Intf:/im,
  // Arista LLDP detection
  aristaLldpHeader: /^Interface\s+\S+\s+detected\s+\d+\s+LLDP\s+neighbor/im,
  // Juniper LLDP detection (uses "LLDP Neighbor Information:" blocks)
  juniperLldpHeader: /^LLDP Neighbor Information:/im,

  // CDP Fields (Cisco IOS/NX-OS)
  cdpDeviceId: /^Device ID:\s*(.+?)$/im,
  cdpIpAddress: /(?:IP(?:v4)?\s+[Aa]ddress|Entry address\(es\)|Mgmt address):\s*\n?\s*([\d.]+)/im,
  cdpIpAddressAlternate: /^\s+IP(?:v4)?\s+[Aa]ddress:\s*([\d.]+)/im,
  cdpPlatform: /^Platform:\s*(.+?)(?:,|$)/im,
  cdpInterface: /^Interface:\s*(\S+)\s*,/im,
  cdpPortId: /Port ID\s*\(outgoing port\):\s*(\S+)/im,

  // LLDP Fields (Cisco IOS/NX-OS)
  lldpLocalIntf: /^Local Intf:\s*(\S+)/im,
  lldpChassisId: /^Chassis id:\s*(\S+)/im,
  lldpPortId: /^Port id:\s*(.+?)$/im,
  lldpPortDescription: /^Port Description:\s*(.+?)$/im,
  lldpSystemName: /^System Name:\s*(.+?)$/im,
  lldpSystemDescription: /^System Description:\s*\n?\s*(.+?)$/im,
  lldpMgmtAddress: /^Management Addresses?:?\s*\n?\s*(?:IP(?:v4)?:\s*)?([\d.]+)/im,
  lldpMgmtAddressAlternate: /^\s+IP:\s*([\d.]+)/im,

  // Juniper LLDP Fields (uses spaces before colons)
  juniperLocalInterface: /^Local Interface\s+:\s*(\S+)/im,
  juniperChassisId: /^Chassis ID\s+:\s*(\S+)/im,
  juniperPortId: /^Port ID\s+:\s*(.+?)$/im,
  juniperPortDescription: /^Port description\s+:\s*(.+?)$/im,
  juniperSystemName: /^System name\s+:\s*(.+?)$/im,
  juniperSystemDescription: /^System Description\s+:\s*(.+?)$/im,
  juniperMgmtAddress: /^\s+Address\s+:\s*([\d.]+)/im,
  juniperMgmtAddressType: /^\s+Address Type\s+:\s*IPv4/im,

  // Arista LLDP Fields (uses spaces before colons and quotes around values)
  aristaInterface: /^Interface\s+(\S+)\s+detected\s+\d+\s+LLDP\s+neighbor/im,
  aristaChassisId: /Chassis ID\s+:\s*(\S+)/im,
  aristaPortId: /Port ID\s+:\s*"?([^"\n]+)"?/im,
  aristaPortDescription: /Port Description:\s*"?([^"\n]+)"?/im,
  aristaSystemName: /System Name:\s*"?([^"\n]+)"?/im,
  aristaSystemDescription: /System Description:\s*"?([^"\n]+)"?/im,
  aristaMgmtAddress: /Management Address\s+:\s*([\d.]+)/im,

  // IPv4 address pattern
  ipv4: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/,
};

/**
 * NeighborParser class for parsing CDP/LLDP output
 */
export class NeighborParser {
  /**
   * Auto-detect protocol and parse neighbor output
   */
  static parse(output: string): NeighborParseResult {
    if (this.isCdpOutput(output)) {
      return {
        protocol: 'cdp',
        neighbors: this.parseCdp(output),
        deviceName: this.extractLocalDeviceName(output, 'cdp'),
      };
    }

    if (this.isLldpOutput(output)) {
      return {
        protocol: 'lldp',
        neighbors: this.parseLldp(output),
        deviceName: this.extractLocalDeviceName(output, 'lldp'),
      };
    }

    // Unknown format - return empty result
    return {
      protocol: 'cdp', // Default
      neighbors: [],
    };
  }

  /**
   * Check if output is from CDP command
   */
  static isCdpOutput(output: string): boolean {
    if (!output || output.trim().length === 0) return false;
    return PATTERNS.cdpHeader.test(output) ||
           PATTERNS.cdpDetailSection.test(output);
  }

  /**
   * Check if output is from LLDP command
   */
  static isLldpOutput(output: string): boolean {
    if (!output || output.trim().length === 0) return false;
    return PATTERNS.lldpHeader.test(output) ||
           PATTERNS.lldpDetailSection.test(output) ||
           PATTERNS.lldpLocal.test(output) ||
           PATTERNS.aristaLldpHeader.test(output) ||
           PATTERNS.juniperLldpHeader.test(output);
  }

  /**
   * Check if output is Arista LLDP format
   */
  static isAristaLldpOutput(output: string): boolean {
    if (!output || output.trim().length === 0) return false;
    return PATTERNS.aristaLldpHeader.test(output);
  }

  /**
   * Check if output is Juniper LLDP format
   */
  static isJuniperLldpOutput(output: string): boolean {
    if (!output || output.trim().length === 0) return false;
    return PATTERNS.juniperLldpHeader.test(output);
  }

  /**
   * Parse Cisco CDP neighbors detail output
   */
  static parseCdp(output: string): NeighborEntry[] {
    const neighbors: NeighborEntry[] = [];
    if (!output || output.trim().length === 0) return neighbors;

    // Split by "Device ID:" to get each neighbor block
    // Use lookahead to keep the delimiter in the split
    const blocks = output.split(/(?=^Device ID:)/im).filter(b => b.trim());

    for (const block of blocks) {
      const neighbor = this.parseCdpBlock(block);
      if (neighbor) {
        neighbors.push(neighbor);
      }
    }

    return neighbors;
  }

  /**
   * Parse a single CDP neighbor block
   */
  private static parseCdpBlock(block: string): NeighborEntry | null {
    // Extract Device ID (required)
    const deviceMatch = block.match(PATTERNS.cdpDeviceId);
    if (!deviceMatch) return null;

    const neighborName = deviceMatch[1].trim();
    if (!neighborName) return null;

    // Extract local interface (required)
    const interfaceMatch = block.match(PATTERNS.cdpInterface);
    if (!interfaceMatch) return null;

    const localInterface = interfaceMatch[1].trim();

    // Extract IP address (optional)
    let neighborIp: string | undefined;
    const ipMatch = block.match(PATTERNS.cdpIpAddress) ||
                    block.match(PATTERNS.cdpIpAddressAlternate);
    if (ipMatch) {
      neighborIp = ipMatch[1].trim();
    }

    // Extract platform (optional)
    let neighborPlatform: string | undefined;
    const platformMatch = block.match(PATTERNS.cdpPlatform);
    if (platformMatch) {
      neighborPlatform = platformMatch[1].trim();
    }

    // Extract remote port (optional)
    let neighborInterface: string | undefined;
    const portMatch = block.match(PATTERNS.cdpPortId);
    if (portMatch) {
      neighborInterface = portMatch[1].trim();
    }

    return {
      localInterface,
      neighborName,
      neighborIp,
      neighborInterface,
      neighborPlatform,
      protocol: 'cdp',
    };
  }

  /**
   * Parse LLDP neighbors detail output
   */
  static parseLldp(output: string): NeighborEntry[] {
    const neighbors: NeighborEntry[] = [];
    if (!output || output.trim().length === 0) return neighbors;

    // Check if this is Juniper format (check first - more specific)
    if (this.isJuniperLldpOutput(output)) {
      return this.parseJuniperLldp(output);
    }

    // Check if this is Arista format
    if (this.isAristaLldpOutput(output)) {
      return this.parseAristaLldp(output);
    }

    // Split by "Local Intf:" or "Chassis id:" to get each neighbor block
    // Different vendors may start with different fields
    let blocks: string[];

    if (PATTERNS.lldpLocalIntf.test(output)) {
      // Cisco format: starts with "Local Intf:"
      blocks = output.split(/(?=^Local Intf:)/im).filter(b => b.trim());
    } else {
      // Other format: starts with "Chassis id:"
      blocks = output.split(/(?=^Chassis id:)/im).filter(b => b.trim());
    }

    for (const block of blocks) {
      const neighbor = this.parseLldpBlock(block);
      if (neighbor) {
        neighbors.push(neighbor);
      }
    }

    return neighbors;
  }

  /**
   * Parse Juniper LLDP neighbors detail output
   */
  static parseJuniperLldp(output: string): NeighborEntry[] {
    const neighbors: NeighborEntry[] = [];
    if (!output || output.trim().length === 0) return neighbors;

    // Split by "LLDP Neighbor Information:" to get each neighbor block
    const blocks = output.split(/(?=^LLDP Neighbor Information:)/im).filter(b => b.trim());

    for (const block of blocks) {
      const neighbor = this.parseJuniperLldpBlock(block);
      if (neighbor) {
        neighbors.push(neighbor);
      }
    }

    return neighbors;
  }

  /**
   * Parse a single Juniper LLDP neighbor block
   */
  private static parseJuniperLldpBlock(block: string): NeighborEntry | null {
    // Must have "LLDP Neighbor Information:" header
    if (!PATTERNS.juniperLldpHeader.test(block)) return null;

    // Extract local interface (required)
    const localIntfMatch = block.match(PATTERNS.juniperLocalInterface);
    if (!localIntfMatch) return null;

    const localInterface = localIntfMatch[1].trim();

    // Extract system name (preferred) or chassis ID (fallback)
    let neighborName: string | undefined;
    const sysNameMatch = block.match(PATTERNS.juniperSystemName);
    if (sysNameMatch) {
      neighborName = sysNameMatch[1].trim();
    } else {
      const chassisMatch = block.match(PATTERNS.juniperChassisId);
      if (chassisMatch) {
        neighborName = chassisMatch[1].trim();
      }
    }

    if (!neighborName) return null;

    // Extract management IP - look for IPv4 address after "Address Type : IPv4"
    let neighborIp: string | undefined;
    const mgmtMatch = block.match(PATTERNS.juniperMgmtAddress);
    if (mgmtMatch) {
      neighborIp = mgmtMatch[1].trim();
    }

    // Extract remote port - try Port ID first
    let neighborInterface: string | undefined;
    const portIdMatch = block.match(PATTERNS.juniperPortId);
    if (portIdMatch) {
      neighborInterface = portIdMatch[1].trim();
    }

    // Extract platform from system description
    let neighborPlatform: string | undefined;
    const sysDescMatch = block.match(PATTERNS.juniperSystemDescription);
    if (sysDescMatch) {
      // Take first line of system description as platform
      neighborPlatform = sysDescMatch[1].split('\n')[0].trim();
    }

    return {
      localInterface,
      neighborName,
      neighborIp,
      neighborInterface,
      neighborPlatform,
      protocol: 'lldp',
    };
  }

  /**
   * Parse Arista LLDP neighbors detail output
   */
  static parseAristaLldp(output: string): NeighborEntry[] {
    const neighbors: NeighborEntry[] = [];
    if (!output || output.trim().length === 0) return neighbors;

    // Split by "Interface XXX detected N LLDP neighbors:" to get each interface block
    const blocks = output.split(/(?=^Interface\s+\S+\s+detected\s+\d+\s+LLDP\s+neighbor)/im).filter(b => b.trim());

    for (const block of blocks) {
      const neighbor = this.parseAristaLldpBlock(block);
      if (neighbor) {
        neighbors.push(neighbor);
      }
    }

    return neighbors;
  }

  /**
   * Parse a single Arista LLDP neighbor block
   */
  private static parseAristaLldpBlock(block: string): NeighborEntry | null {
    // Extract local interface from "Interface Ethernet1 detected 1 LLDP neighbors:"
    const localIntfMatch = block.match(PATTERNS.aristaInterface);
    if (!localIntfMatch) return null;

    const localInterface = localIntfMatch[1].trim();

    // Extract system name (required)
    let neighborName: string | undefined;
    const sysNameMatch = block.match(PATTERNS.aristaSystemName);
    if (sysNameMatch) {
      neighborName = sysNameMatch[1].trim().replace(/^"|"$/g, ''); // Remove quotes
    } else {
      // Fallback to chassis ID
      const chassisMatch = block.match(PATTERNS.aristaChassisId);
      if (chassisMatch) {
        neighborName = chassisMatch[1].trim();
      }
    }

    if (!neighborName) return null;

    // Extract management IP
    let neighborIp: string | undefined;
    const mgmtMatch = block.match(PATTERNS.aristaMgmtAddress);
    if (mgmtMatch) {
      neighborIp = mgmtMatch[1].trim();
    }

    // Extract remote port - try Port ID first, then Port Description
    let neighborInterface: string | undefined;
    const portIdMatch = block.match(PATTERNS.aristaPortId);
    if (portIdMatch) {
      neighborInterface = portIdMatch[1].trim().replace(/^"|"$/g, '');
    } else {
      const portDescMatch = block.match(PATTERNS.aristaPortDescription);
      if (portDescMatch) {
        neighborInterface = portDescMatch[1].trim().replace(/^"|"$/g, '');
      }
    }

    // Extract platform from system description
    let neighborPlatform: string | undefined;
    const sysDescMatch = block.match(PATTERNS.aristaSystemDescription);
    if (sysDescMatch) {
      neighborPlatform = sysDescMatch[1].trim().replace(/^"|"$/g, '');
    }

    return {
      localInterface,
      neighborName,
      neighborIp,
      neighborInterface,
      neighborPlatform,
      protocol: 'lldp',
    };
  }

  /**
   * Parse a single LLDP neighbor block
   */
  private static parseLldpBlock(block: string): NeighborEntry | null {
    // Extract local interface (required)
    const localIntfMatch = block.match(PATTERNS.lldpLocalIntf);
    if (!localIntfMatch) return null;

    const localInterface = localIntfMatch[1].trim();

    // Extract system name (preferred) or chassis ID (fallback)
    let neighborName: string | undefined;
    const sysNameMatch = block.match(PATTERNS.lldpSystemName);
    if (sysNameMatch) {
      neighborName = sysNameMatch[1].trim();
    } else {
      const chassisMatch = block.match(PATTERNS.lldpChassisId);
      if (chassisMatch) {
        neighborName = chassisMatch[1].trim();
      }
    }

    if (!neighborName) return null;

    // Extract management IP (optional)
    let neighborIp: string | undefined;
    const mgmtMatch = block.match(PATTERNS.lldpMgmtAddress) ||
                      block.match(PATTERNS.lldpMgmtAddressAlternate);
    if (mgmtMatch) {
      neighborIp = mgmtMatch[1].trim();
    }

    // Extract remote port (optional) - try port ID first, then port description
    let neighborInterface: string | undefined;
    const portIdMatch = block.match(PATTERNS.lldpPortId);
    if (portIdMatch) {
      neighborInterface = portIdMatch[1].trim();
    } else {
      const portDescMatch = block.match(PATTERNS.lldpPortDescription);
      if (portDescMatch) {
        neighborInterface = portDescMatch[1].trim();
      }
    }

    // Extract platform from system description (optional)
    let neighborPlatform: string | undefined;
    const sysDescMatch = block.match(PATTERNS.lldpSystemDescription);
    if (sysDescMatch) {
      // Take first line of system description as platform
      neighborPlatform = sysDescMatch[1].split('\n')[0].trim();
    }

    return {
      localInterface,
      neighborName,
      neighborIp,
      neighborInterface,
      neighborPlatform,
      protocol: 'lldp',
    };
  }

  /**
   * Try to extract local device hostname from output
   */
  private static extractLocalDeviceName(output: string, _protocol: 'cdp' | 'lldp'): string | undefined {
    // Look for common header patterns that might include the local hostname
    // This is often at the top of the output before the neighbor entries

    // Check for prompt-like patterns (e.g., "router#" at start)
    const promptMatch = output.match(/^(\S+)[>#]/m);
    if (promptMatch) {
      return promptMatch[1];
    }

    return undefined;
  }

  /**
   * Determine device type from platform string
   */
  static inferDeviceType(platform: string | undefined): 'router' | 'switch' | 'firewall' | 'server' | 'unknown' {
    if (!platform) return 'unknown';

    const lower = platform.toLowerCase();

    if (lower.includes('router') || lower.includes('isr') || lower.includes('asr') ||
        lower.includes('nexus 7') || lower.includes('mx') || lower.includes('srx')) {
      return 'router';
    }

    if (lower.includes('switch') || lower.includes('catalyst') || lower.includes('nexus') ||
        lower.includes('ex') || lower.includes('qfx')) {
      return 'switch';
    }

    if (lower.includes('firewall') || lower.includes('asa') || lower.includes('pix') ||
        lower.includes('fortinet') || lower.includes('palo alto')) {
      return 'firewall';
    }

    if (lower.includes('server') || lower.includes('linux') || lower.includes('windows')) {
      return 'server';
    }

    return 'unknown';
  }
}
