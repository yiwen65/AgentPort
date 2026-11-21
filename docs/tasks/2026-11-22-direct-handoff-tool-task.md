# Task Plan: Direct Handoff Delegation Tool

- Created: 2026-11-22
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: User request to add an MCP `handoff` tool equivalent to the handoff-writer skill, but delegate the handoff directly to a split Agent Session instead of writing a document.

<!-- task-doc-section:background-goal -->
## Background and goal

Add a first-class MCP tool named `handoff`. It receives a complete Markdown handoff, compacts it into the single-line prompt format required by AgentPort terminal delegation, creates a new owned Session in a new pane for the explicitly selected Agent, and returns immediately with the same delivery/session metadata as normal delegation. The tool must not create or modify `docs/handoff/` files.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**In scope**

- MCP tool registration, schema, dispatch, direct delegation, prompt compaction/validation, and result metadata.
- Optional project/title/permission/worktree/role parameters compatible with `create_session`; `agent` and Markdown `handoff` are required.
- Dynamic Role metadata exposure for `handoff` when `roleId` is available, preserving explicit model-selected Role behavior.
- E2E and unit regression coverage, MCP documentation, build/test/commit, and Debug App verification.

**Non-goals**

- No writing to `docs/handoff/` or any other handoff file.
- No automatic wait for the delegated Agent's final answer; existing wait tools remain the completion mechanism.
- No new AgentPort Host protocol, raw input path, or Session ownership model.
- No modification to the unrelated `mobile/src-tauri/gen/schemas/acl-manifests.json` change.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Existing `create_session_with_pane` already handles Agent validation, project resolution, Role selection, readiness, prompt delivery, ownership, and pane placement. | `crates/agentport-mcp/src/tools.rs:1226-1515`. |
| F-002 | MCP prompts are bounded to 8 KiB and must be single-line/no ESC/control input because terminal submission semantics require one prompt line. | `crates/agentport-mcp/src/text.rs:74-103`; `ops.rs` delivery path. |
| F-003 | Existing MCP tools return immediately for creation and use `wait_for_task`/wait groups for completion. | `tools.rs` tool registry and wait-group implementation; `docs/mcp.md`. |
| F-004 | Existing delegation always queues a pane and stores MCP ownership before returning. | `tools.rs:create_session_with_pane`, `registry.rs`, and current MCP E2E. |
| F-005 | The handoff-writer skill requires a self-contained handoff covering summary, intent/success criteria, outcomes, decisions/constraints, files/artifacts, commands/evidence, unresolved risks, and recommended continuation. | `/Users/w/.epi/agent/skills/wjskill-handoff-writer/SKILL.md`. |
| F-006 | Repository rules require a verified commit and prescribed Debug App restart/verification, preserving the mobile schema change. | `/Users/w/Projects/AgentSessions/AGENTS.md`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: The caller/model supplies the complete Markdown handoff; MCP cannot infer the current conversation transcript from the JSON-RPC request, so it must not pretend to generate missing context.
- Assumption: Handoff content is compacted by whitespace folding before delivery; headings, labels, paths, evidence, and ordering remain in the prompt while newlines become spaces to satisfy the terminal prompt contract.
- Assumption: The raw handoff and compacted prompt both obey the existing 8 KiB bound; ESC/NUL/control input is rejected through the existing sanitizer.
- Open question: None after the user confirmed Markdown input, required explicit Agent, and immediate return.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `tools/list` advertises `handoff` with a schema requiring `agent` and `handoff` Markdown.
- Calling `handoff` creates an MCP-owned Session, sends the compacted handoff once, queues a split pane, and returns immediately without writing a handoff document.
- The selected Agent is explicit; optional project/title/permission/worktree/role options follow existing delegation semantics.
- Handoff content over 8 KiB, empty content, ESC, NUL, or unsupported control characters returns a structured error before Session creation.
- The result identifies the direct handoff path and whether compaction occurred; completion remains available through existing wait tools.
- Role selection remains explicit/model-owned, and Generic Shell rejects a selected Role as before.
- Existing MCP tool, service, E2E, and delegation behavior remains green.
- The task document validates, task changes are committed, the unrelated mobile schema change remains untouched, and the Debug App is rebuilt/restarted with a nonblank window.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001` tool/schema/implementation → `T-002` tests/docs → `T-003` integrated validation/commit/debug delivery.
- Parallel batches: None; tool registration, dispatch, prompt compaction, E2E expected-tool count, and docs share the same MCP contract.
- Serialization constraints: Keep edits to `tools.rs`, `server.rs`, E2E, and docs serialized; reserve this task document and final commit for the coordinator.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Implement direct handoff MCP tool

- Status: done
- Owner: coordinator
- Objective: Add `handoff` as a direct, immediate-return delegation path reusing existing Session creation and pane ownership behavior.
- Inputs and prerequisites: Existing `create_session_with_pane`, prompt sanitizer, Role metadata tool descriptions, and handoff-writer section contract.
- Scope or files: `crates/agentport-mcp/src/tools.rs`, `crates/agentport-mcp/src/server.rs`, focused MCP tests.
- Expected output: Required `agent`/`handoff` schema, compaction/validation helper, dispatch, direct result metadata, and dynamic Role description coverage.
- Dependencies: None.
- Execution steps:
  1. Add `handoff` to `TOOLS` and its schema.
  2. Fold Markdown whitespace, sanitize/bound the resulting prompt, and delegate through `create_session_with_pane`.
  3. Add `handoff` result metadata without writing files or waiting for completion.
  4. Include enabled Role metadata in the dynamic handoff description when applicable.
- Acceptance criteria:
  - Valid Markdown reaches the new pane once; invalid content fails before side effects.
  - Existing Role, permission, ownership, project, and pane semantics are reused rather than duplicated.
- Verification method:
  - `cargo test -p agentport-mcp --lib`
- Validation evidence: `cargo test -p agentport-mcp --lib` passed 42 tests. The handoff schema, compaction/sanitization helper, immediate direct delegation path, dynamic Role metadata, and invalid-content unit coverage are present.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Add E2E and documentation coverage

- Status: done
- Owner: unassigned
- Objective: Protect tool discovery, direct pane delegation, immediate return, invalid-input behavior, and no-document semantics.
- Inputs and prerequisites: T-001 implementation.
- Scope or files: `scripts/test-agentport-mcp.py`, `docs/mcp.md`, task docs.
- Expected output: E2E handoff scenario and user-facing tool documentation.
- Dependencies: T-001.
- Execution steps:
  1. Add `handoff` to the expected MCP tool set.
  2. Invoke it with a temporary Shell target and compact multi-section Markdown; assert Session/pane/prompt metadata and clean up the Session.
  3. Add invalid handoff coverage and document waiting/return behavior.
- Acceptance criteria:
  - E2E proves direct delegation and cleanup without creating a handoff file.
  - Existing E2E remains green.
- Verification method:
  - `python3 scripts/test-agentport-mcp.py`
  - `git diff --check`
- Validation evidence: `python3 scripts/test-agentport-mcp.py` completed all MCP E2E checks, including handoff Session creation, Prompt delivery, split pane metadata, invalid handoff rejection, no-document assertion, and cleanup. `docs/mcp.md` documents the new tool and wait behavior.
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — Integrated validation, commit, and Debug App delivery

- Status: in_progress
- Owner: coordinator
- Objective: Run the complete required checks, commit task-only changes, and deliver the updated debug application.
- Inputs and prerequisites: T-001 and T-002 done.
- Scope or files: Task document, task-related source/docs/tests only, debug bundle.
- Expected output: Passing tests/build/E2E, task commit, exact debug executable verification, and nonblank screenshot/tree evidence.
- Dependencies: T-001, T-002.
- Execution steps:
  1. Validate this task document and inspect the final diff.
  2. Run MCP, Service, Remote Bridge, frontend/build, and E2E checks.
  3. Commit only task-related changes; preserve mobile schema modification.
  4. Run `python3 scripts/restart-debug-app.py` and verify exact GUI path plus nonblank rendering.
- Acceptance criteria:
  - All required checks pass and all task changes are committed.
  - The unrelated mobile schema change remains untouched/uncommitted.
- Verification method:
  - Task document validator.
  - Focused Rust/frontend tests/build.
  - `python3 scripts/test-agentport-mcp.py`.
  - Prescribed Debug App restart and CUA verification.
- Validation evidence: `cargo test -p agentport-service --lib` passed 73 tests; `cargo check -p agentport-remote-bridge` passed; `npm run build` and `npm run i18n:check` passed; and final MCP E2E passed after adding the handoff scenario. Debug App restart remains for final delivery.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- `python3 /Users/w/.epi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path docs/tasks/2026-11-22-direct-handoff-tool-task.md`
- `cargo test -p agentport-mcp --lib`
- `cargo test -p agentport-service --lib`
- `cargo check -p agentport-remote-bridge`
- Frontend build and i18n check (unless no frontend files are touched, still ensure the existing build remains available for Debug App packaging).
- `python3 scripts/test-agentport-mcp.py`
- `git diff --check` and final diff review.
- `python3 scripts/restart-debug-app.py`; verify exact executable path and populated nonblank window.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Markdown compaction can reduce readability; preserve section labels and ordering, and report `compacted=true` so the caller knows the transport representation changed.
- Handoff contents may contain user-provided ESC/control data; sanitize before any Session creation and do not retry unknown delivery outcomes.
- Direct delegation must not accidentally wait synchronously or create a document; reuse `create_session_with_pane` and add a focused E2E assertion.
- Existing 8 KiB prompt and role preamble limits can make a valid handoff plus selected Role too large; return the existing structured invalid-prompt error before typing.
- The final Debug App restart must use the prescribed script and must not stop Hosts, Connectors, or the release App.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-22: User confirmed Markdown input, explicit Agent selection, immediate return, direct split-pane delegation, and no handoff document output.
- 2026-11-22: Task document created in execute mode; implementation begins with MCP tool contract.
- 2026-11-22: T-001 completed: registered `handoff`, added Markdown compaction/validation, and reused existing direct Session/pane delegation.
- 2026-11-22: T-002 completed: added E2E coverage for delivery, pane creation, invalid input, no-document behavior, cleanup, and MCP documentation.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: not_run
- Evidence: Not run.
- Limitations: Implementation, integrated validation, commit, and Debug App delivery are incomplete.
