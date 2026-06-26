//! Background-task human-interaction service (AUDIT FIX EXEC-017, Feature B).
//!
//! Originally a binary approve/reject gate on mutating tools. Feature B
//! generalizes it into a typed, two-way **interaction** channel: the ReAct
//! loop can park on an `Approval` (mutating-tool gate), a free-form
//! `Question` (the `ask_user` tool), a `Plan` review, or a `Checkpoint` that
//! carries a masked credential — and resume the SAME Tokio task with the
//! user's typed `HumanResponse`.
//!
//! The frontend polls `GET /api/tasks/:id/pending-interactions`, surfaces a
//! kind-switched panel, and resolves via the typed resolve endpoint. While
//! waiting the task status stays `Running` (the pending interaction is
//! in-memory state; Feature B Step 3 also persists it for restart recovery).
//!
//! Fail-closed: cancellation, timeout, or a dropped receiver all collapse to
//! `Reject`. A structural invariant in `resolve()` prevents a `Question`
//! answer from ever resolving an `Approval`/`Checkpoint` gate.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::store::TaskStore;

/// Maximum time the user has to respond to a parked interaction before the
/// task auto-rejects. Generous because a user might step away from a
/// long-running agent task.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);

/// Returns true when the named tool requires explicit user approval per
/// invocation. Add new mutating tools here.
pub fn is_mutating_tool(name: &str) -> bool {
    // Delegate to the canonical tool-name catalog (Feature A) so this and the
    // output validator can never silently disagree on a tool's classification.
    super::tools::catalog::is_mutating(name)
}

/// What kind of decision the task is parked on. Drives the frontend's
/// InteractionPanel render (approve/reject vs free-text vs plan-edit vs a
/// masked credential checkpoint). STRUCTURAL INVARIANT: a `Question` answer
/// can NEVER resolve an `Approval`/`Checkpoint` interaction, and vice-versa
/// — enforced in `resolve()` via `response_matches_kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InteractionKind {
    /// Mutating-tool gate (the legacy approve/reject path).
    Approval,
    /// Free-form clarifying question from the `ask_user` tool.
    Question,
    // Future (autonomy dial): Plan (review/edit a proposed plan) and
    // Checkpoint (masked-credential review). Add when those features land —
    // omitted here to keep the build warning-clean (no unused variants).
}

impl InteractionKind {
    /// DB / wire string form (matches the schema CHECK + serde lowercase).
    fn as_str(&self) -> &'static str {
        match self {
            InteractionKind::Approval => "approval",
            InteractionKind::Question => "question",
        }
    }
}

/// Compact JSON audit representation of a resolved response for the durable
/// `task_interactions.response_json` column.
fn human_response_repr(resp: &HumanResponse) -> String {
    match resp {
        HumanResponse::Approve => "{\"kind\":\"approve\"}".to_string(),
        HumanResponse::Reject { reason } => {
            serde_json::json!({ "kind": "reject", "reason": reason }).to_string()
        }
        HumanResponse::Answer { text } => {
            serde_json::json!({ "kind": "answer", "text": text }).to_string()
        }
        HumanResponse::AnswerStructured { json } => {
            serde_json::json!({ "kind": "answer_structured", "json": json }).to_string()
        }
    }
}

/// The user's typed reply to a parked interaction. Fail-closed default is
/// `Reject` (timeout / cancellation / dropped-receiver collapse to it).
#[derive(Debug, Clone)]
pub enum HumanResponse {
    Approve,
    Reject { reason: Option<String> },
    Answer { text: String },
    AnswerStructured { json: serde_json::Value },
    // Future (autonomy dial): EditPlan { steps }. Add with the Plan kind.
}

/// A parked interaction awaiting the user, serialized to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct PendingInteraction {
    pub id: String,
    pub task_id: String,
    pub kind: InteractionKind,
    /// Human-readable prompt to show the user. For Approval this is derived
    /// from tool_name; for Question it is the agent's question text.
    pub prompt: String,
    /// Optional choice chips (e.g. ["Yes", "No", "Skip"]) for Question/Plan.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
    /// Present for Approval/Checkpoint: the tool being gated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Present for Approval: the tool input the user is approving.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<serde_json::Value>,
    /// Optional inline diff (unified diff text) for Plan/Checkpoint review.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    pub created_at: String,
}

struct PendingState {
    info: PendingInteraction,
    sender: oneshot::Sender<HumanResponse>,
}

pub struct TaskApprovalService {
    /// Interaction id → state. The ReAct loop is sequential, so one task has
    /// at most one active interaction at a time (the map is keyed by
    /// interaction id, not task id).
    pending: RwLock<HashMap<String, PendingState>>,
    /// Store handle for best-effort durable persistence (Feature B Step 3).
    store: TaskStore,
}

impl TaskApprovalService {
    pub fn new(store: TaskStore) -> Arc<Self> {
        Arc::new(Self {
            pending: RwLock::new(HashMap::new()),
            store,
        })
    }

    /// Approval-gate convenience: park on an `Approval`-kind interaction for a
    /// mutating tool. Cancel-aware + fail-closed.
    pub async fn request(
        &self,
        task_id: String,
        kind: InteractionKind,
        tool_name: String,
        tool_input: serde_json::Value,
        cancel_token: &CancellationToken,
    ) -> HumanResponse {
        self.request_full(
            PendingInteraction {
                id: Uuid::new_v4().to_string(),
                task_id,
                kind,
                prompt: format!("Approve tool: {}", tool_name),
                choices: None,
                tool_name: Some(tool_name),
                tool_input: Some(tool_input),
                diff: None,
                created_at: chrono::Utc::now().to_rfc3339(),
            },
            cancel_token,
        )
        .await
    }

    /// Generalized park used by the approval gate (`Approval`) and `ask_user`
    /// (`Question`). The caller builds the full `PendingInteraction`.
    ///
    /// Cancel-aware + FAIL-CLOSED: cancellation, the 600s timeout, OR a
    /// dropped receiver all collapse to `Reject`. Do NOT collapse these arms
    /// into an `unwrap_or` — every non-resolve outcome must reach `Reject`.
    pub async fn request_full(
        &self,
        info: PendingInteraction,
        cancel_token: &CancellationToken,
    ) -> HumanResponse {
        let id = info.id.clone();
        let task_id = info.task_id.clone();
        let kind = info.kind;
        let (tx, rx) = oneshot::channel();

        tracing::warn!(
            target: "audit",
            task_id = %task_id,
            kind = ?kind,
            interaction_id = %id,
            "ReAct task awaiting human interaction"
        );

        // Feature B Step 3: persist the interaction BEFORE parking so a restart
        // sweep can mark it expired (fail-closed). Best-effort — a persist
        // failure must never fail the task. Extract fields before `info` moves.
        let choices_json = info.choices.as_ref().and_then(|c| serde_json::to_string(c).ok());
        let tool_input_json = info.tool_input.as_ref().and_then(|v| serde_json::to_string(v).ok());
        if let Err(e) = self
            .store
            .create_interaction(
                &id,
                &task_id,
                kind.as_str(),
                &info.prompt,
                choices_json.as_deref(),
                info.tool_name.as_deref(),
                tool_input_json.as_deref(),
                info.diff.as_deref(),
            )
            .await
        {
            tracing::warn!(task_id = %task_id, error = %e, "failed to persist interaction");
        }

        self.pending
            .write()
            .await
            .insert(id.clone(), PendingState { info, sender: tx });

        let (resp, db_status, db_response): (HumanResponse, &'static str, Option<String>) = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                tracing::warn!(
                    target: "audit",
                    task_id = %task_id, kind = ?kind,
                    "human interaction cancelled — treating as rejected"
                );
                (HumanResponse::Reject { reason: Some("cancelled".to_string()) }, "expired", None)
            }
            outcome = tokio::time::timeout(APPROVAL_TIMEOUT, rx) => {
                match outcome {
                    Ok(Ok(resp)) => {
                        tracing::warn!(
                            target: "audit",
                            task_id = %task_id, kind = ?kind,
                            "human interaction resolved"
                        );
                        let repr = human_response_repr(&resp);
                        (resp, "resolved", Some(repr))
                    }
                    // FAIL-CLOSED: timeout (Err(Elapsed)) OR dropped sender
                    // (Ok(Err(RecvError))) both deny.
                    _ => {
                        tracing::warn!(
                            target: "audit",
                            task_id = %task_id, kind = ?kind,
                            "human interaction timed out / receiver dropped — treating as rejected"
                        );
                        (HumanResponse::Reject { reason: Some("timed out or cancelled".to_string()) }, "expired", None)
                    }
                }
            }
        };
        // Always clean up the pending entry (idempotent; resolve() may also remove).
        self.pending.write().await.remove(&id);
        // Mark the durable row resolved/expired (best-effort).
        if let Err(e) = self
            .store
            .resolve_interaction(&id, db_status, db_response.as_deref())
            .await
        {
            tracing::warn!(task_id = %task_id, error = %e, "failed to update interaction status");
        }
        resp
    }

    /// REST endpoint backing: interactions pending for a specific task.
    pub async fn pending_for_task(&self, task_id: &str) -> Vec<PendingInteraction> {
        self.pending
            .read()
            .await
            .values()
            .filter(|p| p.info.task_id == task_id)
            .map(|p| p.info.clone())
            .collect()
    }

    /// REST endpoint backing: every pending interaction (used for a global
    /// "anything waiting?" indicator on the agents panel).
    pub async fn list_all(&self) -> Vec<PendingInteraction> {
        self.pending.read().await.values().map(|p| p.info.clone()).collect()
    }

    /// Resolve a pending interaction with a typed response. Returns `false` if
    /// no such interaction exists OR the response variant is incompatible with
    /// the interaction's kind (caller maps the latter to a 4xx). The kind check
    /// is the structural boundary that stops a free-text `Question` answer from
    /// silently approving a mutating tool.
    pub async fn resolve(&self, interaction_id: &str, response: HumanResponse) -> bool {
        // Peek the kind without removing, to validate compatibility first.
        let kind = {
            let guard = self.pending.read().await;
            match guard.get(interaction_id) {
                Some(state) => state.info.kind,
                None => return false,
            }
        };
        if !Self::response_matches_kind(kind, &response) {
            tracing::warn!(
                target: "audit",
                interaction_id = %interaction_id,
                kind = ?kind,
                "rejected interaction resolve: response variant incompatible with kind"
            );
            return false;
        }
        let removed = self.pending.write().await.remove(interaction_id);
        match removed {
            Some(state) => {
                let _ = state.sender.send(response);
                true
            }
            None => false, // raced with timeout/another resolve
        }
    }

    /// STRUCTURAL INVARIANT enforcement: which response variants may resolve
    /// which interaction kinds.
    fn response_matches_kind(kind: InteractionKind, resp: &HumanResponse) -> bool {
        use HumanResponse::*;
        use InteractionKind::*;
        match kind {
            // Approval = a gate: only approve/reject.
            Approval => matches!(resp, Approve | Reject { .. }),
            // Question = free-form: only text / structured / reject.
            Question => matches!(resp, Answer { .. } | AnswerStructured { .. } | Reject { .. }),
        }
    }
}
