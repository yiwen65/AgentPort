// AgentPort-owned observer. Explicit per-invocation loading only; no policy changes.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

export default function (pi) {
  const env = process.env;
  if (env.AGENTPORT_NOTIFICATION_AGENT !== "omp" || !env.AGENTPORT_NOTIFICATION_RELAY ||
      !env.AGENTPORT_NOTIFICATION_CONTEXT_READER) return;
  let readContext;
  try { readContext = createRequire(process.execPath)(env.AGENTPORT_NOTIFICATION_CONTEXT_READER); }
  catch { return; }
  const pending = new Set();
  const managed = (event, ctx) => {
    if (!ctx.hasUI || typeof event.toolCallId !== "string" || !event.toolCallId) return null;
    const nativeId = ctx.sessionManager.getSessionId();
    const context = readContext("omp", true, nativeId);
    // Require exact native identity AND actual owning CLI PID, even when a
    // nested same-agent process inherits the parent's entire environment.
    return context && context.nativeSessionId === nativeId && event.sessionId === nativeId ? context : null;
  };
  const report = async (kind, context) => {
    // Never forward tool arguments, prompt text, approval reason, or credentials.
    await new Promise((resolve) => {
      execFile("/bin/sh", [env.AGENTPORT_NOTIFICATION_RELAY, kind], {
        timeout: 1500, maxBuffer: 1024,
        env: { ...env, AGENTPORT_NOTIFICATION_TOKEN: context.token, AGENTPORT_HOOK_EVENTS_FILE: context.eventsFile },
      }, () => resolve());
    });
  };
  pi.on("tool_approval_requested", async (event, ctx) => {
    // Omp emits this event even before rejecting headless approval requests.
    const context = managed(event, ctx);
    if (!context || pending.has(event.toolCallId)) return;
    pending.add(event.toolCallId);
    await report("needs_input", context);
  });
  pi.on("tool_approval_resolved", async (event, ctx) => {
    const context = managed(event, ctx);
    if (!context || !pending.delete(event.toolCallId) || pending.size > 0) return;
    // Internal state transition, not a completion/failure notification. Denial
    // is a user choice; leave the native agent to decide its next action.
    await report("working", context);
  });
  pi.on("session_shutdown", () => pending.clear());
}
