/**
 * Tests for base detail providers
 */

import { describe, it, expect } from 'vitest';
import type { Device } from '../../../types/topology';
import type { DeviceDetailContext } from '../types';
import { connectivityProvider } from '../providers/connectivity';
import { liveProvider } from '../providers/live';
import { enrichmentProvider } from '../providers/enrichment';
import { tracerouteProvider } from '../providers/traceroute';

const minimalDevice = {
  id: 'test-1',
  name: 'test-device',
  primaryIp: '10.0.0.1',
} as Device;

const minimalContext: DeviceDetailContext = {
  isEnterprise: false,
  hasFeature: () => false,
};

describe('connectivityProvider', () => {
  it('shows Management IP for unmanaged device with primaryIp, no Connection status', () => {
    const device = { ...minimalDevice, primaryIp: '10.0.0.1' };
    const ctx = { ...minimalContext };
    const sections = connectivityProvider(device, ctx);
    expect(sections).toHaveLength(1);
    const ipField = sections[0].fields.find(f => f.key === 'management-ip');
    expect(ipField?.value).toBe('10.0.0.1');
    const statusField = sections[0].fields.find(f => f.key === 'status');
    expect(statusField).toBeUndefined();
  });

  it('shows Management IP and Connected status for managed device with connected=true', () => {
    const device = { ...minimalDevice, profileId: 'prof-1', primaryIp: '192.168.1.1' };
    const ctx = { ...minimalContext, connected: true };
    const sections = connectivityProvider(device, ctx);
    expect(sections).toHaveLength(1);
    const ipField = sections[0].fields.find(f => f.key === 'management-ip');
    expect(ipField?.value).toBe('192.168.1.1');
    const statusField = sections[0].fields.find(f => f.key === 'status');
    expect(statusField).toEqual({
      key: 'status',
      label: 'Connection',
      value: 'Connected',
      tone: 'good',
    });
  });

  it('omits entire section when device has no primaryIp and is unmanaged', () => {
    const device = { id: 'test-1', name: 'no-ip-device' } as Device;
    const ctx = { ...minimalContext };
    const sections = connectivityProvider(device, ctx);
    expect(sections).toHaveLength(0);
  });

  it('omits status field when connected is undefined for managed device', () => {
    const device = { ...minimalDevice, profileId: 'prof-1' };
    const ctx = { ...minimalContext, connected: undefined };
    const sections = connectivityProvider(device, ctx);
    expect(sections).toHaveLength(1);
    const statusField = sections[0].fields.find(f => f.key === 'status');
    expect(statusField).toBeUndefined();
  });

  it('shows Not connected with muted tone when connected=false', () => {
    const device = { ...minimalDevice, profileId: 'prof-1' };
    const ctx = { ...minimalContext, connected: false };
    const sections = connectivityProvider(device, ctx);
    const statusField = sections[0].fields.find(f => f.key === 'status');
    expect(statusField).toEqual({
      key: 'status',
      label: 'Connection',
      value: 'Not connected',
      tone: 'muted',
    });
  });
});

describe('liveProvider', () => {
  it('formats uptime from enrichment.uptimeSeconds and marks compact', () => {
    const device = { ...minimalDevice };
    const ctx: DeviceDetailContext = {
      ...minimalContext,
      enrichment: { uptimeSeconds: 392445 },
    };
    const sections = liveProvider(device, ctx);
    expect(sections).toHaveLength(1);
    expect(sections[0].compact).toBe(true);
    const uptimeField = sections[0].fields.find(f => f.key === 'uptime');
    expect(uptimeField?.value).toBe('4d 13h 0m');
  });

  it('formats uptime from enrichment.uptimeFormatted and marks compact', () => {
    const device = { ...minimalDevice };
    const ctx: DeviceDetailContext = {
      ...minimalContext,
      enrichment: { uptimeFormatted: '2d 4h 30m' },
    };
    const sections = liveProvider(device, ctx);
    expect(sections).toHaveLength(1);
    expect(sections[0].compact).toBe(true);
    const uptimeField = sections[0].fields.find(f => f.key === 'uptime');
    expect(uptimeField?.value).toBe('2d 4h 30m');
  });

  it('formats uptime from liveStats.sysUptimeSeconds and marks compact', () => {
    const device = { ...minimalDevice };
    const ctx: DeviceDetailContext = {
      ...minimalContext,
      liveStats: { sysUptimeSeconds: 7200 },
    };
    const sections = liveProvider(device, ctx);
    expect(sections).toHaveLength(1);
    expect(sections[0].compact).toBe(true);
    const uptimeField = sections[0].fields.find(f => f.key === 'uptime');
    expect(uptimeField?.value).toBe('2h 0m');
  });

  it('uses device.uptime as fallback and marks compact', () => {
    const device = { ...minimalDevice, uptime: '1d 12h' };
    const ctx = { ...minimalContext };
    const sections = liveProvider(device, ctx);
    expect(sections).toHaveLength(1);
    expect(sections[0].compact).toBe(true);
    const uptimeField = sections[0].fields.find(f => f.key === 'uptime');
    expect(uptimeField?.value).toBe('1d 12h');
  });

  it('returns empty section array when no uptime available', () => {
    const device = { ...minimalDevice };
    const ctx = { ...minimalContext };
    const sections = liveProvider(device, ctx);
    expect(sections).toHaveLength(0);
  });
});

describe('enrichmentProvider', () => {
  it('hides serial when absent', () => {
    const device = { ...minimalDevice };
    const ctx = { ...minimalContext, enrichment: {} };
    const sections = enrichmentProvider(device, ctx);
    if (sections.length > 0) {
      const serialField = sections[0].fields.find(f => f.key === 'serial');
      expect(serialField).toBeUndefined();
    }
  });

  it('shows serial from enrichment.serialNumber and marks compact', () => {
    const device = { ...minimalDevice };
    const ctx: DeviceDetailContext = {
      ...minimalContext,
      enrichment: { serialNumber: 'SN12345' },
    };
    const sections = enrichmentProvider(device, ctx);
    expect(sections[0].compact).toBe(true);
    const serialField = sections[0].fields.find(f => f.key === 'serial');
    expect(serialField?.value).toBe('SN12345');
  });

  it('shows serial from device.serial when enrichment absent', () => {
    const device = { ...minimalDevice, serial: 'SN99999' };
    const ctx = { ...minimalContext };
    const sections = enrichmentProvider(device, ctx);
    const serialField = sections[0].fields.find(f => f.key === 'serial');
    expect(serialField?.value).toBe('SN99999');
  });

  it('shows hostname when present', () => {
    const device = { ...minimalDevice };
    const ctx: DeviceDetailContext = {
      ...minimalContext,
      enrichment: { hostname: 'router-core-1' },
    };
    const sections = enrichmentProvider(device, ctx);
    const hostnameField = sections[0].fields.find(f => f.key === 'hostname');
    expect(hostnameField?.value).toBe('router-core-1');
  });
});

describe('tracerouteProvider', () => {
  it('omits section when hopNumber absent', () => {
    const device = { ...minimalDevice };
    const ctx = { ...minimalContext };
    const sections = tracerouteProvider(device, ctx);
    expect(sections).toHaveLength(0);
  });

  it('includes section when hopNumber present', () => {
    const device = { ...minimalDevice, metadata: { hopNumber: 3 } };
    const ctx = { ...minimalContext };
    const sections = tracerouteProvider(device, ctx);
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe('traceroute');
    expect(sections[0].compact).toBe(true);
  });

  it('maps classification to correct tone', () => {
    const testCases = [
      { classification: 'managed', tone: 'good' },
      { classification: 'external', tone: 'default' },
      { classification: 'isp-transit', tone: 'warn' },
      { classification: 'unknown', tone: 'muted' },
    ];

    for (const { classification, tone } of testCases) {
      const device = {
        ...minimalDevice,
        metadata: { hopNumber: 1, classification },
      };
      const ctx = { ...minimalContext };
      const sections = tracerouteProvider(device, ctx);
      const classField = sections[0].fields.find(f => f.key === 'classification');
      expect(classField?.tone).toBe(tone);
    }
  });

  it('formats ASN with name when present', () => {
    const device = {
      ...minimalDevice,
      metadata: { hopNumber: 1, asn: 64512, asnName: 'Example AS' },
    };
    const ctx = { ...minimalContext };
    const sections = tracerouteProvider(device, ctx);
    const asnField = sections[0].fields.find(f => f.key === 'asn');
    expect(asnField?.value).toBe('AS64512 - Example AS');
  });

  it('formats ASN without name', () => {
    const device = {
      ...minimalDevice,
      metadata: { hopNumber: 1, asn: 64512 },
    };
    const ctx = { ...minimalContext };
    const sections = tracerouteProvider(device, ctx);
    const asnField = sections[0].fields.find(f => f.key === 'asn');
    expect(asnField?.value).toBe('AS64512');
  });

  it('includes NetBox link when netboxUrl present', () => {
    const device = {
      ...minimalDevice,
      metadata: { hopNumber: 1, netboxUrl: 'https://netbox.example.com/device/123' },
      netboxId: 123,
    };
    const ctx = { ...minimalContext };
    const sections = tracerouteProvider(device, ctx);
    const netboxField = sections[0].fields.find(f => f.key === 'netbox');
    expect(netboxField?.kind).toBe('link');
    expect(netboxField?.href).toBe('https://netbox.example.com/device/123');
    expect(netboxField?.value).toBe('Open in NetBox');
  });

  it('includes all WHOIS fields when present', () => {
    const device = {
      ...minimalDevice,
      metadata: {
        hopNumber: 1,
        whoisOrg: 'Example Org',
        whoisCidr: '10.0.0.0/8',
        whoisCountry: 'US',
      },
    };
    const ctx = { ...minimalContext };
    const sections = tracerouteProvider(device, ctx);
    const orgField = sections[0].fields.find(f => f.key === 'organization');
    const cidrField = sections[0].fields.find(f => f.key === 'cidr');
    const countryField = sections[0].fields.find(f => f.key === 'country');
    expect(orgField?.value).toBe('Example Org');
    expect(cidrField?.value).toBe('10.0.0.0/8');
    expect(countryField?.value).toBe('US');
  });

  it('includes interface with description', () => {
    const device = {
      ...minimalDevice,
      metadata: {
        hopNumber: 1,
        interfaceName: 'GigabitEthernet0/0/0',
        interfaceDescription: 'Uplink to Core',
      },
    };
    const ctx = { ...minimalContext };
    const sections = tracerouteProvider(device, ctx);
    const intField = sections[0].fields.find(f => f.key === 'interface');
    expect(intField?.value).toBe('GigabitEthernet0/0/0 (Uplink to Core)');
  });

  it('includes DNS hostnames', () => {
    const device = {
      ...minimalDevice,
      metadata: {
        hopNumber: 1,
        dnsHostnames: 'router1.example.com, router1.internal',
      },
    };
    const ctx = { ...minimalContext };
    const sections = tracerouteProvider(device, ctx);
    const dnsField = sections[0].fields.find(f => f.key === 'dns');
    expect(dnsField?.value).toBe('router1.example.com, router1.internal');
  });

  it('includes enrichment sources', () => {
    const device = {
      ...minimalDevice,
      metadata: {
        hopNumber: 1,
        enrichmentSources: 'NetBox, WHOIS',
      },
    };
    const ctx = { ...minimalContext };
    const sections = tracerouteProvider(device, ctx);
    const sourcesField = sections[0].fields.find(f => f.key === 'sources');
    expect(sourcesField?.value).toBe('NetBox, WHOIS');
  });
});
