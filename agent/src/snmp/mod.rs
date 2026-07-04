//! SNMP v2c client foundation for NetStacks
//!
//! Provides async GET, WALK, GETBULK, and community trial functions
//! using the snmp2 crate with tokio async support.
//!
//! All functions are stateless helpers that create a session per-call.
//! This is intentional for network equipment polling where connections
//! are lightweight UDP exchanges, not persistent TCP sessions.
//!
//! For devices reachable only via a jump host (where direct UDP/161 won't
//! work — SSH only forwards TCP), see `cli_parse` (and the upcoming T2
//! `cli_exec`) which run net-snmp CLI tools on the jump and parse stdout
//! back into the same `SnmpValueEntry` shape.

pub mod cli_parse;
pub mod cli_exec;
pub mod dest;

use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;
use tokio::time::timeout;

/// Where an SNMP operation should be performed.
///
/// `Direct` keeps today's pure-Rust UDP path: open a UDP socket from the
/// agent process to `host:port`. `ViaJump` is for devices reachable only
/// via a jump host (SSH only forwards TCP, so UDP/161 can't be tunneled
/// directly): open an SSH exec channel on the jump and run net-snmp's CLI
/// tools there. Both paths produce the same `SnmpValueEntry` shape, so
/// every downstream consumer (interface stats, neighbor discovery,
/// frontend rendering) is dest-agnostic.
///
/// The `ViaJump` variant takes a fully-resolved `SshConfig` rather than a
/// jump id — the SNMP module doesn't know about session/profile lookup or
/// vault resolution. Callers (typically `api.rs` handlers) build the
/// SshConfig from `resolve_effective_jump` before dispatching.
#[derive(Debug, Clone)]
pub enum SnmpDest {
    Direct {
        host: String,
        port: u16,
    },
    ViaJump {
        /// SSH connection target — the jump host. Includes its auth.
        jump: crate::ssh::SshConfig,
        /// The actual SNMP target the jump will reach over UDP.
        target_host: String,
        target_port: u16,
    },
}

impl SnmpDest {
    /// Convenience constructor for the common direct case.
    pub fn direct(host: impl Into<String>, port: u16) -> Self {
        Self::Direct { host: host.into(), port }
    }

    /// The (host, port) pair the SNMP query is ultimately aimed at,
    /// regardless of whether it travels direct or via a jump.
    fn target(&self) -> (&str, u16) {
        match self {
            Self::Direct { host, port } => (host.as_str(), *port),
            Self::ViaJump { target_host, target_port, .. } => (target_host.as_str(), *target_port),
        }
    }
}

/// Default SNMP operation timeout (5 seconds)
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

/// Maximum entries to collect during a WALK before stopping (safety limit)
const MAX_WALK_ENTRIES: usize = 10_000;

// === Error Types ===

/// SNMP operation errors
#[derive(Debug, Error)]
pub enum SnmpError {
    #[error("SNMP operation timed out after {0} seconds")]
    Timeout(u64),

    #[error("Failed to connect to {host}:{port}: {reason}")]
    ConnectionFailed {
        host: String,
        port: u16,
        reason: String,
    },

    #[error("Invalid OID: {0}")]
    InvalidOid(String),

    #[error("No such object at OID {0}")]
    NoSuchObject(String),

    #[error("No such instance at OID {0}")]
    NoSuchInstance(String),

    #[error("SNMP authentication error (community string rejected)")]
    AuthError,

    #[error("SNMP protocol error: {0}")]
    Protocol(String),

    #[error("Interface not found: {0}")]
    InterfaceNotFound(String),

    #[error("SNMP error: {0}")]
    Other(String),
}

// === Value Types ===

/// Serializable SNMP value enum
///
/// Converts from snmp2's borrowed Value type into an owned, serializable form.
/// This decouples our API from the snmp2 crate's lifetime-bound types.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "value")]
pub enum SnmpValue {
    Integer(i64),
    String(String),
    OctetString(Vec<u8>),
    Counter32(u32),
    Counter64(u64),
    Gauge32(u32),
    TimeTicks(u32),
    IpAddress(String),
    ObjectId(String),
    Boolean(bool),
    Null,
    EndOfMibView,
    NoSuchObject,
    NoSuchInstance,
    Unknown(String),
}

/// A single SNMP value entry with its OID
#[derive(Debug, Clone, Serialize)]
pub struct SnmpValueEntry {
    pub oid: String,
    pub value: SnmpValue,
    pub value_type: String,
}

// === Response Types ===

/// Response from an SNMP GET operation
#[derive(Debug, Clone, Serialize)]
pub struct _SnmpGetResponse {
    pub values: Vec<SnmpValueEntry>,
}

/// Response from an SNMP WALK operation
#[derive(Debug, Clone, Serialize)]
pub struct _SnmpWalkResponse {
    pub entries: Vec<SnmpValueEntry>,
    pub root_oid: String,
}

/// Response from a community string trial
#[derive(Debug, Clone, Serialize)]
pub struct SnmpTryCommunityResponse {
    pub community: String,
    pub sys_name: String,
}

// === Helper Functions ===

/// Convert snmp2::Value (borrowed) to our owned SnmpValue
fn convert_value(value: &snmp2::Value<'_>) -> SnmpValue {
    match value {
        snmp2::Value::Integer(n) => SnmpValue::Integer(*n),
        snmp2::Value::OctetString(bytes) => {
            // Try to interpret as UTF-8 string first
            match std::str::from_utf8(bytes) {
                Ok(s) if s.chars().all(|c| !c.is_control() || c == '\n' || c == '\r' || c == '\t') => {
                    SnmpValue::String(s.to_string())
                }
                _ => SnmpValue::OctetString(bytes.to_vec()),
            }
        }
        snmp2::Value::ObjectIdentifier(oid) => SnmpValue::ObjectId(oid.to_string()),
        snmp2::Value::Counter32(n) => SnmpValue::Counter32(*n),
        snmp2::Value::Counter64(n) => SnmpValue::Counter64(*n),
        snmp2::Value::Unsigned32(n) => SnmpValue::Gauge32(*n),
        snmp2::Value::Timeticks(n) => SnmpValue::TimeTicks(*n),
        snmp2::Value::IpAddress(octets) => {
            SnmpValue::IpAddress(format!("{}.{}.{}.{}", octets[0], octets[1], octets[2], octets[3]))
        }
        snmp2::Value::Boolean(b) => SnmpValue::Boolean(*b),
        snmp2::Value::Null => SnmpValue::Null,
        snmp2::Value::EndOfMibView => SnmpValue::EndOfMibView,
        snmp2::Value::NoSuchObject => SnmpValue::NoSuchObject,
        snmp2::Value::NoSuchInstance => SnmpValue::NoSuchInstance,
        other => SnmpValue::Unknown(format!("{:?}", other)),
    }
}

/// Get the type name string for an SnmpValue
fn value_type_name(value: &SnmpValue) -> String {
    match value {
        SnmpValue::Integer(_) => "Integer".to_string(),
        SnmpValue::String(_) => "OctetString".to_string(),
        SnmpValue::OctetString(_) => "OctetString".to_string(),
        SnmpValue::Counter32(_) => "Counter32".to_string(),
        SnmpValue::Counter64(_) => "Counter64".to_string(),
        SnmpValue::Gauge32(_) => "Gauge32".to_string(),
        SnmpValue::TimeTicks(_) => "TimeTicks".to_string(),
        SnmpValue::IpAddress(_) => "IpAddress".to_string(),
        SnmpValue::ObjectId(_) => "ObjectIdentifier".to_string(),
        SnmpValue::Boolean(_) => "Boolean".to_string(),
        SnmpValue::Null => "Null".to_string(),
        SnmpValue::EndOfMibView => "EndOfMibView".to_string(),
        SnmpValue::NoSuchObject => "NoSuchObject".to_string(),
        SnmpValue::NoSuchInstance => "NoSuchInstance".to_string(),
        SnmpValue::Unknown(_) => "Unknown".to_string(),
    }
}

/// Parse a dotted-decimal OID string (e.g., "1.3.6.1.2.1.1.1.0") into component parts
fn parse_oid_components(oid_str: &str) -> Result<Vec<u64>, SnmpError> {
    // Strip leading dot if present (e.g., ".1.3.6.1..." -> "1.3.6.1...")
    let stripped = oid_str.strip_prefix('.').unwrap_or(oid_str);

    if stripped.is_empty() {
        return Err(SnmpError::InvalidOid(oid_str.to_string()));
    }

    stripped
        .split('.')
        .map(|part| {
            part.parse::<u64>()
                .map_err(|_| SnmpError::InvalidOid(format!("Invalid OID component '{}' in '{}'", part, oid_str)))
        })
        .collect()
}

/// Check if oid_b is a child of (starts with) oid_a by comparing numeric components
fn oid_starts_with(child_oid: &str, parent_oid: &str) -> bool {
    let child = child_oid.strip_prefix('.').unwrap_or(child_oid);
    let parent = parent_oid.strip_prefix('.').unwrap_or(parent_oid);

    let child_parts: Vec<&str> = child.split('.').collect();
    let parent_parts: Vec<&str> = parent.split('.').collect();

    if child_parts.len() < parent_parts.len() {
        return false;
    }

    // Compare each numeric component
    for (c, p) in child_parts.iter().zip(parent_parts.iter()) {
        let c_num: u64 = match c.parse() {
            Ok(n) => n,
            Err(_) => return false,
        };
        let p_num: u64 = match p.parse() {
            Ok(n) => n,
            Err(_) => return false,
        };
        if c_num != p_num {
            return false;
        }
    }

    true
}

/// Create an SNMP session with timeout handling
async fn create_session(
    host: &str,
    port: u16,
    community: &str,
) -> Result<snmp2::AsyncSession, SnmpError> {
    let addr = format!("{}:{}", host, port);
    let session_future = snmp2::AsyncSession::new_v2c(
        addr.as_str(),
        community.as_bytes(),
        0,
    );

    match timeout(DEFAULT_TIMEOUT, session_future).await {
        Ok(Ok(session)) => Ok(session),
        Ok(Err(e)) => Err(SnmpError::ConnectionFailed {
            host: host.to_string(),
            port,
            reason: e.to_string(),
        }),
        Err(_) => Err(SnmpError::Timeout(DEFAULT_TIMEOUT.as_secs())),
    }
}

/// Map snmp2 errors to our error type
fn map_snmp_error(err: snmp2::Error, context: &str) -> SnmpError {
    match err {
        snmp2::Error::CommunityMismatch => SnmpError::AuthError,
        snmp2::Error::Send | snmp2::Error::Receive => SnmpError::ConnectionFailed {
            host: context.to_string(),
            port: 0,
            reason: err.to_string(),
        },
        _ => SnmpError::Protocol(format!("{}: {}", context, err)),
    }
}

// === Public API ===

/// Perform an SNMPv2c GET for one or more OIDs.
///
/// Returns the values for each requested OID. Routes either over UDP/161
/// directly or as a `snmpget` invocation on a jump host, depending on
/// `dest`.
pub async fn snmp_get(
    dest: &SnmpDest,
    community: &str,
    oids: &[&str],
) -> Result<Vec<SnmpValueEntry>, SnmpError> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }
    if let SnmpDest::ViaJump { jump, target_host, target_port } = dest {
        return cli_exec::snmp_get_via_jump(jump, target_host, *target_port, community, oids).await;
    }
    let (host, port) = dest.target();

    let mut session = create_session(host, port, community).await?;

    // Parse OIDs
    let parsed_oids: Vec<Vec<u64>> = oids
        .iter()
        .map(|oid_str| parse_oid_components(oid_str))
        .collect::<Result<Vec<_>, _>>()?;

    let mut results = Vec::with_capacity(oids.len());

    if oids.len() == 1 {
        // Single OID GET
        let oid = snmp2::Oid::from(parsed_oids[0].as_slice())
            .map_err(|e| SnmpError::InvalidOid(format!("{}: {:?}", oids[0], e)))?;
        let pdu_future = session.get(&oid);
        let pdu = timeout(DEFAULT_TIMEOUT, pdu_future)
            .await
            .map_err(|_| SnmpError::Timeout(DEFAULT_TIMEOUT.as_secs()))?
            .map_err(|e| map_snmp_error(e, host))?;

        for (resp_oid, value) in pdu.varbinds {
            let converted = convert_value(&value);
            // Check for error values
            match &converted {
                SnmpValue::NoSuchObject => {
                    return Err(SnmpError::NoSuchObject(oids[0].to_string()));
                }
                SnmpValue::NoSuchInstance => {
                    return Err(SnmpError::NoSuchInstance(oids[0].to_string()));
                }
                _ => {}
            }
            let type_name = value_type_name(&converted);
            results.push(SnmpValueEntry {
                oid: resp_oid.to_string(),
                value: converted,
                value_type: type_name,
            });
        }
    } else {
        // Multi-OID GET
        let oid_refs: Vec<snmp2::Oid<'_>> = parsed_oids
            .iter()
            .map(|components| {
                snmp2::Oid::from(components.as_slice())
                    .map_err(|e| SnmpError::InvalidOid(format!("{:?}", e)))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let oid_ref_slice: Vec<&snmp2::Oid<'_>> = oid_refs.iter().collect();

        let pdu_future = session.get_many(&oid_ref_slice);
        let pdu = timeout(DEFAULT_TIMEOUT, pdu_future)
            .await
            .map_err(|_| SnmpError::Timeout(DEFAULT_TIMEOUT.as_secs()))?
            .map_err(|e| map_snmp_error(e, host))?;

        for (resp_oid, value) in pdu.varbinds {
            let converted = convert_value(&value);
            let type_name = value_type_name(&converted);
            results.push(SnmpValueEntry {
                oid: resp_oid.to_string(),
                value: converted,
                value_type: type_name,
            });
        }
    }

    Ok(results)
}

/// Perform an SNMPv2c WALK using GETNEXT loop.
///
/// Walks the subtree under `root_oid`, collecting all values until the
/// returned OID is outside the root subtree. Routes either over UDP/161
/// directly or as a `snmpwalk` invocation on a jump host, depending on
/// `dest`.
pub async fn snmp_walk(
    dest: &SnmpDest,
    community: &str,
    root_oid: &str,
) -> Result<Vec<(String, SnmpValue)>, SnmpError> {
    if let SnmpDest::ViaJump { jump, target_host, target_port } = dest {
        return cli_exec::snmp_walk_via_jump(jump, target_host, *target_port, community, root_oid).await;
    }
    let (host, port) = dest.target();

    let mut session = create_session(host, port, community).await?;
    let root_components = parse_oid_components(root_oid)?;
    let mut current_oid = snmp2::Oid::from(root_components.as_slice())
        .map_err(|e| SnmpError::InvalidOid(format!("{}: {:?}", root_oid, e)))?;
    let mut results: Vec<(String, SnmpValue)> = Vec::new();

    loop {
        if results.len() >= MAX_WALK_ENTRIES {
            tracing::warn!(
                "SNMP WALK of {} on {}:{} reached max entries limit ({})",
                root_oid, host, port, MAX_WALK_ENTRIES
            );
            break;
        }

        // Use GETBULK (SNMPv2c) instead of GETNEXT — one PDU returns up to
        // BULK_REPS rows instead of one. For a 200-row table that's 8 PDUs
        // instead of 200 — roughly 25x fewer round-trips. Massive win for
        // walks against devices with hundreds of interfaces / neighbors.
        const BULK_REPS: u32 = 25;
        let oids_arr = [&current_oid];
        let pdu_future = session.getbulk(&oids_arr, 0, BULK_REPS);
        let pdu = match timeout(DEFAULT_TIMEOUT, pdu_future).await {
            Ok(Ok(pdu)) => pdu,
            Ok(Err(e)) => {
                // Some devices return errors at end of MIB
                tracing::debug!("WALK ended with error: {}", e);
                break;
            }
            Err(_) => {
                return Err(SnmpError::Timeout(DEFAULT_TIMEOUT.as_secs()));
            }
        };

        let mut found_next = false;
        for (resp_oid, value) in pdu.varbinds {
            let oid_string = resp_oid.to_string();

            // Check if we've left the subtree
            if !oid_starts_with(&oid_string, root_oid) {
                return Ok(results);
            }

            let converted = convert_value(&value);

            // EndOfMibView means we're done
            if matches!(converted, SnmpValue::EndOfMibView) {
                return Ok(results);
            }

            // NoSuchObject/NoSuchInstance - skip but continue
            if matches!(converted, SnmpValue::NoSuchObject | SnmpValue::NoSuchInstance) {
                return Ok(results);
            }

            // Track the last in-subtree OID so the next GETBULK starts there.
            if let Ok(next_components) = parse_oid_components(&oid_string) {
                if let Ok(next_oid) = snmp2::Oid::from(next_components.as_slice()) {
                    current_oid = next_oid;
                    found_next = true;
                }
            }

            results.push((oid_string, converted));
        }

        if !found_next {
            break;
        }
    }

    Ok(results)
}

/// Try each community string with a GET of sysName.0.
///
/// Returns the first community that succeeds along with the sysName value.
/// This is useful for auto-detecting which community string works for a device.
///
/// # Arguments
/// * `dest` - Where to query (direct UDP or via a jump host)
/// * `communities` - List of community strings to try
pub async fn try_communities(
    dest: &SnmpDest,
    communities: &[String],
) -> Result<SnmpTryCommunityResponse, SnmpError> {
    if let SnmpDest::ViaJump { jump, target_host, target_port } = dest {
        return cli_exec::try_communities_via_jump(jump, target_host, *target_port, communities).await;
    }
    let (host, port) = dest.target();

    // sysName.0 OID: 1.3.6.1.2.1.1.5.0
    let sys_name_oid = "1.3.6.1.2.1.1.5.0";

    for community in communities {
        match snmp_get(dest, community, &[sys_name_oid]).await {
            Ok(values) => {
                if let Some(entry) = values.first() {
                    let sys_name = match &entry.value {
                        SnmpValue::String(s) => s.clone(),
                        SnmpValue::OctetString(bytes) => {
                            String::from_utf8_lossy(bytes).to_string()
                        }
                        other => format!("{:?}", other),
                    };
                    return Ok(SnmpTryCommunityResponse {
                        community: community.clone(),
                        sys_name,
                    });
                }
            }
            Err(SnmpError::Timeout(_)) => {
                // Timeout likely means wrong community or unreachable - try next
                tracing::debug!(
                    "Community '{}' timed out for {}:{}, trying next",
                    community, host, port
                );
                continue;
            }
            Err(SnmpError::AuthError) => {
                // Wrong community - try next
                tracing::debug!(
                    "Community '{}' rejected by {}:{}, trying next",
                    community, host, port
                );
                continue;
            }
            Err(SnmpError::NoSuchObject(_) | SnmpError::NoSuchInstance(_)) => {
                // Community works but sysName not available - still valid
                return Ok(SnmpTryCommunityResponse {
                    community: community.clone(),
                    sys_name: String::new(),
                });
            }
            Err(e) => {
                tracing::debug!(
                    "Community '{}' failed for {}:{}: {}",
                    community, host, port, e
                );
                continue;
            }
        }
    }

    Err(SnmpError::AuthError)
}

// === Interface Stats ===

/// Interface statistics from IF-MIB
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceStats {
    pub if_index: u64,
    pub if_descr: String,
    pub if_alias: String,
    pub oper_status: u8,
    pub admin_status: u8,
    pub if_type: u64,
    pub mtu: u64,
    pub phys_address: String,
    pub last_change: u64,
    pub speed_mbps: u64,
    pub in_octets: u64,
    pub out_octets: u64,
    pub in_errors: u64,
    pub out_errors: u64,
    pub in_discards: u64,
    pub out_discards: u64,
    pub in_ucast_pkts: u64,
    pub out_ucast_pkts: u64,
    pub in_multicast_pkts: u64,
    pub out_multicast_pkts: u64,
    pub in_broadcast_pkts: u64,
    pub out_broadcast_pkts: u64,
    pub hc_counters: bool,
}

/// Common interface name abbreviation mappings.
/// Maps short prefixes to their full canonical forms.
const INTERFACE_ABBREVIATIONS: &[(&str, &str)] = &[
    ("Gi", "GigabitEthernet"),
    ("Fa", "FastEthernet"),
    ("Te", "TenGigabitEthernet"),
    ("Tw", "TwentyFiveGigE"),
    ("Fo", "FortyGigabitEthernet"),
    ("Hu", "HundredGigE"),
    ("Et", "Ethernet"),
    ("Lo", "Loopback"),
    ("Vl", "Vlan"),
    ("Po", "Port-channel"),
    ("Tu", "Tunnel"),
    ("Se", "Serial"),
    ("Mg", "Management"),
    ("Ma", "Management"),
];

/// Check if an interface name matches a target using abbreviation expansion.
///
/// Supports matching abbreviated names like "Gi0/0" against "GigabitEthernet0/0"
/// and vice versa. Also does case-insensitive exact match as fallback.
fn interface_name_matches(if_descr: &str, target: &str) -> bool {
    // Case-insensitive exact match
    if if_descr.eq_ignore_ascii_case(target) {
        return true;
    }

    // Try expanding the target abbreviation and match against if_descr
    for (abbrev, full) in INTERFACE_ABBREVIATIONS {
        // Target is abbreviated, if_descr is full
        if let Some(suffix) = target.strip_prefix(abbrev) {
            let expanded = format!("{}{}", full, suffix);
            if if_descr.eq_ignore_ascii_case(&expanded) {
                return true;
            }
        }
        // if_descr is abbreviated, target is full
        if let Some(suffix) = if_descr.strip_prefix(abbrev) {
            let expanded = format!("{}{}", full, suffix);
            if expanded.eq_ignore_ascii_case(target) {
                return true;
            }
        }
    }

    // Substring match as final fallback (case-insensitive)
    if_descr.to_lowercase().contains(&target.to_lowercase())
        || target.to_lowercase().contains(&if_descr.to_lowercase())
}

/// Extract a u64 value from an SnmpValue, returning 0 for missing/error values.
fn snmp_value_to_u64(val: &SnmpValue) -> Option<u64> {
    match val {
        SnmpValue::Integer(n) => Some(*n as u64),
        SnmpValue::Counter32(n) => Some(*n as u64),
        SnmpValue::Counter64(n) => Some(*n),
        SnmpValue::Gauge32(n) => Some(*n as u64),
        SnmpValue::TimeTicks(n) => Some(*n as u64),
        SnmpValue::NoSuchObject | SnmpValue::NoSuchInstance | SnmpValue::Null => None,
        _ => None,
    }
}

/// Extract a string value from an SnmpValue
fn snmp_value_to_string(val: &SnmpValue) -> String {
    match val {
        SnmpValue::String(s) => s.clone(),
        SnmpValue::OctetString(bytes) => String::from_utf8_lossy(bytes).to_string(),
        SnmpValue::NoSuchObject | SnmpValue::NoSuchInstance | SnmpValue::Null => String::new(),
        other => format!("{:?}", other),
    }
}

/// Retrieve interface statistics by name.
///
/// Walks ifDescr to find the interface index matching `interface_name`,
/// then GETs all IF-MIB counters in a single call. Prefers 64-bit HC
/// counters but falls back to 32-bit if unavailable.
///
/// # Arguments
/// * `host` - Target hostname or IP address
/// * `port` - UDP port (typically 161)
/// * `community` - SNMP community string
/// * `interface_name` - Interface name or abbreviation (e.g., "Gi0/0", "GigabitEthernet0/0")
pub async fn snmp_interface_stats(
    dest: &SnmpDest,
    community: &str,
    interface_name: &str,
) -> Result<InterfaceStats, SnmpError> {
    let (host, port) = dest.target();
    // Step 1: Walk ifDescr, ifName, and ifAlias to find the matching ifIndex.
    // LLDP port descriptions may map to ifAlias rather than ifDescr, so we
    // search all three tables to maximise the chance of a match.
    let tables = [
        "1.3.6.1.2.1.2.2.1.2",      // ifDescr  (e.g. "GigabitEthernet0/0/0")
        "1.3.6.1.2.1.31.1.1.1.1",   // ifName   (e.g. "Gi0/0/0")
        "1.3.6.1.2.1.31.1.1.1.18",  // ifAlias  (e.g. "to PE3-CHI")
    ];

    let mut found_index: Option<u64> = None;
    for table_oid in &tables {
        if found_index.is_some() {
            break;
        }
        let walk_results = match snmp_walk(dest, community, table_oid).await {
            Ok(results) => results,
            Err(_) => continue, // Table might not exist on this device
        };

        for (oid, value) in &walk_results {
            let descr = snmp_value_to_string(value);
            if interface_name_matches(&descr, interface_name) {
                // Extract ifIndex from OID suffix: table.{idx} -> last component is the index
                let stripped = oid.strip_prefix('.').unwrap_or(oid);
                if let Some(last) = stripped.rsplit('.').next() {
                    if let Ok(idx) = last.parse::<u64>() {
                        found_index = Some(idx);
                        break;
                    }
                }
            }
        }
    }

    let idx = found_index.ok_or_else(|| {
        SnmpError::InterfaceNotFound(format!(
            "Interface '{}' not found on {}:{}",
            interface_name, host, port
        ))
    })?;

    // Step 2: GET all IF-MIB counters for this index
    let oids_to_get = vec![
        format!("1.3.6.1.2.1.2.2.1.2.{}", idx),     // ifDescr
        format!("1.3.6.1.2.1.2.2.1.3.{}", idx),     // ifType
        format!("1.3.6.1.2.1.2.2.1.4.{}", idx),     // ifMtu
        format!("1.3.6.1.2.1.2.2.1.5.{}", idx),     // ifSpeed (32-bit, bps)
        format!("1.3.6.1.2.1.2.2.1.6.{}", idx),     // ifPhysAddress (MAC)
        format!("1.3.6.1.2.1.2.2.1.7.{}", idx),     // ifAdminStatus
        format!("1.3.6.1.2.1.2.2.1.8.{}", idx),     // ifOperStatus
        format!("1.3.6.1.2.1.2.2.1.9.{}", idx),     // ifLastChange
        format!("1.3.6.1.2.1.2.2.1.10.{}", idx),    // ifInOctets (32-bit)
        format!("1.3.6.1.2.1.2.2.1.11.{}", idx),    // ifInUcastPkts
        format!("1.3.6.1.2.1.2.2.1.13.{}", idx),    // ifInDiscards
        format!("1.3.6.1.2.1.2.2.1.14.{}", idx),    // ifInErrors
        format!("1.3.6.1.2.1.2.2.1.16.{}", idx),    // ifOutOctets (32-bit)
        format!("1.3.6.1.2.1.2.2.1.17.{}", idx),    // ifOutUcastPkts
        format!("1.3.6.1.2.1.2.2.1.19.{}", idx),    // ifOutDiscards
        format!("1.3.6.1.2.1.2.2.1.20.{}", idx),    // ifOutErrors
        format!("1.3.6.1.2.1.31.1.1.1.6.{}", idx),  // ifHCInOctets (64-bit)
        format!("1.3.6.1.2.1.31.1.1.1.7.{}", idx),  // ifHCInUcastPkts
        format!("1.3.6.1.2.1.31.1.1.1.8.{}", idx),  // ifHCInMulticastPkts
        format!("1.3.6.1.2.1.31.1.1.1.9.{}", idx),  // ifHCInBroadcastPkts
        format!("1.3.6.1.2.1.31.1.1.1.10.{}", idx), // ifHCOutOctets (64-bit)
        format!("1.3.6.1.2.1.31.1.1.1.11.{}", idx), // ifHCOutUcastPkts
        format!("1.3.6.1.2.1.31.1.1.1.12.{}", idx), // ifHCOutMulticastPkts
        format!("1.3.6.1.2.1.31.1.1.1.13.{}", idx), // ifHCOutBroadcastPkts
        format!("1.3.6.1.2.1.31.1.1.1.15.{}", idx), // ifHighSpeed (Mbps)
        format!("1.3.6.1.2.1.31.1.1.1.18.{}", idx), // ifAlias
    ];
    let oid_refs: Vec<&str> = oids_to_get.iter().map(|s| s.as_str()).collect();
    let values = snmp_get(dest, community, &oid_refs).await?;

    // Build a lookup map by OID suffix for easier access
    let get_val = |oid_suffix: &str| -> &SnmpValue {
        let target_oid = format!("{}.{}", oid_suffix, idx);
        for entry in &values {
            let entry_oid = entry.oid.strip_prefix('.').unwrap_or(&entry.oid);
            let target_stripped = target_oid.strip_prefix('.').unwrap_or(&target_oid);
            if entry_oid == target_stripped {
                return &entry.value;
            }
        }
        &SnmpValue::Null
    };

    let if_descr = snmp_value_to_string(get_val("1.3.6.1.2.1.2.2.1.2"));
    let if_alias = snmp_value_to_string(get_val("1.3.6.1.2.1.31.1.1.1.18"));
    let oper_status = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.8")).unwrap_or(0) as u8;
    let admin_status = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.7")).unwrap_or(0) as u8;
    let if_type = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.3")).unwrap_or(0);
    let mtu = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.4")).unwrap_or(0);
    let last_change = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.9")).unwrap_or(0);

    // MAC address: ifPhysAddress is an OctetString of 6 bytes
    let phys_address = match get_val("1.3.6.1.2.1.2.2.1.6") {
        SnmpValue::OctetString(bytes) if bytes.len() == 6 => {
            bytes.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(":")
        }
        SnmpValue::String(s) if s.len() == 6 => {
            // Sometimes returned as a 6-char string of raw bytes
            s.bytes().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(":")
        }
        SnmpValue::String(s) if s.contains(':') || s.contains('.') => s.clone(),
        _ => String::new(),
    };

    // Speed: prefer ifHighSpeed (Mbps), fallback to ifSpeed / 1_000_000
    let if_high_speed = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.15"));
    let if_speed = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.5"));
    let speed_mbps = if_high_speed.unwrap_or_else(|| if_speed.unwrap_or(0) / 1_000_000);

    // Octets: prefer HC (64-bit), fallback to 32-bit
    let hc_in = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.6"));
    let hc_out = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.10"));
    let std_in = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.10")).unwrap_or(0);
    let std_out = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.16")).unwrap_or(0);

    let (in_octets, out_octets, hc_counters) = match (hc_in, hc_out) {
        (Some(hi), Some(ho)) => (hi, ho, true),
        _ => (std_in, std_out, false),
    };

    let in_errors = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.14")).unwrap_or(0);
    let out_errors = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.20")).unwrap_or(0);
    let in_discards = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.13")).unwrap_or(0);
    let out_discards = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.19")).unwrap_or(0);

    // Packet counters: prefer HC (64-bit), fallback to 32-bit
    let in_ucast_pkts = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.7"))
        .unwrap_or_else(|| snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.11")).unwrap_or(0));
    let out_ucast_pkts = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.11"))
        .unwrap_or_else(|| snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.17")).unwrap_or(0));
    let in_multicast_pkts = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.8")).unwrap_or(0);
    let out_multicast_pkts = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.12")).unwrap_or(0);
    let in_broadcast_pkts = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.9")).unwrap_or(0);
    let out_broadcast_pkts = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.13")).unwrap_or(0);

    Ok(InterfaceStats {
        if_index: idx,
        if_descr,
        if_alias,
        oper_status,
        admin_status,
        if_type,
        mtu,
        phys_address,
        last_change,
        speed_mbps,
        in_octets,
        out_octets,
        in_errors,
        out_errors,
        in_discards,
        out_discards,
        in_ucast_pkts,
        out_ucast_pkts,
        in_multicast_pkts,
        out_multicast_pkts,
        in_broadcast_pkts,
        out_broadcast_pkts,
        hc_counters,
    })
}

/// Retrieve interface statistics for multiple interfaces on a single device.
///
/// More efficient than calling `snmp_interface_stats` N times because the
/// ifDescr walk (most expensive part) happens only once for the whole device.
/// Unmatched interface names are silently skipped (no error for missing).
///
/// # Arguments
/// * `host` - Target hostname or IP address
/// * `port` - UDP port (typically 161)
/// * `community` - SNMP community string
/// * `interface_names` - Interface names or abbreviations (e.g., ["Gi0/0", "Te1/0/1"])
pub async fn snmp_bulk_interface_stats(
    dest: &SnmpDest,
    community: &str,
    interface_names: &[String],
) -> Result<Vec<InterfaceStats>, SnmpError> {
    // Step 1: ONE ifDescr walk to build index map for the whole device
    let if_descr_oid = "1.3.6.1.2.1.2.2.1.2";
    let walk_results = snmp_walk(dest, community, if_descr_oid).await?;

    // Step 2: Match interface_names against the walk results.
    // When interface_names is empty, poll ALL discovered interfaces.
    let mut matched: Vec<(u64, String)> = Vec::new(); // (ifIndex, name)
    if interface_names.is_empty() {
        for (oid, value) in &walk_results {
            let descr = snmp_value_to_string(value);
            let stripped = oid.strip_prefix('.').unwrap_or(oid);
            if let Some(last) = stripped.rsplit('.').next() {
                if let Ok(idx) = last.parse::<u64>() {
                    matched.push((idx, descr));
                }
            }
        }
    } else {
        for iface_name in interface_names {
            for (oid, value) in &walk_results {
                let descr = snmp_value_to_string(value);
                if interface_name_matches(&descr, iface_name) {
                    let stripped = oid.strip_prefix('.').unwrap_or(oid);
                    if let Some(last) = stripped.rsplit('.').next() {
                        if let Ok(idx) = last.parse::<u64>() {
                            // Avoid duplicates (same ifIndex matched by multiple names)
                            if !matched.iter().any(|(i, _)| *i == idx) {
                                matched.push((idx, iface_name.clone()));
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    if matched.is_empty() {
        return Ok(Vec::new());
    }

    // Step 3: For each matched interface, GET all IF-MIB counters
    let mut results = Vec::with_capacity(matched.len());
    for (idx, _name) in &matched {
        let oids_to_get = vec![
            format!("1.3.6.1.2.1.2.2.1.2.{}", idx),     // ifDescr
            format!("1.3.6.1.2.1.2.2.1.3.{}", idx),     // ifType
            format!("1.3.6.1.2.1.2.2.1.4.{}", idx),     // ifMtu
            format!("1.3.6.1.2.1.2.2.1.5.{}", idx),     // ifSpeed (32-bit, bps)
            format!("1.3.6.1.2.1.2.2.1.6.{}", idx),     // ifPhysAddress (MAC)
            format!("1.3.6.1.2.1.2.2.1.7.{}", idx),     // ifAdminStatus
            format!("1.3.6.1.2.1.2.2.1.8.{}", idx),     // ifOperStatus
            format!("1.3.6.1.2.1.2.2.1.9.{}", idx),     // ifLastChange
            format!("1.3.6.1.2.1.2.2.1.10.{}", idx),    // ifInOctets (32-bit)
            format!("1.3.6.1.2.1.2.2.1.11.{}", idx),    // ifInUcastPkts
            format!("1.3.6.1.2.1.2.2.1.13.{}", idx),    // ifInDiscards
            format!("1.3.6.1.2.1.2.2.1.14.{}", idx),    // ifInErrors
            format!("1.3.6.1.2.1.2.2.1.16.{}", idx),    // ifOutOctets (32-bit)
            format!("1.3.6.1.2.1.2.2.1.17.{}", idx),    // ifOutUcastPkts
            format!("1.3.6.1.2.1.2.2.1.19.{}", idx),    // ifOutDiscards
            format!("1.3.6.1.2.1.2.2.1.20.{}", idx),    // ifOutErrors
            format!("1.3.6.1.2.1.31.1.1.1.6.{}", idx),  // ifHCInOctets (64-bit)
            format!("1.3.6.1.2.1.31.1.1.1.7.{}", idx),  // ifHCInUcastPkts
            format!("1.3.6.1.2.1.31.1.1.1.8.{}", idx),  // ifHCInMulticastPkts
            format!("1.3.6.1.2.1.31.1.1.1.9.{}", idx),  // ifHCInBroadcastPkts
            format!("1.3.6.1.2.1.31.1.1.1.10.{}", idx), // ifHCOutOctets (64-bit)
            format!("1.3.6.1.2.1.31.1.1.1.11.{}", idx), // ifHCOutUcastPkts
            format!("1.3.6.1.2.1.31.1.1.1.12.{}", idx), // ifHCOutMulticastPkts
            format!("1.3.6.1.2.1.31.1.1.1.13.{}", idx), // ifHCOutBroadcastPkts
            format!("1.3.6.1.2.1.31.1.1.1.15.{}", idx), // ifHighSpeed (Mbps)
            format!("1.3.6.1.2.1.31.1.1.1.18.{}", idx), // ifAlias
        ];
        let oid_refs: Vec<&str> = oids_to_get.iter().map(|s| s.as_str()).collect();

        match snmp_get(dest, community, &oid_refs).await {
            Ok(values) => {
                let get_val = |oid_suffix: &str| -> &SnmpValue {
                    let target_oid = format!("{}.{}", oid_suffix, idx);
                    for entry in &values {
                        let entry_oid = entry.oid.strip_prefix('.').unwrap_or(&entry.oid);
                        let target_stripped = target_oid.strip_prefix('.').unwrap_or(&target_oid);
                        if entry_oid == target_stripped {
                            return &entry.value;
                        }
                    }
                    &SnmpValue::Null
                };

                let if_descr = snmp_value_to_string(get_val("1.3.6.1.2.1.2.2.1.2"));
                let if_alias = snmp_value_to_string(get_val("1.3.6.1.2.1.31.1.1.1.18"));
                let oper_status = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.8")).unwrap_or(0) as u8;
                let admin_status = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.7")).unwrap_or(0) as u8;
                let if_type = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.3")).unwrap_or(0);
                let mtu = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.4")).unwrap_or(0);
                let last_change = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.9")).unwrap_or(0);

                let phys_address = match get_val("1.3.6.1.2.1.2.2.1.6") {
                    SnmpValue::OctetString(bytes) if bytes.len() == 6 => {
                        bytes.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(":")
                    }
                    SnmpValue::String(s) if s.len() == 6 => {
                        s.bytes().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(":")
                    }
                    SnmpValue::String(s) if s.contains(':') || s.contains('.') => s.clone(),
                    _ => String::new(),
                };

                let if_high_speed = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.15"));
                let if_speed = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.5"));
                let speed_mbps = if_high_speed.unwrap_or_else(|| if_speed.unwrap_or(0) / 1_000_000);

                let hc_in = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.6"));
                let hc_out = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.10"));
                let std_in = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.10")).unwrap_or(0);
                let std_out = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.16")).unwrap_or(0);

                let (in_octets, out_octets, hc_counters) = match (hc_in, hc_out) {
                    (Some(hi), Some(ho)) => (hi, ho, true),
                    _ => (std_in, std_out, false),
                };

                let in_errors = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.14")).unwrap_or(0);
                let out_errors = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.20")).unwrap_or(0);
                let in_discards = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.13")).unwrap_or(0);
                let out_discards = snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.19")).unwrap_or(0);

                let in_ucast_pkts = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.7"))
                    .unwrap_or_else(|| snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.11")).unwrap_or(0));
                let out_ucast_pkts = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.11"))
                    .unwrap_or_else(|| snmp_value_to_u64(get_val("1.3.6.1.2.1.2.2.1.17")).unwrap_or(0));
                let in_multicast_pkts = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.8")).unwrap_or(0);
                let out_multicast_pkts = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.12")).unwrap_or(0);
                let in_broadcast_pkts = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.9")).unwrap_or(0);
                let out_broadcast_pkts = snmp_value_to_u64(get_val("1.3.6.1.2.1.31.1.1.1.13")).unwrap_or(0);

                results.push(InterfaceStats {
                    if_index: *idx,
                    if_descr,
                    if_alias,
                    oper_status,
                    admin_status,
                    if_type,
                    mtu,
                    phys_address,
                    last_change,
                    speed_mbps,
                    in_octets,
                    out_octets,
                    in_errors,
                    out_errors,
                    in_discards,
                    out_discards,
                    in_ucast_pkts,
                    out_ucast_pkts,
                    in_multicast_pkts,
                    out_multicast_pkts,
                    in_broadcast_pkts,
                    out_broadcast_pkts,
                    hc_counters,
                });
            }
            Err(e) => {
                let (host, port) = dest.target();
                tracing::warn!(
                    "Failed to get stats for ifIndex {} on {}:{}: {}",
                    idx, host, port, e
                );
                // Skip this interface, continue with others
                continue;
            }
        }
    }

    Ok(results)
}

/// CPU and memory resource information from SNMP
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceResourceInfo {
    /// CPU utilization percentage (0-100)
    pub cpu_percent: Option<f64>,
    /// Memory used in bytes
    pub memory_used_bytes: Option<u64>,
    /// Memory free in bytes
    pub memory_free_bytes: Option<u64>,
}

/// Retrieve device CPU and memory resource info via SNMP.
///
/// Tries Cisco-specific OIDs first (cpmCPUTotal5minRev, ciscoMemoryPool),
/// then falls back to HOST-RESOURCES-MIB (hrProcessorLoad) for CPU.
/// Cost: 1-2 extra UDP round-trips per device.
pub async fn snmp_device_resources(
    dest: &SnmpDest,
    community: &str,
) -> Result<DeviceResourceInfo, SnmpError> {
    // Try Cisco-specific OIDs first (single GET for all 3)
    let cisco_cpu_oid = "1.3.6.1.4.1.9.9.109.1.1.1.1.8.1";   // cpmCPUTotal5minRev
    let cisco_mem_used_oid = "1.3.6.1.4.1.9.9.48.1.1.1.5.1";  // ciscoMemoryPoolUsed
    let cisco_mem_free_oid = "1.3.6.1.4.1.9.9.48.1.1.1.6.1";  // ciscoMemoryPoolFree

    let cisco_result = snmp_get(
        dest, community,
        &[cisco_cpu_oid, cisco_mem_used_oid, cisco_mem_free_oid],
    ).await;

    if let Ok(values) = cisco_result {
        let mut cpu_percent = None;
        let mut memory_used_bytes = None;
        let mut memory_free_bytes = None;

        for entry in &values {
            let oid = entry.oid.strip_prefix('.').unwrap_or(&entry.oid);
            if oid == "1.3.6.1.4.1.9.9.109.1.1.1.1.8.1" {
                if let Some(v) = snmp_value_to_u64(&entry.value) {
                    cpu_percent = Some(v as f64);
                }
            } else if oid == "1.3.6.1.4.1.9.9.48.1.1.1.5.1" {
                memory_used_bytes = snmp_value_to_u64(&entry.value);
            } else if oid == "1.3.6.1.4.1.9.9.48.1.1.1.6.1" {
                memory_free_bytes = snmp_value_to_u64(&entry.value);
            }
        }

        // If we got any Cisco data, return it
        if cpu_percent.is_some() || memory_used_bytes.is_some() {
            return Ok(DeviceResourceInfo {
                cpu_percent,
                memory_used_bytes,
                memory_free_bytes,
            });
        }
    }

    // Fallback: HOST-RESOURCES-MIB hrProcessorLoad (walk and average)
    let hr_processor_load_oid = "1.3.6.1.2.1.25.3.3.1.2"; // hrProcessorLoad
    let mut cpu_percent = None;

    if let Ok(entries) = snmp_walk(dest, community, hr_processor_load_oid).await {
        if !entries.is_empty() {
            let mut total: f64 = 0.0;
            let mut count: usize = 0;
            for (_oid, value) in &entries {
                if let Some(v) = snmp_value_to_u64(value) {
                    total += v as f64;
                    count += 1;
                }
            }
            if count > 0 {
                cpu_percent = Some(total / count as f64);
            }
        }
    }

    Ok(DeviceResourceInfo {
        cpu_percent,
        memory_used_bytes: None,
        memory_free_bytes: None,
    })
}

/// Device system-level info from SNMPv2-MIB
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSystemInfo {
    /// sysUpTime in hundredths of a second (TimeTicks)
    pub sys_uptime_hundredths: Option<u64>,
    /// sysDescr string (OS/firmware description)
    pub sys_descr: Option<String>,
}

/// Retrieve device system info: sysUpTime.0 and sysDescr.0 in a single GET.
///
/// Lightweight: one UDP round-trip for 2 OIDs.
pub async fn snmp_device_system_info(
    dest: &SnmpDest,
    community: &str,
) -> Result<DeviceSystemInfo, SnmpError> {
    let sys_uptime_oid = "1.3.6.1.2.1.1.3.0"; // sysUpTime.0
    let sys_descr_oid = "1.3.6.1.2.1.1.1.0";  // sysDescr.0

    let values = snmp_get(dest, community, &[sys_uptime_oid, sys_descr_oid]).await?;

    let mut sys_uptime_hundredths = None;
    let mut sys_descr = None;

    for entry in &values {
        let oid = entry.oid.strip_prefix('.').unwrap_or(&entry.oid);
        if oid == "1.3.6.1.2.1.1.3.0" {
            sys_uptime_hundredths = snmp_value_to_u64(&entry.value);
        } else if oid == "1.3.6.1.2.1.1.1.0" {
            let s = snmp_value_to_string(&entry.value);
            if !s.is_empty() {
                sys_descr = Some(s);
            }
        }
    }

    Ok(DeviceSystemInfo {
        sys_uptime_hundredths,
        sys_descr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_oid_components() {
        let result = parse_oid_components("1.3.6.1.2.1.1.1.0").unwrap();
        assert_eq!(result, vec![1, 3, 6, 1, 2, 1, 1, 1, 0]);
    }

    #[test]
    fn test_parse_oid_with_leading_dot() {
        let result = parse_oid_components(".1.3.6.1.2.1.1.1.0").unwrap();
        assert_eq!(result, vec![1, 3, 6, 1, 2, 1, 1, 1, 0]);
    }

    #[test]
    fn test_parse_oid_invalid() {
        assert!(parse_oid_components("").is_err());
        assert!(parse_oid_components("abc.def").is_err());
    }

    #[test]
    fn test_oid_starts_with() {
        assert!(oid_starts_with("1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1"));
        assert!(oid_starts_with("1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1"));
        assert!(!oid_starts_with("1.3.6.1.2.1.2.1.0", "1.3.6.1.2.1.1"));
        assert!(oid_starts_with("1.3.6.1.2.1.1", "1.3.6.1.2.1.1"));
        assert!(!oid_starts_with("1.3.6.1", "1.3.6.1.2.1.1"));
    }

    #[test]
    fn test_oid_starts_with_leading_dots() {
        assert!(oid_starts_with(".1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1"));
        assert!(oid_starts_with("1.3.6.1.2.1.1.1.0", ".1.3.6.1.2.1.1"));
    }

    #[test]
    fn test_value_type_name() {
        assert_eq!(value_type_name(&SnmpValue::Integer(42)), "Integer");
        assert_eq!(value_type_name(&SnmpValue::String("test".to_string())), "OctetString");
        assert_eq!(value_type_name(&SnmpValue::Counter32(100)), "Counter32");
        assert_eq!(value_type_name(&SnmpValue::TimeTicks(1000)), "TimeTicks");
    }

    #[test]
    fn test_interface_name_matches_exact() {
        assert!(interface_name_matches("GigabitEthernet0/0", "GigabitEthernet0/0"));
        assert!(interface_name_matches("GigabitEthernet0/0", "gigabitethernet0/0"));
    }

    #[test]
    fn test_interface_name_matches_abbreviation() {
        assert!(interface_name_matches("GigabitEthernet0/0", "Gi0/0"));
        assert!(interface_name_matches("FastEthernet0/1", "Fa0/1"));
        assert!(interface_name_matches("TenGigabitEthernet1/0/1", "Te1/0/1"));
        assert!(interface_name_matches("Ethernet1", "Et1"));
        assert!(interface_name_matches("Loopback0", "Lo0"));
    }

    #[test]
    fn test_interface_name_matches_reverse() {
        // if_descr is abbreviated, target is full
        assert!(interface_name_matches("Gi0/0", "GigabitEthernet0/0"));
    }

    #[test]
    fn test_interface_name_no_match() {
        assert!(!interface_name_matches("GigabitEthernet0/0", "GigabitEthernet0/1"));
        assert!(!interface_name_matches("GigabitEthernet0/0", "Fa0/0"));
    }

    #[test]
    fn test_snmp_value_to_u64_variants() {
        assert_eq!(snmp_value_to_u64(&SnmpValue::Integer(42)), Some(42));
        assert_eq!(snmp_value_to_u64(&SnmpValue::Counter32(100)), Some(100));
        assert_eq!(snmp_value_to_u64(&SnmpValue::Counter64(999)), Some(999));
        assert_eq!(snmp_value_to_u64(&SnmpValue::Gauge32(50)), Some(50));
        assert_eq!(snmp_value_to_u64(&SnmpValue::NoSuchObject), None);
        assert_eq!(snmp_value_to_u64(&SnmpValue::NoSuchInstance), None);
        assert_eq!(snmp_value_to_u64(&SnmpValue::Null), None);
    }
}
