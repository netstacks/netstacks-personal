//! Canonical object identity (spec §8).
//!
//! Every fact resolver and the intent parser emit [`ObjectRef`]s, so the
//! session-path check in `evaluate` is a plain set-membership test.
//! Interface names go through one normalizer so `Gi1/0/24`, `gig 1/0/24`
//! and `GigabitEthernet1/0/24` are the same object.

use serde::Serialize;
use std::fmt;

/// A canonical reference to a network object, scoped to a device.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub enum ObjectRef {
    Interface { device: String, name: String },
    Svi { device: String, vlan: u16 },
    Vlan { device: String, id: u16 },
    Acl { device: String, name: String },
    Aaa { device: String, list: String },
}

impl ObjectRef {
    /// Build an interface object from any accepted spelling. `VlanN` is
    /// classified as an SVI so it matches the routing-table view of it.
    pub fn interface(device: &str, raw_name: &str) -> Option<Self> {
        let name = normalize_interface(raw_name)?;
        if let Some(vlan) = name.strip_prefix("Vlan").and_then(|v| v.parse::<u16>().ok()) {
            return Some(ObjectRef::Svi { device: device.to_string(), vlan });
        }
        Some(ObjectRef::Interface { device: device.to_string(), name })
    }

    pub fn device(&self) -> &str {
        match self {
            ObjectRef::Interface { device, .. }
            | ObjectRef::Svi { device, .. }
            | ObjectRef::Vlan { device, .. }
            | ObjectRef::Acl { device, .. }
            | ObjectRef::Aaa { device, .. } => device,
        }
    }
}

impl fmt::Display for ObjectRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ObjectRef::Interface { device, name } => write!(f, "iface:{device}:{name}"),
            ObjectRef::Svi { device, vlan } => write!(f, "svi:{device}:Vlan{vlan}"),
            ObjectRef::Vlan { device, id } => write!(f, "vlan:{device}:{id}"),
            ObjectRef::Acl { device, name } => write!(f, "acl:{device}:{name}"),
            ObjectRef::Aaa { device, list } => write!(f, "aaa:{device}:{list}"),
        }
    }
}

/// Short forms IOS-XE prints or accepts that are *not* plain prefixes of
/// the canonical name (or that would otherwise be ambiguous).
const INTERFACE_ALIASES: &[(&str, &str)] = &[
    ("gi", "GigabitEthernet"),
    ("gig", "GigabitEthernet"),
    ("te", "TenGigabitEthernet"),
    ("ten", "TenGigabitEthernet"),
    ("tw", "TwoGigabitEthernet"),
    ("twe", "TwentyFiveGigE"),
    ("fo", "FortyGigabitEthernet"),
    ("hu", "HundredGigE"),
    ("fa", "FastEthernet"),
    ("et", "Ethernet"),
    ("eth", "Ethernet"),
    ("po", "Port-channel"),
    ("vl", "Vlan"),
    ("lo", "Loopback"),
    ("tu", "Tunnel"),
    ("ap", "AppGigabitEthernet"),
    ("bd", "BDI"),
];

/// Canonical interface type names, as IOS-XE prints them in `show run`.
const CANONICAL_TYPES: &[&str] = &[
    "GigabitEthernet",
    "TenGigabitEthernet",
    "TwoGigabitEthernet",
    "TwentyFiveGigE",
    "FortyGigabitEthernet",
    "HundredGigE",
    "FastEthernet",
    "Ethernet",
    "Port-channel",
    "Vlan",
    "Loopback",
    "Tunnel",
    "AppGigabitEthernet",
    "BDI",
];

/// Normalize an interface name to its canonical spelling.
///
/// Accepts explicit aliases (`Gi`, `Te`, `Po`, …) and any unambiguous
/// prefix of a canonical type (`gigabit1/0/24`), with or without a space
/// before the number. Returns `None` for ambiguous prefixes (`t1/0/1`
/// could be Ten, Two, TwentyFive or Tunnel) or anything that does not look
/// like `<type><number-path>`.
pub fn normalize_interface(raw: &str) -> Option<String> {
    let compact: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    let digit_at = compact.find(|c: char| c.is_ascii_digit())?;
    let (prefix, rest) = compact.split_at(digit_at);
    if prefix.is_empty() || rest.is_empty() {
        return None;
    }
    if !rest
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '/' | '.' | ':'))
    {
        return None;
    }
    let prefix_lc = prefix.to_ascii_lowercase();
    let canonical = match INTERFACE_ALIASES.iter().find(|(alias, _)| *alias == prefix_lc) {
        Some((_, canonical)) => *canonical,
        None => {
            let mut matches = CANONICAL_TYPES
                .iter()
                .filter(|c| c.to_ascii_lowercase().starts_with(&prefix_lc));
            let first = matches.next()?;
            if matches.next().is_some() {
                return None; // ambiguous
            }
            first
        }
    };
    Some(format!("{canonical}{rest}"))
}

/// Expand an IOS VLAN list (`1,10,20-25`) into individual IDs. Non-numeric
/// tokens (`none`, `all`) are skipped — callers that care about them must
/// check the raw text.
pub fn parse_vlan_list(spec: &str) -> Vec<u16> {
    let mut out = Vec::new();
    for token in spec.split(',') {
        let token = token.trim();
        if let Some((a, b)) = token.split_once('-') {
            if let (Ok(a), Ok(b)) = (a.trim().parse::<u16>(), b.trim().parse::<u16>()) {
                if a <= b {
                    out.extend(a..=b);
                }
            }
        } else if let Ok(v) = token.parse::<u16>() {
            out.push(v);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_common_spellings() {
        for raw in ["Gi1/0/24", "gi1/0/24", "gig 1/0/24", "GigabitEthernet1/0/24", "gigabit1/0/24"] {
            assert_eq!(normalize_interface(raw).as_deref(), Some("GigabitEthernet1/0/24"), "{raw}");
        }
        assert_eq!(normalize_interface("Te1/1/1").as_deref(), Some("TenGigabitEthernet1/1/1"));
        assert_eq!(normalize_interface("Twe1/0/1").as_deref(), Some("TwentyFiveGigE1/0/1"));
        assert_eq!(normalize_interface("Tw1/0/1").as_deref(), Some("TwoGigabitEthernet1/0/1"));
        assert_eq!(normalize_interface("Po10").as_deref(), Some("Port-channel10"));
        assert_eq!(normalize_interface("vlan 10").as_deref(), Some("Vlan10"));
        assert_eq!(normalize_interface("Lo0").as_deref(), Some("Loopback0"));
    }

    #[test]
    fn rejects_ambiguous_or_malformed() {
        assert_eq!(normalize_interface("t1/0/1"), None);
        assert_eq!(normalize_interface("f0/1"), None);
        assert_eq!(normalize_interface("Gi"), None);
        assert_eq!(normalize_interface("1/0/24"), None);
        assert_eq!(normalize_interface("Gi1/0/24 shutdown"), None);
        assert_eq!(normalize_interface("Xy1/1"), None);
    }

    #[test]
    fn svi_is_classified_from_interface_name() {
        assert_eq!(
            ObjectRef::interface("sw1", "vl10"),
            Some(ObjectRef::Svi { device: "sw1".into(), vlan: 10 })
        );
        assert_eq!(
            ObjectRef::interface("sw1", "Gi1/0/24").unwrap().to_string(),
            "iface:sw1:GigabitEthernet1/0/24"
        );
        assert_eq!(ObjectRef::interface("sw1", "vl10").unwrap().to_string(), "svi:sw1:Vlan10");
    }

    #[test]
    fn vlan_lists_expand() {
        assert_eq!(parse_vlan_list("1,10,20-22"), vec![1, 10, 20, 21, 22]);
        assert_eq!(parse_vlan_list("none"), Vec::<u16>::new());
        assert_eq!(parse_vlan_list("1-4094").len(), 4094);
    }
}
