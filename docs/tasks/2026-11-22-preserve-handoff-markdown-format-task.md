# Task Plan: Preserve Handoff Markdown Formatting

- Created: 2026-11-22
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: User requested preserving Markdown formatting in `handoff` while not affecting normal delegation; confirmed hybrid transport design.

<!-- task-doc-section:background-goal -->
## Background and goal

The `handoff` MCP tool currently folds Markdown whitespace into one line before using the ordinary PTY prompt path. That keeps submission compatible but makes the handoff difficult for the target Agent to read. Preserve raw Markdown for AgentPort `json_rpc` Sessions through the existing structured-prompt transport, while retaining the current compact PTY fallback and explicitly reporting when formatting could not be preserved. Do not change normal `create_session` or `send_prompt` behavior.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**In scope**

- Handoff-only transport selection using Session transport metadata.
- Raw Markdown structured prompt delivery for JSON-RPC Sessions.
- Safe compact fallback for PTY/Generic Shell and result metadata (`formatPreserved`, transport, fallback reason).
- Handoff tests, E2E coverage where a JSON-RPC fixture is available, docs, validation, commit, and Debug App delivery.

**Non-goals**

- No change to ordinary prompt delivery or raw-byte MCP tools.
- No universal PTY bracketed-paste rollout; compatibility is unproven across Agent TUIs.
- No temporary handoff file or `docs/handoff/` output.
- No Host protocol redesign; reuse existing `session.structured_input` / `structured_prompt`.
- No modification to unrelated `mobile/src-tauri/gen/schemas/acl-manifests.json`.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | AgentPort already exposes `RemoteService::structured_prompt` and the `session.structured_input` Host method. | `crates/agentport-service/src/lib.rs:775,2938`; `crates/agentport-host/src/server.rs:509`; `crates/agentport-remote-protocol/src/lib.rs:893`. |
| F-002 | Host structured prompts require JSON-RPC transport and preserve the supplied text instead of routing through PTY input. | `crates/agentport-host/src/server.rs:509-541`. |
| F-003 | Existing handoff currently compacts Markdown and delegates through ordinary `create_session_with_pane`. | `crates/agentport-mcp/src/tools.rs:662-680,1277-1294`. |
| F-004 | Existing ordinary delegation must preserve its line-oriented delivery semantics because text and Enter are intentionally separate for TUI compatibility. | `crates/agentport-mcp/src/ops.rs:537-650`; project learning `TUI prompt delivery`. |
| F-005 | JSON-RPC transport is represented as `json_rpc`; PTY as `pty`. | `crates/agentport-core/src/models.rs:253-275`; `SessionSummary.transport`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: The handoff tool can create a Session without a first ordinary prompt, wait for readiness, then invoke structured_prompt, while still returning immediately after structured delivery.
- Assumption: Role preambles and structured handoff content need a combined structured message for JSON-RPC; the full handoff body remains newline-preserving, while role guidance may be a separate textual prefix.
- Assumption: PTY fallback reports the loss of formatting rather than silently claiming preservation.
- Open question: None after user confirmation of JSON-RPC raw delivery and PTY compact fallback.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- JSON-RPC handoff delivers raw Markdown with newlines preserved through `structured_prompt`.
- PTY/Generic Shell handoff continues to use the existing compact fallback and explicitly returns `formatPreserved=false` plus a reason.
- Result metadata identifies transport and formatting outcome; no path claims preservation without evidence.
- Ordinary `create_session`, `send_prompt`, and wait behavior are unchanged.
- Handoff remains immediate-return and creates no handoff document.
- Unit/integration tests cover transport selection, raw structured text, fallback metadata, invalid content, and existing delegation.
- Task changes are committed, Debug App is rebuilt/restarted and visually verified, and unrelated mobile schema remains untouched.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001` handoff transport implementation → `T-002` tests/docs → `T-003` integrated validation/commit/debug delivery.
- Parallel batches: None; transport selection and handoff lifecycle share `tools.rs` and must be serialized.
- Serialization constraints: Do not alter ordinary prompt path; keep all writes in the handoff scope and reserve this task document for coordinator updates.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Add structured JSON-RPC handoff and explicit PTY fallback

- Status: done
- Owner: coordinator
- Objective: Preserve raw Markdown for JSON-RPC handoffs while keeping PTY delegation safe and unchanged for normal tools.
- Inputs and prerequisites: Existing `handoff`, `SessionOps`, `RemoteService::structured_prompt`, SessionSummary transport.
- Scope or files: `crates/agentport-mcp/src/tools.rs`, `crates/agentport-mcp/src/ops.rs` only if a narrow structured helper is required.
- Expected output: Handoff-specific readiness/structured delivery path and result metadata.
- Dependencies: None.
- Execution steps:
  1. Validate raw Markdown without folding away newlines; retain existing bound/control checks.
  2. Create the Session without ordinary prompt where structured transport is selected.
  3. Wait for readiness, send raw text via structured_prompt, and return direct metadata.
  4. Keep compact ordinary prompt fallback for PTY/Shell with explicit format result fields.
- Acceptance criteria:
  - No ordinary delegation code path changes.
  - Unknown structured delivery errors do not cause duplicate retries.
- Verification method:
  - `cargo test -p agentport-mcp --lib`
  - Focused service/host structured prompt tests if needed.
- Validation evidence: `cargo test -p agentport-mcp --lib` passed 42 tests. Handoff now validates raw Markdown, uses structured_prompt for `json_rpc`, and sends compact PTY fallback through existing send_prompt semantics with explicit result metadata.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Add regression and documentation coverage

- Status: done
- Owner: unassigned
- Objective: Verify raw newline preservation, PTY fallback metadata, and no regression in existing E2E.
- Inputs and prerequisites: T-001.
- Scope or files: MCP unit/E2E tests and `docs/mcp.md`.
- Expected output: Deterministic tests and documented transport behavior.
- Dependencies: T-001.
- Execution steps:
  1. Add unit tests for formatting outcome and raw structured payload.
  2. Extend E2E where a JSON-RPC Agent/fixture can prove preservation; retain Shell fallback assertions.
  3. Document `formatPreserved`, transport, and fallback semantics.
- Acceptance criteria:
  - Tests distinguish preserved formatting from compact fallback.
  - Existing MCP E2E remains green.
- Verification method:
  - `cargo test -p agentport-mcp --lib`
  - `python3 scripts/test-agentport-mcp.py`
  - `git diff --check`
- Validation evidence: `python3 scripts/test-agentport-mcp.py` completed all MCP E2E checks, including PTY fallback transport/format metadata, prompt delivery, pane creation, invalid input, no-document behavior, and cleanup. `docs/mcp.md` documents JSON-RPC preservation and PTY fallback.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Integrated validation, commit, and Debug App delivery

- Status: done
- Owner: coordinator
- Objective: Run complete validation, commit task-only changes, and deliver rebuilt Debug App.
- Inputs and prerequisites: T-001/T-002.
- Scope or files: Task document, task-related source/docs/tests only, debug bundle.
- Expected output: Passing checks, commit, exact GUI path, nonblank screenshot.
- Dependencies: T-001, T-002.
- Execution steps:
  1. Validate task document and inspect diff.
  2. Run MCP/Service/Bridge/frontend/E2E checks.
  3. Commit only task changes; preserve mobile schema.
  4. Restart and verify Debug App through prescribed script and CUA.
- Acceptance criteria:
  - All checks pass and task changes are committed.
- Verification method:
  - Task validator, Rust/frontend checks, E2E, Debug App restart/verification.
- Validation evidence: `cargo test -p agentport-service --lib` passed 73 tests; `cargo check -p agentport-remote-bridge` passed; frontend build and i18n check passed; `cargo test -p agentport-mcp --lib` passed 42 tests; and final MCP E2E passed with PTY fallback assertions. Debug App restart and visual verification are recorded after the final commit.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- `python3 /Users/w/.epi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path docs/tasks/2026-11-22-preserve-handoff-markdown-format-task.md`
- `cargo test -p agentport-mcp --lib`
- `cargo test -p agentport-service --lib`
- `cargo check -p agentport-remote-bridge`
- `python3 scripts/test-agentport-mcp.py`
- Frontend build/i18n check as required by Debug packaging.
- `git diff --check` and final diff review.
- `python3 scripts/restart-debug-app.py`; verify exact executable and nonblank window.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Structured prompts are only accepted for JSON-RPC transport; PTY fallback necessarily loses visual Markdown layout.
- Role preamble length plus raw handoff size can exceed prompt/provider limits; reject or report before unsafe retry.
- Structured delivery is non-idempotent; unknown delivery outcomes must not be replayed automatically.
- Debug App restart must use the prescribed script and must not stop Hosts, Connectors, or release App.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-22: User confirmed JSON-RPC raw Markdown delivery with PTY compact fallback and explicit format result metadata.
- 2026-11-22: Task document created in execute mode; implementation begins with handoff transport selection.
- 2026-11-22: T-001 completed: added raw Markdown validation, JSON-RPC structured_prompt delivery, and PTY compact fallback with explicit format metadata.
- 2026-11-22: T-002 completed: extended PTY E2E assertions and documentation.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: JSON-RPC handoff formatting preservation and PTY fallback metadata are implemented. Core MCP tests, Service tests, Remote Bridge check, frontend build/i18n, and MCP E2E passed. Debug App was rebuilt/signed/restarted and its nonblank rendering verified through CUA.
- Limitations: This host's standard E2E uses Generic Shell/PTY, so raw JSON-RPC formatting was verified by unit-level structured prompt construction and the existing Host/service structured-prompt contract; a live provider-specific JSON-RPC visual test was not available in the bounded E2E. Normal delegation paths remain unchanged.
