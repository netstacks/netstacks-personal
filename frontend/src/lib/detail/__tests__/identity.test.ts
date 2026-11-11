/**
 * Tests for identityProvider
 */

import { describe, expect, it } from 'vitest';
import type { Device } from '../../../types/topology';
import type { DeviceDetailContext } from '../types';
import { identityProvider } from '../providers/identity';

describe('identityProvider', () => {
  it('shows CLI Flavor for managed device with non-auto cli_flavor', () => {
    const device = {
      id: 'dev1',
      primaryIp: '10.1.1.1',
      profileId: 'prof1',
    } as Device;

    const ctx: DeviceDetailContext = {
      profile: {
        id: 'prof1',
        name: 'XR Router',
        cli_flavor: 'cisco-ios-xr',
      } as any,
      isEnterprise: false,
      hasFeature: () => false,
    };

    const sections = identityProvider(device, ctx);
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe('identity');
    expect(sections[0].title).toBe('System Information');
    expect(sections[0].priority).toBe(10);
    expect(sections[0].compact).toBe(true);

    const fields = sections[0].fields;
    const cliFlavor = fields.find(f => f.key === 'cli-flavor');
    expect(cliFlavor).toBeDefined();
    expect(cliFlavor?.label).toBe('CLI Flavor');
    expect(cliFlavor?.value).toBe('Cisco IOS-XR');

    // No OS Version field for managed devices with CLI flavor
    const osVersion = fields.find(f => f.key === 'os-version');
    expect(osVersion).toBeUndefined();
  });

  it('parses Model from Juniper sysDescr in device.model (unmanaged)', () => {
    const device = {
      id: 'dev2',
      primaryIp: '10.2.2.2',
      model: 'Juniper Networks, Inc. mx480 internet router, kernel JUNOS 18.4R3, Build date: 2019-12-18 20:03:42 UTC',
    } as Device;

    const ctx: DeviceDetailContext = {
      isEnterprise: false,
      hasFeature: () => false,
    };

    const sections = identityProvider(device, ctx);
    expect(sections).toHaveLength(1);

    const fields = sections[0].fields;
    const model = fields.find(f => f.key === 'model');
    expect(model).toBeDefined();
    expect(model?.value).toBe('mx480'); // Parsed, not the full sysDescr

    const osVersion = fields.find(f => f.key === 'os-version');
    expect(osVersion).toBeDefined();
    expect(osVersion?.value).toContain('18.4R3');

    // Vendor should also be parsed
    const vendor = fields.find(f => f.key === 'vendor');
    expect(vendor).toBeDefined();
    expect(vendor?.value).toBe('Juniper');
  });

  it('keeps raw unparseable sysDescr as Model when nothing else available', () => {
    const device = {
      id: 'dev3',
      primaryIp: '10.3.3.3',
      model: 'Some Very Long Custom Device Description That Cannot Be Parsed By Our System But Must Be Preserved',
    } as Device;

    const ctx: DeviceDetailContext = {
      isEnterprise: false,
      hasFeature: () => false,
    };

    const sections = identityProvider(device, ctx);
    expect(sections).toHaveLength(1);

    const fields = sections[0].fields;
    const model = fields.find(f => f.key === 'model');
    expect(model).toBeDefined();
    // Should show the raw string, not drop it
    expect(model?.value).toBe('Some Very Long Custom Device Description That Cannot Be Parsed By Our System But Must Be Preserved');
  });

  it('omits CLI Flavor if profile.cli_flavor is auto', () => {
    const device = {
      id: 'dev4',
      primaryIp: '10.4.4.4',
      profileId: 'prof2',
      version: '15.2.1',
    } as Device;

    const ctx: DeviceDetailContext = {
      profile: {
        id: 'prof2',
        name: 'Auto Profile',
        cli_flavor: 'auto',
      } as any,
      isEnterprise: false,
      hasFeature: () => false,
    };

    const sections = identityProvider(device, ctx);
    const fields = sections[0].fields;
    const cliFlavor = fields.find(f => f.key === 'cli-flavor');
    expect(cliFlavor).toBeUndefined();

    // Should show OS Version instead
    const osVersion = fields.find(f => f.key === 'os-version');
    expect(osVersion).toBeDefined();
    expect(osVersion?.value).toBe('15.2.1');
  });

  it('uses enrichment data when available', () => {
    const device = {
      id: 'dev5',
      primaryIp: '10.5.5.5',
      vendor: 'Generic',
      model: 'OldModel',
    } as Device;

    const ctx: DeviceDetailContext = {
      enrichment: {
        vendor: 'Arista',
        model: 'DCS-7050',
        osVersion: '4.21.0F',
      } as any,
      isEnterprise: false,
      hasFeature: () => false,
    };

    const sections = identityProvider(device, ctx);
    const fields = sections[0].fields;

    const vendor = fields.find(f => f.key === 'vendor');
    expect(vendor?.value).toBe('Arista');

    const model = fields.find(f => f.key === 'model');
    expect(model?.value).toBe('DCS-7050');

    const osVersion = fields.find(f => f.key === 'os-version');
    expect(osVersion?.value).toBe('4.21.0F');
  });

  it('shows CLI Flavor from enrichment for unmanaged device', () => {
    const device = {
      id: 'dev6',
      primaryIp: '10.6.6.6',
    } as Device;

    const ctx: DeviceDetailContext = {
      enrichment: {
        cliFlavor: 'juniper',
      } as any,
      isEnterprise: false,
      hasFeature: () => false,
    };

    const sections = identityProvider(device, ctx);
    expect(sections).toHaveLength(1);
    const fields = sections[0].fields;

    const cliFlavor = fields.find(f => f.key === 'cli-flavor');
    expect(cliFlavor).toBeDefined();
    expect(cliFlavor?.value).toBe('Juniper');

    // No OS Version when CLI Flavor is shown
    const osVersion = fields.find(f => f.key === 'os-version');
    expect(osVersion).toBeUndefined();
  });
});
