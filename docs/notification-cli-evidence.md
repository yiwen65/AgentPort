# CLI notification integration evidence

Verified 2026-09-10. This is an interface/evidence record, not the task-status authority (`docs/tasks/2026-09-10-agent-notification-auto-setup-task.md`).

## Scope and safety

T-003 covers Claude, Codex, Qoder, Kimi, OpenCode, Amp, Gemini, Cline, Kiro CLI, Cursor Agent and Grok Build. Existing first-four launch hooks/native readers remain the sole integration: no duplicate global registration. New assets are declarative installer inputs; this task **did not write real HOME**, run installers, send model prompts, log in, change selected agents, or change permission policy.

Every added observer requires the managed `AGENTPORT_NOTIFICATION_AGENT`, session/run and relay/context-file environment. Its mode-0600, same-UID, no-symlink private launch context must match agent/session/run and, when available, the native session ID. SDK plugins additionally require `ownerPid === process.pid` at callback emission, rejecting inherited nested CLI activation. External JSON observers require a direct parent matching ownerPid or exactly one verified system shell whose parent is ownerPid; a bounded `/bin/ps` lookup (and Linux `/proc` executable verification) rejects unknown workers and nested CLI processes even without a native ID. The token is read only from that private file, never native global settings; Gemini can therefore retain its normal TOKEN environment redaction. The agent discriminator also prevents Grok's Claude/Cursor compatibility discovery from executing another provider's observer. Only constant `completed`, `needs_input`, `failed` labels reach the shared `/bin/sh` relay. No tool inputs, prompts, answers, model error details or credentials are copied. Native plugin code uses only Node builtins supplied by the CLI runtime; external JSON hooks explicitly require `node` on PATH and installation must fail clearly if it is absent. No npm/package installation is needed.

Global files are standalone additive discovery inputs where documented. Gemini and Cursor use strict-JSON array merge, not JSONC/TOML/YAML rewriting. Gemini's native hook sanitizer removes the relay token environment variable, so the observer validates the private per-launch context file instead. Installer owns conflicts, disabled settings, symlinks, alternate home roots, atomic writes and rollback; an unknown format must remain untouched. User-disabled native hooks are never force-enabled. Old sessions need restart/reload by their normal lifecycle; AgentPort does not forcibly restart them.

## Coverage and exact boundaries

`hook` describes the installed precise subset, not a claim that every possible application question/error is observable. Overall readiness must remain degraded when any category is partial, the native version/API is unverified, or only process failure is available.

| Agent | Registration/source | Completed | Waiting | Failed | Boundary |
|---|---|---|---|---|---|
| Claude | Existing capability-gated per-invocation `--settings` | Existing Stop hook | Existing PermissionRequest/Notification | Process only | No new global hook; Stop is a native gate and existing behavior is not strengthened here |
| Codex | Existing capability-gated `-c notify=…` | `agent-turn-complete` | `approval-requested` | Process only | Existing filter/trust settings retained, no global TOML |
| Qoder | Existing per-invocation settings | Existing Stop | Heuristic | Process only | PreToolUse is **not** approval |
| Kimi | Existing managed wire JSONL reader | Native | Heuristic | Process only | Watcher maps TurnEnd, not approval; no duplicate watcher/hooks |
| OpenCode | `.config/opencode/plugins/agentport-notifications.js` | Heuristic | `permission.asked` | `session.error`, abort excluded | SDK lookup rejects child sessions; binds one root. `session.idle` is not success |
| Amp | `.config/amp/plugins/agentport-notifications.js` | `agent.end.status=done` | Real `awaiting-approval` state where supported; arbitrary plugin questions remain heuristic | `agent.end.status=error` | Native root via `parentThreadID()`, message-ID correlation; cancelled ignored; only first root thread |
| Cline | `.cline/plugins/agentport-notifications.js` | `afterRun.result.status=completed` | Heuristic | `afterRun.result.status=failed` | Requires runtime snapshot, rejects parentAgentId; aborted/unknown ignored |
| Gemini | Append `.gemini/settings.json` `/hooks/Notification` | Heuristic | Notification `ToolPermission` | Process only | Private launch context carries relay identity without weakening native TOKEN redaction; no BeforeTool/AfterAgent registration |
| Kiro CLI | No config write | Heuristic | Heuristic | Process only | Current official references conflict on Stop semantics; no selected-agent replacement |
| Cursor Agent | Append `.cursor/hooks.json` `/hooks/stop` | `stop.status=completed` | Heuristic | `stop.status=error` | aborted/subagentStop ignored; requires current CLI hook support |
| Grok Build | `.grok/hooks/agentport-notifications.json` | Heuristic | Notification `permission_prompt` | Main `StopFailure` | Child events rejected; no Stop/StopCancelled/background-task completion mapping |

The first four source classifications describe existing implementation, not a claim that legacy raw hook payload handling has been repaired by T-003. Process-only failure does not observe model errors that leave the TUI alive. Amp/Cline current interfaces were verified against public docs/source, not an installed authenticated CLI. If their CLI daemon drops per-launch environment, notifications do not activate; that is an unverified live-runtime boundary, not permission to alter daemon/user configuration.

## Primary references

### Preserved implementations

- `crates/agentport-core/src/adapters/claude.rs`: `HOOK_EVENTS`, settings-json generation and capability gating.
- `.../codex.rs`: `notifier_relay_script`, `hook_plan` and capability flags.
- `.../qoder.rs`: its per-invocation hook list/relay and settings gating.
- `crates/agentport-host/src/semantic_events.rs`: native Kimi source/turn mapping.
- Existing CLI provenance: `docs/agent-cli-evidence.md`.

### OpenCode

- https://opencode.ai/docs/plugins/ — public rendered endpoint returned 403; authoritative repository Markdown retrieved instead:
  https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/plugins.mdx
  (`https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/plugins.mdx`). Documents global `.config/opencode/plugins/`, direct JS loading, plugin context, `event`, `permission.asked`, `session.error`, `session.idle`; Node/Bun builtin modules do not require an npm package.
- https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/config.mdx — merged configuration and `OPENCODE_CONFIG_CONTENT`; standalone plugin chosen to avoid overwriting any pre-existing inline config or plugin list.
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts — idle is activity state, not a successful outcome. No completion relay is generated from it.
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts — native plugin loader/context. Requires current session SDK `client.session.get({path:{id}})` returning `data.parentID`; missing result is fail-closed for observations.
- https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts and `src/v2/gen/types.gen.ts` — `MessageAbortedError.name` is exactly `MessageAbortedError`, session `parentID` is optional, current v2 permission event is `permission.asked`. Older v1 event schema uses `permission.updated`; it is not silently treated as the current approval event.

### Amp

- https://ampcode.com/docs/markdown/customize/plugins — system plugins honor XDG_CONFIG_HOME; otherwise `~/.config/amp/plugins/`; JS/default-function entry, `amp.on`, concurrent threads and lifecycle semantics.
- https://ampcode.com/docs/markdown/plugin-api — full current API: `AgentEndEvent.status: 'done' | 'error' | 'cancelled'`, initiating message `id`, `PluginThread.parentThreadID()`, `state: Observable<ThreadState>`, `ThreadState = 'idle' | 'running' | 'awaiting-approval' | 'error'`. `agent.end` can schedule a **new** follow-up turn; unlike a Stop gate, outcome is explicit.
- https://ampcode.com/docs/markdown/tools — no default approval prompt; policy plugins may request one. This integration does not add/change policies and never maps `tool.call` to approval.
- Capability requirement: native Bun-hosted system-plugin loading and the above API. Older API missing parent/state methods is not silently treated as verified. Ordinary plugin load does not subscribe outside a managed process.

### Cline

- https://docs.cline.bot/sdk/plugin-install.md — global `~/.cline/plugins/` discovery, single-file JS/TS default export; no need to invoke package installation for a dependency-free local observer.
- https://docs.cline.bot/sdk/guides/writing-plugins.md — `AgentPlugin`, manifest `{capabilities:['hooks']}`, `afterRun`; single-file imports can be Node builtins and `@cline/*`. Observer uses only `node:child_process`.
- https://github.com/cline/cline/blob/main/sdk/examples/hooks/README.md — explicitly says `afterRun` wraps each `run()/continue()` user turn and fires for completed, aborted and failed; check `result.status`.
- https://github.com/cline/cline/blob/main/sdk/packages/agents/src/agent-runtime.ts — `callAfterRunHooks` passes `{snapshot:this.snapshot(),result}`; snapshot contains `parentAgentId` and `runId`. Observer refuses missing snapshots and child agents.
- Capability requirement: current native single-file discovery and the exact snapshot/outcome API. The legacy VS Code `.clinerules/hooks` surface is not installed into CLI by guesswork.

### Gemini

- https://geminicli.com/docs/hooks/reference.md — strict JSON `hooks` event arrays, matcher groups, command hooks and timeout **milliseconds**. Common `hook_event_name`; Notification has `notification_type: 'ToolPermission'` and cannot grant permission/block alerts.
- https://geminicli.com/docs/hooks/ — discovery/settings reference. The old `/docs/hooks/configuration/` URL returned a Page Not Found document; not used as schema evidence.
- AfterAgent permits a block/continuation; installing a passive completion observer would misreport intermediate gates with users' existing hooks. No AfterAgent completion or BeforeTool approval mapping is added.
- https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/hooks/hookRunner.ts — invokes `sanitizeEnvironment(process.env, ...)` before hook execution.
- https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/environmentSanitization.ts — `NEVER_ALLOWED_NAME_PATTERNS` includes `/TOKEN/i` (also AUTH, KEY, SECRET etc.). Thus `AGENTPORT_NOTIFICATION_TOKEN` cannot reach the hook. This was verified before installation: the implemented private-context protocol validates a mode-0600, same-UID, no-symlink local launch file and matching session/run/agent/native identity before obtaining the relay association. No credential alias, sanitizer override, or global secret is added.
- https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settingsSchema.ts — actual canonical settings are `hooksConfig.enabled` and `hooksConfig.disabled`; these are not guessed as `hooks.enabled` or force-enabled. Respect alternate Gemini home; do not migrate to another product to gain coverage.

### Cursor

- https://cursor.com/docs/hooks.md — current official hook reference, user-level `~/.cursor/hooks.json`, merged matching hooks, default schema version 1; `stop.status: 'completed'|'aborted'|'error'`, common `hook_event_name`, separate subagentStop. No passive permission-wait event is documented.
- https://cursor.com/docs/cli/overview.md — actual CLI product reference. `/docs/cli/hooks.md` redirected rather than providing an independent version matrix. Shared hook docs explicitly name CLI for workspaceOpen but do not identify a minimum release for every other hook. Accordingly current CLI hooks support is an explicit live-validation requirement, not inferred from a flag name or from editor-only fixtures.
- No enterprise policy, trust, force/permission option, hook failClosed/loop_limit or existing hook is modified.

### Kiro CLI: deliberate documented degradation

- https://kiro.dev/docs/cli/v3/hooks-migration.md — standalone versioned `.kiro/hooks/*.json`; table states Stop is session-end and nonblocking, and older hooks were embedded in selected-agent JSON.
- https://kiro.dev/docs/hooks/types.md — Agent Stop instead says turn-completed and block/continue supported, including CLI. Several CLI example payload blocks in returned Markdown are empty.
- https://kiro.dev/llms.txt — confirms current CLI 3/shared reference locations, superseding obsolete `/docs/cli/hooks/`.
- The conflicting semantic claims and absent waiting/error trigger make installing guessed v1/v2 configuration unsafe. No agent migrate command, selected-agent replacement or policy modification is used. This is a verified evidence gap, not a claim that Kiro has no hooks.

### Grok Build: local source cross-check

Public product identity: https://x.ai/cli and https://docs.x.ai/build/overview. Local checkout is `/Users/w/Projects/easy-pi/grok-build`; its origin is a user fork, **not proof of an official upstream repository**. Product identity is independently documented by existing `docs/agent-cli-evidence.md` and real `grok --help`/version fixture. Local sources inspected:

- `crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md`: global `~/.grok/hooks/*.json` always trusted and additive; matcher Notification type, StopFailure error class; camelCase input; main-vs-child `subagentType`; native Stop/StopFailure/StopCancelled distinction.
- `.../09-plugins.md` and `.../05-configuration.md`: trust and compatibility semantics; standalone hook file avoids TOML migration/plugin trust mutation.
- `crates/codegen/xai-grok-shell/src/tools/notification_bridge.rs`, `DispatchNotificationHook` around line 608: **task_complete means background task**, not the main model turn. It is intentionally not registered.
- `.../session/acp_session_impl/hook_dispatch.rs`: actual permission_prompt notification.
- `crates/codegen/xai-grok-hooks/src/config.rs` (`HookSpec.command`, `parse_hook_file`): shell command environment refs can be expanded at **load time**. Generated command therefore contains no `$` environment refs or filesystem paths; fixed Node `-e` code reads paths from `process.env` and calls `require` without eval/shell interpolation. This also prevents unsafe paths becoming shell syntax or a global command capturing one managed session's path.
- `.../runner/command.rs`: shell command execution is `sh -c`; unresolved variable precheck is another reason to avoid bare environment refs in global command strings.

Stop is a gate and can fire before a different user hook continues the same turn. `idle_prompt` follows cancelled/errored turns too. A passive observer cannot distinguish final Stop from a continuation without changing users' gates. Completed coverage therefore remains heuristic. StopFailure can be queued after a subsequent prompt; the shared run identity alone does not distinguish native turns in one long-lived process. A UserPromptSubmit observer therefore stores only `{sessionId,promptId}` in a mode-0600, process-run-scoped sidecar next to the pre-created host event file. StopFailure is emitted only when both IDs match the latest submission; missing metadata, child events, symlinks and stale/foreign native IDs are rejected. The shared relay still independently validates the AgentPort run/token. No prompt content is stored.

## Verification actually performed

- HTTPS GET only for official documentation/source; source snapshots were read under `/tmp/agentport-cli-evidence`. No downloaded code was executed. Checked-in scripts are original minimal observers, not copied telemetry examples.
- `node --test crates/agentport-core/src/notification_setup/cli_assets/notifications.test.mjs`: **11 tests passed, 0 failed**. Temporary HOME only; actual shared shell relay writes synthetic envelopes to a pre-created temporary file, never system notifications.
- Tests cover Grok main/child, latest native prompt/foreign session filtering, metadata-only state, permission vs pretool/idle/background/abort; Gemini actual permission with TOKEN absent and private-context validation; Cursor completed/error vs aborted/subagent; malformed/oversize JSON; no identifiers/wrong agent; Cline parent and outcome filtering; Amp native message correlation, duplicate, cancellation and approval-state signal; OpenCode child/idle/abort rejection; all plugins ordinary-terminal no-op; secret payload sentinels absent in output; private-context wrong identity/native ID, insecure mode, symlink, inherited SDK owner and hostile path characters.
- `rustfmt --edition 2021 crates/agentport-core/src/notification_setup/providers_cli.rs`: succeeded. No workspace formatter/build/commit invoked by this task.
- Rust provider tests cover eleven-agent routing, no duplicate first-four/selected-agent modification, shell exclusion, registration structure, and no PreToolUse/Stop completion guesses. Cargo execution belongs to coordinator; not claimed passed here.

**Not verified:** real authenticated CLI plugin loading for seven new providers, old/unknown native versions, a live GUI notification, Linux runtime behavior, all alternate config-home overrides, host/daemon environment inheritance, and native hook scheduling under live concurrent workloads. Installer and coordinator must retain honest degraded/failed states for these boundaries. Existing real user configuration must never be edited just to make the capability display green.
