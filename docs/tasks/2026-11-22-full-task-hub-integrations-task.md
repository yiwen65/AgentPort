# Task Plan: Full AgentPort task hub and provider integrations

- Created: 2026-11-22
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: Confirmed user contract: one-shot full implementation of Orca-like three-column Task Hub, GitHub+GitLab desktop/remote write capabilities, and mobile read-only task surfaces.

<!-- task-doc-section:background-goal -->
## Background and goal

Replace the initial compact GitHub Task Center with a full-screen AgentPort Task Hub. The hub must feel native to AgentPort: dark graphite surfaces, electric-blue focus, restrained status colors, terminal-compatible density, and high-quality typography/layout. Implement the confirmed GitHub and GitLab task workflow end-to-end: list/detail, comments, status, labels, assignees, reviews, checks, merge, Projects/Boards editing, device-local credentials, Remote execution on the owning device, and mobile read-only summary/detail/deep links.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### In scope

- Full-screen three-column Task Hub: source/provider navigation, list/board center, detail/review drawer.
- GitHub Issues/PRs/Projects and GitLab Issues/MRs/Boards.
- Desktop read/write operations with authoritative read-back and explicit unknown outcomes.
- Remote protocol/service/bridge/desktop routing and capability gates for task reads/writes.
- Mobile read-only task summary/detail/deep links; no mutation controls.
- Device-local `gh`/`glab` credentials only.

### Non-goals

- Linear/Jira providers.
- OAuth account-center implementation.
- Storing external credentials or task data in AgentPort SQLite, logs, backups, or remote frames.
- Changing local Project/Session/Worktree ownership semantics.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Existing read-only GitHub Task Center is in `c9e3d9b`; GitLab discovery/provider contracts are in `df45db2`. | `src/src/components/TaskCenter.tsx`, `src-tauri/src/github_tasks.rs`, `src-tauri/src/gitlab_tasks.rs`, commits |
| F-002 | Remote methods are an explicit registry with retry classification and mobile allowlist. | `crates/agentport-remote-protocol/src/lib.rs` |
| F-003 | Desktop remote calls route through `RemoteBackend` and service extended facade. | `src/src/remote/backend.ts`, `crates/agentport-service/src/lib.rs` |
| F-004 | Mobile has typed remote APIs and feature surfaces under `mobile/src/features`. | `mobile/src/features/git`, `mobile/src/remote` |
| F-005 | Existing unrelated mobile schema change must be preserved uncommitted. | `git status --short`: `mobile/src-tauri/gen/schemas/acl-manifests.json` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption accepted by user: use device-local `gh`/`glab` credentials rather than OAuth.
- Assumption accepted by user: desktop and remote writes are enabled after explicit confirmation; mobile remains read-only.
- Assumption: provider-specific API gaps are surfaced as capabilities/errors rather than hidden behind untyped behavior.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- [ ] Task Hub is full-screen and uses the confirmed three-column graphite/electric-blue design with responsive collapse behavior.
- [ ] GitHub and GitLab lists/detail views work with explicit loading, stale, partial, auth, rate-limit, and unavailable states.
- [ ] Desktop supports confirmed task mutations, comments, review/checks/merge, and Projects/Boards edits with read-back/unknown outcome handling.
- [ ] Remote methods execute on the target device, are allowlisted/capability-gated, and never transmit credentials.
- [ ] Mobile provides read-only task summary/detail/deep links and cannot invoke mutations.
- [ ] Existing AgentPort Project/Session/Git Center behavior remains intact; unrelated mobile schema change stays out of commits.
- [ ] Targeted checks pass, the debug App rebuilds and renders, and a scoped commit is created.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 UI foundation and T-002 provider operations can proceed independently; T-003 remote protocol depends on provider DTOs; T-004 mobile depends on remote DTOs; T-005 integration depends on all.
- Parallel batches: Batch 1 T-001/T-002. Batch 2 T-003/T-004. Batch 3 T-005. Batch 4 T-006.
- Serialization constraints: shared `src/src/api.ts`, `src/src/types.ts`, remote registry, and TaskCenter are integration hotspots; coordinator resolves final conflicts.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Rebuild full-screen Task Hub UI

- Status: done
- Owner: /root/task-hub-ui
- Objective: Replace compact panel with a polished three-column Task Hub matching AgentPort.
- Inputs and prerequisites: Existing TaskCenter, styles, App shell, confirmed visual contract.
- Scope or files: `src/src/components/TaskCenter.tsx`, `src/src/styles.css`, `src/src/App.tsx`, `src/src/components/TopBar.tsx`, new UI tests.
- Expected output: provider/source rail, filter/list/board center, detail/review column, responsive states and keyboard/accessibility behavior.
- Dependencies: None.
- Execution steps: define layout/state; implement visual tokens and surfaces; integrate list/detail slots; add responsive collapse and focus handling; test/build.
- Acceptance criteria: no compact modal feel; full viewport workspace; high-density but readable; existing AgentPort palette and terminal context preserved.
- Verification method: frontend build and focused component tests; debug screenshot.
- Validation evidence: `npm run build -- --mode test` passed; `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [ ] T-002 — Complete GitHub/GitLab desktop operations

- Status: in_progress
- Owner: /root/task-provider-ops
- Objective: Add detail/read/write operations and provider-aware task state for GitHub and GitLab.
- Inputs and prerequisites: Existing `github_tasks.rs`, `gitlab_tasks.rs`, provider contracts.
- Scope or files: Tauri provider modules, API/types, Task Hub detail/mutation components, tests.
- Expected output: comments/status/labels/assignees, PR/MR review/checks/merge, Projects/Boards edits, guarded write/read-back/unknown outcomes.
- Dependencies: None.
- Execution steps: extend command DTOs; implement bounded CLI/API operations; add confirmation/read-back; wire detail and mutation UI; test.
- Acceptance criteria: no mutation reports success without authoritative response; credentials stay local; provider gaps explicit.
- Verification method: Rust unit/normalization tests, frontend build and focused UI tests.
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — Add remote protocol/service/provider routing

- Status: blocked
- Owner: /root/task-hub-remote
- Objective: Make task reads/writes execute on owning remote devices through explicit methods and capability gates.
- Inputs and prerequisites: Provider DTOs and operations from T-002.
- Scope or files: `crates/agentport-remote-protocol/src/lib.rs`, `crates/agentport-service/src/lib.rs`, bridge dispatch, `src/src/remote/backend.ts`, `src/src/remote/types.ts`, tests.
- Expected output: registry, retry classes, service handlers, desktop route mappings, read/write capabilities.
- Dependencies: T-002.
- Execution steps: add typed method names; dispatch to device-local provider service; map errors/unknown outcomes; add mobile read allowlist only; test.
- Acceptance criteria: no credentials cross wire; remote writes are non-replayable unless idempotency/read-back proves safe.
- Verification method: Rust protocol/service tests and TypeScript remote tests.
- Validation evidence: `cargo check -p agentport-remote-protocol -p agentport-service -p agentport-remote-bridge` passed; remote service now executes target-local gh/glab list/detail/basic mutation calls; `git diff --check` passed.
- Blocker: T-002 provider parity and full project/board mutation coverage remain incomplete.
- Unblock condition: Complete provider parity and hardening.

### [ ] T-004 — Add mobile read-only Task Hub surface

- Status: blocked
- Owner: /root/task-hub-mobile
- Objective: Add read-only mobile task summary/detail/deep-link screens.
- Inputs and prerequisites: T-003 read DTOs/capabilities.
- Scope or files: `mobile/src/features/tasks`, navigation/API, tests; do not touch generated schemas.
- Expected output: provider/task list/detail with auth/unavailable states and no mutation actions.
- Dependencies: T-003.
- Execution steps: add read API wrappers; implement list/detail; cache by device/provider/repository; deep links; tests.
- Acceptance criteria: mutation methods unavailable from mobile surface and capability errors clear.
- Verification method: mobile tests/type checks.
- Validation evidence: Mobile agent reports 6 task tests passed and production build passed; scoped commit `1dc2d51`.
- Blocker: Remote task read contract is not fully wired to provider execution.
- Unblock condition: Complete T-003 provider hooks and reconcile mobile read methods.

### [ ] T-005 — Security, cache, and consistency hardening

- Status: pending
- Owner: coordinator
- Objective: Verify identity keys, stale/partial/error states, credential boundaries, and unknown mutation handling across surfaces.
- Inputs and prerequisites: T-001–T-004.
- Scope or files: provider contracts/cache, remote capability tests, security docs/tests as needed.
- Expected output: adversarial tests and bounded refresh behavior.
- Dependencies: T-001, T-002, T-003, T-004.
- Execution steps: inspect diffs; add missing tests; audit serialized DTOs/frames/logs; run checks.
- Acceptance criteria: no source/device/account cross-contamination; no credential leakage; no false success.
- Verification method: targeted tests, diff review, grep/audit.
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-006 — Integrate, commit, rebuild, and deliver

- Status: blocked
- Owner: coordinator
- Objective: Resolve integration, commit scoped work, rebuild/sign debug App, verify process and screenshot, and report limits.
- Inputs and prerequisites: T-001–T-005.
- Scope or files: integration points, task document, commit, debug bundle.
- Expected output: verified debug build and scoped commit.
- Dependencies: T-001, T-002, T-003, T-004, T-005.
- Execution steps: run validation; preserve unrelated mobile schema change; commit; `python3 scripts/restart-debug-app.py`; verify process/window.
- Acceptance criteria: all task IDs done, task validator passes, debug UI nonblank, commit excludes unrelated changes.
- Verification method: repository checks, task validator, process/screenshot verification.
- Validation evidence: Partial provider/Rust/frontend checks pass; full mutation/read-back integration not complete.
- Blocker: T-002 provider mutations and T-005 security/consistency hardening remain incomplete.
- Unblock condition: Complete provider operations, run hardening/security checks, then integrate and rebuild.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Frontend: `npm run build -- --mode test`, focused component tests.
- Rust: `cargo check -p agentport`, provider/protocol/service tests.
- Mobile: targeted task feature tests/type checks.
- Security: no credential fields in task DTOs/remote frames/logs/backup; explicit mutation outcome tests.
- Integration: `git diff --check`, task validator, scoped diff review, debug rebuild and screenshot.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- One-shot provider + UI + Remote + mobile integration is large; incomplete sub-deliverables must remain explicitly blocked.
- CLI availability/auth differs by device; runtime unavailable/auth states must be tested.
- Remote registry and mobile allowlist changes can create unsafe mutation exposure; use explicit read/write capability names.
- Existing unrelated mobile generated schema change must remain outside all commits.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-22: User confirmed one-shot full scope: three-column high-end Task Hub, GitHub/GitLab desktop and remote writes, mobile read-only, local gh/glab credentials.
- 2026-11-22: Batch 1 started with UI/provider operation owners.
- 2026-11-22: Full-screen three-column Task Hub completed; frontend build passed.
- 2026-11-22: GitHub/GitLab provider modules extended with detail/mutation DTOs; GitLab detail/mutation currently returns explicit unavailable until provider hooks are complete.
- 2026-11-22: Remote registry/service/bridge capability and credential rejection paths added; CoreService now executes target-local provider list/detail/basic mutation operations.
- 2026-11-22: Mobile read-only Task Hub completed and committed as `1dc2d51`.
- 2026-11-22: Full integration remains partial; T-002 and T-005 are blocked.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: Full-screen UI build, Rust provider/protocol checks, mobile task tests/build, task-document validation, and debug App rebuild/screenshot passed. Scoped commit `0fa5d07`; mobile read-only commit `1dc2d51`.
- Limitations: GitLab advanced review/checks/board operations and complete mutation read-back/security hardening remain incomplete; basic remote list/detail/comment/state/merge execution is now wired to target-local gh/glab.
