# Task Plan: GitHub task center read-only integration

- Created: 2026-11-22
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: User request to formulate a plan and implement the Orca Issues/PRs/Projects task modules in AgentPort.

<!-- task-doc-section:background-goal -->
## Background and goal

Orca provides a mature provider-aware task surface for GitHub Issues, Pull Requests, and GitHub Projects. AgentPort currently manages local Projects, Sessions, Worktrees, and Git Center, but has no external work-item model or UI. Deliver a bounded first vertical slice: a local desktop GitHub Task Center with read-only Issues, Pull Requests, and Projects discovery, driven by the active AgentPort project. Preserve AgentPort's local project/session model and avoid credentials in persisted state or renderer payloads beyond returned read-only task data.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### In scope

- A typed Tauri command/API for read-only GitHub task data resolved from an AgentPort project checkout.
- GitHub Issues and Pull Requests listing, with repository identity and classified errors.
- GitHub Projects V2 discovery/listing with bounded item summaries.
- A desktop Task Center surface reachable from the top bar, with Issues/PRs/Projects tabs, loading/error/empty states, refresh, and browser deep links.
- Unit/contract tests for remote URL parsing, JSON normalization, and renderer behavior where practical.

### Non-goals

- Mutations (comments, labels, state changes, merge, project field updates).
- OAuth/account management, remote-device protocol, mobile UI, Linear/Jira/GitLab providers.
- Persisting GitHub tokens, task bodies, or external task records in AgentPort SQLite.
- Replacing the existing local Project/Session/Worktree model.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | AgentPort projects are local filesystem/git roots and have no external task fields. | `crates/agentport-core/src/models.rs:320-330`; `src/src/types.ts:70-90` |
| F-002 | Tauri commands are registered centrally in `src-tauri/src/main.rs`, while renderer calls are wrapped in `src/src/api.ts`. | `src-tauri/src/main.rs:5251+`; `src/src/api.ts` command surface |
| F-003 | Git Center already resolves checkout context and remote URL through opaque backend descriptors. | `src/src/types.ts:380+`; `src/src/gitCenter.ts`; `src-tauri/src/git_workspace_commands.rs` |
| F-004 | Orca separates Issues/PRs/Projects, uses provider-aware source identity, bounded reads, partial errors, and GraphQL for Projects V2. | Orca analysis paths: `src/main/github/client/list/*`, `src/main/github/project-view/*`, `src/shared/github/projects/*` |
| F-005 | The working tree has an unrelated pre-existing modification that must not be included. | `git status --short`: `mobile/src-tauri/gen/schemas/acl-manifests.json` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: A first complete delivery can be a desktop/local read-only vertical slice; remote/mobile and mutations remain explicitly deferred because they require protocol, capability, and credential-contract changes.
- Assumption: Reusing the authenticated `gh` CLI is acceptable for this first slice; no token is read by AgentPort and the command runs with the user's existing environment/authentication.
- Open question: Whether a future release should replace `gh` subprocess access with first-class OAuth/HTTP credentials; this is deferred and does not block the read-only slice.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- [x] The active AgentPort project can open a Task Center from the top bar.
- [x] The Task Center lists GitHub Issues, Pull Requests, and Projects when the checkout has a resolvable GitHub remote and `gh` authentication is available.
- [x] Non-Git folders, non-GitHub remotes, missing authentication, malformed responses, and command failures produce explicit error states rather than empty-success states.
- [x] Refresh is user-triggered and bounded; no mutation is exposed.
- [x] Task payloads are typed, no credentials are persisted, and existing local Project/Session/Git Center behavior remains unchanged.
- [x] Targeted tests/build checks pass and only task-related changes are committed; the unrelated mobile schema modification is preserved outside the commit.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001` (backend contract/commands) and `T-002` (renderer Task Center) may proceed in parallel after this plan is validated; `T-003` integrates and validates both.
- Parallel batches: Batch 1 = T-001, T-002. Batch 2 = T-003.
- Serialization constraints: `src-tauri/src/main.rs` registration and `src/src/api.ts` type surface are shared integration points; coordinator resolves/validates them after parallel work. The task document and git commit are coordinator-owned.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Implement local GitHub read-only task command

- Status: done
- Owner: /root/github-task-backend
- Objective: Add typed read-only GitHub Issues/PRs/Projects retrieval for an AgentPort project without persisting credentials or task data.
- Inputs and prerequisites: F-001 through F-004; validated task plan; existing Tauri command conventions.
- Scope or files: `src-tauri/src/github_tasks.rs`, `src-tauri/src/main.rs`, `src/src/api.ts`, `src/src/types.ts` (backend-facing additions only).
- Expected output: command/API contracts, GitHub remote parsing, bounded `gh api` calls, normalized typed result and unit tests.
- Dependencies: None.
- Execution steps:
  1. Resolve project git root and GitHub owner/repository from remote URL.
  2. Execute bounded `gh api` REST/GraphQL reads with no token capture.
  3. Normalize results and classify failures.
  4. Register the command and expose typed renderer API.
  5. Run focused Rust/TypeScript checks.
- Acceptance criteria:
  - Issues, PRs, and Projects are represented by typed JSON-safe DTOs.
  - GitHub URL parsing covers HTTPS, SSH, and `.git` suffixes and rejects non-GitHub remotes.
  - Errors are explicit and no credentials are written to files, logs, or DTOs.
- Verification method:
  - Rust unit tests for parsing/normalization.
  - `cargo check -p agentport` and targeted TypeScript check.
- Validation evidence: `cargo check -p agentport` passed; `cargo test -p agentport --bin agentport github_tasks` passed (3 tests).
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Implement desktop Task Center UI

- Status: done
- Owner: /root/github-task-ui
- Objective: Add a read-only Task Center surface for Issues, PRs, and Projects reachable from the top bar.
- Inputs and prerequisites: F-002/F-003; stable API names from T-001 can be consumed structurally and reconciled by T-003.
- Scope or files: `src/src/components/TaskCenter.tsx`, `src/src/App.tsx`, `src/src/components/TopBar.tsx`, `src/src/styles.css`, and focused UI tests if needed.
- Expected output: accessible tabbed panel with loading/error/empty states, refresh and deep links, without changing local Project/Session semantics.
- Dependencies: None (API calls may be stubbed structurally until integration).
- Execution steps:
  1. Add Task Center open state at app shell level.
  2. Add top-bar action and panel component.
  3. Render three read-only tabs and task rows.
  4. Add refresh/close/open-browser interactions and bounded layout styling.
  5. Run focused renderer tests/typecheck.
- Acceptance criteria:
  - UI is reachable without stealing terminal/session focus.
  - All states are explicit and no mutation controls are present.
  - Existing top-bar/Git Center behavior remains intact.
- Verification method:
  - Renderer unit test or component smoke test.
  - `npm run typecheck`/repository-equivalent targeted check.
- Validation evidence: `npm run build -- --mode test` passed (TypeScript and Vite build).
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Integrate, validate, and deliver

- Status: done
- Owner: coordinator
- Objective: Reconcile backend/UI contracts, run meaningful checks, review diff, update this plan, and commit only task-related changes.
- Inputs and prerequisites: T-001 and T-002 reports and changed files.
- Scope or files: integration points, tests, task document, git commit.
- Expected output: passing build/tests, clean scoped diff, commit hash, and delivery summary.
- Dependencies: T-001, T-002.
- Execution steps:
  1. Inspect both diffs and resolve API/type mismatches.
  2. Run focused Rust and frontend checks, then the repository gate appropriate to touched paths.
  3. Verify no credentials or unrelated mobile schema changes are included.
  4. Update task evidence/status and commit scoped changes.
- Acceptance criteria:
  - All required checks pass or limitations are explicitly documented.
  - All completed tasks have evidence and the validator passes.
  - Commit contains only this feature.
- Verification method:
  - `cargo test`/`cargo check` targeted package checks.
  - `pnpm check:changed` if applicable to touched frontend paths.
  - `git diff --check`, scoped diff review, task-document validator.
- Validation evidence: `cargo check -p agentport`; `cargo test -p agentport --bin agentport github_tasks` (3 passed); `npm run build -- --mode test`; `git diff --cached --check`; task-document validator; scoped commit `2cf1309`.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. Validate this task document before implementation.
2. Run backend unit tests for GitHub remote parsing and JSON mapping.
3. Run frontend typecheck and focused Task Center tests.
4. Run `git diff --check` and inspect the complete scoped diff.
5. Run the repository's changed-file gate (`pnpm check:changed`) if the current checkout supports it; otherwise record the exact unavailable command and use the smallest equivalent checks.
6. Confirm the pre-existing `mobile/src-tauri/gen/schemas/acl-manifests.json` modification remains uncommitted.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- `gh` may be unavailable or unauthenticated in the validation environment; unit tests must cover deterministic parsing while runtime availability is reported as a limitation.
- GitHub Projects V2 GraphQL schema and permissions vary by host; the first slice must bound and classify failures rather than promise full Project row parity with Orca.
- The existing working tree contains unrelated mobile changes; commit selection must remain path-scoped.
- Adding a new top-bar surface may affect UI snapshots/layout; focused tests and diff review are required.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-22: Task document created in execute mode from the Orca/AgentPort analysis. Scope constrained to a local desktop read-only vertical slice; mutations, remote, and mobile deferred.
- 2026-11-22: Batch 1 started: backend and UI tasks delegated to separate owners; coordinator retains integration/commit ownership.
- 2026-11-22: T-001 backend completed with bounded `git`/`gh api` reads, typed envelopes, and 3 passing unit tests.
- 2026-11-22: T-002 UI completed with top-bar entry, tabbed read-only panel, refresh/error/empty states, and successful frontend build.
- 2026-11-22: Coordinator aligned the UI to `api.listGithubTasks` and the typed `{data:{items}}` envelope; integration checks are running.
- 2026-11-22: T-003 checks passed; scoped feature commit created as `2cf1309` while preserving the unrelated mobile schema change.
- 2026-11-22: Final validation passed; runtime GitHub API behavior remains dependent on local `gh` installation/authentication and was not exercised against a live repository.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: Task validator passed; Rust compile and 3 backend unit tests passed; frontend TypeScript/Vite build passed; staged diff check passed; scoped commit `2cf1309` contains only the task plan and feature files.
- Limitations: Live GitHub API/Projects V2 access was not exercised; runtime behavior requires `gh` installed and authenticated. Remote-device/mobile/mutation integrations remain intentionally out of scope.
