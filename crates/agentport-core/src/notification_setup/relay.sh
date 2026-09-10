#!/bin/sh
# No stdin, CLI payload, prompt, or tool arguments are read or recorded.
set -eu
case "${1-}" in completed|needs_input|failed|working) ;; *) exit 0 ;; esac
for id in "${AGENTPORT_SESSION_ID-}" "${AGENTPORT_RUN_ID-}" "${AGENTPORT_NOTIFICATION_TOKEN-}"; do
  case "$id" in ''|*[!a-zA-Z0-9_-]*) exit 0 ;; esac
done
case "${AGENTPORT_HOOK_EVENTS_FILE-}" in /*) ;; *) exit 0 ;; esac
# The host pre-creates its private event file. Never create a file in an
# unverified ordinary terminal context, nor follow a replaced final symlink.
[ -f "$AGENTPORT_HOOK_EVENTS_FILE" ] && [ ! -L "$AGENTPORT_HOOK_EVENTS_FILE" ] || exit 0
printf '{"event":"AgentPortNotification","kind":"%s","sessionId":"%s","runId":"%s","token":"%s"}\n' "$1" "$AGENTPORT_SESSION_ID" "$AGENTPORT_RUN_ID" "$AGENTPORT_NOTIFICATION_TOKEN" >> "$AGENTPORT_HOOK_EVENTS_FILE"
