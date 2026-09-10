// Private launch association. This is not an upstream credential and never
// enters native global settings. Gemini intentionally redacts TOKEN env names.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function ownedHookProcess(ownerPid) {
  const parent = process.ppid;
  if (parent === ownerPid) return true;
  if (!Number.isSafeInteger(parent) || parent <= 0) return false;
  try {
    // Exactly one system-shell bridge is permitted. Never walk through another
    // CLI/worker, even if it inherited a valid context from the owning CLI.
    const output = execFileSync('/bin/ps', ['-p', String(parent), '-o', 'ppid=', '-o', 'comm='], {
      encoding: 'utf8', timeout: 500, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(output);
    if (!match || Number(match[1]) !== ownerPid || process.ppid !== parent) return false;
    const command = match[2].trim();
    if (process.platform === 'linux') {
      if (!['sh', 'bash', 'zsh', '/bin/sh', '/bin/bash', '/bin/zsh'].includes(command)) return false;
      // Linux ps comm alone can be renamed; verify the actual system executable.
      const executable = fs.readlinkSync(`/proc/${parent}/exe`);
      return ['/bin/sh', '/bin/bash', '/bin/zsh'].some((shell) => {
        try { return fs.realpathSync(shell) === executable; } catch { return false; }
      });
    }
    return ['/bin/sh', '/bin/bash', '/bin/zsh'].includes(command);
  } catch { return false; }
}

module.exports = function managedContext(agent, requireOwner = false, nativeId) {
  const env = process.env;
  if (env.AGENTPORT_NOTIFICATION_AGENT !== agent || !env.AGENTPORT_SESSION_ID || !env.AGENTPORT_RUN_ID) return null;
  const path = env.AGENTPORT_NOTIFICATION_CONTEXT_FILE;
  if (!path?.startsWith('/')) return null;
  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null;
    const ctx = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (ctx.agent !== agent || ctx.sessionId !== env.AGENTPORT_SESSION_ID || ctx.runId !== env.AGENTPORT_RUN_ID ||
        typeof ctx.token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(ctx.token) ||
        typeof ctx.eventsFile !== 'string' || !ctx.eventsFile.startsWith('/')) return null;
    if (!Number.isSafeInteger(ctx.ownerPid) || ctx.ownerPid <= 0) return null;
    if (requireOwner ? ctx.ownerPid !== process.pid : !ownedHookProcess(ctx.ownerPid)) return null;
    if (ctx.nativeSessionId && ctx.nativeSessionId !== nativeId) return null;
    return ctx;
  } catch { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
};
