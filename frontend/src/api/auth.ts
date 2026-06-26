import axios from 'axios';
import { getClient } from './client';
import type {
  LoginRequest,
  LoginResponse,
  RefreshRequest,
  RefreshResponse,
  User,
} from '../types/auth';

/**
 * Log in with email and password.
 * Returns tokens and user info on success.
 */
export async function login(request: LoginRequest): Promise<LoginResponse> {
  const client = getClient();
  const response = await client.http.post<LoginResponse>('/auth/login', request);
  return response.data;
}

/**
 * Refresh access token using refresh token.
 * Uses a plain axios call to avoid triggering the 401 interceptor
 * (which would cause an infinite refresh loop).
 */
export async function refreshToken(request: RefreshRequest): Promise<RefreshResponse> {
  const client = getClient();
  const response = await axios.post<RefreshResponse>(
    `${client.http.defaults.baseURL}/auth/refresh`,
    request,
    { headers: { 'Content-Type': 'application/json' } }
  );
  return response.data;
}

/**
 * Log out and invalidate tokens.
 */
export async function logout(): Promise<void> {
  try {
    const client = getClient();
    await client.http.post('/auth/logout');
  } catch (error) {
    // Logout should succeed locally even if server call fails
    console.warn('[auth] Server logout failed, continuing local logout:', error);
  }
}

/**
 * Get current user info.
 * Requires valid access token.
 */
export async function getCurrentUser(): Promise<User> {
  const client = getClient();
  const response = await client.http.get<User>('/auth/me');
  return response.data;
}

/**
 * List available auth providers.
 * Can be called without authentication.
 */
export interface AuthProvider {
  type: 'local' | 'oidc' | 'ldap';
  name: string;
  enabled: boolean;
}

export async function getAuthProviders(): Promise<AuthProvider[]> {
  const client = getClient();
  // Controller returns { providers: [{ name, enabled }] } (no `type` field;
  // `name` is the type: 'local' | 'ldap' | 'oidc'). Tolerate a raw array too.
  const { data } = await client.http.get<
    { providers?: Array<{ name: string; enabled: boolean }> } | Array<{ name: string; enabled: boolean }>
  >('/auth/providers');
  const raw = Array.isArray(data) ? data : (data?.providers ?? []);
  return raw.map((p) => ({
    type: (p.name === 'oidc' || p.name === 'ldap' ? p.name : 'local') as AuthProvider['type'],
    name: p.name,
    enabled: p.enabled,
  }));
}
