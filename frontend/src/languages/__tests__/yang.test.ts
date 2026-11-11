import { describe, it, expect, beforeAll } from 'vitest';
import * as monaco from 'monaco-editor';
import { yangLanguage, yangLanguageConfig } from '../yang';

beforeAll(() => {
  monaco.languages.register({ id: 'yang', extensions: ['.yang'] });
  monaco.languages.setMonarchTokensProvider('yang', yangLanguage);
  monaco.languages.setLanguageConfiguration('yang', yangLanguageConfig);
});

function tokenize(line: string): { token: string; text: string }[] {
  const tokens = monaco.editor.tokenize(line, 'yang')[0];
  return tokens.map((t, i) => ({
    token: t.type,
    text: line.substring(t.offset, tokens[i + 1]?.offset ?? line.length),
  }));
}

describe('YANG Monarch grammar', () => {
  it('tokenizes top-level keywords', () => {
    const result = tokenize('module example {');
    expect(result[0].token).toBe('keyword.yang');
    expect(result[0].text).toBe('module');
  });

  it('tokenizes statement keywords', () => {
    const result = tokenize('  container interfaces {');
    expect(result.find(t => t.text === 'container')?.token).toBe('keyword.yang');
  });

  it('tokenizes built-in types after `type`', () => {
    const result = tokenize('    type string;');
    const stringToken = result.find(t => t.text === 'string');
    expect(stringToken?.token).toMatch(/type\.yang/);
  });

  it('tokenizes double-quoted strings', () => {
    const result = tokenize('  description "Hello world";');
    const stringTokens = result.filter(t => t.token.startsWith('string'));
    expect(stringTokens.length).toBeGreaterThan(0);
  });

  it('tokenizes single-line comments', () => {
    const result = tokenize('// this is a comment');
    expect(result[0].token).toMatch(/comment/);
  });

  it('tokenizes block comments', () => {
    const result = tokenize('/* block comment */');
    expect(result[0].token).toMatch(/comment/);
  });

  it('tokenizes numbers', () => {
    const result = tokenize('  default 42;');
    const numToken = result.find(t => t.text === '42');
    expect(numToken?.token).toMatch(/number/);
  });
});
