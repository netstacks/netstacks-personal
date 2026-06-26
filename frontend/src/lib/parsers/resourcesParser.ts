/**
 * Resources output parser for device enrichment
 * Parses CPU and memory utilization commands across vendors
 */

import type { CliFlavor, DeviceEnrichment } from '../../types/enrichment';

/**
 * Parse size string with unit to MB
 * Handles: KB, MB, GB, TB, K, M, G, T, bytes
 */
function parseSizeToMB(sizeStr: string, unit?: string): number {
  const size = parseFloat(sizeStr.replace(/,/g, ''));
  if (isNaN(size)) return 0;

  const unitLower = (unit || '').toLowerCase();

  if (unitLower.startsWith('t')) {
    return size * 1024 * 1024; // TB to MB
  }
  if (unitLower.startsWith('g')) {
    return size * 1024; // GB to MB
  }
  if (unitLower.startsWith('m')) {
    return size; // Already MB
  }
  if (unitLower.startsWith('k')) {
    return size / 1024; // KB to MB
  }
  // Assume bytes if no unit
  return size / (1024 * 1024);
}

/**
 * Parse Cisco IOS CPU and memory output
 * Commands: show processes cpu | include CPU, show processes memory | include Processor
 */
function parseCiscoIos(outputs: string[]): Partial<DeviceEnrichment> {
  const result: Partial<DeviceEnrichment> = {};

  for (const output of outputs) {
    // CPU: "CPU utilization for five seconds: 23%/0%"
    const cpuMatch = output.match(/CPU utilization.*?:\s*(\d+)%/i) ||
                     output.match(/five seconds:\s*(\d+)%/i);
    if (cpuMatch) {
      result.cpuPercent = parseInt(cpuMatch[1], 10);
    }

    // Memory: "Processor    123456789   12345678   111111111"
    // Format: Processor Total(bytes) Used(bytes) Free(bytes)
    const memMatch = output.match(/Processor\s+(\d+)\s+(\d+)\s+(\d+)/i);
    if (memMatch) {
      const totalBytes = parseInt(memMatch[1], 10);
      const usedBytes = parseInt(memMatch[2], 10);
      result.memoryTotalMB = Math.round(totalBytes / (1024 * 1024));
      result.memoryUsedMB = Math.round(usedBytes / (1024 * 1024));
      if (totalBytes > 0) {
        result.memoryPercent = Math.round((usedBytes / totalBytes) * 100);
      }
    }
  }

  return result;
}

/**
 * Parse Cisco NX-OS system resources output
 * Command: show system resources
 */
function parseCiscoNxos(outputs: string[]): Partial<DeviceEnrichment> {
  const result: Partial<DeviceEnrichment> = {};

  for (const output of outputs) {
    // CPU: "CPU states  :   5.0% user,   2.0% kernel,  93.0% idle"
    // CPU used = 100 - idle
    const cpuIdleMatch = output.match(/(\d+(?:\.\d+)?)\s*%\s*idle/i);
    if (cpuIdleMatch) {
      const idle = parseFloat(cpuIdleMatch[1]);
      result.cpuPercent = Math.round(100 - idle);
    }

    // Memory: "Memory usage:   16384084K total,   8192042K used,   8192042K free"
    const memMatch = output.match(/Memory.*?total:\s*([\d.]+)\s*(\w+).*?used:\s*([\d.]+)\s*(\w+)/i);
    if (memMatch) {
      result.memoryTotalMB = Math.round(parseSizeToMB(memMatch[1], memMatch[2]));
      result.memoryUsedMB = Math.round(parseSizeToMB(memMatch[3], memMatch[4]));
      if (result.memoryTotalMB && result.memoryTotalMB > 0) {
        result.memoryPercent = Math.round((result.memoryUsedMB / result.memoryTotalMB) * 100);
      }
    }

    // Alternative memory format: "16384084K total, 8192042K used"
    const memAltMatch = output.match(/([\d.]+)\s*(\w+)\s+total.*?([\d.]+)\s*(\w+)\s+used/i);
    if (memAltMatch && !result.memoryTotalMB) {
      result.memoryTotalMB = Math.round(parseSizeToMB(memAltMatch[1], memAltMatch[2]));
      result.memoryUsedMB = Math.round(parseSizeToMB(memAltMatch[3], memAltMatch[4]));
      if (result.memoryTotalMB && result.memoryTotalMB > 0) {
        result.memoryPercent = Math.round((result.memoryUsedMB / result.memoryTotalMB) * 100);
      }
    }
  }

  return result;
}

/**
 * Parse Juniper Junos chassis and uptime output
 * Commands: show system uptime, show chassis routing-engine
 */
function parseJuniperJunos(outputs: string[]): Partial<DeviceEnrichment> {
  const result: Partial<DeviceEnrichment> = {};

  for (const output of outputs) {
    // CPU: "Idle            45 percent" => used = 100 - idle
    const cpuIdleMatch = output.match(/Idle\s+(\d+)\s+percent/i);
    if (cpuIdleMatch) {
      const idle = parseInt(cpuIdleMatch[1], 10);
      result.cpuPercent = 100 - idle;
    }

    // Alternative CPU: "CPU utilization: 55 percent"
    const cpuUsedMatch = output.match(/CPU utilization:\s*(\d+)\s*percent/i);
    if (cpuUsedMatch) {
      result.cpuPercent = parseInt(cpuUsedMatch[1], 10);
    }

    // Memory: "Memory utilization: 60 percent"
    const memPercentMatch = output.match(/Memory utilization:\s*(\d+)\s*percent/i);
    if (memPercentMatch) {
      result.memoryPercent = parseInt(memPercentMatch[1], 10);
    }

    // Memory: "2048 MB total (1228 MB used, 820 MB available)"
    const memMatch = output.match(/(\d+)\s*MB.*?total.*?(\d+)\s*MB.*?used/i);
    if (memMatch) {
      result.memoryTotalMB = parseInt(memMatch[1], 10);
      result.memoryUsedMB = parseInt(memMatch[2], 10);
      if (result.memoryTotalMB > 0) {
        result.memoryPercent = Math.round((result.memoryUsedMB / result.memoryTotalMB) * 100);
      }
    }
  }

  return result;
}

/**
 * Parse Arista EOS processes top output
 * Command: show processes top once
 */
function parseAristaEos(outputs: string[]): Partial<DeviceEnrichment> {
  const result: Partial<DeviceEnrichment> = {};

  for (const output of outputs) {
    // CPU: "%Cpu(s):  5.0 us,  2.0 sy,  0.0 ni, 93.0 id"
    // CPU used = 100 - idle
    const cpuIdleMatch = output.match(/Cpu\(s\):.*?(\d+(?:\.\d+)?)\s*%?\s*id/i) ||
                         output.match(/(\d+(?:\.\d+)?)\s*%?\s*id(?:le)?/i);
    if (cpuIdleMatch) {
      const idle = parseFloat(cpuIdleMatch[1]);
      result.cpuPercent = Math.round(100 - idle);
    }

    // Memory: "Mem: 16384084K total, 8192042K used, 8192042K free"
    // or "KiB Mem : 16384084 total,  8192042 used"
    const memMatch = output.match(/Mem[:\s]+(\d+)\s*(\w*)\s*total.*?(\d+)\s*(\w*)\s*used/i);
    if (memMatch) {
      const totalUnit = memMatch[2] || 'K'; // Default to KB if no unit
      const usedUnit = memMatch[4] || 'K';
      result.memoryTotalMB = Math.round(parseSizeToMB(memMatch[1], totalUnit));
      result.memoryUsedMB = Math.round(parseSizeToMB(memMatch[3], usedUnit));
      if (result.memoryTotalMB && result.memoryTotalMB > 0) {
        result.memoryPercent = Math.round((result.memoryUsedMB / result.memoryTotalMB) * 100);
      }
    }
  }

  return result;
}

/**
 * Parse Linux uptime, free, and top output
 * Commands: uptime, free -h, top -bn1 | head -5
 */
function parseLinux(outputs: string[]): Partial<DeviceEnrichment> {
  const result: Partial<DeviceEnrichment> = {};

  for (const output of outputs) {
    // uptime: "14:32:01 up 45 days,  2:30,  2 users,  load average: 0.15, 0.20, 0.18"
    // We can derive load average but not direct CPU %
    const loadMatch = output.match(/load average:\s*([\d.]+)/i);
    if (loadMatch) {
      // Store load average as pseudo-CPU (not exact but useful)
      // Convert load to % assuming typical system
      const load = parseFloat(loadMatch[1]);
      // Rough estimate: load of 1.0 on single core = 100%
      // Most systems have multiple cores, so this is just indicative
      result.cpuPercent = Math.min(100, Math.round(load * 100));
    }

    // free -h: "Mem:          15Gi       8.0Gi       7.0Gi"
    // or "Mem:       16384084    8192042    8192042"
    const freeMatch = output.match(/Mem:\s+(\S+)\s+(\S+)\s+(\S+)/i);
    if (freeMatch) {
      // Parse with potential unit suffix
      const totalStr = freeMatch[1];
      const usedStr = freeMatch[2];

      // Extract number and unit
      const totalParts = totalStr.match(/([\d.]+)(\w*)/);
      const usedParts = usedStr.match(/([\d.]+)(\w*)/);

      if (totalParts && usedParts) {
        // For free -h, units are like "Gi", "Mi", "Ki"
        const totalUnit = totalParts[2].replace('i', '').toUpperCase();
        const usedUnit = usedParts[2].replace('i', '').toUpperCase();

        result.memoryTotalMB = Math.round(parseSizeToMB(totalParts[1], totalUnit || 'K'));
        result.memoryUsedMB = Math.round(parseSizeToMB(usedParts[1], usedUnit || 'K'));

        if (result.memoryTotalMB && result.memoryTotalMB > 0) {
          result.memoryPercent = Math.round((result.memoryUsedMB / result.memoryTotalMB) * 100);
        }
      }
    }

    // top: "%Cpu(s):  5.0 us,  2.0 sy,  0.0 ni, 93.0 id"
    const topCpuMatch = output.match(/Cpu.*?(\d+(?:\.\d+)?)\s*%?\s*id/i);
    if (topCpuMatch) {
      const idle = parseFloat(topCpuMatch[1]);
      result.cpuPercent = Math.round(100 - idle);
    }

    // top memory: "MiB Mem :  15953.5 total,   7976.8 used"
    const topMemMatch = output.match(/Mem\s*:\s*([\d.]+)\s*total.*?([\d.]+)\s*used/i);
    if (topMemMatch && !result.memoryTotalMB) {
      result.memoryTotalMB = Math.round(parseFloat(topMemMatch[1]));
      result.memoryUsedMB = Math.round(parseFloat(topMemMatch[2]));
      if (result.memoryTotalMB > 0) {
        result.memoryPercent = Math.round((result.memoryUsedMB / result.memoryTotalMB) * 100);
      }
    }
  }

  return result;
}

/**
 * Parse resources output based on CLI flavor
 * @param outputs - Array of raw command outputs (can be multiple commands)
 * @param flavor - CLI flavor identifier
 * @returns Partial DeviceEnrichment with CPU and memory data
 */
export function parseResourcesOutput(
  outputs: string[],
  flavor: CliFlavor
): Partial<DeviceEnrichment> {
  if (!outputs || outputs.length === 0) {
    return {};
  }

  // Filter out empty outputs
  const validOutputs = outputs.filter(o => o && o.trim().length > 0);
  if (validOutputs.length === 0) {
    return {};
  }

  switch (flavor) {
    case 'cisco-ios':
      return parseCiscoIos(validOutputs);
    case 'cisco-nxos':
      return parseCiscoNxos(validOutputs);
    case 'juniper':
      return parseJuniperJunos(validOutputs);
    case 'arista':
      return parseAristaEos(validOutputs);
    case 'linux':
      return parseLinux(validOutputs);
    default:
      return {};
  }
}
