/**
 * Detection Types for Smart Detection Engine
 *
 * Type definitions for network identifier detection in terminal output.
 * Supports IPs, MACs, hostnames, interfaces, VLANs, CIDR notation, and ASNs.
 */

/**
 * Types of network identifiers that can be detected
 */
export type DetectionType =
  | 'ipv4'
  | 'ipv6'
  | 'mac'
  | 'interface'
  | 'vlan'
  | 'cidr'
  | 'asn'
  | 'hostname'
  | 'regex';

/**
 * IPv4-specific metadata
 */
export interface IPv4Metadata {
  type: 'ipv4';
  isPrivate: boolean;
  isMulticast: boolean;
  isLoopback: boolean;
}

/**
 * IPv6-specific metadata
 */
export interface IPv6Metadata {
  type: 'ipv6';
  isLinkLocal: boolean;
  isLoopback: boolean;
}

/**
 * MAC address format variants
 */
export type MACFormat = 'colon' | 'dash' | 'dot';

/**
 * MAC address-specific metadata
 */
export interface MACMetadata {
  type: 'mac';
  format: MACFormat;
  oui?: string;
}

/**
 * Network interface vendor detection
 */
export type InterfaceVendor = 'cisco' | 'juniper' | 'linux' | 'unknown';

/**
 * Interface-specific metadata
 */
export interface InterfaceMetadata {
  type: 'interface';
  vendor: InterfaceVendor;
  interfaceType: string; // e.g., 'gigabit', 'fastethernet', 'ethernet', 'loopback'
}

/**
 * VLAN-specific metadata
 */
export interface VLANMetadata {
  type: 'vlan';
  vlanId: number;
}

/**
 * CIDR notation-specific metadata
 */
export interface CIDRMetadata {
  type: 'cidr';
  networkAddress: string;
  prefixLength: number;
}

/**
 * ASN-specific metadata
 */
export interface ASNMetadata {
  type: 'asn';
  asnNumber: number;
}

/**
 * Custom regex detection metadata
 */
export interface RegexMetadata {
  type: 'regex';
  pattern: string;
}

/**
 * Union type for type-specific detection metadata
 */
export type DetectionMetadata =
  | IPv4Metadata
  | IPv6Metadata
  | MACMetadata
  | InterfaceMetadata
  | VLANMetadata
  | CIDRMetadata
  | ASNMetadata
  | RegexMetadata;

/**
 * A detected network identifier in the terminal buffer
 */
export interface Detection {
  /** Unique identifier for this detection */
  id: string;
  /** Type of network identifier detected */
  type: DetectionType;
  /** The raw matched text (e.g., "192.168.1.1") */
  value: string;
  /** Canonical/normalized form (e.g., lowercase MAC) */
  normalizedValue: string;
  /** Terminal buffer line number (0-indexed) */
  line: number;
  /** Start column position (0-indexed) */
  startColumn: number;
  /** End column position (exclusive) */
  endColumn: number;
  /** Type-specific metadata */
  metadata: DetectionMetadata;
}

/**
 * Helper to check if metadata is IPv4
 */
export function isIPv4Metadata(meta: DetectionMetadata): meta is IPv4Metadata {
  return meta.type === 'ipv4';
}

/**
 * Helper to check if metadata is IPv6
 */
export function isIPv6Metadata(meta: DetectionMetadata): meta is IPv6Metadata {
  return meta.type === 'ipv6';
}

/**
 * Helper to check if metadata is MAC
 */
export function isMACMetadata(meta: DetectionMetadata): meta is MACMetadata {
  return meta.type === 'mac';
}

/**
 * Helper to check if metadata is Interface
 */
export function isInterfaceMetadata(meta: DetectionMetadata): meta is InterfaceMetadata {
  return meta.type === 'interface';
}

/**
 * Helper to check if metadata is CIDR
 */
export function isCIDRMetadata(meta: DetectionMetadata): meta is CIDRMetadata {
  return meta.type === 'cidr';
}
