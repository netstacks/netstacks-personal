//! The trace record (spec §5): written only when a predicate fires, only to
//! local disk, owned by the customer. Replayable, debuggable, tunable.
//!
//! `render` produces the exact text shape the spec defines. Get this right
//! before anything else — it is the engine's contract.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

use super::verbs::Intent;
use super::{Evaluation, SessionKind};

#[derive(Debug, Clone, Serialize)]
pub struct TraceRecord {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub session_kind: SessionKind,
    pub intent: Intent,
    pub evaluation: Evaluation,
    /// What rollback was armed, e.g. `armed  "reload in 5"`. Filled after the hold.
    pub guard: Option<String>,
    /// What the user chose: `proceed`, `cancel`, `proceed-unarmed`.
    pub choice: Option<String>,
    /// What actually happened, appended once known.
    pub outcome: Option<String>,
}

impl TraceRecord {
    pub fn new(intent: Intent, evaluation: Evaluation, session_kind: SessionKind) -> Self {
        let id = uuid::Uuid::new_v4().simple().to_string()[..5].to_string();
        Self::with_id_and_time(id, Utc::now(), intent, evaluation, session_kind)
    }

    pub fn with_id_and_time(
        id: String,
        timestamp: DateTime<Utc>,
        intent: Intent,
        evaluation: Evaluation,
        session_kind: SessionKind,
    ) -> Self {
        TraceRecord { id, timestamp, session_kind, intent, evaluation, guard: None, choice: None, outcome: None }
    }

    /// Render in the §5 text format.
    pub fn render(&self) -> String {
        let mut out = String::new();
        let ts = self.timestamp.to_rfc3339_opts(SecondsFormat::Secs, true);
        let header = format!("evaluation {}", self.id);
        out.push_str(&format!("{header:<50}{ts}\n"));
        out.push_str(&format!("  device:  {} ({})\n", self.intent.device, self.intent.platform.as_str()));
        let objects = if self.intent.objects.is_empty() {
            "(no object)".to_string()
        } else {
            self.intent.objects.iter().map(|o| o.to_string()).collect::<Vec<_>>().join(", ")
        };
        out.push_str(&format!("  intent:  {} → {}\n", self.intent.verb.as_str(), objects));
        out.push_str(&format!("  raw:     {:?}\n", self.intent.raw));
        let ctx = self.intent.context.iter().map(|c| format!("{c:?}")).collect::<Vec<_>>().join(", ");
        out.push_str(&format!("  context: [{ctx}]\n"));

        out.push('\n');
        out.push_str("  facts consulted:\n");
        if self.evaluation.facts_consulted.is_empty() {
            out.push_str("    (none)\n");
        }
        for f in &self.evaluation.facts_consulted {
            out.push_str(&format!("    {} = {}\n", f.name, f.value));
            out.push_str(&format!("                           source {:?}\n", f.source));
            out.push_str(&format!("                           age {}s\n", f.age_secs));
        }

        out.push('\n');
        out.push_str(&format!("  verdict: {} ({} session)\n", self.evaluation.verdict.as_str(), self.session_kind.as_str()));
        out.push_str(&format!("  reason:  {}\n", self.evaluation.reason));
        if let Some(g) = &self.guard {
            out.push_str(&format!("  guard:   {g}\n"));
        }
        if let Some(c) = &self.choice {
            out.push_str(&format!("  choice:  {c}\n"));
        }
        if let Some(o) = &self.outcome {
            out.push_str(&format!("  outcome: {o}\n"));
        }
        out
    }
}
