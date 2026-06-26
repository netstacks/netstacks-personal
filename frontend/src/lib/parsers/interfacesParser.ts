/**
 * Interfaces output parser for device enrichment
 * Parses "show interfaces" and equivalent commands across vendors
 */

import type { CliFlavor, InterfaceEnrichment, InterfaceStatus } from '../../types/enrichment';

/**
 * Parse Cisco IOS/IOS-XE show interfaces output
 */
function parseCiscoIos(output: string): InterfaceEnrichment[] {
  const interfaces: InterfaceEnrichment[] = [];

  // Split on interface headers - matches various interface name patterns
  // GigabitEthernet0/0/1, FastEthernet0/1, Ethernet0/0, Vlan10, Loopback0, Port-channel1
  const blocks = output.split(
    /(?=^(?:Gigabit|Fast|Ten|Hundred|Twenty-Five|Forty|Hundred)?Ethernet\S+|^Vlan\d+|^Loopback\d+|^Port-?channel\d+|^Tunnel\d+|^BVI\d+)/im
  ).filter(b => b.trim());

  for (const block of blocks) {
    const iface = parseCiscoInterfaceBlock(block);
    if (iface) {
      interfaces.push(iface);
    }
  }

  return interfaces;
}

/**
 * Parse a single Cisco interface block
 */
function parseCiscoInterfaceBlock(block: string): InterfaceEnrichment | null {
  // Get interface name from first line
  const nameMatch = block.match(/^(\S+)/);
  if (!nameMatch) return null;

  const name = nameMatch[1];

  // Skip if name doesn't look like an interface
  if (!name.match(/^(Gigabit|Fast|Ten|Hundred|Twenty|Forty|Ethernet|Vlan|Loopback|Port-?channel|Tunnel|BVI)/i)) {
    return null;
  }

  const iface: InterfaceEnrichment = {
    name,
    status: 'down',
  };

  // Status: "GigabitEthernet0/1 is up, line protocol is up"
  // or "administratively down"
  if (block.match(/administratively down/i)) {
    iface.status = 'admin-down';
  } else if (block.match(/line protocol is up/i)) {
    iface.status = 'up';
  } else if (block.match(/line protocol is down/i)) {
    iface.status = 'down';
  }

  // Description: "Description: Uplink to core router"
  const descMatch = block.match(/Description:\s*(.+?)$/im);
  if (descMatch) {
    iface.description = descMatch[1].trim();
  }

  // Speed/Bandwidth: "BW 1000000 Kbit"
  const bwMatch = block.match(/BW\s+(\d+)\s*(\w+)/i);
  if (bwMatch) {
    const bw = parseInt(bwMatch[1], 10);
    const unit = bwMatch[2].toLowerCase();
    if (unit.startsWith('k')) {
      iface.speed = bw >= 1000000 ? `${bw / 1000000}G` : bw >= 1000 ? `${bw / 1000}M` : `${bw}K`;
    } else if (unit.startsWith('m')) {
      iface.speed = bw >= 1000 ? `${bw / 1000}G` : `${bw}M`;
    } else if (unit.startsWith('g')) {
      iface.speed = `${bw}G`;
    }
  }

  // Duplex: "Full-duplex" or "Half-duplex" or "auto-duplex"
  const duplexMatch = block.match(/(Full|Half|Auto)[- ]?duplex/i);
  if (duplexMatch) {
    iface.duplex = duplexMatch[1].toLowerCase();
  }

  // MTU: "MTU 1500 bytes"
  const mtuMatch = block.match(/MTU\s+(\d+)/i);
  if (mtuMatch) {
    iface.mtu = parseInt(mtuMatch[1], 10);
  }

  // IP Address: "Internet address is 192.168.1.1/24"
  const ipMatch = block.match(/Internet address is\s+(\S+)/i);
  if (ipMatch) {
    iface.ipAddress = ipMatch[1];
  }

  // MAC Address: "Hardware is ... address is 0000.0000.0001" or "bia 0000.0000.0001"
  const macMatch = block.match(/address is\s+([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})/i) ||
                   block.match(/bia\s+([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})/i) ||
                   block.match(/address.*?([0-9a-f:.-]{14,17})/i);
  if (macMatch) {
    iface.macAddress = macMatch[1];
  }

  // Packet stats: "12345 packets input, 67890 bytes"
  const rxPktsMatch = block.match(/(\d+)\s+packets input/i);
  if (rxPktsMatch) {
    iface.rxPackets = parseInt(rxPktsMatch[1], 10);
  }

  const rxBytesMatch = block.match(/packets input,\s+(\d+)\s+bytes/i);
  if (rxBytesMatch) {
    iface.rxBytes = parseInt(rxBytesMatch[1], 10);
  }

  const txPktsMatch = block.match(/(\d+)\s+packets output/i);
  if (txPktsMatch) {
    iface.txPackets = parseInt(txPktsMatch[1], 10);
  }

  const txBytesMatch = block.match(/packets output,\s+(\d+)\s+bytes/i);
  if (txBytesMatch) {
    iface.txBytes = parseInt(txBytesMatch[1], 10);
  }

  // Errors: "0 input errors" "0 output errors"
  const rxErrMatch = block.match(/(\d+)\s+input errors/i);
  if (rxErrMatch) {
    iface.rxErrors = parseInt(rxErrMatch[1], 10);
  }

  const txErrMatch = block.match(/(\d+)\s+output errors/i);
  if (txErrMatch) {
    iface.txErrors = parseInt(txErrMatch[1], 10);
  }

  return iface;
}

/**
 * Parse Cisco NX-OS show interface output
 * Similar to IOS but with some differences
 */
function parseCiscoNxos(output: string): InterfaceEnrichment[] {
  // NX-OS format is very similar to IOS, reuse the parser
  return parseCiscoIos(output);
}

/**
 * Parse Juniper Junos show interfaces extensive output
 */
function parseJuniperJunos(output: string): InterfaceEnrichment[] {
  const interfaces: InterfaceEnrichment[] = [];

  // Split on "Physical interface:" lines
  const blocks = output.split(/(?=^Physical interface:\s+\S+)/im).filter(b => b.trim());

  for (const block of blocks) {
    const iface = parseJuniperInterfaceBlock(block);
    if (iface) {
      interfaces.push(iface);
    }
  }

  return interfaces;
}

/**
 * Parse a single Juniper interface block
 */
function parseJuniperInterfaceBlock(block: string): InterfaceEnrichment | null {
  // Get interface name: "Physical interface: ge-0/0/0"
  const nameMatch = block.match(/Physical interface:\s+(\S+)/i);
  if (!nameMatch) return null;

  const iface: InterfaceEnrichment = {
    name: nameMatch[1],
    status: 'down',
  };

  // Status: "Enabled, Physical link is Up/Down"
  // or "Administratively down"
  if (block.match(/Administratively down/i)) {
    iface.status = 'admin-down';
  } else if (block.match(/Physical link is Up/i)) {
    iface.status = 'up';
  } else if (block.match(/Physical link is Down/i)) {
    iface.status = 'down';
  }

  // Description: "Description: Uplink to core"
  const descMatch = block.match(/Description:\s*(.+?)$/im);
  if (descMatch) {
    iface.description = descMatch[1].trim();
  }

  // Speed: "Speed: 1000mbps" or "Link-level type: Ethernet, MTU: 1514, Speed: 10Gbps"
  const speedMatch = block.match(/Speed:\s*(\d+)\s*(\w+)/i);
  if (speedMatch) {
    const speed = parseInt(speedMatch[1], 10);
    const unit = speedMatch[2].toLowerCase();
    if (unit.includes('g')) {
      iface.speed = `${speed}G`;
    } else if (unit.includes('m')) {
      iface.speed = `${speed}M`;
    } else {
      iface.speed = `${speed}${unit}`;
    }
  }

  // Link mode: "Link-mode: Full-duplex"
  const duplexMatch = block.match(/Link-mode:\s*(\S+)/i);
  if (duplexMatch) {
    const duplex = duplexMatch[1].toLowerCase();
    if (duplex.includes('full')) {
      iface.duplex = 'full';
    } else if (duplex.includes('half')) {
      iface.duplex = 'half';
    } else {
      iface.duplex = duplex;
    }
  }

  // MTU: "MTU: 1514"
  const mtuMatch = block.match(/MTU:\s*(\d+)/i);
  if (mtuMatch) {
    iface.mtu = parseInt(mtuMatch[1], 10);
  }

  // MAC Address: "Current address: 00:00:00:00:00:01"
  const macMatch = block.match(/Current address:\s*([0-9a-f:]+)/i);
  if (macMatch) {
    iface.macAddress = macMatch[1];
  }

  // Input stats: "Input packets : 12345"
  const rxPktsMatch = block.match(/Input.*?packets\s*:\s*(\d+)/i);
  if (rxPktsMatch) {
    iface.rxPackets = parseInt(rxPktsMatch[1], 10);
  }

  // Input bytes: "Input bytes  : 67890"
  const rxBytesMatch = block.match(/Input.*?bytes\s*:\s*(\d+)/i);
  if (rxBytesMatch) {
    iface.rxBytes = parseInt(rxBytesMatch[1], 10);
  }

  // Output stats
  const txPktsMatch = block.match(/Output.*?packets\s*:\s*(\d+)/i);
  if (txPktsMatch) {
    iface.txPackets = parseInt(txPktsMatch[1], 10);
  }

  const txBytesMatch = block.match(/Output.*?bytes\s*:\s*(\d+)/i);
  if (txBytesMatch) {
    iface.txBytes = parseInt(txBytesMatch[1], 10);
  }

  // Errors
  const rxErrMatch = block.match(/Input errors:\s*(\d+)/i);
  if (rxErrMatch) {
    iface.rxErrors = parseInt(rxErrMatch[1], 10);
  }

  const txErrMatch = block.match(/Output errors:\s*(\d+)/i);
  if (txErrMatch) {
    iface.txErrors = parseInt(txErrMatch[1], 10);
  }

  return iface;
}

/**
 * Parse Arista EOS show interfaces output
 * Very similar to Cisco IOS format
 */
function parseAristaEos(output: string): InterfaceEnrichment[] {
  // Arista format is very similar to IOS, reuse the parser
  return parseCiscoIos(output);
}

/**
 * Parse Linux ip -s link output
 */
function parseLinux(output: string): InterfaceEnrichment[] {
  const interfaces: InterfaceEnrichment[] = [];

  // Split on interface numbers: "1: lo:" "2: eth0:"
  const blocks = output.split(/(?=^\d+:\s+\S+:)/im).filter(b => b.trim());

  for (const block of blocks) {
    const iface = parseLinuxInterfaceBlock(block);
    if (iface) {
      interfaces.push(iface);
    }
  }

  return interfaces;
}

/**
 * Parse a single Linux interface block from ip -s link
 */
function parseLinuxInterfaceBlock(block: string): InterfaceEnrichment | null {
  // Get interface name: "2: eth0: <BROADCAST,MULTICAST,UP>"
  const nameMatch = block.match(/^\d+:\s+(\S+?):/m);
  if (!nameMatch) return null;

  // Remove @ suffix if present (e.g., "eth0@if5")
  const name = nameMatch[1].split('@')[0];

  const iface: InterfaceEnrichment = {
    name,
    status: 'down',
  };

  // Status: Check flags <...UP...> or <...DOWN...>
  const flagsMatch = block.match(/<([^>]+)>/);
  if (flagsMatch) {
    const flags = flagsMatch[1].toUpperCase();
    if (flags.includes('UP')) {
      iface.status = 'up';
    } else if (flags.includes('DOWN') || flags.includes('NO-CARRIER')) {
      iface.status = 'down';
    }
  }

  // MTU: "mtu 1500"
  const mtuMatch = block.match(/mtu\s+(\d+)/i);
  if (mtuMatch) {
    iface.mtu = parseInt(mtuMatch[1], 10);
  }

  // MAC Address: "link/ether 00:00:00:00:00:01"
  const macMatch = block.match(/link\/ether\s+([0-9a-f:]+)/i);
  if (macMatch) {
    iface.macAddress = macMatch[1];
  }

  // RX stats: "RX: bytes  packets errors dropped..."
  // followed by: "12345   67890   0      0"
  // or newer format: "RX: bytes  packets errors dropped..."
  //                  "    12345  67890   0      0"
  const rxLine = block.match(/RX:.*?\n\s*(\d+)\s+(\d+)/i);
  if (rxLine) {
    iface.rxBytes = parseInt(rxLine[1], 10);
    iface.rxPackets = parseInt(rxLine[2], 10);
  }

  // Alternative RX format: "RX packets 12345 bytes 67890"
  const rxAltMatch = block.match(/RX.*?packets\s+(\d+).*?bytes\s+(\d+)/i);
  if (rxAltMatch && !iface.rxPackets) {
    iface.rxPackets = parseInt(rxAltMatch[1], 10);
    iface.rxBytes = parseInt(rxAltMatch[2], 10);
  }

  // TX stats
  const txLine = block.match(/TX:.*?\n\s*(\d+)\s+(\d+)/i);
  if (txLine) {
    iface.txBytes = parseInt(txLine[1], 10);
    iface.txPackets = parseInt(txLine[2], 10);
  }

  // Alternative TX format
  const txAltMatch = block.match(/TX.*?packets\s+(\d+).*?bytes\s+(\d+)/i);
  if (txAltMatch && !iface.txPackets) {
    iface.txPackets = parseInt(txAltMatch[1], 10);
    iface.txBytes = parseInt(txAltMatch[2], 10);
  }

  // RX errors: look for errors column
  const rxErrMatch = block.match(/RX:.*?\n\s*\d+\s+\d+\s+(\d+)/i);
  if (rxErrMatch) {
    iface.rxErrors = parseInt(rxErrMatch[1], 10);
  }

  // TX errors
  const txErrMatch = block.match(/TX:.*?\n\s*\d+\s+\d+\s+(\d+)/i);
  if (txErrMatch) {
    iface.txErrors = parseInt(txErrMatch[1], 10);
  }

  return iface;
}

/**
 * Parse interfaces output based on CLI flavor
 * @param output - Raw command output
 * @param flavor - CLI flavor identifier
 * @returns Array of InterfaceEnrichment objects
 */
export function parseInterfacesOutput(
  output: string,
  flavor: CliFlavor
): InterfaceEnrichment[] {
  if (!output || output.trim().length === 0) {
    return [];
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
      return [];
  }
}

/**
 * Find an interface by name in the enrichment array
 * Handles common name variations (Gi vs GigabitEthernet, etc.)
 */
export function findInterfaceByName(
  interfaces: InterfaceEnrichment[],
  name: string
): InterfaceEnrichment | undefined {
  if (!name || !interfaces.length) return undefined;

  // Direct match first
  const direct = interfaces.find(i => i.name.toLowerCase() === name.toLowerCase());
  if (direct) return direct;

  // Normalize name for comparison
  const normalized = normalizeInterfaceName(name).toLowerCase();

  return interfaces.find(i => normalizeInterfaceName(i.name).toLowerCase() === normalized);
}

/**
 * Normalize interface name to common format
 * Expands abbreviations: Gi -> GigabitEthernet, Fa -> FastEthernet, etc.
 */
export function normalizeInterfaceName(name: string): string {
  if (!name) return name;

  // Common abbreviation expansions
  const expansions: Record<string, string> = {
    gi: 'GigabitEthernet',
    gig: 'GigabitEthernet',
    fa: 'FastEthernet',
    fast: 'FastEthernet',
    te: 'TenGigabitEthernet',
    tengig: 'TenGigabitEthernet',
    eth: 'Ethernet',
    lo: 'Loopback',
    po: 'Port-channel',
    vl: 'Vlan',
    tu: 'Tunnel',
    ge: 'ge', // Juniper uses ge-x/x/x
    xe: 'xe', // Juniper 10G
    et: 'Ethernet', // Juniper/Arista
  };

  // Check if name starts with an abbreviation followed by number or slash
  const match = name.match(/^([a-zA-Z]+)([0-9/.-].*)$/);
  if (match) {
    const prefix = match[1].toLowerCase();
    const suffix = match[2];

    if (expansions[prefix]) {
      return expansions[prefix] + suffix;
    }
  }

  return name;
}

/**
 * Determine interface status from text
 */
export function determineInterfaceStatus(statusText: string): InterfaceStatus {
  if (!statusText) return 'down';

  const lower = statusText.toLowerCase();

  if (lower.includes('admin') && lower.includes('down')) {
    return 'admin-down';
  }
  if (lower.includes('up')) {
    return 'up';
  }
  return 'down';
}
