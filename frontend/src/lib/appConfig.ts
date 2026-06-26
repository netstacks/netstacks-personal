import type { AppConfig, AppMode } from '../types/config';
import { DEFAULT_CONFIG, ControllerUrlError } from '../types/config';

import { logger } from './logger'
const CONFIG_FILE = 'app-config.json';

let cachedConfig: AppConfig | null = null;

/**
 * Validate and normalize a controller URL.
 * - Strips trailing slashes to prevent double-slash in paths
 * - Validates URL is parseable
 * - Validates scheme is http or https
 * - Warns if scheme is http (not https)
 *
 * @returns Cleaned URL string
 * @throws ControllerUrlError if URL is invalid
 */
export function validateControllerUrl(url: string): string {
  // Strip trailing slashes
  const cleaned = url.replace(/\/+$/, '');

  // Validate URL is parseable
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new ControllerUrlError(
      `Invalid controller URL: "${url}" — URL must be a valid absolute URL (e.g., https://controller.example.com)`
    );
  }

  // Validate scheme
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ControllerUrlError(
      `Invalid controller URL scheme: "${parsed.protocol}" — only http: and https: are supported`
    );
  }

  // Controller requires HTTPS — auto-upgrade http URLs
  if (parsed.protocol === 'http:') {
    console.warn(
      '[appConfig] Controller URL uses http:// — upgrading to https:// (Controller requires TLS)'
    );
    return cleaned.replace(/^http:/, 'https:');
  }

  return cleaned;
}

/**
 * Check if we're running in a Tauri environment.
 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Try to read config directly from filesystem.
 * This is a fallback when Tauri store doesn't work.
 */
async function readConfigFromFs(): Promise<AppConfig | null> {
  logger.log('[appConfig] Attempting to read config from filesystem...');
  try {
    const pathModule = await import('@tauri-apps/api/path');
    const dataDir = await pathModule.appDataDir();
    // Use join for proper path separator handling
    const configPath = await pathModule.join(dataDir, CONFIG_FILE);

    logger.log('[appConfig] Config path:', configPath);

    // Try to import fs plugin
    let fsModule;
    try {
      fsModule = await import('@tauri-apps/plugin-fs');
    } catch (fsImportError) {
      console.warn('[appConfig] fs plugin not available:', fsImportError);
      return null;
    }

    const fileExists = await fsModule.exists(configPath);
    if (!fileExists) {
      logger.log('[appConfig] Config file does not exist at path');
      return null;
    }

    const content = await fsModule.readTextFile(configPath);
    logger.log('[appConfig] Read config file content:', content);

    const parsed = JSON.parse(content);
    logger.log('[appConfig] Parsed config:', parsed);

    let controllerUrl: string | null = parsed.controllerUrl ?? null;
    if (controllerUrl) {
      try {
        controllerUrl = validateControllerUrl(controllerUrl);
      } catch (e) {
        console.error('[appConfig] Invalid controllerUrl from filesystem, falling back to standalone mode:', e);
        controllerUrl = null;
      }
    }

    return { controllerUrl };
  } catch (error) {
    console.warn('[appConfig] Failed to read config from fs:', error);
    return null;
  }
}

/**
 * Try to fetch config from a static file in the public folder.
 * This enables browser-based testing of Enterprise mode.
 */
async function fetchConfigFromPublic(): Promise<AppConfig | null> {
  try {
    const response = await fetch('/app-config.json');
    if (!response.ok) {
      return null;
    }
    const parsed = await response.json();
    logger.log('[appConfig] Loaded config from public folder:', parsed);

    let controllerUrl: string | null = parsed.controllerUrl ?? null;
    if (controllerUrl) {
      try {
        controllerUrl = validateControllerUrl(controllerUrl);
      } catch (e) {
        console.error('[appConfig] Invalid controllerUrl from public config, falling back to standalone mode:', e);
        controllerUrl = null;
      }
    }

    return { controllerUrl };
  } catch {
    return null;
  }
}

/**
 * Load app configuration from persistent storage.
 * Returns cached config if already loaded.
 */
export async function loadAppConfig(): Promise<AppConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  // If not in Tauri, try to load from public folder first (for dev/testing)
  if (!isTauri()) {
    logger.log('[appConfig] Not in Tauri environment, checking for config file...');

    // If served from a controller at /terminal/, the controller is the origin
    if (window.location.pathname.startsWith('/terminal')) {
      cachedConfig = { controllerUrl: window.location.origin };
      logger.log('[appConfig] Detected web client mode, controller is origin');
      return cachedConfig;
    }

    const publicConfig = await fetchConfigFromPublic();
    if (publicConfig) {
      cachedConfig = publicConfig;
      return cachedConfig;
    }
    logger.log('[appConfig] No config file found, using defaults (standalone mode)');
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }

  // Try reading directly from filesystem first (our manual config)
  const fsConfig = await readConfigFromFs();
  if (fsConfig) {
    logger.log('[appConfig] Loaded config from filesystem:', fsConfig);
    cachedConfig = fsConfig;
    return cachedConfig;
  }

  // Try Tauri store as fallback
  try {
    const { load } = await import('@tauri-apps/plugin-store');

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Store load timeout')), 3000);
    });

    const store = await Promise.race([
      load(CONFIG_FILE, { autoSave: false, defaults: {} }),
      timeoutPromise,
    ]);

    let controllerUrl: string | null = await store.get<string>('controllerUrl') ?? null;
    if (controllerUrl) {
      try {
        controllerUrl = validateControllerUrl(controllerUrl);
      } catch (e) {
        console.error('[appConfig] Invalid controllerUrl from store, falling back to standalone mode:', e);
        controllerUrl = null;
      }
    }

    cachedConfig = { controllerUrl };

    logger.log('[appConfig] Loaded config from store:', cachedConfig);
    return cachedConfig;
  } catch (error) {
    console.warn('[appConfig] Failed to load config, using defaults:', error);
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }
}

/**
 * Save app configuration to persistent storage.
 * Requires app restart for mode changes to take effect.
 */
export async function saveAppConfig(config: Partial<AppConfig>): Promise<void> {
  if (!isTauri()) {
    console.warn('[appConfig] Not in Tauri environment, cannot save config');
    return;
  }

  // Validate controllerUrl before saving
  if (config.controllerUrl !== undefined && config.controllerUrl !== null) {
    config = { ...config, controllerUrl: validateControllerUrl(config.controllerUrl) };
  }

  try {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load(CONFIG_FILE, { autoSave: false, defaults: {} });

    if (config.controllerUrl !== undefined) {
      if (config.controllerUrl === null) {
        await store.delete('controllerUrl');
      } else {
        await store.set('controllerUrl', config.controllerUrl);
      }
    }

    await store.save();

    // Update cache
    if (cachedConfig) {
      cachedConfig = { ...cachedConfig, ...config };
    }

    logger.log('[appConfig] Saved config:', config);
  } catch (error) {
    console.error('[appConfig] Failed to save config:', error);
    throw error;
  }
}

/**
 * Clear cached configuration (for testing or reset scenarios).
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

/**
 * Get the current app mode based on configuration.
 */
export function getAppMode(config: AppConfig): AppMode {
  return config.controllerUrl ? 'enterprise' : 'standalone';
}
