//! Live guard: the per-session state machine between the WebSocket input
//! loop and the PTY (spec Part C §14.2).
//!
//! Still no I/O. It consumes input chunks and output chunks and returns
//! [`Action`]s; the transport executes them. That keeps the whole
//! Enter-withholding protocol unit-testable against recorded byte streams.
//!
//! Protocol:
//! - Every keystroke is forwarded to the device as typed. **The device is
//!   the line editor** — tab completion, history recall and Ctrl-U all
//!   happen there, and we never try to reconstruct them.
//! - Only the `\r` is withheld. When Enter arrives, the command is read
//!   back from the device's own echo: the text after the last prompt on
//!   the current output line. If the echo has not caught up with what was
//!   typed (WAN latency, paste), the `\r` stays withheld until it settles
//!   — [`Action::AwaitEcho`] asks the transport to tick us — bounded by
//!   [`ECHO_MAX_WAIT`].
//! - Allowed → send the `\r`. Held → send Ctrl-U to clear the device line,
//!   emit a [`HoldNotice`], and wait for [`LiveGuard::on_decision`].
//!   Proceed retypes the line. Keystrokes typed while held are dropped:
//!   the device line was cleared and the dialog is modal. A hold nobody
//!   answers within [`HOLD_TIMEOUT`] is cancelled by the transport via
//!   [`LiveGuard::on_hold_expired`].
//! - A pasted block (more than one line in a single input message) is
//!   evaluated line by line against a simulated context stack and held
//!   as a whole if any line trips (§8).
//! - No echo for typed bytes (password prompts) means there is no line to
//!   parse, so that Enter passes straight through (§3.3).

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use super::context::{mentions_interface_or_vlan, prompt_prefix_end, ContextKind, ContextStack};
use super::trace::TraceRecord;
use super::verbs::{parse, Intent, Verb};
use super::{evaluate, Evaluation, FactValue, Known, Platform, SessionFacts, SessionKind, Verdict};

/// Output silence after Enter that counts as "the echo is complete" when
/// editing keys (tab, arrows, backspace) made the byte count meaningless.
pub const ECHO_QUIET: Duration = Duration::from_millis(75);
/// Output silence that counts as complete when plain characters were typed
/// but the echo is still short — a device that does not echo at all.
pub const ECHO_QUIET_NO_ECHO: Duration = Duration::from_millis(300);
/// Never withhold an Enter longer than this; evaluate whatever echoed.
pub const ECHO_MAX_WAIT: Duration = Duration::from_millis(1000);
/// How often the transport should call [`LiveGuard::on_await_tick`].
pub const ECHO_TICK: Duration = Duration::from_millis(25);
/// A hold with no decision is treated as cancel after this long.
pub const HOLD_TIMEOUT: Duration = Duration::from_secs(60);
/// Facts older than this are re-probed on the next Enter.
pub const FACTS_TTL: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum GuardMode {
    /// Evaluate and trace, never hold.
    DryRun,
    /// Hold on WARN/DENY and wait for a decision.
    Enforce,
}

impl GuardMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "dry-run" | "dryrun" | "dry_run" => Some(GuardMode::DryRun),
            "enforce" => Some(GuardMode::Enforce),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            GuardMode::DryRun => "dry-run",
            GuardMode::Enforce => "enforce",
        }
    }
}

/// What the client is shown while a command is held.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HoldNotice {
    pub id: String,
    /// The tripping line (redacted).
    pub command: String,
    pub verdict: String,
    pub reason: String,
    pub objects: Vec<String>,
    /// 1 for a typed line; >1 when a pasted block was held.
    pub block_lines: usize,
}

/// Something the transport must do. Order matters.
#[derive(Debug, Clone)]
pub enum Action {
    /// Write these bytes to the PTY.
    Send(String),
    /// Tell the client a command is held, and arm a [`HOLD_TIMEOUT`] timer
    /// that calls [`LiveGuard::on_hold_expired`].
    Hold(HoldNotice),
    /// Persist a trace record.
    Trace(TraceRecord),
    /// A config write touched an object in the session path (or the facts
    /// aged past [`FACTS_TTL`]); re-run the probes and call `set_facts`, or
    /// `refresh_failed`. Emitted at most once per refresh cycle.
    RefreshFacts,
    /// An Enter is withheld until the device echo settles. Call
    /// [`LiveGuard::on_await_tick`] every [`ECHO_TICK`] until it stops
    /// returning this. Output chunks may resolve it sooner.
    AwaitEcho,
    /// The hold with this id timed out and was cancelled; the client should
    /// drop its dialog.
    HoldExpired(String),
}

struct Held {
    id: String,
    send_on_proceed: String,
    /// Lines to replay through the context stack if the user proceeds.
    replay: Vec<String>,
    record: TraceRecord,
    /// Whether proceeding would dirty the session path facts.
    touches_path: bool,
}

/// An Enter waiting for the echo to settle (NS-GUARD-5).
struct PendingEnter {
    /// The client's input message, verbatim (`\r`, or text ending in `\r`).
    data: String,
    since: Instant,
    /// Input that arrived while waiting; replayed once resolved.
    queued: String,
}

/// Reconstructs the device's current output line from the byte stream:
/// ANSI stripped, `\r\n` and lone `\r` handled, backspaces applied. Remembers
/// where the prompt ended so the typed command is everything after it.
#[derive(Default)]
struct LineTracker {
    line: String,
    prompt_end: Option<usize>,
    cr_pending: bool,
}

/// Remove ANSI escape sequences (CSI, OSC, two-byte ESC) while keeping C0
/// control characters — `\r`, `\n` and backspace are exactly the bytes the
/// line tracker needs to see. (`strip_ansi_escapes` drops them.)
fn strip_ansi_keep_controls(chunk: &str) -> std::borrow::Cow<'_, str> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]").unwrap()
    });
    re.replace_all(chunk, "")
}

impl LineTracker {
    /// Feed an output chunk. Returns the prompt text the first time a
    /// prompt is recognised at the start of the current line — whatever
    /// follows it (`?` help and `logging synchronous` redraw the prompt
    /// together with the half-typed command, NS-GUARD-4).
    fn feed(&mut self, chunk: &str) -> Option<String> {
        let clean = strip_ansi_keep_controls(chunk);
        for c in clean.chars() {
            if self.cr_pending {
                self.cr_pending = false;
                if c != '\n' {
                    // Bare CR: the device is redrawing from column 0.
                    self.line.clear();
                    self.prompt_end = None;
                }
            }
            match c {
                '\n' => {
                    self.line.clear();
                    self.prompt_end = None;
                }
                '\r' => self.cr_pending = true,
                '\u{8}' => {
                    if self.line.len() > self.prompt_end.unwrap_or(0) {
                        self.line.pop();
                    }
                }
                c if c.is_control() => {}
                c => self.line.push(c),
            }
        }
        if self.cr_pending || self.prompt_end.is_some() {
            return None;
        }
        let end = prompt_prefix_end(&self.line)?;
        self.prompt_end = Some(end);
        Some(self.line[..end].to_string())
    }

    /// The echoed command after the prompt, if we know where the prompt ends.
    fn command(&self) -> Option<String> {
        self.prompt_end.map(|p| self.line[p..].trim().to_string())
    }

    /// Characters echoed after the prompt (untrimmed), if a prompt is known.
    fn echoed_len(&self) -> Option<usize> {
        self.prompt_end.map(|p| self.line[p..].chars().count())
    }
}

/// Is the echoed line trustworthy as the full command? Pure so the
/// settle policy is testable without clocks (NS-GUARD-5).
///
/// - `echoed`/`sent`: characters after the prompt vs printable characters
///   forwarded since that prompt appeared.
/// - `control_sent`: editing keys (tab, arrows, backspace, Ctrl-U) were
///   forwarded, so the counts no longer correspond.
/// - `quiet_for`: output silence measured from the later of the last
///   output chunk and the Enter itself.
/// - `waited`: time since the Enter arrived.
pub fn echo_settled(echoed: usize, sent: usize, control_sent: bool, quiet_for: Duration, waited: Duration) -> bool {
    if waited >= ECHO_MAX_WAIT {
        return true;
    }
    if !control_sent && echoed >= sent {
        return true;
    }
    quiet_for >= if control_sent { ECHO_QUIET } else { ECHO_QUIET_NO_ECHO }
}

pub struct LiveGuard {
    mode: GuardMode,
    device: String,
    platform: Platform,
    session_kind: SessionKind,
    stack: ContextStack,
    facts: SessionFacts,
    line: LineTracker,
    held: Option<Held>,
    pending: Option<PendingEnter>,
    next_id: u64,
    /// When `facts` were collected; `None` until the first `set_facts`.
    facts_at: Option<Instant>,
    /// A `RefreshFacts` is outstanding; suppress duplicates until `set_facts`.
    refresh_pending: bool,
    /// When the last `RefreshFacts` was emitted, so a failing probe is not
    /// retried on every Enter once the facts are past their TTL.
    last_refresh_at: Option<Instant>,
    /// Printable characters forwarded since the current prompt appeared.
    sent_since_prompt: usize,
    /// An editing key was forwarded since the current prompt appeared.
    control_sent: bool,
    last_output_at: Instant,
}

fn unknown_facts() -> SessionFacts {
    SessionFacts {
        path_objects: FactValue { value: Known::Unknown, source: "not collected".to_string(), age_secs: 0 },
        stp_has_alternate: FactValue { value: Known::Unknown, source: "not collected".to_string(), age_secs: 0 },
    }
}

fn is_config_mode(kind: ContextKind) -> bool {
    !matches!(kind, ContextKind::Exec | ContextKind::Unknown)
}

impl LiveGuard {
    pub fn new(device: &str, platform: Platform, mode: GuardMode) -> Self {
        LiveGuard {
            mode,
            device: device.to_string(),
            platform,
            session_kind: SessionKind::Human,
            stack: ContextStack::new(),
            facts: unknown_facts(),
            line: LineTracker::default(),
            held: None,
            pending: None,
            next_id: 0,
            facts_at: None,
            refresh_pending: false,
            last_refresh_at: None,
            sent_since_prompt: 0,
            control_sent: false,
            last_output_at: Instant::now(),
        }
    }

    pub fn mode(&self) -> GuardMode {
        self.mode
    }

    pub fn is_holding(&self) -> bool {
        self.held.is_some()
    }

    /// An Enter is withheld waiting for the echo to settle.
    pub fn is_awaiting_echo(&self) -> bool {
        self.pending.is_some()
    }

    pub fn context(&self) -> &ContextStack {
        &self.stack
    }

    /// Install (or refresh) the session facts once the probes have run.
    pub fn set_facts(&mut self, facts: SessionFacts) {
        self.set_facts_with_age(facts, 0);
    }

    /// Install facts collected `age_secs` ago (tests, replay).
    pub fn set_facts_with_age(&mut self, facts: SessionFacts, age_secs: u64) {
        self.facts = facts;
        self.facts_at = Some(
            Instant::now()
                .checked_sub(Duration::from_secs(age_secs))
                .unwrap_or_else(Instant::now),
        );
        self.refresh_pending = false;
    }

    /// The probe requested by `RefreshFacts` did not produce facts. Clears
    /// the outstanding-refresh flag so the next path write asks again
    /// (NS-GUARD-7); the old facts stay in place.
    pub fn refresh_failed(&mut self) {
        self.refresh_pending = false;
    }

    /// Facts as the predicate should see them right now (ages stamped).
    fn facts_now(&self) -> SessionFacts {
        let age = self.facts_at.map(|t| t.elapsed().as_secs()).unwrap_or(0);
        self.facts.with_age(age)
    }

    /// Collected facts have aged past the TTL and no refresh was asked for
    /// within the last TTL either.
    fn facts_stale(&self) -> bool {
        let Some(at) = self.facts_at else { return false };
        at.elapsed() > FACTS_TTL && self.last_refresh_at.is_none_or(|t| t.elapsed() > FACTS_TTL)
    }

    /// True if the intent writes to an object in the (known) session path.
    fn intent_touches_path(&self, intent: &Intent) -> bool {
        if intent.verb == Verb::Unclassified || intent.verb == Verb::SystemReload {
            return false;
        }
        match &self.facts.path_objects.value {
            Known::Known(set) => intent.objects.iter().any(|o| set.contains(o)),
            Known::Unknown => false,
        }
    }

    /// Emit `RefreshFacts` once per cycle.
    fn maybe_refresh(&mut self, touches_path: bool, actions: &mut Vec<Action>) {
        if self.refresh_pending {
            return;
        }
        if touches_path || self.facts_stale() {
            self.refresh_pending = true;
            self.last_refresh_at = Some(Instant::now());
            actions.push(Action::RefreshFacts);
        }
    }

    fn note_sent(&mut self, data: &str) {
        for c in data.chars() {
            if c.is_control() || c == '\u{7f}' {
                self.control_sent = true;
            } else {
                self.sent_since_prompt += 1;
            }
        }
    }

    fn settled(&self, now: Instant) -> bool {
        let Some(p) = &self.pending else { return true };
        let quiet_since = self.last_output_at.max(p.since);
        echo_settled(
            self.line.echoed_len().unwrap_or(0),
            self.sent_since_prompt,
            self.control_sent,
            now.saturating_duration_since(quiet_since),
            now.saturating_duration_since(p.since),
        )
    }

    /// Feed PTY output. Prompts cross-check the context stack; a withheld
    /// Enter is evaluated as soon as the echo catches up.
    pub fn on_output(&mut self, chunk: &str) -> Vec<Action> {
        let now = Instant::now();
        self.last_output_at = now;
        if let Some(prompt) = self.line.feed(chunk) {
            self.stack.on_prompt(&prompt);
            self.sent_since_prompt = 0;
            self.control_sent = false;
        }
        if self.pending.is_some() && self.settled(now) {
            return self.resolve_pending();
        }
        Vec::new()
    }

    /// Timer callback while an Enter is withheld (see [`Action::AwaitEcho`]).
    pub fn on_await_tick(&mut self) -> Vec<Action> {
        if self.pending.is_none() {
            return Vec::new();
        }
        if self.settled(Instant::now()) {
            self.resolve_pending()
        } else {
            vec![Action::AwaitEcho]
        }
    }

    fn resolve_pending(&mut self) -> Vec<Action> {
        let Some(p) = self.pending.take() else { return Vec::new() };
        let mut actions = self.evaluate_enter(&p.data);
        // Keystrokes typed during the wait: replay them if the line went
        // through; drop them if it was held (the device line was cleared).
        if !p.queued.is_empty() && self.held.is_none() {
            actions.extend(self.on_input(&p.queued));
        }
        actions
    }

    /// Feed client input. Returns the actions to perform, in order.
    pub fn on_input(&mut self, data: &str) -> Vec<Action> {
        if self.held.is_some() {
            // The device line was cleared and the dialog is modal: nothing
            // typed now has a line to land on (NS-GUARD-6).
            return Vec::new();
        }
        if let Some(p) = &mut self.pending {
            p.queued.push_str(data);
            return Vec::new();
        }
        let norm = data.replace("\r\n", "\r").replace('\n', "\r");
        if !norm.contains('\r') {
            self.note_sent(data);
            return vec![Action::Send(data.to_string())];
        }
        let parts: Vec<&str> = norm.split('\r').collect();
        let complete = &parts[..parts.len() - 1];
        let trailing = parts[parts.len() - 1];

        if complete.len() > 1 || !trailing.is_empty() {
            // Pasted block: we have the text itself, no echo needed. The
            // first line may continue whatever was already echoed.
            let mut lines: Vec<String> = Vec::with_capacity(complete.len());
            for (i, part) in complete.iter().enumerate() {
                let line = if i == 0 {
                    format!("{}{}", self.line.command().unwrap_or_default(), part)
                } else {
                    part.to_string()
                };
                let line = line.trim().to_string();
                if !line.is_empty() {
                    lines.push(line);
                }
            }
            return self.commit(data, lines, false);
        }

        // Single Enter: the command is what the device echoed, plus any
        // text the client sent in the same message.
        if self.line.command().is_none() {
            // No prompt known (password prompt, banner, --More--): pass.
            return vec![Action::Send(data.to_string())];
        }
        let now = Instant::now();
        self.pending = Some(PendingEnter { data: data.to_string(), since: now, queued: String::new() });
        if self.settled(now) {
            return self.resolve_pending();
        }
        vec![Action::AwaitEcho]
    }

    /// Evaluate a single Enter (`data` is `\r` or `text\r`) against the echo.
    fn evaluate_enter(&mut self, data: &str) -> Vec<Action> {
        let norm = data.replace("\r\n", "\r").replace('\n', "\r");
        let typed = norm.strip_suffix('\r').unwrap_or(&norm);
        let Some(echoed) = self.line.command() else {
            // The prompt vanished while we waited (async output): pass.
            return vec![Action::Send(data.to_string())];
        };
        let command = format!("{echoed}{typed}").trim().to_string();
        if command.is_empty() {
            // Bare Enter, or bytes typed without echo (credential entry).
            return vec![Action::Send(data.to_string())];
        }
        self.commit(data, vec![command], true)
    }

    /// Evaluate the lines this Enter commits. `retype` is true for a typed
    /// line (device line gets cleared on hold and retyped on proceed) and
    /// false for a pasted block (nothing was sent yet; resend verbatim).
    fn commit(&mut self, data: &str, lines: Vec<String>, retype: bool) -> Vec<Action> {
        let mut sim = self.stack.clone();
        let mut traces = Vec::new();
        let mut trip: Option<(Intent, Evaluation)> = None;
        let mut touches_path = false;
        let facts = self.facts_now();
        for line in &lines {
            let kind = sim.kind();
            let intent = parse(line, &sim, &self.device, self.platform);
            let ev = evaluate(&intent, &facts, self.session_kind);
            let fires = ev.verdict != Verdict::Pass;
            touches_path |= self.intent_touches_path(&intent);
            if self.mode == GuardMode::DryRun && (fires || intent.verb != Verb::Unclassified) {
                let mut rec = TraceRecord::new(intent.clone(), ev.clone(), self.session_kind);
                rec.choice = Some(if fires { "dry-run (would hold)" } else { "dry-run" }.to_string());
                traces.push(rec);
            }
            if fires && trip.is_none() {
                trip = Some((intent, ev));
            }
            let path_before = sim.path();
            sim.on_input_line(line);
            // Any config-mode write naming an interface or VLAN may change
            // the session path, whether or not the object is in the set we
            // know about (NS-GUARD-7). Context entries (`interface X`) and
            // `do show …` are not writes.
            if is_config_mode(kind)
                && sim.path() == path_before
                && !line.trim_start().to_ascii_lowercase().starts_with("do ")
                && mentions_interface_or_vlan(line)
            {
                touches_path = true;
            }
        }

        match (self.mode, trip) {
            (GuardMode::Enforce, Some((intent, ev))) => {
                self.next_id += 1;
                let id = format!("h{}", self.next_id);
                let notice = HoldNotice {
                    id: id.clone(),
                    command: intent.raw.clone(),
                    verdict: ev.verdict.as_str().to_string(),
                    reason: ev.reason.clone(),
                    objects: intent.objects.iter().map(|o| o.to_string()).collect(),
                    block_lines: lines.len(),
                };
                let send_on_proceed = if retype { format!("{}\r", lines[0]) } else { data.to_string() };
                let record = TraceRecord::new(intent, ev, self.session_kind);
                self.held = Some(Held { id, send_on_proceed, replay: lines, record, touches_path });
                let mut actions = Vec::new();
                if retype {
                    actions.push(Action::Send("\u{15}".to_string()));
                }
                actions.push(Action::Hold(notice));
                actions
            }
            _ => {
                self.stack = sim;
                let mut actions = vec![Action::Send(data.to_string())];
                actions.extend(traces.into_iter().map(Action::Trace));
                self.maybe_refresh(touches_path, &mut actions);
                actions
            }
        }
    }

    /// Resolve a hold. Unknown or stale ids are ignored.
    pub fn on_decision(&mut self, id: &str, proceed: bool) -> Vec<Action> {
        let Some(held) = self.held.take() else {
            return Vec::new();
        };
        if held.id != id {
            self.held = Some(held);
            return Vec::new();
        }
        let mut record = held.record;
        if proceed {
            record.choice = Some("proceed".to_string());
            for line in &held.replay {
                self.stack.on_input_line(line);
            }
            let mut actions = vec![Action::Send(held.send_on_proceed), Action::Trace(record)];
            self.maybe_refresh(held.touches_path, &mut actions);
            actions
        } else {
            record.choice = Some("cancel".to_string());
            vec![Action::Trace(record)]
        }
    }

    /// The transport's [`HOLD_TIMEOUT`] fired for `id`. If that hold is
    /// still open it is cancelled and traced as such (NS-GUARD-6); a hold
    /// already decided is left alone.
    pub fn on_hold_expired(&mut self, id: &str) -> Vec<Action> {
        if self.held.as_ref().is_none_or(|h| h.id != id) {
            return Vec::new();
        }
        let held = self.held.take().expect("checked above");
        let mut record = held.record;
        record.choice = Some(format!("cancel (no decision within {}s)", HOLD_TIMEOUT.as_secs()));
        vec![Action::HoldExpired(id.to_string()), Action::Trace(record)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::context::ContextKind;
    use crate::guard::path::{build_path_set, extract_stp_has_alternate, ProbeOutputs};

    const DEVICE: &str = "mgmt-sw-01";

    fn facts() -> SessionFacts {
        let probes = ProbeOutputs {
            ip_route: include_str!("fixtures/ios_xe/ip_route_svi.txt"),
            interfaces_trunk: include_str!("fixtures/ios_xe/interfaces_trunk.txt"),
            run_line_vty: include_str!("fixtures/ios_xe/run_line_vty.txt"),
            run_aaa: include_str!("fixtures/ios_xe/run_aaa.txt"),
        };
        SessionFacts {
            path_objects: FactValue { value: build_path_set(DEVICE, &probes), source: "probes".into(), age_secs: 1 },
            stp_has_alternate: FactValue {
                value: extract_stp_has_alternate(include_str!("fixtures/ios_xe/spanning_tree_vlan10_no_alt.txt")),
                source: "show spanning-tree vlan 10".into(),
                age_secs: 1,
            },
        }
    }

    fn guard(mode: GuardMode) -> LiveGuard {
        let mut g = LiveGuard::new(DEVICE, Platform::IosXe, mode);
        g.set_facts(facts());
        g
    }

    /// Type a line the way a human does: keystrokes, echo, then Enter.
    fn type_line(g: &mut LiveGuard, text: &str) -> Vec<Action> {
        let a = g.on_input(text);
        assert!(matches!(a.as_slice(), [Action::Send(s)] if s == text));
        assert!(g.on_output(text).is_empty()); // device echo
        g.on_input("\r")
    }

    fn sends(actions: &[Action]) -> Vec<&str> {
        actions
            .iter()
            .filter_map(|a| if let Action::Send(s) = a { Some(s.as_str()) } else { None })
            .collect()
    }

    fn hold_id(actions: &[Action]) -> String {
        match actions.iter().find(|a| matches!(a, Action::Hold(_))) {
            Some(Action::Hold(n)) => n.id.clone(),
            _ => panic!("expected a hold, got {actions:?}"),
        }
    }

    fn has_refresh(actions: &[Action]) -> bool {
        actions.iter().any(|a| matches!(a, Action::RefreshFacts))
    }

    fn walk_to_interface(g: &mut LiveGuard) {
        g.on_output("mgmt-sw-01#");
        assert_eq!(sends(&type_line(g, "conf t")), vec!["\r"]);
        g.on_output("\r\nEnter configuration commands, one per line.  End with CNTL/Z.\r\nmgmt-sw-01(config)#");
        assert_eq!(g.context().kind(), ContextKind::Config);
        assert_eq!(sends(&type_line(g, "int gi1/0/24")), vec!["\r"]);
        g.on_output("\r\nmgmt-sw-01(config-if)#");
        assert_eq!(g.context().kind(), ContextKind::Interface);
    }

    #[test]
    fn no_prompt_known_means_pass_through() {
        let mut g = guard(GuardMode::Enforce);
        let a = g.on_input("shut\r");
        assert_eq!(sends(&a), vec!["shut\r"]);
        assert!(!g.is_holding());
    }

    #[test]
    fn echo_derived_hold_then_proceed() {
        let mut g = guard(GuardMode::Enforce);
        walk_to_interface(&mut g);
        let a = type_line(&mut g, "shut");
        assert_eq!(sends(&a), vec!["\u{15}"], "device line is cleared, Enter withheld");
        let Some(Action::Hold(n)) = a.iter().find(|a| matches!(a, Action::Hold(_))) else {
            panic!("expected hold, got {a:?}");
        };
        assert_eq!(n.command, "shut");
        assert_eq!(n.verdict, "WARN");
        assert_eq!(n.objects, vec!["iface:mgmt-sw-01:GigabitEthernet1/0/24"]);
        assert_eq!(n.block_lines, 1);
        assert!(g.is_holding());

        let a = g.on_decision(&n.id, true);
        assert_eq!(sends(&a), vec!["shut\r"], "retyped on proceed");
        assert!(matches!(&a[1], Action::Trace(r) if r.choice.as_deref() == Some("proceed")));
        assert!(!g.is_holding());
    }

    /// NS-GUARD-2: the Phase-24 dialog intercepts Enter on a fully spelled
    /// `shutdown`, then "Proceed" sends only `\r` (NS-TERM-3). The guard
    /// sees the echoed line exactly once and holds it.
    #[test]
    fn full_shutdown_after_safety_dialog_proceed_is_held() {
        let mut g = guard(GuardMode::Enforce);
        walk_to_interface(&mut g);
        for c in "shutdown".chars() {
            let s = c.to_string();
            assert_eq!(sends(&g.on_input(&s)), vec![s.as_str()]);
            g.on_output(&s);
        }
        // Phase 24 held the Enter locally; the user clicked Proceed.
        let a = g.on_input("\r");
        assert_eq!(sends(&a), vec!["\u{15}"]);
        let Some(Action::Hold(n)) = a.iter().find(|a| matches!(a, Action::Hold(_))) else { panic!("{a:?}") };
        assert_eq!(n.command, "shutdown", "not `shutdownshutdown`");
        assert_eq!(n.verdict, "WARN");
    }

    #[test]
    fn cancel_writes_trace_and_sends_nothing() {
        let mut g = guard(GuardMode::Enforce);
        walk_to_interface(&mut g);
        let a = type_line(&mut g, "shutdown");
        let id = hold_id(&a);
        let a = g.on_decision(&id, false);
        assert!(sends(&a).is_empty());
        assert!(matches!(&a[0], Action::Trace(r) if r.choice.as_deref() == Some("cancel")));
        // Still in interface context; nothing was sent.
        assert_eq!(g.context().kind(), ContextKind::Interface);
    }

    #[test]
    fn dry_run_sends_enter_and_traces() {
        let mut g = guard(GuardMode::DryRun);
        walk_to_interface(&mut g);
        let a = type_line(&mut g, "shut");
        assert_eq!(sends(&a), vec!["\r"]);
        assert!(matches!(&a[1], Action::Trace(r) if r.choice.as_deref() == Some("dry-run (would hold)")));
        assert!(!g.is_holding());
    }

    #[test]
    fn dry_run_traces_classified_but_not_noise() {
        let mut g = guard(GuardMode::DryRun);
        walk_to_interface(&mut g);
        let a = type_line(&mut g, "description uplink");
        assert_eq!(a.len(), 1, "unclassified lines produce no trace: {a:?}");
        g.on_output("\r\nmgmt-sw-01(config-if)#");
        let a = type_line(&mut g, "no shut");
        let traces: Vec<&TraceRecord> = a.iter().filter_map(|a| if let Action::Trace(r) = a { Some(r) } else { None }).collect();
        assert_eq!(traces.len(), 1, "{a:?}");
        assert_eq!(traces[0].choice.as_deref(), Some("dry-run"));
    }

    #[test]
    fn unknown_facts_never_hold() {
        let mut g = LiveGuard::new(DEVICE, Platform::IosXe, GuardMode::Enforce);
        walk_to_interface(&mut g);
        let a = type_line(&mut g, "shut");
        assert_eq!(sends(&a), vec!["\r"]);
        assert!(!g.is_holding());
    }

    #[test]
    fn backspace_in_echo_is_applied() {
        let mut g = guard(GuardMode::Enforce);
        walk_to_interface(&mut g);
        g.on_input("shuu");
        g.on_output("shuu");
        g.on_input("\u{8}");
        g.on_output("\u{8} \u{8}"); // IOS erases with BS-space-BS
        g.on_input("t");
        g.on_output("t");
        // A backspace was sent, so the byte count is untrusted: the Enter
        // waits for output silence, which the tick supplies.
        let a = g.on_input("\r");
        assert!(matches!(a.as_slice(), [Action::AwaitEcho]), "{a:?}");
        std::thread::sleep(ECHO_QUIET + Duration::from_millis(10));
        let a = g.on_await_tick();
        assert!(matches!(&a[1], Action::Hold(n) if n.command == "shut"), "{a:?}");
    }

    #[test]
    fn credential_entry_passes_without_parsing() {
        let mut g = guard(GuardMode::Enforce);
        g.on_output("mgmt-sw-01>");
        assert_eq!(sends(&type_line(&mut g, "enable")), vec!["\r"]);
        g.on_output("\r\nPassword: ");
        // No echo for the secret; Enter passes straight through.
        g.on_input("hunter2");
        let a = g.on_input("\r");
        assert_eq!(a.len(), 1);
        assert_eq!(sends(&a), vec!["\r"]);
        // Typed-without-echo at a real prompt: the echo never catches up,
        // so the Enter is released once the line has been quiet.
        g.on_output("\r\nmgmt-sw-01#");
        g.on_input("abc");
        let a = g.on_input("\r");
        assert!(matches!(a.as_slice(), [Action::AwaitEcho]), "{a:?}");
        assert!(g.is_awaiting_echo());
        assert!(matches!(g.on_await_tick().as_slice(), [Action::AwaitEcho]));
        std::thread::sleep(ECHO_QUIET_NO_ECHO + Duration::from_millis(10));
        assert_eq!(sends(&g.on_await_tick()), vec!["\r"]);
        assert!(!g.is_awaiting_echo());
    }

    #[test]
    fn pasted_block_is_held_whole_and_resent_verbatim() {
        let mut g = guard(GuardMode::Enforce);
        g.on_output("mgmt-sw-01#");
        let block = "conf t\rinterface Gi1/0/24\rshut\rend\r";
        let a = g.on_input(block);
        assert!(sends(&a).is_empty(), "nothing reaches the device while held");
        let Action::Hold(n) = &a[0] else { panic!("{a:?}") };
        assert_eq!(n.command, "shut");
        assert_eq!(n.block_lines, 4);
        let a = g.on_decision(&n.id, true);
        assert_eq!(sends(&a), vec![block]);
        assert_eq!(g.context().kind(), ContextKind::Exec, "stack replayed through `end`");
    }

    #[test]
    fn clean_pasted_block_passes_and_advances_stack() {
        let mut g = guard(GuardMode::Enforce);
        g.on_output("mgmt-sw-01#");
        let block = "conf t\ninterface Gi1/0/5\n shutdown\n";
        let a = g.on_input(block);
        assert_eq!(sends(&a), vec![block]);
        assert_eq!(g.context().kind(), ContextKind::Interface);
    }

    #[test]
    fn prompt_disagreement_resyncs_before_evaluation() {
        let mut g = guard(GuardMode::Enforce);
        walk_to_interface(&mut g);
        // Device says we are back at (config)# — our stack was wrong.
        g.on_output("\r\nmgmt-sw-01(config)#");
        assert_eq!(g.context().kind(), ContextKind::Config);
        let a = type_line(&mut g, "shut");
        assert_eq!(sends(&a), vec!["\r"], "unclassified at (config)# passes");
    }

    #[test]
    fn input_during_hold_is_dropped_and_wrong_id_is_ignored() {
        let mut g = guard(GuardMode::Enforce);
        walk_to_interface(&mut g);
        let a = type_line(&mut g, "shut");
        let id = hold_id(&a);
        assert!(g.on_input("x").is_empty(), "the device line was cleared; blind keystrokes go nowhere");
        assert!(g.on_input("\r").is_empty(), "Enter never bypasses an open hold");
        assert!(g.on_decision("nope", true).is_empty());
        assert!(g.is_holding());
        assert_eq!(sends(&g.on_decision(&id, true)), vec!["shut\r"]);
    }

    /// NS-GUARD-6: a hold nobody answers is cancelled with a trace record.
    #[test]
    fn hold_expiry_is_a_traced_cancel() {
        let mut g = guard(GuardMode::Enforce);
        walk_to_interface(&mut g);
        let id = hold_id(&type_line(&mut g, "shut"));
        assert!(g.on_hold_expired("other").is_empty(), "stale timer for another hold");
        assert!(g.is_holding());
        let a = g.on_hold_expired(&id);
        assert!(matches!(&a[0], Action::HoldExpired(h) if h == &id), "{a:?}");
        assert!(matches!(&a[1], Action::Trace(r) if r.choice.as_deref().is_some_and(|c| c.starts_with("cancel"))));
        assert!(sends(&a).is_empty());
        assert!(!g.is_holding());
        assert_eq!(g.context().kind(), ContextKind::Interface);
        // The timer firing after a decision is a no-op.
        assert!(g.on_hold_expired(&id).is_empty());
        assert!(g.on_decision(&id, true).is_empty());
        // Typing works again.
        assert_eq!(sends(&g.on_input("x")), vec!["x"]);
    }

    #[test]
    fn config_write_to_path_object_requests_one_refresh() {
        let mut g = guard(GuardMode::DryRun);
        walk_to_interface(&mut g);
        g.set_facts(facts()); // `int gi1/0/24` itself asked for one; clear it
        // `no shut` on the uplink: passes, but it touched a path object.
        let a = type_line(&mut g, "no shut");
        assert!(has_refresh(&a), "{a:?}");
        g.on_output("\r\nmgmt-sw-01(config-if)#");
        // Second write before facts arrive: no duplicate request.
        let a = type_line(&mut g, "no shut");
        assert!(!has_refresh(&a));
        g.on_output("\r\nmgmt-sw-01(config-if)#");
        g.set_facts(facts());
        let a = type_line(&mut g, "no shut");
        assert!(has_refresh(&a));
        // Unrelated port: entering it names an interface (refresh), but a
        // write that names nothing on a port outside the path does not.
        g.set_facts(facts());
        g.on_output("\r\nmgmt-sw-01(config-if)#");
        let a = type_line(&mut g, "int gi1/0/5");
        assert_eq!(sends(&a), vec!["\r"]);
        assert!(!has_refresh(&a), "context entry is not a write: {a:?}");
        g.on_output("\r\nmgmt-sw-01(config-if)#");
        let a = type_line(&mut g, "shut");
        assert!(!has_refresh(&a));
    }

    /// NS-GUARD-7: writes naming an interface/VLAN outside the known set
    /// still refresh; `do show` and exec-mode lines do not.
    #[test]
    fn config_write_naming_interface_or_vlan_requests_refresh() {
        let mut g = guard(GuardMode::DryRun);
        walk_to_interface(&mut g);
        g.set_facts(facts());
        g.on_output("\r\nmgmt-sw-01(config-if)#");
        let a = type_line(&mut g, "switchport trunk allowed vlan add 30");
        assert!(has_refresh(&a), "{a:?}");
        g.set_facts(facts());
        g.on_output("\r\nmgmt-sw-01(config-if)#");
        let a = type_line(&mut g, "do show int gi1/0/1");
        assert!(!has_refresh(&a), "{a:?}");
        g.on_output("\r\nmgmt-sw-01(config-if)#");
        let a = type_line(&mut g, "description uplink");
        assert!(!has_refresh(&a), "{a:?}");
        g.on_output("\r\nmgmt-sw-01(config-if)#");
        assert_eq!(sends(&type_line(&mut g, "end")), vec!["\r"]);
        g.on_output("\r\nmgmt-sw-01#");
        let a = type_line(&mut g, "show int gi1/0/1");
        assert!(!has_refresh(&a), "exec is never a write: {a:?}");
    }

    /// NS-GUARD-7: facts past their TTL are re-probed on the next Enter;
    /// a failed probe clears the outstanding flag without retrying on
    /// every Enter.
    #[test]
    fn stale_facts_are_reprobed_and_failed_probe_clears_pending() {
        let mut g = LiveGuard::new(DEVICE, Platform::IosXe, GuardMode::DryRun);
        g.set_facts_with_age(facts(), FACTS_TTL.as_secs() + 1);
        g.on_output("mgmt-sw-01#");
        let a = type_line(&mut g, "show clock");
        assert!(has_refresh(&a), "{a:?}");
        g.on_output("\r\nmgmt-sw-01#");
        let a = type_line(&mut g, "show clock");
        assert!(!has_refresh(&a), "one outstanding refresh at a time");
        g.refresh_failed();
        g.on_output("\r\nmgmt-sw-01#");
        let a = type_line(&mut g, "show clock");
        assert!(!has_refresh(&a), "failed probe is not retried on every Enter");
        // A path write still asks straight away.
        assert_eq!(sends(&type_line(&mut g, "conf t")), vec!["\r"]);
        g.on_output("\r\nmgmt-sw-01(config)#");
        assert_eq!(sends(&type_line(&mut g, "int gi1/0/24")), vec!["\r"]);
        g.on_output("\r\nmgmt-sw-01(config-if)#");
        let a = type_line(&mut g, "no shut");
        assert!(has_refresh(&a), "{a:?}");
        // Never-collected facts have no TTL.
        let mut g = LiveGuard::new(DEVICE, Platform::IosXe, GuardMode::DryRun);
        g.on_output("mgmt-sw-01#");
        assert!(!has_refresh(&type_line(&mut g, "show clock")));
    }

    #[test]
    fn proceeding_after_hold_requests_refresh_and_ages_are_stamped() {
        let mut g = LiveGuard::new(DEVICE, Platform::IosXe, GuardMode::Enforce);
        walk_to_interface(&mut g);
        g.set_facts_with_age(facts(), 90);
        let a = type_line(&mut g, "shut");
        let id = hold_id(&a);
        let a = g.on_decision(&id, true);
        assert!(matches!(&a[2], Action::RefreshFacts), "{a:?}");
        let Action::Trace(rec) = &a[1] else { panic!() };
        assert!(rec.evaluation.facts_consulted.iter().all(|f| f.age_secs >= 90), "{:?}", rec.evaluation.facts_consulted);
    }

    /// NS-GUARD-10: `interface range` evaluates every member.
    #[test]
    fn interface_range_including_uplink_is_held() {
        let mut g = guard(GuardMode::Enforce);
        g.on_output("mgmt-sw-01#");
        assert_eq!(sends(&type_line(&mut g, "conf t")), vec!["\r"]);
        g.on_output("\r\nmgmt-sw-01(config)#");
        assert_eq!(sends(&type_line(&mut g, "interface range gi1/0/1-4, gi1/0/24")), vec!["\r"]);
        g.on_output("\r\nmgmt-sw-01(config-if-range)#");
        assert_eq!(g.context().kind(), ContextKind::Interface);
        let a = type_line(&mut g, "shut");
        let Some(Action::Hold(n)) = a.iter().find(|a| matches!(a, Action::Hold(_))) else { panic!("{a:?}") };
        assert_eq!(n.objects.len(), 5);
        assert!(n.objects.contains(&"iface:mgmt-sw-01:GigabitEthernet1/0/24".to_string()));
        assert!(n.reason.contains("GigabitEthernet1/0/24"));
        // A range that misses the uplink passes.
        let mut g = guard(GuardMode::Enforce);
        g.on_output("mgmt-sw-01#");
        type_line(&mut g, "conf t");
        g.on_output("\r\nmgmt-sw-01(config)#");
        type_line(&mut g, "interface range gi1/0/1-4");
        g.on_output("\r\nmgmt-sw-01(config-if-range)#");
        assert_eq!(sends(&type_line(&mut g, "shut")), vec!["\r"]);
    }

    /// NS-GUARD-4: `?` help redraws the prompt with the half-typed command
    /// on one line; the prompt is still found and the Enter evaluated.
    #[test]
    fn help_redraw_keeps_prompt_position() {
        let mut g = guard(GuardMode::Enforce);
        walk_to_interface(&mut g);
        g.on_input("shut");
        g.on_output("shut");
        g.on_input("?");
        // IOS does not echo `?`; it prints the help and redraws prompt+line.
        g.on_output("\r\n  <cr>  <cr>\r\nmgmt-sw-01(config-if)#shut");
        assert_eq!(g.context().kind(), ContextKind::Interface);
        let a = g.on_input("\r");
        assert!(matches!(&a[1], Action::Hold(n) if n.command == "shut"), "{a:?}");
    }

    /// NS-GUARD-4: `logging synchronous` interrupts the line with a syslog
    /// message and redraws prompt + partial command.
    #[test]
    fn syslog_mid_line_redraw_keeps_prompt_position() {
        let mut g = guard(GuardMode::Enforce);
        walk_to_interface(&mut g);
        g.on_input("shu");
        g.on_output("shu");
        g.on_output("\r\n%SYS-5-CONFIG_I: Configured from console by admin on vty0 (10.20.4.55)\r\nmgmt-sw-01(config-if)#shu");
        g.on_input("t");
        g.on_output("t");
        let a = g.on_input("\r");
        assert!(matches!(&a[1], Action::Hold(n) if n.command == "shut"), "{a:?}");
        // Without a synchronous redraw the prompt is gone: the Enter passes
        // rather than guessing.
        let mut g = guard(GuardMode::Enforce);
        walk_to_interface(&mut g);
        g.on_input("shut");
        g.on_output("shut");
        g.on_output("\r\n%LINK-3-UPDOWN: Interface GigabitEthernet1/0/5, changed state to down\r\n");
        assert_eq!(sends(&g.on_input("\r")), vec!["\r"]);
    }

    /// NS-GUARD-5: Enter arriving before the echo has caught up is withheld
    /// and evaluated once the echo lands (or the wait bounds out).
    #[test]
    fn enter_waits_for_lagging_echo() {
        let mut g = guard(GuardMode::Enforce);
        walk_to_interface(&mut g);
        g.on_input("shu");
        g.on_output("shu");
        g.on_input("t");
        // Enter races the echo of `t` across the WAN.
        let a = g.on_input("\r");
        assert!(matches!(a.as_slice(), [Action::AwaitEcho]), "{a:?}");
        assert!(g.is_awaiting_echo());
        // Keystrokes typed meanwhile are queued, not sent onto the old line.
        assert!(g.on_input("x").is_empty());
        assert!(matches!(g.on_await_tick().as_slice(), [Action::AwaitEcho]));
        // The echo lands: evaluated immediately from the output path.
        let a = g.on_output("t");
        assert!(matches!(&a[1], Action::Hold(n) if n.command == "shut"), "{a:?}");
        assert!(!g.is_awaiting_echo());
        assert!(g.on_await_tick().is_empty(), "nothing pending any more");
        // The queued `x` was dropped: the device line was cleared for the hold.
        assert!(sends(&a).iter().all(|s| *s == "\u{15}"));
    }

    #[test]
    fn queued_input_replays_after_a_passing_enter() {
        let mut g = guard(GuardMode::Enforce);
        g.on_output("mgmt-sw-01#");
        g.on_input("show clo");
        g.on_output("show clo");
        g.on_input("ck");
        let a = g.on_input("\r");
        assert!(matches!(a.as_slice(), [Action::AwaitEcho]), "{a:?}");
        g.on_input("sh");
        let a = g.on_output("ck");
        assert_eq!(sends(&a), vec!["\r", "sh"], "{a:?}");
        assert!(!g.is_awaiting_echo());
    }

    #[test]
    fn echo_settle_policy() {
        let z = Duration::ZERO;
        // Plain typing: the count is authoritative.
        assert!(echo_settled(4, 4, false, z, z));
        assert!(echo_settled(5, 4, false, z, z));
        assert!(!echo_settled(3, 4, false, z, z));
        assert!(!echo_settled(3, 4, false, ECHO_QUIET, ECHO_QUIET));
        // ...unless the device never echoes: a longer silence releases it.
        assert!(echo_settled(0, 4, false, ECHO_QUIET_NO_ECHO, ECHO_QUIET_NO_ECHO));
        // Editing keys: only silence counts.
        assert!(!echo_settled(9, 4, true, z, z));
        assert!(echo_settled(9, 4, true, ECHO_QUIET, ECHO_QUIET));
        // Hard bound.
        assert!(echo_settled(0, 4, true, z, ECHO_MAX_WAIT));
        assert!(echo_settled(0, 4, false, z, ECHO_MAX_WAIT));
    }

    #[test]
    fn ansi_and_bare_cr_redraws_are_handled() {
        let mut t = LineTracker::default();
        assert!(t.feed("\u{1b}[0m\u{1b}[?25hmgmt-sw-01(config-if)#").is_some());
        t.feed("shu");
        assert_eq!(t.command().as_deref(), Some("shu"));
        // OSC title + CSI colour sequences vanish; text survives.
        t.feed("\u{1b}]0;title\u{7}\u{1b}[32mt\u{1b}[0m");
        assert_eq!(t.command().as_deref(), Some("shut"));
        assert_eq!(t.echoed_len(), Some(4));
        // Redraw from column 0 (bare CR) re-locates the prompt on the new line.
        assert_eq!(t.feed("\rmgmt-sw-01(config-if)#shut").as_deref(), Some("mgmt-sw-01(config-if)#"));
        assert_eq!(t.command().as_deref(), Some("shut"));
        // A prompt is reported once per line, not on every echo chunk.
        assert!(t.feed("d").is_none());
        assert_eq!(t.command().as_deref(), Some("shutd"));
        assert_eq!(GuardMode::parse("Enforce"), Some(GuardMode::Enforce));
        assert_eq!(GuardMode::parse("dry-run"), Some(GuardMode::DryRun));
        assert_eq!(GuardMode::parse("bogus"), None);
    }
}
