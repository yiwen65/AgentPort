// Synthetic extension API + production private context/relay, no model or CLI.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import extension from "./omp-approval.ts";

const dir = mkdtempSync(join(tmpdir(), "agentport-omp-observer-"));
const saved = { ...process.env };
try {
  process.env.HOME = dir;
  for (const key of Object.keys(process.env)) if (key.startsWith("AGENTPORT_")) delete process.env[key];
  const handlers = new Map();
  const api = { on: (name, callback) => handlers.set(name, callback) };
  extension(api);
  assert.equal(handlers.size, 0, "normal CLI is inert");
  const log = join(dir, "events.jsonl");
  const contextFile = join(dir, "context.json");
  writeFileSync(log, "", { mode: 0o600 });
  Object.assign(process.env, {
    AGENTPORT_NOTIFICATION_AGENT: "omp", AGENTPORT_SESSION_ID: "ses_fixture", AGENTPORT_RUN_ID: "run_fixture",
    AGENTPORT_NOTIFICATION_RELAY: fileURLToPath(new URL("../relay.sh", import.meta.url)),
    AGENTPORT_NOTIFICATION_CONTEXT_READER: fileURLToPath(new URL("../cli_assets/managed-context.cjs", import.meta.url)),
    AGENTPORT_NOTIFICATION_CONTEXT_FILE: contextFile,
  });
  const context = (changes = {}) => writeFileSync(contextFile, JSON.stringify({
    agent: "omp", sessionId: "ses_fixture", runId: "run_fixture", token: "fixture-token",
    eventsFile: log, nativeSessionId: "native-fixture", ownerPid: process.pid, ...changes,
  }), { mode: 0o600 });
  context();
  extension(api);
  assert.deepEqual([...handlers.keys()], ["tool_approval_requested", "tool_approval_resolved", "session_shutdown"]);
  const request = handlers.get("tool_approval_requested");
  const resolve = handlers.get("tool_approval_resolved");
  const ctx = { hasUI: true, sessionManager: { getSessionId: () => "native-fixture" } };
  const event = { sessionId: "native-fixture", toolCallId: "call1", reason: "SECRET_REASON", input: "SECRET_INPUT" };
  await request(event, { ...ctx, hasUI: false });
  await request(event, { ...ctx, sessionManager: { getSessionId: () => "child" } });
  await request({ ...event, sessionId: "foreign" }, ctx);
  await request({ ...event, toolCallId: "" }, ctx);
  for (const invalid of [{ ownerPid: process.pid + 1 }, { nativeSessionId: "foreign" },
    { nativeSessionId: null }, { runId: "old-run" }, { agent: "pi" }]) {
    context(invalid);
    await request(event, ctx);
  }
  context();
  chmodSync(contextFile, 0o644);
  await request(event, ctx);
  chmodSync(contextFile, 0o600);
  const link = join(dir, "context-link");
  symlinkSync(contextFile, link);
  process.env.AGENTPORT_NOTIFICATION_CONTEXT_FILE = link;
  await request(event, ctx);
  process.env.AGENTPORT_NOTIFICATION_CONTEXT_FILE = contextFile;
  assert.equal(readFileSync(log, "utf8"), "", "invalid/private/foreign/child contexts are inert");
  await resolve(event, ctx); // no matching pending request
  await request(event, ctx);
  await request(event, ctx);
  const records = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.deepEqual(records(), [{ event: "AgentPortNotification", kind: "needs_input", sessionId: "ses_fixture",
    runId: "run_fixture", token: "fixture-token" }]);
  await request({ ...event, toolCallId: "call2" }, ctx);
  await resolve(event, ctx); // second approval still pending: do not mark working
  assert.deepEqual(records().map(r => r.kind), ["needs_input", "needs_input"]);
  await resolve({ ...event, toolCallId: "call2", approved: false }, ctx);
  await resolve({ ...event, toolCallId: "call2" }, ctx);
  assert.deepEqual(records().map(r => r.kind), ["needs_input", "needs_input", "working"]);
  assert.equal(readFileSync(log, "utf8").includes("SECRET"), false);
  process.env.AGENTPORT_NOTIFICATION_RELAY = join(dir, "missing-relay");
  assert.equal(await request({ ...event, toolCallId: "call3" }, ctx), undefined);
  handlers.get("session_shutdown")();
  console.log("Omp observer: passed private context/PID/native isolation, approval resolution, dedup, redaction, relay failure");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(dir, { recursive: true, force: true });
}
