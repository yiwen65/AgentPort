# Task Plan: Task issue and pull request management

- Created: 2026-11-22
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: User request: add issue creation/status management and pull request creation/review management to Task Hub.

<!-- task-doc-section:background-goal -->
## Background and goal

Complete the missing write workflows in the provider-aware Task Hub. GitHub and GitLab users must be able to create issues and pull/merge requests, change issue/request state, and perform supported pull/merge-request review or approval actions. Writes remain device-local through `gh`/`glab`, use the existing read-back/unknown-outcome contract, and remain unavailable to mobile.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### In scope

- GitHub Issues: create, open/close/reopen state changes.
- GitLab Issues: create, open/close/reopen state changes.
- GitHub Pull Requests: create, approve, request changes, comment review, and retain existing merge/state actions.
- GitLab Merge Requests: create, approve/unapprove where the provider supports it, comment review, and retain existing merge/state actions; unsupported review events are explicit.
- Desktop Task Hub composer and detail actions with validation, loading, failure, conflict, and unknown-outcome states.
- Remote task mutation compatibility using the same provider-neutral payload and target-local credentials.
- Focused provider normalization tests, contract tests, frontend build/tests, debug rebuild and live UI verification.

### Non-goals

- OAuth/account-center work or credential transmission over Remote.
- Mobile mutation controls; mobile remains read-only.
- Bulk task creation or batch state/review operations.
- Replacing the existing provider detection or Task Hub layout beyond the controls needed for these workflows.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Desktop Task Hub already lists GitHub/GitLab tasks and loads issue/PR/MR details, but renders no mutation controls. | `src/src/components/TaskCenter.tsx` detail panel contains read-only provider detail and no mutation calls. |
| F-002 | GitHub desktop mutations already support comments, state, labels, assignees, reviews, merge, and Projects, but no create operation. | `src-tauri/src/github_tasks.rs` `execute_github_mutation`; `GithubTaskMutationRequest`. |
| F-003 | GitLab desktop mutations already support comments, state, labels, assignees, merge, and board moves, but no create/review operation. | `src-tauri/src/gitlab_tasks.rs` `mutate_gitlab_task_blocking`. |
| F-004 | Remote `task.mutate` is registered as a non-retryable write and executes against the owning device. | `crates/agentport-remote-protocol/src/lib.rs`, `crates/agentport-service/src/lib.rs`, `crates/agentport-remote-bridge/src/lib.rs`. |
| F-005 | Provider credentials are device-local and the unrelated generated mobile schema file is already dirty. | Existing repository instructions and `git status --short`; do not include `mobile/src-tauri/gen/schemas/acl-manifests.json`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “PR” includes GitHub Pull Requests and GitLab Merge Requests, with provider-specific terminology shown in the UI.
- Assumption: GitHub review events are `APPROVE`, `REQUEST_CHANGES`, and `COMMENT`; GitLab exposes approve/unapprove and comment review, while unsupported request-changes behavior is reported explicitly.
- Assumption: New-task forms require title and description; PR/MR creation additionally requires source/head and target/base branches. Labels/assignees are optional follow-up fields where the provider accepts them.
- Open question: None blocking; provider limitations must remain explicit in capabilities/errors rather than hidden behind a guessed action.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- GitHub and GitLab desktop users can create an issue and change its open/closed state.
- GitHub users can create a Pull Request and submit approve/request-changes/comment review actions.
- GitLab users can create a Merge Request and submit supported approve/unapprove/comment review actions; unsupported actions show a clear provider error.
- Every mutation validates inputs, never serializes credentials, and reports confirmed read-back or an explicit unknown outcome.
- The Task Hub exposes these controls without restoring an explicit provider switch and preserves detection/stale/error states.
- Remote `task.mutate` accepts the new operation payloads and still executes on the target device without automatic retry.
- Existing focused Rust/TypeScript checks pass; the debug App is rebuilt with the updated embedded frontend and visually verified.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 provider request/operation contract and backend writes → T-002 Remote service compatibility → T-003 Task Hub composer/actions → T-004 validation, rebuild, and delivery.
- Parallel batches: T-001 is coordinator-owned and serialized because GitHub/GitLab request shapes are shared; T-002 and T-003 depend on T-001 and touch shared contracts/UI integration, so they are serialized in this workspace; T-004 runs last.
- Serialization constraints: `GithubTaskMutationRequest`, `GitlabTaskMutationRequest`, `TaskCenter.tsx`, and service dispatch must not be edited concurrently. Preserve the unrelated mobile schema modification.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Add create/state/review provider mutations

- Status: done
- Owner: coordinator
- Objective: Extend GitHub/GitLab mutation requests and bounded provider commands for issue/PR/MR creation, state changes, and supported review actions with authoritative read-back.
- Inputs and prerequisites: F-001–F-005; current provider mutation implementations and local CLI credential boundary.
- Scope or files: `src-tauri/src/github_tasks.rs`, `src-tauri/src/gitlab_tasks.rs`, `src/src/types.ts`, `src/src/api.ts`.
- Expected output: Validated operation payloads, provider endpoints, explicit unsupported/failed/unknown outcomes, and focused tests.
- Dependencies: None.
- Execution steps:
  1. Add create fields and provider operation validation.
  2. Implement GitHub issue/PR create and GitLab issue/MR create.
  3. Implement GitLab review operations and normalize state/review read-back.
  4. Add parser/normalization/mutation contract tests.
- Acceptance criteria:
  - No write reports success without a fresh provider read or returns unknown when read-back is inconclusive.
  - Inputs are bounded and provider-specific limitations are explicit.
- Verification method:
  - `cargo test -p agentport --bin agentport github_tasks`
  - `cargo test -p agentport --bin agentport gitlab_tasks`
  - `cargo check -p agentport --bin agentport`
- Validation evidence: `cargo test -p agentport --bin agentport github_tasks` (4 passed); `cargo test -p agentport --bin agentport gitlab_tasks` (3 passed); `cargo check -p agentport --bin agentport` passed. Creation/review argument helpers and bounded field validation are covered; live provider writes remain unexecuted.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Keep Remote task writes compatible

- Status: done
- Owner: coordinator
- Objective: Ensure Remote service task mutation dispatch uses the new payload fields and provider-local create/review endpoints without credential leakage or retries.
- Inputs and prerequisites: T-001 request fields and operation names.
- Scope or files: `crates/agentport-service/src/lib.rs`, protocol/bridge tests if contract changes are needed, `src/src/remote/backend.ts` only if TypeScript payload typing requires it.
- Expected output: Target-local Remote create/review/state mutations with the existing `task.write` capability and unknown-outcome semantics.
- Dependencies: T-001.
- Execution steps:
  1. Audit service payload extraction and endpoint mapping.
  2. Add only required fields/operations; keep credential rejection and non-retry classification.
  3. Add focused service/protocol tests.
- Acceptance criteria:
  - Remote writes use the target checkout and never send credentials.
  - New non-idempotent operations are never automatically retried.
- Verification method:
  - `cargo test -p agentport-service task`
  - `cargo test -p agentport-remote-protocol task`
  - Remote credential contract tests.
- Validation evidence: `cargo check -p agentport-service` passed; protocol remains `NonIdempotentWrite` and credential rejection path is preserved. No live Remote provider write was executed.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Add Task Hub management controls

- Status: done
- Owner: coordinator
- Objective: Add create composer, state controls, PR/MR review actions, busy/error/unknown feedback, and refresh/read-back behavior without a provider switch.
- Inputs and prerequisites: T-001 operation names and T-002 local/Remote API compatibility.
- Scope or files: `src/src/components/TaskCenter.tsx`, `src/src/types.ts`, `src/src/api.ts`, `src/src/styles.css`, focused frontend tests.
- Expected output: Usable desktop controls for issue/PR/MR management with provider-aware labels and validation.
- Dependencies: T-001, T-002.
- Execution steps:
  1. Add provider-aware create dialog/form.
  2. Add issue state controls and PR/MR review actions to detail.
  3. Wire local and Remote mutations, refresh selected scope, and surface unknown outcomes.
  4. Add focused UI/contract coverage.
- Acceptance criteria:
  - No mutation control appears while provider detection is pending or unsupported.
  - Form validation prevents empty/oversized required fields.
  - Successful actions refresh authoritative data; failed/unknown actions remain visible.
- Verification method:
  - `npm run build -- --mode test`
  - `npm test -- --run taskTypes.test.ts`
  - Focused Task Hub test if added.
- Validation evidence: `npm run build -- --mode test` passed; focused `npm test -- --run taskTypes.test.ts` passed; fresh Debug App screenshots show GitLab New issue/Close Issue/comment controls and New merge request/Approve/review controls.
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — Integrate, rebuild, and deliver

- Status: blocked
- Owner: coordinator
- Objective: Run dependency-path checks, rebuild the signed Debug App, verify live GitHub and GitLab management states, and commit only related changes.
- Inputs and prerequisites: T-001–T-003.
- Scope or files: task document, related source/tests, debug bundle; exclude mobile schema artifact.
- Expected output: Verified management workflows and a clean task-related commit with the Debug App open.
- Dependencies: T-001, T-002, T-003.
- Execution steps:
  1. Run diff/security/scope review and task document validation.
  2. Run Rust/frontend/Remote tests and build.
  3. Run `python3 scripts/restart-debug-app.py` and verify process path plus live Task Hub screenshot.
  4. Commit task changes and record residual limitations.
- Acceptance criteria:
  - All required checks pass or residual failures are explicitly unrelated and documented.
  - Debug App embeds the new UI and renders nonblank.
- Verification method:
  - Repository Rust/frontend/Remote checks, `git diff --check`, task validator, process-path check, CUA screenshot.
- Validation evidence: Debug App rebuilt with `python3 scripts/restart-debug-app.py`; exact GUI process path verified and fresh nonblank CUA screenshots captured. Local desktop management controls are live. The TaskCenter still calls provider-specific local API methods and is not yet normalized onto generic Remote task routing, so full Remote UI parity is not claimed.
- Blocker: Generic Remote Task Hub routing/normalization and live provider write read-back remain outside this patch.
- Unblock condition: Add RemoteBackend provider-specific adapters or route TaskCenter through `task.list`/`task.detail`/`task.mutate`, then validate on a remote device.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Provider: focused Rust mutation/normalization tests, `cargo check -p agentport --bin agentport`.
- Remote: protocol/service credential and retry classification tests.
- Frontend: TypeScript/Vite build and focused Task Hub/type tests.
- Integration: `git diff --check`, task document validator, signed Debug App rebuild, exact process path, fresh CUA screenshot.
- Security: inspect mutation payloads and remote frames for credential-shaped fields; preserve device-local `gh`/`glab` execution.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Provider APIs differ: GitLab request-changes is not equivalent to GitHub review events; unsupported operations must remain explicit.
- Create and review writes are non-idempotent and must not be automatically retried; timeouts can produce unknown outcomes.
- Branch names, body/title length, labels, and assignee identifiers need bounded validation before invoking CLIs.
- The existing unrelated mobile schema modification must remain outside the commit.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-22: Task document created in execute mode; T-001 started by coordinator after auditing existing provider mutation paths.
- 2026-11-22: T-001 and T-002 implementation completed and focused Rust/service checks passed; T-003 UI controls are now in progress.
- 2026-11-22: T-003 completed with frontend build, focused test, and live Debug App verification; T-004 blocked on generic Remote Task Hub routing parity.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: Local desktop provider creation/state/review mutations compile and the live Task Hub exposes management controls; Remote generic Task Hub routing and live provider write verification remain blocked.
- Limitations: No live create/approve write was sent to GitHub/GitLab during validation; mobile remains read-only; the unrelated mobile schema change is not included.
