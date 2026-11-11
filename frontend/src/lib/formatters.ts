/**
 * Shared formatting utilities for the terminal frontend.
 *
 * Canonical source for:
 *   - formatDuration (seconds -> compact string)
 *   - formatDurationMs (milliseconds -> compact string)
 *   - formatDurationBetween (ISO date strings -> string | null)
 *   - formatElapsed (Date start to now/end -> hh:mm:ss or mm:ss)
 *   - formatUptime (seconds -> compact or verbose string)
 *   - escapeCSV (CSV field escaping)
 *   - downloadFile (browser file download via blob URL)
 */

/**
 * Format a duration in seconds to a compact human-readable string.
 * Examples: 30 -> "30s", 90 -> "1m 30s", 5400 -> "1h 30m", 90000 -> "1d 1h"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hours < 24) return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}

/**
 * Format a duration in milliseconds to a compact human-readable string.
 * Examples: 150 -> "150ms", 1500 -> "1.5s"
 */
export function formatDurationMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format duration between two ISO date strings.
 * Returns null if startAt is null.
 * If endAt is null, uses current time (task still running).
 * Examples: ("2024-01-01T00:00:00Z", "2024-01-01T00:01:30Z") -> "1m 30s"
 */
export function formatDurationBetween(startAt: string | null, endAt: string | null): string | null {
  if (!startAt) return null;

  const start = new Date(startAt).getTime();
  const end = endAt ? new Date(endAt).getTime() : Date.now();
  const ms = end - start;

  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) {
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${mins}m`;
}

/**
 * Format elapsed time from a start Date to now (or an explicit end Date).
 * Returns a clock-style string: "mm:ss" or "hh:mm:ss" for values >= 1 hour.
 * Suitable for real-time displays and summary duration fields.
 */
export function formatElapsed(start: Date, end?: Date): string {
  const now = end ?? new Date();
  const diffMs = now.getTime() - start.getTime();
  const totalSeconds = Math.floor(diffMs / 1000);

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Format uptime from seconds to a human-readable string.
 *
 * @param seconds - Uptime in seconds
 * @param mode - 'compact' (default) for "4d 13h 0m"; 'verbose' for "4 days, 13 hours, 0 minutes"
 *
 * Examples:
 *   formatUptime(392445) -> "4d 13h 0m"
 *   formatUptime(392445, 'verbose') -> "4 days, 13 hours, 0 minutes"
 */
export function formatUptime(seconds: number, mode: 'compact' | 'verbose' = 'compact'): string {
  if (seconds < 0 || !isFinite(seconds)) {
    return 'N/A';
  }

  if (mode === 'verbose') {
    if (seconds <= 0) return '0 seconds';

    const days = Math.floor(seconds / (24 * 60 * 60));
    const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
    const minutes = Math.floor((seconds % (60 * 60)) / 60);
    const secs = seconds % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
    if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
    if (secs > 0 && days === 0) parts.push(`${secs} second${secs !== 1 ? 's' : ''}`);

    return parts.join(', ') || '0 seconds';
  }

  // compact mode: "4d 13h 0m"
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0 || days > 0) {
    parts.push(`${hours}h`);
  }
  parts.push(`${minutes}m`);

  return parts.join(' ');
}

/**
 * Escape a value for CSV format.
 * Wraps value in double-quotes if it contains commas, quotes, or newlines.
 */
export function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Trigger a browser file download via a temporary blob URL.
 *
 * @param content - File content as a string or Blob
 * @param filename - Download filename (including extension)
 * @param mimeType - MIME type (used only when content is a string). Defaults to 'application/octet-stream'.
 */
export function downloadFile(content: string | Blob, filename: string, mimeType?: string): void {
  const blob = content instanceof Blob
    ? content
    : new Blob([content], { type: mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
