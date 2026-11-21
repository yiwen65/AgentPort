# Task Plan: Nonblocking parallel MCP waits

- Created: 2026-11-21
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: user request to implement true nonblocking parallel coordination for multiple delegated Agents

<!-- task-doc-section:background-goal -->
## Background and goal

The MCP can already launch multiple delegated Sessions whose Host processes execute concurrently, but `wait_for_tasks` currently waits for items serially inside the synchronous stdio request handler. A slow Agent can therefore block the transport and make later status/output calls queue behind it. Implement a bounded background wait-group facility so multiple turn waits are registered immediately, monitored concurrently, and queried without blocking the MCP transport. Preserve the existing synchronous wait tools for compatibility.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**In scope**

- Add nonblocking `start_wait_group`, `get_wait_group`, and `cancel_wait_group` MCP tools.
- Run one bounded background waiter per registered Session turn, using existing Hook/Adapter/lifecycle/reply evidence and prompt baselines.
- Return independent per-Session states and final replies, with completion events cached for recovery.
- Keep existing `wait_for_task` / `wait_for_tasks` behavior compatible.
- Add unit/E2E coverage and update MCP documentation/instructions.

**Non-goals**

- Do not replace AgentPort's existing Host status journal or provider hooks.
- Do not require Agents to emit an extra model/tool call for completion.
- Do not change ownership, permissions, panes, transcript formats, or Session lifecycle policy.
- Do not terminate user Sessions or unrelated Host processes.
- Do not modify the pre-existing `mobile/src-tauri/gen/schemas/acl-manifests.json` change.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Agent execution is already concurrent after Session creation, but `wait_for_tasks` processes items serially. | `crates/agentport-mcp/src/tools.rs` loops through `self.wait_for_task`; previous E2E and source inspection. |
| F-002 | The stdio transport handles one request at a time. | `crates/agentport-mcp/src/main.rs` reads one line, calls `Server::handle_line`, then writes one response. |
| F-003 | Hook/Adapter completion events and native transcript replies already exist. | `crates/agentport-mcp/src/ops.rs` and observed easy-pi `idle/adapter` plus final `reply`. |
| F-004 | A 45-second synchronous wait is the safe compatibility ceiling for the observed 60-second client deadline. | `c9efff3` and controlled `sleep 50` reproduction: oversized wait returned structured continuation at ~45 seconds. |
| F-005 | `RemoteService` is implemented by `CoreService` with thread-safe DB/attachment internals, but the trait object currently has no explicit Send/Sync bound. | `crates/agentport-service/src/lib.rs` `CoreService` and `RemoteService` definitions. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: The background wait facility may use one worker thread per active MCP-owned Session, bounded by the existing 16 live-Session limit plus a small job cap; cancellation is checked between short wait quanta.
- Assumption: The first compatible implementation can keep wait-group state in the MCP process; existing `session_status.completion` remains the recovery path after MCP restart.
- Open question: Whether every external MCP client will consume server progress notifications is unknown; therefore the primary portable API will expose nonblocking result polling, with notifications deferred to a later compatibility layer.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `start_wait_group` returns immediately without waiting for any Agent turn.
- Multiple Sessions in one group are monitored concurrently; one slow Session does not delay another completed result.
- `get_wait_group` returns per-item `waiting`, `needs_input`, `completed`, `failed`, `cancelled`, or `timeout` states and includes the final reply when completed.
- `cancel_wait_group` stops all group workers without terminating Agent Sessions.
- Duplicate waits for the same Session/turn are coalesced or rejected deterministically.
- Existing synchronous MCP tests and E2E behavior remain passing.
- New tests demonstrate nonblocking registration, independent completion, cancellation, and final reply delivery.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001` (job model and worker plumbing) → `T-002` (tool schemas/dispatch and integration) → `T-003` (tests/docs) → `T-004` (full validation and debug App restart).
- Parallel batches: No implementation tasks are parallel-ready because the central `Toolbox`, protocol registry, and shared tests overlap. A read-only design review may run in parallel with `T-001`.
- Serialization constraints: Changes to `tools.rs`, `protocol.rs`, `server.rs`, and MCP tests are serialized. The pre-existing mobile schema modification is excluded from all tasks.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Add bounded background wait-group state and worker execution

- Status: done
- Owner: coordinator
- Objective: Implement thread-safe in-process wait-group/job state and background waiters that preserve turn baselines and resolve final replies.
- Inputs and prerequisites: F-001 through F-005; existing `SessionOps::wait_for_task` and prompt-fence storage.
- Scope or files: `crates/agentport-mcp/src/tools.rs`, `crates/agentport-mcp/src/ops.rs`, and only necessary service trait bounds.
- Expected output: Internal job registry, worker lifecycle, result serialization helper, cancellation and duplicate/coalescing behavior.
- Dependencies: None.
- Execution steps:
  1. Define bounded job/group state and a stable ID generator.
  2. Register each owned Session turn without blocking the transport.
  3. Spawn bounded workers using short wait quanta and existing completion/reply evidence.
  4. Store terminal outcomes and cancellation state for later reads.
- Acceptance criteria:
  - Registration returns immediately.
  - Workers can complete independently and return final replies.
  - Cancellation is cooperative and does not stop Agents.
- Verification method:
  - Targeted unit tests plus controlled temporary-data concurrency test.
- Validation evidence: `cargo test -p agentport-mcp --lib` passed (40 tests); controlled E2E registered a group in 0.00s, completed fast/slow workers independently, rejected duplicate Session waits, and exercised cancellation/deadline cleanup.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Expose nonblocking MCP tools and compatibility instructions

- Status: done
- Owner: coordinator
- Objective: Add `start_wait_group`, `get_wait_group`, and `cancel_wait_group` schemas/dispatch and describe the portable polling contract.
- Inputs and prerequisites: T-001.
- Scope or files: `crates/agentport-mcp/src/tools.rs`, `crates/agentport-mcp/src/protocol.rs`, `crates/agentport-mcp/src/server.rs` only if needed.
- Expected output: Tool definitions, validation, per-item result shape, and no blocking in the new calls.
- Dependencies: T-001.
- Execution steps:
  1. Add schemas and descriptions.
  2. Dispatch calls to the job registry.
  3. Verify ownership, bounded task count, and stable result serialization.
- Acceptance criteria:
  - New tools appear in `tools/list`.
  - Calls return within the transport request budget independent of Agent duration.
  - Existing tools remain backward compatible.
- Verification method: MCP unit/protocol tests and temporary-data smoke test.
- Validation evidence: `tools/list` reports 22 tools; `scripts/test-agentport-mcp.py` passed registration, polling, cancellation, timeout, and legacy synchronous checks.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Add regression coverage and documentation

- Status: done
- Owner: coordinator
- Objective: Prevent serial-wait regressions and document how coordinators use the new group API.
- Inputs and prerequisites: T-002.
- Scope or files: `crates/agentport-mcp/src/ops.rs`, `crates/agentport-mcp/src/tools.rs`, `scripts/test-agentport-mcp.py`, `docs/mcp.md`.
- Expected output: Tests for independent completion/cancellation/reply and clear usage docs.
- Dependencies: T-002.
- Execution steps:
  1. Add deterministic unit tests for job state transitions.
  2. Extend temporary-data E2E with multiple slow/fast Shell tasks.
  3. Document timeout, cancellation, and reply semantics.
- Acceptance criteria:
  - Tests prove a slow item does not delay a completed item result query.
  - E2E cleanup leaves no task-owned resources.
- Verification method: Targeted Rust tests and Python E2E.
- Validation evidence: 40 MCP unit tests passed after the wait-registry duplicate test; Python E2E passed with 22-tool discovery and all new wait-group assertions; `docs/mcp.md` and protocol instructions document polling states.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Validate, package, and deliver

- Status: done
- Owner: coordinator
- Objective: Run final checks, commit only task-related changes, rebuild/restart the debug App, and verify the window.
- Inputs and prerequisites: T-003.
- Scope or files: validation outputs and debug bundle only; preserve unrelated mobile change.
- Expected output: Passing checks, commits, running debug App with nonblank window, and final report.
- Dependencies: T-003.
- Execution steps:
  1. Validate the task document and inspect the diff.
  2. Run MCP tests, E2E, and relevant build checks.
  3. Commit task files only.
  4. Run `scripts/restart-debug-app.py`, verify executable path and screenshot.
- Acceptance criteria:
  - All required tests pass.
  - Task document validates with all tasks done.
  - Only task-related files are committed.
- Verification method: Commands listed in the validation plan and GUI observation.
- Validation evidence: `cargo test -p agentport-mcp --lib` passed (40 tests); `cargo test -p agentport-service --lib` passed (73 tests); `cargo check -p agentport-remote-bridge` passed; `python3 scripts/test-agentport-mcp.py` passed with 22 tools and nonblocking group assertions; `git diff --check` passed; commit `fd1c888` created task changes. Debug bundle was rebuilt/signed/restarted and exact GUI path plus nonblank screenshot were verified.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- `cargo test -p agentport-mcp --lib`
- `cargo build -p agentport-mcp`
- `python3 scripts/test-agentport-mcp.py`
- A controlled temporary-data Python harness that starts two Shell Sessions, registers one wait group, confirms immediate return, observes independent completion, and cancels the remaining job.
- `git diff --check` and task-document validation.
- `python3 scripts/restart-debug-app.py`; verify the exact GUI executable path with `ps` and a nonblank screenshot.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Background workers increase concurrent Host attachments and service calls; cap active jobs and use short polling quanta.
- A process crash loses in-memory wait groups; `session_status.completion` remains the recovery path, and durable cross-process jobs are explicitly out of scope for this iteration.
- Clients that do not understand future MCP notifications will still use `get_wait_group` polling; no notification-only contract is required for acceptance.
- Shared worktrees can still conflict when Agents edit the same files; nonblocking coordination does not make dependent tasks independent.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-21: Task document created in execute mode; implementation authorized by user.
- 2026-11-21: Scope selected as portable nonblocking wait-group polling with bounded background workers; preserve synchronous compatibility tools.
- 2026-11-21: T-001 implementation started; worker state is isolated from the synchronous Toolbox attachment cache.
- 2026-11-21: T-001/T-002/T-003 implemented; nonblocking wait-group E2E and registry duplicate test passed.
- 2026-11-21: Final validation passed; commit `fd1c888` created and debug GUI restarted/verified.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: All required task tests, E2E, service/bridge checks, diff check, task-document validation, commit, and debug GUI verification passed.
- Limitations: Wait groups are in-process and portable polling; an MCP process restart loses active wait-group handles, while `session_status.completion` remains the recovery path. The pre-existing mobile schema modification remains uncommitted.
