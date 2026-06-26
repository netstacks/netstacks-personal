//! SNMP-based neighbor discovery using LLDP-MIB and CDP-MIB
//!
//! Primary discovery method. Walks LLDP and CDP MIB tables via SNMP v2c
//! and returns structured neighbor lists. Falls back from LLDP to CDP
//! automatically.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::snmp::{self, SnmpValue};

// === LLDP-MIB OID Constants ===
// IEEE 802.1AB LLDP Management Information Base
// Indexed by timeMark.localPortNum.remIndex

/// lldpRemSysName — remote system name
const LLDP_REM_SYS_NAME: &str = "1.0.8802.1.1.2.1.4.1.1.9";
/// lldpRemPortId — remote port identifier
const LLDP_REM_PORT_ID: &str = "1.0.8802.1.1.2.1.4.1.1.7";
/// lldpRemPortDesc — remote port description
const LLDP_REM_PORT_DESC: &str = "1.0.8802.1.1.2.1.4.1.1.8";
/// lldpRemSysDesc — remote system description
const LLDP_REM_SYS_DESC: &str = "1.0.8802.1.1.2.1.4.1.1.10";
/// lldpRemManAddrIfSubtype — remote management address
/// Indexed by timeMark.localPortNum.remIndex.addrSubtype.addr
const LLDP_REM_MAN_ADDR: &str = "1.0.8802.1.1.2.1.4.2.1.4";
/// lldpLocPortId — local port identifier (usually interface name), indexed by localPortNum
const LLDP_LOC_PORT_ID: &str = "1.0.8802.1.1.2.1.3.7.1.3";
/// lldpLocPortDesc — local port description, indexed by localPortNum
const LLDP_LOC_PORT_DESC: &str = "1.0.8802.1.1.2.1.3.7.1.4";
/// sysName.0
const SYS_NAME_OID: &str = "1.3.6.1.2.1.1.5.0";
/// sysDescr.0
const SYS_DESCR_OID: &str = "1.3.6.1.2.1.1.1.0";

// === CDP-MIB OID Constants ===
// Cisco Discovery Protocol MIB
// Indexed by ifIndex.deviceIndex

/// cdpCacheDeviceId — neighbor device identifier
const CDP_CACHE_DEVICE_ID: &str = "1.3.6.1.4.1.9.9.23.1.2.1.1.6";
/// cdpCacheAddress — neighbor address (4 bytes IPv4)
const CDP_CACHE_ADDRESS: &str = "1.3.6.1.4.1.9.9.23.1.2.1.1.4";
/// cdpCachePlatform — neighbor platform string
const CDP_CACHE_PLATFORM: &str = "1.3.6.1.4.1.9.9.23.1.2.1.1.8";
/// cdpCacheDevicePort — neighbor port/interface
const CDP_CACHE_DEVICE_PORT: &str = "1.3.6.1.4.1.9.9.23.1.2.1.1.7";

// === Types ===

/// A discovered neighbor device from SNMP or CLI discovery
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredNeighbor {
    /// Local interface where the neighbor was seen
    pub local_interface: String,
    /// Neighbor device hostname or system name
    pub neighbor_name: String,
    /// Neighbor management IP address (if available)
    pub neighbor_ip: Option<String>,
    /// Neighbor remote interface/port
    pub neighbor_interface: Option<String>,
    /// Neighbor platform or system description
    pub neighbor_platform: Option<String>,
    /// Discovery protocol used: "lldp", "cdp", "lldp-cli", "cdp-cli"
    pub protocol: String,
}

/// Result from SNMP-based neighbor discovery
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnmpDiscoveryResult {
    /// Target host that was queried
    pub host: String,
    /// sysName of the queried device
    pub sys_name: Option<String>,
    /// sysDescr of the queried device (platform/vendor/version info)
    pub sys_descr: Option<String>,
    /// Discovered neighbors
    pub neighbors: Vec<DiscoveredNeighbor>,
    /// Discovery method used: "lldp", "cdp", or "none"
    pub method: String,
    /// Error message if discovery failed
    pub error: Option<String>,
}

// === Helper Functions ===

/// Extract the index suffix from an OID after stripping a known prefix.
///
/// Example: oid="1.0.8802.1.1.2.1.4.1.1.9.0.1.1", prefix="1.0.8802.1.1.2.1.4.1.1.9"
/// Returns Some("0.1.1")
fn extract_index_suffix(oid: &str, prefix: &str) -> Option<String> {
    let oid_clean = oid.strip_prefix('.').unwrap_or(oid);
    let prefix_clean = prefix.strip_prefix('.').unwrap_or(prefix);

    if oid_clean.len() <= prefix_clean.len() {
        return None;
    }

    if !oid_clean.starts_with(prefix_clean) {
        return None;
    }

    let suffix = &oid_clean[prefix_clean.len()..];
    let suffix = suffix.strip_prefix('.').unwrap_or(suffix);

    if suffix.is_empty() {
        None
    } else {
        Some(suffix.to_string())
    }
}

/// Extract a string from an SnmpValue, returning None for Null/NoSuchObject/NoSuchInstance
fn snmp_value_to_string_lossy(val: &SnmpValue) -> Option<String> {
    match val {
        SnmpValue::String(s) => {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        }
        SnmpValue::OctetString(bytes) => {
            let s = String::from_utf8_lossy(bytes).trim().to_string();
            if s.is_empty() { None } else { Some(s) }
        }
        SnmpValue::Null | SnmpValue::NoSuchObject | SnmpValue::NoSuchInstance => None,
        _ => None,
    }
}

/// Convert a 4-byte OctetString SNMP value to a dotted IPv4 address string
fn snmp_value_to_ipv4(val: &SnmpValue) -> Option<String> {
    match val {
        SnmpValue::OctetString(bytes) if bytes.len() == 4 => {
            Some(format!("{}.{}.{}.{}", bytes[0], bytes[1], bytes[2], bytes[3]))
        }
        SnmpValue::IpAddress(ip) => Some(ip.clone()),
        SnmpValue::String(s) => {
            // Sometimes CDP addresses come as printable strings
            let bytes = s.as_bytes();
            if bytes.len() == 4 {
                Some(format!("{}.{}.{}.{}", bytes[0], bytes[1], bytes[2], bytes[3]))
            } else {
                // Try parsing as a dotted-decimal IP already
                if s.contains('.') && s.split('.').count() == 4 {
                    Some(s.trim().to_string())
                } else {
                    None
                }
            }
        }
        _ => None,
    }
}

/// Extract LLDP management IP from management address table entries.
///
/// LLDP management addresses have complex indexing:
/// timeMark.localPortNum.remIndex.addrSubtype.addrLen.addr...
///
/// The InetAddress (lldpRemManAddr) is encoded as a length-prefixed sequence
/// in the OID index per SMIv2 rules. For IPv4 (addrSubtype=1):
///   remaining = "1.4.a.b.c.d"
///   parts[0]=addrSubtype(1), parts[1]=addrLen(4), parts[2..6]=IP octets
fn extract_lldp_mgmt_ip(
    entries: &[(String, SnmpValue)],
    prefix: &str,
    neighbor_key: &str,
) -> Option<String> {
    for (oid, _value) in entries {
        if let Some(suffix) = extract_index_suffix(oid, prefix) {
            // suffix format: timeMark.localPortNum.remIndex.addrSubtype.addrLen.a.b.c.d
            // neighbor_key is: timeMark.localPortNum.remIndex
            if suffix.starts_with(neighbor_key) {
                let remaining = &suffix[neighbor_key.len()..];
                let remaining = remaining.strip_prefix('.').unwrap_or(remaining);
                let parts: Vec<&str> = remaining.split('.').collect();
                // parts[0] = addrSubtype (1=IPv4)
                // parts[1] = addrLen (4 for IPv4)
                // parts[2..6] = IP octets
                if parts.len() >= 6 && parts[0] == "1" && parts[1] == "4" {
                    if let (Ok(a), Ok(b), Ok(c), Ok(d)) = (
                        parts[2].parse::<u8>(),
                        parts[3].parse::<u8>(),
                        parts[4].parse::<u8>(),
                        parts[5].parse::<u8>(),
                    ) {
                        return Some(format!("{}.{}.{}.{}", a, b, c, d));
                    }
                }
            }
        }
    }
    None
}

/// Build a map from walk results keyed by index suffix
fn build_walk_map(
    entries: &[(String, SnmpValue)],
    prefix: &str,
) -> HashMap<String, SnmpValue> {
    let mut map = HashMap::new();
    for (oid, value) in entries {
        if let Some(suffix) = extract_index_suffix(oid, prefix) {
            map.insert(suffix, value.clone());
        }
    }
    map
}

/// Extract the LLDP 3-component key (timeMark.localPortNum.remIndex) from a full suffix
fn lldp_neighbor_key(suffix: &str) -> Option<String> {
    let parts: Vec<&str> = suffix.split('.').collect();
    if parts.len() >= 3 {
        Some(format!("{}.{}.{}", parts[0], parts[1], parts[2]))
    } else {
        None
    }
}

/// Extract the local port number from an LLDP index suffix
fn lldp_local_port_num(suffix: &str) -> Option<String> {
    let parts: Vec<&str> = suffix.split('.').collect();
    if parts.len() >= 2 {
        Some(parts[1].to_string())
    } else {
        None
    }
}

// === Public Discovery Functions ===

/// Discover neighbors via LLDP-MIB SNMP walks.
///
/// Walks all LLDP remote tables concurrently and correlates entries by
/// their 3-component index (timeMark.localPortNum.remIndex).
pub async fn discover_lldp_neighbors(
    dest: &snmp::SnmpDest,
    community: &str,
) -> Result<Vec<DiscoveredNeighbor>, String> {
    let (host, port) = match dest {
        snmp::SnmpDest::Direct { host, port } => (host.as_str(), *port),
        snmp::SnmpDest::ViaJump { target_host, target_port, .. } => (target_host.as_str(), *target_port),
    };
    tracing::debug!("Starting LLDP SNMP discovery on {}:{}", host, port);

    // Walk only the REMOTE tables — these are bounded by neighbor count
    // (typically <20) rather than interface count. The LOCAL port tables
    // (lldpLocPortDesc/lldpLocPortId) used to be walked too, but on devices
    // with hundreds of LLDP-enabled ports those walks dominated the
    // discovery time and tripped the 30s timeout. We now do targeted GETs
    // for only the local ports that actually have a neighbor (see below).
    let (sys_name_result, port_id_result, port_desc_result, sys_desc_result, man_addr_result) = tokio::join!(
        snmp::snmp_walk(dest, community, LLDP_REM_SYS_NAME),
        snmp::snmp_walk(dest, community, LLDP_REM_PORT_ID),
        snmp::snmp_walk(dest, community, LLDP_REM_PORT_DESC),
        snmp::snmp_walk(dest, community, LLDP_REM_SYS_DESC),
        snmp::snmp_walk(dest, community, LLDP_REM_MAN_ADDR),
    );

    let sys_names = sys_name_result.map_err(|e| format!("LLDP SysName walk failed: {}", e))?;

    if sys_names.is_empty() {
        tracing::debug!("LLDP: No remote system names found on {}", host);
        return Ok(Vec::new());
    }

    let port_ids = port_id_result.unwrap_or_default();
    let port_descs = port_desc_result.unwrap_or_default();
    let sys_descs = sys_desc_result.unwrap_or_default();
    let man_addrs = man_addr_result.unwrap_or_default();

    // Build remote-table lookup maps
    let sys_name_map = build_walk_map(&sys_names, LLDP_REM_SYS_NAME);
    let port_id_map = build_walk_map(&port_ids, LLDP_REM_PORT_ID);
    let port_desc_map = build_walk_map(&port_descs, LLDP_REM_PORT_DESC);
    let sys_desc_map = build_walk_map(&sys_descs, LLDP_REM_SYS_DESC);

    // Targeted GET for local-port info, ONLY for ports that have a neighbor.
    // Each REM_SYS_NAME suffix is `timeMark.lldpRemLocalPortNum.remIndex`;
    // the middle component is the local port number we need to look up.
    let mut local_ports: std::collections::HashSet<String> = std::collections::HashSet::new();
    for suffix in sys_name_map.keys() {
        if let Some(p) = lldp_local_port_num(suffix) {
            local_ports.insert(p);
        }
    }
    let mut loc_oids: Vec<String> = Vec::with_capacity(local_ports.len() * 2);
    for p in &local_ports {
        loc_oids.push(format!("{}.{}", LLDP_LOC_PORT_ID, p));
        loc_oids.push(format!("{}.{}", LLDP_LOC_PORT_DESC, p));
    }
    let loc_port_id_map: HashMap<String, SnmpValue>;
    let loc_port_map: HashMap<String, SnmpValue>;
    if loc_oids.is_empty() {
        loc_port_id_map = HashMap::new();
        loc_port_map = HashMap::new();
    } else {
        let oid_refs: Vec<&str> = loc_oids.iter().map(|s| s.as_str()).collect();
        match snmp::snmp_get(dest, community, &oid_refs).await {
            Ok(entries) => {
                let pairs: Vec<(String, SnmpValue)> = entries.into_iter().map(|e| (e.oid, e.value)).collect();
                loc_port_id_map = build_walk_map(&pairs, LLDP_LOC_PORT_ID);
                loc_port_map = build_walk_map(&pairs, LLDP_LOC_PORT_DESC);
            }
            Err(e) => {
                tracing::debug!("LLDP local-port batch GET failed on {}: {} — proceeding with port number only", host, e);
                loc_port_id_map = HashMap::new();
                loc_port_map = HashMap::new();
            }
        }
    }

    // Collect unique neighbor keys from sys_name entries
    let mut neighbors = Vec::new();
    let mut seen_keys = std::collections::HashSet::new();

    for suffix in sys_name_map.keys() {
        let key = match lldp_neighbor_key(suffix) {
            Some(k) => k,
            None => continue,
        };

        if !seen_keys.insert(key.clone()) {
            continue;
        }

        // Neighbor name (required)
        let sys_name_value = match sys_name_map.get(suffix) {
            Some(v) => v,
            None => continue, // key from own iterator; should not happen
        };
        let neighbor_name = match snmp_value_to_string_lossy(sys_name_value) {
            Some(name) => name,
            None => continue,
        };

        // Neighbor interface: prefer PortId, fallback to PortDesc
        let neighbor_interface = snmp_value_to_string_lossy(
            port_id_map.get(suffix).unwrap_or(&SnmpValue::Null),
        )
        .or_else(|| {
            snmp_value_to_string_lossy(
                port_desc_map.get(suffix).unwrap_or(&SnmpValue::Null),
            )
        });

        // Neighbor platform: first line of system description
        let neighbor_platform = snmp_value_to_string_lossy(
            sys_desc_map.get(suffix).unwrap_or(&SnmpValue::Null),
        )
        .map(|desc| desc.lines().next().unwrap_or("").trim().to_string())
        .filter(|s| !s.is_empty());

        // Management IP from LLDP management address table
        let neighbor_ip = extract_lldp_mgmt_ip(&man_addrs, LLDP_REM_MAN_ADDR, &key);

        // Local interface: prefer lldpLocPortId (actual interface name like "Ethernet1")
        // over lldpLocPortDesc (admin description like "to PE3-CHI").
        // Fall back to port description if port ID is a MAC address or empty.
        let local_interface = lldp_local_port_num(suffix)
            .and_then(|port_num| {
                // Try port ID first (usually the real interface name)
                let port_id = snmp_value_to_string_lossy(
                    loc_port_id_map.get(&port_num).unwrap_or(&SnmpValue::Null),
                );
                // Use port ID if it looks like an interface name (contains a letter + digit)
                if let Some(ref id) = port_id {
                    if !id.is_empty() && id.chars().any(|c| c.is_alphabetic()) && id.chars().any(|c| c.is_ascii_digit()) && !id.contains(':') {
                        return Some(id.clone());
                    }
                }
                // Fall back to port description
                snmp_value_to_string_lossy(
                    loc_port_map.get(&port_num).unwrap_or(&SnmpValue::Null),
                )
            })
            .unwrap_or_else(|| {
                lldp_local_port_num(suffix).unwrap_or_else(|| "unknown".to_string())
            });

        neighbors.push(DiscoveredNeighbor {
            local_interface,
            neighbor_name,
            neighbor_ip,
            neighbor_interface,
            neighbor_platform,
            protocol: "lldp".to_string(),
        });
    }

    tracing::debug!("LLDP: Found {} neighbors on {}", neighbors.len(), host);
    Ok(neighbors)
}

/// Discover neighbors via CDP-MIB SNMP walks.
///
/// Walks CDP cache tables and correlates entries by their
/// 2-component index (ifIndex.deviceIndex).
pub async fn discover_cdp_neighbors(
    dest: &snmp::SnmpDest,
    community: &str,
) -> Result<Vec<DiscoveredNeighbor>, String> {
    let (host, port) = match dest {
        snmp::SnmpDest::Direct { host, port } => (host.as_str(), *port),
        snmp::SnmpDest::ViaJump { target_host, target_port, .. } => (target_host.as_str(), *target_port),
    };
    tracing::debug!("Starting CDP SNMP discovery on {}:{}", host, port);

    // Walk all CDP tables concurrently
    let (device_id_result, address_result, platform_result, device_port_result) = tokio::join!(
        snmp::snmp_walk(dest, community, CDP_CACHE_DEVICE_ID),
        snmp::snmp_walk(dest, community, CDP_CACHE_ADDRESS),
        snmp::snmp_walk(dest, community, CDP_CACHE_PLATFORM),
        snmp::snmp_walk(dest, community, CDP_CACHE_DEVICE_PORT),
    );

    let device_ids = device_id_result.map_err(|e| format!("CDP DeviceId walk failed: {}", e))?;

    if device_ids.is_empty() {
        tracing::debug!("CDP: No neighbor device IDs found on {}", host);
        return Ok(Vec::new());
    }

    let addresses = address_result.unwrap_or_default();
    let platforms = platform_result.unwrap_or_default();
    let device_ports = device_port_result.unwrap_or_default();

    // Build lookup maps
    let device_id_map = build_walk_map(&device_ids, CDP_CACHE_DEVICE_ID);
    let address_map = build_walk_map(&addresses, CDP_CACHE_ADDRESS);
    let platform_map = build_walk_map(&platforms, CDP_CACHE_PLATFORM);
    let device_port_map = build_walk_map(&device_ports, CDP_CACHE_DEVICE_PORT);

    // Cache for ifIndex -> interface name resolution
    let mut if_name_cache: HashMap<String, String> = HashMap::new();

    let mut neighbors = Vec::new();

    for (suffix, device_id_value) in &device_id_map {
        // Neighbor name (required)
        let neighbor_name = match snmp_value_to_string_lossy(device_id_value) {
            Some(name) => name,
            None => continue,
        };

        // Neighbor IP from CDP address (4-byte OctetString)
        let neighbor_ip = address_map
            .get(suffix)
            .and_then(snmp_value_to_ipv4);

        // Neighbor platform
        let neighbor_platform = snmp_value_to_string_lossy(
            platform_map.get(suffix).unwrap_or(&SnmpValue::Null),
        );

        // Neighbor interface
        let neighbor_interface = snmp_value_to_string_lossy(
            device_port_map.get(suffix).unwrap_or(&SnmpValue::Null),
        );

        // Local interface: first component of suffix is ifIndex
        let if_index = suffix.split('.').next().unwrap_or("0").to_string();
        let local_interface = if let Some(cached) = if_name_cache.get(&if_index) {
            cached.clone()
        } else {
            // Resolve ifIndex to ifDescr via SNMP GET
            let if_descr_oid = format!("1.3.6.1.2.1.2.2.1.2.{}", if_index);
            let name = match snmp::snmp_get(dest, community, &[&if_descr_oid]).await {
                Ok(values) => values
                    .first()
                    .and_then(|v| snmp_value_to_string_lossy(&v.value))
                    .unwrap_or_else(|| format!("ifIndex-{}", if_index)),
                Err(_) => format!("ifIndex-{}", if_index),
            };
            if_name_cache.insert(if_index.clone(), name.clone());
            name
        };

        neighbors.push(DiscoveredNeighbor {
            local_interface,
            neighbor_name,
            neighbor_ip,
            neighbor_interface,
            neighbor_platform,
            protocol: "cdp".to_string(),
        });
    }

    tracing::debug!("CDP: Found {} neighbors on {}", neighbors.len(), host);
    Ok(neighbors)
}

/// Combined SNMP neighbor discovery: tries LLDP first, falls back to CDP.
///
/// Returns an SnmpDiscoveryResult with the device sysName, discovered neighbors,
/// the method used, and any error that occurred. Never panics.
pub async fn discover_snmp_neighbors(
    dest: &snmp::SnmpDest,
    community: &str,
) -> SnmpDiscoveryResult {
    let (host, port) = match dest {
        snmp::SnmpDest::Direct { host, port } => (host.as_str(), *port),
        snmp::SnmpDest::ViaJump { target_host, target_port, .. } => (target_host.as_str(), *target_port),
    };
    let _ = port; // host is used for tracing/result building; port currently isn't needed here

    // Get sysName and sysDescr first (response varbinds are in request order)
    let (sys_name, sys_descr) = match snmp::snmp_get(dest, community, &[SYS_NAME_OID, SYS_DESCR_OID]).await {
        Ok(values) => {
            let name = values.first().and_then(|v| snmp_value_to_string_lossy(&v.value));
            let descr = values.get(1).and_then(|v| snmp_value_to_string_lossy(&v.value));
            (name, descr)
        }
        Err(e) => {
            tracing::debug!("Could not get sysName/sysDescr from {}: {}", host, e);
            (None, None)
        }
    };

    // Try LLDP first
    match discover_lldp_neighbors(dest, community).await {
        Ok(neighbors) if !neighbors.is_empty() => {
            return SnmpDiscoveryResult {
                host: host.to_string(),
                sys_name,
                sys_descr,
                neighbors,
                method: "lldp".to_string(),
                error: None,
            };
        }
        Ok(_) => {
            tracing::debug!("LLDP returned empty for {}, trying CDP", host);
        }
        Err(lldp_err) => {
            tracing::warn!("LLDP failed for {}: {}, trying CDP", host, lldp_err);
            // Try CDP as fallback
            match discover_cdp_neighbors(dest, community).await {
                Ok(neighbors) if !neighbors.is_empty() => {
                    return SnmpDiscoveryResult {
                        host: host.to_string(),
                        sys_name,
                        sys_descr,
                        neighbors,
                        method: "cdp".to_string(),
                        error: None,
                    };
                }
                Ok(_) => {
                    return SnmpDiscoveryResult {
                        host: host.to_string(),
                        sys_name,
                        sys_descr,
                        neighbors: Vec::new(),
                        method: "none".to_string(),
                        error: Some(format!("LLDP error: {}; CDP returned no neighbors", lldp_err)),
                    };
                }
                Err(cdp_err) => {
                    return SnmpDiscoveryResult {
                        host: host.to_string(),
                        sys_name,
                        sys_descr,
                        neighbors: Vec::new(),
                        method: "none".to_string(),
                        error: Some(format!("LLDP error: {}; CDP error: {}", lldp_err, cdp_err)),
                    };
                }
            }
        }
    }

    // LLDP returned empty, try CDP
    match discover_cdp_neighbors(dest, community).await {
        Ok(neighbors) if !neighbors.is_empty() => {
            SnmpDiscoveryResult {
                host: host.to_string(),
                sys_name,
                sys_descr,
                neighbors,
                method: "cdp".to_string(),
                error: None,
            }
        }
        Ok(_) => {
            SnmpDiscoveryResult {
                host: host.to_string(),
                sys_name,
                sys_descr,
                neighbors: Vec::new(),
                method: "none".to_string(),
                error: None,
            }
        }
        Err(cdp_err) => {
            SnmpDiscoveryResult {
                host: host.to_string(),
                sys_name,
                sys_descr,
                neighbors: Vec::new(),
                method: "none".to_string(),
                error: Some(format!("CDP error: {}", cdp_err)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_index_suffix() {
        // LLDP case: timeMark.localPortNum.remIndex
        assert_eq!(
            extract_index_suffix(
                "1.0.8802.1.1.2.1.4.1.1.9.0.1.1",
                "1.0.8802.1.1.2.1.4.1.1.9"
            ),
            Some("0.1.1".to_string())
        );

        // CDP case: ifIndex.deviceIndex
        assert_eq!(
            extract_index_suffix(
                "1.3.6.1.4.1.9.9.23.1.2.1.1.6.3.1",
                "1.3.6.1.4.1.9.9.23.1.2.1.1.6"
            ),
            Some("3.1".to_string())
        );

        // Leading dots
        assert_eq!(
            extract_index_suffix(
                ".1.3.6.1.4.1.9.9.23.1.2.1.1.6.3.1",
                "1.3.6.1.4.1.9.9.23.1.2.1.1.6"
            ),
            Some("3.1".to_string())
        );

        // Exact match (no suffix)
        assert_eq!(
            extract_index_suffix(
                "1.3.6.1.2.1.1.5.0",
                "1.3.6.1.2.1.1.5.0"
            ),
            None
        );

        // Non-matching prefix
        assert_eq!(
            extract_index_suffix(
                "1.3.6.1.2.1.2",
                "1.3.6.1.4.1"
            ),
            None
        );
    }

    #[test]
    fn test_snmp_value_to_string_lossy() {
        assert_eq!(
            snmp_value_to_string_lossy(&SnmpValue::String("switch1".to_string())),
            Some("switch1".to_string())
        );
        assert_eq!(
            snmp_value_to_string_lossy(&SnmpValue::OctetString(b"router1".to_vec())),
            Some("router1".to_string())
        );
        assert_eq!(snmp_value_to_string_lossy(&SnmpValue::Null), None);
        assert_eq!(snmp_value_to_string_lossy(&SnmpValue::NoSuchObject), None);
        assert_eq!(snmp_value_to_string_lossy(&SnmpValue::NoSuchInstance), None);
        assert_eq!(
            snmp_value_to_string_lossy(&SnmpValue::String("  ".to_string())),
            None
        );
    }

    #[test]
    fn test_snmp_value_to_ipv4() {
        // 4-byte OctetString
        assert_eq!(
            snmp_value_to_ipv4(&SnmpValue::OctetString(vec![192, 168, 1, 1])),
            Some("192.168.1.1".to_string())
        );

        // IpAddress type
        assert_eq!(
            snmp_value_to_ipv4(&SnmpValue::IpAddress("10.0.0.1".to_string())),
            Some("10.0.0.1".to_string())
        );

        // Wrong length OctetString
        assert_eq!(
            snmp_value_to_ipv4(&SnmpValue::OctetString(vec![192, 168])),
            None
        );

        // Null
        assert_eq!(snmp_value_to_ipv4(&SnmpValue::Null), None);
    }

    #[test]
    fn test_extract_lldp_mgmt_ip() {
        // Simulated management address entries
        // OID format: prefix.timeMark.localPortNum.remIndex.addrSubtype.addrLen.a.b.c.d
        // InetAddress is length-prefixed in the OID index per SMIv2 rules
        let entries = vec![
            (
                "1.0.8802.1.1.2.1.4.2.1.4.0.1.1.1.4.10.0.0.1".to_string(),
                SnmpValue::Integer(2), // value doesn't matter, IP is in OID
            ),
            (
                "1.0.8802.1.1.2.1.4.2.1.4.0.2.1.1.4.172.16.0.5".to_string(),
                SnmpValue::Integer(2),
            ),
        ];

        // Neighbor key "0.1.1" should match the first entry
        assert_eq!(
            extract_lldp_mgmt_ip(&entries, LLDP_REM_MAN_ADDR, "0.1.1"),
            Some("10.0.0.1".to_string())
        );

        // Neighbor key "0.2.1" should match the second entry
        assert_eq!(
            extract_lldp_mgmt_ip(&entries, LLDP_REM_MAN_ADDR, "0.2.1"),
            Some("172.16.0.5".to_string())
        );

        // Non-existent key
        assert_eq!(
            extract_lldp_mgmt_ip(&entries, LLDP_REM_MAN_ADDR, "0.3.1"),
            None
        );
    }

    #[test]
    fn test_parse_lldp_walk_results() {
        // Simulate LLDP walk results for 2 neighbors
        // Neighbor 1: index 0.1.1 (timeMark=0, localPort=1, remIndex=1)
        // Neighbor 2: index 0.2.1 (timeMark=0, localPort=2, remIndex=1)

        let sys_names = vec![
            ("1.0.8802.1.1.2.1.4.1.1.9.0.1.1".to_string(), SnmpValue::String("switch1.example.com".to_string())),
            ("1.0.8802.1.1.2.1.4.1.1.9.0.2.1".to_string(), SnmpValue::String("router2.example.com".to_string())),
        ];

        let port_ids = vec![
            ("1.0.8802.1.1.2.1.4.1.1.7.0.1.1".to_string(), SnmpValue::String("Gi0/1".to_string())),
            ("1.0.8802.1.1.2.1.4.1.1.7.0.2.1".to_string(), SnmpValue::String("Te1/0/1".to_string())),
        ];

        let sys_descs = vec![
            ("1.0.8802.1.1.2.1.4.1.1.10.0.1.1".to_string(), SnmpValue::String("Cisco IOS Software\nCatalyst 3850".to_string())),
            ("1.0.8802.1.1.2.1.4.1.1.10.0.2.1".to_string(), SnmpValue::String("Juniper Junos 21.2R3".to_string())),
        ];

        let loc_ports = vec![
            ("1.0.8802.1.1.2.1.3.7.1.4.1".to_string(), SnmpValue::String("GigabitEthernet0/0".to_string())),
            ("1.0.8802.1.1.2.1.3.7.1.4.2".to_string(), SnmpValue::String("GigabitEthernet0/1".to_string())),
        ];

        let man_addrs = vec![
            ("1.0.8802.1.1.2.1.4.2.1.4.0.1.1.1.4.192.168.1.10".to_string(), SnmpValue::Integer(2)),
            ("1.0.8802.1.1.2.1.4.2.1.4.0.2.1.1.4.10.0.0.2".to_string(), SnmpValue::Integer(2)),
        ];

        // Build maps
        let sys_name_map = build_walk_map(&sys_names, LLDP_REM_SYS_NAME);
        let port_id_map = build_walk_map(&port_ids, LLDP_REM_PORT_ID);
        let sys_desc_map = build_walk_map(&sys_descs, LLDP_REM_SYS_DESC);
        let loc_port_map = build_walk_map(&loc_ports, LLDP_LOC_PORT_DESC);

        // Parse neighbors
        let mut neighbors = Vec::new();
        let mut seen_keys = std::collections::HashSet::new();

        for suffix in sys_name_map.keys() {
            let key = match lldp_neighbor_key(suffix) {
                Some(k) => k,
                None => continue,
            };
            if !seen_keys.insert(key.clone()) {
                continue;
            }

            let neighbor_name = snmp_value_to_string_lossy(sys_name_map.get(suffix).unwrap()).unwrap();
            let neighbor_interface = snmp_value_to_string_lossy(port_id_map.get(suffix).unwrap_or(&SnmpValue::Null));
            let neighbor_platform = snmp_value_to_string_lossy(sys_desc_map.get(suffix).unwrap_or(&SnmpValue::Null))
                .map(|desc| desc.lines().next().unwrap_or("").trim().to_string());
            let neighbor_ip = extract_lldp_mgmt_ip(&man_addrs, LLDP_REM_MAN_ADDR, &key);
            let local_interface = lldp_local_port_num(suffix)
                .and_then(|pn| snmp_value_to_string_lossy(loc_port_map.get(&pn).unwrap_or(&SnmpValue::Null)))
                .unwrap_or_else(|| "unknown".to_string());

            neighbors.push(DiscoveredNeighbor {
                local_interface,
                neighbor_name,
                neighbor_ip,
                neighbor_interface,
                neighbor_platform,
                protocol: "lldp".to_string(),
            });
        }

        assert_eq!(neighbors.len(), 2);

        // Sort for deterministic assertions
        neighbors.sort_by(|a, b| a.neighbor_name.cmp(&b.neighbor_name));

        let n1 = &neighbors[0]; // router2
        assert_eq!(n1.neighbor_name, "router2.example.com");
        assert_eq!(n1.neighbor_ip, Some("10.0.0.2".to_string()));
        assert_eq!(n1.neighbor_interface, Some("Te1/0/1".to_string()));
        assert_eq!(n1.neighbor_platform, Some("Juniper Junos 21.2R3".to_string()));
        assert_eq!(n1.local_interface, "GigabitEthernet0/1");

        let n2 = &neighbors[1]; // switch1
        assert_eq!(n2.neighbor_name, "switch1.example.com");
        assert_eq!(n2.neighbor_ip, Some("192.168.1.10".to_string()));
        assert_eq!(n2.neighbor_interface, Some("Gi0/1".to_string()));
        assert_eq!(n2.neighbor_platform, Some("Cisco IOS Software".to_string()));
        assert_eq!(n2.local_interface, "GigabitEthernet0/0");
    }

    #[test]
    fn test_parse_cdp_walk_results() {
        // Simulate CDP walk results for 2 neighbors
        // Neighbor 1: index 3.1 (ifIndex=3, deviceIndex=1)
        // Neighbor 2: index 5.1 (ifIndex=5, deviceIndex=1)

        let device_ids = vec![
            ("1.3.6.1.4.1.9.9.23.1.2.1.1.6.3.1".to_string(), SnmpValue::String("switch1.local".to_string())),
            ("1.3.6.1.4.1.9.9.23.1.2.1.1.6.5.1".to_string(), SnmpValue::String("router2.local".to_string())),
        ];

        let addresses = vec![
            ("1.3.6.1.4.1.9.9.23.1.2.1.1.4.3.1".to_string(), SnmpValue::OctetString(vec![192, 168, 1, 10])),
            ("1.3.6.1.4.1.9.9.23.1.2.1.1.4.5.1".to_string(), SnmpValue::OctetString(vec![10, 0, 0, 2])),
        ];

        let platforms = vec![
            ("1.3.6.1.4.1.9.9.23.1.2.1.1.8.3.1".to_string(), SnmpValue::String("Cisco Catalyst 3850".to_string())),
            ("1.3.6.1.4.1.9.9.23.1.2.1.1.8.5.1".to_string(), SnmpValue::String("Cisco ISR 4451".to_string())),
        ];

        let device_ports = vec![
            ("1.3.6.1.4.1.9.9.23.1.2.1.1.7.3.1".to_string(), SnmpValue::String("GigabitEthernet0/1".to_string())),
            ("1.3.6.1.4.1.9.9.23.1.2.1.1.7.5.1".to_string(), SnmpValue::String("TenGigabitEthernet1/0/1".to_string())),
        ];

        let device_id_map = build_walk_map(&device_ids, CDP_CACHE_DEVICE_ID);
        let address_map = build_walk_map(&addresses, CDP_CACHE_ADDRESS);
        let platform_map = build_walk_map(&platforms, CDP_CACHE_PLATFORM);
        let device_port_map = build_walk_map(&device_ports, CDP_CACHE_DEVICE_PORT);

        let mut neighbors = Vec::new();

        for (suffix, device_id_value) in &device_id_map {
            let neighbor_name = snmp_value_to_string_lossy(device_id_value).unwrap();
            let neighbor_ip = address_map.get(suffix).and_then(snmp_value_to_ipv4);
            let neighbor_platform = snmp_value_to_string_lossy(platform_map.get(suffix).unwrap_or(&SnmpValue::Null));
            let neighbor_interface = snmp_value_to_string_lossy(device_port_map.get(suffix).unwrap_or(&SnmpValue::Null));
            let if_index = suffix.split('.').next().unwrap_or("0");

            neighbors.push(DiscoveredNeighbor {
                local_interface: format!("ifIndex-{}", if_index),
                neighbor_name,
                neighbor_ip,
                neighbor_interface,
                neighbor_platform,
                protocol: "cdp".to_string(),
            });
        }

        assert_eq!(neighbors.len(), 2);

        neighbors.sort_by(|a, b| a.neighbor_name.cmp(&b.neighbor_name));

        let n1 = &neighbors[0];
        assert_eq!(n1.neighbor_name, "router2.local");
        assert_eq!(n1.neighbor_ip, Some("10.0.0.2".to_string()));
        assert_eq!(n1.neighbor_interface, Some("TenGigabitEthernet1/0/1".to_string()));
        assert_eq!(n1.neighbor_platform, Some("Cisco ISR 4451".to_string()));
        assert_eq!(n1.protocol, "cdp");

        let n2 = &neighbors[1];
        assert_eq!(n2.neighbor_name, "switch1.local");
        assert_eq!(n2.neighbor_ip, Some("192.168.1.10".to_string()));
    }

    #[test]
    fn test_empty_walk_returns_empty() {
        let empty: Vec<(String, SnmpValue)> = Vec::new();
        let map = build_walk_map(&empty, LLDP_REM_SYS_NAME);
        assert!(map.is_empty());
    }

    #[test]
    fn test_lldp_neighbor_key() {
        assert_eq!(lldp_neighbor_key("0.1.1"), Some("0.1.1".to_string()));
        assert_eq!(lldp_neighbor_key("0.2.1"), Some("0.2.1".to_string()));
        assert_eq!(lldp_neighbor_key("0.1"), None);
        assert_eq!(lldp_neighbor_key(""), None);
    }

    #[test]
    fn test_discovered_neighbor_serialization() {
        let neighbor = DiscoveredNeighbor {
            local_interface: "Gi0/0".to_string(),
            neighbor_name: "switch1".to_string(),
            neighbor_ip: Some("10.0.0.1".to_string()),
            neighbor_interface: Some("Gi0/1".to_string()),
            neighbor_platform: Some("Cisco IOS".to_string()),
            protocol: "lldp".to_string(),
        };

        let json = serde_json::to_string(&neighbor).unwrap();
        assert!(json.contains("\"localInterface\""));
        assert!(json.contains("\"neighborName\""));
        assert!(json.contains("\"neighborIp\""));
        assert!(json.contains("\"neighborInterface\""));
        assert!(json.contains("\"neighborPlatform\""));
    }

    #[test]
    fn test_snmp_discovery_result_serialization() {
        let result = SnmpDiscoveryResult {
            host: "192.168.1.1".to_string(),
            sys_name: Some("router1".to_string()),
            sys_descr: Some("Cisco IOS XR Software, Version 7.3.2".to_string()),
            neighbors: vec![],
            method: "lldp".to_string(),
            error: None,
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"sysName\""));
        assert!(json.contains("\"method\""));
    }
}
