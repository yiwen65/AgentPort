# Implementation Plan: Zero-configuration Agent detection

## Overview

Make Agent detection automatic and deterministic across GUI, interactive shells,
package-manager directories, and common Node version managers. The normal UI
shows only the selected working installation; candidate paths and manual
overrides remain available as advanced recovery controls.

## Architecture Decisions

- Treat the interactive login shell as the user's intended environment, then
  fall back to the GUI process PATH, version-manager directories, and common
  system directories.
- Select the first candidate in that documented order that passes the existing
  read-only capability probe. Never select an executable merely because it
  exists.
- Use the same effective PATH for probing and Session launch so detection cannot
  succeed while launch fails on a transitive runtime such as `node`.
- Keep manual path selection, but place it behind advanced disclosure rather
  than making it part of the normal setup flow.

## Task List

### Phase 1: Discovery and selection

- [x] Detect stable paths for fnm, nvm, Volta, asdf, mise, pnpm, Bun, npm-global,
      Homebrew/Linuxbrew, MacPorts, Snap, and the existing Agent-specific dirs.
- [x] Rank interactive-shell candidates first and keep fallback ordering stable.
- [x] Add CLI-level regression tests for version-manager-only discovery and
      automatic best-candidate selection.

### Checkpoint: Detection

- [x] A Node-shebang Agent outside the GUI PATH is found and probed successfully.
- [x] A working interactive-shell candidate wins over fallback installations.

### Phase 2: Zero-configuration UI

- [x] Run detection automatically when the setup/advanced Agent screen opens.
- [x] Present automatic status first; keep candidates and manual override under
      advanced controls.
- [x] Update Simplified Chinese and English copy and add UI behavior tests.

### Checkpoint: Complete

- [x] Rust and frontend tests pass.
- [x] The packaged debug App is rebuilt, signed, relaunched, and visually checked.
- [x] The Settings flow completes automatic detection without manual path input.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Version-manager directories contain stale versions | Wrong CLI selected | Shell-resolved path wins; every candidate must pass the read-only probe |
| Shell startup prints warnings | PATH parsing fails | Parse only the explicit AgentPort marker |
| Automatic UI probing runs twice | Extra delay and DB writes | Guard initial probing with component state |
| Manual recovery becomes hard to find | Users cannot recover uncommon installs | Keep a clearly labeled advanced section and show it on failures |

## Open Questions

- None blocking. Manual override remains supported for uncommon installations.
