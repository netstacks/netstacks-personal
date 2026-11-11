//! Config-context stack (spec §3.2) and credential-entry detection (§3.3).
//!
//! The stack is driven by accepted input lines and **cross-checked against
//! every prompt the device prints**. When they disagree the device wins:
//! the stack resets and, if the object cannot be recovered from the prompt
//! alone, context becomes `Unknown` — which parses everything to
//! `Verb::Unclassified` until the next prompt re-syncs us.

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

use super::object::normalize_interface;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ContextKind {
    Exec,
    Config,
    Interface,
    Router,
    Vlan,
    Line,
    /// We could not reconcile our stack with the device's prompt.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContextFrame {
    pub kind: ContextKind,
    /// The object this frame is scoped to, canonicalized where possible
    /// (interface name, routing process, VLAN id, line range).
    pub arg: Option<String>,
    /// For `interface range`, every member interface (canonical names) so a
    /// verb in that frame is evaluated against all of them (NS-GUARD-10).
    pub members: Vec<String>,
    /// The line as we record it in trace context, e.g. `interface GigabitEthernet1/0/24`.
    pub raw: String,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct ContextStack {
    frames: Vec<ContextFrame>,
    unknown: bool,
}

/// Result of cross-checking a prompt against the stack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptCheck {
    /// The text did not look like a prompt; stack untouched.
    NotAPrompt,
    /// Prompt and stack agree.
    Agree,
    /// Prompt and stack disagreed; the stack was reset to what the prompt implies.
    Reset,
}

struct Triggers {
    conf_t: Regex,
    interface: Regex,
    router: Regex,
    vlan: Regex,
    line: Regex,
    exit: Regex,
    end: Regex,
    credential_prompt: Regex,
    /// A prompt at the start of an output line, whatever follows it
    /// (`?` help and `logging synchronous` redraw the prompt *and* the
    /// partially typed command on one line).
    prompt_prefix: Regex,
    vlan_mention: Regex,
}

fn triggers() -> &'static Triggers {
    static T: OnceLock<Triggers> = OnceLock::new();
    T.get_or_init(|| Triggers {
        conf_t: Regex::new(r"(?i)^conf(?:igure)?(?:\s+t(?:erm(?:inal)?)?)?$").unwrap(),
        interface: Regex::new(r"(?i)^int(?:erface)?\s+(range\s+)?(.+)$").unwrap(),
        router: Regex::new(r"(?i)^router\s+(.+)$").unwrap(),
        vlan: Regex::new(r"(?i)^vlan\s+(\S+)$").unwrap(),
        line: Regex::new(r"(?i)^line\s+(.+)$").unwrap(),
        exit: Regex::new(r"(?i)^exit$").unwrap(),
        end: Regex::new(r"(?i)^end$").unwrap(),
        credential_prompt: Regex::new(r"(?i)(?:password|passphrase|secret|confirm)[^\n]*:\s*$").unwrap(),
        prompt_prefix: Regex::new(r"^[^\s()#>]+(\([^)]*\))?[#>]").unwrap(),
        vlan_mention: Regex::new(r"(?i)\bvlan\b").unwrap(),
    })
}

pub(crate) fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn config_frame() -> ContextFrame {
    ContextFrame { kind: ContextKind::Config, arg: None, members: Vec::new(), raw: "configure terminal".to_string() }
}

/// Byte offset just past a prompt that starts `line`, if one does. Unlike
/// [`ContextStack::classify_prompt`] this ignores whatever follows the
/// prompt, so `sw(config-if)#shut` still locates the prompt at 14.
pub fn prompt_prefix_end(line: &str) -> Option<usize> {
    triggers().prompt_prefix.find(line).map(|m| m.end())
}

/// Expand an `interface range` argument (`gi1/0/1-4, gi1/0/24`,
/// `gi1/0/1 - 4`, `gi1/0/1-gi1/0/4`) into canonical member names. Tokens
/// that cannot be normalized are dropped; ranges are capped so a typo
/// cannot allocate millions of names.
pub fn expand_interface_range(spec: &str) -> Vec<String> {
    const MAX_MEMBERS: usize = 1024;
    let mut out = Vec::new();
    for token in spec.split(',') {
        let token: String = token.chars().filter(|c| !c.is_whitespace()).collect();
        if token.is_empty() {
            continue;
        }
        let Some((start_raw, end_raw)) = token.split_once('-') else {
            if let Some(n) = normalize_interface(&token) {
                out.push(n);
            }
            continue;
        };
        let Some(start) = normalize_interface(start_raw) else { continue };
        let Some(dash) = start.rfind(|c: char| !c.is_ascii_digit()) else { continue };
        let (stem, first) = start.split_at(dash + 1);
        let Ok(first) = first.parse::<u32>() else { continue };
        // `gi1/0/1-4` or `gi1/0/1-gi1/0/4`: the end is the last number either way.
        let last_digits = end_raw.rsplit(|c: char| !c.is_ascii_digit()).next().unwrap_or("");
        let Ok(last) = last_digits.parse::<u32>() else { continue };
        if last < first {
            continue;
        }
        for n in first..=last {
            if out.len() >= MAX_MEMBERS {
                return out;
            }
            out.push(format!("{stem}{n}"));
        }
    }
    out
}

/// True when a config-mode line names an interface or a VLAN — any such
/// write may add or remove an object from the session path, so the facts
/// are refreshed after it (NS-GUARD-7).
pub fn mentions_interface_or_vlan(line: &str) -> bool {
    if triggers().vlan_mention.is_match(line) {
        return true;
    }
    line.split(|c: char| c.is_whitespace() || c == ',')
        .any(|tok| !tok.is_empty() && normalize_interface(tok).is_some())
}

impl ContextStack {
    pub fn new() -> Self {
        Self::default()
    }

    /// The context the next input line will be evaluated in.
    pub fn kind(&self) -> ContextKind {
        if self.unknown {
            ContextKind::Unknown
        } else {
            self.frames.last().map(|f| f.kind).unwrap_or(ContextKind::Exec)
        }
    }

    pub fn top(&self) -> Option<&ContextFrame> {
        self.frames.last()
    }

    pub fn is_unknown(&self) -> bool {
        self.unknown
    }

    /// The path recorded in a trace record.
    pub fn path(&self) -> Vec<String> {
        self.frames.iter().map(|f| f.raw.clone()).collect()
    }

    /// Advance the stack after a line has been *sent* to the device.
    pub fn on_input_line(&mut self, line: &str) {
        let line = collapse_ws(line.trim());
        if line.is_empty() {
            return;
        }
        let t = triggers();
        if line.contains('\u{1a}') || t.end.is_match(&line) {
            self.frames.clear();
            return;
        }
        if line.to_ascii_lowercase().starts_with("do ") {
            return;
        }
        if t.exit.is_match(&line) {
            self.frames.pop();
            return;
        }
        match self.kind() {
            ContextKind::Exec => {
                if t.conf_t.is_match(&line) {
                    self.frames.push(config_frame());
                }
            }
            ContextKind::Unknown => {}
            _ => {
                // Sub-mode entries are legal from any depth and always land
                // one level below (config).
                if let Some(c) = t.interface.captures(&line) {
                    self.truncate_to_config();
                    let is_range = c.get(1).is_some();
                    let name_raw = c[2].trim();
                    let (arg, members, raw) = if is_range {
                        (None, expand_interface_range(name_raw), format!("interface range {name_raw}"))
                    } else {
                        match normalize_interface(name_raw) {
                            Some(n) => (Some(n.clone()), Vec::new(), format!("interface {n}")),
                            None => (None, Vec::new(), format!("interface {name_raw}")),
                        }
                    };
                    self.frames.push(ContextFrame { kind: ContextKind::Interface, arg, members, raw });
                } else if let Some(c) = t.router.captures(&line) {
                    self.truncate_to_config();
                    let arg = c[1].trim().to_string();
                    self.frames.push(ContextFrame {
                        kind: ContextKind::Router,
                        members: Vec::new(),
                        raw: format!("router {arg}"),
                        arg: Some(arg),
                    });
                } else if let Some(c) = t.vlan.captures(&line) {
                    self.truncate_to_config();
                    let arg = c[1].to_string();
                    self.frames.push(ContextFrame {
                        kind: ContextKind::Vlan,
                        members: Vec::new(),
                        raw: format!("vlan {arg}"),
                        arg: Some(arg),
                    });
                } else if let Some(c) = t.line.captures(&line) {
                    self.truncate_to_config();
                    let arg = c[1].trim().to_string();
                    self.frames.push(ContextFrame {
                        kind: ContextKind::Line,
                        members: Vec::new(),
                        raw: format!("line {arg}"),
                        arg: Some(arg),
                    });
                }
            }
        }
    }

    fn truncate_to_config(&mut self) {
        match self.frames.iter().position(|f| f.kind == ContextKind::Config) {
            Some(pos) => self.frames.truncate(pos + 1),
            None => {
                self.frames.clear();
                self.frames.push(config_frame());
            }
        }
    }

    /// Classify a prompt by its suffix. Returns `None` if the text does not
    /// end in something prompt-shaped.
    pub fn classify_prompt(text: &str) -> Option<ContextKind> {
        let last_line = text.trim_end().rsplit('\n').next()?.trim();
        if last_line.is_empty() || last_line.contains(' ') {
            return None;
        }
        if !(last_line.ends_with('#') || last_line.ends_with('>')) {
            return None;
        }
        if let Some(mode) = last_line
            .strip_suffix(")#")
            .and_then(|s| s.rfind('(').map(|i| &s[i + 1..]))
        {
            return Some(match mode {
                "config" => ContextKind::Config,
                m if m.starts_with("config-if") => ContextKind::Interface,
                "config-router" => ContextKind::Router,
                "config-vlan" => ContextKind::Vlan,
                "config-line" => ContextKind::Line,
                _ => ContextKind::Unknown,
            });
        }
        Some(ContextKind::Exec)
    }

    /// Cross-check the stack against a prompt the device just printed.
    pub fn on_prompt(&mut self, text: &str) -> PromptCheck {
        let Some(observed) = Self::classify_prompt(text) else {
            return PromptCheck::NotAPrompt;
        };
        if observed == self.kind() {
            return PromptCheck::Agree;
        }
        // The device is the truth. Rebuild what we can from the prompt alone.
        self.frames.clear();
        match observed {
            ContextKind::Exec => self.unknown = false,
            ContextKind::Config => {
                self.frames.push(config_frame());
                self.unknown = false;
            }
            // We know the mode but not the object (e.g. which interface).
            _ => self.unknown = true,
        }
        PromptCheck::Reset
    }
}

/// True when the tail of the output stream is asking for a secret. This is
/// the belt-and-braces signal; echo suppression (detected by the transport)
/// is the primary one.
pub fn is_credential_prompt(text: &str) -> bool {
    let last_line = text.trim_end().rsplit('\n').next().unwrap_or("");
    triggers().credential_prompt.is_match(last_line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_config_interface_path() {
        let mut s = ContextStack::new();
        s.on_input_line("conf t");
        assert_eq!(s.kind(), ContextKind::Config);
        s.on_input_line("int gi1/0/24");
        assert_eq!(s.kind(), ContextKind::Interface);
        assert_eq!(s.top().unwrap().arg.as_deref(), Some("GigabitEthernet1/0/24"));
        assert_eq!(s.path(), vec!["configure terminal", "interface GigabitEthernet1/0/24"]);
        s.on_input_line("exit");
        assert_eq!(s.kind(), ContextKind::Config);
        s.on_input_line("end");
        assert_eq!(s.kind(), ContextKind::Exec);
    }

    #[test]
    fn submode_from_submode_lands_at_config_depth() {
        let mut s = ContextStack::new();
        s.on_input_line("configure terminal");
        s.on_input_line("interface Gi1/0/1");
        s.on_input_line("interface Gi1/0/2");
        assert_eq!(s.path(), vec!["configure terminal", "interface GigabitEthernet1/0/2"]);
        s.on_input_line("router ospf 1");
        assert_eq!(s.path(), vec!["configure terminal", "router ospf 1"]);
    }

    #[test]
    fn do_and_ctrl_z_behave() {
        let mut s = ContextStack::new();
        s.on_input_line("conf t");
        s.on_input_line("do show ip int brief");
        assert_eq!(s.kind(), ContextKind::Config);
        s.on_input_line("\u{1a}");
        assert_eq!(s.kind(), ContextKind::Exec);
    }

    #[test]
    fn prompt_classification() {
        assert_eq!(ContextStack::classify_prompt("switch#"), Some(ContextKind::Exec));
        assert_eq!(ContextStack::classify_prompt("switch>"), Some(ContextKind::Exec));
        assert_eq!(ContextStack::classify_prompt("sw-01(config)#"), Some(ContextKind::Config));
        assert_eq!(ContextStack::classify_prompt("sw-01(config-if)#"), Some(ContextKind::Interface));
        assert_eq!(ContextStack::classify_prompt("sw-01(config-if-range)#"), Some(ContextKind::Interface));
        assert_eq!(ContextStack::classify_prompt("sw-01(config-router)#"), Some(ContextKind::Router));
        assert_eq!(ContextStack::classify_prompt("sw-01(config-line)#"), Some(ContextKind::Line));
        assert_eq!(ContextStack::classify_prompt("sw-01(config-pmap-c)#"), Some(ContextKind::Unknown));
        assert_eq!(ContextStack::classify_prompt("Building configuration..."), None);
        assert_eq!(ContextStack::classify_prompt("Hardware version: 1#"), None);
        assert_eq!(ContextStack::classify_prompt("output\nsw-01(config)#"), Some(ContextKind::Config));
    }

    #[test]
    fn prompt_disagreement_resets_and_marks_unknown() {
        let mut s = ContextStack::new();
        s.on_input_line("conf t");
        s.on_input_line("int gi1/0/24");
        // Device says we're at (config)# — maybe the interface line was rejected.
        assert_eq!(s.on_prompt("sw(config)#"), PromptCheck::Reset);
        assert_eq!(s.kind(), ContextKind::Config);
        assert!(!s.is_unknown());
        // Device says config-if but we have no idea which interface.
        assert_eq!(s.on_prompt("sw(config-if)#"), PromptCheck::Reset);
        assert_eq!(s.kind(), ContextKind::Unknown);
        // Back at exec we re-sync.
        assert_eq!(s.on_prompt("sw#"), PromptCheck::Reset);
        assert_eq!(s.kind(), ContextKind::Exec);
        assert!(!s.is_unknown());
    }

    #[test]
    fn prompt_agreement_is_noop() {
        let mut s = ContextStack::new();
        s.on_input_line("conf t");
        s.on_input_line("int gi1/0/24");
        assert_eq!(s.on_prompt("sw(config-if)#"), PromptCheck::Agree);
        assert_eq!(s.top().unwrap().arg.as_deref(), Some("GigabitEthernet1/0/24"));
        assert_eq!(s.on_prompt("some output line"), PromptCheck::NotAPrompt);
    }

    #[test]
    fn prompt_prefix_ignores_trailing_text() {
        assert_eq!(prompt_prefix_end("sw-01(config-if)#shut"), Some(17));
        assert_eq!(prompt_prefix_end("sw-01#"), Some(6));
        assert_eq!(prompt_prefix_end("sw-01>show ver"), Some(6));
        assert_eq!(prompt_prefix_end("Hardware version: 1#"), None);
        assert_eq!(prompt_prefix_end("%SYS-5-CONFIG_I: Configured from console"), None);
        assert_eq!(prompt_prefix_end(" --More-- "), None);
        assert_eq!(prompt_prefix_end("shut"), None);
    }

    #[test]
    fn interface_range_expands_to_members() {
        assert_eq!(
            expand_interface_range("gi1/0/1-4, gi1/0/24"),
            vec![
                "GigabitEthernet1/0/1",
                "GigabitEthernet1/0/2",
                "GigabitEthernet1/0/3",
                "GigabitEthernet1/0/4",
                "GigabitEthernet1/0/24"
            ]
        );
        assert_eq!(expand_interface_range("gi1/0/1 - 2"), vec!["GigabitEthernet1/0/1", "GigabitEthernet1/0/2"]);
        assert_eq!(expand_interface_range("te1/1/1-te1/1/2"), vec!["TenGigabitEthernet1/1/1", "TenGigabitEthernet1/1/2"]);
        assert!(expand_interface_range("gi1/0/4-1").is_empty());
        assert_eq!(expand_interface_range("gi1/0/1-999999").len(), 1024);
        let mut s = ContextStack::new();
        s.on_input_line("conf t");
        s.on_input_line("interface range gi1/0/1-4, gi1/0/24");
        let top = s.top().unwrap();
        assert_eq!(top.kind, ContextKind::Interface);
        assert_eq!(top.arg, None);
        assert_eq!(top.members.len(), 5);
        assert_eq!(top.raw, "interface range gi1/0/1-4, gi1/0/24");
    }

    #[test]
    fn interface_or_vlan_mentions() {
        assert!(mentions_interface_or_vlan("switchport access vlan 10"));
        assert!(mentions_interface_or_vlan("switchport trunk allowed vlan add 20,30"));
        assert!(mentions_interface_or_vlan("no interface Vlan10"));
        assert!(mentions_interface_or_vlan("interface Gi1/0/24"));
        assert!(mentions_interface_or_vlan("channel-group 1 mode active source-interface gi1/0/1"));
        assert!(!mentions_interface_or_vlan("description uplink1"));
        assert!(!mentions_interface_or_vlan("ip address 10.1.1.1 255.255.255.0"));
        assert!(!mentions_interface_or_vlan("encapsulation dot1q 10"));
        assert!(!mentions_interface_or_vlan("mtu 9000"));
    }

    #[test]
    fn credential_prompts() {
        assert!(is_credential_prompt("Password: "));
        assert!(is_credential_prompt("sw#enable\nPassword:"));
        assert!(is_credential_prompt("Enter passphrase for key '/root/.ssh/id_rsa':"));
        assert!(is_credential_prompt("Confirm: "));
        assert!(!is_credential_prompt("sw(config)#"));
        assert!(!is_credential_prompt("Enter configuration commands, one per line."));
    }
}
