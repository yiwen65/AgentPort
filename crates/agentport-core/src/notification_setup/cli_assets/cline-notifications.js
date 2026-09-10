// Single-file Cline plugin; only Node builtins supplied by the CLI runtime.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export default {
  name: 'agentport-notifications',
  manifest: { capabilities: ['hooks'] },
  hooks: {
    afterRun(context) {
      const env = process.env;
      if (env.AGENTPORT_NOTIFICATION_AGENT !== 'cline' || !env.AGENTPORT_NOTIFICATION_CONTEXT_READER ||
          !env.AGENTPORT_NOTIFICATION_RELAY) return;
      // The runtime supplies a snapshot; child agents share plugin definitions.
      if (!context?.snapshot || context.snapshot.parentAgentId) return;
      const status = context?.result?.status;
      const kind = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : null;
      if (!kind) return; // aborted and unknown outcomes are not failures.
      try {
        const ctx = createRequire(process.execPath)(env.AGENTPORT_NOTIFICATION_CONTEXT_READER)('cline', true, context.snapshot.conversationId);
        if (!ctx) return;
        spawnSync('/bin/sh', [env.AGENTPORT_NOTIFICATION_RELAY, kind], { stdio: 'ignore', timeout: 2000,
          env: { ...env, AGENTPORT_NOTIFICATION_TOKEN: ctx.token, AGENTPORT_HOOK_EVENTS_FILE: ctx.eventsFile } });
      } catch {}
    },
  },
};
