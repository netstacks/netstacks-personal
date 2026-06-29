// SFTP API client for remote file browsing

import { getClient } from './client';

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
}

export interface SftpConnectResponse {
  connected: boolean;
  home_dir: string | null;
}

export interface SftpLsResponse {
  entries: FileEntry[];
  path: string;
}

// Connect to SFTP for a session
export async function sftpConnect(
  sftpId: string,
  sessionId?: string,
  enterpriseParams?: { profile_id: string; host: string; port?: number }
): Promise<SftpConnectResponse> {
  try {
    const body = enterpriseParams
      ? { profile_id: enterpriseParams.profile_id, host: enterpriseParams.host, port: enterpriseParams.port }
      : { session_id: sessionId };
    const { data } = await getClient().http.post(`/sftp/${sftpId}/connect`, body);
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to connect SFTP');
  }
}

// Disconnect SFTP session
export async function sftpDisconnect(sftpId: string): Promise<void> {
  try {
    await getClient().http.post(`/sftp/${sftpId}/disconnect`);
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to disconnect SFTP');
  }
}

// List directory contents
export async function sftpLs(
  sftpId: string,
  path?: string
): Promise<SftpLsResponse> {
  try {
    const { data } = await getClient().http.get(`/sftp/${sftpId}/ls`, {
      params: path ? { path } : undefined,
    });
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to list directory');
  }
}

/**
 * Callback for real byte-transfer progress.
 *
 * `loaded` is the number of bytes that have crossed the wire so far.
 * `total` is the full payload size when known (download: from
 * Content-Length; upload: from the source Blob/Buffer size); `undefined`
 * for chunked responses with no Content-Length.
 *
 * Wired to axios's onUploadProgress / onDownloadProgress events, which
 * the browser populates from real XHR progress events — i.e. these
 * numbers are bytes-on-the-wire, not estimates.
 */
export type SftpTransferProgress = (loaded: number, total: number | undefined) => void;

// Download a file. `signal` lets the caller cancel a large transfer
// mid-stream — without it the cancel-flag was only checked after the
// full blob landed, which defeats the purpose for multi-GB files.
// `onProgress` receives real bytes-received counts during download.
export async function sftpDownload(
  sftpId: string,
  path: string,
  signal?: AbortSignal,
  onProgress?: SftpTransferProgress,
): Promise<Blob> {
  try {
    const { data } = await getClient().http.get(`/sftp/${sftpId}/download`, {
      params: { path },
      responseType: 'blob',
      signal,
      onDownloadProgress: onProgress
        ? (e) => onProgress(e.loaded, e.total)
        : undefined,
    });
    return data;
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError' || (err as Error).name === 'CanceledError') {
      throw err;
    }
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to download file');
  }
}

// Upload a file. Same signal semantics as sftpDownload — abort mid-upload
// closes the request rather than waiting for the full body to flush.
// `onProgress` receives real bytes-sent counts during upload.
export async function sftpUpload(
  sftpId: string,
  path: string,
  data: Blob | ArrayBuffer,
  signal?: AbortSignal,
  onProgress?: SftpTransferProgress,
): Promise<void> {
  try {
    await getClient().http.post(`/sftp/${sftpId}/upload`, data, {
      params: { path },
      headers: { 'Content-Type': 'application/octet-stream' },
      signal,
      onUploadProgress: onProgress
        ? (e) => onProgress(e.loaded, e.total)
        : undefined,
    });
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError' || (err as Error).name === 'CanceledError') {
      throw err;
    }
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to upload file');
  }
}

// Create a directory
export async function sftpMkdir(sftpId: string, path: string): Promise<void> {
  try {
    await getClient().http.post(`/sftp/${sftpId}/mkdir`, null, {
      params: { path },
    });
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to create directory');
  }
}

// Remove a file or directory
export async function sftpRm(
  sftpId: string,
  path: string,
  isDir: boolean
): Promise<void> {
  try {
    await getClient().http.delete(`/sftp/${sftpId}/rm`, {
      params: { path, is_dir: isDir },
    });
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to remove');
  }
}

// Rename a file or directory
export async function sftpRename(
  sftpId: string,
  from: string,
  to: string
): Promise<void> {
  try {
    await getClient().http.post(`/sftp/${sftpId}/rename`, null, {
      params: { from, to },
    });
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to rename');
  }
}

// Get file info
export async function sftpStat(
  sftpId: string,
  path: string
): Promise<FileEntry> {
  try {
    const { data } = await getClient().http.get(`/sftp/${sftpId}/stat`, {
      params: { path },
    });
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to get file info');
  }
}

// Helper to format file size
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// Helper to format permissions (Unix style)
export function formatPermissions(mode: number | null): string {
  if (mode === null) return '---';
  const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  const owner = perms[(mode >> 6) & 7];
  const group = perms[(mode >> 3) & 7];
  const other = perms[mode & 7];
  return `${owner}${group}${other}`;
}

// Helper to format timestamp
export function formatTimestamp(ts: number | null): string {
  if (ts === null) return '-';
  const date = new Date(ts * 1000);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
}
