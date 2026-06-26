//! Per-tab scratch directories for loose-file LSP sessions.
//!
//! When a Monaco editor opens a file without a workspace (e.g. a one-off
//! `.py` from DocumentTabEditor), the LSP needs *some* directory to use
//! as its project root. We create a per-session UUID temp dir under
//! `{dataDir}/lsp/scratch/{uuid}/` so the LSP sees a stable root.
//!
//! Scratch dirs are cleaned up on session disconnect (via the LspHost's
//! session map). If the agent crashed mid-session, the next agent startup
//! sweeps anything older than 24h.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const SCRATCH_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60); // 24h

/// Construct the per-session scratch dir path. Does not create the dir.
pub fn scratch_dir_for(data_dir: &Path, session_id: &str) -> PathBuf {
    data_dir.join("lsp").join("scratch").join(session_id)
}

/// Create the scratch dir if it doesn't exist. Returns the path.
pub fn ensure_scratch_dir(data_dir: &Path, session_id: &str) -> std::io::Result<PathBuf> {
    let dir = scratch_dir_for(data_dir, session_id);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Delete a single scratch dir. Errors are logged but not returned —
/// best-effort cleanup.
pub fn remove_scratch_dir(data_dir: &Path, session_id: &str) {
    let dir = scratch_dir_for(data_dir, session_id);
    if let Err(e) = fs::remove_dir_all(&dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(path = %dir.display(), error = %e, "remove_scratch_dir failed");
        }
    }
}

/// Sweep scratch dirs older than SCRATCH_MAX_AGE. Called on agent startup.
pub fn sweep_stale_scratch_dirs(data_dir: &Path) {
    let scratch_root = data_dir.join("lsp").join("scratch");
    let entries = match fs::read_dir(&scratch_root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            tracing::warn!(error = %e, "sweep_stale_scratch_dirs: read_dir failed");
            return;
        }
    };
    let now = SystemTime::now();
    let mut swept = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else { continue };
        let Ok(modified) = metadata.modified() else { continue };
        let Ok(age) = now.duration_since(modified) else { continue };
        if age >= SCRATCH_MAX_AGE {
            if let Err(e) = fs::remove_dir_all(&path) {
                tracing::warn!(path = %path.display(), error = %e, "sweep: remove failed");
            } else {
                swept += 1;
            }
        }
    }
    if swept > 0 {
        tracing::info!("Swept {} stale LSP scratch directories", swept);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn ensure_and_remove_scratch_dir() {
        let tmp = tempdir().unwrap();
        let path = ensure_scratch_dir(tmp.path(), "test-uuid").unwrap();
        assert!(path.exists());
        assert!(path.is_dir());
        remove_scratch_dir(tmp.path(), "test-uuid");
        assert!(!path.exists());
    }

    #[test]
    fn sweep_handles_missing_root_gracefully() {
        let tmp = tempdir().unwrap();
        // Don't create any scratch root — should not panic
        sweep_stale_scratch_dirs(tmp.path());
    }
}
