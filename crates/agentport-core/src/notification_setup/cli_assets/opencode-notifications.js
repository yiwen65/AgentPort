// OpenCode native JS plugin; Bun supplies node:child_process, no npm packages.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export const AgentPortNotifications = async ({ client }) => {
  const env = process.env;
  if (env.AGENTPORT_NOTIFICATION_AGENT !== 'opencode' || !env.AGENTPORT_NOTIFICATION_CONTEXT_READER ||
      !env.AGENTPORT_NOTIFICATION_RELAY) return {};
  let readContext;
  try { readContext = createRequire(process.execPath)(env.AGENTPORT_NOTIFICATION_CONTEXT_READER); } catch { return {}; }
  let rootSession;
  return {
    event: async ({ event }) => {
      if (!['permission.asked', 'session.error'].includes(event.type)) return;
      const id = event.properties?.sessionID;
      if (!id || (rootSession && rootSession !== id)) return;
      try {
        const response = await client.session.get({ path: { id } });
        if (!response.data || response.data.parentID) return;
        rootSession ??= id;
        let kind;
        if (event.type === 'permission.asked') kind = 'needs_input';
        else if (event.properties?.error?.name && event.properties.error.name !== 'MessageAbortedError') kind = 'failed';
        const ctx = readContext('opencode', true, id);
        if (kind && ctx) spawnSync('/bin/sh', [env.AGENTPORT_NOTIFICATION_RELAY, kind], { stdio: 'ignore', timeout: 2000,
          env: { ...env, AGENTPORT_NOTIFICATION_TOKEN: ctx.token, AGENTPORT_HOOK_EVENTS_FILE: ctx.eventsFile } });
      } catch {}
      // session.idle also follows interrupts/errors: not successful completion.
    },
  };
};
