/**
 * Leveled logger.
 *
 * `log` and `debug` are no-ops in production builds (gated on
 * `import.meta.env.PROD`) so dev-only diagnostic output doesn't ship to
 * end users. `warn` and `error` always fire — those need to surface in
 * production too so users / support can see them in DevTools.
 *
 * Why a namespace export (`logger.log(...)`) and not bare named
 * exports? Several files in this codebase already use local symbols
 * named `log`. Namespacing keeps the migration mechanical and avoids
 * accidental shadowing.
 *
 * Companion ESLint rule (B-3) bans raw `console.log` / `console.debug`
 * going forward to keep this discipline once it's in place.
 */

const isProd = import.meta.env.PROD;
const noop = (..._args: unknown[]): void => { /* no-op in prod */ };

export const logger = {
  /** Dev diagnostic; silenced in production. */
  log: isProd ? noop : console.log.bind(console),
  /** Verbose dev diagnostic; silenced in production. */
  debug: isProd ? noop : console.debug.bind(console),
  /** Always fires. Use for soft failures the user / support may need. */
  warn: console.warn.bind(console),
  /** Always fires. Use for hard failures and unexpected conditions. */
  error: console.error.bind(console),
};
