//! Repository for AI Engineer Profile CRUD operations.

use sqlx::SqlitePool;
use std::collections::HashMap;

use crate::ai::profile::AiEngineerProfile;

/// Get the AI engineer profile (there is at most one row).
pub async fn get_profile(pool: &SqlitePool) -> Result<Option<AiEngineerProfile>, sqlx::Error> {
    let row = sqlx::query_as::<_, ProfileRow>(
        "SELECT * FROM ai_engineer_profile LIMIT 1"
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| r.into()))
}

/// Create or update the AI engineer profile.
pub async fn upsert_profile(pool: &SqlitePool, profile: &AiEngineerProfile) -> Result<(), sqlx::Error> {
    let vendor_weights = serde_json::to_string(&profile.vendor_weights).unwrap_or_default();
    let domain_focus = serde_json::to_string(&profile.domain_focus).unwrap_or_default();
    let safety_rules = serde_json::to_string(&profile.safety_rules).unwrap_or_default();

    sqlx::query(
        "INSERT OR REPLACE INTO ai_engineer_profile
            (id, name, behavior_mode, autonomy_level, vendor_weights, domain_focus,
             cert_perspective, verbosity, risk_tolerance, troubleshooting_method,
             syntax_style, user_experience_level, environment_type, safety_rules,
             communication_style, onboarding_completed, updated_at)
         VALUES
            (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, CURRENT_TIMESTAMP)"
    )
    .bind(&profile.name)
    .bind(&profile.behavior_mode)
    .bind(&profile.autonomy_level)
    .bind(&vendor_weights)
    .bind(&domain_focus)
    .bind(&profile.cert_perspective)
    .bind(&profile.verbosity)
    .bind(&profile.risk_tolerance)
    .bind(&profile.troubleshooting_method)
    .bind(&profile.syntax_style)
    .bind(&profile.user_experience_level)
    .bind(&profile.environment_type)
    .bind(&safety_rules)
    .bind(&profile.communication_style)
    .bind(profile.onboarding_completed)
    .execute(pool)
    .await?;

    Ok(())
}

/// Delete the profile (for re-onboarding).
pub async fn delete_profile(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM ai_engineer_profile").execute(pool).await?;
    Ok(())
}

/// Check if a profile exists and onboarding is complete.
pub async fn is_onboarded(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
    // SQLite stores booleans as 0/1 integers; query as i32 for compatibility
    let row = sqlx::query_scalar::<_, i32>(
        "SELECT CAST(onboarding_completed AS INTEGER) FROM ai_engineer_profile LIMIT 1"
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.unwrap_or(0) != 0)
}

// Internal row type for sqlx mapping
#[derive(sqlx::FromRow)]
struct ProfileRow {
    id: i64,
    name: Option<String>,
    behavior_mode: Option<String>,
    autonomy_level: Option<String>,
    vendor_weights: Option<String>,
    domain_focus: Option<String>,
    cert_perspective: Option<String>,
    verbosity: Option<String>,
    risk_tolerance: Option<String>,
    troubleshooting_method: Option<String>,
    syntax_style: Option<String>,
    user_experience_level: Option<String>,
    environment_type: Option<String>,
    safety_rules: Option<String>,
    communication_style: Option<String>,
    onboarding_completed: bool,
}

impl From<ProfileRow> for AiEngineerProfile {
    fn from(row: ProfileRow) -> Self {
        let vendor_weights: HashMap<String, f64> = row.vendor_weights
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let domain_focus: HashMap<String, f64> = row.domain_focus
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let safety_rules: Vec<String> = row.safety_rules
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        AiEngineerProfile {
            id: row.id,
            name: row.name,
            behavior_mode: row.behavior_mode,
            autonomy_level: row.autonomy_level,
            vendor_weights,
            domain_focus,
            cert_perspective: row.cert_perspective,
            verbosity: row.verbosity,
            risk_tolerance: row.risk_tolerance,
            troubleshooting_method: row.troubleshooting_method,
            syntax_style: row.syntax_style,
            user_experience_level: row.user_experience_level,
            environment_type: row.environment_type,
            safety_rules,
            communication_style: row.communication_style,
            onboarding_completed: row.onboarding_completed,
        }
    }
}
