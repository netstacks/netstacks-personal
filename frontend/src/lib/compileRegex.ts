/**
 * Compile a regex string that may carry leading PCRE/Rust-style inline flag
 * groups (e.g. `(?i)`, `(?im)`). JavaScript's `RegExp` does not support inline
 * flags, so a pattern like `(?i)\bGi\d+` throws "unrecognized character after
 * (?". Network-device matcher patterns are authored against the Rust regex
 * crate (backend), which does support `(?i)`, so they reach the frontend with
 * inline flags. This translates the leading group(s) into RegExp flags.
 *
 * Only leading *global* groups (`(?i)`) are translated; scoped groups
 * (`(?i:...)`) are left as-is, since JS can't express per-group flags — those
 * would still throw and be caught by the caller.
 */
const TRANSLATABLE_FLAGS = new Set(['i', 'm', 's', 'u']);

export function compileRegex(pattern: string, baseFlags = ''): RegExp {
  let source = pattern;
  let extra = '';
  const leadingFlags = /^\(\?([a-zA-Z]+)\)/;
  let m: RegExpExecArray | null;
  while ((m = leadingFlags.exec(source)) !== null) {
    for (const f of m[1].toLowerCase()) {
      // Skip flags JS lacks (e.g. `x` extended mode) — no equivalent.
      if (TRANSLATABLE_FLAGS.has(f) && !baseFlags.includes(f) && !extra.includes(f)) {
        extra += f;
      }
    }
    source = source.slice(m[0].length);
  }
  return new RegExp(source, baseFlags + extra);
}
