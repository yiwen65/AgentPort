# Task Plan: AgentPort Mobile UI typography and color redesign

- Created: 2026-09-03
- Workspace: /Users/w/Projects/AgentSessions
- Mode: execute
- Overall status: done
- Source: User request on 2026-09-03; `mobile/src/app/styles.css`; `mobile/src/terminal/mobile-terminal.css`; Apple Human Interface Guidelines for Typography, Accessibility, Lists and tables, Color, Materials, Dark Mode, and Layout.

<!-- task-doc-section:background-goal -->
## Background and goal

The current Mobile V2 interface preserves AgentPort's functionality but visually compresses desktop-sidebar density into an iPhone viewport. The user reports that typography is too small, the list feels crowded, and the current gray-purple color system is undesirable. Redesign the Mobile UI as a readable, touch-first interface informed by current Apple platform conventions while preserving AgentPort's remote-control IA, project/session behavior, Agent quick launch, terminal-only Session interaction, and desktop-equivalent state semantics.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

Scope:

- Replace the gray-purple palette with semantic iOS-dark-inspired CSS roles: base/elevated backgrounds, primary/secondary labels, separators, system-blue interaction, and distinct success/warning/destructive state colors.
- Use glass only for navigation/control layers; use solid or standard-material grouped surfaces for Project/Session content.
- Raise list, toolbar, status, modal and Session-header typography to mobile roles; add Apple system-font/Dynamic-Type role fallbacks where WKWebView supports them.
- Increase row spacing and grouping so Project and Session content remains scannable while retaining 44 CSS px minimum action hit regions and horizontal Agent quick launch.
- Raise the default terminal font modestly without changing PTY semantics or removing the existing font controls.
- Add focused CSS/component regressions, run the full Mobile suite/build, rebuild/install the iOS simulator bundle, and visually inspect the real connected workspace.

Non-goals:

- No backend, Remote protocol, Session-state, notification, terminal ownership, or desktop UI behavior changes.
- No replacement of the current Project/Activity IA, Agent quick-launch semantics, or full-screen terminal navigation.
- No claim of native UIKit Dynamic Type parity: this remains a Tauri/WKWebView interface and must use CSS/system-font fallbacks.
- No Android runtime acceptance in this run unless required by a regression; cross-platform CSS fallback remains required.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The rendered iPhone 17 Pro/iOS 26.5 list is visibly dense: Project labels are 13 CSS px, Session labels 12.5 CSS px, timestamps 10.5 CSS px, and the section caption 10 CSS px. | `mobile/src/app/styles.css:130-170`; live Simulator screenshot observed 2026-09-03. |
| F-002 | Existing interactive controls generally preserve 44 CSS px hit regions, but the visual glyph/text scale is much smaller than the hit regions. | `mobile/src/app/styles.css:121-162`; `mobile/src/terminal/mobile-terminal.css:36-77`. |
| F-003 | Apple recommends 17 pt as the iOS/iPadOS default text size, at least 11 pt for text, Dynamic Type adaptation, and 44×44 pt default controls; CSS px and native pt are not claimed equivalent, but the role hierarchy exposes the current mismatch. | Apple HIG Typography and Accessibility, retrieved 2026-09-03. |
| F-004 | Apple distinguishes Liquid Glass for navigation/controls from standard materials in content, and recommends grouped list styles for grouped/hierarchical data. | Apple HIG Materials and Lists and tables, retrieved 2026-09-03. |
| F-005 | Apple dark interfaces use semantic base/elevated backgrounds and label/separator/status roles; color should communicate stable meaning rather than decorate every element. | Apple HIG Color and Dark Mode, retrieved 2026-09-03. |
| F-006 | Mobile V2's Project/Activity, per-device workspace, Agent quick launch, Session status, and terminal-only interaction are already implemented and covered by tests. | `docs/tasks/2026-09-02-agentport-mobile-v2-task.md`; `mobile/src/features/sessions`. |
| F-007 | The worktree contains unrelated edits in `LEARNS.md`, `docs/mobile-app-prd.md`, and desktop terminal files. | `git status --short` on 2026-09-03. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: The requested Apple/mainstream direction prioritizes readability and calm semantic color over pixel-copying a specific Apple app; AgentPort remains dark-first and retains restrained brand accents.
- Assumption: On iOS WKWebView, Apple CSS system-font roles are a progressive enhancement; Android and unsupported engines use explicit CSS px fallbacks.
- Open question: None; the user explicitly authorized both typography/layout and color redesign.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- AC-001: The connected Project/Session list has a clear title, Project, Session and metadata hierarchy with no task-relevant text below 12 CSS px in the default fallback, and primary list labels are 16–17 CSS px.
- AC-002: Project and Session rows have visibly calmer spacing while every existing action remains reachable and the Agent launch strip retains at least 44×44 CSS px hit regions.
- AC-003: Navigation/control glass is visually distinct from grouped content surfaces; Project/Session content does not use Liquid-Glass-like blur on every row or card.
- AC-004: The new palette uses neutral black/graphite surfaces, system-blue interaction, readable semantic labels, and distinct green/orange/red state colors; the old gray-purple atmosphere is removed.
- AC-005: The Session header, status messages, action sheet and terminal keyboard use the same semantic palette and readable typography; raw xterm content remains terminal-native with a modestly larger default font.
- AC-006: Reduced-transparency and reduced-motion fallbacks remain functional; Session terminal surface remains opaque.
- AC-007: Focused and full Mobile tests, production build, iOS simulator debug build/install/launch, real connected-list visual inspection, and scoped diff checks pass.
- AC-008: Only task-owned files are committed; unrelated dirty-worktree files remain unstaged and unchanged by this run.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 → T-002 → T-003`.
- Parallel batches: None. Typography, color, list spacing, terminal chrome and CSS regression tests share the same stylesheet contracts and must be integrated serially by the coordinator.
- Serialization constraints: Only the coordinator edits this authority document and Mobile UI styles/tests. Unrelated dirty files are never staged. Runtime installation follows successful unit/build checks.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Audit the current hierarchy and freeze the design direction

- Status: done
- Owner: coordinator
- Objective: Establish the current typography/color/spacing baseline and translate official platform guidance into an AgentPort-specific design contract.
- Inputs and prerequisites: User request, current simulator render, Mobile CSS/components, Mobile V2 task, official Apple HIG.
- Scope or files: Read-only inspection of `mobile/src/app/styles.css`, `mobile/src/terminal/mobile-terminal.css`, Session components/tests, and the current simulator UI.
- Expected output: Facts F-001 through F-007, scope/non-goals, and acceptance criteria AC-001 through AC-008.
- Dependencies: None.
- Execution steps:
  1. Inspect the live connected list and record the current default text sizes and row heights.
  2. Inspect shared/list/terminal style boundaries and preserved interaction contracts.
  3. Retrieve current official Apple guidance for typography, accessibility, lists, color, materials and dark mode.
- Acceptance criteria:
  - Design choices are grounded in current source/runtime evidence and official guidance rather than screenshot imitation.
- Verification method:
  - Source line inspection, live iPhone 17 Pro/iOS 26.5 screenshot, official Apple documentation retrieval.
- Validation evidence: Completed 2026-09-03. Live list captured with real Local AgentPort data; current 10/10.5/12.5/13 CSS px roles and 44 CSS px controls identified; Apple HIG evidence retrieved for 17 pt default/11 pt minimum, 44×44 pt default controls, grouped lists, semantic colors, and navigation-only Liquid Glass.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Implement semantic typography, color and spacing

- Status: done
- Owner: coordinator
- Objective: Redesign shared Mobile chrome, Project/Session lists and Session terminal chrome into a readable, neutral, Apple-informed system without changing product behavior.
- Inputs and prerequisites: T-001 design contract; existing CSS/React structure.
- Scope or files: `mobile/src/app/styles.css`, `mobile/src/terminal/mobile-terminal.css`, minimal `SessionWorkspace.tsx` default-font change, focused tests.
- Expected output: Semantic color tokens, platform font-role fallbacks, grouped list surfaces, larger readable roles, calmer spacing, consistent terminal chrome.
- Dependencies: T-001.
- Execution steps:
  1. Replace global and state colors with semantic neutral/system-inspired roles.
  2. Restrict glass to toolbar/control layers and restyle content groups as elevated standard surfaces.
  3. Raise list/header/modal/status typography and spacing; add Apple system-font role fallbacks.
  4. Align Session header/keyboard colors and increase the raw terminal default font from 14 to 15.
  5. Update focused CSS tests for the new design contract.
- Acceptance criteria:
  - AC-001 through AC-006 pass by source/test inspection and no Session protocol or behavior code changes occur.
- Verification method:
  - Focused Vitest CSS/component tests, TypeScript production build, diff review.
- Validation evidence: Completed 2026-09-03. Semantic black/graphite/system-blue/green/orange/red roles, navigation-only blur, grouped Project/Activity surfaces, 28/17/16/13 CSS px list fallback hierarchy, Apple WebKit system text roles, increased-contrast fallback, 17/13 CSS px Session header, 13 CSS px status line, system-colored terminal controls and default xterm font 15 implemented. Focused Vitest passed 4 files/17 tests; `npm run build` passed with the existing >500 kB chunk warning; `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Verify in the real simulator and deliver a scoped commit

- Status: done
- Owner: coordinator
- Objective: Prove the redesign in automated gates and the real connected iOS simulator, then commit only task-owned files.
- Inputs and prerequisites: T-002 completed.
- Scope or files: Mobile test/build artifacts, generated simulator bundle, task document, scoped Git staging.
- Expected output: Passing regression evidence, nonblank connected-list render, running App process, and one scoped commit.
- Dependencies: T-002.
- Execution steps:
  1. Run focused/full Mobile tests, production build and `git diff --check`.
  2. Build, install and launch the iOS 26.5 simulator bundle.
  3. Inspect list and Session render for hierarchy, clipping, density, color and terminal isolation.
  4. Record limits, validate this task document, and commit only task files.
- Acceptance criteria:
  - AC-007 and AC-008 pass with current evidence.
- Verification method:
  - Test/build command output, simulator process check, Computer Use screenshots, scoped staged diff.
- Validation evidence: Completed 2026-09-03. Full Mobile Vitest passed 9 files/34 tests; the production web build and iOS Simulator bundle build passed; `git diff --check` passed. The rebuilt `com.agentport.mobile` bundle was installed and launched on iPhone 17 Pro/iOS 26.5 (PID 48090), connected to the real `Local AgentPort Debug` workspace, and rendered 89 sessions/projects. Computer Use inspection passed for Projects, expanded Project sessions, Activity, a live full-screen terminal, and the Session action sheet without clipping, blank landing content, or terminal/list bleed. Computed contrast against the elevated `#1c1c1e` surface was 15.25:1 for primary text, 4.66:1 for system blue, 8.42:1 for green, 8.28:1 for orange, and 4.99:1 for red. Exact task files were isolated for staging; unrelated dirty files remained unstaged.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Focused: Mobile CSS contract test, `SessionDashboard.test.tsx`, `SessionWorkspace.test.tsx`, `MobileTerminal.test.tsx`.
- Integration: `cd mobile && npm test`; `npm run build`; `git diff --check`.
- Runtime: `npm run build:ios-simulator`; install/launch on booted iPhone 17 Pro/iOS 26.5; inspect connected Project/Session list and terminal screen.
- Accessibility/design: verify 44 CSS px hit regions, default text roles, truncation, reduced-transparency fallback, dark contrast by computed token inspection and real render. Full VoiceOver and Android runtime remain outside this focused run.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Larger text can reduce visible Session count and expose long-name truncation; mitigate with stable one-line ellipsis, increased row height, and real long-title data in the connected workspace.
- `backdrop-filter` on content can harm hierarchy/performance; only the sticky toolbar and transient controls retain blur.
- CSS system font roles can vary across WebKit versions; explicit fallback sizes remain the cross-platform contract.
- Existing dirty files can be accidentally committed; stage exact task paths and inspect the staged name list before commit.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-03: Task document created in execute mode.
- 2026-09-03: T-001 completed from source inspection, official Apple HIG retrieval, and live iPhone 17 Pro/iOS 26.5 connected-list evidence. T-002 started with coordinator ownership; all implementation is serialized because the styles share one contract.
- 2026-09-03: T-002 completed. Focused tests 17/17, production build, and diff check passed; T-003 started for full-suite and real-simulator verification.
- 2026-09-03: T-003 completed. Full tests 34/34 and iOS Simulator build passed; the rebuilt App launched as PID 48090, connected to the real workspace, and passed Project/Activity/terminal/action-sheet visual inspection. Contrast calculations and scoped-diff checks passed.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: Focused tests 17/17; full Mobile tests 34/34; production build; iOS Simulator bundle build/install/launch; real `Local AgentPort Debug` connection with 89 sessions/projects; Project, Activity, live Session terminal, and action-sheet Computer Use inspection; semantic-token contrast calculations; `git diff --check`; scoped staging review.
- Limitations: The production build retains the existing >500 kB chunk warning. Android runtime, a physical iPhone, the largest accessibility text sizes, Increase Contrast in the simulator, and a full VoiceOver walkthrough were not run in this focused redesign acceptance.
