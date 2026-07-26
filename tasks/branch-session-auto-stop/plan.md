# Implementation Plan: Safe Session handling for local branch operations

## Overview

Replace the current raw live-Session blocker with an explicit, user-confirmed
flow that gracefully stops only Sessions using the active checkout, verifies
their terminal lifecycle from the backend, revalidates repository state, and
then continues the original switch operation. Keep the existing backend branch
guard as the final authority for races and external state changes.

## Architecture Decisions

- Use the fresh `list_local_branches` response as the read-only preflight;
  `status.liveSessionIds` is already scoped by exact repository checkout.
- Resolve Session IDs to frontend Session titles and lifecycle labels for UI,
  but retain IDs only as internal command arguments.
- Stop Sessions sequentially with the existing graceful `stop_session` command.
  That command returns only after `HostManager::stop` verifies a terminal
  lifecycle; a second repository preflight confirms the checkout is clear.
- Add one backend `create_and_switch_local_branch` operation that holds the
  repository lock across create and switch, preventing AgentPort Session launch
  from entering the gap and avoiding a session-induced created-only branch.
- Never restart stopped Sessions automatically. Preserve their records and
  expose links to the existing Session recovery UI.

## Task List

### Phase 1: Contracts and backend atomicity

- [x] Add the atomic core create-and-switch path under one repository lock.
- [x] Expose it through Tauri and the typed frontend API.
- [x] Cover clean success, live-Session blocking, and exact-checkout isolation.

### Checkpoint: Backend safety

- [x] A live Session prevents ref creation and checkout mutation.
- [x] With no live Session, create-and-switch completes without an inter-command gap.

### Phase 2: User-confirmed frontend orchestration

- [x] Add fresh preflight before switch and create-and-switch.
- [x] Show names, lifecycle states, count, and explicit Continue/Cancel choices.
- [x] Sequentially stop, verify, revalidate, and continue only after confirmation.
- [x] Report stopped and failed Sessions without raw IDs or backend English.

### Checkpoint: Interaction safety

- [x] Cancel has no stop, create, or switch calls.
- [x] Partial stop failure and checkout drift abort before Git mutation.
- [x] Successful operations retain recovery links for stopped Sessions.

### Phase 3: Verification and packaged App

- [x] Frontend, Tauri, and core focused tests pass.
- [x] Full frontend tests, type/build, i18n, and diff checks pass.
- [x] Debug App is rebuilt, signed, restarted, and visually exercised for
      confirm, cancel, success, and failure states.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A new Session starts during the flow | Wrong checkout changes under a live process | Final core guard plus shared repository lock |
| One stop succeeds and another fails | Some Sessions are stopped but Git must not run | Abort immediately, list stopped/failed Sessions, preserve current branch |
| Frontend Session snapshot is stale | Misleading title/state | Use IDs only for command identity, re-read store labels for each UI state |
| Existing dirty worktree work overlaps | Accidental loss or unrelated edits | Patch only scoped files and avoid checkout/reset/stash outside product behavior |
| External Git races with create/rollback | Misowned or missing local ref | Expected-absent ref CAS, recovery-reference guard, post-delete Worktree revalidation |
| Checkout identity drifts during confirmation | Stop Sessions for a different repository state | Compare repo key, checkout root, branch/detached identity, and HEAD OID at every preflight |

## Open Questions

- None blocking. Existing stopped-Session recovery remains the supported manual
  resume path; this feature will not invent automatic restart semantics.
