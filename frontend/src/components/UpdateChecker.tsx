import { useState, useEffect, useCallback } from 'react';
import './UpdateChecker.css';

// Dynamic imports for Tauri plugins (only available in Tauri environment)
const getTauriModules = async () => {
  if (!('__TAURI_INTERNALS__' in window)) {
    return { check: null, relaunch: null };
  }
  const [updater, process] = await Promise.all([
    import('@tauri-apps/plugin-updater'),
    import('@tauri-apps/plugin-process'),
  ]);
  return { check: updater.check, relaunch: process.relaunch };
};

interface UpdateInfo {
  version: string;
  body: string;
  date: string;
}

interface DownloadProgress {
  total: number;
  downloaded: number;
}

export default function UpdateChecker() {
  const [updateAvailable, setUpdateAvailable] = useState<UpdateInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Check for updates on component mount
  useEffect(() => {
    let cancelled = false;
    const checkForUpdates = async () => {
      try {
        const { check } = await getTauriModules();
        if (cancelled || !check) return;

        const update = await check();
        if (cancelled) return;
        if (update) {
          setUpdateAvailable({
            version: update.version,
            body: update.body || 'Bug fixes and improvements',
            date: update.date || new Date().toISOString(),
          });
        }
      } catch (err) {
        if (!cancelled) console.warn('Update check failed:', err);
      }
    };

    // Delay check slightly to not impact startup
    const timer = setTimeout(checkForUpdates, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const installUpdate = useCallback(async () => {
    if (!updateAvailable) return;

    setDownloading(true);
    setError(null);
    setProgress({ total: 0, downloaded: 0 });

    try {
      const { check, relaunch } = await getTauriModules();
      if (!check || !relaunch) {
        throw new Error('Update not available in this environment');
      }

      const update = await check();
      if (!update) {
        throw new Error('Update no longer available');
      }

      // Download and install with progress tracking
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await update.downloadAndInstall((event: any) => {
        if (event.event === 'Started') {
          setProgress({ total: event.data.contentLength || 0, downloaded: 0 });
        } else if (event.event === 'Progress') {
          setProgress(prev => ({
            total: prev?.total || event.data.contentLength || 0,
            downloaded: (prev?.downloaded || 0) + (event.data.chunkLength || 0),
          }));
        } else if (event.event === 'Finished') {
          setProgress(prev => ({ ...prev!, downloaded: prev?.total || 0 }));
        }
      });

      // Relaunch app after successful install
      await relaunch();
    } catch (err) {
      console.error('Update install failed:', err);
      // Richer error-extraction chain than `getErrorMessage` models — the
      // additional arms cover string-thrown errors and `{message: ...}`
      // objects, both real shapes thrown by the Tauri updater plugin.
      // The first arm is the pattern banned by no-restricted-syntax;
      // disabling it on this one expression rather than wrapping the
      // chain in a less-readable helper.
      const message =
        // eslint-disable-next-line no-restricted-syntax
        err instanceof Error ? err.message :
        typeof err === 'string' ? err :
        err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) :
        `Update failed: ${JSON.stringify(err)}`;
      setError(message);
      setDownloading(false);
    }
  }, [updateAvailable]);

  const dismissUpdate = useCallback(() => {
    setDismissed(true);
  }, []);

  // Calculate progress percentage
  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.downloaded / progress.total) * 100)
    : 0;

  // Don't render if no update, dismissed, or not in Tauri
  if (!updateAvailable || dismissed) {
    return null;
  }

  return (
    <div className="update-banner" role="alert">
      <div className="update-content">
        <span className="update-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </span>
        <div className="update-text">
          <strong>Update Available</strong>
          <span>Version {updateAvailable.version} is ready to install</span>
        </div>
      </div>

      {downloading ? (
        <div className="update-progress">
          <div className="progress-bar-container">
            <div
              className="progress-bar-fill"
              style={{ width: `${progressPercent}%` }}
              role="progressbar"
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          <span className="progress-text">{progressPercent}%</span>
        </div>
      ) : (
        <div className="update-actions">
          <button
            onClick={installUpdate}
            className="update-button primary"
            disabled={downloading}
          >
            Install Now
          </button>
          <button
            onClick={dismissUpdate}
            className="update-button secondary"
          >
            Later
          </button>
        </div>
      )}

      {error && (
        <div className="update-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
