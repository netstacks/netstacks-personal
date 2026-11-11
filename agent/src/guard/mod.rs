//! Session Guard engine (spec: `gaurd work.md`, Part A).
//!
//! Pure and I/O-free by design: the caller runs probe commands, feeds the
//! output to [`path`], feeds accepted input lines to a [`ContextStack`],
//! parses each line with [`verbs::parse`], and asks [`evaluate`] for a
//! verdict. Nothing in this module opens a socket, reads a file, or calls a
//! model — so every verdict is reproducible from a trace record, and the
//! whole thing runs in `cargo test` against captured device output.
//!
//! v1 is one hardcoded predicate (§3.5):
//!
//! ```text
//! verb == interface.admin_down
//!   && object ∈ session.path_objects
//!   && stp.has_alternate(ingress vlan) == false
//! ```
//!
//! Unknown facts pass silently for humans and deny for agents (§3.6).

pub mod context;
pub mod live;
pub mod object;
pub mod path;
pub mod probe;
pub mod store;
pub mod trace;
pub mod verbs;

use serde::Serialize;
use std::collections::HashSet;

pub use context::{is_credential_prompt, ContextKind, ContextStack, PromptCheck};
pub use live::{Action, GuardMode, HoldNotice, LiveGuard};
pub use object::{normalize_interface, ObjectRef};
pub use path::{build_path_set, ProbeOutputs};
pub use trace::TraceRecord;
pub use verbs::{parse, redact, Intent, Verb};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum Platform {
    IosXe,
}

impl Platform {
    pub fn as_str(&self) -> &'static str {
        match self {
            Platform::IosXe => "ios-xe",
        }
    }
}

/// A fact value that may be unknown. Unknown is a real value and it
/// propagates; it is never collapsed to a default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Known<T> {
    Known(T),
    Unknown,
}

impl<T> Known<T> {
    pub fn is_unknown(&self) -> bool {
        matches!(self, Known::Unknown)
    }

    pub fn as_ref(&self) -> Known<&T> {
        match self {
            Known::Known(v) => Known::Known(v),
            Known::Unknown => Known::Unknown,
        }
    }
}

/// A resolved fact with the provenance the trace record needs.
#[derive(Debug, Clone, Serialize)]
pub struct FactValue<T> {
    pub value: Known<T>,
    /// The command(s) it came from, e.g. `show ip route 10.20.4.55`.
    pub source: String,
    /// Seconds since the value was obtained, at evaluation time.
    pub age_secs: u64,
}

/// Everything v1's predicate can consult.
#[derive(Debug, Clone, Serialize)]
pub struct SessionFacts {
    pub path_objects: FactValue<HashSet<ObjectRef>>,
    /// STP alternate for the session's ingress VLAN. `Unknown` when the
    /// session did not ingress over an SVI or the probe failed.
    pub stp_has_alternate: FactValue<bool>,
}

impl SessionFacts {
    /// The same facts with both ages set — the engine stamps the age at
    /// evaluation time so trace records say how stale each value was.
    pub fn with_age(&self, age_secs: u64) -> SessionFacts {
        let mut f = self.clone();
        f.path_objects.age_secs = age_secs;
        f.stp_has_alternate.age_secs = age_secs;
        f
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SessionKind {
    Human,
    Agent,
}

impl SessionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionKind::Human => "human",
            SessionKind::Agent => "agent",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Verdict {
    /// Send the command through.
    Pass,
    /// Hold the command, explain, offer to arm rollback (human sessions).
    Warn,
    /// Refuse and escalate (agent sessions).
    Deny,
}

impl Verdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            Verdict::Pass => "PASS",
            Verdict::Warn => "WARN",
            Verdict::Deny => "DENY",
        }
    }
}

/// One fact as the predicate saw it, for the trace record.
#[derive(Debug, Clone, Serialize)]
pub struct ConsultedFact {
    pub name: String,
    pub value: String,
    pub source: String,
    pub age_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Evaluation {
    pub verdict: Verdict,
    pub reason: String,
    pub facts_consulted: Vec<ConsultedFact>,
}

fn render_path(set: &Known<HashSet<ObjectRef>>) -> String {
    match set {
        Known::Unknown => "unknown".to_string(),
        Known::Known(s) => {
            let mut names: Vec<String> = s.iter().map(|o| o.to_string()).collect();
            names.sort();
            format!("[{}]", names.join(", "))
        }
    }
}

fn render_bool(v: &Known<bool>) -> String {
    match v {
        Known::Known(b) => b.to_string(),
        Known::Unknown => "unknown".to_string(),
    }
}

/// The v1 predicate. Microseconds, no I/O.
pub fn evaluate(intent: &Intent, facts: &SessionFacts, kind: SessionKind) -> Evaluation {
    if intent.verb != Verb::InterfaceAdminDown {
        return Evaluation {
            verdict: Verdict::Pass,
            reason: format!("no predicate registered for {}", intent.verb.as_str()),
            facts_consulted: Vec::new(),
        };
    }

    let mut consulted = vec![ConsultedFact {
        name: "session.path_objects".to_string(),
        value: render_path(&facts.path_objects.value),
        source: facts.path_objects.source.clone(),
        age_secs: facts.path_objects.age_secs,
    }];

    let unknown = |consulted: Vec<ConsultedFact>, what: &str| match kind {
        SessionKind::Human => Evaluation {
            verdict: Verdict::Pass,
            reason: format!("{what} is unknown; human session passes silently"),
            facts_consulted: consulted,
        },
        SessionKind::Agent => Evaluation {
            verdict: Verdict::Deny,
            reason: format!("{what} is unknown; an agent may not act on a network we cannot characterise"),
            facts_consulted: consulted,
        },
    };

    let path = match &facts.path_objects.value {
        Known::Known(p) => p,
        Known::Unknown => return unknown(consulted, "session.path_objects"),
    };

    let hit = intent.objects.iter().find(|o| path.contains(o));
    let Some(hit) = hit else {
        return Evaluation {
            verdict: Verdict::Pass,
            reason: "object is not in the session path".to_string(),
            facts_consulted: consulted,
        };
    };

    let vlan_label = path::ingress_vlan(path).map(|v| v.to_string()).unwrap_or_else(|| "-".to_string());
    consulted.push(ConsultedFact {
        name: format!("stp.has_alternate({vlan_label})"),
        value: render_bool(&facts.stp_has_alternate.value),
        source: facts.stp_has_alternate.source.clone(),
        age_secs: facts.stp_has_alternate.age_secs,
    });

    match facts.stp_has_alternate.value {
        Known::Unknown => unknown(consulted, "stp.has_alternate"),
        Known::Known(true) => Evaluation {
            verdict: Verdict::Pass,
            reason: format!("{hit} carries this session but VLAN {vlan_label} has an STP alternate; traffic will reconverge"),
            facts_consulted: consulted,
        },
        Known::Known(false) => Evaluation {
            verdict: match kind {
                SessionKind::Human => Verdict::Warn,
                SessionKind::Agent => Verdict::Deny,
            },
            reason: format!("{hit} carries this session and VLAN {vlan_label} has no STP alternate; this command will sever the session"),
            facts_consulted: consulted,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    const IP_ROUTE_SVI: &str = include_str!("fixtures/ios_xe/ip_route_svi.txt");
    const TRUNKS: &str = include_str!("fixtures/ios_xe/interfaces_trunk.txt");
    const LINE_VTY: &str = include_str!("fixtures/ios_xe/run_line_vty.txt");
    const AAA: &str = include_str!("fixtures/ios_xe/run_aaa.txt");
    const STP_NO_ALT: &str = include_str!("fixtures/ios_xe/spanning_tree_vlan10_no_alt.txt");
    const STP_ALT: &str = include_str!("fixtures/ios_xe/spanning_tree_vlan10_alt.txt");

    const DEVICE: &str = "mgmt-sw-01";

    fn facts(stp_output: &str) -> SessionFacts {
        let probes = ProbeOutputs { ip_route: IP_ROUTE_SVI, interfaces_trunk: TRUNKS, run_line_vty: LINE_VTY, run_aaa: AAA };
        SessionFacts {
            path_objects: FactValue {
                value: build_path_set(DEVICE, &probes),
                source: "show ip route 10.20.4.55 + 3 more".into(),
                age_secs: 51,
            },
            stp_has_alternate: FactValue {
                value: path::extract_stp_has_alternate(stp_output),
                source: "show spanning-tree vlan 10".into(),
                age_secs: 44,
            },
        }
    }

    fn session_typing(lines: &[&str]) -> (ContextStack, Intent) {
        let mut stack = ContextStack::new();
        let (last, prior) = lines.split_last().unwrap();
        for l in prior {
            stack.on_input_line(l);
        }
        let intent = parse(last, &stack, DEVICE, Platform::IosXe);
        (stack, intent)
    }

    #[test]
    fn the_scenario_shut_the_uplink_trunk() {
        let (_, intent) = session_typing(&["conf t", "int gi1/0/24", "shut"]);
        let ev = evaluate(&intent, &facts(STP_NO_ALT), SessionKind::Human);
        assert_eq!(ev.verdict, Verdict::Warn, "{}", ev.reason);
        assert!(ev.reason.contains("sever"));
        assert_eq!(ev.facts_consulted.len(), 2);
        assert_eq!(ev.facts_consulted[1].name, "stp.has_alternate(10)");
        assert_eq!(ev.facts_consulted[1].value, "false");
    }

    #[test]
    fn shut_an_unrelated_port_passes() {
        let (_, intent) = session_typing(&["conf t", "int gi1/0/5", "shut"]);
        let ev = evaluate(&intent, &facts(STP_NO_ALT), SessionKind::Human);
        assert_eq!(ev.verdict, Verdict::Pass);
        assert_eq!(ev.facts_consulted.len(), 1);
    }

    #[test]
    fn stp_alternate_means_reconverge_not_sever() {
        let (_, intent) = session_typing(&["conf t", "int gi1/0/24", "shut"]);
        let ev = evaluate(&intent, &facts(STP_ALT), SessionKind::Human);
        assert_eq!(ev.verdict, Verdict::Pass);
        assert!(ev.reason.contains("reconverge"));
    }

    #[test]
    fn no_shut_is_not_symmetric() {
        let (_, intent) = session_typing(&["conf t", "int gi1/0/24", "no shut"]);
        assert_eq!(evaluate(&intent, &facts(STP_NO_ALT), SessionKind::Human).verdict, Verdict::Pass);
    }

    #[test]
    fn unknown_facts_pass_for_humans_deny_for_agents() {
        let (_, intent) = session_typing(&["conf t", "int gi1/0/24", "shut"]);
        let mut f = facts(STP_NO_ALT);
        f.stp_has_alternate.value = Known::Unknown;
        assert_eq!(evaluate(&intent, &f, SessionKind::Human).verdict, Verdict::Pass);
        assert_eq!(evaluate(&intent, &f, SessionKind::Agent).verdict, Verdict::Deny);

        let mut f = facts(STP_NO_ALT);
        f.path_objects.value = Known::Unknown;
        assert_eq!(evaluate(&intent, &f, SessionKind::Human).verdict, Verdict::Pass);
        assert_eq!(evaluate(&intent, &f, SessionKind::Agent).verdict, Verdict::Deny);
    }

    #[test]
    fn agent_gets_deny_where_human_gets_warn() {
        let (_, intent) = session_typing(&["conf t", "int gi1/0/24", "shut"]);
        assert_eq!(evaluate(&intent, &facts(STP_NO_ALT), SessionKind::Agent).verdict, Verdict::Deny);
    }

    #[test]
    fn prompt_disagreement_makes_shut_unclassified_and_pass() {
        let mut stack = ContextStack::new();
        stack.on_input_line("conf t");
        stack.on_input_line("int gi1/0/24");
        stack.on_prompt("mgmt-sw-01(config-vlan)#");
        let intent = parse("shut", &stack, DEVICE, Platform::IosXe);
        assert_eq!(intent.verb, Verb::Unclassified);
        assert_eq!(evaluate(&intent, &facts(STP_NO_ALT), SessionKind::Human).verdict, Verdict::Pass);
    }

    #[test]
    fn paste_block_is_held_if_any_line_trips() {
        // §8: run the stack machine over every line, evaluate each.
        let block = "conf t\ninterface Gi1/0/5\n description edge\ninterface Gi1/0/24\n shutdown\nend\n";
        let mut stack = ContextStack::new();
        let f = facts(STP_NO_ALT);
        let mut verdicts = Vec::new();
        for line in block.lines() {
            let intent = parse(line, &stack, DEVICE, Platform::IosXe);
            verdicts.push(evaluate(&intent, &f, SessionKind::Human).verdict);
            stack.on_input_line(line);
        }
        assert!(verdicts.contains(&Verdict::Warn));
        assert_eq!(verdicts.iter().filter(|v| **v == Verdict::Warn).count(), 1);
    }

    #[test]
    fn trace_record_renders_spec_shape() {
        let (_, intent) = session_typing(&["conf t", "int gi1/0/24", "shut"]);
        let ev = evaluate(&intent, &facts(STP_NO_ALT), SessionKind::Human);
        let ts = Utc.with_ymd_and_hms(2026, 8, 23, 14, 22, 45).unwrap();
        let mut rec = TraceRecord::with_id_and_time("e7f21".into(), ts, intent, ev, SessionKind::Human);
        rec.guard = Some("armed  \"reload in 5\"".into());
        rec.choice = Some("proceed".into());
        rec.outcome = Some("session dropped T+2s, reconnected T+4m12s, guard disarmed manually".into());
        let text = rec.render();
        let expected_head = concat!(
            "evaluation e7f21                                  2026-08-23T14:22:45Z\n",
            "  device:  mgmt-sw-01 (ios-xe)\n",
            "  intent:  interface.admin_down → iface:mgmt-sw-01:GigabitEthernet1/0/24\n",
            "  raw:     \"shut\"\n",
            "  context: [\"configure terminal\", \"interface GigabitEthernet1/0/24\"]\n",
            "\n",
            "  facts consulted:\n",
            "    session.path_objects = [aaa:mgmt-sw-01:default, acl:mgmt-sw-01:10, acl:mgmt-sw-01:MGMT-ACL, iface:mgmt-sw-01:GigabitEthernet1/0/24, svi:mgmt-sw-01:Vlan10, vlan:mgmt-sw-01:10]\n",
            "                           source \"show ip route 10.20.4.55 + 3 more\"\n",
            "                           age 51s\n",
            "    stp.has_alternate(10) = false\n",
            "                           source \"show spanning-tree vlan 10\"\n",
            "                           age 44s\n",
            "\n",
            "  verdict: WARN (human session)\n",
        );
        assert!(text.starts_with(expected_head), "got:\n{text}");
        assert!(text.contains("  guard:   armed  \"reload in 5\"\n"));
        assert!(text.contains("  choice:  proceed\n"));
        assert!(text.ends_with("guard disarmed manually\n"));
        // Replayable: the same inputs give the same verdict.
        let (_, intent2) = session_typing(&["conf t", "int gi1/0/24", "shut"]);
        assert_eq!(evaluate(&intent2, &facts(STP_NO_ALT), SessionKind::Human).verdict, rec.evaluation.verdict);
    }

    #[test]
    fn trace_record_is_json_serializable() {
        let (_, intent) = session_typing(&["conf t", "int gi1/0/24", "shut"]);
        let ev = evaluate(&intent, &facts(STP_NO_ALT), SessionKind::Human);
        let rec = TraceRecord::new(intent, ev, SessionKind::Human);
        let json = serde_json::to_string(&rec).unwrap();
        assert!(json.contains("\"verdict\":\"Warn\""));
        assert_eq!(rec.id.len(), 5);
    }
}
