// API client for enterprise profiles (Controller API, profile contract).
//
// Profile-by-reference is the single connect contract: the terminal always
// uses /profiles/accessible (+/default). Safe metadata only — never secrets.

import { getClient } from './client';
import type { AccessibleProfile } from '../types/enterpriseProfile';

/**
 * List all profiles the current user has access to.
 * Returns safe metadata only (name, auth_mode, transports, username) — never secrets.
 */
export async function listAccessibleProfiles(): Promise<AccessibleProfile[]> {
  const client = getClient();
  const res = await client.http.get('/profiles/accessible');
  return res.data.items;
}

/**
 * Get the user's default profile.
 * Returns null if the user has no accessible default profile.
 */
export async function getUserDefaultProfile(): Promise<AccessibleProfile | null> {
  const client = getClient();
  const res = await client.http.get('/profiles/accessible/default');
  return res.data;
}

/**
 * List of connect targets — always the AccessibleProfile contract
 * (/profiles/accessible).
 */
export async function loadConnectTargets(): Promise<AccessibleProfile[]> {
  return listAccessibleProfiles();
}

/**
 * Default connect target — always the AccessibleProfile contract
 * (/profiles/accessible/default).
 */
export async function getDefaultConnectTarget(): Promise<AccessibleProfile | null> {
  return getUserDefaultProfile();
}
