// External JSON hook classifier. Node is an explicit setup dependency.
// Read at most 1 MiB, never persist the input, emit only a constant event kind.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const readContext = require('./managed-context.cjs');
const env = process.env;

// Grok queues failure reports off the turn loop. Associate them with the most
// recently submitted native prompt, not merely the long-lived process run.
function grokTurn(data, start, file) {
  const id = data.promptId;
  const session = data.sessionId;
  if (typeof id !== 'string' || !id || id.length > 256 || typeof session !== 'string' ||
      !session || session.length > 256 || !/^[A-Za-z0-9_-]+$/.test(env.AGENTPORT_RUN_ID) ||
      !file?.startsWith('/')) return false;
  const state = `${file}.grok-turn-${env.AGENTPORT_RUN_ID}`;
  try {
    const eventStat = fs.lstatSync(file);
    if (!eventStat.isFile() || eventStat.isSymbolicLink()) return false;
    try { if (!fs.lstatSync(state).isFile()) return false; }
    catch (error) { if (error.code !== 'ENOENT') return false; }
    if (!start) {
      const latest = JSON.parse(fs.readFileSync(state, 'utf8'));
      return latest.promptId === id && latest.sessionId === session;
    }
    const temporary = `${state}.${process.pid}.tmp`;
    let created = false;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ promptId: id, sessionId: session }), { mode: 0o600, flag: 'wx' });
      created = true;
      fs.renameSync(temporary, state);
    } finally {
      if (created) { try { fs.unlinkSync(temporary); } catch {} }
    }
    return true;
  } catch { return false; }
}
const agent = process.argv[2];
if (agent === env.AGENTPORT_NOTIFICATION_AGENT && env.AGENTPORT_SESSION_ID &&
    env.AGENTPORT_RUN_ID && env.AGENTPORT_NOTIFICATION_CONTEXT_FILE && env.AGENTPORT_NOTIFICATION_RELAY) {
  let chunks = [], size = 0;
  process.stdin.on('data', (chunk) => {
    size += chunk.length;
    if (size <= 1048576) chunks.push(chunk);
    else chunks = [];
  });
  process.stdin.on('end', () => {
    if (size > 1048576) return;
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const nativeId = agent === 'grok_build' ? data.sessionId : agent === 'gemini' ? data.session_id : data.conversation_id;
      const ctx = readContext(agent, false, nativeId);
      if (!ctx) return;
      let kind;
      if (agent === 'grok_build') {
        if (data.subagentType) return;
        if (data.hookEventName === 'user_prompt_submit') { grokTurn(data, true, ctx.eventsFile); return; }
        if (data.hookEventName === 'notification' && data.notificationType === 'permission_prompt') kind = 'needs_input';
        else if (data.hookEventName === 'stop_failure' && grokTurn(data, false, ctx.eventsFile)) kind = 'failed';
        // Stop is a blocking gate; idle_prompt includes cancellations/errors;
        // task_complete is a background task. None proves main-turn success.
      } else if (agent === 'gemini') {
        if (data.hook_event_name === 'Notification' && data.notification_type === 'ToolPermission') kind = 'needs_input';
      } else if (agent === 'cursor_agent') {
        if (data.hook_event_name !== 'stop') return;
        if (data.status === 'completed') kind = 'completed';
        else if (data.status === 'error') kind = 'failed';
      }
      if (kind) spawnSync('/bin/sh', [env.AGENTPORT_NOTIFICATION_RELAY, kind], { stdio: 'ignore', timeout: 2000,
        env: { ...env, AGENTPORT_NOTIFICATION_TOKEN: ctx.token, AGENTPORT_HOOK_EVENTS_FILE: ctx.eventsFile } });
    } catch {} // observational hooks never block or disclose upstream data
  });
  process.stdin.on('error', () => {});
}
