import { getClient } from './client';
import type { PortForwardType } from './sessions';

// === Types ===

export type TunnelStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface Tunnel {
  id: string;
  name: string;
  host: string;
  port: number;
  profile_id: string;
  jump_host_id: string | null;
  /** Alternative jump: a Session used as the jump endpoint
   *  (mutually exclusive with jump_host_id). */
  jump_session_id: string | null;
  forward_type: PortForwardType;
  local_port: number;
  bind_address: string;
  remote_host: string | null;
  remote_port: number | null;
  auto_start: boolean;
  auto_reconnect: boolean;
  max_retries: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface TunnelRuntimeState {
  id: string;
  status: TunnelStatus;
  uptime_secs: number | null;
  bytes_tx: number;
  bytes_rx: number;
  last_error: string | null;
  retry_count: number;
}

export interface TunnelWithState extends Tunnel, TunnelRuntimeState {}

export interface NewTunnel {
  name: string;
  host: string;
  port?: number;
  profile_id: string;
  jump_host_id?: string | null;
  jump_session_id?: string | null;
  forward_type: PortForwardType;
  local_port: number;
  bind_address?: string;
  remote_host?: string | null;
  remote_port?: number | null;
  auto_start?: boolean;
  auto_reconnect?: boolean;
  max_retries?: number;
}

export interface UpdateTunnel {
  name?: string;
  host?: string;
  port?: number;
  profile_id?: string;
  jump_host_id?: string | null;
  jump_session_id?: string | null;
  forward_type?: PortForwardType;
  local_port?: number;
  bind_address?: string;
  remote_host?: string | null;
  remote_port?: number | null;
  auto_start?: boolean;
  auto_reconnect?: boolean;
  max_retries?: number;
  enabled?: boolean;
}

// === API Functions ===

export async function listTunnels(): Promise<TunnelWithState[]> {
  const { data } = await getClient().http.get('/tunnels');
  return data;
}

export async function createTunnel(tunnel: NewTunnel): Promise<Tunnel> {
  const { data } = await getClient().http.post('/tunnels', tunnel);
  return data;
}

export async function updateTunnel(id: string, update: UpdateTunnel): Promise<Tunnel> {
  const { data } = await getClient().http.put(`/tunnels/${id}`, update);
  return data;
}

export async function deleteTunnel(id: string): Promise<void> {
  await getClient().http.delete(`/tunnels/${id}`);
}

export async function startTunnel(id: string): Promise<void> {
  await getClient().http.post(`/tunnels/${id}/start`);
}

export async function stopTunnel(id: string): Promise<void> {
  await getClient().http.post(`/tunnels/${id}/stop`);
}

export async function reconnectTunnel(id: string): Promise<void> {
  await getClient().http.post(`/tunnels/${id}/reconnect`);
}

export async function getTunnelStatus(): Promise<TunnelRuntimeState[]> {
  const { data } = await getClient().http.get('/tunnels/status');
  return data;
}

export async function startAllTunnels(): Promise<void> {
  await getClient().http.post('/tunnels/start-all');
}

export async function stopAllTunnels(): Promise<void> {
  await getClient().http.post('/tunnels/stop-all');
}

// === Helpers ===

export function formatTunnelSpec(tunnel: { forward_type: PortForwardType; local_port: number; remote_host: string | null; remote_port: number | null }): string {
  switch (tunnel.forward_type) {
    case 'local':
      return `L :${tunnel.local_port} → ${tunnel.remote_host}:${tunnel.remote_port}`;
    case 'remote':
      return `R :${tunnel.remote_port} → localhost:${tunnel.local_port}`;
    case 'dynamic':
      return `D :${tunnel.local_port} SOCKS5`;
  }
}

export function formatUptime(secs: number | null): string {
  if (secs === null) return '';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
