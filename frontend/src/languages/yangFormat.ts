import type { languages, editor } from 'monaco-editor';

const INDENT = '  ';

/**
 * Indent-based YANG pretty-printer.
 *
 * Walks the input line by line, tracking depth from { and }.
 * Quoted strings and block comments are passed through verbatim so their
 * contents are never reformatted. Single-line statements get the current
 * depth's indent. Lines that contain both { and } at the same depth on
 * a single line are passed through as-is (the formatter does not try to
 * expand one-liners onto multiple lines).
 */
export function formatYang(input: string): string {
  const lines = input.split('\n');
  const output: string[] = [];
  let depth = 0;
  let inBlockComment = false;
  let inString: false | '"' | "'" = false;

  for (const rawLine of lines) {
    // If we're inside a multi-line string or block comment, the line
    // is passed through verbatim (don't touch its indentation).
    if (inString || inBlockComment) {
      output.push(rawLine);
      for (let i = 0; i < rawLine.length; i++) {
        const c = rawLine[i];
        const next = rawLine[i + 1];
        if (inBlockComment && c === '*' && next === '/') {
          inBlockComment = false;
          i++;
        } else if (inString && c === inString && rawLine[i - 1] !== '\\') {
          inString = false;
        }
      }
      continue;
    }

    const trimmed = rawLine.trim();
    if (trimmed === '') {
      output.push('');
      continue;
    }

    // Count net brace change on this line, ignoring braces inside
    // strings or comments that open/close on the same line.
    let netChange = 0;
    let opensAtStart = 0; // leading } that should DEDENT before emit
    let sawNonBraceBeforeOpening = false;
    let localInString: false | '"' | "'" = false;
    let localInBlockComment = false;
    let localInLineComment = false;

    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      const next = trimmed[i + 1];

      if (localInLineComment) break;
      if (localInString) {
        if (c === localInString && trimmed[i - 1] !== '\\') localInString = false;
        continue;
      }
      if (localInBlockComment) {
        if (c === '*' && next === '/') { localInBlockComment = false; i++; }
        continue;
      }

      if (c === '/' && next === '/') { localInLineComment = true; continue; }
      if (c === '/' && next === '*') { localInBlockComment = true; i++; continue; }
      if (c === '"' || c === "'") { localInString = c as '"' | "'"; continue; }

      if (c === '{') { netChange++; sawNonBraceBeforeOpening = sawNonBraceBeforeOpening || i > opensAtStart; }
      else if (c === '}') {
        netChange--;
        if (!sawNonBraceBeforeOpening && netChange < 0) opensAtStart++;
      } else if (c !== ' ' && c !== '\t') {
        sawNonBraceBeforeOpening = true;
      }
    }

    // Apply leading dedent for any close braces at the start of the line.
    const effectiveDepth = Math.max(0, depth - opensAtStart);
    output.push(INDENT.repeat(effectiveDepth) + trimmed);

    depth = Math.max(0, depth + netChange);
    if (localInString) inString = localInString;
    if (localInBlockComment) inBlockComment = true;
  }

  return output.join('\n');
}

/**
 * Monaco format provider adapter.
 */
export const yangFormatProvider: languages.DocumentFormattingEditProvider = {
  provideDocumentFormattingEdits(model: editor.ITextModel): languages.TextEdit[] {
    const formatted = formatYang(model.getValue());
    return [{
      range: model.getFullModelRange(),
      text: formatted,
    }];
  },
};
