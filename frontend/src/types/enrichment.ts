/**
 * Enrichment data types for topology device and link enrichment
 * Used for parsing CLI output and displaying device/interface details
 */

/**
 * CLI flavor types for vendor-specific command sets and parsing
 */
export type CliFlavor =
  | 'auto'
  | 'linux'
  | 'cisco-ios'
  | 'cisco-ios-xr'
  | 'cisco-nxos'
  | 'juniper'
  | 'arista'
  | 'paloalto'
  | 'fortinet';

/**
 * Interface status types
 */
export type InterfaceStatus = 'up' | 'down' | 'admin-down';

/**
 * Device enrichment data collected from CLI output
 * All fields optional except sessionId and collectedAt
 */
export interface DeviceEnrichment {
  /** Associated session ID */
  sessionId: string;
  /** Timestamp when data was collected */
  collectedAt: string;
  /** Detected CLI flavor */
  cliFlavor?: CliFlavor;

  // Version info
  /** Device vendor (Cisco, Juniper, Arista, etc.) */
  vendor?: string;
  /** Hardware model */
  model?: string;
  /** OS/software version */
  osVersion?: string;
  /** Serial number */
  serialNumber?: string;
  /** Device hostname */
  hostname?: string;

  // Uptime
  /** Uptime in seconds */
  uptimeSeconds?: number;
  /** Formatted uptime string (e.g., "45 days, 12:30:45") */
  uptimeFormatted?: string;

  // Resources
  /** CPU utilization percentage (0-100) */
  cpuPercent?: number;
  /** Memory used in MB */
  memoryUsedMB?: number;
  /** Total memory in MB */
  memoryTotalMB?: number;
  /** Memory utilization percentage (0-100) */
  memoryPercent?: number;
  /** Temperature in Celsius */
  temperatureCelsius?: number;

  // Raw outputs for debugging
  /** Raw command outputs keyed by command */
  rawOutputs?: Record<string, string>;
}

/**
 * Interface enrichment data for a single interface
 */
export interface InterfaceEnrichment {
  /** Interface name (e.g., "GigabitEthernet0/1") */
  name: string;
  /** Interface description */
  description?: string;
  /** Operational status */
  status: InterfaceStatus;
  /** Interface speed (e.g., "1000 Mbps", "10G") */
  speed?: string;
  /** Duplex mode (e.g., "full", "half", "auto") */
  duplex?: string;
  /** MTU in bytes */
  mtu?: number;

  // Traffic statistics
  /** Received packets */
  rxPackets?: number;
  /** Transmitted packets */
  txPackets?: number;
  /** Received bytes */
  rxBytes?: number;
  /** Transmitted bytes */
  txBytes?: number;
  /** Receive errors */
  rxErrors?: number;
  /** Transmit errors */
  txErrors?: number;

  // Addressing
  /** IP address with prefix (e.g., "192.168.1.1/24") */
  ipAddress?: string;
  /** MAC address */
  macAddress?: string;
}

/**
 * Link enrichment data for a connection between devices
 */
export interface LinkEnrichment {
  /** Connection ID from topology */
  connectionId: string;
  /** Timestamp when data was collected */
  collectedAt: string;

  /** Source device interface data */
  sourceInterface: InterfaceEnrichment;
  /** Destination device interface data */
  destInterface: InterfaceEnrichment;
}

/**
 * Parsed enrichment result combining device and interface data
 */
export interface ParsedEnrichment {
  /** Device-level enrichment data */
  device: Partial<DeviceEnrichment>;
  /** Interface enrichment array */
  interfaces: InterfaceEnrichment[];
}
