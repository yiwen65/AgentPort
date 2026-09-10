// AgentPort observer: no model/tool payloads, dependencies, or policy changes.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export default function agentPortNotifications(amp) {
  const env = process.env;
  if (env.AGENTPORT_NOTIFICATION_AGENT !== 'amp' || !env.AGENTPORT_NOTIFICATION_CONTEXT_READER ||
      !env.AGENTPORT_NOTIFICATION_RELAY) return;
  let readContext;
  try { readContext = createRequire(process.execPath)(env.AGENTPORT_NOTIFICATION_CONTEXT_READER); } catch { return; }
  let rootThread;
  const emit = (kind) => {
    const ctx = readContext('amp', true, rootThread);
    if (!ctx) return;
    try { spawnSync('/bin/sh', [env.AGENTPORT_NOTIFICATION_RELAY, kind], { stdio: 'ignore', timeout: 2000,
      env: { ...env, AGENTPORT_NOTIFICATION_TOKEN: ctx.token, AGENTPORT_HOOK_EVENTS_FILE: ctx.eventsFile } }); } catch {}
  };
  const turns = new Map();
  amp.on('session.start', async (event, ctx) => {
    try {
      // Amp supports concurrent subthreads in one CLI; never notify for children.
      if (typeof ctx.thread.parentThreadID !== 'function' || await ctx.thread.parentThreadID() !== null) return;
      if (rootThread && rootThread !== event.thread.id) return;
      if (rootThread) return;
      rootThread = event.thread.id;
      ctx.thread.state?.subscribe((state) => {
        if (state === 'awaiting-approval') emit('needs_input');
      });
    } catch {}
  });
  amp.on('agent.start', (event) => {
    if (event.thread.id === rootThread) turns.set(rootThread, event.id);
  });
  amp.on('agent.end', (event) => {
    if (event.thread.id !== rootThread || turns.get(rootThread) !== event.id) return;
    turns.delete(rootThread);
    if (event.status === 'done') emit('completed');
    else if (event.status === 'error') emit('failed');
    // cancelled is deliberately not failure or completion.
  });
}
