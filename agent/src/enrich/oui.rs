//! IEEE OUI vendor database — seeds from `https://standards-oui.ieee.org/oui/oui.csv`
//! on first agent start (and every ~30 days thereafter). Persisted in the
//! `oui_vendors` SQLite table so lookups are local + instant.
//!
//! The hover-popup `oui_vendor` source consults this table first; cache miss
//! falls back to macvendors.com (which gets cached into the same table for
//! next time). Net effect: macvendors.com is hit only for OUIs the IEEE
//! registry doesn't know about, which usually means rate limits stop being
//! a problem entirely.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::providers::DataProvider;

const OUI_CSV_URL: &str = "https://standards-oui.ieee.org/oui/oui.csv";
const REFRESH_AFTER_DAYS: i64 = 30;
const SETTING_LAST_REFRESH: &str = "oui.last_refreshed_at";

/// Kick off the OUI vendor table maintenance task on agent startup. Returns
/// immediately — the actual download/import runs in the background. Safe to
/// call on every start: if the table is fresh, this is a no-op.
pub fn spawn_refresh(provider: Arc<dyn DataProvider>) {
    tokio::spawn(async move {
        tracing::info!("oui: background refresh task started");
        match maybe_refresh(provider).await {
            Ok(MaintenanceResult::Skipped { reason }) => {
                tracing::info!(reason = %reason, "oui: table is fresh — refresh skipped");
            }
            Ok(MaintenanceResult::Refreshed { count, duration_ms }) => {
                tracing::info!(count, duration_ms, "oui: vendor table refreshed from IEEE CSV");
            }
            Err(e) => {
                // Non-fatal — agent continues using the API fallback per-lookup.
                tracing::warn!(error = %e, "oui: background refresh failed; falling back to macvendors.com API per-request");
            }
        }
    });
}

enum MaintenanceResult {
    Skipped { reason: String },
    Refreshed { count: usize, duration_ms: u64 },
}

async fn maybe_refresh(provider: Arc<dyn DataProvider>) -> Result<MaintenanceResult, String> {
    let row_count = provider
        .oui_count()
        .await
        .map_err(|e| format!("oui_count: {}", e))?;
    tracing::info!(row_count, "oui: current table size");

    let needs_refresh = if row_count == 0 {
        tracing::info!("oui: table is empty — initial seed from IEEE CSV required");
        true
    } else {
        // Read the last-refreshed timestamp from settings; stale if missing or > 30d.
        let last = provider
            .get_setting(SETTING_LAST_REFRESH)
            .await
            .map_err(|e| format!("get_setting: {}", e))?;
        match last.as_str() {
            None => { tracing::info!("oui: no last-refresh timestamp — will refresh"); true }
            Some("") => { tracing::info!("oui: empty last-refresh timestamp — will refresh"); true }
            Some(s) => match DateTime::parse_from_rfc3339(s) {
                Ok(ts) => {
                    let age = Utc::now().signed_duration_since(ts.with_timezone(&Utc));
                    let days = age.num_days();
                    tracing::info!(days_since_refresh = days, threshold = REFRESH_AFTER_DAYS, "oui: checking refresh age");
                    days >= REFRESH_AFTER_DAYS
                }
                Err(e) => {
                    tracing::warn!(error = %e, "oui: couldn't parse last-refresh timestamp — will refresh");
                    true
                }
            },
        }
    };

    if !needs_refresh {
        return Ok(MaintenanceResult::Skipped {
            reason: format!("{} rows present and refreshed within {} days", row_count, REFRESH_AFTER_DAYS),
        });
    }

    let started = std::time::Instant::now();
    tracing::info!(url = OUI_CSV_URL, "oui: fetching IEEE CSV (this may take a few seconds)");
    let entries = fetch_and_parse_csv().await?;
    tracing::info!(parsed_rows = entries.len(), "oui: CSV parsed, beginning bulk upsert");
    let count = provider
        .oui_bulk_upsert(&entries)
        .await
        .map_err(|e| format!("oui_bulk_upsert: {}", e))?;
    provider
        .set_setting(SETTING_LAST_REFRESH, serde_json::Value::String(Utc::now().to_rfc3339()))
        .await
        .map_err(|e| format!("set_setting: {}", e))?;
    Ok(MaintenanceResult::Refreshed {
        count,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// Download and parse the IEEE OUI CSV. Returns `(prefix, vendor, registry)`
/// tuples ready for bulk upsert. The CSV is ~7 MB / ~30k rows.
async fn fetch_and_parse_csv() -> Result<Vec<(String, String, String)>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {}", e))?;

    let body = client
        .get(OUI_CSV_URL)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?
        .error_for_status()
        .map_err(|e| format!("upstream: {}", e))?
        .text()
        .await
        .map_err(|e| format!("read body: {}", e))?;

    parse_csv(&body)
}

/// Parse the IEEE OUI CSV. Header row: `Registry,Assignment,Organization Name,Organization Address`.
/// `Assignment` is the prefix (uppercase hex, no separators). For MA-M and MA-S
/// registries the assignment is longer than 6 chars — we still key by the first
/// 6 (MA-L granularity) since that's what a MAC's first 3 octets give us.
fn parse_csv(body: &str) -> Result<Vec<(String, String, String)>, String> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_reader(body.as_bytes());

    let mut out = Vec::with_capacity(35_000);
    for record in rdr.records() {
        let r = record.map_err(|e| format!("csv parse: {}", e))?;
        let registry = r.get(0).unwrap_or("").trim().to_string();
        let assignment = r.get(1).unwrap_or("").trim().to_uppercase();
        let vendor = r.get(2).unwrap_or("").trim().to_string();
        if assignment.len() < 6 || vendor.is_empty() {
            continue;
        }
        // Key by the first 6 hex chars (MA-L equivalent). Longer assignments
        // (MA-M, MA-S) become the same key as their MA-L parent — last write
        // wins, which is fine since the parent vendor is the right answer for
        // a hover lookup that only has 3 octets to go on.
        let prefix = assignment[..6].to_string();
        out.push((prefix, vendor, registry));
    }
    Ok(out)
}

/// Extract the OUI prefix from a MAC string in any common format.
/// Returns the first 3 octets as 6 uppercase hex chars, or None if invalid.
pub fn oui_prefix_from_mac(mac: &str) -> Option<String> {
    let cleaned: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if cleaned.len() != 12 {
        return None;
    }
    Some(cleaned[..6].to_uppercase())
}

/// Check the U/L bit (2nd-least-significant bit of the first octet).
/// Locally-administered MACs (randomized / VM / container) have no IEEE
/// vendor — skip the API entirely.
pub fn is_locally_administered(mac: &str) -> bool {
    let cleaned: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if cleaned.len() < 2 {
        return false;
    }
    u8::from_str_radix(&cleaned[..2], 16)
        .map(|b| (b & 0x02) != 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_csv_basic() {
        let body = "Registry,Assignment,Organization Name,Organization Address\n\
                    MA-L,002F00,Aprilaire,500 Hwy 78 W\n\
                    MA-L,005056,VMware Inc.,\"3401 Hillview, Palo Alto\"\n";
        let out = parse_csv(body).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], ("002F00".to_string(), "Aprilaire".to_string(), "MA-L".to_string()));
        assert_eq!(out[1].0, "005056");
        assert!(out[1].1.starts_with("VMware"));
    }

    #[test]
    fn oui_prefix_handles_separators() {
        assert_eq!(oui_prefix_from_mac("00:50:56:b3:07:42").as_deref(), Some("005056"));
        assert_eq!(oui_prefix_from_mac("00-50-56-b3-07-42").as_deref(), Some("005056"));
        assert_eq!(oui_prefix_from_mac("0050.56b3.0742").as_deref(), Some("005056"));
        assert_eq!(oui_prefix_from_mac("not a mac"), None);
    }

    #[test]
    fn locally_administered_detection() {
        // 0x02 = 00000010 — U/L bit set
        assert!(is_locally_administered("02:00:01:00:00:09"));
        assert!(is_locally_administered("06:aa:bb:cc:dd:ee"));
        assert!(is_locally_administered("0a:bb:cc:dd:ee:ff"));
        // 0x00 = 00000000 — vendor-assigned
        assert!(!is_locally_administered("00:50:56:b3:07:42"));
        // 0x01 = 00000001 — multicast bit set, U/L bit not set
        assert!(!is_locally_administered("01:00:5e:00:00:01"));
    }
}
