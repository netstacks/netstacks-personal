/**
 * Detail section types for extensible device/link detail providers
 */

import type { Device } from '../../types/topology';
import type { DeviceEnrichment } from '../../types/enrichment';
import type { DeviceLiveStats } from '../../hooks/useTopologyLive';
import type { CredentialProfile } from '../../api/profiles';

/**
 * Visual tone for detail field display
 */
export type DetailFieldTone = 'default' | 'good' | 'warn' | 'bad' | 'muted';

/**
 * Rendering kind for detail field
 */
export type DetailFieldKind = 'text' | 'badge' | 'link';

/**
 * A single detail field in a section
 */
export interface DetailField {
  /** Stable, unique key within a section */
  key: string;
  /** Display label */
  label: string;
  /** Display value (already formatted) */
  value: string;
  /** Rendering kind (default: 'text') */
  kind?: DetailFieldKind;
  /** Link href (for kind 'link') */
  href?: string;
  /** Visual tone (drives badge/text color) */
  tone?: DetailFieldTone;
}

/**
 * A section of detail fields
 * Sections with the same id from multiple providers are merged
 */
export interface DetailSection {
  /** Stable section identifier (same id from two providers merges) */
  id: string;
  /** Section title */
  title: string;
  /** Rendering priority (ascending; lower renders first) */
  priority: number;
  /** Include in compact card (not just tab) */
  compact?: boolean;
  /** Fields in this section */
  fields: DetailField[];
}

/**
 * Context provided to device detail providers
 * Extended (never rewritten) as sources grow
 */
export interface DeviceDetailContext {
  /** Device enrichment data */
  enrichment?: DeviceEnrichment;
  /** Live SNMP stats */
  liveStats?: DeviceLiveStats;
  /** Resolved credential profile */
  profile?: CredentialProfile | null;
  /** Connection status (matched against active sessions) */
  connected?: boolean;
  /** Enterprise mode flag */
  isEnterprise: boolean;
  /** Feature flag checker */
  hasFeature: (name: string) => boolean;
}

/**
 * Device detail provider function
 * Returns zero or more sections for a device
 */
export type DeviceDetailProvider =
  (device: Device, ctx: DeviceDetailContext) => DetailSection[];
