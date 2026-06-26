# Agent Orchestration (Sub-Agents) — Implementation Plan

Status: **IMPLEMENTED (Phases 1–4).** Naming refactor (AI Assistant / Agents) DONE.
- Phase 1 (data model): DONE — `parent_task_id`/`root_task_id`/`depth`/`spawned_by_agent_definition_id`/`delegation_label` via idempotent migration `migrate_agent_subagent_columns`; model + store + frontend type.
- Phase 2 (spawn primitive): DONE — `Tool::parks()` trait (replaced hardcoded ask_user check); `delegate_to_agent` (blocking, permit released while awaiting child) + `list_specialists` in `tasks/tools/subagent.rs`; `spawn_task(self: &Arc<Self>)`; safety limits; cancel propagates to subtree.
- Phase 3+4 (UI): DONE — `lib/subagentGraph.ts` (tidy tree layout), `SubagentNode.tsx` + `AgentWorkflowGraph.tsx` (+ css): pan/zoom canvas, draggable/resizable/expandable boxes embedding `AgentActivity`; Activity⇄Workflow toggle in `AgentRunTab`; double-click a node opens that run's tab.
- Verified: `cargo check` clean+warning-free, 37 tasks tests pass, `tsc -b` clean. Pending: GUI test on Mac.

Original plan below (kept for reference / open decisions).

This plan adds the ability for an **Agent** (a declared, typed, long-running task) to
delegate work to **other agents** mid-run — either a user-declared **specialist**
(e.g. "Core Node Expert") or an **ephemeral child** it spins up itself — with every
delegated run **correlated to its parent** so it renders as part of the parent's
workflow and stays independently **auditable**. It also defines the **graph UI**
(reusing the Topology canvas infra) to view/expand/drag/resize those sub-agent boxes.

---

## 0. Terminology (post-rename — already applied)

- **AI Assistant** = the generic conversational chat (side panel / tab / pop-out;
  `AISidePanel`). It may *also* spawn child agents to offload work / save context —
  **UI for the Assistant's children is deferred** (out of scope here). The spawn
  primitive built below is shared, but this plan's UI focuses on Agents.
- **Agents** = declared, typed task-runners = `agent_definitions` + their runs
  (`agent_tasks`, executed by `AgentTaskExecutor` running the ReAct loop). **Focus.**
- **Specialist** = a delegated child whose identity is a known `agent_definition`
  (reusable, has a domain system prompt). e.g. "Core Node Expert".
- **Ephemeral child** = a delegated child with no definition — an on-the-fly generic
  agent the parent creates because no specialist matched. Disposable.
- In the UI a specialist run and an ephemeral run look the same (both are child
  nodes under the parent); the only difference is the specialist carries a
  definition id/name.

## 1. Goal & user stories

1. A user creates a custom Agent: *"You are a Core Node Expert; troubleshoot core
   node issues like XXXX."* (already possible — agent definitions.)
2. A different Agent (say a "Document the network" agent) runs and hits a core-node
   problem. It can **discover** the Core Node Expert and **hand it a job**, get the
   result back, and continue. The specialist's run is **correlated to the parent**.
3. If **no** matching specialist exists, the Agent **spins up an ephemeral child**
   to do the sub-job, also correlated to the parent.
4. In the UI, the parent run shows its sub-agents as a **graph of boxes** —
   expandable (show the child's live/recorded activity feed), draggable, resizable,
   movable — each fully auditable on its own.
5. Guardrails prevent infinite/explosive spawning.

## 2. Verified current state (do NOT re-derive — confirmed in code)

- **Spawn-from-chat EXISTS**: `AISidePanel`/`useAIAgent` advertise + handle
  `spawn_agent_task` and `list_agent_definitions` (schema in
  `frontend/src/lib/agentTools.ts`, handler in
  `frontend/src/hooks/useAIAgent.ts` ~line 2379). They call
  `runAgentDefinition(agent_id, prompt)` (specialist) or `createTask({prompt})`
  (generic). Spawned tasks are real `agent_tasks` with full auditable transcripts
  (`task_messages` → `AgentActivity`).
- **GAP 1 — no linkage**: `agent_tasks` (schema.sql ~600) has **no** parent/child
  column. `createTask`/`runAgentDefinition` record no parent. Sub-agents appear
  flat. *Nothing can render as a tree until this exists.*
- **GAP 2 — agents can't spawn**: the backend `AgentTaskExecutor` tool registry
  (`agent/src/tasks/executor.rs` ~128-156) registers ssh/device/email/mop/
  ask_user/save_document/file tools — **no spawn tool**. Only the chat can spawn.
- **Executor entry point**: `AgentTaskExecutor::spawn_task(task_id)` (executor.rs:59)
  creates a Tokio task running `execute_task_with_react`. The executor holds
  `store, registry, broadcaster, pool, provider, mcp_manager, sanitizer,
  approval_service`. Tools are built per-task and receive `(input, task_id)` in
  `Tool::execute`.
- **Topology UI is HTML5 `<canvas>`** (`TopologyCanvas.tsx`, 2573 lines, `ctx`
  draw calls, world↔screen pan/zoom transforms). Canvas nodes can't embed React →
  reuse its **pan/zoom + grid + edge drawing**, render **sub-agent boxes as DOM
  overlays** on top. (reactflow-style.)
- **AgentActivity** (`frontend/src/components/AgentActivity.tsx`) already renders a
  run's full step feed and is reused inside each sub-agent box.

## 3. Data model (Phase 1 — foundation, nothing works without it)

Add to `agent_tasks` (agent/src/db/schema.sql + a runtime `ALTER TABLE` migration
for existing DBs — confirm the migration mechanism in `agent/src/db/` before
writing; schema.sql is `CREATE TABLE IF NOT EXISTS` so existing DBs need ALTERs):

| column | type | meaning |
|---|---|---|
| `parent_task_id` | TEXT NULL, FK→agent_tasks(id) | immediate parent run (null = top-level) |
| `root_task_id` | TEXT NULL | top of the tree (denormalized for cheap tree fetch; = id for roots) |
| `depth` | INTEGER NOT NULL DEFAULT 0 | 0 = root; enforced against MAX_DEPTH |
| `spawned_by_agent_definition_id` | TEXT NULL | which specialist (null = ephemeral child) |
| `delegation_label` | TEXT NULL | short human label the parent gave the sub-job ("check BGP on core") |

Index: `idx_agent_tasks_parent ON agent_tasks(parent_task_id)`,
`idx_agent_tasks_root ON agent_tasks(root_task_id)`.

Touch points:
- `agent/src/models.rs` — `AgentTask` struct + serde (add the 5 fields, all
  `Option`/default so existing rows/JSON stay valid).
- Task store create/get/list queries (`agent/src/tasks/store.rs` or wherever
  `get_task`/`create_task` live) — select/insert the new columns.
- API responses (`agent/src/api.rs` task endpoints + the WS task payload) — include
  the new fields so the frontend store gets them.
- Frontend `AgentTask` type (`frontend/src/types/tasks.ts`) + `useAgentTasks` store
  — carry `parent_task_id`/`root_task_id`/`depth`/`spawned_by_agent_definition_id`/
  `delegation_label`.

**Acceptance:** existing flows unchanged; new columns null/0 for all current tasks;
a task created with a parent persists + returns the linkage.

## 4. Backend — the spawn primitive (Phase 2)

### 4.1 Inject a spawner into tools
The spawn tool must (a) create a child `agent_task` row with linkage, then (b) call
`AgentTaskExecutor::spawn_task(child_id)`. The executor builds the tool registry, so
the tool needs a handle *back* to a spawner. Avoid a hard cycle:

- Define `trait SubagentSpawner: Send + Sync` in `agent/src/tasks/` with
  `async fn spawn_child(&self, req: SpawnChildRequest) -> Result<String /*child_id*/>`
  and `async fn await_child(&self, child_id, timeout) -> Result<ChildOutcome>`.
- Implement it for `AgentTaskExecutor` (it already has store + spawn_task + pool +
  a way to read agent_definitions). Hold the executor as `Arc<AgentTaskExecutor>`;
  pass `Arc<dyn SubagentSpawner>` (a clone) into the spawn tool when building the
  per-task registry. (Executor must therefore be constructed as `Arc` and self-
  reference via the Arc — store an `Arc<Self>`-style handle, or build the registry
  in `spawn_task` where the `Arc<executor>` is available. Decide during impl;
  prefer building the registry with the Arc handle in `spawn_task`.)

`SpawnChildRequest { parent_task_id, prompt, agent_definition_id: Option, label,
depth, root_task_id }`.

### 4.2 New tools (registered only for Agent tasks, NOT chat)
- **`list_specialists`** — returns available `agent_definitions` (id, name, summary)
  so the agent can choose one. (Backend mirror of the chat's
  `list_agent_definitions`.)
- **`delegate_to_agent`** — params: `prompt` (the sub-job), `agent_id` (optional;
  omit = ephemeral), `label` (short), `wait` (bool, default **true**),
  `timeout_seconds` (default 300). Behaviour:
  1. Enforce safety (§4.3). On violation → tool error (fail-closed), surfaced as a
     normal tool_result so the agent adapts.
  2. `spawn_child` → child row with `parent_task_id = self`, `root_task_id`,
     `depth = self.depth + 1`, `spawned_by_agent_definition_id = agent_id`,
     `delegation_label = label`. If `agent_id`, child uses that definition's system
     prompt/config; else an ephemeral generic agent with `prompt`.
  3. `spawn_task(child_id)` to run it.
  4. If `wait`: await child terminal state (poll store / oneshot) up to timeout →
     return the child's `result_json` (or error/cancelled) as the tool_result, so
     the parent continues with the answer. If `!wait`: return `{child_id, status:
     "running"}` immediately (background; the parent monitors via the graph).
  5. Emit a transcript step on the PARENT ("Delegated to <specialist|ephemeral>:
     <label> → <child_id>") so the parent's own `AgentActivity` shows the handoff,
     and the child carries the back-link.

### 4.3 Safety (fail-closed, configurable)
- `MAX_DEPTH` (default 3): reject if `self.depth + 1 > MAX_DEPTH`.
- `MAX_CHILDREN_PER_TASK` (default 5): count existing children of self.
- `MAX_DESCENDANTS_PER_ROOT` (default 25): count by `root_task_id`.
- **Cancellation propagation**: cancelling a task cancels its descendants
  (`cancel_task` walks children by `parent_task_id`, or the cancel token tree).
- **Capability gating inheritance**: config-mode / terminal-mode allow-flags do NOT
  widen for children — a child inherits ≤ parent's permissions. (Tie into existing
  `ai.terminal_mode` / config-mode allow gating.)
- Defaults live in settings (standalone) / controller (enterprise), like other AI
  gates. Keep limits in one config struct.

### 4.4 Optional: same primitive for the Assistant (deferred UI)
`useAIAgent`'s `spawn_agent_task` should also set `parent` linkage (tagged to the
conversation/root) using the same columns, so Assistant-spawned children are
correlated too — but their **graph UI is out of scope** here. Low-effort: pass an
optional `parent`/`conversation` tag through `createTask`/`runAgentDefinition`.

**Acceptance:** an Agent run can call `delegate_to_agent`, a child task runs with
correct linkage, the parent receives the child result (wait=true), limits reject the
6th child / depth 4, cancelling the parent cancels children. `cargo check` clean,
no `#[allow(dead_code)]`, warning-clean.

## 5. API & frontend store (Phase 3)

- **Tree fetch**: `GET /tasks/:id/tree` → the root + all descendants (flat list with
  linkage; frontend builds the tree). Or reuse the existing tasks WS/list + filter by
  `root_task_id` client-side (cheaper — prefer this; the store already holds tasks).
- `useAgentTasks` store: add a selector `selectSubtree(rootId)` returning the run +
  descendants ordered by depth, plus `childrenOf(taskId)`.
- Each child's transcript already streams via the existing task WS + the
  `/tasks/:id/messages` catch-up — **no new transcript plumbing**; the graph just
  mounts `AgentActivity` per node.

## 6. UI — the Workflow Graph (Phase 4)

**Reuse, don't reinvent.** New component `AgentWorkflowGraph` +
`SubagentNode` + `AgentWorkflowGraph.css`.

- **Canvas/edge layer (reuse Topology):** extract or reuse `TopologyCanvas`'s
  pan/zoom transform (`viewOffset`, `zoom`, world↔screen) and connection drawing for
  the **background grid + edges** between parent/child boxes. The edges are drawn on
  a `<canvas>`/SVG layer sized to the viewport, transformed by the same pan/zoom.
  (If extracting from TopologyCanvas is too entangled, replicate just the
  pan/zoom+grid+line-draw — but try reuse first per the consistency goal.)
- **Node layer (DOM overlay):** each `SubagentNode` is an absolutely-positioned DOM
  box transformed by the shared pan/zoom, so it can hold real content:
  - **Collapsed:** status pill (running/completed/failed/cancelled, reuse
    `agent-run-status` styles), specialist name or "ephemeral", `delegation_label`,
    a step count, and an expand chevron.
  - **Expanded:** embeds `<AgentActivity steps={transcript} live={isRunning} />`
    (the exact feed used in the run tab) — fully auditable inline.
  - **Draggable** (manual position override stored per-node, like Topology
    annotation positions), **resizable** (corner handle), **movable**.
  - Double-click a node → open that sub-agent as its own **Agent run tab** (reuse
    `handleOpenAgentRunTab`) for the full-room view / continue-in-chat.
- **Auto-layout:** layered top-down by `depth` (simple Sugiyama/Walker-lite: parent
  centered over its children). Manual drags override; a "re-layout" button resets.
- **Live:** new children appear as nodes as they spawn; status/feed update via the
  existing WS-backed store (no polling).
- **Where it lives:** a **"Workflow" toggle** in the Agent run tab (`AgentRunTab`)
  — the run shows either the linear activity feed (current) or the graph of itself +
  descendants. The root run is the top node. (Also reachable from the Agents panel
  for any root task.)

**Acceptance:** running an Agent that delegates shows a parent box with child boxes
wired beneath it; boxes expand to the live activity feed, drag/resize/move; double-
click opens the child's run tab; pan/zoom works; styling matches Topology + existing
tokens. `tsc -b` clean.

## 7. Build sequence (each increment independently shippable + verifiable)

1. **Phase 1 — data model**: columns + migration + model/API/store plumbing.
   Verify: tasks round-trip linkage; existing flows unchanged.
2. **Phase 2 — spawn primitive**: `SubagentSpawner` + `delegate_to_agent` +
   `list_specialists` + safety. Verify: an Agent delegates and gets results;
   limits + cancellation hold; `cargo check` clean.
3. **Phase 3 — store/tree selectors**: `selectSubtree`/`childrenOf`. Verify: store
   exposes the tree from existing task data.
4. **Phase 4 — graph UI**: `AgentWorkflowGraph` + `SubagentNode`, reusing Topology
   pan/zoom + `AgentActivity`. Verify in GUI: spawn → boxes → expand/drag/resize.
5. **Phase 5 (later)**: Assistant-children linkage + their UI; node-graph polish
   (auto-layout tuning, minimap, edge labels with the delegation result summary).

## 8. Open decisions (resolve before / during Phase 2)

1. **Migration mechanism** — confirm how `agent/src/db` applies schema changes to
   existing DBs (embedded migrations vs. just schema.sql). Needed before Phase 1.
2. **Executor self-reference** — cleanest way to give the spawn tool a spawner
   handle without a refcount cycle (build registry inside `spawn_task` with the
   `Arc<executor>` vs. a separate `SpawnService`). Lean: separate lightweight
   `SpawnService { store, pool, executor: Weak<AgentTaskExecutor> }`.
3. **wait vs async default** — default `wait=true` (parent uses child result). Keep
   `wait=false` for parallel fan-out. Confirm the ReAct loop tolerates a long
   blocking tool call (it already does for ssh; reuse the cancel-aware park).
4. **Ephemeral child config** — what system prompt/limits does an ephemeral child
   get? Proposal: a trimmed generic agent prompt + inherit parent capability gates.
5. **Enterprise** — does the controller need to know about sub-agent tasks
   (audit/limits)? Mirror the existing controller task path; tag children.

## 9. Explicitly out of scope (this plan)

- The Assistant's child-agent **UI** (primitive is shared; viz deferred).
- A full drag-to-author node editor (this is a **monitoring/audit** graph, not an
  authoring canvas like the screenshot's builder).
- Cross-run/global orchestration dashboards.
