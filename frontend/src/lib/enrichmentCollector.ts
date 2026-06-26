import { getErrorMessage } from '../api/errors'
/**
 * Enrichment data collector
 * Runs enrichment commands on devices and parses the output
 */

import type { DeviceEnrichment, InterfaceEnrichment } from '../types/enrichment';
import { detectCliFlavor, type DeviceInfo } from './cliFlavorDetector';
import { getCommandsForFlavor } from './enrichmentCommands';
import { parseEnrichmentData } from './parsers/index';

/**
 * Result from enrichment collection
 */
export interface EnrichmentCollectorResult {
  /** Device enrichment data */
  device: DeviceEnrichment;
  /** Interface enrichment array */
  interfaces: InterfaceEnrichment[];
}

/**
 * Terminal reference interface for command execution
 */
export interface TerminalRef {
  sendCommand: (cmd: string, timeout?: number) => Promise<string>;
}

/**
 * Log entry for progress reporting
 */
export interface LogEntry {
  level: 'info' | 'success' | 'warning' | 'error';
  device?: string;
  message: string;
}

/** Default timeout for enrichment commands (ms) */
const DEFAULT_COMMAND_TIMEOUT = 8000;

/**
 * Collect enrichment data from a device
 *
 * @param terminalRef - Terminal reference with sendCommand capability
 * @param sessionId - Session ID for the device
 * @param deviceInfo - Device info from show version parsing
 * @param versionOutput - Raw show version output
 * @param addLog - Optional logging callback for progress reporting
 * @returns Enrichment data or null if collection fails entirely
 *
 * @example
 * ```typescript
 * const result = await collectEnrichmentData(
 *   terminalRef,
 *   'session-123',
 *   { vendor: 'Cisco', platform: 'ISR 4451' },
 *   'Cisco IOS XE Software...',
 *   (log) => logger.log(log.message)
 * );
 * ```
 */
export async function collectEnrichmentData(
  terminalRef: TerminalRef,
  sessionId: string,
  deviceInfo: DeviceInfo,
  versionOutput: string,
  addLog?: (entry: LogEntry) => void
): Promise<EnrichmentCollectorResult | null> {
  const log = (entry: LogEntry) => {
    if (addLog) {
      addLog(entry);
    }
  };

  try {
    // Step 1: Detect CLI flavor
    const cliFlavor = detectCliFlavor(deviceInfo, versionOutput);
    log({
      level: 'info',
      message: `Detected CLI flavor: ${cliFlavor}`,
    });

    // Step 2: Get command set for this flavor
    const commands = getCommandsForFlavor(cliFlavor);
    if (commands.length === 0) {
      log({
        level: 'warning',
        message: `No enrichment commands for flavor: ${cliFlavor}`,
      });
      return null;
    }

    log({
      level: 'info',
      message: `Collecting device details (${commands.length} commands)...`,
    });

    // Step 3: Run each command and collect outputs
    const outputs: Record<string, string> = {};
    let successCount = 0;

    // Include the version output we already have
    outputs['show version'] = versionOutput;

    for (const cmd of commands) {
      // Skip show version since we already have it
      if (cmd.toLowerCase() === 'show version' || cmd.toLowerCase() === 'uname -a') {
        continue;
      }

      try {
        log({
          level: 'info',
          message: `Running: ${cmd}`,
        });

        const output = await terminalRef.sendCommand(cmd, DEFAULT_COMMAND_TIMEOUT);

        // Check for command errors
        if (
          output.includes('Invalid input') ||
          output.includes('% Unknown command') ||
          output.includes('command not found') ||
          output.includes('syntax error')
        ) {
          log({
            level: 'warning',
            message: `Command not supported: ${cmd}`,
          });
          continue;
        }

        outputs[cmd] = output;
        successCount++;
      } catch (err) {
        const errMsg = getErrorMessage(err);
        log({
          level: 'warning',
          message: `Command failed (${cmd}): ${errMsg}`,
        });
        // Continue with other commands
      }
    }

    // Check if we got any data
    if (successCount === 0 && !versionOutput) {
      log({
        level: 'warning',
        message: 'No enrichment data collected',
      });
      return null;
    }

    // Step 4: Parse the collected output
    log({
      level: 'info',
      message: 'Parsing collected data...',
    });

    const parsed = parseEnrichmentData(outputs, cliFlavor);

    // Step 5: Build the final result with required fields
    const result: EnrichmentCollectorResult = {
      device: {
        sessionId,
        collectedAt: new Date().toISOString(),
        cliFlavor,
        ...parsed.device,
      },
      interfaces: parsed.interfaces,
    };

    log({
      level: 'success',
      message: `Collected: ${result.interfaces.length} interfaces, CPU ${result.device.cpuPercent ?? 'N/A'}%, Mem ${result.device.memoryPercent ?? 'N/A'}%`,
    });

    return result;
  } catch (err) {
    const errMsg = getErrorMessage(err);
    log({
      level: 'error',
      message: `Enrichment collection failed: ${errMsg}`,
    });
    return null;
  }
}

/**
 * Collect enrichment data with minimal logging (for background collection)
 *
 * @param terminalRef - Terminal reference with sendCommand capability
 * @param sessionId - Session ID for the device
 * @param deviceInfo - Device info from show version parsing
 * @param versionOutput - Raw show version output
 * @returns Enrichment data or null if collection fails
 */
export async function collectEnrichmentDataQuiet(
  terminalRef: TerminalRef,
  sessionId: string,
  deviceInfo: DeviceInfo,
  versionOutput: string
): Promise<EnrichmentCollectorResult | null> {
  return collectEnrichmentData(terminalRef, sessionId, deviceInfo, versionOutput);
}
