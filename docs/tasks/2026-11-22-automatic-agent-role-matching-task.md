# Task Plan: Model-Selected Agent Roles

- Created: 2026-11-22
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: Confirmed user requirement: the coordinating model should see all enabled Role names/descriptions, choose a Role explicitly when appropriate, or omit Role when none applies; full instructions load progressively only after that choice.

<!-- task-doc-section:background-goal -->
## Background and goal

The current MCP supports Role use only when the caller already knows and passes `roleId`, while `list_roles` is an optional separate discovery call. Make Role selection Skill-like without introducing a second local classifier: dynamically include enabled Role metadata in the `tools/list` descriptions for delegation tools, let the model decide whether and which `roleId` to pass, and load full instructions only after explicit selection. Omission remains a valid no-Role decision.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**In scope**

- Instruction-free Role metadata type and metadata-only DB/service query.
- Dynamic MCP `tools/list` descriptions containing every enabled Role's ID, name, and description for `create_session` and `create_sessions`.
- Explicit `roleId` validation, progressive full-content loading, one-time injection, immutable ownership snapshots, and first-`send_prompt` behavior when creation omitted the prompt.
- Existing `list_roles` metadata tool and MCP documentation.
- Focused Core/Service/MCP tests, E2E, build, commit, and Debug App verification.

**Non-goals**

- No local keyword/semantic Role scorer or automatic Role selection inside MCP.
- No trigger-word field, trigger migration, trigger editor, or trigger-based matching.
- No model/network call made by MCP to choose a Role; the coordinating model makes the decision from tool metadata.
- No changes to Agent permissions, Agent selection, Session lifecycle, tools, or safety policy.
- No automatic Role use for Generic Shell.
- No modification to the unrelated `mobile/src-tauri/gen/schemas/acl-manifests.json` change.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | MCP currently resolves a Role only when `roleId` is present and rejects disabled/missing Roles. | `crates/agentport-mcp/src/tools.rs` `resolve_role`. |
| F-002 | Full Role instructions are currently loaded through `get_agent_role` and prepended to the first prompt. | `crates/agentport-mcp/src/tools.rs` `role_prompt` and create/send flows. |
| F-003 | Roles are persisted in SQLite and the desktop UI uses `AgentRole`; MCP already has a metadata-only `list_roles` response contract, but its backend query currently loads full records. | `crates/agentport-core/src/db/mod.rs`, `crates/agentport-core/src/agent_roles.rs`, `crates/agentport-mcp/src/tools.rs`. |
| F-004 | MCP ownership persists an immutable Role snapshot and a one-time delivery marker across restart. | `crates/agentport-mcp/src/registry.rs` `RoleSnapshot`/`role_preamble_delivered`. |
| F-005 | Generic Shell explicitly rejects a selected Role. | `crates/agentport-mcp/src/tools.rs` `role_not_supported`. |
| F-006 | MCP `tools/list` is currently built from the static `TOOLS` registry and `Server` owns a `Toolbox` that can access local service metadata. | `crates/agentport-mcp/src/server.rs`, `crates/agentport-mcp/src/tools.rs`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: Dynamic metadata is appended to delegation-tool descriptions at each `tools/list` request, so settings changes are visible without loading full instructions or requiring a prior `list_roles` call.
- Assumption: The v22 no-op schema marker is retained only to open local databases created during the superseded trigger experiment; the active Role model does not read or expose that experiment's extra column.
- Assumption: Explicit `roleId` remains the sole selection signal. Omission means no Role, including when the task text happens to resemble a Role description.
- Assumption: Metadata contains `roleId`, name, description, enabled/revision and optional output-contract summary; `instructions` never appears in metadata.
- Open question: None after the user confirmed dynamic `tools/list` exposure, model-owned selection, and removal of trigger-based matching.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `tools/list` includes every enabled Role's ID/name/description in the `create_session` and `create_sessions` descriptions, without full instructions.
- The coordinating model can omit `roleId` and the Session receives no Role; MCP never locally auto-selects a Role from task text.
- An explicit enabled `roleId` loads full instructions only after selection; missing or disabled explicit IDs fail closed.
- `create_session` with a selected Role and prompt injects it once; without a prompt, the selected Role is injected once on the first `send_prompt`.
- Existing Role snapshot/audit and restart semantics remain intact; Role edits do not mutate existing snapshots.
- Generic Shell continues rejecting explicit Roles.
- Existing Session creation, prompt delivery, wait groups, final replies, permissions, and ownership tests remain green.
- The task validator passes, task changes are committed, the unrelated mobile schema modification remains uncommitted, and the rebuilt Debug App is signed, opened, and visibly nonblank.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001` metadata model/query → `T-002` dynamic MCP exposure and progressive selection → `T-003` integrated validation and delivery.
- Parallel batches: None for implementation because Core/service/MCP share the Role metadata contract and `tools/list` behavior. A read-only review may run alongside T-001, but no concurrent edits are allowed to shared role files.
- Serialization constraints: Serialize the metadata type and DB query before Service and MCP consumers; reserve this task document and final commit for the coordinator.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Add instruction-free Role metadata loading

- Status: done
- Owner: coordinator
- Objective: Add a metadata type and DB/service query that excludes full Role instructions.
- Inputs and prerequisites: Existing AgentRole schema and local service boundary.
- Scope or files: `crates/agentport-core/src/agent_roles.rs`, `crates/agentport-core/src/db/mod.rs`, `crates/agentport-service/src/lib.rs`, focused tests.
- Expected output: Metadata-only query/API, a no-op v22 compatibility marker for the superseded local trigger experiment, and explicit full lookup unchanged.
- Dependencies: None.
- Execution steps:
  1. Add `AgentRoleMetadata` without instructions.
  2. Add the DB projection and Service method; retain a compatibility default for test services.
  3. Add metadata round-trip/query coverage.
- Acceptance criteria:
  - Metadata query does not select the `instructions` column.
  - Existing database schema and Role CRUD remain compatible.
- Verification method:
  - `cargo test -p agentport-core --lib`
  - `cargo test -p agentport-service --lib`
- Validation evidence: `cargo test -p agentport-core --lib` passed 472 tests (2 ignored); `cargo test -p agentport-service --lib` passed 73 tests. The metadata projection and full lookup both compile and pass. The v22 no-op compatibility marker keeps the existing local debug database readable without exposing trigger data.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Expose model-selected progressive Role choice

- Status: done
- Owner: coordinator
- Objective: Put enabled Role metadata in delegation tool descriptions and preserve explicit-only Role loading/injection.
- Inputs and prerequisites: T-001 metadata API and existing Role snapshot flow.
- Scope or files: `crates/agentport-mcp/src/tools.rs`, `crates/agentport-mcp/src/server.rs`, MCP tests, `docs/mcp.md`.
- Expected output: Dynamic `tools/list`, metadata-only `list_roles`, explicit roleId behavior, no local matcher or trigger fields.
- Dependencies: T-001.
- Execution steps:
  1. Build dynamic tool definitions from enabled metadata for create tools.
  2. Keep omitted roleId as no Role and explicit roleId as the only selection signal.
  3. Verify full instructions are fetched only through explicit ID resolution and injected once.
  4. Add a server test proving Role metadata appears in tools/list.
- Acceptance criteria:
  - The model sees all enabled Role IDs/names/descriptions without calling list_roles first.
  - No full instructions are exposed in tools/list or list_roles.
  - Existing explicit selection and Shell rejection remain intact.
- Verification method:
  - `cargo test -p agentport-mcp --lib`
  - Current-tree MCP E2E.
- Validation evidence: `cargo test -p agentport-mcp --lib` passed 41 tests, including dynamic tools/list Role metadata. After rebuilding the current `agentport-cli` and `agentport-mcp` binaries, `python3 scripts/test-agentport-mcp.py` completed all MCP E2E checks successfully.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Integrated validation, commit, and Debug App delivery

- Status: done
- Owner: coordinator
- Objective: Run final checks for the corrected model-selected design, commit task-only changes, and deliver the rebuilt debug application.
- Inputs and prerequisites: T-001 and T-002 done.
- Scope or files: Task document, task-related source/docs/tests only, debug bundle.
- Expected output: Passing validation, task-only Git commit(s), exact debug executable verification, and nonblank screenshot/tree evidence.
- Dependencies: T-001, T-002.
- Execution steps:
  1. Validate this task document and inspect the final diff.
  2. Run Core, Service, MCP, frontend/build, remote bridge, and E2E checks.
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
- Validation evidence: Core 472 tests (2 ignored), Service 73 tests, MCP 41 tests, Remote Bridge check, frontend build and i18n check, and final MCP E2E all passed. `cargo build -p agentport-cli` refreshed the CLI used by E2E after the schema compatibility marker. `python3 scripts/restart-debug-app.py` rebuilt/signed/opened the Debug App; the current GUI PID 93989 was verified at the exact GUI path, with CUA confirming a populated 1366×911 nonblank window.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- `python3 /Users/w/.epi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path docs/tasks/2026-11-22-automatic-agent-role-matching-task.md`
- `cargo test -p agentport-core --lib`
- `cargo test -p agentport-service --lib`
- `cargo test -p agentport-mcp --lib`
- `cargo check -p agentport-remote-bridge`
- Frontend typecheck/build and i18n check (no UI changes expected in corrected scope).
- `python3 scripts/test-agentport-mcp.py` after rebuilding `agentport-cli` for the current schema.
- `git diff --check` and final diff review.
- `python3 scripts/restart-debug-app.py`; verify exact executable path and populated nonblank window.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Dynamic tool descriptions can become large with many custom Roles; metadata is bounded by existing Role field limits and only enabled entries are included.
- A coordinating client may cache tools/list; clients should refresh tools when MCP indicates a tool-list change, but no local Role classifier will compensate for stale metadata.
- Full instructions must remain behind explicit `get_agent_role` lookup; verify the metadata SQL projection rather than relying only on response filtering.
- The E2E helper's `agentport-cli` must be rebuilt whenever the database schema changes; a stale v21 CLI against v22 data previously caused a false test failure during the superseded trigger experiment.
- The final Debug App restart must use the prescribed script and must not stop Hosts, Connectors, or the release App.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-22: Initial automatic local matcher design was rejected by the user; the requirement was clarified to model-owned Role selection from visible metadata.
- 2026-11-22: Revised contract confirmed: dynamic tools/list metadata, explicit model-provided roleId, omission means no Role, and no trigger field/migration.
- 2026-11-22: T-001 completed: added instruction-free Core/Service metadata loading without a schema migration.
- 2026-11-22: T-002 completed: added dynamic delegation-tool metadata and server regression coverage; restored explicit-only selection semantics.
- 2026-11-22: Rebuilt the current MCP/CLI binaries before E2E; this avoided the stale-v21 CLI/schema-v22 false failure encountered during the superseded design attempt. Final corrected-design E2E passed.
- 2026-11-22: Removed unused metadata helper warnings and committed the final cleanup.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: The corrected model-selected Role design is implemented and committed in `325e639`, cleanup `66aadad`, and schema compatibility `ff09f97`. Core/Service/MCP tests, Remote Bridge check, frontend build/i18n check, final MCP E2E, task validation, and Debug App rendering verification passed. `tools/list` now exposes enabled Role metadata to the model; full instructions remain behind explicit `roleId` lookup.
- Limitations: Existing MCP clients that cache `tools/list` may need to refresh their tool registry to see Role metadata changes. The CUA accessibility tree exposes only native window chrome, so nonblank proof relies on the captured populated window image.
