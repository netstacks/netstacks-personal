/**
 * Traceroute provider — Path enrichment from device metadata
 */

import type { DeviceDetailProvider, DetailFieldTone } from '../types';

/**
 * Map classification to visual tone
 */
function classificationToTone(classification?: string): DetailFieldTone {
  switch (classification) {
    case 'managed':
      return 'good';
    case 'external':
      return 'default';
    case 'isp-transit':
      return 'warn';
    default:
      return 'muted';
  }
}

/**
 * Traceroute provider
 *
 * Shows path and enrichment metadata when device.metadata.hopNumber is present.
 * Mirrors the existing inline fields from DeviceDetailCard.tsx lines 417-495.
 */
export const tracerouteProvider: DeviceDetailProvider = (device, _ctx) => {
  if (!device.metadata?.hopNumber) {
    return [];
  }

  const meta = device.metadata;
  const fields = [];

  // Classification with tone mapping
  if (meta.classification) {
    fields.push({
      key: 'classification',
      label: 'Classification',
      value: meta.classification,
      kind: 'badge' as const,
      tone: classificationToTone(meta.classification),
    });
  }

  // ASN
  if (meta.asn) {
    const asnValue = meta.asnName
      ? `AS${meta.asn} - ${meta.asnName}`
      : `AS${meta.asn}`;
    fields.push({
      key: 'asn',
      label: 'ASN',
      value: asnValue,
    });
  }

  // Organization
  if (meta.whoisOrg) {
    fields.push({
      key: 'organization',
      label: 'Organization',
      value: meta.whoisOrg,
    });
  }

  // CIDR
  if (meta.whoisCidr) {
    fields.push({
      key: 'cidr',
      label: 'CIDR',
      value: meta.whoisCidr,
    });
  }

  // Country
  if (meta.whoisCountry) {
    fields.push({
      key: 'country',
      label: 'Country',
      value: meta.whoisCountry,
    });
  }

  // Interface
  if (meta.interfaceName) {
    const interfaceValue = meta.interfaceDescription
      ? `${meta.interfaceName} (${meta.interfaceDescription})`
      : meta.interfaceName;
    fields.push({
      key: 'interface',
      label: 'Interface',
      value: interfaceValue,
    });
  }

  // DNS
  if (meta.dnsHostnames) {
    fields.push({
      key: 'dns',
      label: 'DNS',
      value: meta.dnsHostnames,
    });
  }

  // NetBox link
  if (meta.netboxUrl) {
    fields.push({
      key: 'netbox',
      label: 'NetBox',
      value: 'Open in NetBox',
      kind: 'link' as const,
      href: meta.netboxUrl,
    });
  }

  // Enrichment sources
  if (meta.enrichmentSources) {
    fields.push({
      key: 'sources',
      label: 'Sources',
      value: meta.enrichmentSources,
      tone: 'muted' as const,
    });
  }

  return [{
    id: 'traceroute',
    title: 'Path / Enrichment',
    priority: 50,
    compact: true,
    fields,
  }];
};
