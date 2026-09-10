# Pi-family notification evidence

Source investigation: 2026-09-10. No model requests, credential reads, permission changes, or user-global configuration writes.

## Authoritative local evidence

- Easy Pi checkout `/Users/w/Projects/easy-pi/pi`, revision `c227dbb2ee1d69e8428edfa9cc1ca7ba315f6547`: coding-agent README, complete `docs/extensions.md`, `docs/session-format.md`, `docs/environment-variables.md`, and `examples/extensions/permission-gate.ts`.
- Oh My Pi checkout `/Users/w/Projects/easy-pi/oh-my-pi`, revision `969062200754ea02cfac922e5ebb8c608c079e15`, package version `18.0.11`: complete `docs/extensions.md`, `docs/extension-loading.md`; `src/extensibility/extensions/types.ts:912` and `wrapper.ts:240-350`.
- AgentPort `adapters/pi.rs`, `adapters/pi_family.rs`, and Host `semantic_events.rs` retain separate identities and native session directories. No changes to old Pi adapter behavior are needed.

## Signal interpretation

| Product | Completed | Needs input | Failure |
| --- | --- | --- | --- |
| Pi (legacy identity) | Existing native session JSONL | Heuristic; no verified universal approval observer | Native/process coverage owned by Host |
| easy-pi | Existing native session JSONL | Heuristic; extension UI questions are not globally observable | Native/process coverage owned by Host |
| Oh My Pi | Existing native session JSONL | Actual `tool_approval_requested` observer for verified versions, otherwise heuristic | Native/process coverage owned by Host |

Easy Pi's `agent_end` is a low-level run boundary: automatic retries, compaction, or queued follow-ups may follow. Its newer `agent_settled` is explicitly documented as the settled boundary; this event is not assumed available in legacy Pi or Omp. No plugin emits completed events, avoiding duplication of the existing native watcher. The Omp approval observer emits only the internal working transition when its last pending approval resolves.

An assistant's `stopReason: error` is different from `aborted`; tool `isError` does not by itself mean the task failed (the agent may recover). Immediate errors may precede retries, so native failure classification must not blindly treat every tool result as final failure. No tool-start callback is classified as waiting.

Omp `wrapper.ts` emits `tool_approval_requested` only after its real approval policy requires approval. Crucially it emits *before* the no-UI rejection branch; an observer must additionally require `ctx.hasUI`. The event carries the originating native `sessionId`; this must match `ctx.sessionManager.getSessionId()` to reject foreign in-process sessions. `tool_approval_resolved` occurs after the native dialog resolves; denial is not task failure. The observer must not return a policy result, mutate event input, wrap tools, or replace UI.

## Loading and compatibility

Omp supports explicit `--extension/-e` paths in addition to existing plugins/settings. Its own Bun loader handles TS without installing a runtime dependency. Generated assets only use Node built-ins. Explicit loading avoids writes to `~/.omp/agent/config.yml`, settings, profiles, and plugin lists. Pi/easy-pi user directories are likewise untouched (easy-pi's authoritative environment reference says `~/.epi/agent`, despite stale `.pi` examples elsewhere in its README).

Capability gating requires a probed `extension` flag and a positively verified Omp API version. A flag proves only loading syntax, not event existence: unknown versions must not be reported as precisely covered. Broad waiting-for-answer coverage remains partial even when native approvals are hooked: custom extension questions have no universal event. Therefore overall readiness remains degraded.

## Verification

- Implemented `notification_setup/providers_pi.rs`: independent Pi/Omp/EasyPi plans; native completion requires probed `session-dir`; Omp approval loading requires `extension` and exact verified version `omp/18.0.11`. No config registrations/global assets. Future versions deliberately degrade until validated.
- Implemented `pi_assets/omp-approval.ts`: additive observer using only `node:child_process`; calls installed relay through `/bin/sh`. Requires AgentPort session/run/token/relay and expected native-session markers. Does not report completion, tool failures, cancellation, or ordinary tool starts. Emits internal `working` only when the last observed approval resolves (including denial), preventing stuck waiting state without declaring a task failure.
- Passed `node crates/agentport-core/src/notification_setup/pi_assets/omp-approval.test.mjs` with temporary HOME: unmanaged invocation, headless requests, inherited child native IDs, foreign events, malformed/duplicate calls, minimal payload, relay failure containment, and actual production relay JSON envelope.
- Passed scoped `rustfmt --edition 2021` and `git diff --check`. Provider unit tests added for independent identities, global preservation, loading flag and version gating; Cargo execution is reserved for coordinator.
- Real Omp Bun loader not executed (Bun unavailable on PATH); no CLI/model invocation or actual system notification test was performed. Static API/source + synthetic factory/production relay checks are not claimed as a full real-CLI acceptance test.

### Integration contract

`plan(&AdapterInstall) -> Option<IntegrationPlan>` uses the shared installer types. Omp asset launch argument is `{{asset_dir}}/omp-approval.ts`. The installer independently checks `/bin/sh`; this provider adds no `required_commands` and needs no separately installed Node/Bun dependency. The plan also installs the common `cli_assets/managed-context.cjs` and sets `AGENTPORT_NOTIFICATION_CONTEXT_READER`. Launch provides `AGENTPORT_NOTIFICATION_RELAY`, `AGENTPORT_NOTIFICATION_AGENT=omp`, and the private context path. Context schema is `{sessionId,runId,token,agent,nativeSessionId,eventsFile,ownerPid}`; each callback revalidates private regular-file ownership/mode/no-symlink, matching agent/run/session, exact native session, and `ownerPid === process.pid`. Missing identity makes the extension inert, including nested same-agent CLIs inheriting environment. The token/events path are obtained from the validated context, not trusted from inherited environment.

Follow-up fixture run passed: private-context mode/symlink rejection, mismatched owner PID/native ID/run/agent, headless requests, simultaneous approvals, final resolution to `working`, duplicate resolution suppression, redaction and relay errors. Omp's own `legacy-pi-compat.ts` imports `createRequire` from `node:module` and explicitly handles `createRequire(base)(specifier)` at lines 487–535; absolute CJS reader loading is compatible with this loader surface. Actual Bun execution remains unverified (runtime unavailable). Overall status must remain degraded because custom question waiting and non-process task errors do not have universal precise coverage.
