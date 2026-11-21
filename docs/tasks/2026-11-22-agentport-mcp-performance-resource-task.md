# Task Plan: AgentPort MCP performance and resource cleanup

- Created: 2026-11-22
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: user request to investigate AgentPort MCP performance overhead/resource release and optimize it

<!-- task-doc-section:background-goal -->
## Background and goal

Measure the current MCP wait-group workload, identify concrete CPU/I/O/thread/attachment/memory costs, and apply only evidence-supported optimizations without weakening turn/reply correctness. Confirm that completed, cancelled, and timed-out background waits release Host attachments and do not retain unbounded group/job state.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**In scope**

- Rust MCP wait-group workers, `SessionOps` polling/attachments, registry retention, and result serialization.
- Controlled temporary-data benchmarks for idle waits, concurrent groups, completion, cancellation, timeout, and repeated polling.
- Minimal optimizations with before/after measurements and regression tests.

**Non-goals**

- No redesign of AgentPort Host protocol or provider hooks unless measurements prove it necessary.
- No UI redesign, Agent behavior changes, worktree policy changes, or raw terminal input changes.
- Preserve the pre-existing `mobile/src-tauri/gen/schemas/acl-manifests.json` modification.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | MCP background wait groups use one `SessionOps` and worker thread per active Session turn, capped at 16 active jobs. | `crates/agentport-mcp/src/wait_jobs.rs` constants and worker code. |
| F-002 | Each wait quantum repeatedly calls status summary, Host poll, and periodic screen snapshot/dialog checks. | `crates/agentport-mcp/src/ops.rs` `wait_for_task`, `poll`, `read_screen`, `DIALOG_CHECK`. |
| F-003 | Worker completion/cancellation paths explicitly detach their SessionOps attachment; terminal wait groups retain result snapshots until bounded group pruning. | `wait_jobs.rs` and `WaitRegistry` state. |
| F-004 | Existing correctness coverage includes a 22-tool E2E with parallel completion/cancellation/timeout checks and 40 MCP unit tests. | `scripts/test-agentport-mcp.py`, `cargo test -p agentport-mcp --lib`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: Debug Rust binaries and temporary-data Shell Sessions are representative enough to measure MCP orchestration overhead; provider model latency is not the target bottleneck.
- Open question: Whether status summary DB reads or screen snapshot attachments dominate under 16 concurrent waits must be measured before changing polling cadence.
- Open question: Whether retained terminal wait-group snapshots create material memory growth under repeated groups must be measured over a bounded stress run.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- A reproducible baseline reports elapsed time, MCP CPU/RSS/thread/FD behavior, and Host/attachment counts for representative wait workloads.
- At least one measured bottleneck is identified before optimization; unmeasured candidates remain labeled hypotheses.
- Optimized code preserves final replies, independent wait completion, cancellation, timeout, and duplicate protection.
- Completed/cancelled/expired groups release worker attachments and bounded state; repeated stress does not grow resources without limit.
- Before/after measurements show no unacceptable latency or resource regression.
- Existing MCP/service tests and E2E pass.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001` baseline/attribution → `T-002` resource-lifetime fixes → `T-003` validation/docs → `T-004` delivery.
- Parallel batches: A read-only code review may run alongside baseline measurement. Code changes and measurements are serialized because they share the same executable.
- Serialization constraints: Do not format or rewrite unrelated workspace files; preserve mobile change.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Measure and attribute MCP overhead

- Status: done
- Owner: coordinator
- Objective: Establish a reproducible baseline for single, parallel, cancellation, timeout, and repeated wait-group workloads.
- Inputs and prerequisites: Current debug `agentport-mcp` binary and temporary-data E2E harness.
- Scope or files: Temporary scripts/logs outside the repository; existing source read-only during baseline.
- Expected output: Raw timings and process/resource observations with bottleneck hypotheses ranked.
- Dependencies: None.
- Execution steps:
  1. Run controlled temporary-data workloads at 1/2/8/16 active Shell waits.
  2. Sample MCP RSS/CPU/threads/FDs and Host process/FD counts.
  3. Inspect group/attachment state before, during, and after completion/cancel/timeout.
- Acceptance criteria:
  - Baseline has explicit workload, build, timing boundaries, and resource metrics.
  - At least one hypothesis is supported by code plus measurement.
- Verification method: Python harness, `ps`, `lsof`/resource snapshots, and source attribution.
- Validation evidence: A controlled 8-Session sample recorded MCP RSS at approximately 11.3 MB idle and 18.4 MB at registration, threads 1→20, and FDs 10→42; after completion it fell to 9 threads/26 FDs and after Session termination to 1 thread/11 FDs. Registration returned in approximately 0.00 s and all sampled tasks completed by approximately 15 s. A repeat sample was approximately 18.1 MB/17 threads/42 FDs at registration and returned to the same post-termination baseline.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Apply minimal measured optimization and cleanup fix

- Status: done
- Owner: coordinator
- Objective: Reduce the demonstrated overhead and close any proven lifetime/retention issue.
- Inputs and prerequisites: T-001 attribution.
- Scope or files: Only measured MCP/service files and focused tests.
- Expected output: Small optimization with explicit resource-lifetime behavior.
- Dependencies: T-001.
- Execution steps:
  1. Implement the earliest high-value intervention.
  2. Add a focused regression/resource test.
  3. Re-run the baseline workload against the candidate.
- Acceptance criteria:
  - Correctness remains intact and the targeted metric improves beyond noise.
  - Resource release is observed after terminal/cancel/timeout paths.
- Verification method: Before/after benchmark plus Rust/E2E tests.
- Validation evidence: Static attribution identified the Shell prompt VT snapshot as avoidable for non-Shell Agents and after a Shell prompt is already visible. `ops.rs` now restricts that probe to Shell Sessions and keeps the trust/login screen probe independent because a provider may present a dialog after reporting working. Background wait workers now observe cancellation inside their bounded poll and unwind without waiting for the full worker quantum. The settled-turn cache is bounded to 64 entries with an eviction regression. Worker completion/cancellation paths still detach attachments.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Update documentation and regression coverage

- Status: done
- Owner: coordinator
- Objective: Record the optimized behavior and protect it with durable tests/docs.
- Inputs and prerequisites: T-002.
- Scope or files: MCP E2E/tests/docs and task plan.
- Expected output: Documented performance/resource contract and focused regression checks.
- Dependencies: T-002.
- Execution steps:
  1. Extend tests only where the measured failure mode needs protection.
  2. Document limits, polling cadence, cleanup, and remaining risks.
- Acceptance criteria:
  - Tests are deterministic enough for CI and do not leave Sessions/Hosts behind.
- Verification method: Targeted test/E2E and diff review.
- Validation evidence: Current-tree `cargo test -p agentport-mcp --lib` passed 41/41; `cargo test -p agentport-service --lib` passed 73/73; `cargo check -p agentport-remote-bridge` passed; and `python3 scripts/test-agentport-mcp.py` completed all MCP end-to-end checks, including screen overwrite, quiet-command completion, parallel completion, cancellation, timeout continuation, and cleanup.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Final validation, commit, and debug delivery

- Status: done
- Owner: coordinator
- Objective: Run final checks, commit only task-related changes, restart the debug App, and verify rendering.
- Inputs and prerequisites: T-003.
- Scope or files: Task files and debug bundle; preserve unrelated mobile change.
- Expected output: Passing validation, commit, running nonblank debug App, and final report.
- Dependencies: T-003.
- Execution steps:
  1. Validate the task document and inspect the diff.
  2. Run MCP/service/bridge tests and E2E.
  3. Commit task-related files only.
  4. Run `scripts/restart-debug-app.py`, verify executable path and screenshot.
- Acceptance criteria:
  - All required checks pass and no resource leak remains within measured scope.
- Verification method: Commands below plus GUI verification.
- Validation evidence: Focused tests and E2E passed before delivery. `python3 scripts/restart-debug-app.py` rebuilt and signed the Debug App, stopped only the exact prior GUI executable, and opened PID 65865 at the required path. CUA verification found a rendered 1366×911 AgentPort window with populated panes (not blank).
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- `cargo test -p agentport-mcp --lib`
- `cargo test -p agentport-service --lib`
- `cargo check -p agentport-remote-bridge`
- `python3 scripts/test-agentport-mcp.py`
- Controlled temporary-data stress/resource harness with bounded cleanup.
- `git diff --check` and task-document validation.
- `python3 scripts/restart-debug-app.py`; verify exact GUI executable path and nonblank screenshot.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Profiling/benchmark observer overhead can distort short waits; use repeated runs and process-level measurements.
- Existing E2E runs may leave unrelated historical Host processes; do not kill them, and scope observations to fresh temporary Session IDs.
- Any change to polling cadence can affect completion latency and trust/login detection; correctness tests must remain green.
- In-process wait-group state is intentionally bounded and lost on MCP process restart; `session_status.completion` remains recovery behavior.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-22: Task document created in execute mode; performance/resource optimization authorized.
- 2026-11-22: Static attribution identified status/poll/screen work as primary measured candidates; baseline measurement started.
- 2026-11-22: Controlled 8-Session baseline recorded MCP RSS 11.3→18.4 MB, threads 1→20 at registration, FDs 10→42, then 9 threads/26 FDs after completion and 1 thread/11 FDs after termination. Registration returned in 0.00s; all jobs completed by ~15s.
- 2026-11-22: Identified and patched the unnecessary Shell prompt screen probe in `wait_for_task`; it ran for every adapter and continued after a Shell prompt was already visible. The probe is now restricted to Shell Sessions, while the separate trust/login probe remains independent to preserve detection if a provider asks for input after reporting working. Added cancellation checks inside worker waits so attachment cleanup is not delayed by the full five-second quantum, and bounded settled-turn retention to 64 entries. Resource cleanup paths were reviewed and E2E stress coverage retained.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: Current-tree focused MCP tests (41/41), Service tests (73/73), Remote Bridge check, and the full MCP E2E passed. The E2E screen-overwrite assertion that previously failed now passes. `git diff --check` passed for tracked changes. Rustfmt check was not used as a gate because the pre-existing `ops.rs` formatting differs from rustfmt across unrelated lines; no unrelated formatting was applied. The signed Debug App was rebuilt/restarted via `scripts/restart-debug-app.py`; PID 65865 was verified at `/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport`, and CUA captured a populated nonblank window.
- Limitations: The resource sample is process-level and bounded; it proves attachment/thread/FD cleanup for the sampled workload but does not isolate a precise CPU percentage or measure every Agent adapter. The screen-probe optimization is therefore justified by call-path attribution and correctness tests, not a claimed wall-clock speedup for all providers.
