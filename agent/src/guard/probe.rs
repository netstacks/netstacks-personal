//! Probe plan and fact assembly (spec §3.1, Part C §14.3). Pure: the
//! binary's `guard_probe` runs these commands over a second SSH login and
//! hands the text back here. Nothing in this module parses bytes it did
//! not receive as an argument.

use serde::Serialize;
use std::fmt;

use super::path::{build_path_set, extract_stp_has_alternate, ingress_vlan, ProbeOutputs};
use super::{FactValue, Known, ObjectRef, SessionFacts};

/// Sent first so paged output never stalls the probe.
pub const SETUP_COMMANDS: &[&str] = &["terminal length 0"];

/// Reveals this login's source address (the `*` row).
pub const SOURCE_IP_COMMAND: &str = "show users";

/// How many `show ip route <hop>` lookups the runner may chain when the
/// route to the source recurses through bare next hops.
pub const MAX_ROUTE_HOPS: usize = 3;

/// The path probes, in §3.1 order, for a given source address. CEF is
/// asked first because it prints the outgoing interface even for
/// recursive routes; `show ip route` is the fallback (see [`route_command`]).
pub fn path_commands(source_ip: &str) -> [String; 5] {
    [
        format!("show ip cef {source_ip}"),
        route_command(source_ip),
        "show interfaces trunk".to_string(),
        "show running-config | section line vty".to_string(),
        "show running-config | include aaa".to_string(),
    ]
}

/// One hop of the RIB walk: `show ip route <address>`.
pub fn route_command(address: &str) -> String {
    format!("show ip route {address}")
}

pub fn stp_command(vlan: u16) -> String {
    format!("show spanning-tree vlan {vlan}")
}

/// What the probe found, for the UI and the log.
#[derive(Debug, Clone, Serialize)]
pub struct FactsSummary {
    pub source_ip: String,
    pub object_count: usize,
    pub ingress: Option<String>,
    pub ingress_vlan: Option<u16>,
    pub stp_has_alternate: Known<bool>,
}

impl fmt::Display for FactsSummary {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.ingress {
            None => write!(f, "session path unknown (source {})", self.source_ip),
            Some(ingress) => {
                write!(f, "{} object(s) in session path; ingress {}", self.object_count, ingress)?;
                match self.stp_has_alternate {
                    Known::Known(true) => write!(f, "; STP alternate present"),
                    Known::Known(false) => write!(f, "; no STP alternate"),
                    Known::Unknown => write!(f, "; STP alternate unknown"),
                }
            }
        }
    }
}

/// Build `SessionFacts` from probe output. `stp_output` is only needed
/// when the session ingresses over an SVI; pass `None` on the first call,
/// read `summary.ingress_vlan`, run [`stp_command`] if it is `Some`, and
/// call again with the output.
pub fn assemble_facts(
    device: &str,
    source_ip: &str,
    probes: &ProbeOutputs<'_>,
    stp_output: Option<&str>,
) -> (SessionFacts, FactsSummary) {
    let path = build_path_set(device, probes);
    let (vlan, ingress, count) = match &path {
        Known::Known(set) => {
            let vlan = ingress_vlan(set);
            let ingress = match vlan {
                Some(v) => Some(format!("svi:{device}:Vlan{v}")),
                None => set
                    .iter()
                    .find(|o| matches!(o, ObjectRef::Interface { .. }))
                    .map(|o| o.to_string()),
            };
            (vlan, ingress, set.len())
        }
        Known::Unknown => (None, None, 0),
    };

    let stp = match (&path, vlan, stp_output) {
        (Known::Unknown, _, _) => FactValue {
            value: Known::Unknown,
            source: "not collected (session path unknown)".to_string(),
            age_secs: 0,
        },
        // Routed ingress: no L2 redundancy applies, losing the port severs.
        (Known::Known(_), None, _) => FactValue {
            value: Known::Known(false),
            source: "n/a (routed ingress, no VLAN)".to_string(),
            age_secs: 0,
        },
        (Known::Known(_), Some(v), Some(out)) => FactValue {
            value: extract_stp_has_alternate(out),
            source: stp_command(v),
            age_secs: 0,
        },
        (Known::Known(_), Some(v), None) => FactValue {
            value: Known::Unknown,
            source: format!("not collected ({} pending)", stp_command(v)),
            age_secs: 0,
        },
    };

    let summary = FactsSummary {
        source_ip: source_ip.to_string(),
        object_count: count,
        ingress,
        ingress_vlan: vlan,
        stp_has_alternate: stp.value.clone(),
    };
    let facts = SessionFacts {
        path_objects: FactValue {
            value: path,
            source: format!("show ip cef {source_ip} + 4 more"),
            age_secs: 0,
        },
        stp_has_alternate: stp,
    };
    (facts, summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRUNKS: &str = include_str!("fixtures/ios_xe/interfaces_trunk.txt");
    const VTY: &str = include_str!("fixtures/ios_xe/run_line_vty.txt");
    const AAA: &str = include_str!("fixtures/ios_xe/run_aaa.txt");

    #[test]
    fn commands_are_the_spec_five() {
        let c = path_commands("10.20.4.55");
        assert_eq!(c[0], "show ip cef 10.20.4.55");
        assert_eq!(c[1], "show ip route 10.20.4.55");
        assert_eq!(route_command("10.20.10.1"), "show ip route 10.20.10.1");
        assert_eq!(stp_command(10), "show spanning-tree vlan 10");
        assert_eq!(SETUP_COMMANDS, ["terminal length 0"]);
    }

    #[test]
    fn svi_ingress_needs_stp_then_completes() {
        let probes = ProbeOutputs {
            ip_route: include_str!("fixtures/ios_xe/ip_route_svi.txt"),
            interfaces_trunk: TRUNKS,
            run_line_vty: VTY,
            run_aaa: AAA,
        };
        let (facts, summary) = assemble_facts("sw", "10.20.4.55", &probes, None);
        assert_eq!(summary.ingress_vlan, Some(10));
        assert_eq!(summary.object_count, 6);
        assert!(facts.stp_has_alternate.value.is_unknown());
        assert!(facts.stp_has_alternate.source.contains("pending"));

        let stp = include_str!("fixtures/ios_xe/spanning_tree_vlan10_no_alt.txt");
        let (facts, summary) = assemble_facts("sw", "10.20.4.55", &probes, Some(stp));
        assert_eq!(facts.stp_has_alternate.value, Known::Known(false));
        assert_eq!(facts.stp_has_alternate.source, "show spanning-tree vlan 10");
        assert_eq!(summary.to_string(), "6 object(s) in session path; ingress svi:sw:Vlan10; no STP alternate");
    }

    #[test]
    fn routed_ingress_has_no_alternate_by_definition() {
        let probes = ProbeOutputs {
            ip_route: include_str!("fixtures/ios_xe/ip_route_routed_port.txt"),
            interfaces_trunk: "",
            run_line_vty: VTY,
            run_aaa: AAA,
        };
        let (facts, summary) = assemble_facts("sw", "10.20.4.55", &probes, None);
        assert_eq!(summary.ingress_vlan, None);
        assert_eq!(summary.ingress.as_deref(), Some("iface:sw:GigabitEthernet1/0/1"));
        assert_eq!(facts.stp_has_alternate.value, Known::Known(false));
        assert!(facts.stp_has_alternate.source.contains("routed"));
    }

    #[test]
    fn unknown_route_stays_unknown_everywhere() {
        let probes = ProbeOutputs {
            ip_route: include_str!("fixtures/ios_xe/ip_route_nexthop.txt"),
            interfaces_trunk: TRUNKS,
            run_line_vty: VTY,
            run_aaa: AAA,
        };
        let (facts, summary) = assemble_facts("sw", "10.20.4.55", &probes, None);
        assert!(facts.path_objects.value.is_unknown());
        assert!(facts.stp_has_alternate.value.is_unknown());
        assert_eq!(summary.to_string(), "session path unknown (source 10.20.4.55)");
    }
}
