# Task Plan: Task Hub rendered rich composer, repository options, and image upload

- Created: 2026-11-22
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: User clarification: show only the rendered rich editing surface and load labels/assignees from repository options.

<!-- task-doc-section:background-goal -->
## Background and goal

Upgrade Task Hub's issue/PR/MR composer from a raw Markdown textarea plus a separate preview to one rendered-only editable surface. Keep Markdown serialization hidden inside the editor so provider APIs still receive Markdown, show uploaded images directly in the editing surface, and source labels/assignees from the detected repository rather than free-text fields.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### In scope

- One rendered contenteditable rich editor with formatting toolbar; no visible raw Markdown textarea or duplicate preview.
- Markdown serialization for headings, emphasis, lists, task lists, quotes, code, links, and safe HTTPS images.
- File-picker, paste, native-WebKit clipboard, and drop image intake for GitHub composers.
- Bounded local image transfer through `gh`, signature/type/size checks, and GitHub user-attachment URLs.
- Repository-backed GitHub labels/assignees and GitLab labels/project members, with searchable multi-select chips.
- Repository-backed label/assignee filters.
- Preserve automatic provider detection, device-local `gh`/`glab` credentials, desktop writes, and mobile read-only behavior.

### Non-goals

- Binary image upload to self-hosted GitLab in this slice; GitLab keeps safe HTTPS image URL insertion.
- Mobile mutation/image-upload support.
- Sending GitHub/GitLab credentials or raw file paths over Remote.
- Live provider write/upload verification against production repositories during this run.
- Full Remote Task Hub UI routing; the existing local provider command boundary remains unchanged.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Task Hub previously rendered a raw `<textarea>` and a separate Markdown preview. | `src/src/components/TaskCenter.tsx` before this change. |
| F-002 | AgentPort already has bounded remote-image validation and blob-backed Markdown image sessions. | `src/src/markdownImages.ts`, `src-tauri/src/markdown_images.rs`. |
| F-003 | GitHub and GitLab repository option APIs can use the existing device-local `gh`/`glab` CLI configuration. | `src-tauri/src/github_tasks.rs`, `src-tauri/src/gitlab_tasks.rs`. |
| F-004 | The unrelated generated mobile schema file is dirty and must remain outside this change. | `git status --short`: `mobile/src-tauri/gen/schemas/acl-manifests.json`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: The editor may keep Markdown only in React state and serialize it on input; the user-visible surface must remain rendered rich content.
- Assumption: Repository options are read when Task Hub is open and are reused for composer and filters; an unavailable options read disables arbitrary entry but does not block creating a task without labels/assignees.
- Assumption: GitLab binary upload needs a separate provider-native contract and remains intentionally unsupported here.
- Open question: None blocking. Live provider writes/uploads remain unexecuted to avoid modifying a real repository.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- The composer contains one rendered rich editing surface and toolbar; no raw Markdown textarea or second rendered preview is visible.
- Toolbar edits and normal typing update the hidden Markdown body sent to the existing create mutation.
- Image URL insertion shows a safe image in the editor; uploaded/pasted GitHub images show a local preview immediately and retain the returned provider URL in serialized Markdown.
- Image input is bounded to supported types and 10 MiB; unsafe URLs, invalid clipboard data, and unsupported GitLab upload attempts fail visibly.
- Labels and assignees are searchable repository-backed options, represented as selected chips; no comma-separated free-text fields remain.
- Filters use repository-backed label/assignee options.
- Existing title/branch/create behavior remains buildable and safe.
- Debug App is rebuilt and a fresh screenshot confirms the rendered-only composer and repository-backed controls.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and batches

- Dependency graph: rich editor/serialization → repository option commands and upload boundary → validation/rebuild/delivery.
- Batches are serialized because they share `TaskCenter.tsx`, API registration, and embedded frontend assets.
- Do not modify or commit the unrelated mobile schema; do not send live provider writes without explicit new authorization.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Replace raw/preview composer with rendered-only editor

- Status: done
- Scope: `src/src/components/TaskCenter.tsx`, `src/src/components/TaskRichEditor.tsx`, `src/src/styles.css`.
- Output: contenteditable rendered surface, toolbar, Markdown serializer, safe image placeholders/session loading, image URL/file/paste/drop intake, upload state.

### [x] T-002 — Add repository-backed option APIs and pickers

- Status: done
- Scope: `src-tauri/src/task_options.rs`, `src-tauri/src/github_tasks.rs`, `src-tauri/src/gitlab_tasks.rs`, `src-tauri/src/main.rs`, `src/src/api.ts`, `src/src/types.ts`, `src/src/components/TaskOptionPicker.tsx`.
- Output: GitHub labels/assignees and GitLab labels/project members loaded through local CLIs; searchable chips in composer and filters.

### [x] T-003 — Add bounded GitHub image upload and clipboard fallback

- Status: done
- Scope: `src-tauri/src/github_tasks.rs`, `src-tauri/src/main.rs`, `src/src/api.ts`, `src/src/components/TaskCenter.tsx`.
- Output: bounded base64/stdin upload, filename sanitization, image signature checks, safe attachment URL validation, native clipboard image conversion.

### [x] T-004 — Validate, rebuild, and deliver

- Status: done
- Objective: run focused checks, rebuild/sign the Debug App, verify a fresh nonblank screenshot, review the scoped diff, and commit only related files.
- Exclude: `mobile/src-tauri/gen/schemas/acl-manifests.json`.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Frontend: `npm run build -- --mode test`; `npm test -- --run taskTypes.test.ts`.
- Rust: `cargo check -p agentport --bin agentport`; `cargo test -p agentport --bin agentport github_tasks`; `cargo test -p agentport --bin agentport gitlab_tasks`.
- Security/diff: `git diff --check`; inspect local-only credential boundaries, image type/size/signature/URL checks, contenteditable paste sanitization, and option source paths.
- Integration: `python3 scripts/restart-debug-app.py`; verify exact Debug App executable path and a fresh screenshot showing rendered-only editor and repository-backed pickers.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- GitHub user-attachment behavior may change or require account support beyond github.com; no live upload was executed.
- GitLab binary image upload remains unsupported by design in this slice.
- The contenteditable serializer intentionally canonicalizes Markdown rather than preserving every source formatting nuance.
- Repository option reads depend on the local provider CLI being installed/authenticated; failures are shown and never replaced with free-text credential-like inputs.
- Generic Remote Task Hub routing remains open and is not claimed by this task.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-22: Added the initial live preview and GitHub image upload path.
- 2026-11-22: Replaced the raw/preview pair with a rendered-only editor, added safe image-session previews, repository option APIs/pickers, native clipboard conversion, and bounded image signature checks.
- 2026-11-22: Frontend/Rust checks passed; signed Debug App rebuilt and verified with a nonblank Task Hub composer, repository label options, and assignee options.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: done.
- Evidence: `npm run build -- --mode test`, focused frontend test, `cargo check -p agentport --bin agentport`, `cargo check -p agentport-service`, focused GitHub tests (5), focused GitLab tests (3), `git diff --check`, signed Debug App rebuild, exact executable-path verification, and fresh screenshots.
- Limitations: no live provider write/upload was executed; Remote UI routing and GitLab binary uploads remain outside scope.
