// Type declarations for Tauri globals

interface Window {
  __TAURI__?: {
    // Tauri internals - presence indicates running in Tauri
    [key: string]: unknown;
  };
  __TAURI_INTERNALS__?: {
    // Tauri v2 internals - presence indicates running in Tauri
    [key: string]: unknown;
  };
}
