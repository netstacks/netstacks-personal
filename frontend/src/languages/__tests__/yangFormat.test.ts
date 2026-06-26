import { describe, it, expect } from 'vitest';
import { formatYang } from '../yangFormat';

describe('YANG format provider', () => {
  it('indents nested braces with 2 spaces per level', () => {
    const input = `module foo {
container bar {
leaf baz {
type string;
}
}
}`;
    const expected = `module foo {
  container bar {
    leaf baz {
      type string;
    }
  }
}`;
    expect(formatYang(input)).toBe(expected);
  });

  it('preserves single-line statements with no brace change', () => {
    const input = `module foo {
yang-version 1.1;
namespace "urn:example:foo";
prefix "f";
}`;
    const expected = `module foo {
  yang-version 1.1;
  namespace "urn:example:foo";
  prefix "f";
}`;
    expect(formatYang(input)).toBe(expected);
  });

  it('preserves quoted strings verbatim (does not reformat their contents)', () => {
    const input = `module foo {
description "Line one
Line two
Line three";
}`;
    const expected = `module foo {
  description "Line one
Line two
Line three";
}`;
    expect(formatYang(input)).toBe(expected);
  });

  it('preserves block comments without rewriting them', () => {
    const input = `module foo {
/* This is a
   multi-line block comment */
container c {
}
}`;
    const expected = `module foo {
  /* This is a
   multi-line block comment */
  container c {
  }
}`;
    expect(formatYang(input)).toBe(expected);
  });

  it('handles closing braces on the same line as opening (one-liners)', () => {
    const input = `module foo { leaf x { type string; } }`;
    expect(formatYang(input)).toBe(input);
  });

  it('collapses trailing whitespace and tabs in indentation', () => {
    const input = `module foo {
\t\tleaf x {
   type string;
}
}`;
    const expected = `module foo {
  leaf x {
    type string;
  }
}`;
    expect(formatYang(input)).toBe(expected);
  });
});
