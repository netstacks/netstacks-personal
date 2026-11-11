// App mode - determines which backend to connect to
// - standalone: Personal Mode (Tauri Terminal + bundled Local Agent, single user)
// - enterprise: Controller-managed deployment (multi-user, talks to Controller)
export type AppMode = 'standalone' | 'enterprise';

// Persisted configuration
export interface AppConfig {
  // If set, app runs in Enterprise mode connecting to this Controller
  controllerUrl: string | null;
  // Display name for this controller instance (e.g., "DC1-Primary", "US-East")
  controllerName?: string | null;
}

// Default configuration: Personal Mode (no Controller URL).
export const DEFAULT_CONFIG: AppConfig = {
  controllerUrl: null,
};

// Error class for invalid controller URLs
export class ControllerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControllerUrlError';
  }
}
