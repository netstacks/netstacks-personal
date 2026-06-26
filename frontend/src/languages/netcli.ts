import type { languages } from 'monaco-editor';

/**
 * `netcli` — a single Monarch grammar for network device CLI configs,
 * covering both Cisco-style (IOS/IOS-XE/IOS-XR/NX-OS: `!` comments,
 * indentation-scoped stanzas) and Junos-style (`{ }` braces, `set`/`delete`
 * statements, `#` comments, `[ ... ]` value lists).
 *
 * This is deliberately vendor-agnostic: rather than two grammars + a
 * detector, one tokenizer highlights the lexical features common to both
 * families (comments, stanza keywords, IP/number literals, strings,
 * brackets). It's a readability aid for CLI backups, not a parser.
 */

// Stanza / statement keywords seen across Cisco + Junos configs. Highlighted
// when they lead a line (the typical place a config keyword appears).
const KEYWORDS = [
  // Junos operative verbs
  'set', 'delete', 'deactivate', 'activate', 'rename', 'insert', 'replace',
  // Cisco operative verbs
  'no', 'shutdown', 'description', 'enable', 'disable',
  // common top-level stanzas (both vendors)
  'interface', 'interfaces', 'router', 'routing-options', 'protocols',
  'policy', 'policy-options', 'policy-map', 'class-map', 'route-map',
  'prefix-list', 'access-list', 'ip', 'ipv6', 'mpls', 'bgp', 'ospf', 'ospf3',
  'isis', 'rip', 'ldp', 'rsvp', 'vlan', 'vlans', 'vrf', 'bridge-domain',
  'system', 'security', 'firewall', 'snmp', 'snmp-server', 'logging', 'ntp',
  'aaa', 'tacacs', 'radius', 'username', 'user', 'group', 'groups',
  'chassis', 'forwarding-options', 'class-of-service', 'event-options',
  'address-family', 'neighbor', 'network', 'redistribute', 'permit', 'deny',
  'match', 'then', 'from', 'unit', 'family', 'inet', 'inet6', 'vlan-id',
  'apply-groups', 'import', 'export', 'community', 'as-path', 'route',
  'static', 'next-hop', 'metric', 'preference', 'local-preference',
  'hostname', 'switchport', 'channel-group', 'spanning-tree', 'mtu',
];

export const netcliLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  ignoreCase: true,

  keywords: KEYWORDS,

  // Tokenizer
  tokenizer: {
    root: [
      // Whitespace
      [/[ \t\r\n]+/, ''],

      // Comments: Cisco `!` and Junos/shell `#` to end of line.
      [/!.*$/, 'comment'],
      [/#.*$/, 'comment'],
      // Junos inline annotations: /* ... */
      [/\/\*/, 'comment', '@blockComment'],

      // Strings
      [/"([^"\\]|\\.)*$/, 'string.invalid'],
      [/"/, 'string', '@string'],

      // IPv4 / IPv4+mask / CIDR
      [/\b\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?\b/, 'number'],
      // IPv6 (loose) and MAC addresses
      [/\b([0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F:]*\b/, 'number'],
      [/\b([0-9a-fA-F]{2}[:.]){2,}[0-9a-fA-F]{2}\b/, 'number'],
      // Plain numbers
      [/\b\d+\b/, 'number'],

      // Junos braces / value-list brackets
      [/[{}]/, '@brackets'],
      [/[[\]]/, '@brackets'],
      [/;/, 'delimiter'],

      // Keywords vs identifiers
      [/[a-zA-Z][\w-]*/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'identifier',
        },
      }],
    ],

    blockComment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],

    string: [
      [/[^"\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
  },
};

export const netcliLanguageConfig: languages.LanguageConfiguration = {
  comments: {
    lineComment: '!',
    blockComment: ['/*', '*/'],
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
  ],
};
