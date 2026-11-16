import { AgentIcon, hasAgentIcon } from "../../components/AgentIcons";

/** Canonical terminal mark, same shape as the desktop sidebar shell rows. */
function ShellGlyph() {
  return <svg className="session-agent-glyph" width={13} height={13} viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="m5 6 3.5 4L5 14m5.5 0H15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/** Owning agent mark in the corner of a Session row, mirroring the desktop badge. */
export function SessionAgentBadge({ agent, mono = false }: { agent: string; mono?: boolean }) {
  return <span className="session-agent-badge" aria-hidden="true">
    {agent === "shell" ? <ShellGlyph /> : hasAgentIcon(agent) ? <AgentIcon
      agent={agent}
      className={`session-agent-glyph ${agent}`}
      size={agent === "easy_pi" ? 16 : 13}
      mono={mono}
    /> : <span className="session-agent-fallback">{agent.slice(0, 1).toUpperCase()}</span>}
  </span>;
}
