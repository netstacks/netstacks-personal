/**
 * Format a bits-per-second value into a human-readable string.
 * Auto-scales to bps / Kbps / Mbps / Gbps.
 */
export function formatRate(bps: number): string {
  if (bps < 0) return '0 bps';
  if (bps < 1000) return `${Math.round(bps)} bps`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(1)} Kbps`;
  if (bps < 1_000_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${(bps / 1_000_000_000).toFixed(1)} Gbps`;
}
