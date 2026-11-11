# Changelog

All notable changes to NetStacks Terminal are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Audience for this file is end users — what they should know about a
release. Internal refactors and commit-by-commit detail belong in the
git log, not here.

---

## [Unreleased]

This section accumulates changes since the last published release. It will
become the entry for the next tagged version.

### Added
- API client: API Resources and their saved requests (Quick Calls) now live in an
  **API** section of the Workspaces sidebar instead of two Settings tabs. Click a
  request to open it in a request tab (method, path, headers, body, template
  variables, extract path on top; status, duration, response headers, body and a
  short per-tab history below). Send runs it ad hoc, Save stores it as a Quick
  Call. *API Client: New Request* in the command palette opens a blank one.
  Responses now include headers, and a request's own `Content-Type` header is
  honoured for raw-text and form bodies.
- Clipboard history: everything you copy inside NetStacks is recorded with where it
  came from (session, device, CLI flavor). `Ctrl+Shift+H` (or *Clipboard: History…*)
  searches it; Enter pastes into the active terminal, Ctrl+Enter re-copies, pin
  to keep past the retention window. Credentials (passwords, secrets, keys, SNMP
  communities) are scrubbed from stored history; the OS clipboard is untouched.
  *Clipboard: Import from OS clipboard* is the only way external text enters history.
- Paste hygiene: pasting into a terminal applies a preset for that session's CLI
  flavor (IOS/NX-OS/XR/EOS: strip CRs, trailing spaces, `!` comments, extra blank
  lines; Junos: strip `display set` banners; Linux: normalize line endings).
  `Ctrl+Shift+Alt+V` pastes raw. *Clipboard: Paste with preview…* shows the
  original next to what will be sent with control characters made visible.
  Settings → Clipboard edits presets and history retention. A clipboard button
  in the top bar opens the history; both clipboard popups can be dragged by
  their title bar and resized from the corner, and remember their placement.
- Confirm multi-line paste (SecureCRT-style, on by default, Settings → Clipboard):
  pasting two or more lines into a terminal opens the paste dialog first, where
  the text can be edited before it is sent; the right pane shows exactly what
  will reach the device. Ctrl+Enter pastes.
- Terminal clipboard chords are now in Settings → Keyboard: Paste (Cmd/Ctrl+V,
  preset + confirm dialog), Paste Passthrough (Cmd/Ctrl+Shift+V, raw, no dialog)
  and Copy Selection (Cmd/Ctrl+Shift+C). Shift+Insert / Ctrl+Insert still work.
  Settings → Clipboard gains an "Enable advanced paste" master switch.

### Fixed
- OpenRouter: a Base URL typed as https://openrouter.ai (without /api/v1) is normalised to the API root, and an HTML page returned where JSON was expected now names the likely cause.
- OpenRouter and other OpenAI-compatible gateways: an error returned with HTTP 200 is now shown as the provider's message in the chat instead of a decode error or a silent empty reply.
- Inline NetBot popup and floating chat no longer echo the internal session/selection envelope in the user bubble.
- Topology map: double-click to connect now honours the session's protocol; Telnet sessions no longer fail with an SSH error.
- AI panel no longer shows a seeded question twice when it is opened from a topology, backup or device-memory "Ask AI" action.
- Device memory card: "Ask AI about this" now opens the AI panel with the incident attached instead of doing nothing.
- Scratchpad typing latency and dropped characters: the floating Scratchpad owns its text buffer (a keystroke no longer re-renders the whole app shell) and Monaco is uncontrolled after mount, so fast typing is never overwritten by a stale React value.
- Faster launch: the app no longer issues the same startup requests three or
  four times over, MCP servers connect in parallel instead of one after
  another, and the dev server pre-warms the module graph.
- MCP server URLs are logged without their query string, so gateway tokens
  passed as `?token=…` no longer appear in agent logs or error messages.
- Dialogs no longer close when a text selection or drag that began inside
  them ends over the backdrop.
- Startup: the agent no longer aborts with "no such column: execution_id" when
  opening a database created by an earlier version.
- Escape key works again everywhere: it reaches the terminal (vi, less, device
  CLI escape sequences) and closes dialogs, menus and popups that handle it
  themselves. An always-mounted modal had been swallowing every Escape.
- AI helpers (Tab-autocomplete, command/next-step suggestions, enrichment
  digests, commit messages, MOP/document/scratchpad AI fields) no longer answer
  as the AI Engineer setup interviewer, and no longer write "profile" fields
  scraped from unrelated text into your AI Engineer profile. The setup
  interview now runs only from the AI panel's welcome conversation.
- Setup wizard: choosing OpenAI, OpenRouter, Ollama, LiteLLM or Custom now
  enables that provider for the AI panel and makes it the default (the panel
  used to keep asking Anthropic and fail with "No model configured"). Custom,
  Ollama and LiteLLM get a Base URL field; a blank model picks the first model
  the provider lists; the model field is no longer mislabelled "optional";
  keyless providers no longer show "Need a key?".
- A Custom AI provider saved without a Base URL now reports "Custom provider
  has no Base URL…" instead of a raw 500 "builder error".
- AI panel: failed tool calls show a red ✕ with the error expanded instead of
  the same green check as successes; every tool result can be expanded.
- AI panel: with no provider configured, the welcome message points to
  Settings → AI instead of inviting you to type "hi".
- AI system prompt no longer describes config-backup tools the model cannot
  call; they appear only when the controller provides them.
- `navigate_to_settings` AI tool lists every real Settings tab (Quick Calls,
  Enrichment, Documents, Trusted Hosts, Recordings, Layouts, Session Logs,
  Workspaces) and rejects unknown tab names.
- Status bar "Overlord" button is now "AI Highlights" with an accurate tooltip;
  it toggles live AI highlighting of terminal output, not the AI panel, and no
  longer shows the Ctrl+I hint.
- Model hints/defaults use current model IDs (`claude-opus-5`,
  `claude-sonnet-5`, `claude-haiku-4-5`) from one shared list; stale
  `claude-3.5-sonnet`/dated IDs removed.
- Topology device/connection overlays no longer show permanent "Interfaces /
  Neighbors / Statistics will be available…" placeholder sections.
- MOP plan editor no longer offers the unimplemented "Deployment" step source.
- Command palette no longer lists New Terminal, Settings and Quick Connect
  twice.
- Changes/MOPs record the signed-in user (enterprise) or the account the local
  agent runs as, instead of a hard-coded "engineer".
- SSH via a jump host: keepalives now also run on the target hop.
- AI credential sanitizer: redactions kept the literal text `${1}[REDACTED]`
  instead of the safe prefix (e.g. `enable secret 5 [REDACTED]`), garbling
  configs sent to the model; group references are now expanded.
- Keyboard shortcuts: rebinding a shortcut in Settings → Keyboard now takes
  effect immediately (previously required a restart), updates the macOS menu
  bar accelerators, other windows, and every tooltip/menu/palette hint, and is
  loaded back from the agent on startup. Conflicting chords (another action,
  tab switching, system keys) are refused instead of silently never firing.
  The Sessions/Documents groups were missing from the editor; menu-only
  accelerators (New Session, New Document, Zoom, Toggle AI Chat, Close All
  Tabs, Reopen Closed Tab) now work on Windows/Linux and are rebindable, as
  are Save Terminal Output (Cmd+Shift+S) and Run Script (Cmd+Enter).
  Wrong hints fixed in the status bar, Groups panel, and Troubleshooting
  settings. New Window moved to Cmd+Alt+N (it collided with New Document).
- Mapped keys: edits apply to open terminals immediately; a mapped chord no
  longer also sends the raw keystroke to the device; Cmd and Ctrl are
  recorded as distinct keys; duplicates and clashes with app shortcuts are
  flagged before saving. Mapped keys recorded on macOS before this release
  as `Ctrl+…` should be re-recorded if they were meant to be Cmd chords.
- AI side panel: the message box no longer opens oversized on first use.

### Added
- MOP plan variables. A **Variables** card on the Plan tab declares named
  values (default, description, required) that steps reference as
  `{{name}}` in commands, expected outputs, quick-action variables and script
  args; the Devices tab sets per-device overrides. Values are resolved per
  device when an execution starts (the Execute preview shows the resolved
  command), `{{device.host}}` / `{{device.name}}` / `{{device.type}}` are
  always available, and a step with an unresolved placeholder or a required
  variable without a value is refused before anything is sent to the device.
  Variables round-trip through MOP export/import and the AI `create_mop` tool.
- MOP commands in the command palette and menus: New MOP, Save MOP, Start
  Execution, Run Next Step, Abort Execution…, Complete Execution — enabled
  only when the active MOP tab can perform them.
- MOP Review → **Run AI Analysis** is now performed by the agent with the full
  execution record (devices and platforms, every step's command, status,
  assertions and output, pre/post diffs) and the configured AI provider; the
  result is stored with the execution and shows its provenance (model, or the
  rule-based fallback and why). **Re-run** forces a fresh review.
- Out-of-band console access per session. Session Settings has a new
  **Console** tab (terminal server host, port, SSH/Telnet, terminal-server
  credential profile, legacy SSH). Right-click a session → **Open Console**
  opens the console in its own tab; if nothing is configured yet, the
  settings dialog opens on the Console tab with **Save & Open Console**.
  Works with any console server that exposes serial lines over SSH or
  Telnet (Opengear, Cisco async, Avocent, Lantronix, …). Also available
  from a terminal tab's context menu; console tabs show a violet console
  icon in the tab strip and a `console host:port` pill. Console fields are
  included in session export/import and the CSV importer/exporter (new
  `console_host`, `console_port`, `console_protocol`, `console_profile`,
  `console_legacy_ssh` columns — see the example CSV template).
- NetBox import fills in console access: cable each device's console port to
  its console server in NetBox and set the `device_console` custom field
  (TCP port) on the console port. NetBox sources gain a terminal-server
  profile and per-manufacturer SSH/Telnet rules (defaults: Opengear → SSH,
  Cisco → Telnet). Re-running an import refreshes console access on
  already-imported sessions (optional) and the report explains any device
  whose console path could not be resolved.
- AI console tools `open_console` and `run_console_command` (off by default;
  enable per mode in Settings → AI → AI Tools → OOB Console). They only work
  through a console tab you can see, require approval in Ask mode, refuse
  login prompts / ROMMON / config mode, and never enter credentials.
  `list_sessions` now reports `console_configured` / `console_connected`.
- Open-source release of the NetStacks Terminal and Local Agent under
  Apache 2.0. NetStacks is now open-core: Personal Mode (this repo) is
  free and open; the commercial Controller for teams remains a separate
  product.
- `LICENSE` (Apache-2.0), `NOTICE` (third-party attributions), `README`,
  `CONTRIBUTING`, `SECURITY`, `SUPPORT`, and `CODE_OF_CONDUCT`
  (Contributor Covenant 2.1) at the repository root.
- GitHub issue templates and pull-request template under `.github/`.
- Continuous-integration workflow at `.github/workflows/ci.yml` covering
  agent, Tauri shell, and frontend across Linux / macOS / Windows.

### Changed
- `AppMode` is now `'standalone' | 'enterprise'` (previously
  `'basic' | 'professional' | 'enterprise'`). Personal Mode is the
  single standalone configuration.
- `license_tier` in the capabilities response is now
  `'standalone' | 'team' | 'enterprise'`. The free `basic` and paid
  standalone `professional` tiers no longer exist; standalone is
  full-featured.
- Default standalone capabilities expose every local feature. There is
  no longer a tiered subset.
- Distribution moved off GitHub Releases. Signed installers are now
  published to <https://netstacks.net/download>.

### Removed
- Settings → API Resources and Settings → Quick Calls (moved to the Workspaces
  sidebar → API section; old links and the AI's settings navigation redirect there).
- The Local Agent's license-validation module (`agent/src/license/`) and
  every call site. The agent no longer phones home and no longer holds a
  license-server URL.
- License-related dependencies from `agent/Cargo.toml`
  (`jsonwebtoken`, `zeroize`).
- All license/tier UI in the frontend: `LicenseContext`,
  `LicenseProvider`, `LicenseBanner`, `LicenseStatus`,
  `LicenseActivation`, `SettingsLicense`, `useLicense`, `AppGate`, the
  License tab in Settings, the BASIC chat-only system prompt, and every
  feature-gate that referenced "professional or enterprise tier".
- The plugin SDK and scaffold from this repository — plugins only run in
  the commercial Controller and now ship there instead.

### Security
- Jump-host SSH connections now use `StrictHostKeyChecking=accept-new`
  (TOFU). Previously they bypassed host-key checking entirely with
  `StrictHostKeyChecking=no`, which made man-in-the-middle attacks
  trivial against any device reached through a jump host.
- `fetch_controller_cert` (the bootstrap that retrieves the Controller's
  CA certificate during first-time setup) now requires the controller URL
  to use `https://` and to include a host. The TLS bypass remains
  intentional for the bootstrap step, but the URL is parsed and validated
  before the request fires.
- The terminal-log endpoints (`start_terminal_log`, `write_terminal_log`,
  `append_to_log`, `stop_terminal_log`'s read path) now confine all
  paths to `~/Documents/NetStacks/logs/` via canonicalization. Previously
  these endpoints accepted arbitrary user-supplied paths and constituted
  an arbitrary file-write / arbitrary file-read primitive.

### Fixed
- Edit dialogs can now actually clear a value: "No folder", "No jump host",
  theme/font/SFTP path, highlight colours, mapped-key descriptions, tunnel
  remote host, device-memory role/notes, NetBox source filters, quick-action
  and API-resource fields, git-account host. Saving `null` used to be
  silently ignored everywhere.
- Error messages now show the real reason from the local agent ("Vault is
  locked", "Cannot delete profile: 3 sessions use it", …) instead of
  "Request failed with status code 500".
- Closing a modified document or script tab now asks before discarding edits;
  Close Others/All/Right and group "Replace" launches honour the same check.
  Closing the app window with connected sessions or unsaved edits prompts too.
- Terminal: reconnecting no longer leaks the old input listener (each
  keystroke after a reconnect used to drop the session); the "Connection
  lost" overlay and auto-reconnect now trigger when the device ends the
  session, not only when the agent dies; session logs are flushed every 2 s
  instead of only on Stop; the command-safety "Proceed" no longer double-types
  the command; SSH keepalives follow the profile setting; host-key prompts now
  appear for interactive sessions (unknown keys were accepted silently, changed
  keys hard-refused).
- Session settings: scrollback, auto-reconnect and reconnect delay are now
  applied to the terminal and persisted on create; CSV import works again;
  drag-to-reorder works upward; duplicate copies protocol/jump/forwards;
  deleting a session or profile that others jump through is refused with a
  clear message instead of silently converting them to direct connections;
  bulk delete only removes folders it emptied.
- Settings: "Reset to defaults" resets what it says and the panel reflects it;
  Font Size can no longer save `NaN`; one shared switch control replaces six
  mismatched toggles (bigger hit target, keyboard focus ring); Status Bar
  Snippets/Quick Prompts can be hidden; Custom Action errors are shown.
- AI: provider settings no longer bleed between providers (Test/Save on one
  card overwrote the active config); base-URL/TLS edits save; remote Ollama
  is honoured; Ollama model tags keep their `:tag`; floating/inline chat input
  works again; closing the popup stops the agent; Stop no longer leaves the
  conversation in a state the provider rejects; batch `run_command` no longer
  crashes the loop; every tool result (and error) is shown; approval covers
  SSH/bash/file tools, not just `run_command`; command capture waits for
  output to go quiet instead of a fixed 5 s; MCP Connect shows the real
  enabled state and "Auth: None" is saved; chat history persistence no longer
  turns itself off after one 404; Prompts "Reset to default" works.
- Topology: moving/resizing/editing an annotation no longer wipes its other
  properties on reload; Delete topology asks first; save-as-topology and JSON
  import keep annotations, enrichment and link styling; discovery uses the
  session's jump host / credentials; New Topology dialog stops resetting
  while you type; SNMP interface stats try every community and report
  timeouts as timeouts (direct and via jump); SNMP never borrows another
  profile's community string.
- Tunnels: Start works on a failed tunnel; editing a running tunnel restarts
  it; the unimplemented "Remote (-R)" type is no longer offered.
- SFTP: OS drag-and-drop uploads go to the folder you're looking at; >64 MB
  uploads report the limit.
- MOP: Review tab no longer crashes on a diff; steps/devices don't get stuck
  in "running" after an error; export/import keeps per-step device targeting;
  2.x packages import.
- Dialogs: Escape in a nested dialog no longer closes the parent; Command
  Palette results are keyboard-selectable; several dialogs gained
  Escape/backdrop dismiss and scroll on short windows; title bar and overlays
  respect the light theme.
- Keyboard: Ctrl+W/T/B/F/I/S reach the terminal on Windows/Linux; menu
  Toggle AI Panel, Find, Reconnect, New Document and Save do what they say.
- Local agent: client errors return 4xx instead of 500 (SFTP, validation,
  not-found, git); a locked vault is reported as such instead of "no password
  configured"; bulk command reports skipped sessions; migrations are
  transactional.
- Session Guard (preview): no longer panics on non-ASCII config lines;
  resolves next-hop routes (`show ip cef`, bounded route recursion) so the
  guard works for normally-routed management access; recognises prompts with
  trailing text (`?` help, syslog); waits for the echo to settle before
  evaluating Enter; holds expire after 60 s; facts expire after 10 min and
  refresh on any interface/VLAN write; `interface range` is expanded; denied
  probe commands report "unknown" instead of a false "known" path; only
  activates for the Cisco IOS flavor (no stray second logins on Linux/Junos);
  probe is cancelled on tab close; settings apply to quick-connect sessions.
- File → Save and Cmd+S work for scripts, SFTP files, MOPs and unsaved
  documents (single save path; Caps Lock safe); "Reopen Closed Tab" covers
  tabs closed one at a time; Quick Look Notes/Templates/Outputs focus their
  category; terminal font size/family are their own settings.
- SFTP uploads are streamed — files larger than 64 MB upload.
- Background tasks: "Run" returns immediately (queued when at capacity)
  instead of timing out; every remaining bespoke toggle uses the shared switch.

- _(none for this release; no upstream-tagged version yet)_

---

<!--
Tagging conventions for future entries:
  - `## [X.Y.Z] - YYYY-MM-DD`
  - Keep entries user-visible (what changed in the binary they install)
  - Group under: Added / Changed / Deprecated / Removed / Fixed / Security
  - Link upgrade notes here when a release requires user action
-->
