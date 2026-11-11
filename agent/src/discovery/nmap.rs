//! Nmap fingerprinting for unknown/unreachable IPs
//!
//! Runs nmap with service version detection and optional OS detection
//! (when passwordless sudo is available). Parses XML output into structured results.
//! Enforces a 15-second timeout to prevent hanging scans.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::process::Command;

/// A discovered port from nmap scan
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NmapPort {
    /// Port number
    pub port: u16,
    /// Protocol: "tcp" or "udp"
    pub protocol: String,
    /// Port state: "open", "closed", "filtered"
    pub state: String,
    /// Service name (e.g., "ssh", "https")
    pub service: Option<String>,
    /// Service version string
    pub version: Option<String>,
}

/// Result from an nmap fingerprint scan
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NmapResult {
    /// Target host
    pub host: String,
    /// Host state: "up" or "down"
    pub state: String,
    /// OS family (e.g., "Linux", "IOS")
    pub os_family: Option<String>,
    /// OS match string (e.g., "Cisco IOS 15.x")
    pub os_match: Option<String>,
    /// OS detection accuracy percentage
    pub os_accuracy: Option<u8>,
    /// Discovered open ports
    pub ports: Vec<NmapPort>,
    /// MAC address if detected
    pub mac_address: Option<String>,
    /// Hardware vendor from MAC
    pub vendor: Option<String>,
    /// Scan duration in milliseconds
    pub scan_time_ms: u64,
    /// Error message if scan failed
    pub error: Option<String>,
}

/// Nmap scan timeout
const NMAP_TIMEOUT: Duration = Duration::from_secs(15);

// === Availability Checks ===

/// Check if the nmap binary is available on this system
pub async fn check_nmap_available() -> bool {
    match Command::new("nmap").arg("--version").output().await {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

/// Check if passwordless sudo is available (for OS detection and SYN scans)
pub async fn check_sudo_available() -> bool {
    match Command::new("sudo").args(["-n", "true"]).output().await {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

// === Nmap Execution ===

/// Run nmap fingerprinting against a host.
///
/// If `use_sudo` is true, runs with sudo for OS detection (-O) and SYN scan (-sS).
/// Otherwise uses TCP connect scan (-sT) which doesn't need root.
/// Enforces a 15-second timeout.
pub async fn nmap_fingerprint(host: &str, use_sudo: bool) -> NmapResult {
    let start = Instant::now();

    let mut args = Vec::new();

    if use_sudo {
        // With sudo: SYN scan + OS detection
        args.extend_from_slice(&[
            "-sS",            // SYN scan (needs root)
            "-sV",            // Service version detection
            "-O",             // OS detection (needs root)
            "--top-ports", "100",
            "-T4",            // Aggressive timing
            "--max-retries", "1",
            "-oX", "-",       // XML output to stdout
            host,
        ]);
    } else {
        // Without sudo: TCP connect scan, no OS detection
        args.extend_from_slice(&[
            "-sT",            // TCP connect scan (no root needed)
            "-sV",            // Service version detection
            "--top-ports", "100",
            "-T4",
            "--max-retries", "1",
            "-oX", "-",
            host,
        ]);
    }

    let cmd = if use_sudo {
        let mut cmd = Command::new("sudo");
        cmd.arg("nmap");
        cmd.args(&args);
        cmd
    } else {
        let mut cmd = Command::new("nmap");
        cmd.args(&args);
        cmd
    };

    // Execute with timeout
    let result = tokio::time::timeout(NMAP_TIMEOUT, execute_nmap(cmd)).await;

    let elapsed = start.elapsed().as_millis() as u64;

    match result {
        Ok(Ok(xml_output)) => {
            let mut parsed = parse_nmap_xml(&xml_output);
            parsed.host = host.to_string();
            parsed.scan_time_ms = elapsed;
            parsed
        }
        Ok(Err(error)) => NmapResult {
            host: host.to_string(),
            state: "unknown".to_string(),
            os_family: None,
            os_match: None,
            os_accuracy: None,
            ports: Vec::new(),
            mac_address: None,
            vendor: None,
            scan_time_ms: elapsed,
            error: Some(error),
        },
        Err(_) => NmapResult {
            host: host.to_string(),
            state: "unknown".to_string(),
            os_family: None,
            os_match: None,
            os_accuracy: None,
            ports: Vec::new(),
            mac_address: None,
            vendor: None,
            scan_time_ms: elapsed,
            error: Some("Nmap scan timed out after 15 seconds".to_string()),
        },
    }
}

async fn execute_nmap(mut cmd: Command) -> Result<String, String> {
    let output = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn nmap: {}", e))?
        .wait_with_output()
        .await
        .map_err(|e| format!("Failed to execute nmap: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // nmap often returns non-zero for hosts that are down but still produces XML
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.contains("<nmaprun") {
            // We have XML output, use it despite non-zero exit
            return Ok(stdout.to_string());
        }
        return Err(format!("Nmap exited with {}: {}", output.status, stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// === XML Parser ===

macro_rules! nmap_regex {
    ($re:literal) => {{
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| Regex::new($re).unwrap())
    }};
}

/// Parse nmap XML output into NmapResult.
///
/// Uses regex patterns for extraction since nmap XML is well-structured.
/// Handles full output, minimal output, host-down, and malformed input.
pub fn parse_nmap_xml(xml: &str) -> NmapResult {
    let mut result = NmapResult {
        host: String::new(),
        state: "unknown".to_string(),
        os_family: None,
        os_match: None,
        os_accuracy: None,
        ports: Vec::new(),
        mac_address: None,
        vendor: None,
        scan_time_ms: 0,
        error: None,
    };

    if xml.trim().is_empty() || !xml.contains("<nmaprun") {
        result.error = Some("Invalid or empty nmap XML output".to_string());
        return result;
    }

    // Host state
    let state_re = nmap_regex!(r#"<status state="([^"]+)""#);
    if let Some(caps) = state_re.captures(xml) {
        result.state = caps[1].to_string();
    }

    // If host is down, return early
    if result.state == "down" {
        return result;
    }

    // Parse ports
    // Match port elements with their service info
    // Port pattern: <port protocol="tcp" portid="22">...<state state="open"/>...<service name="ssh".../>...</port>
    let port_re = nmap_regex!(r#"<port protocol="([^"]+)" portid="(\d+)">([\s\S]*?)</port>"#);
    let state_attr_re = nmap_regex!(r#"<state state="([^"]+)""#);
    let service_re = nmap_regex!(r#"<service name="([^"]*)""#);
    let product_re = nmap_regex!(r#"product="([^"]*)""#);
    let version_re = nmap_regex!(r#"version="([^"]*)""#);

    for caps in port_re.captures_iter(xml) {
        let protocol = caps[1].to_string();
        let port: u16 = match caps[2].parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let port_content = &caps[3];

        let state = state_attr_re
            .captures(port_content)
            .map(|c| c[1].to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let service = service_re
            .captures(port_content)
            .map(|c| c[1].to_string())
            .filter(|s| !s.is_empty());

        let product = product_re
            .captures(port_content)
            .map(|c| c[1].to_string())
            .filter(|s| !s.is_empty());

        let ver = version_re
            .captures(port_content)
            .map(|c| c[1].to_string())
            .filter(|s| !s.is_empty());

        let version = match (product, ver) {
            (Some(p), Some(v)) => Some(format!("{} {}", p, v)),
            (Some(p), None) => Some(p),
            (None, Some(v)) => Some(v),
            (None, None) => None,
        };

        result.ports.push(NmapPort {
            port,
            protocol,
            state,
            service,
            version,
        });
    }

    // Parse OS match (highest accuracy)
    let osmatch_re = nmap_regex!(r#"<osmatch name="([^"]+)" accuracy="(\d+)""#);
    let mut best_accuracy: u8 = 0;
    for caps in osmatch_re.captures_iter(xml) {
        let accuracy: u8 = caps[2].parse().unwrap_or(0);
        if accuracy > best_accuracy {
            best_accuracy = accuracy;
            result.os_match = Some(caps[1].to_string());
            result.os_accuracy = Some(accuracy);
        }
    }

    // Parse OS family
    let osclass_re = nmap_regex!(r#"<osclass[^>]*?family="([^"]+)""#);
    if let Some(caps) = osclass_re.captures(xml) {
        result.os_family = Some(caps[1].to_string());
    }

    // Parse MAC address and vendor
    let mac_re = nmap_regex!(r#"<address addr="([^"]+)" addrtype="mac""#);
    if let Some(caps) = mac_re.captures(xml) {
        result.mac_address = Some(caps[1].to_string());
    }

    let vendor_re = nmap_regex!(r#"<address[^>]*addrtype="mac"[^>]*vendor="([^"]+)""#);
    if result.mac_address.is_some() {
        if let Some(caps) = vendor_re.captures(xml) {
            result.vendor = Some(caps[1].to_string());
        } else {
            // Try alternate order
            let vendor_alt_re = nmap_regex!(r#"<address[^>]*vendor="([^"]+)"[^>]*addrtype="mac""#);
            if let Some(caps) = vendor_alt_re.captures(xml) {
                result.vendor = Some(caps[1].to_string());
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_nmap_xml_full() {
        let xml = r#"<?xml version="1.0"?>
<nmaprun scanner="nmap" args="nmap -sV -sS -O -oX - 192.168.1.1">
<host><status state="up" reason="echo-reply"/>
<address addr="192.168.1.1" addrtype="ipv4"/>
<address addr="00:11:22:33:44:55" addrtype="mac" vendor="Cisco"/>
<ports>
<port protocol="tcp" portid="22"><state state="open" reason="syn-ack"/><service name="ssh" product="OpenSSH" version="8.9"/></port>
<port protocol="tcp" portid="443"><state state="open" reason="syn-ack"/><service name="https" product="nginx" version="1.24"/></port>
<port protocol="tcp" portid="80"><state state="closed" reason="reset"/><service name="http"/></port>
</ports>
<os><osmatch name="Cisco IOS 15.x" accuracy="92"><osclass type="router" vendor="Cisco" osfamily="IOS" osgen="15.X"/></osmatch>
<osmatch name="Cisco IOS 12.x" accuracy="85"><osclass type="router" vendor="Cisco" osfamily="IOS"/></osmatch></os>
</host></nmaprun>"#;

        let result = parse_nmap_xml(xml);

        assert_eq!(result.state, "up");
        assert_eq!(result.ports.len(), 3);

        // Check port 22
        let ssh = result.ports.iter().find(|p| p.port == 22).unwrap();
        assert_eq!(ssh.protocol, "tcp");
        assert_eq!(ssh.state, "open");
        assert_eq!(ssh.service, Some("ssh".to_string()));
        assert_eq!(ssh.version, Some("OpenSSH 8.9".to_string()));

        // Check port 443
        let https = result.ports.iter().find(|p| p.port == 443).unwrap();
        assert_eq!(https.service, Some("https".to_string()));
        assert_eq!(https.version, Some("nginx 1.24".to_string()));

        // Check port 80
        let http = result.ports.iter().find(|p| p.port == 80).unwrap();
        assert_eq!(http.state, "closed");
        assert_eq!(http.service, Some("http".to_string()));
        assert_eq!(http.version, None);

        // OS detection (highest accuracy)
        assert_eq!(result.os_match, Some("Cisco IOS 15.x".to_string()));
        assert_eq!(result.os_accuracy, Some(92));
        assert_eq!(result.os_family, Some("IOS".to_string()));

        // MAC address
        assert_eq!(result.mac_address, Some("00:11:22:33:44:55".to_string()));
        assert_eq!(result.vendor, Some("Cisco".to_string()));

        assert!(result.error.is_none());
    }

    #[test]
    fn test_parse_nmap_xml_minimal() {
        let xml = r#"<?xml version="1.0"?>
<nmaprun scanner="nmap" args="nmap -sT -oX - 10.0.0.1">
<host><status state="up" reason="conn-refused"/>
<address addr="10.0.0.1" addrtype="ipv4"/>
<ports>
<port protocol="tcp" portid="22"><state state="open" reason="syn-ack"/><service name="ssh"/></port>
</ports>
</host></nmaprun>"#;

        let result = parse_nmap_xml(xml);

        assert_eq!(result.state, "up");
        assert_eq!(result.ports.len(), 1);
        assert_eq!(result.ports[0].port, 22);
        assert_eq!(result.ports[0].service, Some("ssh".to_string()));
        assert!(result.os_match.is_none());
        assert!(result.os_family.is_none());
        assert!(result.mac_address.is_none());
        assert!(result.error.is_none());
    }

    #[test]
    fn test_parse_nmap_xml_host_down() {
        let xml = r#"<?xml version="1.0"?>
<nmaprun scanner="nmap">
<host><status state="down" reason="no-response"/>
<address addr="192.168.1.99" addrtype="ipv4"/>
</host></nmaprun>"#;

        let result = parse_nmap_xml(xml);

        assert_eq!(result.state, "down");
        assert!(result.ports.is_empty());
        assert!(result.os_match.is_none());
        assert!(result.error.is_none());
    }

    #[test]
    fn test_parse_nmap_xml_malformed() {
        // Garbage input
        let result = parse_nmap_xml("not xml at all");
        assert!(result.error.is_some());
        assert_eq!(result.state, "unknown");

        // Empty input
        let result = parse_nmap_xml("");
        assert!(result.error.is_some());

        // Partial XML without nmaprun
        let result = parse_nmap_xml("<host><status state=\"up\"/></host>");
        assert!(result.error.is_some());
    }

    #[test]
    fn test_nmap_result_serialization() {
        let result = NmapResult {
            host: "192.168.1.1".to_string(),
            state: "up".to_string(),
            os_family: Some("Linux".to_string()),
            os_match: Some("Linux 5.x".to_string()),
            os_accuracy: Some(95),
            ports: vec![NmapPort {
                port: 22,
                protocol: "tcp".to_string(),
                state: "open".to_string(),
                service: Some("ssh".to_string()),
                version: Some("OpenSSH 8.9".to_string()),
            }],
            mac_address: Some("00:11:22:33:44:55".to_string()),
            vendor: Some("VMware".to_string()),
            scan_time_ms: 5432,
            error: None,
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"osFamily\""));
        assert!(json.contains("\"osMatch\""));
        assert!(json.contains("\"osAccuracy\""));
        assert!(json.contains("\"scanTimeMs\""));
        assert!(json.contains("\"macAddress\""));

        // Round-trip
        let parsed: NmapResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, result);
    }

    #[test]
    fn test_nmap_port_serialization() {
        let port = NmapPort {
            port: 443,
            protocol: "tcp".to_string(),
            state: "open".to_string(),
            service: Some("https".to_string()),
            version: Some("nginx 1.24".to_string()),
        };

        let json = serde_json::to_string(&port).unwrap();
        assert!(json.contains("\"port\":443"));
        assert!(json.contains("\"protocol\":\"tcp\""));
    }
}
