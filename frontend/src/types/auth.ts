/**
 * User entity from Controller.
 * Matches the API response format.
 */
export interface User {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  auth_provider: 'local' | 'oidc' | 'ldap';
  is_active: boolean;
  created_at: string;
  last_login: string | null;
  /** Active organization (differs from home_org_id while a platform admin has switched context) */
  org_id?: string;
  /** The user's real organization */
  home_org_id?: string;
  /** Platform super-admin: may list organizations and switch the active org */
  is_platform_admin?: boolean;
  roles?: string[];
  permissions?: string[];
}

/** Organization summary from GET /admin/organizations (platform admins only). */
export interface OrganizationSummary {
  id: string;
  name: string;
}

/** Response from POST /auth/switch-org: a re-minted access token for the target org. */
export interface SwitchOrgResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  active_org_id: string;
}

/**
 * Login request payload.
 * Uses 'username' to match Controller API.
 */
export interface LoginRequest {
  username: string;
  password: string;
  /** Optional OpenSSH public key for SSH certificate auto-signing */
  public_key?: string;
  /** Client type: "terminal" consumes a license seat, "admin_ui" does not */
  client_type?: string;
}

/** Signed SSH certificate info included in login response */
export interface SignedCertInfo {
  certificate: string;
  ca_public_key: string;
  valid_after: string;
  valid_before: string;
  serial: number;
}

/**
 * Login response from Controller.
 */
export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: User;
  /** SSH certificate (present if public_key was provided in login request) */
  ssh_certificate?: SignedCertInfo;
}

/**
 * Token refresh request.
 */
export interface RefreshRequest {
  refresh_token: string;
}

/**
 * Token refresh response.
 */
export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
}

/**
 * Auth tokens stored in state.
 */
export interface AuthTokens {
  accessToken: string | null;
  refreshToken: string | null;
}

/**
 * Auth state interface for the store.
 */
export interface AuthState {
  // Tokens
  accessToken: string | null;
  refreshToken: string | null;

  // User info
  user: User | null;

  // SSH certificate info (enterprise mode, from login response)
  certInfo: SignedCertInfo | null;

  // State flags
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  doRefreshToken: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
  setUser: (user: User) => void;
  setCertInfo: (certInfo: SignedCertInfo | null) => void;

  /**
   * Bumped whenever the session's active organization changes. AuthProvider
   * keys the app subtree on it so every org-scoped view remounts and refetches.
   */
  sessionEpoch: number;
  /**
   * Switch the active organization (platform admins only). Re-mints the access
   * token for `orgId`, refreshes user + capabilities, then bumps sessionEpoch.
   * `beforeRemount` runs after the token switch and before the remount (used
   * to drop cached queries so nothing from the previous org survives).
   */
  switchOrg: (orgId: string, beforeRemount?: () => void) => Promise<void>;
}
