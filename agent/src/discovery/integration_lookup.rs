//! Integration-based IP lookup for traceroute hop resolution
//!
//! Resolves interface IPs to parent device management IPs by querying
//! NetBox, NetStacks-Crawler, and LibreNMS APIs. All queries run in parallel
//! with first-match semantics.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// A device resolved from an IP address via integration lookup
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDevice {
    /// Management IP of the device
    pub management_ip: String,
    /// Device hostname
    pub hostname: Option<String>,
    /// Device type/role
    pub device_type: Option<String>,
    /// Platform/OS
    pub platform: Option<String>,
    /// Which integration resolved it: "netbox", "netstacks-crawler", "librenms"
    pub source: String,
}

/// Configuration for integration sources (pre-decrypted tokens)
#[derive(Debug, Clone, Default)]
pub struct IntegrationConfigs {
    /// NetBox sources: (base_url, api_token, verify_ssl)
    pub netbox: Vec<(String, String, bool)>,
    /// NetStacks-Crawler sources: (base_url, auth_type, username, credential, verify_ssl)
    pub netstacks_crawler: Vec<(String, String, Option<String>, String, bool)>,
    /// LibreNMS sources: (base_url, api_token, verify_ssl)
    pub librenms: Vec<(String, String, bool)>,
}

impl IntegrationConfigs {
    /// Check if any integration sources are configured
    pub fn is_empty(&self) -> bool {
        self.netbox.is_empty() && self.netstacks_crawler.is_empty() && self.librenms.is_empty()
    }
}

/// Resolver that queries integration APIs to resolve IPs to devices
pub struct IntegrationResolver;

fn build_client(verify_ssl: bool) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .danger_accept_invalid_certs(!verify_ssl)
        .build()
        .unwrap_or_default()
}

impl IntegrationResolver {
    /// Create a new resolver
    pub fn new() -> Self {
        Self
    }

    // === NetBox IP Lookup ===

    /// Resolve an IP to a device via NetBox API
    async fn resolve_via_netbox(
        &self,
        ip: &str,
        base_url: &str,
        api_token: &str,
        verify_ssl: bool,
    ) -> Option<ResolvedDevice> {
        let http_client = build_client(verify_ssl);
        let url = build_netbox_ip_url(base_url, ip);
        tracing::debug!("NetBox IP lookup: {}", url);

        let resp = http_client
            .get(&url)
            .header("Authorization", format!("Token {}", api_token))
            .header("Accept", "application/json")
            .send()
            .await
            .ok()?;

        if !resp.status().is_success() {
            tracing::debug!("NetBox returned {}", resp.status());
            return None;
        }

        let body: serde_json::Value = resp.json().await.ok()?;
        let results = body.get("results")?.as_array()?;

        // Find an IP assignment with a device
        for result in results {
            let assigned_object = result.get("assigned_object")?;
            let device = assigned_object.get("device")?;
            let device_id = device.get("id")?.as_i64()?;

            // Fetch device details
            let device_url = format!("{}/api/dcim/devices/{}/", base_url.trim_end_matches('/'), device_id);
            let dev_resp = http_client
                .get(&device_url)
                .header("Authorization", format!("Token {}", api_token))
                .header("Accept", "application/json")
                .send()
                .await
                .ok()?;

            if !dev_resp.status().is_success() {
                continue;
            }

            let dev_body: serde_json::Value = dev_resp.json().await.ok()?;

            // Extract management IP (primary_ip4.address, strip /mask)
            let mgmt_ip = dev_body
                .get("primary_ip4")
                .and_then(|p| p.get("address"))
                .and_then(|a| a.as_str())
                .map(|addr| addr.split('/').next().unwrap_or(addr).to_string())?;

            let hostname = dev_body
                .get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string());

            let device_type = dev_body
                .get("device_role")
                .and_then(|r| r.get("name"))
                .and_then(|n| n.as_str())
                .map(|s| s.to_string());

            let platform = dev_body
                .get("platform")
                .and_then(|p| p.get("name"))
                .and_then(|n| n.as_str())
                .map(|s| s.to_string());

            return Some(ResolvedDevice {
                management_ip: mgmt_ip,
                hostname,
                device_type,
                platform,
                source: "netbox".to_string(),
            });
        }

        None
    }

    // === NetStacks-Crawler IP Lookup ===

    /// Resolve an IP to a device via NetStacks-Crawler API
    async fn resolve_via_netstacks_crawler(
        &self,
        ip: &str,
        base_url: &str,
        auth_type: &str,
        username: Option<&str>,
        credential: &str,
        verify_ssl: bool,
    ) -> Option<ResolvedDevice> {
        let http_client = build_client(verify_ssl);
        let url = build_netstacks_crawler_search_url(base_url, ip);
        tracing::debug!("NetStacks-Crawler IP lookup: {}", url);

        let mut req = http_client.get(&url).header("Accept", "application/json");

        // Apply authentication
        match auth_type {
            "basic" => {
                let user = username.unwrap_or("admin");
                req = req.basic_auth(user, Some(credential));
            }
            "api_key" => {
                req = req.header("Authorization", format!("ApiKey {}", credential));
            }
            _ => {
                tracing::debug!("Unknown NetStacks-Crawler auth type: {}", auth_type);
                return None;
            }
        }

        let resp = req.send().await.ok()?;

        if !resp.status().is_success() {
            tracing::debug!("NetStacks-Crawler returned {}", resp.status());
            return None;
        }

        let body: serde_json::Value = resp.json().await.ok()?;

        // NetStacks-Crawler returns device search results
        let results = if body.is_array() {
            body.as_array()?.clone()
        } else {
            body.get("results")
                .and_then(|r| r.as_array())
                .cloned()
                .unwrap_or_default()
        };

        for result in &results {
            let mgmt_ip = result
                .get("ip")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let hostname = result
                .get("name")
                .or_else(|| result.get("dns"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if let Some(management_ip) = mgmt_ip {
                return Some(ResolvedDevice {
                    management_ip,
                    hostname,
                    device_type: None,
                    platform: result
                        .get("vendor")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    source: "netstacks-crawler".to_string(),
                });
            }
        }

        None
    }

    // === LibreNMS IP Lookup ===

    /// Resolve an IP to a device via LibreNMS API
    async fn resolve_via_librenms(
        &self,
        ip: &str,
        base_url: &str,
        api_token: &str,
        verify_ssl: bool,
    ) -> Option<ResolvedDevice> {
        let http_client = build_client(verify_ssl);
        let url = build_librenms_ip_url(base_url, ip);
        tracing::debug!("LibreNMS IP lookup: {}", url);

        let resp = http_client
            .get(&url)
            .header("X-Auth-Token", api_token)
            .header("Accept", "application/json")
            .send()
            .await
            .ok()?;

        if !resp.status().is_success() {
            tracing::debug!("LibreNMS returned {}", resp.status());
            return None;
        }

        let body: serde_json::Value = resp.json().await.ok()?;
        let addresses = body.get("addresses")?.as_array()?;

        if addresses.is_empty() {
            return None;
        }

        // Get device_id from first match
        let device_id = addresses[0].get("device_id")?.as_i64()?;

        // Fetch device details
        let device_url = format!(
            "{}/api/v0/devices/{}",
            base_url.trim_end_matches('/'),
            device_id
        );
        let dev_resp = http_client
            .get(&device_url)
            .header("X-Auth-Token", api_token)
            .header("Accept", "application/json")
            .send()
            .await
            .ok()?;

        if !dev_resp.status().is_success() {
            return None;
        }

        let dev_body: serde_json::Value = dev_resp.json().await.ok()?;
        let device = dev_body.get("devices").and_then(|d| {
            if d.is_array() {
                d.as_array().and_then(|a| a.first())
            } else {
                Some(d)
            }
        })?;

        let management_ip = device
            .get("ip")
            .or_else(|| device.get("hostname"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())?;

        let hostname = device
            .get("sysName")
            .or_else(|| device.get("hostname"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let platform = device
            .get("os")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let device_type = device
            .get("hardware")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        Some(ResolvedDevice {
            management_ip,
            hostname,
            device_type,
            platform,
            source: "librenms".to_string(),
        })
    }

    // === Combined Resolution ===

    /// Resolve an IP to a device by querying all configured integrations in parallel.
    ///
    /// Returns the first successful match. All HTTP errors are caught and logged.
    pub async fn resolve_ip_to_device(
        &self,
        ip: &str,
        configs: &IntegrationConfigs,
    ) -> Option<ResolvedDevice> {
        if configs.is_empty() {
            return None;
        }

        // Spawn all lookups concurrently
        let mut futures = Vec::new();

        for (base_url, api_token, verify_ssl) in &configs.netbox {
            let ip = ip.to_string();
            let base_url = base_url.clone();
            let api_token = api_token.clone();
            let verify_ssl = *verify_ssl;
            futures.push(tokio::spawn(async move {
                IntegrationResolver::new().resolve_via_netbox(&ip, &base_url, &api_token, verify_ssl).await
            }));
        }

        for (base_url, auth_type, username, credential, verify_ssl) in &configs.netstacks_crawler {
            let ip = ip.to_string();
            let base_url = base_url.clone();
            let auth_type = auth_type.clone();
            let username = username.clone();
            let credential = credential.clone();
            let verify_ssl = *verify_ssl;
            futures.push(tokio::spawn(async move {
                IntegrationResolver::new()
                    .resolve_via_netstacks_crawler(&ip, &base_url, &auth_type, username.as_deref(), &credential, verify_ssl)
                    .await
            }));
        }

        for (base_url, api_token, verify_ssl) in &configs.librenms {
            let ip = ip.to_string();
            let base_url = base_url.clone();
            let api_token = api_token.clone();
            let verify_ssl = *verify_ssl;
            futures.push(tokio::spawn(async move {
                IntegrationResolver::new().resolve_via_librenms(&ip, &base_url, &api_token, verify_ssl).await
            }));
        }

        // Return first successful result
        for result in futures::future::join_all(futures).await {
            match result {
                Ok(Some(device)) => return Some(device),
                Ok(None) => continue,
                Err(e) => {
                    tracing::debug!("Integration lookup task failed: {}", e);
                    continue;
                }
            }
        }

        None
    }
}

/// Batch resolve multiple IPs with bounded concurrency.
///
/// Returns Vec of (original_ip, Option<ResolvedDevice>) tuples.
pub async fn _resolve_hop_ips(
    resolver: &Arc<IntegrationResolver>,
    ips: &[String],
    configs: &IntegrationConfigs,
) -> Vec<(String, Option<ResolvedDevice>)> {
    if ips.is_empty() {
        return Vec::new();
    }

    let semaphore = Arc::new(tokio::sync::Semaphore::new(5)); // max 5 concurrent lookups
    let mut handles = Vec::with_capacity(ips.len());

    for ip in ips {
        let resolver = resolver.clone();
        let configs = configs.clone();
        let ip = ip.clone();
        let sem = semaphore.clone();

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await;
            let result = resolver.resolve_ip_to_device(&ip, &configs).await;
            (ip, result)
        }));
    }

    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        match handle.await {
            Ok(result) => results.push(result),
            Err(e) => {
                tracing::warn!("Hop resolution task panicked: {}", e);
            }
        }
    }

    results
}

// === URL Builder Helpers ===

/// Build NetBox IP address lookup URL
fn build_netbox_ip_url(base_url: &str, ip: &str) -> String {
    format!(
        "{}/api/ipam/ip-addresses/?address={}",
        base_url.trim_end_matches('/'),
        ip
    )
}

/// Build NetStacks-Crawler search URL
fn build_netstacks_crawler_search_url(base_url: &str, ip: &str) -> String {
    format!(
        "{}/api/v1/search/node?q={}",
        base_url.trim_end_matches('/'),
        ip
    )
}

/// Build LibreNMS IP address lookup URL
fn build_librenms_ip_url(base_url: &str, ip: &str) -> String {
    format!(
        "{}/api/v0/resources/ip/addresses?ipv4_address={}",
        base_url.trim_end_matches('/'),
        ip
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolved_device_serialization() {
        let device = ResolvedDevice {
            management_ip: "10.0.0.1".to_string(),
            hostname: Some("router1".to_string()),
            device_type: Some("Router".to_string()),
            platform: Some("Cisco IOS".to_string()),
            source: "netbox".to_string(),
        };

        let json = serde_json::to_string(&device).unwrap();
        assert!(json.contains("\"managementIp\""));
        assert!(json.contains("\"hostname\""));
        assert!(json.contains("\"deviceType\""));
        assert!(json.contains("\"platform\""));
        assert!(json.contains("\"source\""));

        // Round-trip
        let parsed: ResolvedDevice = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, device);
    }

    #[test]
    fn test_integration_configs_default() {
        let configs = IntegrationConfigs::default();
        assert!(configs.netbox.is_empty());
        assert!(configs.netstacks_crawler.is_empty());
        assert!(configs.librenms.is_empty());
        assert!(configs.is_empty());
    }

    #[test]
    fn test_integration_configs_not_empty() {
        let mut configs = IntegrationConfigs::default();
        configs.netbox.push(("http://netbox.local".to_string(), "token123".to_string(), true));
        assert!(!configs.is_empty());
    }

    #[test]
    fn test_build_netbox_ip_url() {
        assert_eq!(
            build_netbox_ip_url("https://netbox.example.com", "10.0.0.1"),
            "https://netbox.example.com/api/ipam/ip-addresses/?address=10.0.0.1"
        );
        // Trailing slash handling
        assert_eq!(
            build_netbox_ip_url("https://netbox.example.com/", "10.0.0.1"),
            "https://netbox.example.com/api/ipam/ip-addresses/?address=10.0.0.1"
        );
    }

    #[test]
    fn test_build_netstacks_crawler_search_url() {
        assert_eq!(
            build_netstacks_crawler_search_url("https://netstacks-crawler.example.com", "192.168.1.1"),
            "https://netstacks-crawler.example.com/api/v1/search/node?q=192.168.1.1"
        );
    }

    #[test]
    fn test_build_librenms_ip_url() {
        assert_eq!(
            build_librenms_ip_url("https://librenms.example.com", "172.16.0.5"),
            "https://librenms.example.com/api/v0/resources/ip/addresses?ipv4_address=172.16.0.5"
        );
    }

    #[tokio::test]
    async fn test_resolve_hop_ips_empty() {
        let resolver = Arc::new(IntegrationResolver::new());
        let configs = IntegrationConfigs::default();
        let results = _resolve_hop_ips(&resolver, &[], &configs).await;
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_resolve_with_no_configs() {
        let resolver = IntegrationResolver::new();
        let configs = IntegrationConfigs::default();
        let result = resolver.resolve_ip_to_device("10.0.0.1", &configs).await;
        assert!(result.is_none());
    }
}
