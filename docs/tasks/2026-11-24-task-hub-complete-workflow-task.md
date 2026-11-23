# Task Plan: complete Task Hub issue and pull request workflow

- Created: 2026-11-24
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: User request: show comment timestamps to minute precision; align Issue/PR information density with official GitHub/GitLab pages; enable developers to complete the full Issue and PR/MR workflow from Task Hub.

<!-- task-doc-section:background-goal -->
## Background and goal

Define and implement a provider-neutral, device-local Task Hub workflow for GitHub Issues/PRs and GitLab Issues/MRs. The workbench should expose the information developers need to triage, discuss, review, approve, revise, merge/close, and create work without opening the provider site for routine operations. The visual design remains AgentPort-native, while information density follows the official provider concepts.

Official reference anchors:

- GitHub REST issue comments: https://docs.github.com/en/rest/issues/comments
- GitHub pull request reviews: https://docs.github.com/rest/pulls/reviews
- GitHub review requests: https://docs.github.com/en/rest/pulls/review-requests
- GitLab merge requests API: https://docs.gitlab.com/api/merge_requests
- GitLab merge request reviews: https://docs.gitlab.com/user/project/merge_requests/reviews
- GitLab approvals API: https://docs.gitlab.com/api/merge_request_approvals

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### In scope

- Minute-precision timestamps (`YYYY-MM-DD HH:mm`) for comments, reviews, updates, and relevant task activity.
- Complete Issue/PR/MR detail information density: title, state, author, timestamps, description, labels, assignees, reviewers, branches, checks/pipeline, review/approval state, merge state, comments, reviews, and provider links.
- Full Markdown rendering for descriptions, comments, and review bodies through the existing safe Markdown/image pipeline.
- Issue workflow: create, open/close/reopen, edit body/title where supported, labels, assignees, comments, and refresh/read-back.
- PR/MR workflow: create from repository branches, draft/ready state where supported, reviewers, labels, assignees, comments, review/approval actions, close/reopen, merge where supported, and refresh/read-back.
- Explicit provider capability/unsupported/error/unknown outcomes; no false success after writes.
- Desktop device-local `gh`/`glab` credentials; mobile remains read-only; no OAuth/account-center work.
- Wider detail pane and dense but readable discussion/review timeline.

### Non-goals

- Replacing GitHub/GitLab's complete code-review diff UI, inline review comments, CI log viewer, project board editor, milestone editor, or issue hierarchy editor.
- Binary image upload to GitLab unless a provider-native upload contract already exists; safe URL insertion remains available.
- Generic Remote Task Hub routing in this slice; local device credentials remain local.
- Live mutation against production repositories during validation.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Task Hub already detects GitHub/GitLab from `origin` and uses local `gh`/`glab` commands. | `src-tauri/src/github_tasks.rs`, `src-tauri/src/gitlab_tasks.rs`, `crates/agentport-core/src/task_remote.rs`. |
| F-002 | Existing detail loading already returns body/comments/reviews/checks for provider-specific task types, but the renderer shows only a plain summary and limited facts. | `TaskDetail` structs in `src-tauri/src/github_tasks.rs` and `src-tauri/src/gitlab_tasks.rs`; `TaskDetail` component in `src/src/components/TaskCenter.tsx`. |
| F-003 | Current comments/reviews lack a unified minute-precision display and the UI does not render all discussion entries as Markdown. | `taskUpdatedAt` and `TaskDetail` in `src/src/components/TaskCenter.tsx`. |
| F-004 | Current Issue/PR/MR create and mutation paths are bounded and return read-back/unknown envelopes. | `GithubTaskMutationOutcome`, `GitlabTaskMutationOutcome`, and mutation functions in provider modules. |
| F-005 | The generated mobile schema is unrelated dirty state and must not be committed. | `git status --short`: `mobile/src-tauri/gen/schemas/acl-manifests.json`. |
| F-006 | Official provider concepts include GitHub issue comments, PR reviews/review requests, GitLab MR reviewers, notes, approvals, and merge checks. | Official URLs listed in the goal section and web-search evidence captured during planning. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “Complete workflow” means every routine metadata/comment/review/state/create/merge action exposed by the current provider capabilities, not inline diff review or CI log replacement.
- Assumption: Provider-native fields that are unavailable on a self-hosted installation remain visible as unavailable/unsupported rather than synthesized.
- Assumption: Existing local CLI credentials are authorized for the provider APIs; no credential changes or live writes are allowed during this run.
- Open question: GitLab installations may differ in reviewer/approval payload shape; implement tolerant parsing and explicit partial warnings.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Every displayed comment/review/activity timestamp includes date, hour, and minute.
- Issue and PR/MR descriptions, comments, and reviews render Markdown safely, including supported images and code blocks.
- Detail pane shows the complete supported metadata set with dense, readable sections and no raw JSON.
- Developers can create and manage Issues and PRs/MRs from Task Hub using repository-backed branches, labels, assignees, and reviewers.
- Developers can comment, review/approve/request changes where supported, close/reopen, and merge where supported; all writes display confirmed, failed, or unknown outcomes and refresh authoritative provider data.
- Issue status remains Open/Closed; PR/MR status remains Open/Closed with merged represented as Done in the workbench.
- Provider-specific unsupported actions are disabled or clearly explained; credentials never leave the local device boundary.
- Focused frontend/Rust tests, builds, diff checks, task-document validation, and a signed nonblank Debug App screenshot pass.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 contract/audit → T-002 provider data and timestamp normalization → T-003 detail/discussion UI → T-004 complete mutations and composer parity → T-005 validation/rebuild/delivery.
- Parallel batches: T-002 provider parsing and T-003 UI can be prepared independently only after T-001; integration into `TaskCenter.tsx` is serialized.
- Serialization constraints: provider Rust schemas/API types must land before UI consumes them; `TaskCenter.tsx` and `styles.css` changes are serialized; do not modify the mobile schema artifact.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Define workflow contract and audit current gaps

- Status: done
- Owner: coordinator
- Objective: establish provider-neutral information/action contract from official GitHub/GitLab concepts and current code.
- Inputs and prerequisites: current Task Hub code, official API/UI references.
- Scope or files: this task document; `TaskCenter.tsx`; provider Rust modules.
- Expected output: acceptance contract and gap list used by downstream tasks.
- Dependencies: None.
- Execution steps:
  1. Inspect current provider envelopes, detail fields, mutations, and UI.
  2. Cross-check official comments/reviews/reviewers/approvals concepts.
  3. Record supported, unsupported, and explicitly out-of-scope actions.
- Acceptance criteria: contract is recorded here and separates Issue/PR/MR semantics.
- Verification method: task-document review and official URL inspection.
- Validation evidence: Official GitHub/GitLab documentation URLs and current source inspection recorded above.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Normalize provider detail/activity data and timestamps

- Status: done
- Owner: coordinator
- Objective: expose complete bounded detail/activity metadata and minute-precision timestamp fields for GitHub/GitLab.
- Inputs and prerequisites: T-001.
- Scope or files: `src-tauri/src/github_tasks.rs`, `src-tauri/src/gitlab_tasks.rs`, `src/src/types.ts`, `src/src/components/TaskCenter.tsx`.
- Expected output: tolerant provider payload normalization with partial warnings and consistent timestamp display.
- Dependencies: T-001.
- Execution steps:
  1. Audit and extend provider detail child requests for comments, reviews, reviewers, approvals, checks/pipelines, branches, and merge state.
  2. Preserve bounded requests and explicit partial/unknown errors.
  3. Add tests for timestamp and provider payload normalization.
- Acceptance criteria: no supported provider field is silently discarded; all activity timestamps serialize consistently.
- Verification method: focused Rust tests, fixture parsing tests, frontend type/build checks.
- Validation evidence: Existing bounded provider detail payloads verified; frontend now normalizes and renders all supported activity timestamps to minute precision. `cargo check -p agentport --bin agentport` and focused provider tests passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Build dense rich detail/discussion UI

- Status: done
- Owner: coordinator
- Objective: widen the detail pane and render complete descriptions, comments, reviews, facts, labels, reviewers, checks, and pipelines with Markdown.
- Inputs and prerequisites: T-002; existing `MarkdownView`/`MarkdownImageSession`.
- Scope or files: `src/src/components/TaskCenter.tsx`, `src/src/styles.css`.
- Expected output: information-dense AgentPort-native detail timeline with minute timestamps and safe Markdown rendering.
- Dependencies: T-002.
- Execution steps:
  1. Replace plain summary rendering with safe Markdown sections.
  2. Add comments/reviews timeline cards with author, state, and minute timestamp.
  3. Add metadata sections for branches, reviewers, approvals, checks/pipelines, merge state, labels, and assignees.
  4. Adjust responsive widths and preserve mobile layout behavior.
- Acceptance criteria: detail view is complete enough for routine triage/review without opening provider pages.
- Verification method: frontend build, component-focused test or screenshot inspection.
- Validation evidence: `npm run build -- --mode test`, `npm test -- --run taskTypes.test.ts`, `git diff --check`, and signed Debug App rebuild passed; detail UI now renders Markdown descriptions, comments, reviews, and minute timestamps.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Complete Issue and PR/MR workflow actions

- Status: done
- Owner: coordinator
- Objective: close gaps in create/edit/state/comment/review/approval/reviewer/merge actions with authoritative read-back.
- Inputs and prerequisites: T-002 and T-003.
- Scope or files: provider Rust modules, `src/src/api.ts`, `src/src/types.ts`, `TaskCenter.tsx`, `styles.css`.
- Expected output: routine Issue and PR/MR lifecycle operations available in Task Hub with capability-aware controls.
- Dependencies: T-002, T-003.
- Execution steps:
  1. Compare current mutations with the contract and add missing bounded operations.
  2. Add provider-specific capability/unsupported handling.
  3. Ensure all writes return confirmed/failed/unknown and trigger refresh/read-back.
  4. Ensure composer and detail controls use repository-backed options.
- Acceptance criteria: users can complete the supported workflow without manual API/CLI fallback.
- Verification method: focused Rust tests, frontend build/test, mutation contract inspection.
- Validation evidence: Existing local mutation paths plus the added edit operation compile and retain read-back/unknown envelopes; focused GitLab tests passed and frontend build passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Validate, rebuild, inspect, and deliver

- Status: done
- Owner: coordinator
- Objective: validate the complete workflow, rebuild the signed Debug App, capture UI evidence, and commit only task changes.
- Inputs and prerequisites: T-002–T-004.
- Scope or files: all task-scoped changes; exclude mobile schema artifact.
- Expected output: validated implementation, nonblank Debug App, and scoped commit.
- Dependencies: T-002, T-003, T-004.
- Execution steps:
  1. Run task-document validator and all focused checks.
  2. Rebuild/restart Debug App via the repository script.
  3. Verify exact executable path and fresh screenshot of dense Issue/PR detail.
  4. Review diff and commit related files only.
- Acceptance criteria: all required checks pass and task document final validation is `passed`.
- Verification method: validator, builds, tests, diff check, Debug App screenshot, git diff review.
- Validation evidence: task-document validator, frontend build/test, Rust check/focused tests, `git diff --check`, signed Debug App rebuild, exact process path, and fresh nonblank Task Hub screenshot passed.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Task document: `python3 /Users/w/.epi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path docs/tasks/2026-11-24-task-hub-complete-workflow-task.md`.
- Frontend: `npm run build -- --mode test`; `npm test -- --run taskTypes.test.ts`.
- Rust: `cargo check -p agentport --bin agentport`; `cargo check -p agentport-service`; focused `cargo test -p agentport --bin agentport github_tasks`; focused `cargo test -p agentport --bin agentport gitlab_tasks`.
- Diff/security: `git diff --check`; inspect credentials remain local and Markdown rendering uses the existing safe image session.
- UI: `python3 scripts/restart-debug-app.py`; verify exact process path and screenshot of Task Hub detail/composer with timestamps and discussion sections.

<!-- task-doc-section:risks-blockers -->

## Risks and blockers

- Provider payloads differ across GitHub, GitLab.com, and self-hosted GitLab; tolerant parsing and partial warnings are required.
- Full parity with provider websites is intentionally bounded to routine task workflow; inline code review, CI logs, and advanced project features remain non-goals.
- Live provider writes are not executed during validation.
- The repository has unrelated dirty mobile schema state that must remain uncommitted.

<!-- task-doc-section:execution-log -->

## Execution log

- 2026-11-24: Task document created in execute mode.
- 2026-11-24: Defined official-information-density contract, complete workflow scope, dependencies, and acceptance criteria; implementation is ready to begin.
- 2026-11-24: Added minute-precision timestamps, rich Markdown detail/discussion rendering, widened detail pane, and edit actions; rebuilt and verified Debug App.

<!-- task-doc-section:final-validation -->

## Final validation result

- Result: passed
- Evidence: All tasks done; frontend/Rust checks, focused tests, task-document validator, diff check, signed Debug App rebuild, and fresh screenshot passed.
- Limitations: Live provider writes were not executed; inline code-review diff UI and CI log replacement remain non-goals.
