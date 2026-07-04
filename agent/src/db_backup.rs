//! Whole-database export/import for the Backup & Seed feature.
//!
//! Export copies the entire SQLite database with `VACUUM INTO` (a clean,
//! consistent snapshot — captures every table, configured or not). A "shareable"
//! export then strips all secret material so the file is safe to hand out; the
//! importer sets a master password and re-enters secrets in Settings.
//!
//! Import validates the chosen file and stages it next to the live DB as
//! `<db>.incoming`; `db::init_db` swaps it in on the next startup (the only safe
//! time to replace an open SQLite file). See
//! docs/CONFIG-SEED-BACKUP.md.

use chrono::Utc;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use std::path::Path;
use std::str::FromStr;

/// Copy the live DB to `dest`. When `include_vault` is false, strip all secret
/// material (the importer re-enters secrets). `dest` is a user-chosen filesystem
/// path from a native save dialog.
pub async fn export_db(pool: &SqlitePool, dest: &str, include_vault: bool) -> Result<(), String> {
    // VACUUM INTO refuses to overwrite — remove any file the user chose to replace.
    let _ = std::fs::remove_file(dest);

    // No bind param for the destination in VACUUM INTO; escape the single quotes.
    let sql = format!("VACUUM INTO '{}'", dest.replace('\'', "''"));
    sqlx::query(&sql)
        .execute(pool)
        .await
        .map_err(|e| format!("export failed: {e}"))?;

    if !include_vault {
        zeroize_vault(dest).await?;
    }

    // The export still contains config (and, for a full backup, secrets) — keep it
    // private like the live DB.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Remove every piece of secret material from an exported copy so it is safe to
/// share. The core secret tables MUST be cleared (errors propagate); inline/optional
/// columns are best-effort (ignored if a table/column is absent in this schema).
async fn zeroize_vault(dest: &str) -> Result<(), String> {
    let url = format!("sqlite:{dest}?mode=rw");
    let opts = SqliteConnectOptions::from_str(&url).map_err(|e| e.to_string())?;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .map_err(|e| format!("open export for zeroize failed: {e}"))?;

    // Dedicated secret stores — must succeed, or we refuse to call the file safe.
    for stmt in [
        "DELETE FROM credentials",              // per-session credentials
        "DELETE FROM profile_credentials",      // SSH passwords / key passphrases
        "DELETE FROM api_keys",                 // AI provider keys, etc.
        "DELETE FROM api_resource_credentials", // integration tokens
        "DELETE FROM vault_config",             // master-password verifier
    ] {
        if let Err(e) = sqlx::query(stmt).execute(&pool).await {
            pool.close().await;
            return Err(format!("zeroize '{stmt}' failed: {e}"));
        }
    }

    // Inline secret columns / optional tables — best-effort.
    for stmt in [
        "UPDATE documents SET encrypted_content=NULL WHERE encrypted_content IS NOT NULL",
        "UPDATE document_versions SET encrypted_content=NULL WHERE encrypted_content IS NOT NULL",
        "UPDATE mcp_servers SET auth_token_encrypted=NULL WHERE auth_token_encrypted IS NOT NULL",
        "UPDATE mcp_servers SET auth_token=NULL WHERE auth_token IS NOT NULL",
    ] {
        let _ = sqlx::query(stmt).execute(&pool).await;
    }

    // Reclaim space so deleted blobs don't linger in free pages of the shared file.
    let _ = sqlx::query("VACUUM").execute(&pool).await;
    pool.close().await;
    Ok(())
}

/// Backup the live DB (timestamped) then stage an empty file as `<db>.incoming`.
/// On the next startup, `init_db` swaps in the empty file, SQLite creates a fresh
/// database, and all migrations run — effectively a factory reset.
pub async fn stage_reset(pool: &SqlitePool, db_path: &Path) -> Result<(), String> {
    // Backup current DB first so the user can roll back manually.
    let ts = Utc::now().format("%Y%m%d-%H%M%S");
    let mut backup = sibling(db_path, &format!(".bak-{ts}"));
    let mut n = 1u32;
    while backup.exists() {
        backup = sibling(db_path, &format!(".bak-{ts}-{n}"));
        n += 1;
    }
    export_db(pool, &backup.to_string_lossy(), true).await?;

    // An empty file staged as .incoming causes init_db to open a fresh SQLite
    // database (SQLite creates the file header on first write) then run all
    // migrations — identical to a first-time install.
    let incoming = sibling(db_path, ".incoming");
    std::fs::write(&incoming, []).map_err(|e| format!("staging reset failed: {e}"))?;
    Ok(())
}

/// Persist a user-chosen DB path to the config file so `resolve_db_path` picks
/// it up on the next startup. Also VACUUM INTO the new location so the user
/// doesn't lose their current data when they restart.
pub async fn move_db(pool: &SqlitePool, new_path: &Path) -> Result<(), String> {
    // Ensure the parent directory exists.
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create directory: {e}"))?;
    }
    // Copy current DB to the new path (full backup with vault).
    export_db(pool, &new_path.to_string_lossy(), true).await?;
    // Write the config file so the agent uses the new path on next startup.
    let cfg = crate::db::config_file_path();
    let content = serde_json::json!({ "db_path": new_path.to_string_lossy() }).to_string();
    std::fs::write(&cfg, content).map_err(|e| format!("failed to write config: {e}"))?;
    Ok(())
}

/// Clear any custom DB path from the config file, reverting to the default.
pub fn clear_db_path_config() -> Result<(), String> {
    let cfg = crate::db::config_file_path();
    if cfg.exists() {
        std::fs::remove_file(&cfg).map_err(|e| format!("failed to clear config: {e}"))?;
    }
    Ok(())
}

fn sibling(db_path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut p = db_path.as_os_str().to_owned();
    p.push(suffix);
    std::path::PathBuf::from(p)
}

/// Validate `src` is a NetStacks SQLite database and stage it as `<db>.incoming`
/// next to the live DB. `db::init_db` applies it on the next startup.
pub async fn validate_and_stage(db_path: &Path, src: &str) -> Result<(), String> {
    if !Path::new(src).exists() {
        return Err(format!("file not found: {src}"));
    }

    // Open read-only and sanity-check the schema before trusting it.
    let url = format!("sqlite:{src}?mode=ro");
    let opts = SqliteConnectOptions::from_str(&url).map_err(|e| e.to_string())?;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .map_err(|_| "not a valid SQLite database".to_string())?;

    for t in ["settings", "credential_profiles", "sessions"] {
        let q = format!("SELECT 1 FROM {t} LIMIT 1");
        if sqlx::query(&q).fetch_optional(&pool).await.is_err() {
            pool.close().await;
            return Err(format!("not a NetStacks database (missing table '{t}')"));
        }
    }
    pool.close().await;

    let incoming = {
        let mut p = db_path.as_os_str().to_owned();
        p.push(".incoming");
        std::path::PathBuf::from(p)
    };
    std::fs::copy(src, &incoming).map_err(|e| format!("staging import failed: {e}"))?;
    Ok(())
}
