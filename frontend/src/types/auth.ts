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
  org_id?: string;
  roles?: string[];
  permissions?: string[];
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
}
