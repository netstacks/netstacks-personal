/**
 * Enrichment Helper Utilities
 *
 * Helper functions for formatting and displaying enrichment data
 * in topology visualizations.
 */

// Re-export formatUptime from canonical source for backward compatibility
export { formatUptime } from './formatters';

/**
 * Format bytes to human-readable string.
 * Example: 1073741824 -> "1.0 GB"
 */
export function formatBytes(bytes: number): string {
  if (bytes < 0 || !isFinite(bytes)) {
    return 'N/A';
  }

  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / Math.pow(1024, exponent);

  // Use different precision based on size
  if (value >= 100) {
    return `${Math.round(value)} ${units[exponent]}`;
  } else if (value >= 10) {
    return `${value.toFixed(1)} ${units[exponent]}`;
  } else {
    return `${value.toFixed(2)} ${units[exponent]}`;
  }
}

/**
 * Format a percentage value with 1 decimal place.
 * Example: 67.5 -> "67.5%"
 */
export function formatPercent(value: number): string {
  if (!isFinite(value)) {
    return 'N/A';
  }

  // Clamp value to 0-100 range for display
  const clamped = Math.max(0, Math.min(100, value));
  return `${clamped.toFixed(1)}%`;
}

/**
 * Get the color for an interface status.
 * Uses CSS custom properties with fallback hex colors.
 */
export function getStatusColor(status: 'up' | 'down' | 'admin-down'): string {
  switch (status) {
    case 'up':
      return 'var(--success-color, #22c55e)';
    case 'down':
      return 'var(--error-color, #ef4444)';
    case 'admin-down':
      return 'var(--warning-color, #f59e0b)';
    default:
      return 'var(--text-muted, #6b7280)';
  }
}

/**
 * Get the resource level based on a percentage value.
 * Used for color-coding CPU/memory usage.
 */
export function getResourceLevel(percent: number): 'low' | 'medium' | 'high' | 'critical' {
  if (!isFinite(percent) || percent < 0) {
    return 'low';
  }

  if (percent <= 50) {
    return 'low';
  } else if (percent <= 75) {
    return 'medium';
  } else if (percent <= 90) {
    return 'high';
  } else {
    return 'critical';
  }
}

/**
 * Get the color for a resource level.
 */
export function getResourceLevelColor(level: 'low' | 'medium' | 'high' | 'critical'): string {
  switch (level) {
    case 'low':
      return 'var(--success-color, #22c55e)';
    case 'medium':
      return 'var(--warning-color, #f59e0b)';
    case 'high':
      return 'var(--warning-color, #f59e0b)';
    case 'critical':
      return 'var(--error-color, #ef4444)';
    default:
      return 'var(--text-muted, #6b7280)';
  }
}

/**
 * Format packet count with appropriate suffix.
 * Example: 1234567 -> "1.2M pkts"
 */
export function formatPackets(count: number): string {
  if (count < 0 || !isFinite(count)) {
    return 'N/A';
  }

  if (count === 0) {
    return '0 pkts';
  }

  if (count >= 1_000_000_000) {
    return `${(count / 1_000_000_000).toFixed(1)}B pkts`;
  } else if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M pkts`;
  } else if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K pkts`;
  } else {
    return `${count} pkts`;
  }
}

/**
 * Format bits per second (bps) to human-readable string.
 * Example: 1000000000 -> "1.0 Gbps"
 */
export function formatBps(bps: number): string {
  if (bps < 0 || !isFinite(bps)) {
    return 'N/A';
  }

  if (bps === 0) {
    return '0 bps';
  }

  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  const exponent = Math.min(
    Math.floor(Math.log(bps) / Math.log(1000)),
    units.length - 1
  );
  const value = bps / Math.pow(1000, exponent);

  if (value >= 100) {
    return `${Math.round(value)} ${units[exponent]}`;
  } else if (value >= 10) {
    return `${value.toFixed(1)} ${units[exponent]}`;
  } else {
    return `${value.toFixed(2)} ${units[exponent]}`;
  }
}

/**
 * Format a date as a relative time string.
 * Example: "5 minutes ago", "2 hours ago"
 */
export function formatRelativeTime(date: Date | null): string {
  if (!date) {
    return 'Never';
  }

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 60) {
    return 'Just now';
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

/**
 * Truncate a string to a maximum length with ellipsis.
 */
export function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - 3) + '...';
}
