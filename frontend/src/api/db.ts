import { getClient, getCurrentMode } from './client';

// Whole-database backup & seed. Only meaningful in standalone (local agent) mode.
export function backupSupported(): boolean {
  return getCurrentMode() !== 'enterprise';
}

export interface DbInfo {
  path: string;
  dir: string;
  size_bytes: number;
}

export async function getDbInfo(): Promise<DbInfo> {
  const { data } = await getClient().http.get('/db/info');
  return data as DbInfo;
}

export async function exportDb(path: string, includeVault: boolean): Promise<void> {
  await getClient().http.post('/db/export', { path, include_vault: includeVault });
}

export async function importDb(path: string): Promise<void> {
  await getClient().http.post('/db/import', { path });
}

/** Factory reset: backup current DB then stage a fresh empty DB for next startup. */
export async function resetDb(): Promise<void> {
  await getClient().http.post('/db/reset');
}

/** Copy current DB to `path`, write config so agent uses it on next startup. */
export async function setDbPath(path: string): Promise<void> {
  await getClient().http.post('/db/path', { path });
}

/** Clear any custom DB path, reverting to the default on next startup. */
export async function clearDbPath(): Promise<void> {
  await getClient().http.delete('/db/path');
}
