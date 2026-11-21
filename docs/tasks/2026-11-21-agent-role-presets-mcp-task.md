# Task Plan: Agent 角色预设与 MCP 委派

- Created: 2026-11-21
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: 2026-11-21 用户确认的角色预设与 MCP 委派需求合同

<!-- task-doc-section:background-goal -->
## Background and goal

AgentPort 已支持 MCP 创建和管理受限范围内的 Delegated Session。本任务在不改变现有
Agent 选择、全权限默认、Session 所有权和生命周期边界的前提下，增加一个全局 Agent
角色库：用户可以管理内置和 DIY 角色，MCP 只向委派模型暴露已启用角色的摘要，并在
创建 Session 时把选定角色的版本化指令快照作为受约束的 delegation preamble 注入。

目标是让父 Agent 能明确选择“研究/实现/审查”等行为角色，同时保证委派可复现、可审计，
且角色提示词不能悄悄改变安全策略。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### Scope

- 全局角色库及 AgentPort 设置界面：内置角色可编辑、恢复默认、不可删除；DIY 角色可新增/编辑/删除。
- 角色字段：稳定 `roleId`、name、description、instructions、可选软性 output contract、enabled、revision。
- 内置通用角色：研究/分析、实现、审查、测试/验证、文档等少量模板；内置默认启用，DIY 新建默认禁用。
- MCP 角色查询工具：只返回已启用角色的 `roleId`、名称、说明和输出契约，不返回完整内部指令。
- `create_session` / `create_sessions` 的可选单个 `roleId`；不传则保持现有委派行为。
- 禁用、不存在或删除后的 `roleId` 拒绝创建；不静默忽略或回退。
- 创建 Session 时记录角色 `roleId`、revision 和实际内容快照；后续编辑只影响新 Session。
- 单角色受约束 preamble 注入；角色不能覆盖 MCP 所有权、权限、生命周期和安全规则。

### Non-goals

- 多角色叠加、MCP 根据任务文本自动选角、隐式默认角色。
- 角色绑定 Agent、模型/努力程度、权限、工作树、工具或 Session 生命周期。
- MCP 强制校验 JSON Schema 或其他结构化输出；output contract 只是软性指令。
- 运行中 Session 跟随角色最新版本；禁用/删除角色不打断已有 Session。
- 因任务完成自动关闭 Session，或暴露用户创建的 Session。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | MCP 工具 schema 和 dispatch 集中在 `crates/agentport-mcp/src/tools.rs`，已有 create_session/create_sessions 和 ownership registry | `crates/agentport-mcp/src/tools.rs` 与 `crates/agentport-mcp/src/registry.rs` 当前源码 |
| F-002 | MCP Toolbox 持有数据根目录和 `Arc<dyn RemoteService>`，可在工具层读取共享配置并把角色快照加入归属记录 | `crates/agentport-mcp/src/tools.rs` 的 `Toolbox`/`ToolboxConfig` |
| F-003 | AgentPort Tauri 设置页已有 Agent Adapter 设置、API/type 层和 `AppState`/Tauri command 模式 | `src/src/components/SettingsDialog.tsx`、`src/src/api.ts`、`src/src/types.ts`、`src-tauri/src/main.rs` |
| F-004 | 用户确认角色库为全局级别；角色只负责身份/指令；一次 Session 一个角色；显式 roleId；角色创建时快照 | 2026-11-21 需求确认记录 |
| F-005 | 既有 MCP 委派默认使用 Agent 自身 full-permission/bypass，且 Session 不会因完成自动关闭 | `docs/tasks/2026-11-20-agentport-mcp-v1-task.md`、现有 `tools.rs` 委派路径 |
| F-006 | 当前工作树只有预-existing 的 `mobile/src-tauri/gen/schemas/acl-manifests.json` 修改，不得纳入本任务 | 2026-11-21 `git status --short` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 角色共享存储应由 GUI 和独立 MCP 进程共同读取；优先复用现有 AgentPort 数据目录/锁和 Tauri command，而非把角色内容放入前端 localStorage。
- Assumption: Session 角色审计至少保存在 MCP ownership registry；若现有 Session DB 有低风险扩展点，再同步展示到 Session 状态，但不为角色功能引入不必要的迁移。
- Assumption: 角色指令通过现有 prompt delivery 路径发送，使用明确分隔的 bounded preamble；保留 Agent 原生安全行为。
- Open question: 具体共享存储实现（DB 表、settings 字段或锁定 JSON）须由源码勘察和测试风险决定；不改变已确认的外部行为。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- [x] 设置界面可以显示内置和 DIY 角色，新增/编辑/删除 DIY 角色，编辑/恢复内置角色，并切换 enabled。
- [x] 内置角色默认 enabled，DIY 新建默认 disabled；只有 enabled 角色出现在 MCP 角色查询结果。
- [x] MCP 角色查询只返回 metadata/summary，不泄露完整内部 instructions。
- [x] `create_session` 和 `create_sessions` 接受可选单个 `roleId`；不传 roleId 的委派行为与现有行为一致。
- [x] enabled roleId 的指令和软性 output contract 进入受约束 preamble；禁用/不存在 roleId 明确拒绝且不创建 Session。
- [x] Session/registry 保存 roleId、revision 和实际快照；后续编辑、禁用或删除不改变旧 Session 的角色内容。
- [x] 角色不能改变既有 MCP owned-session、pane、permission/full-access 或生命周期策略。
- [x] 通过 Rust、前端、MCP 相关 targeted tests/build，并完成 debug App 重启后的非空白 UI 检查（涉及 UI 行为）。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: reconnaissance -> shared role storage/contracts -> GUI and MCP integration -> cross-process tests/build/UI verification -> commit.
- Parallel batches: read-only reconnaissance tasks may run concurrently; after exact ownership is known, GUI-only and MCP-only implementation can proceed in parallel only if they do not touch shared models/storage. Shared storage/schema and integration tests are serialized.
- Serialization constraints: role schema/storage, MCP tool schema, registry snapshot format, and Tauri command payloads are shared contracts; changes to those files are coordinator-serialized. Do not touch the pre-existing mobile schema modification.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Confirm shared role storage and core contracts

- Status: done
- Owner: coordinator
- Objective: Choose and implement one cross-process role model/storage contract compatible with GUI and MCP, including validation, built-in defaults, revisioning, atomic persistence, and snapshot serialization.
- Inputs and prerequisites: Confirmed requirements; read-only architecture reports; existing core/DB/settings patterns.
- Scope or files: `crates/agentport-core` shared model/storage as required; related tests; task document updates.
- Expected output: Tested role store/model API and stable serialized shape.
- Dependencies: None.
- Execution steps:
  1. Reconcile reconnaissance with current source and avoid unnecessary DB migration.
  2. Add validation/defaults/locking or DB methods and unit tests.
  3. Validate the document and targeted Rust tests.
- Acceptance criteria:
  - Built-in and DIY role lifecycle rules are enforced.
  - Revision and immutable creation snapshot are representable.
  - Concurrent GUI/MCP reads/writes cannot silently lose updates.
- Verification method:
  - Targeted `cargo test` for the changed core/storage module.
- Validation evidence: `cargo test -p agentport-core agent_roles -- --nocapture` passed (3 role/model and DB tests); `cargo check -p agentport-core -p agentport-service` passed; workspace migration/data-model check passed through `cargo check --workspace --all-targets`.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — AgentPort role settings UI

- Status: done
- Owner: coordinator
- Objective: Add a settings section for viewing, editing, restoring, adding, deleting and enabling roles.
- Inputs and prerequisites: T-001 shared model/API contract.
- Scope or files: `src-tauri/src/main.rs`, `src/src/api.ts`, `src/src/types.ts`, `src/src/components/SettingsDialog.tsx`, styles/locales/tests as needed.
- Expected output: Usable role management UI with validation and safe defaults.
- Dependencies: T-001.
- Execution steps:
  1. Add Tauri commands/API/types.
  2. Add SettingsDialog section and role editor/toggles.
  3. Add focused frontend tests and build.
- Acceptance criteria:
  - UI state is loaded from shared storage, not localStorage-only.
  - Built-in restore and DIY CRUD obey the contract.
  - Toggle state is reflected in subsequent MCP calls.
- Verification method:
  - Relevant Vitest tests and `npm run build`.
- Validation evidence: `npx vitest run src/components/SettingsDialog.roles.test.tsx` passed (2 tests); `npm run build` passed; `npm run i18n:check` passed; restarted debug App and visually confirmed the Agent Roles page rendered with built-in roles, switches and editor.
- Blocker: None.
- Unblock condition: T-001 done.

### [x] T-003 — MCP role discovery and delegated snapshot injection

- Status: done
- Owner: coordinator
- Objective: Expose enabled role metadata and apply an explicitly selected role snapshot to single/batch Session creation.
- Inputs and prerequisites: T-001 shared role model/storage.
- Scope or files: `crates/agentport-mcp/src/tools.rs`, `crates/agentport-mcp/src/registry.rs`, prompt helper/ops/tests/docs.
- Expected output: `list_roles` (or equivalent), roleId schema/validation, bounded preamble, registry/session audit fields.
- Dependencies: T-001.
- Execution steps:
  1. Add tool contract and enabled-only metadata.
  2. Resolve role and snapshot before creating the Session; reject invalid roles.
  3. Inject role preamble without changing permission/ownership behavior.
  4. Add protocol/tool/registry tests and update MCP docs.
- Acceptance criteria:
  - Single and batch creation support one optional roleId.
  - Invalid role never creates a Session.
  - Result and registry reveal role identity/revision without exposing private instructions through list_roles.
- Verification method:
  - `cargo test -p agentport-mcp` plus focused end-to-end/fixture checks.
- Validation evidence: `cargo test -p agentport-mcp --lib` passed (37 tests); `scripts/test-agentport-mcp.py --binary target/debug/agentport-mcp` passed end-to-end, including enabled-only role discovery, no instruction leakage and Shell rejection; registry role snapshot tests passed.
- Blocker: None.
- Unblock condition: T-001 done.

### [x] T-004 — Integration validation, debug UI verification and delivery

- Status: done
- Owner: coordinator
- Objective: Verify cross-process behavior and ship only task-related changes in a commit.
- Inputs and prerequisites: T-002 and T-003 done.
- Scope or files: no new implementation scope; scripts/docs/test artifacts only if required by evidence.
- Expected output: Passing targeted checks, non-blank restarted debug App, reviewed diff and commit.
- Dependencies: T-002, T-003.
- Execution steps:
  1. Run targeted Rust/frontend checks and inspect diff.
  2. Run role toggle -> MCP list_roles -> create_session smoke test where feasible.
  3. Use `python3 scripts/restart-debug-app.py`, verify exact GUI executable path and screenshot.
  4. Ensure pre-existing mobile schema change is excluded, validate task document, and commit.
- Acceptance criteria:
  - Acceptance criteria above have current evidence.
  - No unrelated changes are committed.
  - Debug App renders non-blank after restart.
- Verification method:
  - Commands recorded in the task document and final diff review.
- Validation evidence: `cargo check --workspace --all-targets` passed; `npm run build` passed; `git diff --check` passed; debug restart script completed with exact executable path and non-blank Agent Roles screenshot; MCP E2E passed. Full `npm test` ran 169 files/1430 tests with one pre-existing unrelated PairingSection assertion failure; the new role test passed.
- Blocker: None.
- Unblock condition: T-002 and T-003.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Validate task document after initial fill, material status changes, and finalization.
- Run focused Rust tests for the shared role store/model and `cargo test -p agentport-mcp`.
- Run focused frontend SettingsDialog tests plus `npm run build` (or repository-equivalent command discovered from package scripts).
- Run a temporary-data MCP smoke test covering enabled-role listing, disabled-role rejection, and role snapshot metadata. Avoid leaving Sessions running; do not terminate user-owned Sessions.
- If UI behavior changed, run `python3 scripts/restart-debug-app.py`; verify exact process executable path is `target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport` and inspect a non-blank screenshot.
- Run `git diff --check`, review `git status`, and commit only role-feature paths; preserve the pre-existing mobile schema change.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

| ID | Risk | Mitigation |
| --- | --- | --- |
| R-001 | GUI and independent MCP process may race while updating role config | Use existing DB transaction or private atomic/locked store; add concurrent write/read test. |
| R-002 | Adding role text to PTY prompt could be interpreted as user task or exceed Agent-specific limits | Use bounded, clearly delimited preamble and reuse prompt sanitizer/delivery path; test with shell fixture. |
| R-003 | Full role instructions could leak through MCP discovery or output | Return only metadata/summary; keep full content in the creation-time snapshot and execution path. |
| R-004 | Existing Session DB schema may make role audit expansion costly | Keep an MCP registry snapshot as the minimum audit record unless a current low-risk Session field is available. |
| R-005 | Existing user-owned Sessions and pre-existing working-tree changes must remain untouched | Enforce MCP ownership checks and inspect/commit only task-related paths. |
| R-006 | Debug App build/sign/restart can affect the active GUI | Use the prescribed restart script only; verify exact executable path and non-blank screenshot before delivery. |

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-11-21: Task document created and populated in execute mode; implementation authorized by user after requirements confirmation.
- 2026-11-21: Started read-only architecture reconnaissance for MCP, UI and backend configuration patterns.
- 2026-11-21: Implemented v21 SQLite role storage, built-in seeds, revision CAS, Tauri CRUD commands, Settings UI, MCP list_roles/roleId injection, ownership snapshots, docs and tests.
- 2026-11-21: Targeted Rust/frontend checks, MCP E2E and debug App restart/screenshot passed. Full frontend suite has one unrelated PairingSection assertion failure; recorded as a limitation.
- 2026-11-21: Hardened role prompt submission evidence to use visible task text when a long role preamble scrolls its prefix off the TUI; MCP unit and E2E checks passed again.
- 2026-11-21: Reproduced Qoder CLI v1.1.94 specifically: CR left the composer unsent, while LF submitted the same prompt in a temporary Session. Added Qoder-specific LF submission and regression coverage; MCP Qoder smoke returned `promptSubmitted: true`.
- 2026-11-21: All role-feature tasks marked done; task document validated before delivery.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 through T-004 are done; task document validator passed; workspace cargo check, targeted Rust tests, frontend build/i18n/role tests, MCP E2E and non-blank debug UI verification passed.
- Limitations: Existing full `npm test` run reports one unrelated `src/components/PairingSection.test.tsx` text-matching failure; no role test failed. Existing `mobile/src-tauri/gen/schemas/acl-manifests.json` modification was not included.
