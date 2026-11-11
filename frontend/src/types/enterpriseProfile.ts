// Enterprise profile types (Controller API responses)
//
// Profile-by-reference auth contract (Phase 8). Mirrors the Controller's
// `routes/profile_access_api.rs` `AccessibleProfile` struct EXACTLY.
// Metadata only — never any secret bytes.

/**
 * Accessible profile summary — safe metadata only, no secrets.
 *
 * Shape MUST match the Controller `AccessibleProfile` (profile_access_api.rs):
 * - `profile_type`: profiles.profile_type (`personal` | `shared` | `service`)
 * - `auth_mode`: highest-priority SSH-capable secret_type
 *   (`certificate` > `ssh_key` > `password`), or `none`
 * - `transports`: distinct secret_types present, in resolution order
 * - `host`: always null in the current contract (profiles are device-anchored)
 */
export interface AccessibleProfile {
  id: string;
  name: string;
  description: string | null;
  profile_type: 'personal' | 'shared' | 'service';
  username: string | null;
  auth_mode: 'certificate' | 'ssh_key' | 'password' | 'none';
  transports: string[];
  host: string | null;
  port: number | null;
  is_default: boolean;
}
