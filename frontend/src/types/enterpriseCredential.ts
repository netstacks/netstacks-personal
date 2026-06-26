// Enterprise credential types (Controller API responses)

/**
 * Accessible credential summary - safe metadata only, no secrets.
 * Users see what credentials they can use, but never the actual passwords/keys.
 */
export interface AccessibleCredential {
  id: string;
  name: string;
  description: string | null;
  credential_type: 'ssh_password' | 'ssh_key' | 'api_token' | 'snmp_community' | 'generic_secret';
  username: string | null;
  host: string | null;
  port: number | null;
  vault_type: 'personal' | 'shared';
}
