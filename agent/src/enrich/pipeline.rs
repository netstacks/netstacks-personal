//! Enrichment pipeline — executes the source list for a matched token in
//! parallel and aggregates the results.
//!
//! Each source maps to a function that returns `serde_json::Value`. Errors
//! are swallowed per-source (logged as warnings) so one broken integration
//! doesn't ruin the whole enrichment.

use crate::api::AppState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// Output of `Pipeline::run` — per-source enrichment payloads plus any
/// per-source errors (rate limits, network failures, etc). "Not found"
/// outcomes stay out of both maps.
#[derive(Debug, Default, Clone)]
pub struct PipelineOutput {
    pub sources: HashMap<String, Value>,
    pub errors: HashMap<String, String>,
}

/// Session context passed through to per-source executors. Lets port/interface
/// queries resolve the "which device am I on" question that a bare token like
/// "Gi0/1" can't answer on its own.
#[derive(Debug, Clone)]
pub struct SessionContext {
    pub host: String,
    pub name: String,
}

/// Phase 5: source availability is now determined from the DB-loaded
/// `enrichment_sources` cache. A source is available if it's a builtin
/// OR it's an api_resource with a non-null `api_resource_id` configured.
/// The legacy `netstacks_crawler_sources` / `netbox_sources` tables are
/// no longer consulted for enrichment.
pub struct ActiveSources;

impl ActiveSources {
    pub async fn detect(_state: &AppState) -> Self { Self }

    pub fn source_available_from_cache(
        sources: &std::collections::HashMap<String, crate::models::EnrichmentSource>,
        source_name: &str,
    ) -> bool {
        match sources.get(source_name) {
            Some(src) if src.kind == "builtin" => true,
            Some(src) => src.api_resource_id.is_some(),
            None => false,
        }
    }
}

pub struct Pipeline;

impl Pipeline {
    /// Run all enrich sources in parallel for the given token. Errors are
    /// collected per-source rather than logged-and-discarded so the UI can
    /// distinguish "no data" from "rate limited / network failed".
    pub async fn run(
        token: &str,
        enrich_sources: &[String],
        state: Arc<AppState>,
        _active: &ActiveSources,
        session: Option<SessionContext>,
    ) -> PipelineOutput {
        // Check availability from the DB-loaded enrichment_sources cache.
        // Snapshot the available set then drop the lock before spawning tasks.
        let available: Vec<String> = {
            let sources_cache = state.enrichment_sources.read().await;
            enrich_sources.iter()
                .filter(|s| ActiveSources::source_available_from_cache(&sources_cache, s))
                .cloned()
                .collect()
        };
        let mut futures = Vec::new();
        for source in &available {
            let token_s = token.to_string();
            let source_s = source.clone();
            let st = state.clone();
            let sess = session.clone();
            futures.push(tokio::spawn(async move {
                let result = run_one_source(&source_s, &token_s, st, sess.as_ref()).await;
                (source_s, result)
            }));
        }

        let mut out = PipelineOutput::default();
        for fut in futures {
            match fut.await {
                Ok((name, Ok(value))) => {
                    if !value.is_null() {
                        out.sources.insert(name, value);
                    }
                }
                Ok((name, Err(err))) => {
                    tracing::warn!(source = %name, error = %err, "enrichment source failed");
                    out.errors.insert(name, err);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "enrichment task panicked");
                }
            }
        }
        out
    }
}

/// Dispatch one enrichment source for `token`. The source is looked up by
/// name in the DB-backed `enrichment_sources` cache. Built-ins (`dns_ptr`,
/// `oui_vendor`) bypass HTTP entirely. Everything else is an `api_resource`
/// row: we resolve the API resource, substitute path-template variables,
/// call via the unified `ApiResourceClient.request()`, walk the configured
/// unwrap path, and pick the configured fields.
///
/// The returned object includes a `_meta.fields` array describing how the
/// frontend should label and format each value — the renderer is generic.
pub async fn run_one_source(
    source: &str,
    token: &str,
    state: Arc<AppState>,
    session: Option<&SessionContext>,
) -> Result<Value, String> {
    let src = {
        let cache = state.enrichment_sources.read().await;
        cache.get(source).cloned()
    };
    let src = src.ok_or_else(|| format!("Unknown enrichment source: {}", source))?;

    // Built-ins: no API resource required. Wrap the result with
    // picked_fields metadata so the renderer can format it.
    if src.kind == "builtin" {
        let raw = match source {
            "dns_ptr"       => dns_ptr(token).await?,
            "oui_vendor"    => oui_vendor(token, state.clone()).await?,
            "mac_address_type" => mac_address_type(token)?,
            other => return Err(format!("Unknown builtin source: {}", other)),
        };
        return Ok(attach_field_meta(raw, &src.picked_fields));
    }

    // api_resource path
    let Some(api_id) = src.api_resource_id.as_deref() else {
        // Unconfigured source — silently no-op so users with multiple
        // partially-wired integrations don't see errors.
        return Ok(Value::Null);
    };
    let client = crate::api_resource_client::ApiResourceClient::from_id(
        &state.provider, api_id, Some(&state.auth_cache),
    ).await.map_err(|e| format!("api resource client: {}", e))?;

    let path = substitute_template(&src.path_template, token, session);
    // Use the unified ApiResourceClient.execute() — it performs variable
    // substitution, multi-step auth resolution (with one 401 re-auth retry),
    // and returns a structured result. We do our own unwrap + field-pick on
    // the raw body afterwards, so no json_extract_path is passed.
    let result = client.execute(
        &src.method.to_uppercase(),
        &path,
        &serde_json::json!({}),
        None,
        None,
        &std::collections::HashMap::new(),
    ).await;
    if result.status_code == 404 { return Ok(Value::Null); }
    if !result.success {
        return Err(result.error.unwrap_or_else(|| format!("HTTP {}", result.status_code)));
    }
    let body: Value = result.raw_body.unwrap_or(Value::Null);
    // Substitute template vars in unwrap + picked-field keys so JSONPath
    // expressions like `$.ips[?(@.router_name=='{session_host}')]` resolve.
    let unwrap_resolved = substitute_template(&src.response_unwrap, token, session);
    let unwrapped = json_walk_unwrap(&body, &unwrap_resolved);
    let picked_resolved: Vec<crate::models::PickedField> = src.picked_fields.iter()
        .map(|f| crate::models::PickedField {
            key: substitute_template(&f.key, token, session),
            label: f.label.clone(),
            format: f.format.clone(),
        })
        .collect();
    let picked = pick_fields_with_meta(&unwrapped, &picked_resolved);
    Ok(picked)
}

/// Substitute path-template variables. Supported markers:
///   {token}, {token_url}                — the literal/url-encoded hover token
///   {session_host}, {sessions_host}     — session hostname (typo alias)
///   {session_name}                      — session display name
///   {session_host_ip}                   — DNS-resolved IPv4 of session host
///                                         (returns host as-is if already an IP
///                                         or empty string if resolution fails)
/// Unknown markers are left as-is so missing context is visible in agent logs.
fn substitute_template(template: &str, token: &str, session: Option<&SessionContext>) -> String {
    let host = session.map(|s| s.host.as_str()).unwrap_or("");
    let name = session.map(|s| s.name.as_str()).unwrap_or("");
    // Only resolve DNS if the marker is actually present — avoid blocking
    // for sources that don't need an IP.
    let host_ip = if template.contains("{session_host_ip}") {
        resolve_session_host_ip(host)
    } else {
        String::new()
    };
    template
        .replace("{token_url}", &urlencoding::encode(token))
        .replace("{token}", token)
        .replace("{session_host_ip}", &host_ip)
        .replace("{session_host}", host)
        .replace("{sessions_host}", host)  // typo-friendly alias
        .replace("{session_name}", name)
}

/// Public wrapper for callers outside this module (api.rs test endpoint).
pub fn resolve_session_host_ip_pub(host: &str) -> String {
    resolve_session_host_ip(host)
}

/// Resolve a hostname to its first IPv4 address (or return the input as-is
/// if already an IP). Short-circuits on parse failure to keep this fast on
/// the request hot path. Returns empty string on failure (substituted in).
fn resolve_session_host_ip(host: &str) -> String {
    if host.is_empty() { return String::new(); }
    // Already an IPv4/IPv6 literal?
    if host.parse::<std::net::IpAddr>().is_ok() {
        return host.to_string();
    }
    use std::net::ToSocketAddrs;
    // Append a dummy port so ToSocketAddrs resolves the hostname
    match (host, 0u16).to_socket_addrs() {
        Ok(mut iter) => iter.find_map(|sa| {
            if let std::net::IpAddr::V4(v4) = sa.ip() { Some(v4.to_string()) } else { None }
        })
        .or_else(|| {
            // Fall back to IPv6 if no IPv4
            (host, 0u16).to_socket_addrs().ok()
                .and_then(|mut it| it.next().map(|sa| sa.ip().to_string()))
        })
        .unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// Normalize a JSON path: strip a leading dot, convert `[n]` bracket notation
/// to dotted form (`ips[0].name` → `ips.0.name`), and collapse any `..`.
fn normalize_path(path: &str) -> String {
    path.replace('[', ".").replace(']', "")
        .split('.')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(".")
}

/// Run a JSONPath expression against `value`. Returns the single matched
/// value (or first match for array results) — mirrors the picker's first-hit
/// semantics.
fn jsonpath_walk(value: &Value, expr: &str) -> Value {
    match serde_json_path::JsonPath::parse(expr) {
        Ok(jp) => {
            let nodes: Vec<&Value> = jp.query(value).all();
            match nodes.len() {
                0 => Value::Null,
                1 => nodes[0].clone(),
                _ => Value::Array(nodes.into_iter().cloned().collect()),
            }
        }
        Err(_) => Value::Null,
    }
}

/// Walk a JSON value by either dotted/bracket path OR JSONPath expression.
/// JSONPath is auto-detected by the leading `$` character.
/// Empty path returns `value` as-is.
fn json_walk_unwrap(value: &Value, path: &str) -> Value {
    if path.is_empty() { return value.clone(); }
    let trimmed = path.trim();
    if trimmed.starts_with('$') { return jsonpath_walk(value, trimmed); }
    let normalized = normalize_path(trimmed);
    if normalized.is_empty() { return value.clone(); }
    let mut cur = value;
    for part in normalized.split('.') {
        cur = match cur {
            Value::Object(m) => m.get(part).unwrap_or(&Value::Null),
            Value::Array(a) => match part.parse::<usize>() {
                Ok(i) => a.get(i).unwrap_or(&Value::Null),
                Err(_) => return Value::Null,
            },
            _ => return Value::Null,
        };
        if cur.is_null() { return Value::Null; }
    }
    cur.clone()
}

/// Walk a single picked-field key inside `value`. Supports JSONPath
/// (leading `$`) or dotted/bracket notation.
fn json_walk_key(value: &Value, key: &str) -> Value {
    let trimmed = key.trim();
    if trimmed.starts_with('$') { return jsonpath_walk(value, trimmed); }
    let normalized = normalize_path(trimmed);
    let mut cur = value;
    for part in normalized.split('.') {
        cur = match cur {
            Value::Object(m) => m.get(part).unwrap_or(&Value::Null),
            Value::Array(a) => match part.parse::<usize>() {
                Ok(i) => a.get(i).unwrap_or(&Value::Null),
                Err(_) => return Value::Null,
            },
            _ => return Value::Null,
        };
    }
    cur.clone()
}

/// Build a result object containing only the picked fields, plus a
/// `_meta.fields` array describing labels + formats for the renderer.
/// When the source has no picked_fields configured (empty list), we pass
/// the whole unwrapped value through so the frontend's raw-debug fallback
/// can render it.
fn pick_fields_with_meta(
    unwrapped: &Value,
    fields: &[crate::models::PickedField],
) -> Value {
    // Empty unwrapped → no result. Returning Null causes the pipeline to drop
    // this source from the response entirely (no empty section in the popup).
    if unwrapped.is_null() {
        return Value::Null;
    }

    // Many APIs return arrays for "search" endpoints (Crawler's /search/node,
    // /search/device, etc.). When we get an array, project to the first
    // element automatically for dotted-path picks — saves users from having
    // to write `0` as their response_unwrap. Empty arrays drop the source.
    // JSONPath picked fields ($...) get the FULL unwrapped value instead so
    // expressions like $[*].device.name can scan the whole array.
    if let Value::Array(a) = unwrapped { if a.is_empty() { return Value::Null; } }
    let projected: Value = match unwrapped {
        Value::Array(a) => a[0].clone(),
        other => other.clone(),
    };

    if fields.is_empty() {
        // Hand the whole thing back; the frontend raw-debug fallback kicks in.
        return projected;
    }

    let mut picked = serde_json::Map::new();
    let mut any_found = false;
    for f in fields {
        let is_jsonpath = f.key.trim().starts_with('$');
        let eval_against = if is_jsonpath { unwrapped } else { &projected };
        let v = json_walk_key(eval_against, &f.key);
        if !v.is_null() {
            picked.insert(f.key.clone(), v);
            any_found = true;
        }
    }
    // If none of the picked-field keys resolved against the actual response,
    // include the full target object so the user can see what's actually
    // there (via the raw-debug fallback) and adjust their picked_fields.
    // Common cause: response_unwrap is wrong (e.g. `results.0` vs `data.0`)
    // or the API changed shape between configurations.
    if !any_found {
        if let Value::Object(m) = &projected {
            for (k, v) in m {
                if k != "_meta" {  // never collide with our metadata
                    picked.insert(k.clone(), v.clone());
                }
            }
        }
    }
    let meta_fields: Vec<Value> = fields.iter().map(|f| serde_json::json!({
        "key": f.key, "label": f.label, "format": f.format,
    })).collect();
    let mut meta = serde_json::Map::new();
    meta.insert("fields".to_string(), Value::Array(meta_fields));
    // Stash the full unwrapped response under `_raw` so the popup can offer a
    // "view raw" toggle without re-fetching. Cheap on bandwidth (single small
    // hover-scoped response) and lets users discover fields they didn't pick.
    picked.insert("_meta".to_string(), Value::Object(meta));
    picked.insert("_raw".to_string(), projected);
    Value::Object(picked)
}

/// Wrap a built-in result (dns_ptr / oui_vendor) with picked_fields metadata
/// so it goes through the same generic renderer as api_resource sources.
fn attach_field_meta(raw: Value, fields: &[crate::models::PickedField]) -> Value {
    if raw.is_null() { return raw; }
    if fields.is_empty() { return raw; }
    let raw_snapshot = raw.clone();
    match raw {
        Value::Object(mut m) => {
            let meta_fields: Vec<Value> = fields.iter().map(|f| serde_json::json!({
                "key": f.key, "label": f.label, "format": f.format,
            })).collect();
            let mut meta = serde_json::Map::new();
            meta.insert("fields".to_string(), Value::Array(meta_fields));
            m.insert("_meta".to_string(), Value::Object(meta));
            m.insert("_raw".to_string(), raw_snapshot);
            Value::Object(m)
        }
        other => other,
    }
}

// ─── built-in sources ─────────────────────────────────────────────────────

/// Classify a MAC address by its IEEE-defined bits + well-known patterns.
/// No HTTP call. Returns user-friendly labels so hovering a randomized / VM /
/// VXLAN MAC explains *what kind* of fake/virtual MAC it is, instead of an
/// empty OUI section.
///   - I/G bit (LSB of first octet): individual (0) vs multicast/group (1)
///   - U/L bit (next bit):           vendor-assigned (0) vs locally administered (1)
fn mac_address_type(token: &str) -> Result<Value, String> {
    let cleaned: String = token.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if cleaned.len() != 12 {
        return Ok(Value::Null);
    }
    let first_octet = match u8::from_str_radix(&cleaned[0..2], 16) {
        Ok(n) => n,
        Err(_) => return Ok(Value::Null),
    };
    let is_multicast = (first_octet & 0x01) != 0;
    let is_local = (first_octet & 0x02) != 0;
    let prefix6 = cleaned[0..6].to_uppercase();
    let prefix4 = cleaned[0..4].to_uppercase();

    // Most specific matches first. (kind, notes, scope)
    // Reserved / well-known multicast and broadcast destinations are absolute.
    let (kind, notes, scope) = if cleaned.eq_ignore_ascii_case("ffffffffffff") {
        ("Broadcast", "All hosts on the local link", "well-known")
    } else if prefix6 == "01005E" {
        ("IPv4 Multicast", "Maps to a 224.0.0.0/4 multicast group", "well-known")
    } else if prefix4 == "3333" {
        ("IPv6 Multicast", "IPv6 neighbor / link-local multicast", "well-known")
    } else if prefix6 == "0180C2" {
        ("IEEE 802.1 Multicast", "Bridge / spanning-tree / LLDP frames", "well-known")
    } else if prefix6 == "00005E" {
        // VRRP virtual MAC — first 5 octets are 00:00:5E:00:01:VRID for IPv4,
        // 00:00:5E:00:02:VRID for IPv6. Universally administered.
        ("VRRP Virtual", "Virtual Router Redundancy Protocol — gateway VIP, not a real device", "virtual")
    // Locally-administered well-known prefixes (vendors / hypervisors that
    // intentionally set the L bit so they don't collide with real OUIs).
    } else if prefix6 == "525400" {
        ("QEMU/KVM Virtual", "Virtio NIC on a KVM/QEMU virtual machine — generated by libvirt", "virtual")
    } else if prefix4 == "0242" {
        ("Docker Virtual", "Docker container or bridge interface — generated by the Docker daemon", "virtual")
    } else if is_local && (first_octet & 0xF0) == 0 && (first_octet & 0x0E) == 0x02 {
        // 0x02 first octet — the most common randomized / generic local MAC
        ("Locally Administered (Random/VTEP/VM)", "Randomized MAC, VXLAN VTEP, VM virtual NIC, Linux bridge, or bond — software-generated, no IEEE OUI", "virtual")
    } else if is_local {
        // Anything else with L bit set
        ("Locally Administered", "Software-generated MAC (randomized, VXLAN VTEP, VM, container, or bond) — no IEEE OUI to look up", "virtual")
    } else if is_multicast {
        ("Multicast", "Group / multicast frame target", "multicast")
    } else {
        // Normal vendor-assigned MAC — the OUI section already shows the
        // manufacturer. No point adding a "Type: Vendor-Assigned" section
        // that just says "see OUI". Return Null so no section renders.
        return Ok(Value::Null);
    };

    Ok(serde_json::json!({
        "type": kind,
        "scope": scope,
        "notes": notes,
    }))
}

async fn dns_ptr(token: &str) -> Result<Value, String> {
    use hickory_resolver::error::ResolveErrorKind;
    let ip: std::net::IpAddr = token.parse().map_err(|e: std::net::AddrParseError| e.to_string())?;
    match crate::api::dns_resolver().reverse_lookup(ip).await {
        Ok(resp) => {
            let names: Vec<String> = resp
                .iter()
                .map(|n| n.to_utf8().trim_end_matches('.').to_string())
                .collect();
            if names.is_empty() {
                Ok(Value::Null)
            } else {
                Ok(json!({ "ptr": names[0], "all": names }))
            }
        }
        Err(e) if matches!(e.kind(), ResolveErrorKind::NoRecordsFound { .. }) => Ok(Value::Null),
        Err(e) => Err(format!("DNS error: {}", e)),
    }
}

/// OUI vendor lookup. Layered to avoid hammering macvendors.com:
///   1. Locally-administered MACs → skip (mac_address_type tells the story).
///   2. Local SQLite `oui_vendors` table → instant hit when seeded from IEEE.
///   3. macvendors.com API → fall-back; the result is cached back into the
///      table so the next request for that prefix is local-only.
async fn oui_vendor(token: &str, state: Arc<AppState>) -> Result<Value, String> {
    // 1. Skip locally-administered MACs entirely — there's no vendor to look up.
    if crate::enrich::oui::is_locally_administered(token) {
        return Ok(Value::Null);
    }

    // 2. DB lookup by OUI prefix (first 3 octets).
    let Some(prefix) = crate::enrich::oui::oui_prefix_from_mac(token) else {
        return Ok(Value::Null);
    };
    if let Ok(Some(vendor)) = state.provider.oui_lookup(&prefix).await {
        return Ok(json!({ "vendor": vendor }));
    }

    // 3. macvendors.com fallback. Cache the result so this prefix becomes local-only next time.
    let mac_norm = token.replace(['.', '-'], ":");
    let url = format!("https://api.macvendors.com/{}", urlencoding::encode(&mac_norm));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| format!("network: {}", e))?;
    let status = resp.status();
    if status.as_u16() == 404 { return Ok(Value::Null); }
    if !status.is_success() {
        if status.as_u16() == 429 {
            return Err("rate limited (HTTP 429) — macvendors.com throttles free tier (will heal once the local IEEE OUI DB finishes its background download)".into());
        }
        return Err(format!("HTTP {}", status));
    }
    let vendor = resp.text().await.map_err(|e| e.to_string())?;
    let vendor = vendor.trim();
    if vendor.is_empty() {
        return Ok(Value::Null);
    }
    // Cache into the local DB for future lookups (no await on the result —
    // best-effort; if it fails, we still return the value to the user).
    let _ = state.provider.oui_cache_one(&prefix, vendor).await;
    Ok(json!({ "vendor": vendor }))
}

