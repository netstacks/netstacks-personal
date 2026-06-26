import { describe, it, expect } from 'vitest';
import { resolveSnmpHost } from '../sessionHostResolver';
import type { DeviceEnrichment } from '../../types/enrichment';
import type { Session } from '../../api/sessions';

const mkSession = (id: string, host: string): Session => ({
  id,
  name: `tab-${id}`,
  host,
  port: 22,
  username: 'u',
  protocol: 'ssh',
  profile_id: 'p',
} as unknown as Session);

const mkEnr = (sessionId: string, hostname: string): DeviceEnrichment => ({
  sessionId,
  collectedAt: new Date().toISOString(),
  hostname,
} as DeviceEnrichment);

describe('resolveSnmpHost', () => {
  it('falls back to currentHost when no session matches', () => {
    const enrichments = new Map<string, DeviceEnrichment>();
    const sessions = new Map<string, Session>();
    expect(resolveSnmpHost('P2-CHI', '10.255.0.11', enrichments, sessions)).toBe('10.255.0.11');
  });

  it('returns session host when device name matches a cached hostname', () => {
    const enrichments = new Map([['sess-1', mkEnr('sess-1', 'P2-CHI')]]);
    const sessions = new Map([['sess-1', mkSession('sess-1', '172.30.0.204')]]);
    // CDP gave us 10.255.0.11 but we know P2-CHI lives at 172.30.0.204.
    expect(resolveSnmpHost('P2-CHI', '10.255.0.11', enrichments, sessions)).toBe('172.30.0.204');
  });

  it('matches case-insensitively and trims whitespace', () => {
    const enrichments = new Map([['s', mkEnr('s', 'P2-CHI')]]);
    const sessions = new Map([['s', mkSession('s', '10.0.0.1')]]);
    expect(resolveSnmpHost('  p2-chi  ', undefined, enrichments, sessions)).toBe('10.0.0.1');
  });

  it('keeps currentHost when matched session has no host field', () => {
    const enrichments = new Map([['s', mkEnr('s', 'X')]]);
    const sessions = new Map<string, Session>([['s', { ...mkSession('s', ''), host: '' }]]);
    expect(resolveSnmpHost('X', '1.2.3.4', enrichments, sessions)).toBe('1.2.3.4');
  });

  it('returns undefined when both currentHost and any match are missing', () => {
    expect(resolveSnmpHost('Anything', '', new Map(), new Map())).toBeUndefined();
    expect(resolveSnmpHost(null, null, new Map(), new Map())).toBeUndefined();
  });
});
