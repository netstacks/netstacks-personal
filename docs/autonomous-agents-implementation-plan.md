# NetStacks Autonomous Agents — Implementation Plan (Features A & B)

> **Audience:** the LLM (or engineer) implementing this. Every file path, type, and anchor below was **verified by reading the actual codebase** — do not invent names or work from memory of similar projects. When a step cites a file:line, open it and confirm the anchor before editing.

## What you are building

Two features that evolve NetStacks' "agent definitions" from a black-box task runner into a **delegate-to-a-junior-engineer** experience:

- **Feature A — Glass Box:** a durable, live, per-step transcript (the agent's reasoning, the **exact command shown before it runs**, tool output) that replaces today's synthetic progress bar — plus three cheap, independent safety/correctness fixes.
- **Feature B — The Voice:** generalize the binary approve/reject gate into a **typed, persisted, two-way Interaction channel**, and add an `ask_user` tool so an agent can **pause, ask a free-form clarifying question, and resume the same task** with your typed answer. Replaces the approval modal with a queued, kind-switched panel.

A is the foundation; B's question cards render in A's transcript and reuse A's persistence pattern. **Build A first.**

## How to use this document

1. **Read the Project Primer in full first.** It tells you what NetStacks is, the three-codebase architecture, the dual Personal/Enterprise modes, and the hard constraints (warning-clean `cargo check`, strict `npx tsc -b`, no `#[allow(dead_code)]`, fail-closed safety, no git ops, edit only the main tree).
2. **Implement Feature A** in step order. The three safety fixes (A Steps 10–12) are independent bug fixes — you may land them first. Verify with `cargo check` (in `agent/`) and `npx tsc -b` (in `frontend/`) after each step.
3. **Implement Feature B** in the given order. **The ordering is not optional:** B Step 1 (permit-release-while-parked) and A Step 12 (cancel-aware park) **must** land before the durable `ask_user` work (B Steps 3–4), or a long-unanswered question deadlocks the 3-slot concurrency pool.
4. After each step, run the **Definition of done** / **How to test** for that step. Do not move on with a failing `cargo check` or `tsc -b`.
5. Where a step says "verify" or "the implementer MUST verify," **do that** — do not assume.

---

## Project Primer

This primer orients you (the implementer) before you touch any code. Read it once in full. Every file path here is **absolute and real** — verified against the codebase. Do not invent files, types, or line numbers beyond what is stated.

---

### 1. What NetStacks is

NetStacks Terminal is a **desktop application for network engineers** — think "terminal app + AI assistant for routers/switches/firewalls." It gives engineers SSH/Telnet/SFTP access to network devices, a credential vault, SNMP polling, topology visualization, config backup/diff, and a CCIE-level AI assistant.

The feature you are extending is **agent definitions**: prebuilt AI agents that a user runs on demand. When run, a server-side **ReAct loop** (reason → act → observe, repeating) drives Claude through a set of **tools** (run a read-only SSH command, query the device inventory, send an email, read/write files, run a MOP). Today the only human interaction during a run is a **binary approve/reject gate** on mutating tools. Your job (features A and B) is to turn this into a richer "delegate to a junior engineer" experience: a live per-step transcript (A) and a two-way question/answer interaction channel (B).

---

### 2. Architecture: three layers, three locations

The app is **Tauri v2**. There are three distinct codebases, and it is critical you edit the right one:

| Layer | Language | Location | Role |
|---|---|---|---|
| **Tauri shell** | Rust | `frontend/src-tauri/` | Thin native desktop host. Spawns the webview + the agent sidecar. **You will NOT edit this for A/B.** |
| **Frontend (webview)** | React + TypeScript | `frontend/src/` | The UI the user sees. Panels, modals, hooks, the Zustand store, WebSocket clients. **All of feature A/B's UI lives here.** |
| **Agent (sidecar)** | Rust | `agent/src/` | The real engine: an Axum HTTP/WebSocket server backed by SQLite. Runs the ReAct loop, tools, approvals, persistence. **All of feature A/B's backend lives here.** |

The frontend talks to the agent over HTTP (REST) and WebSocket. The agent is a separate spawned process — it is *not* part of the Tauri Rust shell.

**Working directory:** `/home/viper/scripts/netstacks-terminal/`. The agent crate root is `/home/viper/scripts/netstacks-terminal/agent/`; the frontend root is `/home/viper/scripts/netstacks-terminal/frontend/`.

> ⚠️ There is a parallel worktree at `/home/viper/scripts/netstacks-terminal/.worktrees/feature-netconf-gnmi/agent/src` containing divergent copies of some files (e.g. `approvals.rs`, `output_validator.rs`). **Edit only the main tree under `agent/src` and `frontend/src`.** Never edit the worktree.

---

### 3. Dual modes: Personal (standalone) vs Enterprise — and why it matters

The app runs in one of two modes:

- **Personal / standalone:** the local agent sidecar runs everything. The frontend connects to it directly (`wss://127.0.0.1:<port>/...`). This is the mode where your new backend features actually execute.
- **Enterprise:** when a `controllerUrl` is configured, the local agent **self-exits**, and the frontend retargets its AI/agent calls to an out-of-repo **Controller** service. There is **no local agent**, and critically **no `/ws/tasks` WebSocket** — enterprise instead **polls REST every 5 seconds** (`listAgentExecutions` → `/agents/executions`).

**What this means for A and B:**
- The backend work (Rust, `agent/src/`) only runs in **standalone**. The Controller is out of repo — you cannot and must not modify it.
- **Live streaming features (A's transcript, B's interaction events) are standalone-only by default**, because enterprise has no WebSocket. The enterprise REST poll path would need separate Controller-side endpoints that are out of scope.
- Every frontend data function branches on mode. The existing pattern is `const isEnterprise = checkIsEnterprise()` (runtime) or `useMode().isEnterprise`. **`TaskApprovalModal` short-circuits entirely in enterprise** (`if (isEnterprise) return;`). Any new polling/WS frontend code must respect the same enterprise gate — prefer the runtime `useMode()`/`checkIsEnterprise()` check, not the module-level `getCurrentMode()` constant which can be null before client init.

---

### 4. How the agent subsystems fit together (the request lifecycle)

A user runs an agent definition. Here is the chain, with the real modules:

1. **HTTP entry — `run_agent_definition`** (`agent/src/api.rs`). Fetches the `AgentDefinition`, creates a task row, and spawns background execution. *(This handler has the G13 bug feature A fixes: it never checks `enabled`.)*

2. **Task persistence — `TaskStore`** (`agent/src/tasks/store.rs`, model types in `agent/src/tasks/models.rs`). SQLite-backed CRUD over the `agent_tasks` table. There is **no transcript or interaction table today** — A and B add them. Schema lives in two synced places: `agent/src/db/schema.sql` (fresh-install DDL) and migration functions in `agent/src/db/mod.rs` (`migrate_*_table` fns registered in `init_schema`).

3. **Background execution — `AgentTaskExecutor`** (`agent/src/tasks/executor.rs`). `spawn_task` acquires a **semaphore permit** (concurrency cap, default 3) from `TaskRegistry` (`agent/src/tasks/registry.rs`), spawns a Tokio task, builds the `ToolRegistry`, and calls into the ReAct loop. **The permit is held for the entire task body** — including while parked waiting for a user decision. Feature B must release it while parked.

4. **The ReAct loop — `execute_react_loop_with_agent`** (`agent/src/tasks/react.rs`). The reason→act cycle: call Claude, read response blocks, for each `ToolUse` block run a validator + approval gate + dispatch the tool, append results, repeat. Single caller is `executor.rs`. Cancellation (`CancellationToken`) is checked **only at the top of the loop** — long awaits inside (tool exec, approval wait) do not observe it.

5. **Tools — the `Tool` trait + `ToolRegistry`** (`agent/src/tasks/tools/mod.rs`, `registry.rs`; concrete tools like `agent/src/tasks/tools/ssh_command.rs`, `device_query.rs`, `send_email.rs`, `write_file.rs`, `edit_file.rs`, `patch_file.rs`, `mop.rs`). Each tool implements `name()/description()/input_schema()/execute()`. The registry is a `HashMap` keyed by `tool.name()`. Registration happens in `executor.rs` (all `register()` calls must precede the `Arc::new(tool_registry)` freeze). To add B's `ask_user` tool, copy the `device_query.rs` template and register it.

6. **Safety classification — two name-match sites:** `validate_tool_use` (`agent/src/tasks/tools/output_validator.rs`) and `is_mutating_tool` (`agent/src/tasks/approvals.rs`). **These currently mis-classify by name** — e.g. the SSH tool registers as `"execute_ssh_command"` but the validator only matches `"run_command"|"ai_ssh_execute"|"ssh_command"|"execute_command"` (zero overlap → falls through the fail-open `_ => Allow` arm). A unifies these into one canonical catalog keyed off the *real* registered names (the 9 built-ins: `execute_ssh_command`, `query_devices`, `send_email`, `write_file`, `edit_file`, `patch_file`, `mop_plan`, `mop_execution`, `mop_analysis`, plus the `mcp_` prefix).

7. **Approvals — `TaskApprovalService`** (`agent/src/tasks/approvals.rs`). The human-in-the-loop primitive. Today: `request()` creates a `oneshot::Sender<bool>`, parks up to `APPROVAL_TIMEOUT` (600s), and **fails closed** (deny) on timeout OR dropped sender (the catch-all `_ => false` arm). REST handlers in `api.rs` (`approve_task_tool_use`/`reject_task_tool_use`) call `resolve(id, true/false)`. **Feature B generalizes this `bool` into a typed two-way `Interaction` channel** (Approve | Reject | Answer{text} | AnswerStructured | EditPlan) and persists it to a new `task_interactions` table. The fail-closed deny-on-timeout/drop behavior **must be preserved**.

8. **Progress transport — `ProgressBroadcaster` + `TaskProgressEvent`** (`agent/src/tasks/progress.rs`), streamed over `/ws/tasks` by `agent/src/ws.rs` (`handle_task_progress`). The broadcaster is a fire-and-forget `tokio::sync::broadcast` (capacity 100, constructed in `agent/src/main.rs`). The WS forward loop serializes the **whole** `TaskProgressEvent` struct via `serde_json::to_string`, so **adding a field to the struct automatically puts it on the wire** — but you must also initialize it in `TaskProgressEvent::new` (no `Default`). Feature A's per-step transcript rides here and/or in a new durable table.

**Frontend side of the same flow:** the Zustand store + singleton WebSocket live in `frontend/src/hooks/useAgentTasks.ts`. The `/ws/tasks` `onmessage` dispatch (init / task_progress) is where A/B ingest new event types. The task UI is `frontend/src/components/AgentsPanel.tsx` (which *contains* `TaskLogViewer` inline — there is **no separate `TaskLogViewer.tsx`**). The approval UI is `frontend/src/components/TaskApprovalModal.tsx` (inline-styled, polls every 750ms, mounted globally in `frontend/src/main.tsx`). TS types are in `frontend/src/types/tasks.ts`; the approval REST client is `frontend/src/api/taskApprovals.ts`.

---

### 5. Build, test, and run commands

**Backend (Rust agent):**
```
cd /home/viper/scripts/netstacks-terminal/agent
cargo check        # primary correctness gate — MUST be warning-clean
```

**Frontend (React/TS):**
```
cd /home/viper/scripts/netstacks-terminal/frontend
npx tsc -b         # strict typecheck — MUST pass clean (noUnusedLocals, noUnusedParameters, strict:true)
```

The canonical "test" for this task is: **`cargo check` passes warning-clean in `agent/`** and **`npx tsc -b` passes in `frontend/`**.

---

### 6. Hard constraints (non-negotiable)

1. **Backend must be warning-clean** under `cargo check`. A warning is a failure.
2. **NEVER use `#[allow(dead_code)]`.** This is forbidden by project rule. For genuinely-not-yet-used items, follow the existing conventions: underscore-prefix the name (e.g. `_count_by_status`, `_is_terminal`) or `#[cfg]`-gate platform-specific code. *(One pre-existing `#[allow(dead_code)]` exists on `CreateTaskRequest.failure_policy` — leave it; do not add new ones.)*
3. **Frontend must pass strict `npx tsc -b`** — `noUnusedLocals` and `noUnusedParameters` are on. Every new store field needs both the interface entry AND the initializer; every new WS message variant must be added to the `TaskWsMessage` union; no unused imports.
4. **AI model/provider always comes from settings.** No hardcoded model or provider defaults anywhere.
5. **Fail-closed on safety checks.** When B generalizes the approval channel, timeout and dropped-sender must still resolve to **deny**. When A unifies the tool catalog, the goal is to stop built-in tools from hitting the fail-open `_ => Allow` default.
6. **This Linux tree is working-tree-only — NO git operations.** Do not commit, branch, push, or create worktrees. Edits are saved to the working tree and the user handles git elsewhere.
7. **Edit only the main tree** (`agent/src`, `frontend/src`), never the `.worktrees/` copies.
8. **MOPs are alpha and NOT a dependency** for this work. Config changes use the existing config-mode lane.

---

### 7. Glossary of key types you will touch

**Backend (Rust, `agent/src/`):**

- **`AgentDefinition`** (`models.rs`) — a prebuilt agent: `id`, `name`, `system_prompt`, `model`, `max_iterations`, **`enabled: bool`** (the field `run_agent_definition` must check), etc.
- **`AgentTask`** (`tasks/models.rs`) — a task row: `id`, `prompt`, `status`, `progress_pct`, `result_json`, `error_message`, timestamps, `agent_definition_id`. **All timestamps are `String` (RFC3339), not chrono types.**
- **`TaskStatus`** (`tasks/models.rs`) — enum `Pending|Running|Completed|Failed|Cancelled`, lowercase-serialized, with a `can_transition_to` state machine.
- **`TaskStore`** (`tasks/store.rs`) — SQLite CRUD. Pattern: `SELECT_COLUMNS` const + positional tuple `TaskRow` + `row_to_task` mapper. New tables (A: `task_messages`; B: `task_interactions`) copy this pattern.
- **`TaskApprovalService`** + **`PendingTaskApproval`** + **`PendingState`** (`tasks/approvals.rs`) — the human-in-the-loop gate. `PendingState.sender: oneshot::Sender<bool>` is B's primary generalization site → typed response. `is_mutating_tool(name)` is the gate predicate.
- **`ProgressBroadcaster`** + **`TaskProgressEvent`** (`tasks/progress.rs`) — the live event channel. `TaskProgressEvent` is `#[serde(rename_all="camelCase")]` (so `task_id`→`taskId`, `progress_pct`→`progressPct`), `event_type` is always `"task_progress"`. A adds an optional field here.
- **`Tool` trait / `ToolOutput` / `ToolError` / `SharedTool` / `ToolRegistry` / `ToolDefinition`** (`tasks/tools/mod.rs`, `registry.rs`) — the tool plugin system. B's `ask_user` implements `Tool`. Registry key == `Tool::name()` exactly.
- **`ValidationOutcome`** (`tasks/tools/output_validator.rs`) — `Allow | Block(String)`. The output-side validator's result.
- **`AgentMessage` / `AgentContent` (Text|Blocks) / `AgentContentBlock` (Text|ToolUse|ToolResult) / `AgentResponse`** (`agent/src/ai/providers.rs`) — the Claude wire-format message shapes the ReAct loop builds. All derive `Serialize`, so they are JSON-persistable as-is for A's transcript. `AgentContent` is `#[serde(untagged)]`; `AgentContentBlock` is `#[serde(tag="type")]`.
- **`ReactError`** (`tasks/react.rs`) — `ApiError | MaxIterationsReached | Cancelled | ...`. Note `MaxIterationsReached` is an **error**, not graceful completion — don't accidentally exhaust iterations with extra round-trips.
- **`ProviderError`** (`agent/src/providers/mod.rs`) — already has `Conflict(String)` (→ HTTP 409) and `Validation(String)` (→ 400). Reuse `Conflict` for the UNIQUE-name-collision fix; do **not** add new variants.
- **`ApiError`** (`agent/src/api.rs`) — REST error type; `From<ProviderError>` auto-maps `Conflict`→`"CONFLICT"`→409.

**Frontend (TS, `frontend/src/`):**

- **`AgentTask` / `TaskStatus`** (`types/tasks.ts`) — snake_case mirrors of the backend task row.
- **`TaskProgressEvent` / `TaskInitEvent` / `TaskWsMessage`** (`types/tasks.ts`) — WS message types. **`task_progress` is camelCase** (`taskId`, `progressPct`); **`init`/list responses are snake_case** (`running_count`, `max_concurrent`, `result_json`). Match the actual wire casing per event — do not assume one.
- **`AgentTasksState`** (Zustand store, `hooks/useAgentTasks.ts`) — `tasks`, `runningCount`, `maxConcurrent`, `isConnected`, plus `savedTaskIds`/`deletedTaskIds` Sets and their setters. New A/B store fields go in the interface **and** the `create()` initializer.
- **`PendingTaskApproval`** (`api/taskApprovals.ts`) — `{ id, task_id, tool_name, tool_input, created_at }`. B extends this (or adds a parallel type) with a `kind` discriminator for the kind-switched InteractionPanel (text / choice / credential / diff).

---

### 8. Mental model for where A and B land

- **Feature A (glass box):** new durable transcript persistence (`task_messages` table via `store.rs` + `db/mod.rs` + `schema.sql`), per-step emission from `react.rs`, an optional field on `TaskProgressEvent` in `progress.rs`, a new ingest branch + store field in `useAgentTasks.ts`, and a transcript pane inside the inline `TaskLogViewer` in `AgentsPanel.tsx`. Plus the cheap safety/correctness fixes: the canonical tool-name catalog, the `enabled` check in `run_agent_definition`, and making the approval park point cancel-aware.
- **Feature B (the voice):** generalize `oneshot::Sender<bool>` → typed `Interaction` in `approvals.rs`; persist to a new `task_interactions` table; add a non-mutating `ask_user` tool (`tasks/tools/ask_user.rs`); **release the semaphore permit while parked** (executor/react surgery); update the REST resolve handlers in `api.rs` to carry a typed body; and replace/extend `TaskApprovalModal` with a queued, kind-switched `InteractionPanel` in the frontend.

Everything above is grounded in the verified implementation facts. When in doubt, open the cited file and read the anchor before editing — do not work from memory of similar codebases.

---

# Build Order & Sequencing (read before starting)

**Recommended overall order: A, then B.** A touches no autonomy semantics, is independently shippable, and produces the transcript surface that B's interaction cards render into.

### Within Feature A
- **Steps 10–12 (safety fixes) are independent** and can ship immediately — they're verified bug fixes (the `execute_ssh_command` mis-classification that makes the output-validator fail *open*; `run_agent_definition` ignoring `enabled`; the approval park ignoring cancellation). Land these first if you want quick, low-risk wins.
- **Steps 1–9 (the transcript)** are the bulk: table + models + store methods → `react.rs` emission → `TaskProgressEvent` field → catch-up endpoint → frontend types/store/UI.
- **A Step 12 (cancel-aware park) is also a hard prerequisite for B** — do not extend the park timeout in B without it.

### Within Feature B (hard dependency chain)
1. **Step 1 — permit-release-while-parked** (executor/react surgery). MUST be first. Without it, a parked question holds 1 of 3 concurrency slots; three parked questions freeze all agent work.
2. **Step 2 — type the channel** (`oneshot::Sender<bool>` → `HumanResponse`; `PendingTaskApproval` → `PendingInteraction{kind}`). Preserve the **fail-closed** deny-on-timeout/drop behavior.
3. **Step 3 — `task_interactions` table** (persist-before-park) + startup recovery. Reuses A's migration pattern.
4. **Step 4 — the `ask_user` tool** (non-mutating; returns the typed answer as a `tool_result` so the same Tokio task resumes). Depends on 1–3.
5. **Step 5 — REST** `/pending-approvals` → `/pending-interactions` (typed body).
6. **Step 6 — frontend `InteractionPanel`** replacing `TaskApprovalModal` (queued; kind-switched: text box / choice chips / masked credential / inline diff).

### Cross-feature
- B's `task_interactions` migration copies the exact pattern A establishes for `task_messages` (`schema.sql` + `migrate_*` fn in `db/mod.rs` + `store.rs` methods).
- B's interaction events render as cards **in A's transcript** — so A's frontend transcript pane should exist first.

---

# Feature A — Glass Box (durable live transcript) + cheap safety fixes

**Scope / independence:** Feature A touches **no autonomy semantics**. It does not change what the agent is allowed to do, when it pauses, or the approval decision model. It (1) records and streams a per-step transcript, (2) adds a catch-up REST endpoint, (3) turns the task detail view into a live transcript that shows the **exact command before execution**, and (4) lands three cheap correctness/safety fixes (canonical tool-name catalog, `run_agent_definition` enabled check + typed name-collision error, cancel-aware approval park). Ship A on its own; do **not** add the typed `Interaction` channel, `ask_user`, `task_interactions`, or permit-release-while-parked here — those are Feature B.

**Verified environment facts the implementer must keep true:**
- Backend must be warning-clean (`cargo check` in `agent/`) and **never** use `#[allow(dead_code)]` (use `#[cfg]` for platform code). Underscore-prefix genuinely-unused items, matching existing convention (`_count_by_status`, `_is_terminal`).
- Frontend must pass strict `npx tsc -b` in `frontend/` (`noUnusedLocals`, `noUnusedParameters`).
- This Linux tree is **working-tree-only** — no git ops.
- Edit only `agent/src/...` (NOT the `.worktrees/feature-netconf-gnmi/` copy).
- `react.rs` serde: `task_progress` events are camelCase on the wire (`taskId`, `progressPct`); `init`/list payloads are snake_case (`running_count`, `result_json`). Match per-event.

---

## STEP 1 — Add the `task_messages` table (schema.sql + migration)

**Goal:** Create a durable per-step transcript table, child of `agent_tasks`, with a monotonic `seq` per task so the frontend can catch up after WS lag via `since_seq`.

**Files & anchors:**
- `/home/viper/scripts/netstacks-terminal/agent/src/db/schema.sql` — insert after the `agent_tasks` block (ends at the `idx_agent_tasks_created_at` index, ~line 614), before the `-- AI Agent Definitions` block (~line 616).
- `/home/viper/scripts/netstacks-terminal/agent/src/db/mod.rs` — add `migrate_task_messages_table` fn just above the `#[cfg(test)] mod tests` block (after `migrate_device_memory_tables` ends, ~line 2900), and register its call in `init_schema` **after** `migrate_agent_tasks_table(pool).await?;` (line 97) and **before** `seed_default_settings(pool).await?;` (line 131). Inserting at the device-memory cluster (~line 127) is safe.

**1a. `schema.sql`** — insert this block after line 614:

```sql
-- AI Agent Task Messages (Feature A - glass-box transcript)
-- One row per ReAct step event: thought / command-before-exec / tool_result / error.
-- seq is a per-task monotonic counter used by the /messages?since_seq=N catch-up endpoint.
CREATE TABLE IF NOT EXISTS task_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL CHECK (kind IN ('thought', 'command', 'tool_result', 'error', 'status')),
    tool_name TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_messages_task_seq ON task_messages(task_id, seq);
```

**1b. `db/mod.rs`** — add the migrate fn above `#[cfg(test)]` (mirror `migrate_agent_tasks_table` exactly; note bare `CREATE TABLE` inside the `table_exists` guard, `CREATE INDEX IF NOT EXISTS`, `.map_err(|e| DbError::Migration(format!(...)))?`):

```rust
/// Migrate task_messages table - create if it doesn't exist (Feature A transcript).
async fn migrate_task_messages_table(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "task_messages").await? {
        sqlx::query(
            r#"CREATE TABLE task_messages (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                iteration INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL CHECK (kind IN ('thought', 'command', 'tool_result', 'error', 'status')),
                tool_name TEXT,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#,
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create task_messages table: {}", e)))?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_task_messages_task_seq ON task_messages(task_id, seq)")
            .execute(pool)
            .await
            .map_err(|e| DbError::Migration(format!("Failed to create task_messages index: {}", e)))?;

        tracing::info!("Created task_messages table");
    }
    Ok(())
}
```

**1c. `db/mod.rs` init_schema** — register the call (place it after line 127 `migrate_device_memory_tables(pool).await?;`, anywhere after line 97 and before line 131):

```rust
    migrate_task_messages_table(pool).await?;
```

**Why:** Both schema.sql (fresh installs) and the guarded migrate fn (existing DBs) must stay in sync — that is the established two-source pattern. `seq` (per-task counter) drives catch-up; FK `ON DELETE CASCADE` ties cleanup to `agent_tasks` (FKs are enforced — `init_db` sets `.foreign_keys(true)`).

**Definition of done:** `task_messages` table + index exist on both fresh and migrated DBs; `cargo check` clean.

**How to test:** `cd /home/viper/scripts/netstacks-terminal/agent && cargo check`. Delete the dev SQLite DB (or use a scratch copy), run the agent once, then `sqlite3 <db> ".schema task_messages"` shows the table. Confirm `migrate_task_messages_table` is reachable (called from `init_schema`) so no dead-code warning.

> **VERIFY:** confirm the `agent_tasks` block in schema.sql actually ends near line 614 and that the migration call list in `db/mod.rs` is around lines 83–131 with `migrate_agent_tasks_table` at line 97 before you insert — line numbers may have drifted.

---

## STEP 2 — Models for transcript messages

**Goal:** Add the `TaskMessage` row struct + a `CreateTaskMessageRequest` and re-export them.

**Files & anchors:**
- `/home/viper/scripts/netstacks-terminal/agent/src/tasks/models.rs` — after `UpdateTaskRequest` (line 109), before `#[cfg(test)] mod tests` (line 111).
- `/home/viper/scripts/netstacks-terminal/agent/src/tasks/mod.rs` — extend the `pub use models::{...}` line (line 16).

**2a. `models.rs`** — append after line 109 (timestamps are `String` RFC3339 like `AgentTask`; row struct derives Serialize for the WS payload + REST; request struct derives Deserialize only — matching `CreateTaskRequest`):

```rust
/// One durable transcript step for the glass-box view (Feature A).
/// kind ∈ "thought" | "command" | "tool_result" | "error" | "status".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskMessage {
    pub id: String,
    pub task_id: String,
    pub seq: i64,
    pub iteration: i32,
    pub kind: String,
    pub tool_name: Option<String>,
    pub content: String,
    pub created_at: String,
}

/// Insert request for a transcript step. seq/id/created_at are assigned by the store.
#[derive(Debug, Clone)]
pub struct CreateTaskMessageRequest {
    pub iteration: i32,
    pub kind: String,
    pub tool_name: Option<String>,
    pub content: String,
}
```

**2b. `mod.rs`** — change line 16:

```rust
pub use models::{AgentTask, CreateTaskRequest, TaskMessage, TaskStatus};
```

(`CreateTaskMessageRequest` is only used internally by the store + react.rs within `tasks::`, so it does **not** need re-export. `TaskMessage` is serialized out via REST/WS, so it does.)

**Why:** `models` is a private module; public types are invisible outside `tasks::` unless re-exported. `TaskMessage` is the serialized view consumed by the REST catch-up handler.

**Definition of done:** `cargo check` clean; `crate::tasks::TaskMessage` resolves.

**How to test:** `cargo check`.

---

## STEP 3 — Store methods: insert step (assign seq) + list since seq

**Goal:** `create_message` (computes the next per-task `seq` atomically-enough and inserts) and `list_messages` (catch-up by `since_seq`).

**File & anchor:** `/home/viper/scripts/netstacks-terminal/agent/src/tasks/store.rs` — inside `impl TaskStore`, after the last method (`_count_by_status` ends ~line 217), before the closing `}`. Reuse the existing imports (`Uuid`, `Utc`) and the `TaskStoreError` enum.

**3a.** Add a per-table SELECT constant + tuple type + mapper near the top of `store.rs` (after the existing `row_to_task`, ~line 58):

```rust
const MSG_SELECT_COLUMNS: &str =
    "id, task_id, seq, iteration, kind, tool_name, content, created_at";

type TaskMessageRow = (
    String,         // id
    String,         // task_id
    i64,            // seq
    i32,            // iteration
    String,         // kind
    Option<String>, // tool_name
    String,         // content
    String,         // created_at
);

fn row_to_message(row: TaskMessageRow) -> super::models::TaskMessage {
    super::models::TaskMessage {
        id: row.0,
        task_id: row.1,
        seq: row.2,
        iteration: row.3,
        kind: row.4,
        tool_name: row.5,
        content: row.6,
        created_at: row.7,
    }
}
```

**3b.** Add the methods inside `impl TaskStore` (after `_count_by_status`):

```rust
    /// Append a transcript step for a task. Assigns the next per-task `seq`
    /// (max(seq)+1) and returns the persisted message. Feature A.
    pub async fn create_message(
        &self,
        task_id: &str,
        req: super::models::CreateTaskMessageRequest,
    ) -> Result<super::models::TaskMessage, TaskStoreError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        // Next seq for this task. COALESCE handles the first row (NULL -> 0).
        let next_seq: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM task_messages WHERE task_id = ?",
        )
        .bind(task_id)
        .fetch_one(&self.pool)
        .await?;

        sqlx::query(
            r#"INSERT INTO task_messages
               (id, task_id, seq, iteration, kind, tool_name, content, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&id)
        .bind(task_id)
        .bind(next_seq)
        .bind(req.iteration)
        .bind(&req.kind)
        .bind(&req.tool_name)
        .bind(&req.content)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        Ok(super::models::TaskMessage {
            id,
            task_id: task_id.to_string(),
            seq: next_seq,
            iteration: req.iteration,
            kind: req.kind,
            tool_name: req.tool_name,
            content: req.content,
            created_at: now,
        })
    }

    /// List transcript steps for a task with seq strictly greater than
    /// `since_seq` (pass -1 to get all), ordered ascending. Feature A.
    pub async fn list_messages(
        &self,
        task_id: &str,
        since_seq: i64,
    ) -> Result<Vec<super::models::TaskMessage>, TaskStoreError> {
        let query = format!(
            "SELECT {} FROM task_messages WHERE task_id = ? AND seq > ? ORDER BY seq ASC",
            MSG_SELECT_COLUMNS
        );
        let rows: Vec<TaskMessageRow> = sqlx::query_as(&query)
            .bind(task_id)
            .bind(since_seq)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(row_to_message).collect())
    }
```

**Why:** Mirrors the existing positional-tuple/`query_as` pattern (tuple order must match `MSG_SELECT_COLUMNS`). `seq` computed via `MAX(seq)+1` per task. The ReAct loop is sequential per task, so the read-then-insert race on `seq` is acceptable (single writer per task), matching the codebase's tolerance of the analogous `create_session` TOCTOU.

**Definition of done:** `cargo check` clean; both methods compile.

**How to test:** `cargo check`. (Functional test happens end-to-end in STEP 9.)

> **VERIFY:** `query_scalar`/`query_as` are already used elsewhere in `store.rs`; confirm `sqlx::query_scalar` is in scope (it is part of the `sqlx` prelude used via `sqlx::query_scalar(...)` fully-qualified above, so no new `use` needed).

---

## STEP 4 — Extend `TaskProgressEvent` with an optional transcript `step` payload

**Goal:** Let a single `task_progress` WS event optionally carry one persisted `TaskMessage` so the frontend renders steps live.

**File & anchor:** `/home/viper/scripts/netstacks-terminal/agent/src/tasks/progress.rs` — add a field to `TaskProgressEvent` after `pub error: Option<String>,` (line 29); initialize it to `None` in `new()` (after line 47); add a `with_step` builder mirroring `with_result`.

**4a.** Add the field (struct has `#[serde(rename_all = "camelCase")]`, so `step` stays `step` on the wire). Use `serde_json::Value` to avoid a hard dependency cycle and to keep the existing struct's serde shape simple:

```rust
    /// Optional persisted transcript step (Feature A glass-box). When present,
    /// this event carries one task_messages row so the UI can append it live.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<serde_json::Value>,
```

**4b.** In `new()` initialize it (the struct has no `Default`; every field is set literally):

```rust
        Self {
            event_type: "task_progress".to_string(),
            task_id,
            status: status.as_str().to_string(),
            progress_pct,
            message,
            result: None,
            error: None,
            step: None,
        }
```

**4c.** Add the builder after `with_error`:

```rust
    /// Attach a persisted transcript step to this event (Feature A).
    pub fn with_step(mut self, step: serde_json::Value) -> Self {
        self.step = Some(step);
        self
    }
```

**Why:** The WS forward loop in `ws.rs` serializes the whole `TaskProgressEvent` via `serde_json::to_string(&event)` — adding a field automatically streams it; **no ws.rs edit needed**. `skip_serializing_if` keeps existing lifecycle events unchanged on the wire. Adding a struct field without initializing in `new()` is a hard compile error, so 4b is mandatory.

**Definition of done:** `cargo check` clean; existing callers of `TaskProgressEvent::new(...)` still compile (they don't reference `step`).

**How to test:** `cargo check`.

---

## STEP 5 — Thread `TaskStore` into the ReAct loop and persist + stream each step

**Goal:** Persist (and stream) a transcript step at the verified anchors: the **thought** (assistant text), the **exact command before execution**, the **tool_result/error after execution**. The command step is emitted **before** `tool.execute(...)` so the UI shows what will run before it runs.

**Files & anchors:**
- `/home/viper/scripts/netstacks-terminal/agent/src/tasks/react.rs` — signature at line 166 (`execute_react_loop_with_agent`, already `#[allow(clippy::too_many_arguments)]`); imports at lines 16–25; Text arm line 296–304; ToolUse pre-dispatch ~line 375–383; tool_result completion ~line 383–422.
- `/home/viper/scripts/netstacks-terminal/agent/src/tasks/executor.rs` — `execute_task_with_react` already holds `store: &TaskStore` (line 237) and is the sole caller (line 274); add `store` to the call args.

**5a. `react.rs` imports** — add `TaskStore` to the `use super::...` block (after line 24):

```rust
use super::store::TaskStore;
use super::models::CreateTaskMessageRequest;
```

(`store` is a private module; these are `super::` paths within `tasks::` so they resolve. `CreateTaskMessageRequest` was added in STEP 2.)

**5b. `react.rs` signature** — add a `store: &TaskStore` param at line 166 (after `task_id`/`prompt`, before `registry` is fine; pick a stable position and update the one caller). Suggested:

```rust
#[allow(clippy::too_many_arguments)]
pub async fn execute_react_loop_with_agent(
    task_id: &str,
    prompt: &str,
    store: &TaskStore,
    registry: Arc<ToolRegistry>,
    broadcaster: &ProgressBroadcaster,
    cancel_token: CancellationToken,
    data_provider: Arc<dyn DataProvider>,
    agent_definition: Option<AgentDefinition>,
    sanitizer_cache: Arc<RwLock<Option<Sanitizer>>>,
    approval_service: Arc<super::approvals::TaskApprovalService>,
) -> Result<Value, ReactError> {
```

**5c. `react.rs`** — add a small local helper closure near the top of `execute_react_loop_with_agent` (after `messages` is initialized, ~line 247) so each emit both persists and broadcasts. Persistence failures must **not** abort the task (best-effort transcript), so log-and-continue:

```rust
    // Feature A: persist one transcript step then stream it live. Best-effort:
    // a transcript write must never fail the task (the run is the source of truth).
    let record_step = |iteration: i32,
                       kind: &'static str,
                       tool_name: Option<String>,
                       content: String,
                       progress: i32| async move {
        match store
            .create_message(
                task_id,
                CreateTaskMessageRequest {
                    iteration,
                    kind: kind.to_string(),
                    tool_name: tool_name.clone(),
                    content,
                },
            )
            .await
        {
            Ok(msg) => {
                let step = serde_json::to_value(&msg).unwrap_or(serde_json::Value::Null);
                broadcaster.send(
                    TaskProgressEvent::new(
                        task_id.to_string(),
                        TaskStatus::Running,
                        progress,
                        Some(format!("step:{}", kind)),
                    )
                    .with_step(step),
                );
            }
            Err(e) => {
                warn!(task_id = %task_id, error = %e, "failed to persist transcript step");
            }
        }
    };
```

> **VERIFY (borrow/closure):** A reused `async` closure that borrows `store`/`broadcaster`/`task_id` across multiple `.await` calls can hit Rust borrow/lifetime friction. If the closure form does not compile cleanly, **inline** the three `store.create_message(...).await` + `broadcaster.send(...with_step...)` blocks directly at each anchor below instead of using a closure. The inline form is the safe fallback and is what the anchors are written against. Do **not** reach for `#[allow]` to silence anything here.

**5d. Persist the THOUGHT** — in the Text arm (react.rs:296–304), after `final_result = Some(text.clone());` add:

```rust
                AgentContentBlock::Text { ref text } => {
                    info!(
                        task_id = %task_id,
                        text_len = text.len(),
                        "AI responded with text"
                    );
                    final_result = Some(text.clone());
                    // Feature A: record the model's reasoning text as a step.
                    record_step(iteration as i32, "thought", None, text.clone(), progress).await;
                    assistant_blocks.push(block);
                }
```

**5e. Persist the EXACT COMMAND BEFORE EXECUTION** — in the `else if let Some(tool) = registry.get(&tool_name)` branch (react.rs:375), immediately **after** the existing `broadcaster.send(... "Executing tool: ...")` and **before** `match tool.execute(tool_input, task_id).await {` (line 383). Serialize the exact `tool_input` so the UI sees the precise arguments that will run:

```rust
                    } else if let Some(tool) = registry.get(&tool_name) {
                        broadcaster.send(TaskProgressEvent::new(
                            task_id.to_string(),
                            TaskStatus::Running,
                            progress,
                            Some(format!("Executing tool: {}", tool_name)),
                        ));

                        // Feature A: record the EXACT command/arguments BEFORE
                        // running, so the glass-box shows what will execute.
                        let command_repr = serde_json::to_string_pretty(&tool_input)
                            .unwrap_or_else(|_| tool_input.to_string());
                        record_step(
                            iteration as i32,
                            "command",
                            Some(tool_name.clone()),
                            command_repr,
                            progress,
                        )
                        .await;

                        match tool.execute(tool_input, task_id).await {
```

> **NOTE:** `tool_input` is **moved** into `tool.execute(tool_input, task_id)`. Build `command_repr` from `&tool_input` (borrow) **before** that move, as shown — do not reference `tool_input` after the `match` head.

**5f. Persist the TOOL_RESULT / ERROR after execution** — inside the `match tool.execute(...)` arms (react.rs:384–414). In the `Ok(output) =>` arm, after `result_str` is built (line 403) record a `tool_result` step; in the `Err(e) =>` arm record an `error` step:

```rust
                        match tool.execute(tool_input, task_id).await {
                            Ok(output) => {
                                let result_str = serde_json::to_string_pretty(&output.output)
                                    .unwrap_or_else(|_| output.output.to_string());

                                if output.success {
                                    info!(/* unchanged */);
                                } else {
                                    warn!(/* unchanged */);
                                }
                                // Feature A: record the tool result.
                                record_step(
                                    iteration as i32,
                                    "tool_result",
                                    Some(tool_name.clone()),
                                    result_str.clone(),
                                    progress,
                                )
                                .await;
                                result_str
                            }
                            Err(e) => {
                                warn!(/* unchanged */);
                                let err_str = format!("Tool execution error: {}", e);
                                // Feature A: record the tool error.
                                record_step(
                                    iteration as i32,
                                    "error",
                                    Some(tool_name.clone()),
                                    err_str.clone(),
                                    progress,
                                )
                                .await;
                                err_str
                            }
                        }
```

(Keep the existing `info!`/`warn!` calls as-is; only the `record_step` lines and the `let err_str` binding are new. The branch must still **yield a `String`** — `result_str` / `err_str` are returned at the tail.)

**5g. `executor.rs`** — pass `store` into the call (line 274). `execute_task_with_react` already has `store: &TaskStore`:

```rust
    let result = execute_react_loop_with_agent(
        task_id,
        prompt,
        store,
        tool_registry,
        &broadcaster,
        cancel_token,
        provider,
        agent_definition,
        sanitizer,
        approval_service,
    )
    .await;
```

**Why:** `react.rs` previously had no persistence handle; threading `store` (already owned one level up) is the minimal change. Steps are persisted (durable, survives restart, catch-up source) **and** streamed (live) at the same call site. The command step is emitted strictly before `tool.execute`, satisfying "exact command before execution." `iteration` is already in scope at all three anchors (it's the loop counter). `progress` is the existing i32 (10–90%) computed per iteration.

**Definition of done:** `cargo check` clean; the loop still returns `Ok(json!({iterations, result}))`; existing approval/validator/rejection branches untouched.

**How to test:** `cargo check`. Then run a task that uses a read-only tool (e.g. `query_devices` / `execute_ssh_command`) and confirm rows appear: `sqlite3 <db> "SELECT seq, iteration, kind, tool_name FROM task_messages WHERE task_id='<id>' ORDER BY seq"`. You should see `thought`, then `command` (before output), then `tool_result`.

> **VERIFY:** `iteration` is `usize`; the DB/model uses `i32` — the `iteration as i32` casts above are required. Confirm `iteration` is in scope at line 296 and the dispatch branch (it is the outer-loop variable, incremented near line 262).

---

## STEP 6 — `GET /tasks/:id/messages?since_seq=N` catch-up endpoint

**Goal:** REST endpoint to backfill transcript steps the WS missed (e.g. after `RecvError::Lagged` drops or a late-joining client). Returns all steps with `seq > since_seq`.

**Files & anchors:**
- `/home/viper/scripts/netstacks-terminal/agent/src/api.rs` — add handler near `get_task` (line 9179) / the pending-approvals handlers (line 10598). Uses `state.task_store` (an `AppState` field).
- `/home/viper/scripts/netstacks-terminal/agent/src/main.rs` — register route near the existing `/tasks/:id` route (line 1305) and the pending-approvals routes (line 1336).

**6a. `api.rs`** — add the handler (mirror `get_task`'s `(StatusCode, String)` error style):

```rust
/// Query for the transcript catch-up endpoint.
#[derive(Debug, serde::Deserialize)]
pub struct TaskMessagesQuery {
    /// Return steps with seq strictly greater than this. Default -1 (all).
    #[serde(default = "default_since_seq")]
    pub since_seq: i64,
}

fn default_since_seq() -> i64 {
    -1
}

/// GET /api/tasks/:id/messages?since_seq=N — transcript steps after seq N.
/// Used by the live glass-box view to backfill after WebSocket lag.
pub async fn list_task_messages(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<TaskMessagesQuery>,
) -> Result<Json<Vec<crate::tasks::TaskMessage>>, (StatusCode, String)> {
    let messages = state
        .task_store
        .list_messages(&id, q.since_seq)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(messages))
}
```

> **VERIFY:** `Query`, `Path`, `State`, `Json`, `StatusCode` are already imported in `api.rs` (the file has thousands of handlers using all of them). If `Query` is not imported, add `use axum::extract::Query;`.

**6b. `main.rs`** — register after the `/tasks/:id` route (line 1305–1306). Because `/tasks/:id` already uses `.route("/tasks/:id", get(...).delete(...))`, add a sibling route:

```rust
        .route("/tasks/:id/messages", get(api::list_task_messages))
```

**Why:** WS is best-effort with a capacity-100 broadcast channel; a slow/late client misses steps (Lagged → dropped, never retried). The catch-up endpoint makes the transcript reliable: the frontend fetches `?since_seq=<lastSeq>` on connect and after any detected gap. `since_seq=-1` returns everything.

**Definition of done:** `cargo check` clean; `GET /api/tasks/<id>/messages` returns a JSON array (newest-after-since, ascending). `:id_param` name must match the path segment used by the handler's `Path(id)`.

**How to test:** `cargo check`, then `curl -k "https://127.0.0.1:<port>/api/tasks/<id>/messages?since_seq=-1" -H "Authorization: ..."` returns the step array. Confirm `?since_seq=2` returns only `seq>2`.

> **VERIFY:** route prefix — confirm whether routes in `main.rs` are mounted under `/api` (the comments reference `/api/tasks/...`). Match the existing `/tasks/:id` registration exactly; do not invent a new prefix.

---

## STEP 7 — Frontend types: transcript step + WS variant

**Goal:** Add `TaskMessage` and extend `TaskProgressEvent` with the optional `step`, keeping the `TaskWsMessage` union and strict TS happy.

**File & anchor:** `/home/viper/scripts/netstacks-terminal/frontend/src/types/tasks.ts` — `TaskProgressEvent` (line 50–58), `TaskWsMessage` union (line 69).

**7a.** Add the `TaskMessage` interface (snake_case — matches REST `/messages` and the serialized Rust `TaskMessage` which has **no** camelCase rename, so it stays snake_case on the wire):

```ts
export interface TaskMessage {
  id: string;
  task_id: string;
  seq: number;
  iteration: number;
  kind: 'thought' | 'command' | 'tool_result' | 'error' | 'status';
  tool_name: string | null;
  content: string;
  created_at: string;
}
```

**7b.** Extend `TaskProgressEvent` (the WS event is **camelCase**, but the embedded `step` is a serialized `TaskMessage` which is snake_case — that asymmetry is real and intentional):

```ts
export interface TaskProgressEvent {
  type: 'task_progress';
  taskId: string;
  status: TaskStatus;
  progressPct: number;
  message?: string;
  result?: unknown;
  error?: string;
  /** Feature A: optional persisted transcript step (snake_case TaskMessage). */
  step?: TaskMessage;
}
```

(`TaskWsMessage = TaskProgressEvent | TaskInitEvent` at line 69 needs **no** change — `step` rides on the existing `task_progress` variant.)

**Why:** Single source of truth for WS shapes; the `JSON.parse` cast in `useAgentTasks.ts` stays type-safe. The Rust `TaskMessage` struct (STEP 2) has no `rename_all`, so its JSON keys are snake_case; the wrapping `task_progress` event keeps camelCase. Match each exactly or runtime reads silently miss fields.

**Definition of done:** `npx tsc -b` clean.

**How to test:** `cd /home/viper/scripts/netstacks-terminal/frontend && npx tsc -b`.

---

## STEP 8 — Frontend store: per-task transcript + ingest + catch-up

**Goal:** Store transcript steps per task, ingest the WS `step`, expose a REST catch-up call, and track `lastSeq` for gap detection.

**Files & anchors:**
- `/home/viper/scripts/netstacks-terminal/frontend/src/hooks/useAgentTasks.ts` — `AgentTasksState` interface (line 34) + `create<AgentTasksState>` initializer (line 60); `onmessage` dispatch chain (the `else if (msg.type === 'task_progress')` block, line 219). `useAgentTasksStore` is already exported (line 418).
- `/home/viper/scripts/netstacks-terminal/frontend/src/api/tasks.ts` — add a `getTaskMessages` REST helper (follow the standalone/enterprise branch pattern used by every function in that file).

**8a. Store fields** — extend the `AgentTasksState` interface (line 34) with a transcript map + setter. **Both the interface and the `create()` initializer must be updated** or strict-TS fails:

```ts
  // Feature A: per-task transcript steps, keyed by task id, seq-ordered.
  transcripts: Record<string, TaskMessage[]>;
  appendTranscriptStep: (taskId: string, step: TaskMessage) => void;
  setTranscript: (taskId: string, steps: TaskMessage[]) => void;
```

In the `create<AgentTasksState>((set) => ({ ... }))` initializer (line 60), add the initial field + setters. The setters must dedupe on `seq` (WS step + catch-up step can overlap) and keep ascending order:

```ts
  transcripts: {},
  appendTranscriptStep: (taskId, step) =>
    set((state) => {
      const existing = state.transcripts[taskId] ?? [];
      if (existing.some((s) => s.seq === step.seq)) return state; // dedupe
      const merged = [...existing, step].sort((a, b) => a.seq - b.seq);
      return { transcripts: { ...state.transcripts, [taskId]: merged } };
    }),
  setTranscript: (taskId, steps) =>
    set((state) => {
      const bySeq = new Map<number, TaskMessage>();
      for (const s of state.transcripts[taskId] ?? []) bySeq.set(s.seq, s);
      for (const s of steps) bySeq.set(s.seq, s); // catch-up wins on overlap
      const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
      return { transcripts: { ...state.transcripts, [taskId]: merged } };
    }),
```

Add the import at the top of `useAgentTasks.ts` (extend the existing `types/tasks` import):

```ts
import type { /* existing... */, TaskMessage } from '../types/tasks';
```

**8b. Ingest the WS step** — inside the `else if (msg.type === 'task_progress')` block (line 219), after the existing `store.updateTask(...)` call, append the step if present:

```ts
    // Feature A: live transcript step rides on task_progress events.
    if (msg.step) {
      store.appendTranscriptStep(msg.step.task_id, msg.step);
    }
```

(`store` here is the Zustand store instance already used in that block; reuse it.)

**8c. REST catch-up helper** — in `frontend/src/api/tasks.ts`, add (follow the file's standalone/enterprise branch convention; enterprise has no transcript table yet, so return `[]` there):

```ts
import type { TaskMessage } from '../types/tasks';

/** Feature A: backfill transcript steps with seq > sinceSeq. */
export async function getTaskMessages(
  taskId: string,
  sinceSeq = -1,
): Promise<TaskMessage[]> {
  const client = getClient();
  if (isEnterprise()) {
    // Controller does not expose a transcript catch-up endpoint yet.
    return [];
  }
  const res = await client.http.get<TaskMessage[]>(
    `/tasks/${taskId}/messages`,
    { params: { since_seq: sinceSeq } },
  );
  return res.data;
}
```

> **VERIFY:** match the exact import names/helpers used in `tasks.ts` — `getClient`, `isEnterprise`, and the axios `client.http` pattern are described in the verified facts; confirm `isEnterprise` is the helper name in that file (it uses an `isEnterprise()` branch in every function).

**Why:** WS is lossy (capacity 100, Lagged drops). The store dedupes by `seq` so a WS step and a catch-up fetch of the same `seq` collapse to one. Enterprise has no `/ws/tasks` and no transcript endpoint, so it degrades gracefully to empty (the panel just won't show a live transcript in enterprise — acceptable for A, callable out later).

**Definition of done:** `npx tsc -b` clean (interface + initializer both updated; no unused imports).

**How to test:** `npx tsc -b`.

---

## STEP 9 — Frontend: live transcript in the task detail view (command-before-exec + backfill)

**Goal:** Render the per-task transcript inside `TaskLogViewer` (the in-file detail component in `AgentsPanel.tsx`), showing each step (thought / **command before execution** / tool_result / error), and backfill via `since_seq` on open + after detected WS gaps.

**File & anchor:** `/home/viper/scripts/netstacks-terminal/frontend/src/components/AgentsPanel.tsx` — `TaskLogViewer` (lines 164–347; **NOT** a separate file). Insert a transcript section between the Status/progress section (ends ~line 233) and the timestamps section (~line 235). Read the transcript from `useAgentTasksStore` directly (it's exported) and the catch-up helper from `api/tasks.ts`.

**9a.** At the top of `TaskLogViewer`, subscribe to the store transcript and run a catch-up effect:

```tsx
  // Feature A: live transcript for this task.
  const transcript = useAgentTasksStore((s) => s.transcripts[task.id] ?? []);
  const setTranscript = useAgentTasksStore((s) => s.setTranscript);

  React.useEffect(() => {
    let cancelled = false;
    // Backfill everything we have on open; subsequent live steps arrive via WS.
    getTaskMessages(task.id, -1)
      .then((steps) => {
        if (!cancelled && steps.length > 0) setTranscript(task.id, steps);
      })
      .catch(() => {
        /* transcript is best-effort; ignore fetch errors */
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, setTranscript]);
```

Add imports at the top of `AgentsPanel.tsx`:

```tsx
import { useAgentTasksStore } from '../hooks/useAgentTasks';
import { getTaskMessages } from '../api/tasks';
```

(`React` is already imported in this file; if it's imported as named hooks only, use `useEffect`/`useState` directly instead of `React.useEffect`.)

**9b.** Render the transcript section (insert in JSX between Status and timestamps, ~line 233–235):

```tsx
        {transcript.length > 0 && (
          <div className="task-log-section">
            <div className="task-log-section-title">Transcript</div>
            <div className="task-transcript">
              {transcript.map((step) => (
                <div key={step.seq} className={`task-transcript-step step-${step.kind}`}>
                  <div className="step-meta">
                    <span className="step-kind">{step.kind}</span>
                    {step.tool_name && <span className="step-tool">{step.tool_name}</span>}
                    <span className="step-seq">#{step.seq}</span>
                  </div>
                  {step.kind === 'command' ? (
                    <pre className="step-command">{step.content}</pre>
                  ) : (
                    <pre className="step-content">{step.content}</pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
```

**9c.** Add styles in `/home/viper/scripts/netstacks-terminal/frontend/src/components/AgentsPanel.css` (near the existing `.task-log-*` rules, using the project `--color-*` design tokens like the rest of that file — do **not** copy `TaskApprovalModal`'s hardcoded hex). Make the `command` step visually distinct since it shows what *will* run:

```css
.task-transcript {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.task-transcript-step {
  border-left: 3px solid var(--color-border);
  padding: 4px 8px;
}
.task-transcript-step.step-command {
  border-left-color: var(--color-warning, #d97706);
}
.task-transcript-step.step-error {
  border-left-color: var(--color-danger, #dc2626);
}
.step-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--color-text-secondary);
  text-transform: uppercase;
}
.step-command,
.step-content {
  margin: 4px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
.step-command {
  background: var(--color-bg-tertiary, rgba(0, 0, 0, 0.2));
  padding: 6px;
  border-radius: 4px;
}
```

**Why:** `TaskLogViewer` is the existing detail view; the transcript belongs there. The catch-up fetch on open guarantees correctness even if the client connected after steps were emitted or dropped a Lagged batch. The `command` step renders the exact serialized `tool_input` that the backend recorded **before** `tool.execute` (STEP 5e), so the user sees what will run before it runs. Steps are keyed by `seq` (stable, monotonic). Enterprise users get an empty transcript (no endpoint) — acceptable for A.

**Definition of done:** `npx tsc -b` clean; opening a running/completed task shows the transcript with command steps preceding their tool_result steps; no unused imports/vars (strict).

**How to test:**
1. `npx tsc -b`.
2. Manual (standalone, the user tests GUI on Mac per dev workflow): run an agent task that calls a tool, open the task in the Agents panel, watch steps stream in live; the `command` step appears before its `tool_result`. Reload the panel mid-run and confirm the transcript backfills (catch-up).

---

## STEP 10 — Safety fix #1: canonical tool-name catalog (fixes the `execute_ssh_command` miss)

**Goal:** One source of truth mapping the **real** registered tool names to `{mutating, read_only/validated}`, consumed by both `output_validator::validate_tool_use` and `approvals::is_mutating_tool`. The verified bug: SSH tool registers as `"execute_ssh_command"` but the validator's SSH arm only matches `"run_command" | "ai_ssh_execute" | "ssh_command" | "execute_command"` (zero overlap → falls through to `_ => Allow`, output-side filter skipped). Also: `execute_ssh_command` accepts a `commands` **array** that the validator never checks.

**Files & anchors:**
- New file `/home/viper/scripts/netstacks-terminal/agent/src/tasks/tools/catalog.rs`.
- `/home/viper/scripts/netstacks-terminal/agent/src/tasks/tools/mod.rs` — add `pub mod catalog;` (alphabetical, after `bash_filter`) and optionally `pub use catalog::*;`.
- `/home/viper/scripts/netstacks-terminal/agent/src/tasks/approvals.rs` — `is_mutating_tool` (line 31) delegates to the catalog.
- `/home/viper/scripts/netstacks-terminal/agent/src/tasks/tools/output_validator.rs` — fix the SSH arm name (line 46), the file-write arm (line 68, drop dead `ai_*` aliases), patch arm (line 87), and validate the SSH `commands` array.

**10a. `catalog.rs`** — canonical names (verbatim from each `Tool::name()`):

```rust
//! Canonical tool-name catalog (Feature A safety unification).
//!
//! Two match sites previously hard-coded tool-name strings that did NOT
//! match the actual `Tool::name()` returns — most importantly the SSH tool
//! is registered as `execute_ssh_command` but the output validator only
//! matched `run_command`/`ssh_command`/etc., so every LLM-emitted SSH call
//! fell through the validator's `_ => Allow` arm. This module is the single
//! source of truth both sites consume.

/// Returns true when the named tool MUTATES state and therefore requires a
/// per-invocation user approval. Read-only / filtered tools return false.
/// Any `mcp_`-prefixed tool is treated as mutating (matches existing policy).
pub fn is_mutating(name: &str) -> bool {
    matches!(
        name,
        "write_file" | "edit_file" | "patch_file" | "send_email"
    ) || name.starts_with("mcp_")
}

/// True for the SSH/command execution surface (filtered, read-only-ish).
pub fn is_ssh_command(name: &str) -> bool {
    name == "execute_ssh_command"
}

/// True for file-write surfaces (write/edit).
pub fn is_file_write(name: &str) -> bool {
    matches!(name, "write_file" | "edit_file")
}

/// True for the sed-patch surface.
pub fn is_patch(name: &str) -> bool {
    name == "patch_file"
}
```

> **VERIFY (MOP tools):** `mop_plan` / `mop_execution` / `mop_analysis` are registered but appear in **neither** match site today, and `mop_execution` can run device changes. The prompt says MOPs are alpha and **not a dependency** for this work, so this catalog leaves their classification **unchanged** (non-mutating, validator-Allow) to avoid changing behavior. Flag to the MOP owner that `mop_execution` is currently fail-open; do **not** silently gate it as part of A.

**10b. `mod.rs`** — add the module (alphabetical position after `bash_filter`):

```rust
pub mod catalog;
```

**10c. `approvals.rs`** — replace the body of `is_mutating_tool` (lines 31–39) to delegate (keeps the public signature identical; sole caller react.rs:329 unchanged):

```rust
pub fn is_mutating_tool(name: &str) -> bool {
    super::tools::catalog::is_mutating(name)
}
```

> **VERIFY:** confirm `super::tools::catalog` resolves from `approvals.rs` (approvals is `tasks::approvals`, tools is `tasks::tools`, so `super::tools::catalog` is correct). If not, use `crate::tasks::tools::catalog`.

**10d. `output_validator.rs`** — fix the SSH arm (line 46) to use the **real** name and to validate the `commands` array too. Replace the arm pattern and body:

```rust
        // SSH / device command surface. Registered name is
        // `execute_ssh_command` (Feature A fix: the old arm matched names
        // that are NEVER registered, so SSH calls bypassed this validator).
        // Validate BOTH the single `command` and each element of `commands`.
        name if crate::tasks::tools::catalog::is_ssh_command(name) => {
            let filter = CommandFilter::new();

            // Collect every command string this call would run.
            let mut cmds: Vec<&str> = Vec::new();
            if let Some(c) = input.get("command").and_then(|v| v.as_str()) {
                cmds.push(c);
            }
            if let Some(arr) = input.get("commands").and_then(|v| v.as_array()) {
                for v in arr {
                    if let Some(c) = v.as_str() {
                        cmds.push(c);
                    }
                }
            }
            if cmds.iter().all(|c| c.is_empty()) {
                return ValidationOutcome::block("empty command rejected");
            }
            for cmd in cmds {
                if cmd.is_empty() {
                    continue;
                }
                if let Err(e) = filter.is_allowed(cmd) {
                    audit_blocked(tool_name, "command_filter", cmd, &e.to_string());
                    return ValidationOutcome::block(format!(
                        "Command rejected by output-side validator: {}", e
                    ));
                }
            }
            ValidationOutcome::Allow
        }
```

Fix the file-write arm (line 68) — drop the dead `ai_write_file`/`ai_edit_file` aliases, use the catalog:

```rust
        name if crate::tasks::tools::catalog::is_file_write(name) => {
            // ... unchanged body (filepath checks, validate_filepath) ...
        }
```

Fix the patch arm (line 87) — drop dead `ai_patch_file`:

```rust
        name if crate::tasks::tools::catalog::is_patch(name) => {
            // ... unchanged body (filepath + sed_expression checks) ...
        }
```

Leave the `send_email` arm (line 116) and `mcp_` arm (line 138) and the `_ => ValidationOutcome::Allow` default (line 152) as-is. The `mcp_` single-underscore prefix is **correct** (verified against `tool_wrapper.rs:54`) — do not change to `mcp__`.

> **NOTE on arm ordering:** `match tool_name` arms are now name-guards (`name if ...`) instead of literal `|` patterns. Guards are evaluated top-to-bottom; ensure the SSH/file-write/patch guards come **before** the `send_email` literal and the `mcp_` guard and the `_` default. Keep `send_email` as a literal arm (it's a single name) above the `_` default. Verify no two guards overlap (they don't: ssh/file/patch/email/mcp are disjoint).

**10e.** Update the `output_validator.rs` unit tests (verified at lines ~193, 205) that use `"ai_write_file"`/`"ai_patch_file"` — change them to the real names `"write_file"`/`"patch_file"`, and **add a test** that `"execute_ssh_command"` with a blocked command yields `Block` (this is the regression guard for the actual bug):

```rust
    #[test]
    fn execute_ssh_command_is_validated() {
        // The real registered name must hit the SSH arm, not fall through.
        let input = serde_json::json!({ "command": "rm -rf /" });
        // Use whatever the existing tests assert against CommandFilter; the
        // point is this must NOT be ValidationOutcome::Allow for a denied cmd.
        match validate_tool_use("execute_ssh_command", &input) {
            ValidationOutcome::Block(_) => {}
            ValidationOutcome::Allow => panic!("execute_ssh_command bypassed validator"),
        }
    }
```

> **VERIFY:** pick a command string the existing `CommandFilter` actually denies (read `filter.rs` deny rules) so the assertion is real. If `rm -rf /` is allowed by the filter, choose a denied one.

**Why:** Eliminates the silent fail-open on SSH (defence-in-depth restored) and the unvalidated `commands`-array path, removes dead aliases that masked the bug, and centralizes classification so a future rename can't re-open the hole. `is_mutating_tool`'s public signature is unchanged so react.rs needs no edit.

**Definition of done:** `cargo check` clean (no dead code, exhaustive match); `cargo test` for the validator module passes with the real-name tests; `is_mutating_tool` still returns the same set (write_file/edit_file/patch_file/send_email/mcp_*) — note the old arms also listed `ai_*` aliases which were never produced, so dropping them is behavior-preserving for real traffic.

**How to test:** `cargo check && cargo test --lib output_validator` (or the crate's test invocation). Manually confirm an agent SSH call with a filtered command now returns the "blocked by output validator" tool_result.

> **VERIFY:** the validator's match is `match tool_name { ... }`. Confirm converting some arms to `name if guard` guards compiles and that `tool_name` (the matched value) is still usable as `name` inside guarded arms (it is — `name if ...` binds `name` to `tool_name`).

---

## STEP 11 — Safety fix #2: `run_agent_definition` enabled check + typed name-collision

**Goal:** (a) `run_agent_definition` must reject disabled agent definitions (G13: it fetches `_definition` and never reads `.enabled`). (b) `create_agent_definition` must return a typed `Conflict` (HTTP 409) on duplicate name instead of an opaque 500.

**Files & anchors:**
- `/home/viper/scripts/netstacks-terminal/agent/src/api.rs` — `run_agent_definition` (lines 7261–7284); `_definition` bound at line 7267.
- `/home/viper/scripts/netstacks-terminal/agent/src/providers/local.rs` — `create_agent_definition` (line 6540, INSERT at ~6544); canonical Conflict pre-check pattern at `create_session` (lines 1864–1879).

**11a. `api.rs` enabled check** — rename `_definition` → `definition` and gate after the existence check (~line 7269). This handler returns `Result<_, (StatusCode, String)>` (NOT `ApiError`), so build the tuple by hand:

```rust
    // Verify agent definition exists and is enabled.
    let definition = state.provider.get_agent_definition(&id).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Agent definition not found: {}", id)))?;
    if !definition.enabled {
        return Err((
            StatusCode::CONFLICT,
            format!("Agent definition '{}' is disabled", id),
        ));
    }
```

(Everything below — `create_task_with_agent`, `spawn_task` — unchanged.)

> **VERIFY status code:** the prompt suggests `409 CONFLICT` for parity with the Conflict mapping, but a disabled (non-collision) state could arguably be `403 FORBIDDEN` or `400 BAD_REQUEST`. Confirm the intended code with the plan owner; `409` is the documented default here.

**11b. `local.rs` typed name-collision** — add a pre-check before the INSERT in `create_agent_definition` (mirror `create_session` lines 1864–1879). `ProviderError::Conflict` already exists and already maps to `ApiError` code `"CONFLICT"` → HTTP 409 (via `api.rs` From impl + into_response), and the `create_agent_definition` **handler** returns `ApiError`, so propagation is automatic:

```rust
    // Reject duplicate names with a typed Conflict (-> HTTP 409) instead of
    // surfacing the raw UNIQUE-constraint failure as an opaque 500.
    let existing: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM agent_definitions WHERE name = ?1",
    )
    .bind(&req.name)
    .fetch_optional(&self.pool)
    .await
    .map_err(|e| ProviderError::Database(e.to_string()))?;
    if existing.is_some() {
        return Err(ProviderError::Conflict(format!(
            "An agent definition named '{}' already exists",
            req.name
        )));
    }
```

Place this immediately before the `sqlx::query("INSERT INTO agent_definitions ...")` at line ~6544.

**Why:** G13 lets a disabled agent run; the fix is a two-line guard. The collision fix reuses the existing `ProviderError::Conflict` variant and its established 409 mapping — **do not add new enum variants or ApiError codes** (would risk non-exhaustive-match build breaks). The SELECT-then-INSERT race matches `create_session`'s accepted TOCTOU (UNIQUE constraint is the backstop).

**Definition of done:** `cargo check` clean; running a disabled agent returns 409 with "is disabled"; creating a second agent with an existing name returns 409 with "already exists" (not 500).

**How to test:** `cargo check`. Manual: `POST /api/agent-definitions` twice with the same name → second returns 409. Disable an agent (via update), `POST /api/agent-definitions/:id/run` → 409. Confirm `_definition` is no longer unused (renamed) so no warning.

> **VERIFY:** confirm `_definition` is still the binding name at api.rs:7267 and that `AgentDefinition.enabled` is a plain `bool`. Optionally mirror the pre-check in `update_agent_definition` (local.rs ~6567) for renames using `WHERE name = ? AND id != ?` — flagged as optional by the verified facts; include only if the plan wants rename protection.

---

## STEP 12 — Safety fix #3: cancel-aware approval park

**Goal:** Make `TaskApprovalService::request` (approvals.rs:69) observe the task's `CancellationToken` so a cancelled task unblocks immediately instead of waiting up to `APPROVAL_TIMEOUT` (600s). **Preserve fail-closed semantics** (timeout, dropped sender, and now cancellation all resolve to reject/`false`).

**Files & anchors:**
- `/home/viper/scripts/netstacks-terminal/agent/src/tasks/approvals.rs` — `request` (lines 69–116), specifically the `tokio::time::timeout(APPROVAL_TIMEOUT, rx).await` park (line 93) and the fail-closed `_ => false` arm (lines 106–114).
- `/home/viper/scripts/netstacks-terminal/agent/src/tasks/react.rs` — the sole caller (line 338) already has `cancel_token` in scope (it's a fn param).

> **SCOPE NOTE:** This is the **only** approvals change in Feature A. Do **not** generalize the `oneshot::Sender<bool>` to a typed `HumanResponse`, and do **not** release the semaphore permit while parked — those are Feature B. Here we only add cancellation-awareness, fail-closed.

**12a. `approvals.rs`** — add `tokio_util::sync::CancellationToken` to imports (top of file, near the other `use` lines):

```rust
use tokio_util::sync::CancellationToken;
```

Change `request`'s signature to accept the cancel token (one caller to update):

```rust
    pub async fn request(
        &self,
        task_id: String,
        tool_name: String,
        tool_input: serde_json::Value,
        cancel_token: &CancellationToken,
    ) -> bool {
```

Replace the park (line 93) and the match (95–115) with a `tokio::select!` over the oneshot, the timeout, and cancellation — **all non-resolve outcomes deny**:

```rust
        self.pending.write().await.insert(id.clone(), PendingState { info, sender: tx });

        // Park until the user decides, the timeout fires, OR the task is
        // cancelled. Fail-closed: every branch except an explicit Ok(decision)
        // resolves to `false` (reject).
        let approved = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                tracing::warn!(
                    target: "audit",
                    task_id = %task_id,
                    tool = %tool_name,
                    "ReAct task approval cancelled — treating as rejected"
                );
                false
            }
            outcome = tokio::time::timeout(APPROVAL_TIMEOUT, rx) => {
                match outcome {
                    Ok(Ok(decision)) => {
                        tracing::warn!(
                            target: "audit",
                            task_id = %task_id,
                            tool = %tool_name,
                            approved = decision,
                            "ReAct task approval resolved"
                        );
                        decision
                    }
                    // Timeout (Err(Elapsed)) OR dropped sender (Ok(Err(RecvError)))
                    // both deny — preserve the original fail-closed posture.
                    _ => {
                        tracing::warn!(
                            target: "audit",
                            task_id = %task_id,
                            tool = %tool_name,
                            "ReAct task approval timed out / dropped — treating as rejected"
                        );
                        false
                    }
                }
            }
        };
        // Always clean up the pending entry (idempotent; resolve() may also remove).
        self.pending.write().await.remove(&id);
        approved
```

> **NOTE:** The original code removed the pending entry **before** matching (line 94). With `select!`, remove **after** the select (as shown) so the entry stays visible to `resolve()` while parked. `resolve()` already double-removes safely. `biased;` makes cancellation checked first each poll.

**12b. `react.rs`** — update the sole caller (line 338) to pass the token. `cancel_token` is a parameter of `execute_react_loop_with_agent` (react.rs:171) and is in scope:

```rust
        Some(
            approval_service
                .request(
                    task_id.to_string(),
                    tool_name.clone(),
                    tool_input.clone(),
                    &cancel_token,
                )
                .await,
        )
```

> **VERIFY (move/borrow):** `cancel_token` is used elsewhere in the loop (the top-of-loop `cancel_token.is_cancelled()` check at react.rs:257). `CancellationToken` is `Clone` and the methods take `&self`, so passing `&cancel_token` is fine and does not move it. Confirm `cancel_token` is not moved into the loop body earlier; if a partial move occurs, pass `&cancel_token` (a borrow) as written.

**Why:** Today a parked approval ignores cancellation (only the top-of-loop check exists; a blocked `request` waits up to 600s). `select!` with `biased` cancellation makes cancel immediate while keeping **fail-closed**: cancel → `false`, timeout → `false`, dropped sender → `false`; only an explicit user `Ok(true/false)` returns the decision. This is purely a responsiveness fix; it does not change the approval policy or which tools gate.

**Definition of done:** `cargo check` clean; cancelling a task that is parked on an approval transitions to `Cancelled` promptly (not after 600s); the rejected/approved branches in react.rs (consuming `Option<bool>`) are unchanged.

**How to test:** `cargo check`. Manual: start a task that triggers a mutating-tool approval, then cancel it (via the panel / `cancel` WS command) while the approval modal is up — the task should move to `Cancelled` within ~1s instead of hanging. Confirm a normal approve/reject still works, and that letting it time out still rejects.

---

## Final verification checklist (run before declaring A done)

1. `cd /home/viper/scripts/netstacks-terminal/agent && cargo check` — **zero warnings** (no `#[allow(dead_code)]`; new migrate fn is called; renamed `definition` is used; `request`'s new param is used).
2. `cargo test` for the touched modules (`output_validator`, any approvals/store tests) — green, with the new `execute_ssh_command` regression test.
3. `cd /home/viper/scripts/netstacks-terminal/frontend && npx tsc -b` — clean (every new store field is in both the interface and the initializer; every new type/import used; `TaskWsMessage` union compiles).
4. Manual smoke (standalone): run a tool-using task → transcript streams live, `command` step precedes `tool_result`; reload panel mid-run → backfill via `since_seq` works; cancel a parked-on-approval task → prompt `Cancelled`; create duplicate-named agent → 409; run a disabled agent → 409.

## Things the implementer MUST verify (do not assume)
- **Line numbers** across `api.rs`/`main.rs`/`db/mod.rs`/`react.rs` may have drifted; anchor on the **function names / code snippets** quoted here, not raw line numbers.
- **Route prefix** (`/api` vs bare) — match the existing `/tasks/:id` registration in `main.rs` exactly.
- **`CommandFilter` deny example** in the new SSH validator test — pick a command the filter actually rejects.
- **Closure vs inline** in STEP 5c — if the `record_step` async closure fights the borrow checker, inline the persist+broadcast at each anchor (the fallback the anchors are written for).
- **`super::tools::catalog`** path resolution from `approvals.rs` and `output_validator.rs` (use `crate::tasks::tools::catalog` if `super::` doesn't resolve).
- **MOP tool classification** is intentionally left unchanged; flag `mop_execution`'s fail-open status to the MOP owner — do not gate it in A.
- **Disabled-agent status code** (`409` vs `403`/`400`) — confirm with the plan.


---

# Feature B — Implementation (ordered, literal)

> **Read this first.** The steps below have a HARD dependency order. Do them in order. The reason: today the concurrency permit is **held** while a task parks waiting for a human (up to `APPROVAL_TIMEOUT = 600s`). Feature B adds `ask_user`, which can park a task for an arbitrarily long free-form question. If you add `ask_user` **before** releasing the permit, a single parked question consumes 1 of the cap-3 semaphore slots — three parked questions **deadlock the entire pool**. So:
>
> 1. **Permit-release-while-parked** (executor.rs + thread a release/reacquire handle down) — *must precede everything*.
> 2. **Type the channel** (`oneshot::Sender<bool>` → `oneshot::Sender<HumanResponse>`; `PendingTaskApproval` → `PendingInteraction`).
> 3. **`task_interactions` table** (persist-before-park) + **startup recovery sweep**.
> 4. **`ask_user` non-mutating Tool** (resumes the SAME Tokio task with the typed answer).
> 5. **Generalize REST** `/pending-approvals` → `/pending-interactions` (typed resolve body).
> 6. **Frontend `InteractionPanel`** replacing `TaskApprovalModal` — queued, kind-switched.
>
> All edits are in the **main tree** `/home/viper/scripts/netstacks-terminal/agent/src` and `/home/viper/scripts/netstacks-terminal/frontend/src`. **Do NOT** edit `.worktrees/feature-netconf-gnmi/...`. **No git ops** in this Linux tree. After Rust edits: `cargo check` in `agent/` must be **warning-clean** and use **no `#[allow(dead_code)]`** (use `_`-prefixed names or `#[cfg]` like the existing code). After frontend edits: `npx tsc -b` in `frontend/` must pass strict (`noUnusedLocals`, `noUnusedParameters`).

---

## STEP 0 — Verify before you start (do not skip)

These are assumptions the steps below depend on; confirm each with a quick grep/read:

1. **Semaphore capacity is 3.** Find `TaskRegistry::new(<N>)` construction. Grep:
   ```bash
   grep -rn "TaskRegistry::new" /home/viper/scripts/netstacks-terminal/agent/src
   ```
   The "cap-3" deadlock framing assumes a small N. Whatever N is, the permit-release fix is correct; just confirm N.
2. **`acquire_owned` is the only acquire site** and is at `executor.rs:75-79`:
   ```bash
   grep -n "acquire_owned\|acquire(" /home/viper/scripts/netstacks-terminal/agent/src/tasks/executor.rs
   ```
   There must be exactly one. If there are two, STOP and re-plan.
3. **`request()` has exactly one caller** (`react.rs:339`) and **`resolve()` has exactly two** (`api.rs:10618` true, `api.rs:10633` false):
   ```bash
   grep -rn "\.request(\|\.resolve(" /home/viper/scripts/netstacks-terminal/agent/src/tasks /home/viper/scripts/netstacks-terminal/agent/src/api.rs
   ```
4. **Owner-scoping caveat — VERIFY WITH OWNER.** `PendingTaskApproval` and the `/task-approvals` endpoints today are **global** (no user/owner field; `list_all()` returns everything). Feature B does not change that. If NetStacks is multi-user, a typed interaction (especially a `Checkpoint` carrying a masked credential, Step 6) is answerable by **any** authenticated client. Flag this to the parent. The steps below preserve the existing (global) auth posture; do **not** silently widen it.

---

## STEP 1 — Permit-release-while-parked (MUST be first)

### Goal
Release the concurrency permit **before** a task parks waiting for a human, and re-acquire it (cancel-aware) **before** resuming tool execution, so a parked task does not occupy a semaphore slot. Today the permit (`executor.rs:101` `let _permit = permit;`) is held across the entire spawned body, including the 600s park inside `approval_service.request()`.

### Design decision (do this, not the alternatives)
The park is **deep inside `react.rs`** (`react.rs:338` `approval_service.request(...).await`), not in `executor.rs`. You **cannot** drop the permit purely in `executor.rs`. The clean, low-risk approach is a **`PermitGuard` that the approval call drops and re-acquires around the park**, threaded from `executor.rs` → `execute_task_with_react` → `execute_react_loop_with_agent` → the approval site. This keeps backpressure (the initial `acquire_owned` at `spawn_task` still blocks the caller when at capacity) and keeps the permit held during real work (AI calls, tool execution).

### 1a. New file: `agent/src/tasks/permit.rs`
Create a small RAII-ish handle that owns an `OwnedSemaphorePermit` plus the `Arc<Semaphore>` needed to re-acquire, and exposes a **cancel-aware** release/reacquire pair.

```rust
//! Concurrency-permit handle that can release the semaphore slot while a
//! task is parked waiting for a human, then re-acquire it before resuming
//! real work. See Feature B: a parked free-form question must NOT hold a
//! semaphore slot, or three parked questions deadlock the pool.

use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

/// Wraps the active permit and the semaphore so we can drop the slot during
/// a human park and re-acquire it on resume.
pub struct PermitGuard {
    semaphore: Arc<Semaphore>,
    // None while parked (slot released); Some while holding the slot.
    permit: Option<OwnedSemaphorePermit>,
}

/// Re-acquire failed (semaphore closed) or the task was cancelled while
/// parked. The caller must treat either as a fail-closed terminal outcome.
pub enum ReacquireError {
    Cancelled,
    SemaphoreClosed,
}

impl PermitGuard {
    pub fn new(semaphore: Arc<Semaphore>, permit: OwnedSemaphorePermit) -> Self {
        Self { semaphore, permit: Some(permit) }
    }

    /// Drop the held permit, freeing the slot for another task. Idempotent.
    pub fn release(&mut self) {
        // Dropping the OwnedSemaphorePermit returns the slot to the semaphore.
        self.permit = None;
    }

    /// Re-acquire a slot. Cancel-aware: if the task is cancelled while we wait
    /// for a free slot, return Cancelled instead of blocking indefinitely.
    pub async fn reacquire(
        &mut self,
        cancel_token: &CancellationToken,
    ) -> Result<(), ReacquireError> {
        if self.permit.is_some() {
            return Ok(()); // already holding
        }
        let sem = self.semaphore.clone();
        tokio::select! {
            biased;
            _ = cancel_token.cancelled() => Err(ReacquireError::Cancelled),
            res = sem.acquire_owned() => {
                match res {
                    Ok(p) => { self.permit = Some(p); Ok(()) }
                    Err(_) => Err(ReacquireError::SemaphoreClosed),
                }
            }
        }
    }
}
```

Register the module. In `agent/src/tasks/mod.rs`, add alongside the other `mod` lines (it does **not** need a `pub use` unless used outside `tasks::`; it isn't):
```rust
mod permit;
```
Then re-export the type for use across `tasks::` submodules:
```rust
pub use permit::{PermitGuard, ReacquireError};
```
> Verify the exact `mod`/`pub use` block style in `mod.rs` and match it. `PermitGuard` is used inside `tasks::` only, so a `pub(crate)`/`pub use` within the module tree is fine; pick whichever the neighbors use.

### 1b. `executor.rs` — build the guard and thread it down
**Anchor:** `executor.rs:73-101`.

- Keep the existing acquire at `executor.rs:75-79` (preserves backpressure on the caller).
- After acquiring, **also** grab the `Arc<Semaphore>` (you already have `let semaphore = self.registry.semaphore();` at line 74).
- Replace the `let _permit = permit;` at `executor.rs:101` with a `PermitGuard`.

Edit `executor.rs:99-101` from:
```rust
let join_handle = tokio::spawn(async move {
    // Hold permit for duration of task
    let _permit = permit;
```
to:
```rust
let join_handle = tokio::spawn(async move {
    // Hold permit for the duration of real work; the guard lets the
    // react loop RELEASE the slot while parked on a human decision and
    // RE-ACQUIRE it (cancel-aware) before resuming. Feature B.
    let mut permit_guard = super::PermitGuard::new(semaphore, permit);
```
> `semaphore` is the `Arc<Semaphore>` from line 74. It is currently consumed by `.clone().acquire_owned()` at 75-79 — that `.clone()` means the original `semaphore` binding is still alive after line 79, so you can move it into the spawn. **Verify** `semaphore` is not used after line 79 in a way that conflicts; if rustc complains it was moved, change line 76 to keep an explicit clone for the guard.

Now pass `&mut permit_guard` and the `cancel_token_clone` into `execute_task_with_react`. **Anchor:** the call at `executor.rs:159-171` and the signature at `executor.rs:236-247`.

Add a parameter to `execute_task_with_react`:
```rust
#[allow(clippy::too_many_arguments)]
async fn execute_task_with_react(
    store: &TaskStore,
    task_id: &str,
    prompt: &str,
    tool_registry: Arc<ToolRegistry>,
    cancel_token: CancellationToken,
    broadcaster: ProgressBroadcaster,
    provider: Arc<dyn DataProvider>,
    agent_definition: Option<crate::models::AgentDefinition>,
    sanitizer: Arc<RwLock<Option<Sanitizer>>>,
    approval_service: Arc<super::approvals::TaskApprovalService>,
    permit_guard: &mut super::PermitGuard, // NEW
) -> Result<(), ExecutorError> {
```
And at the call site (`executor.rs:159-171`) add `&mut permit_guard` as the final argument:
```rust
let result = execute_task_with_react(
    &store,
    &task_id_clone,
    &prompt,
    tool_registry,
    cancel_token_clone.clone(), // see note below
    broadcaster,
    provider,
    agent_definition,
    sanitizer,
    approval_service,
    &mut permit_guard, // NEW
)
.await;
```
> `cancel_token_clone` is moved into the call today. The `PermitGuard::reacquire` needs a `&CancellationToken`, but that lives inside `execute_react_loop_with_agent`, which already receives `cancel_token`. So you do **not** need an extra clone here — `execute_task_with_react` already forwards `cancel_token` down to the loop. Keep the existing single move of `cancel_token_clone` (drop the `.clone()` I showed if rustc says it's unnecessary). The point: the **loop** has the token; the guard's `reacquire` will be called from inside the loop where the token is in scope.

### 1c. `react.rs` — thread the guard to the approval site, release/reacquire around the park
**Anchor:** signature `react.rs:166-176`; approval gate `react.rs:328-348`.

Add the guard to the loop signature (it already carries `#[allow(clippy::too_many_arguments)]` at line 165):
```rust
pub async fn execute_react_loop_with_agent(
    task_id: &str,
    prompt: &str,
    registry: Arc<ToolRegistry>,
    broadcaster: &ProgressBroadcaster,
    cancel_token: CancellationToken,
    data_provider: Arc<dyn DataProvider>,
    agent_definition: Option<AgentDefinition>,
    sanitizer_cache: Arc<RwLock<Option<Sanitizer>>>,
    approval_service: Arc<super::approvals::TaskApprovalService>,
    permit_guard: &mut super::PermitGuard, // NEW
) -> Result<Value, ReactError> {
```
Forward it from `execute_task_with_react` where it calls the loop (the single call inside `execute_task_with_react` — match arg order).

Now wrap **only the human park** with release/reacquire. **Anchor:** `react.rs:330-348` (`if needs_approval { ... approval_service.request(...).await ... }`).

Replace the `approval_decision` block (`react.rs:330-348`) with:
```rust
let approval_decision = if needs_approval {
    broadcaster.send(TaskProgressEvent::new(
        task_id.to_string(),
        TaskStatus::Running,
        progress,
        Some(format!("Awaiting approval for: {}", tool_name)),
    ));

    // Feature B: release the concurrency slot WHILE parked on the human,
    // so a long decision does not starve the pool.
    permit_guard.release();

    let decision = approval_service
        .request(
            task_id.to_string(),
            super::approvals::InteractionKind::Approval, // Step 2
            tool_name.clone(),
            tool_input.clone(),
        )
        .await;

    // Re-acquire the slot (cancel-aware) before resuming real work.
    if let Err(e) = permit_guard.reacquire(&cancel_token).await {
        return match e {
            super::ReacquireError::Cancelled => Err(ReactError::Cancelled),
            super::ReacquireError::SemaphoreClosed => {
                Err(ReactError::ApiError("semaphore closed during resume".into()))
            }
        };
    }
    Some(decision) // `decision` is a HumanResponse now (Step 2)
} else {
    None
};
```
> The `request()` call now takes an `InteractionKind` and returns a `HumanResponse` — those types arrive in **Step 2**. If you are compiling incrementally, do Step 2 before `cargo check`. The release/reacquire scaffolding itself is correct regardless.

The **`approval_decision` consumer** at `react.rs:350` (`if let Some(false) = approval_decision`) is rewritten in Step 2 (it becomes `Some(HumanResponse::Reject{..})`).

### Why
The permit is the cap on concurrent tasks. Holding it across a human wait conflates "actively using CPU/network/tool" with "blocked on a person." Releasing during the park lets other queued tasks run; re-acquiring before resuming preserves the cap on actual work. Cancel-awareness on re-acquire means a cancelled task does not hang at a full pool.

### Definition of done
- `cargo check` clean.
- `PermitGuard` releases on `request()` entry and re-acquires (or returns `Cancelled`/`SemaphoreClosed`) on exit.
- Backpressure preserved: `spawn_task` still blocks the caller when the pool is full (initial acquire untouched).

### How to test
- Manual/integration: set cap to **1** (temporarily, in `TaskRegistry::new`). Start task A that triggers a mutating tool (so it parks on approval). While A is parked, start task B. **Before the fix:** B blocks at `acquire_owned` and never starts. **After:** B starts and runs. Resolve A's approval; A re-acquires and completes (it may briefly wait for B to free the slot — acceptable).
- Cancel test: park task A on approval, then cancel A (`cancel_task`). It must return `Cancelled` from the re-acquire `select!` rather than hanging until the 600s timeout. (Note: the existing `request()` timeout is the backstop; the `select!` makes cancel observable immediately during the **re-acquire** phase. The park itself still relies on `request()`'s timeout/resolution — see Step 2 for making the park cancel-aware too.)

> **Park cancel-awareness caveat (verify):** `approval_service.request()` awaits a `oneshot` under a 600s timeout but does NOT observe `cancel_token`. A cancelled, parked task won't unblock the *park* until resolved or timed out. Step 4 + the prompt's "cancel-aware park" requirement: wrap the `rx`-await inside `request()` (Step 2) OR the call site in a `tokio::select!` against `cancel_token` so cancellation drops the park immediately. **Recommended:** make the park cancel-aware at the `react.rs` call site by `select!`-ing `request(...)` against `cancel_token.cancelled()`, returning `ReactError::Cancelled` on cancel. Add this around the `let decision = approval_service.request(...).await;` above. Doing it at the call site keeps `request()` free of token plumbing.

---

## STEP 2 — Type the channel: `HumanResponse` + `PendingInteraction`

### Goal
Generalize the binary `oneshot::Sender<bool>` to a typed two-way channel, and the serialized `PendingTaskApproval` view to a kind-tagged `PendingInteraction`. Preserve the **fail-closed** semantics (timeout / dropped receiver ⇒ deny).

### 2a. New types in `agent/src/tasks/approvals.rs`
**Anchor:** add after the `use` block (line 22), before `is_mutating_tool` (line 31).

```rust
/// What kind of decision the task is parked on. Drives the frontend's
/// InteractionPanel render (approve/reject vs free-text vs plan-edit vs
/// a masked credential checkpoint). STRUCTURAL INVARIANT (Step 4): a
/// Question answer can NEVER resolve an Approval/Checkpoint interaction,
/// and vice-versa — `resolve()` enforces kind/variant compatibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InteractionKind {
    /// Mutating-tool gate (the legacy approve/reject path).
    Approval,
    /// Free-form clarifying question from the `ask_user` tool.
    Question,
    /// User is asked to review/edit a proposed plan before execution.
    Plan,
    /// A checkpoint that may carry a masked credential the user supplies
    /// (e.g. an enable password) — answered with structured/secret data.
    Checkpoint,
}

/// The user's typed reply to a parked interaction. Fail-closed default is
/// `Reject` (timeout/dropped-receiver collapse to it — see `request`).
#[derive(Debug, Clone)]
pub enum HumanResponse {
    Approve,
    Reject { reason: Option<String> },
    Answer { text: String },
    AnswerStructured { json: serde_json::Value },
    EditPlan { steps: serde_json::Value },
}

impl HumanResponse {
    /// True when this response is an affirmative for an Approval-kind gate.
    pub fn is_approved(&self) -> bool {
        matches!(self, HumanResponse::Approve)
    }
}
```

### 2b. Replace `PendingTaskApproval` with `PendingInteraction`
**Anchor:** `approvals.rs:41-48`. Replace the struct (keep the old name as a type alias only if other modules import it — but they don't outside `tasks::`; check the `pub use` in `mod.rs`).

```rust
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
```

### 2c. Retype `PendingState` and the service map
**Anchor:** `approvals.rs:50-60`.
```rust
struct PendingState {
    info: PendingInteraction,
    sender: oneshot::Sender<HumanResponse>, // was oneshot::Sender<bool>
}

#[derive(Default)]
pub struct TaskApprovalService {
    /// Interaction id → state. The ReAct loop is sequential, so one task
    /// has at most one active interaction at a time (the map is keyed by
    /// interaction id, not task id).
    pending: RwLock<HashMap<String, PendingState>>,
}
```
> Keep the type name `TaskApprovalService` to minimize blast radius (it's referenced in `executor.rs:35/50` and `api.rs`). Optionally rename to `TaskInteractionService` later; not required.

### 2d. Rewrite `request()` — kind-aware, returns `HumanResponse`, fail-closed
**Anchor:** `approvals.rs:69-116`. This is the **fail-closed safety site** — preserve it. Replace the whole method:

```rust
/// Create a pending interaction and await the user's typed decision.
/// Fail-closed: timeout OR dropped receiver collapse to `Reject`.
pub async fn request(
    &self,
    task_id: String,
    kind: InteractionKind,
    tool_name: String,
    tool_input: serde_json::Value,
) -> HumanResponse {
    self.request_full(PendingInteraction {
        id: Uuid::new_v4().to_string(),
        task_id,
        kind,
        prompt: format!("Approve tool: {}", tool_name),
        choices: None,
        tool_name: Some(tool_name),
        tool_input: Some(tool_input),
        diff: None,
        created_at: chrono::Utc::now().to_rfc3339(),
    })
    .await
}

/// Generalized entry used by `ask_user` (Question kind) and the approval
/// gate (Approval kind). Caller builds the full PendingInteraction.
pub async fn request_full(&self, info: PendingInteraction) -> HumanResponse {
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
    self.pending.write().await.insert(id.clone(), PendingState { info, sender: tx });

    let outcome = tokio::time::timeout(APPROVAL_TIMEOUT, rx).await;
    self.pending.write().await.remove(&id);
    match outcome {
        Ok(Ok(resp)) => {
            tracing::warn!(
                target: "audit",
                task_id = %task_id,
                kind = ?kind,
                "ReAct task interaction resolved"
            );
            resp
        }
        // FAIL-CLOSED: timeout (Err(Elapsed)) OR dropped sender
        // (Ok(Err(RecvError))) both deny. Do NOT collapse this into
        // unwrap_or — both arms must reach Reject.
        _ => {
            tracing::warn!(
                target: "audit",
                task_id = %task_id,
                kind = ?kind,
                "ReAct task interaction timed out / receiver dropped — treating as rejected"
            );
            HumanResponse::Reject { reason: Some("timed out or cancelled".to_string()) }
        }
    }
}
```

### 2e. Persist-before-park hook (placeholder; wired in Step 3)
`request_full` is where Step 3 inserts the **DB persist** call (before the `oneshot` await) and the **resolved-update** (after). For now leave a comment marker:
```rust
// STEP 3: persist this interaction to task_interactions BEFORE awaiting,
// and mark it resolved/expired AFTER `outcome` is known.
```

### 2f. Rewrite `resolve()` — typed, kind/variant-checked (STRUCTURAL INVARIANT)
**Anchor:** `approvals.rs:135-144`. The invariant: a `Question` answer can never resolve an `Approval`/`Checkpoint`, and an approve/reject can never resolve a `Question`. Enforce it here so a malicious or buggy client can't approve a mutating tool by answering a text question.

```rust
/// Resolve a pending interaction with a typed response. Returns false if
/// no such pending interaction exists OR the response variant is
/// incompatible with the interaction's kind (caller maps to 4xx).
pub async fn resolve(&self, interaction_id: &str, response: HumanResponse) -> bool {
    // Peek kind without removing, to validate compatibility first.
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

/// STRUCTURAL INVARIANT enforcement.
fn response_matches_kind(kind: InteractionKind, resp: &HumanResponse) -> bool {
    use HumanResponse::*;
    use InteractionKind::*;
    match kind {
        // Approval/Checkpoint = a gate: only approve/reject (Checkpoint may
        // additionally carry a structured secret).
        Approval => matches!(resp, Approve | Reject { .. }),
        Checkpoint => matches!(resp, Approve | Reject { .. } | AnswerStructured { .. }),
        // Question = free-form: only text / structured / reject.
        Question => matches!(resp, Answer { .. } | AnswerStructured { .. } | Reject { .. }),
        // Plan = edit/approve/reject.
        Plan => matches!(resp, EditPlan { .. } | Approve | Reject { .. }),
    }
}
```
> The peek-then-remove is a tiny TOCTOU window (kind can't change for a given id, so it's safe; the only race is a concurrent resolve/timeout, which the second `remove` handles by returning `false`).

### 2g. Update `pending_for_task()` / `list_all()` return type
**Anchor:** `approvals.rs:119-133`. Change `Vec<PendingTaskApproval>` → `Vec<PendingInteraction>`. Bodies are otherwise unchanged (they clone `p.info`).

### 2h. Update `is_mutating_tool` callers — Approval kind
The **mutating-tool gate becomes `kind = InteractionKind::Approval`** — already wired in Step 1c (`InteractionKind::Approval` passed to `request`). No change to `is_mutating_tool` itself (leave the allowlist as-is; that's Feature A's catalog work, out of scope here).

### 2i. Update the `react.rs` `approval_decision` consumer
**Anchor:** `react.rs:350` (`if let Some(false) = approval_decision`). It now matches a `HumanResponse`:
```rust
let tool_result = if let Some(HumanResponse::Reject { reason }) = &approval_decision {
    warn!(
        target: "audit",
        task_id = %task_id,
        tool = %tool_name,
        reason = ?reason,
        "ReAct task tool-use REJECTED by user"
    );
    format!(
        "User rejected the call to '{}'{}. Do not retry the same call; \
         ask the user what they want done instead.",
        tool_name,
        reason.as_ref().map(|r| format!(" ({})", r)).unwrap_or_default()
    )
} else if let ValidationOutcome::Block(reason) = validation {
    // ... unchanged ...
```
> Bring `HumanResponse` into scope: `use super::approvals::HumanResponse;` near the existing `use super::tools::output_validator::...` import inside the block, or at the top of `react.rs`. `Some(HumanResponse::Approve)` (and `None` for read-only tools) both fall through to dispatch — preserving the **`None` = auto-allow** semantics for read-only tools.

### 2j. Update `api.rs` resolve callers (compiles now; fully reworked in Step 5)
**Anchor:** `api.rs:10618` and `10633`. Temporarily adapt to the new signature so it compiles before Step 5:
```rust
// approve:
state.task_executor.approval_service
    .resolve(&approval_id, crate::tasks::approvals::HumanResponse::Approve).await
// reject:
state.task_executor.approval_service
    .resolve(&approval_id, crate::tasks::approvals::HumanResponse::Reject { reason: None }).await
```
> If `HumanResponse` isn't re-exported from `tasks::`, add it to the `pub use approvals::{...}` line in `mod.rs`. Also update the `Json<Vec<...PendingTaskApproval>>` return types at `api.rs:10601/10609` to `PendingInteraction`. Full endpoint rename happens in Step 5.

### 2k. Update `mod.rs` re-exports and any importer of `PendingTaskApproval`
Grep and fix:
```bash
grep -rn "PendingTaskApproval" /home/viper/scripts/netstacks-terminal/agent/src
```
Rename all to `PendingInteraction`. Update `pub use approvals::{...}` in `mod.rs` to export `PendingInteraction`, `HumanResponse`, `InteractionKind`.

### Why
The binary `bool` can't carry a free-form answer, a structured credential, or a plan edit. The kind tag is what lets one channel serve approve/reject, ask_user, plan-edit, and credential-checkpoint without four parallel services — and the `response_matches_kind` check is the safety boundary that stops a text answer from silently approving a mutating tool.

### Definition of done
- `cargo check` clean; no `PendingTaskApproval` references remain.
- Fail-closed: timeout/dropped-receiver ⇒ `Reject` (both arms).
- `resolve()` rejects (returns `false`) on kind/variant mismatch.

### How to test
- Unit test in `approvals.rs` (`#[cfg(test)]`): create a `Question` interaction via `request_full` in a spawned task; from the test, call `resolve(id, HumanResponse::Approve)` and assert it returns `false` (invariant) and the task is still parked; then `resolve(id, HumanResponse::Answer{..})` returns `true` and the task receives the text.
- Drop test: create an interaction, then drop the service/`rx` without resolving; assert `request_full` returns `Reject`.

---

## STEP 3 — `task_interactions` table (persist-before-park) + startup recovery sweep

### Goal
Persist every interaction **before** parking so it survives an agent restart, and on startup mark orphaned (`pending`) interactions as `expired` (fail-closed) so a restarted agent never silently resumes a parked task with a stale in-memory channel.

### 3a. Schema — `agent/src/db/schema.sql`
**Anchor:** after the `agent_tasks` block (`schema.sql:599-614`), before `-- AI Agent Definitions` (line 616).
```sql
-- AI Agent Task Interactions (Feature B - durable two-way human channel)
CREATE TABLE IF NOT EXISTS task_interactions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('approval', 'question', 'plan', 'checkpoint')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'expired')),
    prompt TEXT NOT NULL,
    choices_json TEXT,
    tool_name TEXT,
    tool_input_json TEXT,
    diff TEXT,
    response_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_interactions_task ON task_interactions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_interactions_status ON task_interactions(status);
```
> **Never persist the response of a `checkpoint` that carries a raw secret.** If a Checkpoint answer contains a credential, store it in the **vault** (see Step 6) and put only a vault reference in `response_json`, or null `response_json`. Flag this to the owner.

### 3b. Migration fn — `agent/src/db/mod.rs`
**Anchor:** add the fn just before the `#[cfg(test)] mod tests` block (~line 2902), copying the `migrate_device_memory_tables` shape:
```rust
/// Migrate task_interactions table - create if it doesn't exist (Feature B)
async fn migrate_task_interactions_table(pool: &SqlitePool) -> Result<(), DbError> {
    if !table_exists(pool, "task_interactions").await? {
        sqlx::query(
            r#"CREATE TABLE task_interactions (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK (kind IN ('approval', 'question', 'plan', 'checkpoint')),
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'expired')),
                prompt TEXT NOT NULL,
                choices_json TEXT,
                tool_name TEXT,
                tool_input_json TEXT,
                diff TEXT,
                response_json TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                resolved_at TEXT
            )"#,
        )
        .execute(pool)
        .await
        .map_err(|e| DbError::Migration(format!("Failed to create task_interactions table: {}", e)))?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_task_interactions_task ON task_interactions(task_id)")
            .execute(pool).await
            .map_err(|e| DbError::Migration(format!("Failed to create task_interactions task index: {}", e)))?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_task_interactions_status ON task_interactions(status)")
            .execute(pool).await
            .map_err(|e| DbError::Migration(format!("Failed to create task_interactions status index: {}", e)))?;

        tracing::info!("Created task_interactions table");
    }
    Ok(())
}
```
Register it in `init_schema` **after** `migrate_agent_tasks_table` (line 97) and **before** `seed_default_settings` (line 131). The `migrate_device_memory_tables` cluster at line 127 is a fine insertion point:
```rust
    migrate_task_interactions_table(pool).await?;
```
> FK to `agent_tasks(id)` requires it to exist first — line 97 guarantees that. FKs are enforced (`init_db` sets `.foreign_keys(true)`).

### 3c. Store methods — `agent/src/tasks/store.rs`
**Anchor:** inside `impl TaskStore`, after `_count_by_status` (closing braces ~line 217). Follow the existing sqlx pattern (`Uuid::new_v4()`, `Utc::now().to_rfc3339()`, both already imported).

```rust
/// Persist a pending interaction BEFORE the task parks on it.
pub async fn create_interaction(
    &self,
    id: &str,
    task_id: &str,
    kind: &str,
    prompt: &str,
    choices_json: Option<&str>,
    tool_name: Option<&str>,
    tool_input_json: Option<&str>,
    diff: Option<&str>,
) -> Result<(), TaskStoreError> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO task_interactions \
         (id, task_id, kind, status, prompt, choices_json, tool_name, tool_input_json, diff, created_at) \
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
    )
    .bind(id).bind(task_id).bind(kind).bind(prompt)
    .bind(choices_json).bind(tool_name).bind(tool_input_json).bind(diff).bind(&now)
    .execute(&self.pool)
    .await?;
    Ok(())
}

/// Mark an interaction resolved (or expired) once the human responds or it
/// times out. `response_json` is None for expired/timed-out.
pub async fn resolve_interaction(
    &self,
    id: &str,
    status: &str, // "resolved" | "expired"
    response_json: Option<&str>,
) -> Result<(), TaskStoreError> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE task_interactions SET status = ?, response_json = ?, resolved_at = ? WHERE id = ?",
    )
    .bind(status).bind(response_json).bind(&now).bind(id)
    .execute(&self.pool)
    .await?;
    Ok(())
}

/// STARTUP RECOVERY: any interaction left 'pending' after a restart is
/// orphaned (its in-memory oneshot is gone). Fail-closed: mark expired so
/// the agent never resumes a stale park. Returns the count expired.
pub async fn expire_orphaned_interactions(&self) -> Result<u64, TaskStoreError> {
    let res = sqlx::query(
        "UPDATE task_interactions SET status = 'expired', resolved_at = datetime('now') \
         WHERE status = 'pending'",
    )
    .execute(&self.pool)
    .await?;
    Ok(res.rows_affected())
}
```
> No `pub use` needed if these are methods on the already-exported `TaskStore`. Verify `TaskStore` is in `mod.rs`'s `pub use` (it is).

### 3d. Wire persist into `request_full` (Step 2e marker)
`request_full` lives in `approvals.rs`, which does **not** hold a `TaskStore`. Two options — pick the one matching project style:
- **(Preferred, minimal)**: give `TaskApprovalService` an optional `Arc<TaskStore>` handle (set in `TaskApprovalService::new(store)` or a `with_store`). Then in `request_full`, before the `oneshot` await, call `store.create_interaction(...)`; after `outcome`, call `store.resolve_interaction(id, "resolved"|"expired", ...)`.
- **(Alt)**: persist from `react.rs`/`ask_user` (the call site has the store via `data_provider`/`pool`) by calling create/resolve around the `request`/`request_full` call.

If you add a store to the service, update `executor.rs:50` (`TaskApprovalService::new()`) to pass the store, and `executor.rs:35` field doc. **Verify** `TaskStore: Clone` (it is, `#[derive(Clone)]`).

### 3e. Run the recovery sweep on startup
Call `expire_orphaned_interactions()` once during agent boot, **after** migrations, **before** accepting traffic. Natural spot: right after the executor/store are constructed in `main.rs` (grep for where `AgentTaskExecutor::new` or `TaskStore::new` is called). Log the count.

### Why
Without persistence, a restart loses every parked interaction silently and the task hangs (its `oneshot` receiver is gone → `request` already fail-closes via `RecvError`, but the **DB** would still claim it's resolvable). The recovery sweep makes the durable record consistent with the fail-closed in-memory behavior, and gives the UI a truthful "expired" state instead of a phantom pending prompt.

### Definition of done
- Table created on fresh install (schema.sql) and existing DB (migration).
- A parked interaction has a `pending` row; resolving flips it to `resolved` with `response_json`; timeout flips to `expired`.
- After a simulated restart, all previously-`pending` rows are `expired`.

### How to test
- `cargo check`; boot the agent against a fresh DB and confirm `task_interactions` exists (`sqlite3 <db> '.schema task_interactions'`).
- Park a task on an approval, kill the agent process, restart, confirm the row is `expired` and the UI shows no phantom prompt.

---

## STEP 4 — The `ask_user` non-mutating Tool

### Goal
A Tool the agent can call to pause and ask a free-form clarifying question; it parks via `request_full(kind=Question)` and **returns the typed answer as its `ToolOutput`**, so the **same Tokio task** resumes with the answer in the conversation. Because permit-release (Step 1) is in place, a long question no longer starves the pool.

### 4a. New file `agent/src/tasks/tools/ask_user.rs`
Follow the `device_query.rs` template. The tool needs the `Arc<TaskApprovalService>` to call `request_full`. Pass it via `new(...)`.

```rust
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tracing::info;

use super::{Tool, ToolError, ToolOutput};
use crate::tasks::approvals::{HumanResponse, InteractionKind, PendingInteraction, TaskApprovalService};

#[derive(Debug, Deserialize)]
struct AskUserInput {
    question: String,
    #[serde(default)]
    choices: Option<Vec<String>>,
}

/// Non-mutating tool: pause the task and ask the user a free-form question,
/// resuming the SAME task with the typed answer. Permit is released while
/// parked (executor PermitGuard) so this does not starve the pool.
pub struct AskUserTool {
    approval_service: Arc<TaskApprovalService>,
}

impl AskUserTool {
    pub fn new(approval_service: Arc<TaskApprovalService>) -> Self {
        Self { approval_service }
    }
}

#[async_trait]
impl Tool for AskUserTool {
    fn name(&self) -> &str {
        "ask_user"
    }

    fn description(&self) -> &str {
        "Pause and ask the human operator a clarifying question, then resume \
         with their answer. Use ONLY when you genuinely cannot proceed without \
         human input (ambiguous target device, missing parameter, a yes/no \
         judgment call). Do NOT use it to ask permission to run a tool — \
         mutating tools already prompt for approval automatically."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The clarifying question to ask the user."
                },
                "choices": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional list of suggested answers shown as chips."
                }
            },
            "required": ["question"],
            "additionalProperties": false
        })
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let params: AskUserInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid ask_user input: {}", e)))?;

        if params.question.trim().is_empty() {
            return Err(ToolError::InvalidInput("question must not be empty".into()));
        }

        info!(task_id = %task_id, "ask_user parking for human answer");

        let interaction = PendingInteraction {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: task_id.to_string(),
            kind: InteractionKind::Question,
            prompt: params.question.clone(),
            choices: params.choices.clone(),
            tool_name: None,
            tool_input: None,
            diff: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        };

        let response = self.approval_service.request_full(interaction).await;

        // STRUCTURAL INVARIANT (enforced in resolve(), defense-in-depth here):
        // a Question can only be answered by Answer/AnswerStructured/Reject.
        let answer = match response {
            HumanResponse::Answer { text } => text,
            HumanResponse::AnswerStructured { json } => json.to_string(),
            HumanResponse::Reject { reason } => {
                // User declined / timed out. Tell the model so it can wrap up
                // gracefully rather than loop. Non-fatal.
                let r = reason.unwrap_or_else(|| "no answer provided".to_string());
                return Ok(ToolOutput::success(json!({
                    "answered": false,
                    "message": format!("User did not answer the question ({}).", r),
                })));
            }
            // Should be unreachable thanks to resolve()'s kind check.
            other => {
                return Err(ToolError::ExecutionFailed(format!(
                    "ask_user received an incompatible response variant: {:?}",
                    std::mem::discriminant(&other)
                )));
            }
        };

        Ok(ToolOutput::success(json!({
            "answered": true,
            "answer": answer,
        })))
    }
}
```
> **Prompt-injection caveat (flag to owner):** the `answer` text is fed straight back into the model's context as a tool result, and the `question` came from the model. Treat the user's answer as untrusted free text — it can contain injection attempts. It does **not** auto-approve anything (Question can't resolve an Approval — Step 2f). But if a downstream tool consumes the answer as a parameter, that tool's own validator (`output_validator`, `CommandFilter`) is the real boundary. Do not special-case `ask_user` output as "trusted."

### 4b. Register the module — `agent/src/tasks/tools/mod.rs`
**Anchor:** `pub mod` block (lines 7-18) and `pub use` block (24-31). Add alphabetically:
```rust
pub mod ask_user;
```
```rust
pub use ask_user::AskUserTool;
```

### 4c. Register the tool — `agent/src/tasks/executor.rs`
**Anchor:** import line 21 and registration block 124-156. Add `AskUserTool` to the `use super::tools::{...}` brace. Then register it **before** line 156 (`let tool_registry = Arc::new(tool_registry);`). It needs the `approval_service`, which is already cloned into the spawned body at `executor.rs:96` (`let approval_service = self.approval_service.clone();`):
```rust
tool_registry.register(Arc::new(AskUserTool::new(approval_service.clone())));
```
> `approval_service` is later moved into `execute_task_with_react` (line 169). Clone it here for the tool. Place this registration after `MopAnalysisTool` (line 130) and before the conditional write-tool block.

### 4d. No react-loop change needed
`ask_user` is **not** mutating, so it is NOT in `is_mutating_tool` (correct — asking a question must not itself require approval). It dispatches via the normal `registry.get(&tool_name)` path (`react.rs:375-383`). The permit is released around the **approval** gate (Step 1c); for `ask_user`, the park happens **inside `tool.execute()`** at `react.rs:383`, which is **NOT** wrapped by the Step-1c release.

> **CRITICAL — extend permit-release to cover `ask_user`.** The Step-1c release only wraps the mutating-tool approval gate. `ask_user` parks inside `tool.execute()`, where the permit is still held. You have two options:
> - **(Preferred)** Detect `ask_user` (and any tool that parks) and release/reacquire around its dispatch. At `react.rs:375` add: if `tool_name == "ask_user"`, call `permit_guard.release()` before `tool.execute(...)` and `permit_guard.reacquire(&cancel_token).await?` after. Keep a single small helper to avoid duplication.
> - **(Cleaner, more work)** Make the park release the permit itself by giving the tool a handle to the guard — not worth the plumbing; the call-site wrap is simpler.
>
> Implement the call-site wrap. Concretely, around `react.rs:383` (the `match tool.execute(...)` for the `registry.get` branch), gate on a known "parks" set (`tool_name == "ask_user"`) to release before and reacquire after. **Verify** no other registered tool parks on a human today (none do).

### 4e. `output_validator` default arm
`ask_user` hits `_ => ValidationOutcome::Allow` (output_validator.rs:152) — fine. Optionally add an explicit `"ask_user" => Allow` arm with a length cap on `question` to bound abuse. Not required.

### Why
This is the entire point of Feature B's "voice": the agent can stop and ask, then continue the **same** reasoning thread with the answer — no new task, no lost context. Returning the answer as the tool result is what makes the ReAct loop naturally resume.

### Definition of done
- `cargo check` clean; `ask_user` appears in the model's tool list (it's auto-included via `list_tools()`).
- Calling `ask_user` parks the task, releases the permit, and on answer the task resumes with `{"answered": true, "answer": "..."}` in the conversation.
- A `Question` interaction cannot be resolved by approve/reject (Step 2f).

### How to test
- Cap=1: start an `ask_user` task; while it's parked, start a second task → it must run (permit released). Answer the question via the resolve endpoint (Step 5); the first task resumes and completes.
- Invariant: while parked on `ask_user`, POST approve to its id → 4xx / `false` (Step 5 maps this); POST a text answer → resolves.

---

## STEP 5 — Generalize REST: `/pending-approvals` → `/pending-interactions` (typed body)

### Goal
Replace the binary approve/reject endpoints with a typed resolve that carries a `HumanResponse`, and rename the list endpoints to interactions. Keep backward-compatible thin aliases only if the frontend rollout needs them (it doesn't if you ship Step 6 together).

### 5a. New resolve handler — `agent/src/api.rs`
**Anchor:** replace `approve_task_tool_use` / `reject_task_tool_use` (`api.rs:10613-10641`) with a single typed handler. Add a request body type near the other request structs:
```rust
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolveInteractionBody {
    Approve,
    Reject { reason: Option<String> },
    Answer { text: String },
    AnswerStructured { json: serde_json::Value },
    EditPlan { steps: serde_json::Value },
}

impl From<ResolveInteractionBody> for crate::tasks::approvals::HumanResponse {
    fn from(b: ResolveInteractionBody) -> Self {
        use crate::tasks::approvals::HumanResponse as H;
        match b {
            ResolveInteractionBody::Approve => H::Approve,
            ResolveInteractionBody::Reject { reason } => H::Reject { reason },
            ResolveInteractionBody::Answer { text } => H::Answer { text },
            ResolveInteractionBody::AnswerStructured { json } => H::AnswerStructured { json },
            ResolveInteractionBody::EditPlan { steps } => H::EditPlan { steps },
        }
    }
}

/// POST /api/task-interactions/:interaction_id/resolve — typed resolution.
pub async fn resolve_task_interaction(
    State(state): State<Arc<AppState>>,
    Path(interaction_id): Path<String>,
    Json(body): Json<ResolveInteractionBody>,
) -> Result<StatusCode, ApiError> {
    let response: crate::tasks::approvals::HumanResponse = body.into();
    if state.task_executor.approval_service.resolve(&interaction_id, response).await {
        Ok(StatusCode::NO_CONTENT)
    } else {
        // `false` here means: not found, already resolved/expired, OR the
        // response variant was incompatible with the interaction kind
        // (structural invariant). All map to a client error.
        Err(ApiError {
            error: "Interaction not found, already resolved, or incompatible response".to_string(),
            code: "NOT_FOUND".to_string(),
        })
    }
}
```
> **Improve fidelity (optional but recommended):** `resolve()` returns `false` for both "not found" and "kind mismatch." Consider having `resolve()` return a small enum (`Resolved | NotFound | KindMismatch`) so the API can return `409`/`400` vs `404` distinctly. If you keep `bool`, document that `NOT_FOUND` covers the invariant-violation case too.

### 5b. Rename list handlers
**Anchor:** `api.rs:10598-10611`. Rename and retype:
```rust
/// GET /api/tasks/:task_id/pending-interactions
pub async fn list_task_pending_interactions(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Json<Vec<crate::tasks::approvals::PendingInteraction>> {
    Json(state.task_executor.approval_service.pending_for_task(&task_id).await)
}

/// GET /api/task-interactions
pub async fn list_all_task_interactions(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<crate::tasks::approvals::PendingInteraction>> {
    Json(state.task_executor.approval_service.list_all().await)
}
```

### 5c. Routes
Grep for where the old routes are registered and rename:
```bash
grep -rn "pending-approvals\|task-approvals" /home/viper/scripts/netstacks-terminal/agent/src
```
Map:
- `GET /tasks/:id/pending-approvals` → `GET /tasks/:id/pending-interactions`
- `GET /task-approvals` → `GET /task-interactions`
- `POST /task-approvals/:id/approve` + `/reject` → `POST /task-interactions/:id/resolve`
> If you want a no-flag-day rollout, keep the two old `approve`/`reject` POST routes as thin wrappers that call `resolve` with `Approve`/`Reject{None}`. Otherwise delete them and ship Step 6 in lockstep.

### Why
The binary endpoints can't carry a text/structured/plan answer. The single `resolve` with a tagged body is the REST mirror of `HumanResponse`, and the server-side `resolve()` invariant check (Step 2f) means the endpoint can't be abused to approve a mutating tool by sending a text answer.

### Definition of done
- `cargo check` clean. Old `PendingTaskApproval`/approve/reject symbols gone (or aliased intentionally).
- `POST /task-interactions/:id/resolve` with `{"kind":"answer","text":"R1"}` resumes a Question; with `{"kind":"approve"}` against a Question returns 4xx.

### How to test
- `curl` the resolve endpoint against a live parked interaction (get the id from `GET /task-interactions`). Verify approve-against-question rejected; answer-against-question accepted.

---

## STEP 6 — Frontend `InteractionPanel` (queued, kind-switched) replacing `TaskApprovalModal`

### Goal
Replace the single-item approve/reject `TaskApprovalModal` with a **queued**, **kind-switched** panel: text box (Question), choice chips (Question/Plan with `choices`), masked credential→vault (Checkpoint), inline diff (Plan/Checkpoint with `diff`). Each resolved interaction also renders as a transcript card (ties into Feature A's transcript view).

### 6a. Types — `frontend/src/api/taskApprovals.ts` (rename to interactions)
Replace `PendingTaskApproval` with `PendingInteraction` matching the Rust `PendingInteraction` (snake_case on the wire — these list endpoints use snake_case, unlike the camelCase `task_progress` WS event; **verify** by hitting `GET /task-interactions`):
```ts
export type InteractionKind = 'approval' | 'question' | 'plan' | 'checkpoint';

export interface PendingInteraction {
  id: string;
  task_id: string;
  kind: InteractionKind;
  prompt: string;
  choices?: string[];
  tool_name?: string;
  tool_input?: unknown;
  diff?: string;
  created_at: string;
}

export type ResolveBody =
  | { kind: 'approve' }
  | { kind: 'reject'; reason?: string }
  | { kind: 'answer'; text: string }
  | { kind: 'answer_structured'; json: unknown }
  | { kind: 'edit_plan'; steps: unknown };

export async function listAllPendingInteractions(): Promise<PendingInteraction[]> {
  const { data } = await getClient().http.get('/task-interactions');
  return data;
}

export async function resolveInteraction(id: string, body: ResolveBody): Promise<void> {
  await getClient().http.post(`/task-interactions/${id}/resolve`, body);
}
```
> Keep the existing import style for `getClient`. Delete `approveTaskToolUse`/`rejectTaskToolUse` or reimplement them atop `resolveInteraction`.

### 6b. New component `frontend/src/components/InteractionPanel.tsx`
Replace `TaskApprovalModal`. Keep the **enterprise short-circuit** (`useMode().isEnterprise` → return null / no poll), the **750ms poll** model (or move to the WS `task_progress`/a new `interaction_request` event — see 6d), and a **queue** (handle all pending, not just `items[0]`).

```tsx
import { useEffect, useRef, useState } from 'react';
import { useMode } from '../hooks/useMode';
import {
  listAllPendingInteractions,
  resolveInteraction,
  type PendingInteraction,
  type ResolveBody,
} from '../api/taskApprovals';

const POLL_INTERVAL_MS = 750;

export default function InteractionPanel() {
  const { isEnterprise } = useMode();
  const [queue, setQueue] = useState<PendingInteraction[]>([]);
  const [answer, setAnswer] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isEnterprise) return; // enterprise has no local interaction surface
    const tick = async () => {
      try {
        const items = await listAllPendingInteractions();
        setQueue(items);
      } catch {
        /* transient; keep last queue */
      }
    };
    void tick();
    timer.current = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [isEnterprise]);

  const current = queue[0] ?? null;
  if (!current) return null;

  const resolve = async (body: ResolveBody) => {
    await resolveInteraction(current.id, body);
    setAnswer('');
    // optimistic dequeue; next poll reconciles
    setQueue((q) => q.filter((i) => i.id !== current.id));
  };

  return (
    <div className="interaction-panel-overlay">
      <div className="interaction-panel">
        <div className="interaction-queue-count">
          {queue.length > 1 ? `${queue.length} pending` : '1 pending'}
        </div>
        <div className="interaction-prompt">{current.prompt}</div>

        {/* kind switch */}
        {current.kind === 'approval' && (
          <ApprovalBody interaction={current} onResolve={resolve} />
        )}
        {current.kind === 'question' && (
          <QuestionBody
            interaction={current}
            answer={answer}
            setAnswer={setAnswer}
            onResolve={resolve}
          />
        )}
        {current.kind === 'plan' && (
          <PlanBody interaction={current} onResolve={resolve} />
        )}
        {current.kind === 'checkpoint' && (
          <CheckpointBody interaction={current} onResolve={resolve} />
        )}
      </div>
    </div>
  );
}
```
Sub-bodies (sketch — implement each):
- **`ApprovalBody`**: shows `tool_name` + `<pre>{JSON.stringify(tool_input, null, 2)}</pre>` (reuse the existing `TaskApprovalModal` destructive heuristic), Approve/Reject buttons → `resolve({kind:'approve'})` / `resolve({kind:'reject'})`.
- **`QuestionBody`**: a text input bound to `answer` + Send → `resolve({kind:'answer', text: answer})`. If `choices`, render choice chips that each call `resolve({kind:'answer', text: choice})`.
- **`PlanBody`**: if `diff`, render it (inline diff). Edit area → `resolve({kind:'edit_plan', steps})`; Approve as-is → `resolve({kind:'approve'})`.
- **`CheckpointBody`**: **masked** credential input (`type="password"`). On submit, **store the secret in the vault** and resolve with a **reference**, not the raw secret. **Verify the vault API** (`grep -rn "vault" frontend/src/api`) and store there; resolve with `{kind:'answer_structured', json:{credentialRef: <id>}}`. **Do NOT** send the raw secret in `response_json` to be persisted in `task_interactions` (Step 3a caveat).

### 6c. Mount it — `frontend/src/main.tsx`
**Anchor:** `<TaskApprovalModal />` at line 206 inside `<VaultUnlockGate>`. Replace with `<InteractionPanel />`. Remove the old import.

### 6d. (Optional) WS push instead of polling
If you want push, extend `frontend/src/types/tasks.ts` `TaskWsMessage` union with an `interaction_request` / `interaction_resolved` variant and ingest it in `useAgentTasks.ts` onmessage (`~line 219`), storing `pendingInteractions` in the Zustand store (add field + setter to **both** the `AgentTasksState` interface at line 34 **and** the `create()` initializer at line 60, or strict-TS fails). The backend would need to broadcast a new event from `request_full` via the `ProgressBroadcaster` (Feature A's transport). Polling is simpler and matches the existing `TaskApprovalModal` — ship polling first.

### 6e. Styling
`TaskApprovalModal` is 100% inline-styled. Prefer a new `InteractionPanel.css` using the project `--color-*` tokens (like `AgentsPanel.css`). Reuse `.task-log-*` card classes for the transcript-card rendering so each resolved interaction shows in the task detail view.

### Why
A single-item approve/reject modal can't express "answer this question" or "edit this plan" or "supply this credential." The kind switch is the UI mirror of `InteractionKind`; the queue handles the (now realistic) case of multiple parked tasks each waiting on a human.

### Definition of done
- `npx tsc -b` clean (strict, no unused).
- `TaskApprovalModal` removed; `InteractionPanel` mounted in `main.tsx`.
- Each kind renders its body; resolving posts the correct typed body; queue advances.
- Checkpoint secrets go to the vault, never to `task_interactions.response_json`.
- Enterprise mode shows nothing (short-circuit preserved).

### How to test
- Standalone: trigger an `ask_user` task → text box appears → type answer → task resumes. Trigger a mutating-tool task → approval body appears → approve → tool runs.
- Queue: start two interaction-needing tasks; confirm the panel shows "2 pending" and advances after each resolve.
- Strict build: `cd frontend && npx tsc -b`.

---

## Cross-cutting caveats the implementer MUST flag/verify

- **Owner-scoping (verify with owner):** interactions are **global** (no per-user field). Any authenticated client can resolve any task's interaction. If multi-user, add an owner column + auth filter — out of current scope, but call it out.
- **Prompt injection:** `ask_user`'s `question` (model-authored) and the user's `answer` (untrusted) both enter model context. The answer is NOT trusted to authorize anything; downstream tool validators (`output_validator`, `CommandFilter`) remain the enforcement boundary. The structural invariant (Step 2f) is what stops a text answer from approving a mutating tool.
- **Fail-closed everywhere:** timeout, dropped receiver, restart-orphan, kind mismatch, cancel-during-reacquire — all deny. Preserve the `_ => Reject` arm in `request_full` and the `expire_orphaned_interactions` sweep.
- **Cancel-aware park (verify):** Step 1c re-acquire is cancel-aware; the **park itself** (`request`/`request_full` await) is not unless you wrap the call in `select!` against `cancel_token`. Do this (recommended) so a cancelled parked task unblocks immediately rather than at the 600s timeout.
- **Iteration budget:** every `ask_user` round-trip consumes a ReAct iteration (default `max_iterations = 15`, `react.rs:28`). A chatty agent can hit `MaxIterationsReached` (an **Err**, treated as failure). Consider not counting `ask_user` turns against the budget, or raising the cap — verify desired behavior with the owner.
- **Worktree:** edit only the main tree. **No git ops.** Build gates: `cargo check` (warning-clean, no `#[allow(dead_code)]`) and `npx tsc -b` (strict).

---

# Open Decisions & Honest Caveats

These are **out of scope for A/B** but the implementer and product owner should know them — A/B are deliberately the safe, high-trust foundation, not the whole vision.

1. **Config mode is the approved change lane.** Device configuration changes are an intended, opt-in capability gated by the server-side, master-password'd, TTL'd config-mode state (recently hardened so the read-only floor is enforced on every AI path, including the PTY `run_command` path). **A/B do not touch this** — agents make changes through the existing config-mode lane. **MOPs are alpha and are NOT a dependency** for A or B.

2. **Prompt injection via device output is a real, unclosed surface.** Device-controlled text (LLDP/CDP neighbor names, interface descriptions, banners, syslog) flows into the ReAct context and can attempt to steer the agent's next command. B's **structural invariant** (a Question-kind answer can never resolve an Approval/Checkpoint-kind interaction) prevents *answer-laundering*, but does not stop injected text from proposing a plausible-but-malicious action. Two follow-ups beyond A/B: a **per-agent tool allow-list** (so a read-only triage agent simply has no `send_email`/write tools to abuse — `send_email` is a standing exfiltration vector), and a backend **model-output gate** (`ToolPolicyProvider` at the SanitizingProvider layer) that rejects forbidden `tool_use` before it reaches any executor.

3. **Owner-scoping is attribution, not a security boundary.** The agent authenticates with a single per-process bearer token, so any "owner" of a task/interaction is client-self-reported. B's interactions are owner-tagged for correct routing and audit, but on a shared/`--remote` agent this is **not** a hard cross-operator boundary until a real per-operator identity layer exists. Do not market it as multi-tenant isolation.

4. **Enterprise mode is standalone-first for these features.** The live transcript (A) and interaction events (B) ride the local `/ws/tasks` WebSocket, which **does not exist in enterprise** (the local agent self-exits; the frontend polls an out-of-repo Controller every 5s). Keep the **`task_messages` and `task_interactions` schemas + the `/pending-interactions` contract stable** so the Controller team can mirror them later — but the Controller backend is out of repo and out of scope here. Respect the existing enterprise gate in every new frontend data path (`TaskApprovalModal` already `return`s early in enterprise; new code must too).

5. **What comes after A/B (the larger vision, not built here):** per-agent **granted-tools allow-list** + **blast-radius scope** (which devices/credentials an agent may ever touch); a four-position **autonomy dial** (read-only → propose → approve-each-change → auto-within-radius) with a **risk classifier** that auto-demotes to a question when the agent leaves known-safe ground; **plan-first** execution (restate + show plan, auto-approve read-only plans); **idempotency keys + per-device change locks** before any unattended change; **supervisor fan-out** across a fleet; and **triggers** (schedule / alert webhook). A and B are the trust foundation every one of those builds on.

---

*Generated from a verified reading of the NetStacks codebase. If any anchor in this document does not match the file you open, trust the file and adjust — then note the discrepancy.*
