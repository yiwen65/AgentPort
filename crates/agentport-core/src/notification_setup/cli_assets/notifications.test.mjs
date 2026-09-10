import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'agentport-cli-notifications-'));
const events = join(temp, 'events.jsonl');
const contextFile = join(temp, 'managed \' " $(must-not-run).json');
writeFileSync(events, '');
const saved = { ...process.env };
Object.assign(process.env, {
  HOME: temp,
  AGENTPORT_SESSION_ID: 'session-test', AGENTPORT_RUN_ID: 'run-test',
  AGENTPORT_NOTIFICATION_TOKEN: 'token-test', AGENTPORT_HOOK_EVENTS_FILE: events,
  AGENTPORT_NOTIFICATION_RELAY: join(dir, '..', 'relay.sh'),
  AGENTPORT_NOTIFICATION_CONTEXT_FILE: contextFile,
  AGENTPORT_NOTIFICATION_CONTEXT_READER: join(dir, 'managed-context.cjs'),
});
const lines = () => readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const context = (extra = {}) => writeFileSync(contextFile, JSON.stringify({
  agent: process.env.AGENTPORT_NOTIFICATION_AGENT, sessionId: 'session-test', runId: 'run-test',
  token: 'token-test', eventsFile: events, ownerPid: process.pid, ...extra,
}), { mode: 0o600 });
const reset = (agent) => { writeFileSync(events, ''); process.env.AGENTPORT_NOTIFICATION_AGENT = agent; context(); };
const load = async (name) => import('data:text/javascript;base64,' + Buffer.from(readFileSync(join(dir, name), 'utf8')).toString('base64'));
const input = (agent, payload, extra = {}) => {
  const result = spawnSync(process.execPath, [join(dir, 'json-hook.cjs'), agent], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...process.env, ...extra }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
};

test('Grok only maps actual approval and main-agent failure, never gates/background/abort', () => {
  reset('grok_build');
  for (const payload of [
    { hookEventName: 'stop', reason: 'end_turn' },
    { hookEventName: 'stop_cancelled', reason: 'user_interrupt' },
    { hookEventName: 'notification', notificationType: 'idle_prompt' },
    { hookEventName: 'notification', notificationType: 'task_complete' },
    { hookEventName: 'pre_tool_use' },
    { hookEventName: 'stop_failure', subagentType: 'worker' },
  ]) input('grok_build', payload);
  assert.equal(lines().length, 0);
  input('grok_build', { hookEventName: 'user_prompt_submit', sessionId: 'native', promptId: 'old', prompt: 'SECRET' });
  input('grok_build', { hookEventName: 'user_prompt_submit', sessionId: 'native', promptId: 'new', prompt: 'SECRET' });
  input('grok_build', { hookEventName: 'stop_failure', sessionId: 'native', promptId: 'old' });
  input('grok_build', { hookEventName: 'stop_failure', sessionId: 'other', promptId: 'new' });
  assert.equal(lines().length, 0);
  input('grok_build', { hookEventName: 'notification', notificationType: 'permission_prompt', toolInput: 'SECRET' });
  input('grok_build', { hookEventName: 'stop_failure', sessionId: 'native', promptId: 'new', errorDetails: 'SECRET' });
  assert.deepEqual(JSON.parse(readFileSync(`${events}.grok-turn-run-test`, 'utf8')), { sessionId: 'native', promptId: 'new' });
  assert.deepEqual(lines().map(x => x.kind), ['needs_input', 'failed']);
  assert.ok(!readFileSync(events, 'utf8').includes('SECRET'));
});

test('Gemini uses private launch context even when native sanitizer removes TOKEN', () => {
  reset('gemini');
  for (const event of ['BeforeTool', 'AfterAgent']) input('gemini', { hook_event_name: event });
  input('gemini', { hook_event_name: 'Notification', notification_type: 'ToolPermission' }, { AGENTPORT_NOTIFICATION_TOKEN: '' });
  assert.deepEqual(lines().map(x => x.kind), ['needs_input']);
});

test('Cursor statuses explicitly exclude abort and subagentStop', () => {
  reset('cursor_agent');
  input('cursor_agent', { hook_event_name: 'stop', status: 'aborted' });
  input('cursor_agent', { hook_event_name: 'subagentStop', status: 'completed' });
  input('cursor_agent', { hook_event_name: 'stop', status: 'completed' });
  input('cursor_agent', { hook_event_name: 'stop', status: 'error' });
  assert.deepEqual(lines().map(x => x.kind), ['completed', 'failed']);
});

test('ordinary terminals, wrong agents, malformed and oversize payloads are silent', () => {
  reset('grok_build');
  const good = { hookEventName: 'stop_failure' };
  input('grok_build', good, { AGENTPORT_RUN_ID: '' });
  input('grok_build', good, { AGENTPORT_NOTIFICATION_AGENT: 'cursor_agent' });
  input('grok_build', '{not-json');
  input('grok_build', 'x'.repeat(1048577));
  assert.equal(lines().length, 0);
});

test('Cline exact outcome and parent snapshot filter', async () => {
  reset('cline');
  const plugin = (await load('cline-notifications.js')).default;
  for (const status of ['aborted', 'unknown']) plugin.hooks.afterRun({ snapshot: {}, result: { status } });
  plugin.hooks.afterRun({ snapshot: { parentAgentId: 'child' }, result: { status: 'completed' } });
  plugin.hooks.afterRun({ result: { status: 'completed' } });
  plugin.hooks.afterRun({ snapshot: {}, result: { status: 'completed', output: 'SECRET' } });
  plugin.hooks.afterRun({ snapshot: {}, result: { status: 'failed', error: 'SECRET' } });
  assert.deepEqual(lines().map(x => x.kind), ['completed', 'failed']);
  assert.ok(!readFileSync(events, 'utf8').includes('SECRET'));
});

test('Amp current API: native root, correlation, approval, exact outcome and cancellation', async () => {
  reset('amp');
  const handlers = {};
  (await load('amp-notifications.js')).default({ on: (key, fn) => { handlers[key] = fn; } });
  let state;
  const ctx = { thread: { parentThreadID: async () => null, state: { subscribe: fn => { state = fn; } } } };
  await handlers['session.start']({ thread: { id: 'root' } }, ctx);
  state('running'); state('awaiting-approval');
  handlers['agent.start']({ thread: { id: 'root' }, id: 'new' });
  handlers['agent.end']({ thread: { id: 'root' }, id: 'old', status: 'error' });
  handlers['agent.end']({ thread: { id: 'child' }, id: 'new', status: 'done' });
  handlers['agent.end']({ thread: { id: 'root' }, id: 'new', status: 'done' });
  handlers['agent.end']({ thread: { id: 'root' }, id: 'new', status: 'done' });
  handlers['agent.start']({ thread: { id: 'root' }, id: 'cancel' });
  handlers['agent.end']({ thread: { id: 'root' }, id: 'cancel', status: 'cancelled' });
  handlers['agent.start']({ thread: { id: 'root' }, id: 'error' });
  handlers['agent.end']({ thread: { id: 'root' }, id: 'error', status: 'error' });
  assert.deepEqual(lines().map(x => x.kind), ['needs_input', 'completed', 'failed']);
});

test('OpenCode excludes idle, child sessions and MessageAbortedError', async () => {
  reset('opencode');
  const plugin = await (await load('opencode-notifications.js')).AgentPortNotifications({
    client: { session: { get: async ({ path }) => ({ data: { parentID: path.id === 'child' ? 'parent' : undefined } }) } },
  });
  const send = (type, sessionID = 'root', error = undefined) => plugin.event({ event: { type, properties: { sessionID, error } } });
  await send('session.idle');
  await send('permission.asked', 'child');
  await send('permission.asked');
  await send('session.error', 'root', { name: 'MessageAbortedError' });
  await send('session.error', 'root', { name: 'APIError', details: 'SECRET' });
  assert.deepEqual(lines().map(x => x.kind), ['needs_input', 'failed']);
});

test('all plugin families refuse ordinary terminal activation', async () => {
  reset('');
  const amp = (await load('amp-notifications.js')).default;
  amp({ on() { throw new Error('registered outside managed session'); } });
  assert.deepEqual(await (await load('opencode-notifications.js')).AgentPortNotifications({}), {});
  (await load('cline-notifications.js')).default.hooks.afterRun({ snapshot: {}, result: { status: 'failed' } });
  assert.equal(lines().length, 0);
});

test('private contexts reject wrong identity, native ID, permissions, symlinks and inherited SDK owner', async () => {
  reset('cursor_agent');
  const event = { hook_event_name: 'stop', status: 'completed', conversation_id: 'native' };
  context({ runId: 'other-run' }); input('cursor_agent', event);
  context({ agent: 'grok_build' }); input('cursor_agent', event);
  context({ nativeSessionId: 'other-native' }); input('cursor_agent', event);
  context(); chmodSync(contextFile, 0o644); input('cursor_agent', event); chmodSync(contextFile, 0o600);
  const link = join(temp, 'linked-context'); symlinkSync(contextFile, link);
  input('cursor_agent', event, { AGENTPORT_NOTIFICATION_CONTEXT_FILE: link });
  assert.equal(lines().length, 0);
  reset('cline'); context({ ownerPid: process.pid + 1 });
  (await load('cline-notifications.js')).default.hooks.afterRun({ snapshot: {}, result: { status: 'completed' } });
  assert.equal(lines().length, 0);
});

test('external hooks accept only the owning CLI or its single system-shell child', () => {
  reset('gemini');
  const payload = JSON.stringify({ hook_event_name: 'Notification', notification_type: 'ToolPermission', session_id: 'native' });
  const classifier = join(dir, 'json-hook.cjs');
  // Direct parent is the owner (the input helper already exercises this path).
  input('gemini', payload);
  // Keep the shell alive after Node exits, preventing shell exec optimization.
  const command = '"$1" "$2" "$3"; status=$?; exit "$status"';
  const result = spawnSync('/bin/sh', ['-c', command, 'agentport-hook', process.execPath, classifier, 'gemini'], {
    input: payload, env: process.env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.deepEqual(lines().map(x => x.kind), ['needs_input', 'needs_input']);
});

test('external hooks reject null ownership and inherited nested CLI with no native ID', () => {
  reset('gemini');
  const payload = JSON.stringify({ hook_event_name: 'Notification', notification_type: 'ToolPermission', session_id: 'nested-native' });
  for (const ownerPid of [null, 0, -1, '123', 1.5]) {
    context({ ownerPid }); input('gemini', payload);
  }
  context({ nativeSessionId: null });
  // Simulate another CLI inheriting the exact environment/context, first with
  // its direct hook child and then its own sh -c hook runner. Neither is owner.
  const nested = `const {spawnSync}=require('node:child_process');
    const input=require('node:fs').readFileSync(0);
    const classifier=process.argv[1];
    for(const shell of [false,true]) {
      const command=shell?'/bin/sh':process.execPath;
      const args=shell?['-c','"$1" "$2" "$3"; status=$?; exit "$status"','nested-hook',process.execPath,classifier,'gemini']:[classifier,'gemini'];
      const result=spawnSync(command,args,{input,env:process.env,encoding:'utf8',timeout:3000});
      if(result.status!==0 || result.stdout || result.stderr) process.exit(1);
    }`;
  const result = spawnSync(process.execPath, ['-e', nested, join(dir, 'json-hook.cjs')], {
    input: payload, env: process.env, encoding: 'utf8', timeout: 8000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(), []);
});

test.after(() => { process.env = saved; rmSync(temp, { recursive: true, force: true }); });
