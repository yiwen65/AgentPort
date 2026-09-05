# Mobile interaction redesign

- Created: 2026-09-05
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: User request and screenshot

<!-- task-doc-section:background-goal -->
## Background and goal
Replace the heavy black dashboard with a light, compact interface; centralize project launch and terminal settings.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals
Mobile frontend, tests and task documentation only. Preserve SSH, Host, session lifecycle and unrelated dirty files.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence
- SessionDashboard.tsx has repeated agent strips and large captions.
- SessionWorkspace.tsx owns terminal appearance controls and persistence.
- App.tsx retains a live terminal while showing the dashboard.
- mobile/package.json supports Vitest, Vite and simulator builds.

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- Assumption: warm gray/white app chrome, independent terminal dark/light palettes.
- Open question: None blocking.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- No visible Projects/Active Sessions display headings; preserve view navigation and accessibility names.
- Project launch button opens centered blurred modal, scopes launch to project, prevents duplicates and handles failure/cancel.
- Main settings owns six palettes and two modes; preserve storage and xterm instance.
- Validate mobile layouts, localization, focus, tests, build and simulator rendering.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches
- T-001 and T-002 run in parallel; T-003 depends on both.
- Dashboard agent owns dashboard source/test/new CSS only.
- Coordinator owns shared Modal, settings, app, global styles, i18n and this document.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Dashboard and agent picker
- Status: done
- Owner: dashboard-agent
- Objective: Compact project launch and preserved navigation.
- Inputs and prerequisites: User request and current dashboard.
- Scope or files: SessionDashboard.tsx, its tests, dashboard.css.
- Expected output: Accessible centered project picker and regression coverage.
- Dependencies: None.
- Execution steps: Implement and test dashboard interactions.
- Acceptance criteria: Correct project/agent binding, cancellation and failure behavior.
- Verification method: Focused dashboard tests and simulator.
- Validation evidence: Final full mobile suite passed: 13 files / 62 tests (`npm test -- --maxWorkers=2`); production and iOS simulator builds passed. Runtime evidence is recorded below.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Settings and visual system
- Status: done
- Owner: coordinator
- Objective: Light application chrome, shared modal and persistent settings migration.
- Inputs and prerequisites: Existing appearance catalog and App.
- Scope or files: App, Settings, Modal, terminal appearance store, i18n, styles and tests.
- Expected output: Settings changes affect retained xterm without remount.
- Dependencies: None.
- Execution steps: Implement shared controls, migrate state, restyle and test.
- Acceptance criteria: Original stored choices survive; terminal-only scope is retained.
- Verification method: Focused settings/workspace tests and build.
- Validation evidence: Final full mobile suite passed: 13 files / 62 tests (`npm test -- --maxWorkers=2`); production and iOS simulator builds passed. Runtime evidence is recorded below.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Integration and runtime validation
- Status: done
- Owner: coordinator
- Objective: Verify and commit only this task.
- Inputs and prerequisites: Completed implementation tasks.
- Scope or files: Task files and validation evidence.
- Expected output: Passing build/tests and simulator screenshots.
- Dependencies: T-001, T-002
- Execution steps: Integrate, run tests/build, inspect simulator and commit.
- Acceptance criteria: User workflows verified with remaining limits documented.
- Verification method: Full mobile tests, build, simulator, scoped diff.
- Validation evidence: Final full mobile suite passed: 13 files / 62 tests (`npm test -- --maxWorkers=2`); production and iOS simulator builds passed. Runtime evidence is recorded below.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan
Focused unit/component checks, full mobile tests, production build, iOS simulator build/install and screenshot checks. No production sessions will be stopped for verification.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers
Avoid remounting xterm. Modal must isolate background gestures and retain list position. Preserve unrelated changes to LEARNS.md, docs/mobile-app-prd.md and desktop terminal files.

<!-- task-doc-section:execution-log -->
## Execution log
- 2026-09-05: Scope confirmed; T-001 and T-002 started with disjoint ownership.
- 2026-09-05: Integrated dashboard/settings work with shared portaled modal, light app tokens, translated strings and desktop-derived brand marks.
- 2026-09-05: Added modal focus/inert tests and picker-backdrop/stale-swipe regression coverage. Corrected async empty-state assertion and icon-name assertion to ignore decorative SVG titles.
- 2026-09-05: A high-concurrency test run hit timing limits; bounded final suite with two workers passed without expanding timeouts. Final frontend/simulator build and scoped validation passed.
- 2026-09-05: Runtime checks completed and final simulator app left open and connected. Unrelated dirty files were excluded from staging.

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: passed
- Evidence: `npm test -- --maxWorkers=2` passed 13 files / 62 tests; `npm run build` passed TypeScript and Vite; final `npm run build:ios-simulator` passed (including its frontend build). Scoped `git diff --check` passed.
- Runtime: Installed final bundle and launched `com.agentport.mobile` on iPhone 17 Pro / iOS 26.5. `ps` confirmed PID 13832 runs the simulator-installed AgentPort Mobile executable. Existing saved SSH profile reconnected; no credential/trust changes.
- Screenshots inspected: `/tmp/mobile-redesign-dashboard-final.png`, `/tmp/mobile-redesign-picker-final.png`, `/tmp/mobile-redesign-settings-final.png`. Dashboard is light and nonblank; final chooser shows six distinct existing brand/shell icons; settings has six palettes and two modes.
- Live behavior: Generic Shell launch reached real PTY prompts (`shell-19`, `shell-20`, no commands or AI tasks submitted). Switching retained terminal from Graphite/light to Aurora/dark preserved the same `.xterm` node, changed workspace background to `rgb(13, 19, 33)`, and retained app canvas `#f3f2ef`. Original Graphite/light preference was restored. Component tests additionally assert no reattach/detach from appearance changes.
- Layout: Temporarily resized the real WKWebView to 320×568 and 568×320 (not separate device/OS tests). Settings stayed within bounds, became vertically scrollable, retained visible 44×44 close control, and document width equaled viewport width. Restored 402×874 before delivery.
- Accessibility: Automated focus entry/wrap/restoration, background inertness, Escape/backdrop/close, and gesture isolation checks passed. New English/Chinese strings are supplied; settings localization is component-tested. Existing active/project navigation and agent preference filtering are covered.
- Limits: No Android, physical-device, iOS 16, actual landscape rotation, Dynamic Type or VoiceOver run. Native runtime manipulation used product DOM/API calls via LLDB, not a complete physical-touch test. No existing sessions, desktop GUI or Host processes were stopped.
