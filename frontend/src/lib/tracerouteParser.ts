/**
 * TracerouteParser - Parse traceroute/tracert/tracepath output
 * and generate topology data for visualization
 */

import type { TracerouteHop, TracerouteResult } from '../types/traceroute';
import type { Device, Connection, Topology } from '../types/topology';

/**
 * Generate a unique ID
 */
function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Regex patterns for different traceroute formats
 */
const PATTERNS = {
  // Linux/macOS traceroute header: "traceroute to example.com (93.184.216.34), 30 hops max"
  headerLinux: /^traceroute\s+to\s+(\S+)\s+\(?([\d.]+)\)?/i,

  // Windows tracert header: "Tracing route to example.com [93.184.216.34]"
  headerWindows: /^Tracing route to\s+(\S+)\s+\[?([\d.]+)\]?/i,

  // tracepath header: " 1?: [LOCALHOST]"
  headerTracepath: /^\s*1\?:\s*\[LOCALHOST\]/i,

  // Linux/macOS hop: " 1  192.168.1.1 (192.168.1.1)  1.234 ms  0.987 ms  1.123 ms"
  // Also handles: " 1  hostname (192.168.1.1)  1.234 ms  0.987 ms  1.123 ms"
  hopLinux: /^\s*(\d+)\s+(?:(\S+)\s+\(([\d.]+)\)|([\d.]+)|\*)\s*(.*)/,

  // Windows tracert hop: "  1    <1 ms    <1 ms    <1 ms  192.168.1.1"
  // Also handles: "  1     1 ms     2 ms     1 ms  192.168.1.1"
  hopWindows: /^\s*(\d+)\s+(?:(<?\d+)\s*ms\s+(<?\d+)\s*ms\s+(<?\d+)\s*ms|(\*)\s+(\*)\s+(\*))\s+([\d.]+|\S+)?/,

  // tracepath hop: " 1:  192.168.1.1  0.123ms pmtu 1500"
  hopTracepath: /^\s*(\d+):\s+(?:([\d.]+|\S+)|no reply)\s+(\d+\.?\d*)ms/,

  // Timeout line: " 2  * * *"
  timeout: /^\s*(\d+)\s+\*\s+\*\s+\*/,

  // RTT values: "1.234 ms" or "<1 ms"
  rtt: /(<?\d+\.?\d*)\s*ms/gi,

  // IP address
  ipv4: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/,

  // MTR report header: "HOST: myhost  Loss%  Snt  Last  Avg  Best  Wrst StDev"
  headerMtr: /^\s*HOST:\s+\S+\s+Loss%/i,

  // MTR partial header (needs hop line confirmation)
  headerMtrAlt: /^\s*HOST:\s+\S+/i,

  // MTR hop: " 1.|-- gateway  0.0%  10  0.5  0.6  0.4  1.2  0.2"
  hopMtr: /^\s*(\d+)\.\|--\s+(\S+)\s+([\d.]+)%?\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/,
};

/**
 * Detect the format of traceroute output
 */
function detectFormat(output: string): 'linux' | 'windows' | 'tracepath' | 'mtr' | 'unknown' {
  const lines = output.trim().split('\n');

  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const line = lines[i];
    if (PATTERNS.headerMtr.test(line)) return 'mtr';
    if (PATTERNS.headerMtrAlt.test(line)) {
      // Confirm with hop lines
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (PATTERNS.hopMtr.test(lines[j])) return 'mtr';
      }
    }
    if (PATTERNS.headerLinux.test(line)) return 'linux';
    if (PATTERNS.headerWindows.test(line)) return 'windows';
    if (PATTERNS.headerTracepath.test(line)) return 'tracepath';
    // Check hop format as fallback
    if (PATTERNS.hopMtr.test(line)) return 'mtr';
    if (PATTERNS.hopWindows.test(line)) return 'windows';
    if (PATTERNS.hopTracepath.test(line)) return 'tracepath';
    if (PATTERNS.hopLinux.test(line)) return 'linux';
  }

  return 'unknown';
}

/**
 * Parse RTT values from a string
 */
function parseRttValues(text: string): (number | null)[] {
  const rtts: (number | null)[] = [];
  const matches = text.matchAll(PATTERNS.rtt);

  for (const match of matches) {
    const value = match[1].replace('<', '');
    rtts.push(parseFloat(value));
  }

  // If no RTTs found but line has *, it's a timeout
  if (rtts.length === 0 && text.includes('*')) {
    return [null, null, null];
  }

  return rtts;
}

/**
 * Parse a single hop line (Linux/macOS format)
 */
function parseHopLinux(line: string): TracerouteHop | null {
  // Check for timeout first
  const timeoutMatch = line.match(PATTERNS.timeout);
  if (timeoutMatch) {
    return {
      hopNumber: parseInt(timeoutMatch[1], 10),
      ip: null,
      rttMs: [null, null, null],
      isTimeout: true,
    };
  }

  const match = line.match(PATTERNS.hopLinux);
  if (!match) return null;

  const hopNumber = parseInt(match[1], 10);
  const hostname = match[2] || undefined;
  const ip = match[3] || match[4] || null;
  const remainder = match[5] || '';

  // Check if this is a timeout hop
  if (!ip && line.includes('*')) {
    return {
      hopNumber,
      ip: null,
      rttMs: [null, null, null],
      isTimeout: true,
    };
  }

  const rttMs = parseRttValues(remainder);

  return {
    hopNumber,
    ip,
    hostname: hostname !== ip ? hostname : undefined,
    rttMs: rttMs.length > 0 ? rttMs : [null],
    isTimeout: rttMs.every(r => r === null),
  };
}

/**
 * Parse a single hop line (Windows format)
 */
function parseHopWindows(line: string): TracerouteHop | null {
  const match = line.match(PATTERNS.hopWindows);
  if (!match) return null;

  const hopNumber = parseInt(match[1], 10);

  // Check if all timeouts
  if (match[5] === '*' || (!match[2] && !match[3] && !match[4])) {
    return {
      hopNumber,
      ip: null,
      rttMs: [null, null, null],
      isTimeout: true,
    };
  }

  const ip = match[8] || null;
  const rttMs: (number | null)[] = [];

  for (let i = 2; i <= 4; i++) {
    if (match[i]) {
      const value = match[i].replace('<', '');
      rttMs.push(parseFloat(value));
    }
  }

  return {
    hopNumber,
    ip,
    rttMs: rttMs.length > 0 ? rttMs : [null],
    isTimeout: false,
  };
}

/**
 * Parse a single hop line (tracepath format)
 */
function parseHopTracepath(line: string): TracerouteHop | null {
  const match = line.match(PATTERNS.hopTracepath);
  if (!match) {
    // Check for "no reply" lines
    const noReplyMatch = line.match(/^\s*(\d+):\s+no reply/);
    if (noReplyMatch) {
      return {
        hopNumber: parseInt(noReplyMatch[1], 10),
        ip: null,
        rttMs: [null],
        isTimeout: true,
      };
    }
    return null;
  }

  const hopNumber = parseInt(match[1], 10);
  const ip = match[2];
  const rtt = parseFloat(match[3]);

  return {
    hopNumber,
    ip: PATTERNS.ipv4.test(ip) ? ip : null,
    hostname: !PATTERNS.ipv4.test(ip) ? ip : undefined,
    rttMs: [rtt],
    isTimeout: false,
  };
}

/**
 * Parse a single hop line (MTR report format)
 */
function parseHopMtr(line: string): TracerouteHop | null {
  const match = line.match(PATTERNS.hopMtr);
  if (!match) return null;

  const hopNumber = parseInt(match[1], 10);
  const host = match[2];
  const lossPercent = parseFloat(match[3]);
  const avg = parseFloat(match[6]);
  const best = parseFloat(match[7]);
  const wrst = parseFloat(match[8]);

  // ??? or 100% loss = timeout
  if (host === '???' || lossPercent >= 100) {
    return {
      hopNumber,
      ip: null,
      rttMs: [null],
      isTimeout: true,
      lossPercent,
    };
  }

  const isIp = PATTERNS.ipv4.test(host);

  return {
    hopNumber,
    ip: isIp ? host : null,
    hostname: !isIp ? host : undefined,
    rttMs: [avg],
    isTimeout: false,
    lossPercent,
    bestMs: best,
    wrstMs: wrst,
  };
}

/**
 * Parse destination from header
 */
function parseDestination(output: string): { destination: string; destinationIp?: string } {
  const lines = output.trim().split('\n');

  for (const line of lines.slice(0, 3)) {
    const linuxMatch = line.match(PATTERNS.headerLinux);
    if (linuxMatch) {
      return {
        destination: linuxMatch[1],
        destinationIp: linuxMatch[2],
      };
    }

    const windowsMatch = line.match(PATTERNS.headerWindows);
    if (windowsMatch) {
      return {
        destination: windowsMatch[1],
        destinationIp: windowsMatch[2],
      };
    }

    const mtrMatch = line.match(/^\s*HOST:\s+(\S+)/i);
    if (mtrMatch) {
      return { destination: mtrMatch[1] };
    }
  }

  return { destination: 'unknown' };
}

/**
 * TracerouteParser class
 */
export class TracerouteParser {
  /**
   * Parse traceroute/tracert/tracepath output from terminal
   * Supports: Linux traceroute, Windows tracert, macOS traceroute, tracepath
   */
  static parse(output: string): TracerouteResult | null {
    if (!output || output.trim().length === 0) {
      return null;
    }

    const format = detectFormat(output);
    const lines = output.trim().split('\n');
    const hops: TracerouteHop[] = [];
    let { destination, destinationIp } = parseDestination(output);

    for (const line of lines) {
      let hop: TracerouteHop | null = null;

      switch (format) {
        case 'windows':
          hop = parseHopWindows(line);
          break;
        case 'tracepath':
          hop = parseHopTracepath(line);
          break;
        case 'mtr':
          hop = parseHopMtr(line);
          break;
        case 'linux':
        default:
          hop = parseHopLinux(line);
          break;
      }

      if (hop) {
        hops.push(hop);
      }
    }

    if (hops.length === 0) {
      return null;
    }

    // Sort by hop number
    hops.sort((a, b) => a.hopNumber - b.hopNumber);

    // For MTR, infer destination IP from last non-timeout hop
    if (format === 'mtr' && !destinationIp) {
      for (let i = hops.length - 1; i >= 0; i--) {
        if (!hops[i].isTimeout && hops[i].ip) {
          destinationIp = hops[i].ip!;
          break;
        }
      }
    }

    // Determine if traceroute completed (last hop has IP matching destination)
    const lastHop = hops[hops.length - 1];
    const complete = lastHop && !lastHop.isTimeout && lastHop.ip === destinationIp;

    return {
      id: generateId(),
      destination,
      destinationIp,
      timestamp: new Date().toISOString(),
      hops,
      complete,
    };
  }

  /**
   * Check if text looks like traceroute output
   */
  static isTracerouteOutput(text: string): boolean {
    if (!text || text.trim().length < 20) return false;

    const lines = text.trim().split('\n');
    if (lines.length < 2) return false;

    // Check for header patterns
    if (PATTERNS.headerLinux.test(text) || PATTERNS.headerWindows.test(text) ||
        PATTERNS.headerMtr.test(text) || PATTERNS.headerMtrAlt.test(text)) {
      return true;
    }

    // Check if multiple lines look like hops
    let hopCount = 0;
    for (const line of lines) {
      if (PATTERNS.hopLinux.test(line) ||
          PATTERNS.hopWindows.test(line) ||
          PATTERNS.hopTracepath.test(line) ||
          PATTERNS.hopMtr.test(line) ||
          PATTERNS.timeout.test(line)) {
        hopCount++;
      }
    }

    return hopCount >= 2;
  }

  /**
   * Generate a new topology from traceroute result
   * Creates devices for each hop and connections between them
   */
  static generateTopology(traceroute: TracerouteResult, name?: string): Topology {
    const devices: Device[] = [];
    const connections: Connection[] = [];

    // Layout settings for path visualization
    const startX = 100;
    const startY = 500;
    const spacingX = 120;

    let prevDeviceId: string | null = null;

    for (let i = 0; i < traceroute.hops.length; i++) {
      const hop = traceroute.hops[i];

      // Create device for this hop
      const deviceId = generateId();
      const deviceName = hop.hostname || hop.ip || `Hop ${hop.hopNumber}`;

      // Position horizontally in a path
      const x = startX + (i * spacingX);
      const y = startY;

      const device: Device = {
        id: deviceId,
        name: hop.isTimeout ? `* (Hop ${hop.hopNumber})` : deviceName,
        type: i === 0 ? 'router' : i === traceroute.hops.length - 1 ? 'server' : 'router',
        status: hop.isTimeout ? 'unknown' : 'online',
        x,
        y,
        primaryIp: hop.ip || undefined,
        metadata: {
          hopNumber: String(hop.hopNumber),
          rtt: hop.rttMs[0] !== null ? `${hop.rttMs[0].toFixed(1)}ms` : 'timeout',
          ...(hop.lossPercent !== undefined && { lossPercent: String(hop.lossPercent) }),
          ...(hop.bestMs !== undefined && { bestMs: `${hop.bestMs.toFixed(1)}ms` }),
          ...(hop.wrstMs !== undefined && { wrstMs: `${hop.wrstMs.toFixed(1)}ms` }),
        },
      };

      devices.push(device);

      // Create connection from previous hop
      if (prevDeviceId) {
        const hasLoss = hop.lossPercent !== undefined && hop.lossPercent > 0;
        let label = hop.rttMs[0] !== null ? `${hop.rttMs[0].toFixed(1)}ms` : undefined;
        if (label && hasLoss) {
          label += ` (${hop.lossPercent}% loss)`;
        }

        const connection: Connection = {
          id: generateId(),
          sourceDeviceId: prevDeviceId,
          targetDeviceId: deviceId,
          status: hop.isTimeout || hasLoss ? 'degraded' : 'active',
          label,
        };
        connections.push(connection);
      }

      prevDeviceId = deviceId;
    }

    const topologyName = name || `Traceroute to ${traceroute.destination}`;

    return {
      id: generateId(),
      name: topologyName,
      devices,
      connections,
      source: 'manual',
      createdAt: traceroute.timestamp,
      updatedAt: traceroute.timestamp,
    };
  }

  /**
   * Match traceroute hops to existing topology devices by IP
   * Returns device IDs for each hop (null if no match)
   */
  static matchToDevices(
    traceroute: TracerouteResult,
    devices: Device[]
  ): (string | null)[] {
    return traceroute.hops.map(hop => {
      if (!hop.ip) return null;
      const device = devices.find(d => d.primaryIp === hop.ip);
      return device?.id ?? null;
    });
  }

  /**
   * Find connections that form the path between matched devices
   */
  static findPathConnections(
    matchedDeviceIds: (string | null)[],
    connections: Connection[]
  ): string[] {
    const connectionIds: string[] = [];
    const validIds = matchedDeviceIds.filter(Boolean) as string[];

    for (let i = 0; i < validIds.length - 1; i++) {
      const conn = connections.find(c =>
        (c.sourceDeviceId === validIds[i] && c.targetDeviceId === validIds[i + 1]) ||
        (c.sourceDeviceId === validIds[i + 1] && c.targetDeviceId === validIds[i])
      );
      if (conn) connectionIds.push(conn.id);
    }

    return connectionIds;
  }
}
