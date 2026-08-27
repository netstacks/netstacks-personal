//! Verb table (spec §3.4): deterministic `(line, context) → Intent`.
//!
//! No inference. Each platform has an ordered table of
//! `(context kind, pattern) → verb`, with the object source and any
//! redaction group declared next to the pattern. Anything that matches
//! nothing — or arrives while context is `Unknown` — is
//! `Verb::Unclassified`, a first-class verdict that lets us ship at partial
//! coverage and still be sound (§3.6).

use regex::{Captures, Regex};
use serde::Serialize;
use std::sync::OnceLock;

use super::context::{collapse_ws, ContextKind, ContextStack};
use super::object::{parse_vlan_list, ObjectRef};
use super::Platform;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum Verb {
    InterfaceAdminDown,
    InterfaceAdminUp,
    VlanRemoveFromTrunk,
    SviDelete,
    AclDelete,
    SystemReload,
    UserSetSecret,
    SnmpSetCommunity,
    Unclassified,
}

impl Verb {
    pub fn as_str(&self) -> &'static str {
        match self {
            Verb::InterfaceAdminDown => "interface.admin_down",
            Verb::InterfaceAdminUp => "interface.admin_up",
            Verb::VlanRemoveFromTrunk => "vlan.remove_from_trunk",
            Verb::SviDelete => "svi.delete",
            Verb::AclDelete => "acl.delete",
            Verb::SystemReload => "system.reload",
            Verb::UserSetSecret => "user.set_secret",
            Verb::SnmpSetCommunity => "snmp.set_community",
            Verb::Unclassified => "unclassified",
        }
    }
}

/// The parsed form of one input line. `raw` is already redacted.
#[derive(Debug, Clone, Serialize)]
pub struct Intent {
    pub verb: Verb,
    /// May be empty (unclassified, or object could not be resolved) or hold
    /// more than one object (a VLAN removed from a trunk names both).
    pub objects: Vec<ObjectRef>,
    pub device: String,
    pub platform: Platform,
    pub raw: String,
    pub context: Vec<String>,
}

/// Where a rule's objects come from.
enum ObjectSource {
    None,
    /// The interface in the top stack frame.
    Frame,
    /// The frame interface plus each VLAN in the captured list.
    FrameAndVlanList(usize),
    /// An SVI whose VLAN id is the captured group.
    Svi(usize),
    /// An ACL whose name is the captured group.
    Acl(usize),
}

struct VerbRule {
    context: ContextKind,
    pattern: Regex,
    verb: Verb,
    objects: ObjectSource,
    /// Capture group to replace with `«redacted»` before the line is stored.
    redact_group: Option<usize>,
}

fn rule(
    context: ContextKind,
    pattern: &str,
    verb: Verb,
    objects: ObjectSource,
    redact_group: Option<usize>,
) -> VerbRule {
    VerbRule { context, pattern: Regex::new(pattern).unwrap(), verb, objects, redact_group }
}

fn ios_xe_rules() -> &'static [VerbRule] {
    static RULES: OnceLock<Vec<VerbRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        use ContextKind::*;
        use ObjectSource as O;
        vec![
            // ── interface context ────────────────────────────────────────
            rule(Interface, r"(?i)^sh(?:u(?:t(?:d(?:o(?:w(?:n)?)?)?)?)?)?$", Verb::InterfaceAdminDown, O::Frame, None),
            rule(Interface, r"(?i)^no\s+sh(?:u(?:t(?:d(?:o(?:w(?:n)?)?)?)?)?)?$", Verb::InterfaceAdminUp, O::Frame, None),
            rule(Interface, r"(?i)^switchport\s+trunk\s+allowed\s+vlan\s+remove\s+(\S+)$", Verb::VlanRemoveFromTrunk, O::FrameAndVlanList(1), None),
            rule(Interface, r"(?i)^no\s+switchport\s+trunk\s+allowed\s+vlan\s+add\s+(\S+)$", Verb::VlanRemoveFromTrunk, O::FrameAndVlanList(1), None),
            // ── global config context ────────────────────────────────────
            rule(Config, r"(?i)^no\s+int(?:erface)?\s+vlan\s*(\d+)$", Verb::SviDelete, O::Svi(1), None),
            rule(Config, r"(?i)^no\s+(?:ip\s+)?access-list\s+(?:(?:standard|extended)\s+)?(\S+)$", Verb::AclDelete, O::Acl(1), None),
            rule(Config, r"(?i)^username\s+(\S+)(?:\s+privilege\s+\d+)?\s+(?:secret|password)(?:\s+\d)?\s+(\S+)$", Verb::UserSetSecret, O::None, Some(2)),
            rule(Config, r"(?i)^snmp-server\s+community\s+(\S+)", Verb::SnmpSetCommunity, O::None, Some(1)),
            // ── exec context ─────────────────────────────────────────────
            rule(Exec, r"(?i)^reload(?:\s.*)?$", Verb::SystemReload, O::None, None),
        ]
    })
}

fn rules_for(platform: Platform) -> &'static [VerbRule] {
    match platform {
        Platform::IosXe => ios_xe_rules(),
    }
}

pub const REDACTED: &str = "«redacted»";

/// Apply every redaction rule for the platform regardless of context, so a
/// secret typed in an unexpected place still never reaches a trace record.
pub fn redact(line: &str, platform: Platform) -> String {
    for r in rules_for(platform).iter().filter(|r| r.redact_group.is_some()) {
        if let Some(caps) = r.pattern.captures(line) {
            if let Some(m) = caps.get(r.redact_group.unwrap_or(0)) {
                let mut s = line.to_string();
                s.replace_range(m.range(), REDACTED);
                return s;
            }
        }
    }
    line.to_string()
}

/// Parse one accepted input line against the current context.
pub fn parse(line: &str, stack: &ContextStack, device: &str, platform: Platform) -> Intent {
    let normalized = collapse_ws(line.trim());
    let raw = redact(&normalized, platform);
    let context = stack.path();
    let unclassified = |raw: String| Intent {
        verb: Verb::Unclassified,
        objects: Vec::new(),
        device: device.to_string(),
        platform,
        raw,
        context: context.clone(),
    };

    let mut kind = stack.kind();
    if kind == ContextKind::Unknown || normalized.is_empty() {
        return unclassified(raw);
    }

    // `do <exec command>` from inside the config tree evaluates as exec.
    let mut cmd = normalized.as_str();
    if kind != ContextKind::Exec {
        if let Some(rest) = strip_prefix_ci(cmd, "do ") {
            cmd = rest.trim();
            kind = ContextKind::Exec;
        }
    }

    for r in rules_for(platform).iter().filter(|r| r.context == kind) {
        if let Some(caps) = r.pattern.captures(cmd) {
            let objects = resolve_objects(&r.objects, &caps, stack, device);
            return Intent {
                verb: r.verb,
                objects,
                device: device.to_string(),
                platform,
                raw,
                context,
            };
        }
    }
    unclassified(raw)
}

/// ASCII case-insensitive prefix strip. `str::get` (not slicing) so a line
/// whose first bytes are multi-byte characters (banner text, `ñó …`) can
/// never split a char boundary and panic (NS-GUARD-1).
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    if head.eq_ignore_ascii_case(prefix) {
        s.get(prefix.len()..)
    } else {
        None
    }
}

/// The interface(s) the top frame is scoped to: one for `interface X`,
/// every member for `interface range …` (NS-GUARD-10).
fn frame_objects(stack: &ContextStack, device: &str) -> Vec<ObjectRef> {
    let Some(top) = stack.top() else { return Vec::new() };
    if top.kind != ContextKind::Interface {
        return Vec::new();
    }
    match &top.arg {
        Some(arg) => ObjectRef::interface(device, arg).into_iter().collect(),
        None => top.members.iter().filter_map(|m| ObjectRef::interface(device, m)).collect(),
    }
}

fn resolve_objects(
    source: &ObjectSource,
    caps: &Captures<'_>,
    stack: &ContextStack,
    device: &str,
) -> Vec<ObjectRef> {
    match source {
        ObjectSource::None => Vec::new(),
        ObjectSource::Frame => frame_objects(stack, device),
        ObjectSource::FrameAndVlanList(g) => {
            let mut v = frame_objects(stack, device);
            for id in parse_vlan_list(&caps[*g]) {
                v.push(ObjectRef::Vlan { device: device.to_string(), id });
            }
            v
        }
        ObjectSource::Svi(g) => caps[*g]
            .parse::<u16>()
            .ok()
            .map(|vlan| ObjectRef::Svi { device: device.to_string(), vlan })
            .into_iter()
            .collect(),
        ObjectSource::Acl(g) => vec![ObjectRef::Acl { device: device.to_string(), name: caps[*g].to_string() }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stack_in_interface(name: &str) -> ContextStack {
        let mut s = ContextStack::new();
        s.on_input_line("conf t");
        s.on_input_line(&format!("interface {name}"));
        s
    }

    #[test]
    fn shut_resolves_object_from_frame() {
        let s = stack_in_interface("gi1/0/24");
        for line in ["shut", "shutdown", "sh", "  SHUT  "] {
            let i = parse(line, &s, "sw1", Platform::IosXe);
            assert_eq!(i.verb, Verb::InterfaceAdminDown, "{line}");
            assert_eq!(i.objects.len(), 1);
            assert_eq!(i.objects[0].to_string(), "iface:sw1:GigabitEthernet1/0/24");
        }
        assert_eq!(parse("no shut", &s, "sw1", Platform::IosXe).verb, Verb::InterfaceAdminUp);
    }

    #[test]
    fn shutdown_outside_interface_context_is_unclassified() {
        let mut s = ContextStack::new();
        // `show run | i shutdown` at exec must never parse as admin_down (§2.4).
        assert_eq!(parse("show run | i shutdown", &s, "sw1", Platform::IosXe).verb, Verb::Unclassified);
        s.on_input_line("conf t");
        assert_eq!(parse("shutdown", &s, "sw1", Platform::IosXe).verb, Verb::Unclassified);
    }

    #[test]
    fn unknown_context_is_unclassified() {
        let mut s = stack_in_interface("gi1/0/24");
        s.on_prompt("sw1(config-if)#"); // agree
        s.on_prompt("sw1(config-vlan)#"); // disagree → unknown
        assert!(s.is_unknown());
        assert_eq!(parse("shut", &s, "sw1", Platform::IosXe).verb, Verb::Unclassified);
    }

    #[test]
    fn trunk_vlan_removal_emits_interface_and_vlans() {
        let s = stack_in_interface("Gi1/0/24");
        let i = parse("switchport trunk allowed vlan remove 10,20-21", &s, "sw1", Platform::IosXe);
        assert_eq!(i.verb, Verb::VlanRemoveFromTrunk);
        let names: Vec<String> = i.objects.iter().map(|o| o.to_string()).collect();
        assert_eq!(names, vec!["iface:sw1:GigabitEthernet1/0/24", "vlan:sw1:10", "vlan:sw1:20", "vlan:sw1:21"]);
    }

    #[test]
    fn svi_and_acl_delete_from_config() {
        let mut s = ContextStack::new();
        s.on_input_line("conf t");
        let i = parse("no interface Vlan10", &s, "sw1", Platform::IosXe);
        assert_eq!(i.verb, Verb::SviDelete);
        assert_eq!(i.objects[0].to_string(), "svi:sw1:Vlan10");
        let i = parse("no ip access-list standard MGMT", &s, "sw1", Platform::IosXe);
        assert_eq!(i.verb, Verb::AclDelete);
        assert_eq!(i.objects[0].to_string(), "acl:sw1:MGMT");
        let i = parse("no access-list 10", &s, "sw1", Platform::IosXe);
        assert_eq!(i.objects[0].to_string(), "acl:sw1:10");
    }

    #[test]
    fn reload_at_exec_and_via_do() {
        let mut s = ContextStack::new();
        assert_eq!(parse("reload in 5", &s, "sw1", Platform::IosXe).verb, Verb::SystemReload);
        s.on_input_line("conf t");
        assert_eq!(parse("do reload", &s, "sw1", Platform::IosXe).verb, Verb::SystemReload);
        assert_eq!(parse("reload", &s, "sw1", Platform::IosXe).verb, Verb::Unclassified);
    }

    #[test]
    fn secrets_are_redacted_in_raw() {
        let mut s = ContextStack::new();
        s.on_input_line("conf t");
        let i = parse("username admin privilege 15 secret 0 Hunter2!", &s, "sw1", Platform::IosXe);
        assert_eq!(i.verb, Verb::UserSetSecret);
        assert_eq!(i.raw, "username admin privilege 15 secret 0 «redacted»");
        let i = parse("snmp-server community s3cr3t RO", &s, "sw1", Platform::IosXe);
        assert_eq!(i.raw, "snmp-server community «redacted» RO");
        // Redaction holds even when context is unknown.
        let mut u = ContextStack::new();
        u.on_prompt("sw1(config-if)#");
        assert!(u.is_unknown());
        let i = parse("username bob secret 5 $1$abc", &u, "sw1", Platform::IosXe);
        assert_eq!(i.verb, Verb::Unclassified);
        assert!(!i.raw.contains("$1$abc"));
    }

    #[test]
    fn interface_range_yields_every_member() {
        let s = stack_in_interface("range gi1/0/1-4, gi1/0/24");
        let i = parse("shut", &s, "sw1", Platform::IosXe);
        assert_eq!(i.verb, Verb::InterfaceAdminDown);
        let names: Vec<String> = i.objects.iter().map(|o| o.to_string()).collect();
        assert_eq!(
            names,
            vec![
                "iface:sw1:GigabitEthernet1/0/1",
                "iface:sw1:GigabitEthernet1/0/2",
                "iface:sw1:GigabitEthernet1/0/3",
                "iface:sw1:GigabitEthernet1/0/4",
                "iface:sw1:GigabitEthernet1/0/24",
            ]
        );
        // A range we cannot parse still classifies; it just has no objects.
        let s = stack_in_interface("range foo");
        assert!(parse("shut", &s, "sw1", Platform::IosXe).objects.is_empty());
    }

    #[test]
    fn non_ascii_line_start_does_not_panic() {
        // A banner or description line starting with multi-byte chars used
        // to hit `&s[..3]` inside `strip_prefix_ci` (NS-GUARD-1).
        let s = stack_in_interface("gi1/0/24");
        for line in ["ñó", "ñó shut", "ñ", "描述 uplink", "dó shut"] {
            assert_eq!(parse(line, &s, "sw1", Platform::IosXe).verb, Verb::Unclassified, "{line}");
        }
        assert_eq!(strip_prefix_ci("ñó", "do "), None);
        assert_eq!(strip_prefix_ci("Do  reload", "do "), Some(" reload"));
        assert_eq!(strip_prefix_ci("d", "do "), None);
    }
}
