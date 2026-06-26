import type { languages } from 'monaco-editor';

// Keywords that introduce statements in a YANG module.
const STATEMENT_KEYWORDS = [
  'module', 'submodule', 'yang-version', 'namespace', 'prefix',
  'import', 'include', 'organization', 'contact', 'description',
  'reference', 'revision', 'revision-date',
  'extension', 'argument', 'yin-element',
  'feature', 'if-feature', 'identity', 'base',
  'typedef', 'type', 'units', 'default', 'status',
  'container', 'must', 'presence', 'leaf', 'leaf-list',
  'list', 'key', 'unique', 'min-elements', 'max-elements', 'ordered-by',
  'choice', 'case', 'mandatory', 'config', 'when',
  'uses', 'refine', 'augment', 'grouping',
  'rpc', 'input', 'output', 'action', 'notification',
  'anyxml', 'anydata',
  'deviation', 'deviate', 'not-supported', 'add', 'replace', 'delete',
  'belongs-to', 'pattern', 'modifier', 'range', 'length',
  'enum', 'value', 'bit', 'position',
  'fraction-digits', 'path', 'require-instance',
  'error-message', 'error-app-tag',
];

// YANG built-in types — highlighted differently when they appear as
// the argument to a `type` statement.
const BUILTIN_TYPES = [
  'binary', 'bits', 'boolean', 'decimal64', 'empty',
  'enumeration', 'identityref', 'instance-identifier',
  'int8', 'int16', 'int32', 'int64',
  'leafref', 'string', 'union',
  'uint8', 'uint16', 'uint32', 'uint64',
];

export const yangLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  ignoreCase: false,

  keywords: STATEMENT_KEYWORDS,
  builtinTypes: BUILTIN_TYPES,

  // Identifiers in YANG can include letters, digits, hyphens, underscores, and dots.
  identifier: /[A-Za-z_][\w\-.]*/,

  tokenizer: {
    root: [
      // Whitespace
      { include: '@whitespace' },

      // Block comments
      [/\/\*/, 'comment', '@blockComment'],

      // Line comments
      [/\/\/.*$/, 'comment'],

      // The `type` statement gets special handling so its argument
      // can be tokenized as a built-in type.
      [/\btype\b/, { token: 'keyword', next: '@typeArgument' }],

      // Keywords (statement names)
      [/@identifier/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'identifier',
        },
      }],

      // Block delimiters
      [/[{}]/, '@brackets'],
      [/[;]/, 'delimiter'],

      // Strings
      [/"/, { token: 'string.quote', next: '@stringDouble' }],
      [/'/, { token: 'string.quote', next: '@stringSingle' }],

      // Numbers (integer + decimal)
      [/\d+\.\d+/, 'number.float'],
      [/\d+/, 'number'],

      // Operators (for when/must XPath-ish expressions)
      [/[+\-*/=<>!]+/, 'operator'],
    ],

    typeArgument: [
      [/\s+/, ''],
      [/@identifier/, {
        cases: {
          '@builtinTypes': { token: 'type', next: '@pop' },
          '@default': { token: 'type', next: '@pop' },
        },
      }],
      // Fallback if no identifier (e.g. malformed input)
      [/./, { token: '', next: '@pop' }],
    ],

    whitespace: [
      [/[ \t\r\n]+/, ''],
    ],

    blockComment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],

    stringDouble: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.quote', next: '@pop' }],
    ],

    stringSingle: [
      [/[^\\']+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, { token: 'string.quote', next: '@pop' }],
    ],
  },
};

export const yangLanguageConfig: languages.LanguageConfiguration = {
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};
