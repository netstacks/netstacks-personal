//! Session-path collection (spec §3.1): pure extractors over captured
//! `show` output. Nothing here touches the network — the caller runs the
//! probes and hands the text in.
//!
//! The result is the set of every object whose failure would sever the
//! session. Five very different commands (shut the port, delete the SVI,
//! pull the VLAN off the trunk, rewrite the vty ACL, break AAA) are all
//! caught by one membership test against this set.

use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

use super::object::{normalize_interface, parse_vlan_list, ObjectRef};
use super::Known;

/// Raw output of the probe commands, in the order §3.1 lists them.
pub struct ProbeOutputs<'a> {
    /// The lookup that names the outgoing interface: `show ip cef <ip>`
    /// when the platform answers it, otherwise the `show ip route <hop>`
    /// output the probe runner reached by following next hops (see
    /// [`extract_route_next_hop`]).
    pub ip_route: &'a str,
    /// `show interfaces trunk`
    pub interfaces_trunk: &'a str,
    /// `show run | section line vty`
    pub run_line_vty: &'a str,
    /// `show run | include aaa`
    pub run_aaa: &'a str,
}

struct Patterns {
    via: Regex,
    bare_next_hop: Regex,
    denied: Regex,
    not_in_table: Regex,
    trunk_active_header: Regex,
    access_class: Regex,
    aaa_new_model: Regex,
    aaa_login: Regex,
    stp_header: Regex,
    stp_altn: Regex,
    vlan_row: Regex,
    vlan_not_found: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        // `show ip route`: `via Vlan10`; `show ip cef`: `nexthop 10.0.0.1 Vlan10`
        // or `attached to Vlan10`. A quoted source (`via "static"`) never
        // matches because the name must start with a letter.
        via: Regex::new(r"(?:via|attached to|nexthop \S+) ([A-Za-z][A-Za-z-]*\d[\d/.:]*)").unwrap(),
        // A descriptor block that is only an address: the route recurses.
        bare_next_hop: Regex::new(r"(?m)^\s*\*?\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$").unwrap(),
        denied: Regex::new(r"(?i)Command authorization failed|Invalid input").unwrap(),
        not_in_table: Regex::new(r"(?i)% (?:network|subnet) not in table").unwrap(),
        trunk_active_header: Regex::new(r"(?im)^Port\s+Vlans allowed and active").unwrap(),
        access_class: Regex::new(r"(?m)^\s*access-class (\S+) in").unwrap(),
        aaa_new_model: Regex::new(r"(?m)^aaa new-model").unwrap(),
        aaa_login: Regex::new(r"(?m)^aaa authentication login (\S+)").unwrap(),
        stp_header: Regex::new(r"(?m)^Interface\s+Role\s+Sts").unwrap(),
        stp_altn: Regex::new(r"(?m)^\S+\s+Altn\s").unwrap(),
        vlan_row: Regex::new(r"(?m)^(\d+)\s+\S+\s+(?:active|suspended|act/lshut|sus/lshut)").unwrap(),
        vlan_not_found: Regex::new(r"(?i)VLAN id \d+ not found").unwrap(),
    })
}

/// Whether the device refused to run the command at all: an error marker
/// (`% ...`), a TACACS denial, or a parser rejection. Output like this
/// must never be read as "nothing configured".
pub fn command_denied(output: &str) -> bool {
    output.trim_start().starts_with('%') || patterns().denied.is_match(output)
}

/// Outgoing interface for the session's source address, from
/// `show ip cef <ip>` or `show ip route <ip>`. `Unknown` when the lookup
/// was refused, the prefix is not in the table, the route recurses
/// through a next hop with no interface, or ECMP spreads it over more
/// than one interface.
pub fn extract_route_interface(output: &str) -> Known<String> {
    let p = patterns();
    if command_denied(output) || p.not_in_table.is_match(output) {
        return Known::Unknown;
    }
    let names: HashSet<String> = p.via.captures_iter(output).filter_map(|c| normalize_interface(&c[1])).collect();
    match names.len() {
        1 => Known::Known(names.into_iter().next().unwrap_or_default()),
        _ => Known::Unknown,
    }
}

/// The address to look up next when `show ip route <ip>` resolves to a
/// bare next hop (no `via <interface>`). `None` if the output already
/// names an interface, was refused, or lists more than one next hop.
pub fn extract_route_next_hop(output: &str) -> Option<String> {
    let p = patterns();
    if command_denied(output) || p.via.is_match(output) {
        return None;
    }
    let hops: HashSet<&str> = p.bare_next_hop.captures_iter(output).map(|c| c.get(1).map_or("", |m| m.as_str())).collect();
    if hops.len() != 1 {
        return None;
    }
    hops.into_iter().next().map(str::to_string)
}

/// Trunk ports on which `vlan` is allowed *and active*, from
/// `show interfaces trunk`. `Unknown` if the command was refused or the
/// section is missing entirely; `Known(empty)` if there are no trunks or
/// none carry the VLAN.
pub fn extract_trunks_carrying_vlan(output: &str, vlan: u16) -> Known<Vec<String>> {
    let p = patterns();
    if command_denied(output) {
        return Known::Unknown;
    }
    let Some(m) = p.trunk_active_header.find(output) else {
        return Known::Unknown;
    };
    // (port, vlan list). Long lists wrap onto indented continuation rows,
    // which belong to the port above them.
    let mut rows: Vec<(&str, String)> = Vec::new();
    for line in output[m.end()..].lines().skip(1) {
        let line = line.trim_end();
        if line.trim().is_empty() {
            break;
        }
        if line.starts_with(char::is_whitespace) {
            if let Some((_, list)) = rows.last_mut() {
                if !list.ends_with(',') {
                    list.push(',');
                }
                list.push_str(line.trim());
            }
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(port), Some(list)) = (parts.next(), parts.next()) else {
            continue;
        };
        rows.push((port, list.to_string()));
    }
    let ports = rows
        .iter()
        .filter(|(_, list)| parse_vlan_list(list).contains(&vlan))
        .filter_map(|(port, _)| normalize_interface(port))
        .collect();
    Known::Known(ports)
}

/// ACLs applied inbound on vty lines. Absence is a real answer (no ACL);
/// a refused command is not.
pub fn extract_vty_acls(output: &str) -> Known<Vec<String>> {
    if command_denied(output) {
        return Known::Unknown;
    }
    let mut seen = HashSet::new();
    Known::Known(
        patterns()
            .access_class
            .captures_iter(output)
            .map(|c| c[1].to_string())
            .filter(|n| seen.insert(n.clone()))
            .collect(),
    )
}

/// AAA login method lists in force. Empty if `aaa new-model` is off;
/// `Unknown` if the command was refused.
pub fn extract_aaa_lists(output: &str) -> Known<Vec<String>> {
    let p = patterns();
    if command_denied(output) {
        return Known::Unknown;
    }
    if !p.aaa_new_model.is_match(output) {
        return Known::Known(Vec::new());
    }
    let mut seen = HashSet::new();
    Known::Known(
        p.aaa_login
            .captures_iter(output)
            .map(|c| c[1].to_string())
            .filter(|n| seen.insert(n.clone()))
            .collect(),
    )
}

/// Whether the VLAN has a port in STP role `Altn`, from
/// `show spanning-tree vlan N`. `Unknown` when there is no port table
/// (no STP instance for the VLAN, or unparsable output).
pub fn extract_stp_has_alternate(output: &str) -> Known<bool> {
    let p = patterns();
    if command_denied(output) || !p.stp_header.is_match(output) {
        return Known::Unknown;
    }
    Known::Known(p.stp_altn.is_match(output))
}

/// Whether `show vlan id N` reports the VLAN as present.
pub fn extract_vlan_exists(output: &str, vlan: u16) -> Known<bool> {
    let p = patterns();
    if command_denied(output) {
        return Known::Unknown;
    }
    if p.vlan_not_found.is_match(output) {
        return Known::Known(false);
    }
    let found = p
        .vlan_row
        .captures_iter(output)
        .any(|c| c[1].parse::<u16>().ok() == Some(vlan));
    if found {
        Known::Known(true)
    } else {
        Known::Unknown
    }
}

/// Source address of *this* login, from `show users`: the row IOS marks
/// with `*`, last column. `Unknown` if no such row or it is not an address.
pub fn extract_source_ip(output: &str) -> Known<String> {
    if command_denied(output) {
        return Known::Unknown;
    }
    for line in output.lines() {
        if let Some(rest) = line.trim_start().strip_prefix('*') {
            if let Some(last) = rest.split_whitespace().last() {
                if last.parse::<std::net::IpAddr>().is_ok() {
                    return Known::Known(last.to_string());
                }
            }
        }
    }
    Known::Unknown
}

/// Assemble the session path set. Any `Unknown` link in the chain makes
/// the whole set `Unknown` — a partial set would silently pass commands
/// that sever the session, which is the one thing this must never do.
pub fn build_path_set(device: &str, probes: &ProbeOutputs<'_>) -> Known<HashSet<ObjectRef>> {
    let ingress_name = match extract_route_interface(probes.ip_route) {
        Known::Known(n) => n,
        Known::Unknown => return Known::Unknown,
    };
    let Some(ingress) = ObjectRef::interface(device, &ingress_name) else {
        return Known::Unknown;
    };

    let mut set = HashSet::new();
    match &ingress {
        ObjectRef::Svi { vlan, .. } => {
            let vlan = *vlan;
            set.insert(ingress.clone());
            set.insert(ObjectRef::Vlan { device: device.to_string(), id: vlan });
            match extract_trunks_carrying_vlan(probes.interfaces_trunk, vlan) {
                Known::Known(ports) => {
                    for port in ports {
                        if let Some(o) = ObjectRef::interface(device, &port) {
                            set.insert(o);
                        }
                    }
                }
                Known::Unknown => return Known::Unknown,
            }
        }
        other => {
            set.insert(other.clone());
        }
    }
    let Known::Known(acls) = extract_vty_acls(probes.run_line_vty) else {
        return Known::Unknown;
    };
    for name in acls {
        set.insert(ObjectRef::Acl { device: device.to_string(), name });
    }
    let Known::Known(lists) = extract_aaa_lists(probes.run_aaa) else {
        return Known::Unknown;
    };
    for list in lists {
        set.insert(ObjectRef::Aaa { device: device.to_string(), list });
    }
    Known::Known(set)
}

/// The VLAN the session ingresses on, if it came in over an SVI.
pub fn ingress_vlan(path: &HashSet<ObjectRef>) -> Option<u16> {
    path.iter().find_map(|o| match o {
        ObjectRef::Svi { vlan, .. } => Some(*vlan),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const IP_ROUTE_SVI: &str = include_str!("fixtures/ios_xe/ip_route_svi.txt");
    const IP_ROUTE_NEXTHOP: &str = include_str!("fixtures/ios_xe/ip_route_nexthop.txt");
    const IP_ROUTE_ROUTED: &str = include_str!("fixtures/ios_xe/ip_route_routed_port.txt");
    const IP_ROUTE_RESOLVED: &str = include_str!("fixtures/ios_xe/ip_route_nexthop_resolved.txt");
    const IP_ROUTE_ECMP: &str = include_str!("fixtures/ios_xe/ip_route_ecmp.txt");
    const IP_CEF_NEXTHOP: &str = include_str!("fixtures/ios_xe/ip_cef_nexthop.txt");
    const IP_CEF_ECMP: &str = include_str!("fixtures/ios_xe/ip_cef_ecmp.txt");
    const IP_CEF_ATTACHED: &str = include_str!("fixtures/ios_xe/ip_cef_attached.txt");
    const TRUNKS: &str = include_str!("fixtures/ios_xe/interfaces_trunk.txt");
    const TRUNKS_WRAPPED: &str = include_str!("fixtures/ios_xe/interfaces_trunk_wrapped.txt");
    const DENIED: &str = "Command authorization failed.\n";
    const INVALID: &str = "% Invalid input detected at '^' marker.\n";
    const LINE_VTY: &str = include_str!("fixtures/ios_xe/run_line_vty.txt");
    const AAA: &str = include_str!("fixtures/ios_xe/run_aaa.txt");
    const STP_NO_ALT: &str = include_str!("fixtures/ios_xe/spanning_tree_vlan10_no_alt.txt");
    const STP_ALT: &str = include_str!("fixtures/ios_xe/spanning_tree_vlan10_alt.txt");
    const VLAN_10: &str = include_str!("fixtures/ios_xe/vlan_id_10.txt");

    #[test]
    fn source_ip_from_show_users() {
        assert_eq!(extract_source_ip(include_str!("fixtures/ios_xe/show_users.txt")), Known::Known("10.20.4.55".into()));
        assert_eq!(extract_source_ip("   1 vty 0     admin      idle   00:03:12 10.20.4.55\n"), Known::Unknown);
        assert_eq!(extract_source_ip("*  0 con 0     admin      idle   00:00:00 "), Known::Unknown);
    }

    #[test]
    fn route_interface() {
        assert_eq!(extract_route_interface(IP_ROUTE_SVI), Known::Known("Vlan10".into()));
        assert_eq!(extract_route_interface(IP_ROUTE_ROUTED), Known::Known("GigabitEthernet1/0/1".into()));
        assert_eq!(extract_route_interface(IP_ROUTE_NEXTHOP), Known::Unknown);
        assert_eq!(extract_route_interface(IP_ROUTE_RESOLVED), Known::Known("Vlan100".into()));
        assert_eq!(extract_route_interface(IP_ROUTE_ECMP), Known::Unknown);
        assert_eq!(extract_route_interface("% Network not in table"), Known::Unknown);
    }

    #[test]
    fn route_interface_from_cef() {
        assert_eq!(extract_route_interface(IP_CEF_NEXTHOP), Known::Known("Vlan100".into()));
        assert_eq!(extract_route_interface(IP_CEF_ATTACHED), Known::Known("Vlan10".into()));
        assert_eq!(extract_route_interface(IP_CEF_ECMP), Known::Unknown);
        assert_eq!(extract_route_interface("0.0.0.0/0\n  no route\n"), Known::Unknown);
    }

    #[test]
    fn route_next_hop_only_for_bare_recursive_routes() {
        assert_eq!(extract_route_next_hop(IP_ROUTE_NEXTHOP).as_deref(), Some("10.20.10.1"));
        assert_eq!(extract_route_next_hop(IP_ROUTE_SVI), None);
        assert_eq!(extract_route_next_hop(IP_ROUTE_RESOLVED), None);
        assert_eq!(extract_route_next_hop(IP_ROUTE_ECMP), None);
        assert_eq!(extract_route_next_hop("% Network not in table"), None);
        // Two bare next hops: ECMP without interfaces stays unresolved.
        let two = "Routing entry for 0.0.0.0/0, supernet\n  Routing Descriptor Blocks:\n  * 10.20.10.1\n    10.20.11.1\n";
        assert_eq!(extract_route_next_hop(two), None);
    }

    #[test]
    fn trunks_carrying_vlan() {
        assert_eq!(extract_trunks_carrying_vlan(TRUNKS, 10), Known::Known(vec!["GigabitEthernet1/0/24".into()]));
        assert_eq!(extract_trunks_carrying_vlan(TRUNKS, 30), Known::Known(vec!["GigabitEthernet1/0/23".into()]));
        assert_eq!(extract_trunks_carrying_vlan(TRUNKS, 999), Known::Known(vec![]));
        assert_eq!(extract_trunks_carrying_vlan("", 10), Known::Unknown);
    }

    #[test]
    fn trunk_continuation_rows_extend_previous_port() {
        assert_eq!(extract_trunks_carrying_vlan(TRUNKS_WRAPPED, 10), Known::Known(vec!["GigabitEthernet1/0/24".into()]));
        assert_eq!(extract_trunks_carrying_vlan(TRUNKS_WRAPPED, 330), Known::Known(vec!["GigabitEthernet1/0/23".into()]));
        assert_eq!(extract_trunks_carrying_vlan(TRUNKS_WRAPPED, 300), Known::Known(vec!["GigabitEthernet1/0/23".into(), "GigabitEthernet1/0/24".into()]));
        assert_eq!(extract_trunks_carrying_vlan(TRUNKS_WRAPPED, 40), Known::Known(vec!["GigabitEthernet1/0/23".into()]));
    }

    #[test]
    fn vty_acls_and_aaa() {
        assert_eq!(extract_vty_acls(LINE_VTY), Known::Known(vec!["10".into(), "MGMT-ACL".into()]));
        assert_eq!(extract_vty_acls("line vty 0 4\n transport input ssh"), Known::Known(Vec::new()));
        assert_eq!(extract_aaa_lists(AAA), Known::Known(vec!["default".into()]));
        assert_eq!(extract_aaa_lists("no aaa new-model"), Known::Known(Vec::new()));
    }

    #[test]
    fn denied_or_rejected_commands_are_unknown_not_absent() {
        for out in [DENIED, INVALID, "% Type \"show ?\" for a list of subcommands\n"] {
            assert!(command_denied(out), "{out}");
            assert_eq!(extract_vty_acls(out), Known::Unknown, "{out}");
            assert_eq!(extract_aaa_lists(out), Known::Unknown, "{out}");
            assert_eq!(extract_trunks_carrying_vlan(out, 10), Known::Unknown, "{out}");
            assert_eq!(extract_route_interface(out), Known::Unknown, "{out}");
            assert_eq!(extract_stp_has_alternate(out), Known::Unknown, "{out}");
            assert_eq!(extract_vlan_exists(out, 10), Known::Unknown, "{out}");
            assert_eq!(extract_source_ip(out), Known::Unknown, "{out}");
        }
        assert!(!command_denied(LINE_VTY));
        assert!(!command_denied(""));
        // A priv-1 user whose `show run | section` is refused must not get a
        // path set that is merely missing the ACL.
        let probes = ProbeOutputs { ip_route: IP_ROUTE_SVI, interfaces_trunk: TRUNKS, run_line_vty: DENIED, run_aaa: AAA };
        assert_eq!(build_path_set("sw", &probes), Known::Unknown);
        let probes = ProbeOutputs { ip_route: IP_ROUTE_SVI, interfaces_trunk: TRUNKS, run_line_vty: LINE_VTY, run_aaa: INVALID };
        assert_eq!(build_path_set("sw", &probes), Known::Unknown);
    }

    #[test]
    fn stp_alternate() {
        assert_eq!(extract_stp_has_alternate(STP_NO_ALT), Known::Known(false));
        assert_eq!(extract_stp_has_alternate(STP_ALT), Known::Known(true));
        assert_eq!(extract_stp_has_alternate("No spanning tree instance exists."), Known::Unknown);
    }

    #[test]
    fn vlan_exists() {
        assert_eq!(extract_vlan_exists(VLAN_10, 10), Known::Known(true));
        assert_eq!(extract_vlan_exists("VLAN id 999 not found in current VLAN database", 999), Known::Known(false));
        assert_eq!(extract_vlan_exists(VLAN_10, 11), Known::Unknown);
    }

    #[test]
    fn builds_full_path_set_for_svi_ingress() {
        let probes = ProbeOutputs { ip_route: IP_ROUTE_SVI, interfaces_trunk: TRUNKS, run_line_vty: LINE_VTY, run_aaa: AAA };
        let Known::Known(set) = build_path_set("mgmt-sw-01", &probes) else {
            panic!("expected known path set");
        };
        let mut names: Vec<String> = set.iter().map(|o| o.to_string()).collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "aaa:mgmt-sw-01:default",
                "acl:mgmt-sw-01:10",
                "acl:mgmt-sw-01:MGMT-ACL",
                "iface:mgmt-sw-01:GigabitEthernet1/0/24",
                "svi:mgmt-sw-01:Vlan10",
                "vlan:mgmt-sw-01:10",
            ]
        );
        assert_eq!(ingress_vlan(&set), Some(10));
    }

    #[test]
    fn unknown_route_makes_whole_set_unknown() {
        let probes = ProbeOutputs { ip_route: IP_ROUTE_NEXTHOP, interfaces_trunk: TRUNKS, run_line_vty: LINE_VTY, run_aaa: AAA };
        assert_eq!(build_path_set("sw", &probes), Known::Unknown);
        let probes = ProbeOutputs { ip_route: IP_ROUTE_SVI, interfaces_trunk: "", run_line_vty: LINE_VTY, run_aaa: AAA };
        assert_eq!(build_path_set("sw", &probes), Known::Unknown);
        let probes = ProbeOutputs { ip_route: IP_ROUTE_ECMP, interfaces_trunk: TRUNKS, run_line_vty: LINE_VTY, run_aaa: AAA };
        assert_eq!(build_path_set("sw", &probes), Known::Unknown);
    }

    #[test]
    fn cef_next_hop_ingress_is_a_known_svi_path() {
        let probes = ProbeOutputs { ip_route: IP_CEF_NEXTHOP, interfaces_trunk: TRUNKS, run_line_vty: LINE_VTY, run_aaa: AAA };
        let Known::Known(set) = build_path_set("sw", &probes) else { panic!() };
        assert_eq!(ingress_vlan(&set), Some(100));
        assert!(set.contains(&ObjectRef::Vlan { device: "sw".into(), id: 100 }));
    }

    #[test]
    fn routed_port_ingress_has_no_vlan_objects() {
        let probes = ProbeOutputs { ip_route: IP_ROUTE_ROUTED, interfaces_trunk: "", run_line_vty: "", run_aaa: "" };
        let Known::Known(set) = build_path_set("sw", &probes) else { panic!() };
        assert_eq!(set.len(), 1);
        assert!(set.contains(&ObjectRef::Interface { device: "sw".into(), name: "GigabitEthernet1/0/1".into() }));
        assert_eq!(ingress_vlan(&set), None);
    }
}
