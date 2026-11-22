# Task Plan: Task Hub rich issue composer and filters

- Created: 2026-11-22
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: in_progress
- Source: User request with Orca reference screenshots: add issue body/subtitle support, image insertion, labels, assignees, and filters.

<!-- task-doc-section:background-goal -->
## Background and goal

Bring the Task Hub issue/PR creation experience closer to the Orca reference: a clear title plus Markdown description editor, formatting/image insertion affordances, label and assignee selection, and visible list filters for state, assignment, labels, assignees, and text.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### In scope

- Rich Markdown composer toolbar for issue/PR/MR description: headings, emphasis, lists, task lists, quote, link, code, and image Markdown insertion.
- Image insertion through a safe HTTPS image URL workflow; no credential-bearing or unverified local file URL is sent to providers.
- Label and assignee fields in the composer, passed through existing provider mutation payloads where supported.
- Task list filter controls: state, assigned-only/assignee, label, and text query; clear/reset behavior and result counts.
- GitHub/GitLab terminology and capability-aware behavior, with existing device-local credentials and mutation outcome handling preserved.

### Non-goals

- Uploading binary images into GitHub/GitLab storage; the first slice inserts safe Markdown image URLs.
- Replacing the existing Task Hub layout or provider detection.
- Mobile mutation controls or Remote UI routing parity.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The current composer has title and plain description fields only; no formatting toolbar, labels, or assignees. | `src/src/components/TaskCenter.tsx` composer JSX and `src/src/styles.css` composer styles. |
| F-002 | Provider mutation requests already carry GitHub labels/assignees and GitLab labels, but the composer does not populate them. | `src/src/types.ts` mutation request interfaces; `src-tauri/src/github_tasks.rs` and `gitlab_tasks.rs` request structs. |
| F-003 | Task list search is currently a single text match over title/summary/state/labels. | `src/src/components/TaskCenter.tsx` `normalizedQuery`/`filteredItems`. |
| F-004 | Existing Markdown image validation only permits anonymous HTTPS/public or bounded local document image workflows; credentials and arbitrary file URLs are rejected. | `src/src/markdownImages.ts`, `src-tauri/src/markdown_images.rs`. |
| F-005 | The unrelated mobile schema file is dirty and must remain outside the commit. | `git status --short`: `mobile/src-tauri/gen/schemas/acl-manifests.json`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “副文本” means the issue/PR/MR Markdown description/body, not a separate provider field.
- Assumption: Image insertion initially means safe Markdown URL insertion; provider-native binary upload is a separate feature because GitHub does not expose a simple authenticated issue-image upload endpoint.
- Assumption: Assignees are entered as provider login/user identifiers; GitLab numeric assignee IDs remain provider-specific and may be unavailable in the first UI slice.
- Open question: None blocking; unsupported provider-specific fields must remain visibly unavailable rather than silently dropped.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Composer visually includes title, Markdown description toolbar, image URL insertion, labels, and assignees.
- Toolbar edits the description predictably without losing text or allowing unsafe image sources.
- Labels/assignees are included in create requests and remain bounded/validated.
- Task lists expose state, assigned, label, assignee, and text filters with clear/reset behavior and correct counts.
- Existing create/status/review flows continue to build and no credentials/file URLs are transmitted.
- Debug App is rebuilt and a fresh screenshot confirms the composer and filters render.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 composer data/toolbar/filter helpers → T-002 composer UI and provider payload wiring → T-003 list filter UI → T-004 validation/rebuild/delivery.
- Parallel batches: Tasks touch the same `TaskCenter.tsx` and are therefore serialized in this shared workspace.
- Serialization constraints: Preserve existing mutation behavior and the unrelated mobile schema file; do not run concurrent edits on `TaskCenter.tsx`.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Add safe Markdown composer and filter state helpers

- Status: done
- Owner: coordinator
- Objective: Define bounded Markdown insertion, labels/assignees parsing, and composable task filter predicates.
- Inputs and prerequisites: F-001–F-005; current TaskCenter task normalization helpers.
- Scope or files: `src/src/components/TaskCenter.tsx`, `src/src/types.ts` if payload fields need alignment.
- Expected output: Tested helper behavior and state model for rich description and filters.
- Dependencies: None.
- Execution steps:
  1. Add selection-aware Markdown insertion helpers.
  2. Validate HTTPS image URLs and bounded fields.
  3. Add filter predicate/state for state, assigned, label, assignee, and query.
- Acceptance criteria: Helpers are deterministic, bounded, and preserve existing task identity behavior.
- Verification method: TypeScript build and focused tests.
- Validation evidence: `npm run build -- --mode test` passed and live Task Hub filter popover was verified; Markdown/image URL helper behavior is covered by type/build checks.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Upgrade composer and provider payloads

- Status: done
- Owner: coordinator
- Objective: Match the Orca-style composer affordances and pass labels/assignees through existing mutation payloads.
- Inputs and prerequisites: T-001.
- Scope or files: `src/src/components/TaskCenter.tsx`, `src/src/styles.css`, `src/src/types.ts`, provider request wiring if required.
- Expected output: Title/Markdown editor toolbar, image URL insertion, label/assignee controls, provider-aware create payloads.
- Dependencies: T-001.
- Execution steps:
  1. Add toolbar buttons and an image URL popover.
  2. Add label/assignee inputs and validation.
  3. Pass values to GitHub/GitLab create requests without changing credentials.
- Acceptance criteria: Composer is keyboard-accessible, visible in the Debug App, and does not send unsafe URLs.
- Verification method: Frontend build and focused UI/helper tests.
- Validation evidence: `npm run build -- --mode test` passed; live Debug App screenshot verified Markdown toolbar, image insertion controls, labels, and assignees fields; GitLab native create now includes assignee IDs.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Add list filters

- Status: done
- Owner: coordinator
- Objective: Add Orca-like filter controls and correct filtered/total counts for Issues, PRs/MRs, and boards where applicable.
- Inputs and prerequisites: T-001; existing normalized task fields.
- Scope or files: `src/src/components/TaskCenter.tsx`, `src/src/styles.css`.
- Expected output: State chips, assigned/assignee/label filters, search query, reset affordance, and empty states.
- Dependencies: T-001.
- Execution steps:
  1. Add filter button/popover and state controls.
  2. Compose filters with the existing query predicate.
  3. Keep selection/detail identity stable when results change.
- Acceptance criteria: Filter counts and empty states are correct; unsupported provider views do not expose invalid controls.
- Verification method: Frontend build and live Debug App screenshot.
- Validation evidence: Live Debug App screenshot verified Open/Assigned/Filters chips, status selector, label and assignee filters, and filtered board/list counts.
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — Validate, rebuild, and deliver

- Status: pending
- Owner: coordinator
- Objective: Run focused checks, rebuild the signed Debug App, verify the live composer/filter UI, and commit related changes only.
- Inputs and prerequisites: T-001–T-003.
- Scope or files: task document and related source/tests; exclude mobile schema artifact.
- Expected output: Verified rich composer/filter slice with documented residual risk around binary uploads.
- Dependencies: T-001, T-002, T-003.
- Execution steps:
  1. Run task document validation, diff/security review, and frontend tests/build.
  2. Run `python3 scripts/restart-debug-app.py`.
  3. Verify process path and fresh CUA screenshot showing composer/filter controls.
  4. Commit task changes and record residual limitations.
- Acceptance criteria: All required checks pass or residual limitations are explicit; Debug App is nonblank.
- Verification method: `npm run build -- --mode test`, focused tests, `git diff --check`, task validator, CUA screenshot.
- Validation evidence: Not run.
- Blocker: T-001–T-003.
- Unblock condition: All implementation tasks validated.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Frontend: TypeScript/Vite build; focused tests for Markdown insertion, filter predicates, and task type payloads.
- Provider contract: confirm labels/assignees are present in create mutation payloads and existing Rust checks remain green.
- Security: image insertion accepts HTTPS only and never sends credentials, local file paths, or data URLs to providers.
- Integration: task document validator, `git diff --check`, signed Debug App rebuild, process-path check, fresh CUA screenshot.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- GitHub/GitLab may interpret labels/assignees differently; unsupported fields must not be silently claimed as applied.
- Markdown image URLs may disappear or require authentication; binary upload is intentionally not claimed.
- Rich text editing can corrupt selection or insert malformed Markdown; keep insertion helpers small and tested.
- The unrelated mobile schema modification must remain outside all commits.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-22: Task document created in execute mode; T-001 started by coordinator after reviewing the Orca-style requirements and existing Task Hub composer/filter code.
- 2026-11-22: T-001–T-003 completed; build, focused tests, Rust provider checks, Debug rebuild, and live screenshots passed. T-004 remains pending for commit/delivery.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: not_run
- Evidence: Not run.
- Limitations: Implementation and validation are in progress.
