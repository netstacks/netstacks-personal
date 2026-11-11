//! Knowledge packs — compiled expertise loaded based on user profile.

pub mod core;
pub mod datacenter;
pub mod mpls;
pub mod routing;
pub mod security;
pub mod wireless;
pub mod vendor_arista;
pub mod vendor_cisco;
pub mod vendor_juniper;

/// Get the core networking pack (always loaded).
pub fn core_pack() -> &'static str {
    core::CORE_PACK
}

/// Get a domain-specific pack by name.
pub fn get_domain_pack(domain: &str) -> Option<&'static str> {
    match domain {
        "routing" => Some(routing::ROUTING_PACK),
        "datacenter" => Some(datacenter::DATACENTER_PACK),
        "security" => Some(security::SECURITY_PACK),
        "wireless" => Some(wireless::WIRELESS_PACK),
        "mpls" => Some(mpls::MPLS_PACK),
        _ => None,
    }
}

/// Get a vendor-specific pack by name.
pub fn get_vendor_pack(vendor: &str) -> Option<&'static str> {
    match vendor {
        "cisco" => Some(vendor_cisco::VENDOR_CISCO_PACK),
        "juniper" => Some(vendor_juniper::VENDOR_JUNIPER_PACK),
        "arista" => Some(vendor_arista::VENDOR_ARISTA_PACK),
        _ => None,
    }
}

/// Get all pack sizes for budget visualization.
/// Returns: [(category, name, size_chars)]
pub fn get_pack_sizes() -> Vec<(String, String, usize)> {
    let mut sizes = Vec::new();

    // Core (always loaded)
    sizes.push(("core".to_string(), "core".to_string(), core_pack().len()));

    // Domain packs
    for domain in &["routing", "datacenter", "security", "wireless", "mpls"] {
        if let Some(pack) = get_domain_pack(domain) {
            sizes.push(("domain".to_string(), domain.to_string(), pack.len()));
        }
    }

    // Vendor packs
    for vendor in &["cisco", "juniper", "arista"] {
        if let Some(pack) = get_vendor_pack(vendor) {
            sizes.push(("vendor".to_string(), vendor.to_string(), pack.len()));
        }
    }

    sizes
}

/// Load knowledge packs based on domain/vendor weights, respecting character budget.
pub fn load_knowledge_packs(
    domains: &[(String, f64)],
    vendors: &[(String, f64)],
    max_chars: usize,
) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let mut budget = max_chars;

    // Always include core pack — non-negotiable foundation
    let core = core_pack();
    parts.push(core);
    budget = budget.saturating_sub(core.len());

    // Add domain packs by weight (highest first, already sorted)
    for (domain, _weight) in domains {
        if budget == 0 {
            break;
        }
        if let Some(pack) = get_domain_pack(domain) {
            if pack.len() <= budget {
                parts.push(pack);
                budget -= pack.len();
            }
        }
    }

    // Add vendor packs by weight (highest first, already sorted)
    for (vendor, _weight) in vendors {
        if budget == 0 {
            break;
        }
        if let Some(pack) = get_vendor_pack(vendor) {
            if pack.len() <= budget {
                parts.push(pack);
                budget -= pack.len();
            }
        }
    }

    parts.join("\n\n")
}
