import type { CliFlavor } from '../types/enrichment'

/**
 * Vendor/platform labels derived from a session's CLI flavor. Used to enrich the
 * AI context for suggestion/autofill features so the model knows what kind of
 * device it's advising on. 'auto' has no entry; 'linux' carries no vendor.
 */
export const CLI_FLAVOR_META: Partial<Record<CliFlavor, { vendor?: string; platform: string }>> = {
  'cisco-ios': { vendor: 'Cisco', platform: 'IOS/IOS-XE' },
  'cisco-ios-xr': { vendor: 'Cisco', platform: 'IOS-XR' },
  'cisco-nxos': { vendor: 'Cisco', platform: 'NX-OS' },
  juniper: { vendor: 'Juniper', platform: 'Junos' },
  arista: { vendor: 'Arista', platform: 'EOS' },
  paloalto: { vendor: 'Palo Alto', platform: 'PAN-OS' },
  fortinet: { vendor: 'Fortinet', platform: 'FortiOS' },
  linux: { platform: 'Linux' },
}
