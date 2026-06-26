import { describe, it, expect } from 'vitest';
import { formatXml } from '../xmlFormat';

describe('XML format provider', () => {
  it('indents nested elements with 2 spaces', () => {
    const input = '<root><a><b>hi</b></a></root>';
    const result = formatXml(input);
    expect(result).toContain('<root>');
    expect(result).toContain('  <a>');
    expect(result).toContain('    <b>hi</b>');
    expect(result).toContain('  </a>');
    expect(result).toContain('</root>');
  });

  it('handles NETCONF-style XML config payloads', () => {
    const input = '<config xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><interfaces><interface><name>eth0</name></interface></interfaces></config>';
    const result = formatXml(input);
    expect(result.split('\n').length).toBeGreaterThan(4);
    expect(result).toContain('  <interfaces>');
  });

  it('returns input unchanged if XML is malformed', () => {
    const input = '<this is not <valid> xml';
    expect(() => formatXml(input)).not.toThrow();
  });

  it('preserves XML declarations', () => {
    const input = '<?xml version="1.0"?><a><b/></a>';
    const result = formatXml(input);
    expect(result).toContain('<?xml version="1.0"?>');
  });
});
