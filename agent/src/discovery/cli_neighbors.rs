//! CLI-based neighbor discovery using SSH show commands
//!
//! Fallback discovery method when SNMP is unavailable. Parses output from
//! "show cdp neighbors detail" and "show lldp neighbors detail" commands
//! across Cisco IOS/NX-OS, Juniper Junos, and Arista EOS formats.
//!
//! Ported from terminal/frontend/src/lib/neighborParser.ts

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

use super::DiscoveredNeighbor;

/// Result from CLI-based neighbor discovery
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDiscoveryResult {
    /// Target host that was queried
    pub host: String,
    /// Device hostname extracted from CLI prompt
    pub device_name: Option<String>,
    /// Discovered neighbors
    pub neighbors: Vec<DiscoveredNeighbor>,
    /// Discovery method: "cdp-cli", "lldp-cli", or "none"
    pub method: String,
    /// Error message if discovery failed
    pub error: Option<String>,
}

// === Compiled regex patterns (initialized once) ===

macro_rules! regex {
    ($re:literal) => {{
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| Regex::new($re).unwrap())
    }};
}

/// Split text at positions where the given regex matches, keeping the
/// matched text as the start of each subsequent block.
/// This replaces JavaScript's split-with-lookahead pattern.
fn split_keeping_delimiter<'a>(text: &'a str, pattern: &Regex) -> Vec<&'a str> {
    let mut blocks = Vec::new();
    let mut last_start = 0;

    for mat in pattern.find_iter(text) {
        if mat.start() > last_start {
            let chunk = &text[last_start..mat.start()];
            if !chunk.trim().is_empty() {
                blocks.push(chunk);
            }
        }
        last_start = mat.start();
    }

    if last_start < text.len() {
        let chunk = &text[last_start..];
        if !chunk.trim().is_empty() {
            blocks.push(chunk);
        }
    }

    blocks
}

// === Detection Functions ===

/// Check if output is from a CDP command
pub fn _is_cdp_output(output: &str) -> bool {
    if output.trim().is_empty() {
        return false;
    }
    regex!(r"(?im)^Device ID:").is_match(output)
        || regex!(r"(?i)CDP\s+neighbor").is_match(output)
}

/// Check if output is from an LLDP command
pub fn _is_lldp_output(output: &str) -> bool {
    if output.trim().is_empty() {
        return false;
    }
    regex!(r"(?im)^Chassis id:").is_match(output)
        || regex!(r"(?i)LLDP\s+neighbor").is_match(output)
        || regex!(r"(?im)^Local Intf:").is_match(output)
        || is_arista_lldp(output)
        || is_juniper_lldp(output)
}

/// Check if output is Arista-specific LLDP format
fn is_arista_lldp(output: &str) -> bool {
    if output.trim().is_empty() {
        return false;
    }
    regex!(r"(?im)^Interface\s+\S+\s+detected\s+\d+\s+LLDP\s+neighbor").is_match(output)
}

/// Check if output is Juniper-specific LLDP format
fn is_juniper_lldp(output: &str) -> bool {
    if output.trim().is_empty() {
        return false;
    }
    regex!(r"(?im)^LLDP Neighbor Information:").is_match(output)
}

// === CDP Parser (Cisco IOS/NX-OS) ===

/// Parse Cisco CDP "show cdp neighbors detail" output
pub fn parse_cdp_output(output: &str) -> Vec<DiscoveredNeighbor> {
    if output.trim().is_empty() {
        return Vec::new();
    }

    let splitter = regex!(r"(?m)^Device ID:");
    let blocks = split_keeping_delimiter(output, splitter);

    let mut neighbors = Vec::new();
    for block in blocks {
        if let Some(neighbor) = parse_cdp_block(block) {
            neighbors.push(neighbor);
        }
    }
    neighbors
}

fn parse_cdp_block(block: &str) -> Option<DiscoveredNeighbor> {
    // Device ID (required)
    let device_re = regex!(r"(?im)^Device ID:\s*(.+?)$");
    let neighbor_name = device_re
        .captures(block)?
        .get(1)?
        .as_str()
        .trim()
        .to_string();
    if neighbor_name.is_empty() {
        return None;
    }

    // Local interface (required)
    let intf_re = regex!(r"(?im)^Interface:\s*(\S+)\s*,");
    let local_interface = intf_re
        .captures(block)?
        .get(1)?
        .as_str()
        .trim()
        .to_string();

    // IP address (optional)
    let ip_re = regex!(r"(?im)(?:IP(?:v4)?\s+[Aa]ddress|Entry address\(es\)|Mgmt address):\s*\n?\s*([\d.]+)");
    let ip_alt_re = regex!(r"(?im)^\s+IP(?:v4)?\s+[Aa]ddress:\s*([\d.]+)");
    let neighbor_ip = ip_re
        .captures(block)
        .or_else(|| ip_alt_re.captures(block))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());

    // Platform (optional)
    let platform_re = regex!(r"(?im)^Platform:\s*(.+?)(?:,|$)");
    let neighbor_platform = platform_re
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());

    // Port ID / remote port (optional)
    let port_re = regex!(r"(?im)Port ID\s*\(outgoing port\):\s*(\S+)");
    let neighbor_interface = port_re
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());

    Some(DiscoveredNeighbor {
        local_interface,
        neighbor_name,
        neighbor_ip,
        neighbor_interface,
        neighbor_platform,
        protocol: "cdp".to_string(),
    })
}

// === LLDP Parser (dispatches to vendor-specific parsers) ===

/// Parse LLDP neighbor output, auto-detecting vendor format
pub fn parse_lldp_output(output: &str) -> Vec<DiscoveredNeighbor> {
    if output.trim().is_empty() {
        return Vec::new();
    }

    if is_juniper_lldp(output) {
        return parse_juniper_lldp(output);
    }

    if is_arista_lldp(output) {
        return parse_arista_lldp(output);
    }

    // Default: Cisco LLDP format
    parse_cisco_lldp(output)
}

// === Cisco LLDP Parser ===

fn parse_cisco_lldp(output: &str) -> Vec<DiscoveredNeighbor> {
    let blocks = if regex!(r"(?im)^Local Intf:").is_match(output) {
        split_keeping_delimiter(output, regex!(r"(?m)^Local Intf:"))
    } else {
        split_keeping_delimiter(output, regex!(r"(?m)^Chassis id:"))
    };

    let mut neighbors = Vec::new();
    for block in blocks {
        if let Some(neighbor) = parse_cisco_lldp_block(block) {
            neighbors.push(neighbor);
        }
    }
    neighbors
}

fn parse_cisco_lldp_block(block: &str) -> Option<DiscoveredNeighbor> {
    // Local interface (required)
    let local_intf_re = regex!(r"(?im)^Local Intf:\s*(\S+)");
    let local_interface = local_intf_re
        .captures(block)?
        .get(1)?
        .as_str()
        .trim()
        .to_string();

    // System Name (preferred) or Chassis ID (fallback)
    let sys_name_re = regex!(r"(?im)^System Name:\s*(.+?)$");
    let chassis_re = regex!(r"(?im)^Chassis id:\s*(\S+)");
    let neighbor_name = sys_name_re
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
        .or_else(|| {
            chassis_re
                .captures(block)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().trim().to_string())
        })?;

    if neighbor_name.is_empty() {
        return None;
    }

    // Management IP (optional)
    let mgmt_re = regex!(r"(?im)^Management Addresses?:?\s*\n?\s*(?:IP(?:v4)?:\s*)?([\d.]+)");
    let mgmt_alt_re = regex!(r"(?im)^\s+IP:\s*([\d.]+)");
    let neighbor_ip = mgmt_re
        .captures(block)
        .or_else(|| mgmt_alt_re.captures(block))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());

    // Port ID (preferred) or Port Description (fallback)
    let port_id_re = regex!(r"(?im)^Port id:\s*(.+?)$");
    let port_desc_re = regex!(r"(?im)^Port Description:\s*(.+?)$");
    let neighbor_interface = port_id_re
        .captures(block)
        .or_else(|| port_desc_re.captures(block))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());

    // System Description first line (optional)
    let sys_desc_re = regex!(r"(?im)^System Description:\s*\n?\s*(.+?)$");
    let neighbor_platform = sys_desc_re
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().split('\n').next().unwrap_or("").trim().to_string())
        .filter(|s| !s.is_empty());

    Some(DiscoveredNeighbor {
        local_interface,
        neighbor_name,
        neighbor_ip,
        neighbor_interface,
        neighbor_platform,
        protocol: "lldp".to_string(),
    })
}

// === Juniper LLDP Parser ===

fn parse_juniper_lldp(output: &str) -> Vec<DiscoveredNeighbor> {
    let blocks = split_keeping_delimiter(output, regex!(r"(?m)^LLDP Neighbor Information:"));

    let mut neighbors = Vec::new();
    for block in blocks {
        if let Some(neighbor) = parse_juniper_lldp_block(block) {
            neighbors.push(neighbor);
        }
    }
    neighbors
}

fn parse_juniper_lldp_block(block: &str) -> Option<DiscoveredNeighbor> {
    // Must contain the header
    if !regex!(r"(?im)^LLDP Neighbor Information:").is_match(block) {
        return None;
    }

    // Local interface (required)
    let local_re = regex!(r"(?im)^Local Interface\s+:\s*(\S+)");
    let local_interface = local_re
        .captures(block)?
        .get(1)?
        .as_str()
        .trim()
        .to_string();

    // System name (preferred) or Chassis ID (fallback)
    let sys_name_re = regex!(r"(?im)^System name\s+:\s*(.+?)$");
    let chassis_re = regex!(r"(?im)^Chassis ID\s+:\s*(\S+)");
    let neighbor_name = sys_name_re
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
        .or_else(|| {
            chassis_re
                .captures(block)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().trim().to_string())
        })?;

    if neighbor_name.is_empty() {
        return None;
    }

    // Management IP — look for IPv4 address after "Address Type : IPv4"
    let mgmt_re = regex!(r"(?im)^\s+Address\s+:\s*([\d.]+)");
    let neighbor_ip = mgmt_re
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());

    // Port ID
    let port_re = regex!(r"(?im)^Port ID\s+:\s*(.+?)$");
    let neighbor_interface = port_re
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());

    // System Description first line
    let sys_desc_re = regex!(r"(?im)^System Description\s+:\s*(.+?)$");
    let neighbor_platform = sys_desc_re
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().split('\n').next().unwrap_or("").trim().to_string())
        .filter(|s| !s.is_empty());

    Some(DiscoveredNeighbor {
        local_interface,
        neighbor_name,
        neighbor_ip,
        neighbor_interface,
        neighbor_platform,
        protocol: "lldp".to_string(),
    })
}

// === Arista LLDP Parser ===

fn parse_arista_lldp(output: &str) -> Vec<DiscoveredNeighbor> {
    let blocks = split_keeping_delimiter(output, regex!(r"(?m)^Interface\s+\S+\s+detected\s+\d+\s+LLDP\s+neighbor"));

    let mut neighbors = Vec::new();
    for block in blocks {
        if let Some(neighbor) = parse_arista_lldp_block(block) {
            neighbors.push(neighbor);
        }
    }
    neighbors
}

fn parse_arista_lldp_block(block: &str) -> Option<DiscoveredNeighbor> {
    // Local interface from header (required)
    let intf_re = regex!(r"(?im)^Interface\s+(\S+)\s+detected\s+\d+\s+LLDP\s+neighbor");
    let local_interface = intf_re
        .captures(block)?
        .get(1)?
        .as_str()
        .trim()
        .to_string();

    // System Name (preferred, strip quotes) or Chassis ID (fallback)
    let sys_name_re = regex!(r#"(?im)System Name\s*:\s*"?([^"\n]+)"?"#);
    let chassis_re = regex!(r"(?im)Chassis ID\s+:\s*(\S+)");
    let neighbor_name = sys_name_re
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().trim_matches('"').to_string())
        .or_else(|| {
            chassis_re
                .captures(block)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().trim().to_string())
        })?;

    if neighbor_name.is_empty() {
        return None;
    }

    // Management IP
    let mgmt_re = regex!(r"(?im)Management Address\s+:\s*([\d.]+)");
    let neighbor_ip = mgmt_re
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());

    // Port ID (strip quotes)
    let port_re = regex!(r#"(?im)Port ID\s+:\s*"?([^"\n]+)"?"#);
    let port_desc_re = regex!(r#"(?im)Port Description:\s*"?([^"\n]+)"?"#);
    let neighbor_interface = port_re
        .captures(block)
        .or_else(|| port_desc_re.captures(block))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().trim_matches('"').to_string());

    // System Description (strip quotes)
    let sys_desc_re = regex!(r#"(?im)System Description:\s*"?([^"\n]+)"?"#);
    let neighbor_platform = sys_desc_re
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty());

    Some(DiscoveredNeighbor {
        local_interface,
        neighbor_name,
        neighbor_ip,
        neighbor_interface,
        neighbor_platform,
        protocol: "lldp".to_string(),
    })
}

// === Auto-detect and parse ===

/// Auto-detect protocol and parse neighbor output.
/// Returns (neighbors, method) where method is "cdp", "lldp", or "none".
pub fn _parse_neighbor_output(output: &str) -> (Vec<DiscoveredNeighbor>, String) {
    if _is_cdp_output(output) {
        let neighbors = parse_cdp_output(output);
        if !neighbors.is_empty() {
            return (neighbors, "cdp".to_string());
        }
    }

    if _is_lldp_output(output) {
        let neighbors = parse_lldp_output(output);
        if !neighbors.is_empty() {
            return (neighbors, "lldp".to_string());
        }
    }

    (Vec::new(), "none".to_string())
}

/// Extract device hostname from CLI output prompt pattern
fn extract_device_name(output: &str) -> Option<String> {
    let prompt_re = regex!(r"(?m)^(\S+)[>#]");
    prompt_re
        .captures(output)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

// === SSH Execution Wrapper ===

/// Discover neighbors by SSHing to a device and running show commands.
///
/// Tries CDP first ("show cdp neighbors detail"), then LLDP
/// ("show lldp neighbors detail"). Parses the output and returns
/// structured neighbor entries.
pub async fn discover_cli_neighbors(
    host: &str,
    port: u16,
    username: &str,
    auth: crate::ssh::SshAuth,
    legacy_ssh: bool,
) -> CliDiscoveryResult {
    let config = crate::ssh::SshConfig {
        host: host.to_string(),
        port,
        username: username.to_string(),
        auth,
        legacy_ssh,
        skip_keyboard_interactive: false,
    };

    let session_id = uuid::Uuid::new_v4().to_string();
    let session_name = host.to_string();
    let timeout = Duration::from_secs(15);

    // Try CDP first
    let cdp_result = crate::ssh::execute_command_on_session(
        config.clone(),
        session_id.clone(),
        session_name.clone(),
        "show cdp neighbors detail".to_string(),
        timeout,
    )
    .await;

    match &cdp_result.status {
        crate::ssh::CommandStatus::Success => {
            let cdp_neighbors = parse_cdp_output(&cdp_result.output);
            if !cdp_neighbors.is_empty() {
                let device_name = extract_device_name(&cdp_result.output);
                return CliDiscoveryResult {
                    host: host.to_string(),
                    device_name,
                    neighbors: cdp_neighbors,
                    method: "cdp-cli".to_string(),
                    error: None,
                };
            }
        }
        _ => {
            tracing::debug!("CDP command failed on {}: {:?}", host, cdp_result.error);
        }
    }

    // Try LLDP
    let lldp_result = crate::ssh::execute_command_on_session(
        config,
        session_id,
        session_name,
        "show lldp neighbors detail".to_string(),
        timeout,
    )
    .await;

    match &lldp_result.status {
        crate::ssh::CommandStatus::Success => {
            let lldp_neighbors = parse_lldp_output(&lldp_result.output);
            if !lldp_neighbors.is_empty() {
                let device_name = extract_device_name(&lldp_result.output);
                return CliDiscoveryResult {
                    host: host.to_string(),
                    device_name,
                    neighbors: lldp_neighbors,
                    method: "lldp-cli".to_string(),
                    error: None,
                };
            }
        }
        _ => {
            tracing::debug!("LLDP command failed on {}: {:?}", host, lldp_result.error);
        }
    }

    // Neither produced results
    let error = if cdp_result.error.is_some() || lldp_result.error.is_some() {
        Some(format!(
            "CDP: {}; LLDP: {}",
            cdp_result.error.unwrap_or_else(|| "no neighbors".to_string()),
            lldp_result.error.unwrap_or_else(|| "no neighbors".to_string()),
        ))
    } else {
        None
    };

    CliDiscoveryResult {
        host: host.to_string(),
        device_name: extract_device_name(&cdp_result.output)
            .or_else(|| extract_device_name(&lldp_result.output)),
        neighbors: Vec::new(),
        method: "none".to_string(),
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // === CDP Tests ===

    #[test]
    fn test_parse_cdp_cisco_ios() {
        let output = r#"router1#show cdp neighbors detail
Device ID: switch1.example.com
Entry address(es):
  IP address: 192.168.1.10
Platform: Cisco WS-C3850-24T, Capabilities: Switch IGMP
Interface: GigabitEthernet0/0, Port ID (outgoing port): GigabitEthernet1/0/1
Holdtime : 162 sec

-------------------------
Device ID: router2.example.com
Entry address(es):
  IP address: 10.0.0.2
Platform: Cisco ISR4451-X/K9, Capabilities: Router Switch IGMP
Interface: GigabitEthernet0/1, Port ID (outgoing port): GigabitEthernet0/0/0
Holdtime : 155 sec
"#;

        let neighbors = parse_cdp_output(output);
        assert_eq!(neighbors.len(), 2);

        assert_eq!(neighbors[0].neighbor_name, "switch1.example.com");
        assert_eq!(neighbors[0].neighbor_ip, Some("192.168.1.10".to_string()));
        assert_eq!(neighbors[0].local_interface, "GigabitEthernet0/0");
        assert_eq!(
            neighbors[0].neighbor_interface,
            Some("GigabitEthernet1/0/1".to_string())
        );
        assert_eq!(
            neighbors[0].neighbor_platform,
            Some("Cisco WS-C3850-24T".to_string())
        );
        assert_eq!(neighbors[0].protocol, "cdp");

        assert_eq!(neighbors[1].neighbor_name, "router2.example.com");
        assert_eq!(neighbors[1].neighbor_ip, Some("10.0.0.2".to_string()));
        assert_eq!(neighbors[1].local_interface, "GigabitEthernet0/1");
    }

    // === Cisco LLDP Tests ===

    #[test]
    fn test_parse_lldp_cisco() {
        let output = r#"router1#show lldp neighbors detail
Local Intf: Gi0/0
Chassis id: 001e.6840.1234
Port id: Gi1/0/1
Port Description: GigabitEthernet1/0/1
System Name: switch1.example.com

System Description:
Cisco IOS Software, Catalyst 3850

Management Addresses:
  IP: 192.168.1.10

-------------------------------------------
Local Intf: Gi0/1
Chassis id: 0050.5678.abcd
Port id: Te1/0/1
Port Description: TenGigabitEthernet1/0/1
System Name: router2.example.com

System Description:
Juniper Junos 21.2R3

Management Addresses:
  IP: 10.0.0.2
"#;

        let neighbors = parse_lldp_output(output);
        assert_eq!(neighbors.len(), 2);

        assert_eq!(neighbors[0].local_interface, "Gi0/0");
        assert_eq!(neighbors[0].neighbor_name, "switch1.example.com");
        assert_eq!(neighbors[0].neighbor_ip, Some("192.168.1.10".to_string()));
        assert_eq!(
            neighbors[0].neighbor_interface,
            Some("Gi1/0/1".to_string())
        );
        assert_eq!(
            neighbors[0].neighbor_platform,
            Some("Cisco IOS Software, Catalyst 3850".to_string())
        );
        assert_eq!(neighbors[0].protocol, "lldp");

        assert_eq!(neighbors[1].local_interface, "Gi0/1");
        assert_eq!(neighbors[1].neighbor_name, "router2.example.com");
        assert_eq!(neighbors[1].neighbor_ip, Some("10.0.0.2".to_string()));
    }

    // === Juniper LLDP Tests ===

    #[test]
    fn test_parse_lldp_juniper() {
        let output = r#"LLDP Neighbor Information:
Local Interface    : ge-0/0/0
Chassis ID         : 00:1e:68:40:12:34
Port ID            : ge-0/0/1
Port description   : ge-0/0/1
System name        : switch1.example.com
System Description : Juniper Networks, Inc. EX4300-48T

  Address Type : IPv4
  Address      : 192.168.1.10

LLDP Neighbor Information:
Local Interface    : ge-0/0/1
Chassis ID         : 00:50:56:78:ab:cd
Port ID            : Ethernet1
Port description   : Ethernet1
System name        : leaf1.dc1
System Description : Arista Networks EOS 4.28.3M

  Address Type : IPv4
  Address      : 10.0.0.5
"#;

        let neighbors = parse_lldp_output(output);
        assert_eq!(neighbors.len(), 2);

        assert_eq!(neighbors[0].local_interface, "ge-0/0/0");
        assert_eq!(neighbors[0].neighbor_name, "switch1.example.com");
        assert_eq!(neighbors[0].neighbor_ip, Some("192.168.1.10".to_string()));
        assert_eq!(
            neighbors[0].neighbor_interface,
            Some("ge-0/0/1".to_string())
        );
        assert_eq!(
            neighbors[0].neighbor_platform,
            Some("Juniper Networks, Inc. EX4300-48T".to_string())
        );

        assert_eq!(neighbors[1].local_interface, "ge-0/0/1");
        assert_eq!(neighbors[1].neighbor_name, "leaf1.dc1");
        assert_eq!(neighbors[1].neighbor_ip, Some("10.0.0.5".to_string()));
    }

    // === Arista LLDP Tests ===

    #[test]
    fn test_parse_lldp_arista() {
        let output = r#"Interface Ethernet1 detected 1 LLDP neighbors:
  Chassis ID   : 001e.6840.1234
  Port ID      : "GigabitEthernet0/1"
  Port Description: "GigabitEthernet0/1"
  System Name  : "router1.example.com"
  System Description: "Cisco IOS Software, ISR 4451"
  Management Address : 192.168.1.1

Interface Ethernet2 detected 1 LLDP neighbors:
  Chassis ID   : 0050.5678.abcd
  Port ID      : "ge-0/0/0"
  Port Description: "ge-0/0/0"
  System Name  : "spine1.dc1"
  System Description: "Juniper Networks EX9208"
  Management Address : 10.0.0.100
"#;

        let neighbors = parse_lldp_output(output);
        assert_eq!(neighbors.len(), 2);

        assert_eq!(neighbors[0].local_interface, "Ethernet1");
        assert_eq!(neighbors[0].neighbor_name, "router1.example.com");
        assert_eq!(neighbors[0].neighbor_ip, Some("192.168.1.1".to_string()));
        assert_eq!(
            neighbors[0].neighbor_interface,
            Some("GigabitEthernet0/1".to_string())
        );
        assert_eq!(
            neighbors[0].neighbor_platform,
            Some("Cisco IOS Software, ISR 4451".to_string())
        );

        assert_eq!(neighbors[1].local_interface, "Ethernet2");
        assert_eq!(neighbors[1].neighbor_name, "spine1.dc1");
        assert_eq!(neighbors[1].neighbor_ip, Some("10.0.0.100".to_string()));
    }

    // === Edge cases ===

    #[test]
    fn test_parse_empty_output() {
        assert!(parse_cdp_output("").is_empty());
        assert!(parse_lldp_output("").is_empty());
        assert!(parse_cdp_output("   \n  ").is_empty());
        assert!(parse_lldp_output("   \n  ").is_empty());
    }

    #[test]
    fn test_auto_detect_cdp() {
        let output = "Device ID: switch1\nInterface: Gi0/0, Port ID (outgoing port): Gi1/0/1\n";
        assert!(_is_cdp_output(output));
        assert!(!_is_lldp_output(output));
    }

    #[test]
    fn test_auto_detect_lldp() {
        let output = "Chassis id: 001e.6840.1234\nLocal Intf: Gi0/0\nSystem Name: switch1\n";
        assert!(_is_lldp_output(output));
    }

    #[test]
    fn test_auto_detect_juniper_lldp() {
        let output = "LLDP Neighbor Information:\nLocal Interface    : ge-0/0/0\n";
        assert!(_is_lldp_output(output));
        assert!(is_juniper_lldp(output));
    }

    #[test]
    fn test_auto_detect_arista_lldp() {
        let output = "Interface Ethernet1 detected 1 LLDP neighbors:\n";
        assert!(_is_lldp_output(output));
        assert!(is_arista_lldp(output));
    }

    #[test]
    fn test__parse_neighbor_output_auto_detect() {
        let cdp_output = r#"Device ID: switch1
Interface: Gi0/0, Port ID (outgoing port): Gi1/0/1
"#;
        let (neighbors, method) = _parse_neighbor_output(cdp_output);
        assert_eq!(method, "cdp");
        assert_eq!(neighbors.len(), 1);
        assert_eq!(neighbors[0].neighbor_name, "switch1");
    }

    #[test]
    fn test_extract_device_name() {
        assert_eq!(
            extract_device_name("router1#show cdp neighbors detail\n"),
            Some("router1".to_string())
        );
        assert_eq!(
            extract_device_name("switch1>show lldp neighbors\n"),
            Some("switch1".to_string())
        );
        assert_eq!(extract_device_name("no prompt here\n"), None);
    }

    #[test]
    fn test_cli_discovery_result_serialization() {
        let result = CliDiscoveryResult {
            host: "10.0.0.1".to_string(),
            device_name: Some("router1".to_string()),
            neighbors: vec![],
            method: "cdp-cli".to_string(),
            error: None,
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"deviceName\""));
        assert!(json.contains("\"method\""));
    }
}
