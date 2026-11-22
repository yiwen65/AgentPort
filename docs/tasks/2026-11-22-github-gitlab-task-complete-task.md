# Task Plan: GitHub and GitLab complete task integration

- Created: 2026-11-22
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: Confirmed user scope: GitHub + GitLab task modules; desktop/remote complete capability; mobile read-only summary/detail/deep links.

<!-- task-doc-section:background-goal -->
## Background and goal

Extend the existing read-only GitHub Task Center into a provider-aware task system covering GitHub and GitLab. Desktop must support task discovery, detail views, comments/status/labels/assignees where the provider permits, PR/MR review/check information, and project/board views where available. Remote AgentPort devices must execute provider calls on the device that owns the repository/account. Mobile receives typed read-only summaries/details/deep links. Local Project/Session/Worktree lifecycles remain independent; task links may reference them but external records never own local deletion.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### In scope

- Provider-neutral task DTOs and capability/error envelopes.
- GitHub Issues, Pull Requests, Projects V2: list, detail, comments/status/labels/assignees, PR checks/review/merge, bounded project rows/field updates.
- GitLab Issues, Merge Requests, Boards/Issues: equivalent typed read/write operations supported by provider APIs.
- Desktop UI for provider selection, list/detail, mutations, and task-to-worktree/session launch links.
- Remote protocol/service/bridge routing for task reads and writes with capability negotiation and device-local credentials.
- Mobile read-only task summary/detail/deep-link surface using typed remote methods.

### Non-goals

- Linear/Jira in this task; they remain future providers.
- Storing access tokens in SQLite, Remote wire, logs, diagnostics, or backups.
- Automatic background polling of every repository; refresh is scoped to visible/selected sources with bounded retry/backoff.
- Silent replay of unknown mutation outcomes.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Current AgentPort has a local-only GitHub read-only slice committed as `c9e3d9b`. | `src-tauri/src/github_tasks.rs`, `src/src/components/TaskCenter.tsx`, commit `c9e3d9b` |
| F-002 | Remote protocol uses an explicit method registry, retry classification, service dispatch, and TS `RemoteBackend` routing. | `crates/agentport-remote-protocol/src/lib.rs`; `crates/agentport-remote-bridge/src/lib.rs`; `crates/agentport-service/src/lib.rs`; `src/src/remote/backend.ts` |
| F-003 | Mobile already consumes typed Remote methods and has an explicit V2 allowlist. | `mobile/src/features/git/gitApi.ts`; `crates/agentport-remote-protocol/src/lib.rs` (`MOBILE_V2_METHOD_ALLOWLIST`) |
| F-004 | Orca has provider-aware work-item, review, ProjectV2, cache, and mutation patterns that informed this scope. | Orca analysis recorded in previous task; paths under `/Users/w/Projects/orca/src/main/github`, `src/main/gitlab`, `src/renderer/src/components/task-page` |
| F-005 | The worktree contains an unrelated pre-existing mobile schema modification. | `git status --short`: `mobile/src-tauri/gen/schemas/acl-manifests.json` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption accepted by confirmation: mobile is read-only; desktop and remote support writes.
- Assumption: GitHub authentication continues to use device-local `gh` credentials for the first integration increment; GitLab uses device-local `glab` where available, with explicit unavailable/auth errors. A later OAuth migration remains possible.
- Open question deferred: exact parity of provider-specific fields; typed common fields plus provider capability-specific optional fields are acceptable.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- [ ] GitHub and GitLab are selectable providers with explicit auth/source/capability errors.
- [ ] Desktop can list and open task details for both providers and perform supported mutations with read-back or explicit unknown outcome.
- [ ] GitHub Projects and GitLab Boards are represented as bounded, provider-specific project surfaces.
- [ ] Remote calls execute against the owning device and are capability-gated; credentials never cross the wire.
- [ ] Mobile can list/read task summaries/details and open provider deep links without mutation controls.
- [ ] Cache keys include provider/host/repository/account/device scope; visible reads are bounded and stale/error states are explicit.
- [ ] Existing local Project/Session/Git Center behavior is preserved; all checks pass and only task-related files are committed.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 provider contract → T-002 GitHub desktop extension and T-003 GitLab adapter; T-001 → T-004 remote protocol; T-004 → T-005 mobile read-only; T-006 integration depends on all.
- Parallel batches: Batch 1 T-001. Batch 2 T-002/T-003/T-004 after contract. Batch 3 T-005 after remote DTOs. Batch 4 T-006.
- Serialization constraints: provider DTOs and remote method registry are shared contracts; coordinator owns final integration and task document. Existing mobile schema file is excluded.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Define provider-neutral task contract and cache identity

- Status: done
- Owner: /root/task-contract
- Objective: Add typed common task/provider/capability/error contracts without coupling local Project lifecycle to external tasks.
- Inputs and prerequisites: F-001–F-004; confirmed scope.
- Scope or files: `src/src/types.ts`, new `src/src/taskTypes.ts` if useful, `src/src/taskCache.ts` or equivalent, shared mobile/remote DTO locations as required.
- Expected output: stable DTOs for GitHub/GitLab issue/PR/MR/board/project/detail/mutation envelopes and scope-aware cache keys.
- Dependencies: None.
- Execution steps: define discriminated unions, capability flags, mutation outcome states, and identity key helpers; add unit tests.
- Acceptance criteria: contracts represent provider-specific capability gaps explicitly and never contain credentials.
- Verification method: frontend typecheck and focused unit tests.
- Validation evidence: `npm run build -- --mode test` passed; `npm test -- --run taskTypes.test.ts` passed (1 test).
- Blocker: None.
- Unblock condition: None.

### [ ] T-002 — Complete GitHub desktop task features

- Status: pending
- Owner: /root/github-task-complete
- Objective: Extend the existing GitHub slice with details, comments/status/labels/assignees, checks/review/merge, Project rows/field writes, and task-to-worktree/session launch.
- Inputs and prerequisites: T-001 contracts; existing `src-tauri/src/github_tasks.rs` and TaskCenter.
- Scope or files: `src-tauri/src/github_tasks.rs`, `src-tauri/src/main.rs`, `src/src/api.ts`, `src/src/components/TaskCenter.tsx`, related new tests.
- Expected output: device-local GitHub read/write command family with explicit mutation read-back/unknown results and desktop UI.
- Dependencies: T-001.
- Execution steps: add operation enum/DTOs, guarded `gh api` calls, detail/mutation UI, bounded refresh and optimistic state only when confirmed.
- Acceptance criteria: no write claims success without authoritative response; all mutations have explicit errors.
- Verification method: Rust unit tests, frontend build, mocked command normalization tests.
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Implement GitLab desktop adapter and UI

- Status: done
- Owner: /root/gitlab-task
- Objective: Add GitLab Issues/Merge Requests/Boards read/write adapter and provider selection in Task Center.
- Inputs and prerequisites: T-001 contracts; existing GitHub UI patterns.
- Scope or files: new `src-tauri/src/gitlab_tasks.rs`, main registration, API/types, TaskCenter provider UI, tests.
- Expected output: GitLab REST/`glab`-backed bounded operations with host/project identity and capability errors.
- Dependencies: T-001.
- Execution steps: parse GitLab remotes including self-hosted hosts; implement list/detail/mutations/boards; add provider-aware UI and deep links.
- Acceptance criteria: GitLab credentials remain device-local; self-hosted host identity is preserved; unsupported board fields degrade explicitly.
- Verification method: Rust parser/normalization tests and frontend build.
- Validation evidence: `cargo check -p agentport` passed; `cargo test -p agentport --bin agentport gitlab_tasks` passed (2 tests); frontend build passed.
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — Extend remote protocol/service/desktop routing

- Status: pending
- Owner: /root/task-remote
- Objective: Add typed task methods to protocol registry, service dispatch, bridge capability negotiation, and desktop RemoteBackend routing.
- Inputs and prerequisites: T-001 DTOs; provider command operations from T-002/T-003.
- Scope or files: `crates/agentport-remote-protocol/src/lib.rs`, `crates/agentport-service/src/lib.rs`, `crates/agentport-remote-bridge/src/lib.rs`, `src/src/remote/backend.ts`, `src/src/remote/types.ts`, routing/tests.
- Expected output: device-local task reads/writes with retry classification and capability gates.
- Dependencies: T-001, T-002, T-003.
- Execution steps: add read/write methods, allowlists, dispatch handlers, mapping, request ownership, and unknown-outcome rules.
- Acceptance criteria: no task credential/value crosses remote wire; methods are explicit and tested.
- Verification method: Rust protocol/service tests and TS remote backend tests.
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — Add mobile read-only task surface

- Status: pending
- Owner: /root/task-mobile
- Objective: Expose read-only task summaries/details/deep links in mobile using remote typed methods.
- Inputs and prerequisites: T-004 remote DTOs and capability names.
- Scope or files: `mobile/src/features/tasks/` new files, mobile navigation/API, remote protocol mobile allowlist (not generated schema artifacts).
- Expected output: provider/task list/detail UI with no mutation controls and graceful unavailable/auth states.
- Dependencies: T-004.
- Execution steps: add API wrappers, cache scoped by device/provider/repository, list/detail screens, deep links, tests.
- Acceptance criteria: mobile cannot invoke task mutation methods and displays capability errors.
- Verification method: mobile unit/type checks and focused UI tests.
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-006 — Integrate, validate, commit, and rebuild

- Status: blocked
- Owner: coordinator
- Objective: Resolve contract integration, run all targeted checks, verify security/scope, commit, and rebuild debug app.
- Inputs and prerequisites: T-001–T-005.
- Scope or files: integration points, task document, commit, debug bundle.
- Expected output: complete scoped delivery with evidence and running debug app.
- Dependencies: T-001, T-002, T-003, T-004, T-005.
- Execution steps: inspect diffs; reconcile conflicts; run checks; ensure mobile schema remains untouched; commit; run restart-debug-app; verify process/window.
- Acceptance criteria: all tasks done, validator passes, commit excludes unrelated changes, debug app renders.
- Verification method: repository-specific Rust/TS/mobile checks, task validator, `git diff --check`, process and screenshot verification.
- Validation evidence: Partial checks passed for T-001/T-003; full integration was not run.
- Blocker: T-002, T-004, and T-005 have no deliverables.
- Unblock condition: Complete GitHub desktop detail/write, remote protocol/service, and mobile read-only tasks.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Contract: frontend typecheck plus task/cache unit tests.
- Provider: Rust parser/normalization/mutation outcome tests for GitHub and GitLab.
- Remote: protocol registry/capability/retry tests, service dispatch tests, TS mapping/backend tests.
- Mobile: targeted package/type tests and read-only UI tests.
- Integration: `git diff --check`, task validator, scoped diff review, debug rebuild and screenshot.
- Security: verify no token fields are serialized into DTOs, remote frames, SQLite, logs, or backups.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Full provider parity is large; provider-specific capability gaps must remain explicit rather than being hidden behind `any`.
- `gh`/`glab` availability and authentication differ per device; runtime tests must include unavailable/auth states.
- Remote protocol changes touch desktop, service, bridge, and mobile allowlists; registry/retry omissions can create unsafe behavior.
- Existing mobile generated schema modification is unrelated and must remain outside all commits.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-22: User confirmed GitHub + GitLab, desktop/remote complete capability, mobile read-only; Linear/Jira closed for this task.
- 2026-11-22: Task document created; Batch 1 started with provider-neutral contract ownership.
- 2026-11-22: Contract agent did not produce changes and was interrupted; coordinator implemented the minimum provider-neutral TS contract and identity tests.
- 2026-11-22: GitLab desktop adapter implemented with self-hosted remote parsing and bounded glab reads for Issues/MRs/Boards; 2 Rust tests passed.
- 2026-11-22: Remaining GitHub detail/write, remote, and mobile tasks were interrupted without deliverables; full scope is blocked.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: Provider-neutral contract and GitLab desktop adapter compile; Rust and frontend targeted checks pass.
- Limitations: GitHub detail/write, Remote protocol/service integration, and mobile read-only task UI remain unimplemented; full-scope delivery is blocked.
