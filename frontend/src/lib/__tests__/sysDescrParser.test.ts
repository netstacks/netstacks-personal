import { describe, it, expect } from 'vitest';
import { parseSysDescr } from '../sysDescrParser';

describe('parseSysDescr', () => {
  it('returns empty object for null/undefined/empty input', () => {
    expect(parseSysDescr(undefined)).toEqual({});
    expect(parseSysDescr(null)).toEqual({});
    expect(parseSysDescr('')).toEqual({});
  });

  it('extracts Cisco IOS classic vendor/model/version', () => {
    // The exact string from the user's screenshot — Cisco Catalyst 3750E.
    const descr =
      'Cisco IOS Software, C3750E Software (C3750E-UNIVERSALK9-M), Version 15.2(4)E10, RELEASE SOFTWARE (fc2)\nTechnical Support: http://www.cisco.com/techsupport';
    const out = parseSysDescr(descr);
    expect(out.vendor).toBe('Cisco');
    expect(out.model).toBe('C3750E');
    expect(out.osVersion).toBe('15.2(4)E10');
  });

  it('extracts Cisco IOS-XE variant', () => {
    const descr =
      'Cisco IOS XE Software, ASR1001 Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 16.9.4, RELEASE SOFTWARE';
    const out = parseSysDescr(descr);
    expect(out.vendor).toBe('Cisco');
    expect(out.model).toBe('ASR1001');
    expect(out.osVersion).toBe('16.9.4');
  });

  it('extracts Cisco IOS-XR vendor and version', () => {
    const descr = 'Cisco IOS XR Software, Version 6.6.3.34I[Default]';
    const out = parseSysDescr(descr);
    expect(out.vendor).toBe('Cisco');
    expect(out.osVersion).toBe('6.6.3.34I');
  });

  it('extracts Juniper vendor/model/version', () => {
    const descr =
      'Juniper Networks, Inc. mx240 internet router, kernel JUNOS 18.4R3, Build date: 2019-01-01';
    const out = parseSysDescr(descr);
    expect(out.vendor).toBe('Juniper');
    expect(out.model).toBe('mx240');
    expect(out.osVersion).toBe('18.4R3');
  });

  it('extracts Arista vendor/model/version', () => {
    const descr =
      'Arista Networks EOS version 4.21.0F running on an Arista Networks DCS-7050QX-32';
    const out = parseSysDescr(descr);
    expect(out.vendor).toBe('Arista');
    expect(out.model).toBe('DCS-7050QX-32');
    expect(out.osVersion).toBe('4.21.0F');
  });

  it('extracts Linux vendor/version', () => {
    const descr =
      'Linux mybox 5.15.0-91-generic #101-Ubuntu SMP Tue Nov 14 13:30:08 UTC 2023 x86_64';
    const out = parseSysDescr(descr);
    expect(out.vendor).toBe('Linux');
    expect(out.osVersion).toBe('5.15.0-91-generic');
  });

  it('falls back to generic vendor + version detection for unknown formats', () => {
    const descr = 'Some Random Box from MikroTik, ver. 7.10.2 (stable)';
    const out = parseSysDescr(descr);
    expect(out.vendor).toBe('MikroTik');
    expect(out.osVersion).toBe('7.10.2');
  });

  it('returns empty object when neither vendor nor version is recognizable', () => {
    expect(parseSysDescr('this string has nothing useful')).toEqual({});
  });
});
