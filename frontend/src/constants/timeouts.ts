/**
 * Centralised timeout constants for HTTP requests, polling intervals,
 * and other time-based operations.
 *
 * Values were chosen to match the literals already used in the codebase
 * — so adopting these constants is a pure rename, not a behaviour
 * change. Add new buckets here rather than introducing more magic
 * numbers in call sites.
 */
export const TIMEOUT = {
  /** Quick interactive calls — local API health probes, etc. */
  FAST: 3000,
  /** Default for most outbound API calls. */
  DEFAULT: 30000,
  /** Slow-but-not-extreme calls — large list fetches, simple device commands. */
  SLOW: 60000,
  /** External integrations that may need long polling — NetBox/LibreNMS. */
  NETBOX: 300000,
  /** Default polling interval — task progress, status, etc. */
  POLL: 15000,
} as const;

export type TimeoutBucket = keyof typeof TIMEOUT;
