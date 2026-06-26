// API client for sessions, folders, and vault

import { getClient, getCurrentMode } from './client';
import type { CliFlavor } from '../types/enrichment';

// Re-export CliFlavor for backward compatibility (consumers importing from sessions still work)
export type { CliFlavor } from '../types/enrichment';

export const CLI_FLAVOR_OPTIONS: { value: CliFlavor; label: string }[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'linux', label: 'Linux/Unix Shell' },
  { value: 'cisco-ios', label: 'Cisco IOS/IOS-XE' },
  { value: 'cisco-ios-xr', label: 'Cisco IOS-XR' },
  { value: 'cisco-nxos', label: 'Cisco NX-OS' },
  { value: 'juniper', label: 'Juniper Junos' },
  { value: 'arista', label: 'Arista EOS' },
  { value: 'paloalto', label: 'Palo Alto PAN-OS' },
  { value: 'fortinet', label: 'Fortinet FortiOS' },
];

// Connection protocol
export type Protocol = 'ssh' | 'telnet';

export const PROTOCOL_OPTIONS: { value: Protocol; label: string }[] = [
  { value: 'ssh', label: 'SSH' },
  { value: 'telnet', label: 'Telnet' },
];

// Port forwarding types (Phase 06.3)
export type PortForwardType = 'local' | 'remote' | 'dynamic';

export interface PortForward {
  id: string;
  forward_type: PortForwardType;
  local_port: number;
  remote_host: string | null;
  remote_port: number | null;
  bind_address: string | null;
  enabled: boolean;
}

export const PORT_FORWARD_TYPE_OPTIONS: { value: PortForwardType; label: string; description: string }[] = [
  { value: 'local', label: 'Local (-L)', description: 'Access remote service through local port' },
  { value: 'remote', label: 'Remote (-R)', description: 'Expose local service to remote host' },
  { value: 'dynamic', label: 'Dynamic (-D)', description: 'SOCKS proxy for any destination' },
];

export interface Session {
  id: string;
  name: string;
  folder_id: string | null;
  host: string;
  port: number;
  color: string | null;
  icon: string | null;
  sort_order: number;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
  // Session-specific settings
  auto_reconnect: boolean;
  reconnect_delay: number;
  scrollback_lines: number;
  local_echo: boolean;
  font_size_override: number | null;
  font_family: string | null;
  // Profile integration (required - all auth comes from profile)
  profile_id: string;
  netbox_device_id: number | null;
  netbox_source_id: string | null;
  // AI features
  cli_flavor: CliFlavor;
  // Terminal appearance
  terminal_theme: string | null;
  // Jump host reference (global jump hosts)
  jump_host_id: string | null;
  // Alternative jump: another Session used as the jump endpoint
  // (mutually exclusive with jump_host_id; backend rejects setting both).
  jump_session_id: string | null;
  // Legacy SSH support for older devices
  legacy_ssh: boolean;
  // Connection protocol
  protocol: Protocol;
  // Port forwarding (Phase 06.3)
  port_forwards: PortForward[];
  // Auto commands on connect
  auto_commands: string[];
  // SFTP starting directory override
  sftp_start_path: string | null;
}

// === Jump Hosts (Global Proxy Configuration) ===

export interface JumpHost {
  id: string;
  name: string;
  host: string;
  port: number;
  profile_id: string;
  created_at: string;
  updated_at: string;
}

export interface NewJumpHost {
  name: string;
  host: string;
  port?: number;
  profile_id: string;
}

export interface UpdateJumpHost {
  name?: string;
  host?: string;
  port?: number;
  profile_id?: string;
}

export interface Snippet {
  id: string;
  session_id: string | null;
  name: string;
  command: string;
  sort_order: number;
  shared?: boolean;
  owner_name?: string | null;
  is_own?: boolean;
  created_at: string;
}

export interface NewSnippet {
  name: string;
  command: string;
  sort_order?: number;
  shared?: boolean;
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface NewSession {
  name: string;
  folder_id?: string | null;
  host: string;
  port?: number;
  color?: string | null;
  icon?: string | null;
  // Session-specific settings
  auto_reconnect?: boolean;
  reconnect_delay?: number;
  scrollback_lines?: number;
  local_echo?: boolean;
  font_size_override?: number | null;
  font_family?: string | null;
  // Profile integration (required - all auth comes from profile)
  profile_id: string;
  // NetBox integration
  netbox_device_id?: number | null;
  netbox_source_id?: string | null;
  // AI features
  cli_flavor?: CliFlavor;
  // Terminal appearance
  terminal_theme?: string | null;
  // Jump host reference (global jump hosts)
  jump_host_id?: string | null;
  // Alternative jump: another Session used as the jump endpoint
  // (mutually exclusive with jump_host_id; backend rejects setting both).
  jump_session_id?: string | null;
  // Legacy SSH support for older devices
  legacy_ssh?: boolean;
  // Connection protocol
  protocol?: Protocol;
  // Port forwarding (Phase 06.3)
  port_forwards?: PortForward[];
  // Auto commands on connect
  auto_commands?: string[];
  // SFTP starting directory override
  sftp_start_path?: string | null;
}

export interface UpdateSessionData {
  name?: string;
  folder_id?: string | null;
  host?: string;
  port?: number;
  color?: string | null;
  icon?: string | null;
  sort_order?: number;
  // Session-specific settings
  auto_reconnect?: boolean;
  reconnect_delay?: number;
  scrollback_lines?: number;
  local_echo?: boolean;
  font_size_override?: number | null;
  font_family?: string | null;
  // Profile integration (required for auth)
  profile_id?: string;
  // AI features
  cli_flavor?: CliFlavor;
  // Terminal appearance
  terminal_theme?: string | null;
  // Jump host reference (global jump hosts)
  jump_host_id?: string | null;
  // Alternative jump: another Session used as the jump endpoint
  // (mutually exclusive with jump_host_id; backend rejects setting both).
  jump_session_id?: string | null;
  // Legacy SSH support for older devices
  legacy_ssh?: boolean;
  // Connection protocol
  protocol?: Protocol;
  // Port forwarding (Phase 06.3)
  port_forwards?: PortForward[];
  // Auto commands on connect
  auto_commands?: string[];
  // SFTP starting directory override
  sftp_start_path?: string | null;
}

export interface VaultStatus {
  unlocked: boolean;
  has_master_password: boolean;
}

// Sessions API
// Sessions are a standalone/professional concept — not available in enterprise mode.
// In enterprise mode, devices come from the controller inventory, not local sessions.
export async function listSessions(): Promise<Session[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get('/sessions');
  return data;
}

export async function getSession(id: string): Promise<Session> {
  const { data } = await getClient().http.get(`/sessions/${id}`);
  return data;
}

export async function createSession(session: NewSession): Promise<Session> {
  const { data } = await getClient().http.post('/sessions', session);
  return data;
}

/** A single artifact (session/tunnel/profile) using some session as its jump. */
export interface JumpDependentRef {
  id: string;
  name: string;
}

/** Aggregate of every artifact depending on a given session as its jump endpoint. */
export interface JumpDependents {
  sessions: JumpDependentRef[];
  tunnels: JumpDependentRef[];
  profiles: JumpDependentRef[];
}

/**
 * Fetch the list of sessions/tunnels/profiles that use the given session
 * as their `jump_session_id`. Used by SessionSettingsDialog to render a
 * "Used as jump by N" hint and (future) gate session deletion.
 */
export async function getSessionJumpDependents(sessionId: string): Promise<JumpDependents> {
  const { data } = await getClient().http.get(`/sessions/${sessionId}/jump-dependents`);
  return data;
}

export async function updateSession(id: string, session: UpdateSessionData): Promise<Session> {
  const { data } = await getClient().http.put(`/sessions/${id}`, session);
  return data;
}

export async function deleteSession(id: string): Promise<void> {
  await getClient().http.delete(`/sessions/${id}`);
}

/**
 * Bulk delete multiple sessions via backend batch endpoint
 * Returns the count of successfully deleted sessions
 */
export async function bulkDeleteSessions(ids: string[]): Promise<{ deleted: number; failed: number }> {
  const { data } = await getClient().http.post('/sessions/bulk-delete', { ids });
  return data;
}

// Folders API
export async function listFolders(): Promise<Folder[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get('/folders');
  return data;
}

export async function createFolder(name: string, parent_id?: string): Promise<Folder> {
  if (getCurrentMode() === 'enterprise') throw new Error('Folder management is not available in enterprise mode');
  const { data } = await getClient().http.post('/folders', { name, parent_id });
  return data;
}

// Vault API
export async function getVaultStatus(): Promise<VaultStatus> {
  if (getCurrentMode() === 'enterprise') return { unlocked: true, has_master_password: false };
  const { data } = await getClient().http.get('/vault/status');
  return data;
}

export async function setMasterPassword(password: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Local vault is not available in enterprise mode');
  await getClient().http.post('/vault/password', { password });
}

export async function unlockVault(password: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Local vault is not available in enterprise mode');
  await getClient().http.post('/vault/unlock', { password });
}

export async function storeCredential(sessionId: string, password?: string, keyPassphrase?: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Local credential storage is not available in enterprise mode');
  await getClient().http.post(`/credentials/${sessionId}`, { password, key_passphrase: keyPassphrase });
}

// Session Snippets API
export async function listSessionSnippets(sessionId: string): Promise<Snippet[]> {
  const { data } = await getClient().http.get(`/sessions/${sessionId}/snippets`);
  return data;
}

export async function createSessionSnippet(sessionId: string, snippet: NewSnippet): Promise<Snippet> {
  const { data } = await getClient().http.post(`/sessions/${sessionId}/snippets`, snippet);
  return data;
}

export async function deleteSessionSnippet(sessionId: string, snippetId: string): Promise<void> {
  await getClient().http.delete(`/sessions/${sessionId}/snippets/${snippetId}`);
}

// Connection History API
export interface ConnectionHistory {
  id: string;
  session_id: string | null;
  host: string;
  port: number;
  username: string;
  connected_at: string;
  disconnected_at: string | null;
  duration_seconds: number | null;
}

export interface NewConnectionHistory {
  session_id?: string | null;
  host: string;
  port?: number;
  username: string;
}

export async function listHistory(): Promise<ConnectionHistory[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get('/history');
  return data;
}

export async function createHistory(entry: NewConnectionHistory): Promise<ConnectionHistory> {
  if (getCurrentMode() === 'enterprise') throw new Error('Connection history is not available in enterprise mode');
  const { data } = await getClient().http.post('/history', entry);
  return data;
}

export async function deleteHistory(id: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Connection history is not available in enterprise mode');
  await getClient().http.delete(`/history/${id}`);
}

// Export/Import API
export interface ExportSession {
  name: string;
  folder_name: string | null;
  host: string;
  port: number;
  color: string | null;
  icon: string | null;
  auto_reconnect: boolean;
  reconnect_delay: number;
  scrollback_lines: number;
  local_echo: boolean;
  font_size_override: number | null;
  mapped_keys: { key_combo: string; command: string }[];
  snippets: { name: string; command: string; sort_order: number }[];
  // Profile-based auth (name reference for portability)
  profile_name: string | null;
  // Jump host reference (name for portability)
  jump_host_name: string | null;
}

export interface ExportFolder {
  name: string;
  parent_name: string | null;
}

export interface ExportData {
  version: string;
  format: string;
  exported_at: string;
  sessions: ExportSession[];
  folders: ExportFolder[];
}

export interface ImportResult {
  sessions_created: number;
  folders_created: number;
  warnings: string[];
}

export async function exportAll(): Promise<ExportData> {
  if (getCurrentMode() === 'enterprise') throw new Error('Session export is not available in enterprise mode');
  const { data } = await getClient().http.get('/sessions/export');
  return data;
}

export async function exportSession(sessionId: string): Promise<ExportData> {
  if (getCurrentMode() === 'enterprise') throw new Error('Session export is not available in enterprise mode');
  const { data } = await getClient().http.get(`/sessions/${sessionId}/export`);
  return data;
}

export async function exportFolder(folderId: string): Promise<ExportData> {
  if (getCurrentMode() === 'enterprise') throw new Error('Folder export is not available in enterprise mode');
  const { data } = await getClient().http.get(`/folders/${folderId}/export`);
  return data;
}

export async function importSessions(data: ExportData): Promise<ImportResult> {
  if (getCurrentMode() === 'enterprise') throw new Error('Session import is not available in enterprise mode');
  const { data: result } = await getClient().http.post('/sessions/import', data);
  return result;
}

// Folder operations
export interface NewFolder {
  name: string;
  parent_id?: string | null;
}

export interface UpdateFolderData {
  name?: string;
  parent_id?: string | null;
  sort_order?: number;
}

export async function updateFolder(id: string, folder: UpdateFolderData): Promise<Folder> {
  if (getCurrentMode() === 'enterprise') throw new Error('Folder management is not available in enterprise mode');
  const { data } = await getClient().http.put(`/folders/${id}`, folder);
  return data;
}

export async function deleteFolder(id: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Folder management is not available in enterprise mode');
  await getClient().http.delete(`/folders/${id}`);
}

// Move/Reorder API

export interface MoveSessionData {
  folder_id: string | null;
  sort_order: number;
}

export interface MoveFolderData {
  parent_id: string | null;
  sort_order: number;
}

export async function moveSession(id: string, data: MoveSessionData): Promise<Session> {
  if (getCurrentMode() === 'enterprise') throw new Error('Session management is not available in enterprise mode');
  const { data: result } = await getClient().http.put(`/sessions/${id}/move`, data);
  return result;
}

export async function moveFolder(id: string, data: MoveFolderData): Promise<Folder> {
  if (getCurrentMode() === 'enterprise') throw new Error('Folder management is not available in enterprise mode');
  const { data: result } = await getClient().http.put(`/folders/${id}/move`, data);
  return result;
}

// === CSV Import/Export Utilities ===

import { type CredentialProfile } from './profiles';
import { escapeCSV } from '../lib/formatters';

/** Parse a CSV line handling quoted fields */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }
  fields.push(current);
  return fields;
}

/** Convert sessions to CSV string for export */
export function sessionsToCSV(
  sessions: Session[],
  folders: Folder[],
  profiles: CredentialProfile[],
): string {
  const folderMap = new Map(folders.map(f => [f.id, f.name]));
  const profileMap = new Map(profiles.map(p => [p.id, p.name]));

  const header = 'name,host,port,folder,profile';
  const rows = sessions.map(s => {
    const folderName = s.folder_id ? (folderMap.get(s.folder_id) || '') : '';
    const profileName = profileMap.get(s.profile_id) || '';
    return [
      escapeCSV(s.name),
      escapeCSV(s.host),
      String(s.port),
      escapeCSV(folderName),
      escapeCSV(profileName),
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

/** Parse CSV text and convert to ExportData format for import */
export function csvToExportData(csvText: string): { data: ExportData; warnings: string[] } {
  const warnings: string[] = [];
  const lines = csvText.split(/\r?\n/).filter(l => l.trim() !== '');

  if (lines.length < 2) {
    throw new Error('CSV file must have a header row and at least one data row');
  }

  const headerFields = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const nameIdx = headerFields.indexOf('name');
  const hostIdx = headerFields.indexOf('host');
  const portIdx = headerFields.indexOf('port');
  const folderIdx = headerFields.indexOf('folder');
  const profileIdx = headerFields.indexOf('profile');

  if (nameIdx === -1 || hostIdx === -1) {
    throw new Error('CSV must contain "name" and "host" columns');
  }

  const folderNames = new Set<string>();
  const exportSessions: ExportSession[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const name = fields[nameIdx]?.trim() || '';
    const host = fields[hostIdx]?.trim() || '';

    if (!name || !host) {
      warnings.push(`Row ${i + 1}: skipped — missing name or host`);
      continue;
    }

    const portStr = portIdx >= 0 ? fields[portIdx]?.trim() : '';
    const port = portStr ? parseInt(portStr, 10) : 22;
    if (isNaN(port) || port < 1 || port > 65535) {
      warnings.push(`Row ${i + 1}: invalid port "${portStr}", using 22`);
    }

    const folderName = folderIdx >= 0 ? fields[folderIdx]?.trim() || null : null;
    const profileName = profileIdx >= 0 ? fields[profileIdx]?.trim() || null : null;

    if (folderName) {
      folderNames.add(folderName);
    }

    exportSessions.push({
      name,
      host,
      port: (isNaN(port) || port < 1 || port > 65535) ? 22 : port,
      folder_name: folderName,
      profile_name: profileName,
      color: null,
      icon: null,
      auto_reconnect: true,
      reconnect_delay: 5,
      scrollback_lines: 10000,
      local_echo: false,
      font_size_override: null,
      mapped_keys: [],
      snippets: [],
      jump_host_name: null,
    });
  }

  const exportFolders: ExportFolder[] = Array.from(folderNames).map(name => ({
    name,
    parent_name: null,
  }));

  const data: ExportData = {
    version: '1.0',
    format: 'netstacks-sessions',
    exported_at: new Date().toISOString(),
    sessions: exportSessions,
    folders: exportFolders,
  };

  return { data, warnings };
}

/** Generate example CSV template */
export function generateExampleCSV(): string {
  return [
    'name,host,port,folder,profile',
    'router-1,192.168.1.1,22,Lab,default',
    'switch-1,192.168.1.2,22,Lab,default',
    'firewall-1,10.0.0.1,22,,default',
  ].join('\n');
}

// Note: Profile inheritance helpers removed - all auth comes from profile directly

// === Jump Hosts API ===

export async function listJumpHosts(): Promise<JumpHost[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get('/jump-hosts');
  return data;
}

export async function getJumpHost(id: string): Promise<JumpHost> {
  if (getCurrentMode() === 'enterprise') throw new Error('Jump host management is not available in enterprise mode');
  const { data } = await getClient().http.get(`/jump-hosts/${id}`);
  return data;
}

export async function createJumpHost(jumpHost: NewJumpHost): Promise<JumpHost> {
  if (getCurrentMode() === 'enterprise') throw new Error('Jump host management is not available in enterprise mode');
  const { data } = await getClient().http.post('/jump-hosts', jumpHost);
  return data;
}

export async function updateJumpHost(id: string, jumpHost: UpdateJumpHost): Promise<JumpHost> {
  if (getCurrentMode() === 'enterprise') throw new Error('Jump host management is not available in enterprise mode');
  const { data } = await getClient().http.put(`/jump-hosts/${id}`, jumpHost);
  return data;
}

export async function deleteJumpHost(id: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Jump host management is not available in enterprise mode');
  await getClient().http.delete(`/jump-hosts/${id}`);
}
