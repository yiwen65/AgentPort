# Mobile Session actions layout

## Confirmed scope

Reduce upper whitespace, remove the visible “Session actions” heading, and distinguish the Session title from its context. User clarified that context must remain `project · branch`, not separate labeled rows.

- Only this modal is top-aligned below existing safe-area padding; other dialogs stay centered.
- Session name remains the accessible h2, larger and bold.
- Project and optional Branch remain one secondary paragraph joined by ` · `, smaller and muted, with a divider before actions. Long content may wrap safely.
- Six actions, rename and shared modal behavior are unchanged. Trigger accessibility label retained.
- The earlier uncommitted split-row implementation and extra translation keys were removed.

## Verification

- Final revision: TypeScript passed; all 49 Workspace tests passed, including long bilingual title, joined project/branch and missing branch cases.
- Prior layout iteration also passed the full 422-test Mobile suite; full suite not rerun after the inline-context correction.
- Final debug iOS archive built and installed/opened on the connected iPhone. Generated tracked files restored to their prebuild state.
- Earlier physical screenshot confirmed top placement (62 CSS px on a 440×956 viewport), larger title, all six actions visible and no horizontal overflow. It predates the inline-context correction and is not final visual acceptance.
- Final phone screenshot blocked by Web Inspector connection termination. Narrow windows, enlarged text, VoiceOver and physical rename interaction remain unverified.
- Debug desktop GUI reopened through `restart-debug-app.py --skip-build`; PID 54686 matched the exact checkout bundle executable. Window/display capture failed (`could not create image`), so desktop visual confirmation is unavailable. Desktop code unchanged.
- No Host or Agent stopped/restarted; no Session lifecycle action or terminal input sent.

Unrelated concurrent work, including LEARNS.md, preserved.
