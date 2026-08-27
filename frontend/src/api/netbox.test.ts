import { describe, it, expect } from 'vitest';
import { consoleFieldsFromAccess, type NetBoxConsoleAccess } from './netbox';
import { DEFAULT_CONSOLE_PROTOCOL_MAPPINGS } from './netboxSources';

const access = (over: Partial<NetBoxConsoleAccess> = {}): NetBoxConsoleAccess => ({
  device_id: 7,
  console_port_name: 'console',
  tcp_port: 3007,
  console_server: { id: 500, name: 'oob-den1', host: '10.9.0.5', manufacturer_slug: 'opengear' },
  skip: null,
  skip_reason: null,
  ...over,
});

const cfg = { consoleProfileId: 'p-oob', consoleProtocolMappings: DEFAULT_CONSOLE_PROTOCOL_MAPPINGS };

describe('consoleFieldsFromAccess', () => {
  const fields = (r: ReturnType<typeof consoleFieldsFromAccess>) => ('fields' in r ? r.fields : null);
  const skip = (r: ReturnType<typeof consoleFieldsFromAccess>) => ('skip' in r ? r.skip : null);

  it('maps a resolved path to session fields using the manufacturer rule', () => {
    expect(fields(consoleFieldsFromAccess(access(), cfg))).toEqual({
      console_host: '10.9.0.5',
      console_port: 3007,
      console_protocol: 'ssh',
      console_profile_id: 'p-oob',
    });
    const cisco = access({ console_server: { id: 1, name: 'ts', host: '10.0.0.250', manufacturer_slug: 'Cisco' } });
    expect(fields(consoleFieldsFromAccess(cisco, cfg))?.console_protocol).toBe('telnet');
  });

  it('falls back to the default protocol for unknown manufacturers', () => {
    const unknown = access({ console_server: { id: 1, name: 'ts', host: '10.0.0.9', manufacturer_slug: 'perle' } });
    const telnetDefault = { ...cfg, consoleProtocolMappings: { default: 'telnet' as const, by_manufacturer: {} } };
    expect(fields(consoleFieldsFromAccess(unknown, telnetDefault))?.console_protocol).toBe('telnet');
    // Telnet lines need no login; SSH consoles without a terminal-server profile are skipped.
    expect(fields(consoleFieldsFromAccess(unknown, { ...telnetDefault, consoleProfileId: null }))?.console_profile_id).toBeNull();
    expect(skip(consoleFieldsFromAccess(access(), { ...cfg, consoleProfileId: null }))).toBe('ssh_needs_profile');
  });

  it('propagates NetBox skip outcomes and incomplete paths', () => {
    expect(skip(consoleFieldsFromAccess(access({ skip: 'no_console_port', skip_reason: 'no console port in NetBox', tcp_port: null, console_server: null }), cfg))).toBe('no_console_port');
    expect(skip(consoleFieldsFromAccess(access({ skip: 'not_cabled', skip_reason: 'not cabled' }), cfg))).toBe('not_cabled');
    expect(skip(consoleFieldsFromAccess(access({ tcp_port: null }), cfg))).toBe('server_no_ip');
    expect(skip(consoleFieldsFromAccess(access({ console_server: { id: 1, name: 'ts', host: null, manufacturer_slug: null } }), cfg))).toBe('server_no_ip');
  });
});
